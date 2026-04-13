import path from 'path';
import fs from 'fs';
import express from 'express';
import multer from 'multer';
import sanitize from 'sanitize-filename';
import { fileTypeFromFile } from 'file-type';
import {
  expireKey,
  addDiskUsage,
  getEffectiveDiskUsage,
  reservePendingDisk,
  releasePendingDisk,
} from '../keyStore.js';
import {
  convertWithKindlegen,
  convertWithKepubify,
  convertWithPdfCropMargins,
} from '../converter.js';
import {
  MAX_FILE_SIZE,
  MAX_DISK_BYTES,
  MAX_FILES_PER_KEY,
  MAX_URLS_PER_KEY,
  UPLOAD_DIR,
  UPLOAD_RATE_LIMIT_MAX,
} from '../config.js';
import { logger } from '../logger.js';
import type { KeyInfo, MetadataDiff } from '../types.js';
import {
  isValidKey,
  isValidUrl,
  deleteFile,
  clientIp,
  doTransliterate,
  updateEpubMetadata,
  TYPE_EPUB,
  ALLOWED_TYPES,
  ALLOWED_EXTENSIONS,
} from '../utils.js';
import { makeLimiter } from '../middleware.js';

// ---------------------------------------------------------------------------
// Helpers

async function detectMimetype(
  filePath: string,
  declared: string
): Promise<{ mimetype: string; detectedMime: string | undefined }> {
  const detected = await fileTypeFromFile(filePath);
  let mimetype = declared;
  if (mimetype === 'application/octet-stream' && detected) {
    mimetype = detected.mime;
  }
  // Normalise non-standard epub MIME type sent by some clients
  if (mimetype === 'application/epub') {
    mimetype = TYPE_EPUB;
  }
  return { mimetype, detectedMime: detected?.mime };
}

export function sanitiseFilename(
  originalname: string,
  options: { transliterate: boolean; isKindle: boolean }
): string {
  let filename = originalname;
  if (options.transliterate) {
    filename = sanitize(doTransliterate(filename));
  }
  // Kindle only supports a limited ASCII character set in filenames
  if (options.isKindle) {
    filename = filename.replace(/[^.\w\-"'()]/g, '_');
  }
  return filename;
}

/** Predicts the display filename after conversion without running it (pure function). */
function predictConvertedFilename(
  sanitised: string,
  mimetype: string,
  agent: string,
  options: { kindlegen: boolean; kepubify: boolean; pdfcropmargins: boolean }
): string {
  if (mimetype === TYPE_EPUB && agent.includes('Kindle') && options.kindlegen) {
    return sanitised.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi');
  }
  if (mimetype === TYPE_EPUB && agent.includes('Kobo') && options.kepubify) {
    return sanitised.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub');
  }
  return sanitised;
}

/** Returns name unchanged, or appends (2), (3), … until unique among existingNames. */
function uniqueFilename(name: string, existingNames: string[]): string {
  if (!existingNames.includes(name)) {
    return name;
  }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let n = 2;
  let candidate: string;
  do {
    candidate = `${base} (${n++})${ext}`;
  } while (existingNames.includes(candidate));
  return candidate;
}

async function runConversion(
  filePath: string,
  filename: string,
  mimetype: string,
  agent: string,
  options: { kindlegen: boolean; kepubify: boolean; pdfcropmargins: boolean },
  key: string
): Promise<{ convertedPath: string; conversionTool: string | null; filename: string }> {
  if (mimetype === TYPE_EPUB && agent.includes('Kindle') && options.kindlegen) {
    const conversionTool = 'KindleGen';
    const newFilename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi');
    logger.info({ key, tool: conversionTool, mimetype }, 'Conversion started');
    const convertedPath = await convertWithKindlegen(filePath);
    logger.info({ key, tool: conversionTool }, 'Conversion succeeded');
    return { convertedPath, conversionTool, filename: newFilename };
  }
  if (mimetype === TYPE_EPUB && agent.includes('Kobo') && options.kepubify) {
    const conversionTool = 'Kepubify';
    const newFilename = filename
      .replace(/\.kepub\.epub$/i, '.epub')
      .replace(/\.epub$/i, '.kepub.epub');
    logger.info({ key, tool: conversionTool, mimetype }, 'Conversion started');
    const convertedPath = await convertWithKepubify(filePath);
    logger.info({ key, tool: conversionTool }, 'Conversion succeeded');
    return { convertedPath, conversionTool, filename: newFilename };
  }
  if (mimetype === 'application/pdf' && options.pdfcropmargins) {
    const conversionTool = 'pdfCropMargins';
    logger.info({ key, tool: conversionTool, mimetype }, 'Conversion started');
    const convertedPath = await convertWithPdfCropMargins(filePath);
    logger.info({ key, tool: conversionTool }, 'Conversion succeeded');
    return { convertedPath, conversionTool, filename };
  }
  return { convertedPath: filePath, conversionTool: null, filename };
}

function deviceLabel(agent: string): string {
  return agent.includes('Kobo') ? 'Kobo' : agent.includes('Kindle') ? 'Kindle' : 'your device';
}

export function buildSuccessMessage(
  device: string,
  conversionTool: string | null,
  filename: string,
  submittedUrl: string | null,
  metadataFailed?: boolean
): string {
  const parts = [
    conversionTool ? `Sent to ${device} (converted with ${conversionTool})` : `Sent to ${device}`,
    `Filename: ${filename}`,
  ];
  if (submittedUrl) {
    parts.push(`URL added: ${submittedUrl}`);
  }
  if (metadataFailed) {
    parts.push('(Metadata lookup failed — original metadata kept.)');
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------

export function makeUploadRouter(
  keys: Map<string, KeyInfo>,
  notifySSE: (key: string, info: KeyInfo) => void
): express.Router {
  const router = express.Router();

  const uploadLimiter = makeLimiter(UPLOAD_RATE_LIMIT_MAX);

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      cb(null, `file-${suffix}${path.extname(file.originalname).toLowerCase()}`);
    },
  });

  const fileFilter: multer.Options['fileFilter'] = (req, file, cb) => {
    file.originalname = sanitize(Buffer.from(file.originalname, 'latin1').toString('utf8'));
    const key = ((req.body?.key as string) ?? '').toUpperCase();
    if (!isValidKey(key)) {
      cb(new Error('Invalid key format'));
      return;
    }
    if (!keys.has(key)) {
      cb(new Error(`Unknown key: ${key}`));
      return;
    }
    const ext = path.extname(file.originalname.toLowerCase()).substring(1);
    if (
      (!ALLOWED_TYPES.has(file.mimetype) && file.mimetype !== 'application/octet-stream') ||
      !ALLOWED_EXTENSIONS.has(ext)
    ) {
      cb(new Error(`Invalid file type: ${file.mimetype} / .${ext}`));
      return;
    }
    cb(null, true);
  };

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE, files: 1, fieldSize: 4096, fields: 10 },
    fileFilter,
  });

  router.post('/upload', uploadLimiter, (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        // LIMIT_FILE_SIZE leaves a partial file on disk; clean it up before responding.
        // fileFilter errors set req.file to undefined (no disk write), so this is a no-op there.
        if (req.file) {
          deleteFile(req.file.path);
        }
        logger.warn({ err: (err as Error).message }, 'Upload rejected');
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).send(err.message);
        } else {
          res.status(400).send((err as Error).message);
        }
        return;
      }

      const key = ((req.body?.key as string) ?? '').toUpperCase();
      if (!isValidKey(key)) {
        res.status(400).send('Invalid key format');
        if (req.file) {
          deleteFile(req.file.path);
        }
        return;
      }
      if (!keys.has(key)) {
        res.status(400).send(`Unknown key: ${key}`);
        if (req.file) {
          deleteFile(req.file.path);
        }
        return;
      }

      const info = keys.get(key)!;
      expireKey(key, keys);

      // Stage URL if provided
      let submittedUrl: string | null = null;
      const rawUrl = ((req.body?.url as string) ?? '').trim();
      if (rawUrl) {
        if (rawUrl.length > 2048) {
          res.status(400).send('URL too long');
          if (req.file) {
            deleteFile(req.file.path);
          }
          return;
        }
        if (!isValidUrl(rawUrl)) {
          res.status(400).send('Invalid URL: only http and https are allowed');
          if (req.file) {
            deleteFile(req.file.path);
          }
          return;
        }
        if (info.urls.length >= MAX_URLS_PER_KEY) {
          res.status(400).send('URL limit reached');
          if (req.file) {
            deleteFile(req.file.path);
          }
          return;
        }
        if (!info.urls.includes(rawUrl)) {
          info.urls.push(rawUrl);
          submittedUrl = rawUrl;
          logger.info({ key, url: rawUrl, ip: clientIp(req) }, 'URL staged');
        }
      }

      if (!req.file && !submittedUrl) {
        res.status(400).send('No file or URL provided');
        return;
      }

      if (req.file) {
        if (req.file.size === 0) {
          res.status(400).send('Invalid file submitted (empty file)');
          deleteFile(req.file.path);
          return;
        }

        const { mimetype, detectedMime } = await detectMimetype(req.file.path, req.file.mimetype);

        if (!ALLOWED_TYPES.has(mimetype) && !(detectedMime && ALLOWED_TYPES.has(detectedMime))) {
          const ext = path.extname(req.file.originalname).substring(1);
          logger.warn({ key, mimetype, ext }, 'Upload rejected: unsupported type');
          res
            .status(400)
            .send(`Unsupported file type: ${req.file.originalname} (${detectedMime ?? mimetype})`);
          deleteFile(req.file.path);
          return;
        }

        // Check file count limit (combines committed + in-flight slots)
        if (info.files.length + info.pendingUploads >= MAX_FILES_PER_KEY) {
          res
            .status(400)
            .send(`File limit reached - this session supports up to ${MAX_FILES_PER_KEY} files`);
          deleteFile(req.file.path);
          return;
        }

        const conversionOptions = {
          kindlegen: !!req.body?.kindlegen,
          kepubify: !!req.body?.kepubify,
          pdfcropmargins: !!req.body?.pdfcropmargins,
        };

        const sanitised = sanitiseFilename(req.file.originalname, {
          transliterate: !!req.body?.transliteration,
          isKindle: info.agent.includes('Kindle'),
        });

        const predicted = predictConvertedFilename(
          sanitised,
          mimetype,
          info.agent,
          conversionOptions
        );
        const finalName = uniqueFilename(predicted, [
          ...info.files.map((f) => f.name),
          ...info.pendingFilenames,
        ]);

        // Reserve slot, filename, and disk pessimistically before any await
        info.pendingUploads++;
        info.pendingFilenames.push(finalName);
        reservePendingDisk(req.file.size);

        try {
          let convertedPath: string;
          let conversionTool: string | null;
          try {
            ({ convertedPath, conversionTool } = await runConversion(
              req.file.path,
              sanitised,
              mimetype,
              info.agent,
              conversionOptions,
              key
            ));
          } catch (convErr) {
            logger.error({ err: convErr, key }, 'Conversion failed');
            deleteFile(req.file.path);
            res.status(500).send(`Conversion failed: ${(convErr as Error).message}`);
            return;
          }

          const { size: convertedSize } = await fs.promises.stat(convertedPath);
          if (convertedSize > MAX_FILE_SIZE) {
            deleteFile(convertedPath);
            logger.warn({ key, convertedSize }, 'Upload rejected: converted file too large');
            res.status(413).send('Converted file too large');
            return;
          }

          // Disk check: subtract our own reservation, add actual converted size
          if (getEffectiveDiskUsage() - req.file.size + convertedSize > MAX_DISK_BYTES) {
            deleteFile(convertedPath);
            logger.warn(
              { key, convertedSize, diskUsage: getEffectiveDiskUsage() },
              'Upload rejected: disk limit reached'
            );
            res.status(507).send('Insufficient storage');
            return;
          }

          let metadataDiff: MetadataDiff | undefined;
          let metadataFailed = false;
          if (req.body?.fetchmetadata && mimetype === TYPE_EPUB) {
            try {
              logger.info({ key }, 'Fetching metadata from Google Books');
              metadataDiff = await updateEpubMetadata(convertedPath);
              logger.info({ key, changes: Object.keys(metadataDiff).length }, 'Metadata updated');
            } catch (metaErr) {
              logger.warn({ err: metaErr, key }, 'Metadata fetch skipped');
              metadataFailed = true;
            }
          }

          addDiskUsage(convertedSize);
          info.files.push({
            name: finalName,
            path: convertedPath,
            size: convertedSize,
            uploaded: new Date(),
            metadataDiff,
            downloadTimer: null,
          });
          expireKey(key, keys);
          logger.info(
            { key, filename: finalName, size: convertedSize, ip: clientIp(req) },
            'File staged'
          );
          notifySSE(key, info);

          res.send(
            buildSuccessMessage(
              deviceLabel(info.agent),
              conversionTool,
              finalName,
              submittedUrl,
              metadataFailed
            )
          );
        } finally {
          info.pendingUploads--;
          info.pendingFilenames = info.pendingFilenames.filter((n) => n !== finalName);
          releasePendingDisk(req.file.size);
        }
        return;
      }

      notifySSE(key, info);
      res.send(`URL added: ${submittedUrl}`);
    });
  });

  return router;
}
