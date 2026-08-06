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
import { backendFor, convert, ConversionError } from '../converter.js';
import type { ConversionIntent } from '../converter.js';
import { QueueFullError } from '../semaphore.js';
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
  formatLimit,
  clientIp,
  doTransliterate,
  updateEpubMetadata,
  hasZipEndRecord,
  invalidEpubMessage,
  detectEreader,
  newErrorRef,
  TYPE_EPUB,
  ALLOWED_TYPES,
  ALLOWED_EXTENSIONS,
} from '../utils.js';
import type { Ereader } from '../utils.js';
import { makeLimiter, requireXhr } from '../middleware.js';

async function detectMimetype(
  filePath: string,
  declared: string
): Promise<{ mimetype: string; detectedMime: string | undefined }> {
  const detected = await fileTypeFromFile(filePath);
  let mimetype = declared;
  if (mimetype === 'application/octet-stream' && detected) {
    mimetype = detected.mime;
  }
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

export interface ConversionOptions {
  kindle: boolean;
  kobo: boolean;
  pdfcrop: boolean;
}

/**
 * Decides which conversion the upload calls for, or null for a straight passthrough.
 * Which tool performs it is the registry's concern.
 */
function intentFor(
  mimetype: string,
  device: Ereader | null,
  options: ConversionOptions
): ConversionIntent | null {
  if (mimetype === TYPE_EPUB && device === 'Kindle' && options.kindle) {
    return 'kindle';
  }
  if (mimetype === TYPE_EPUB && device === 'Kobo' && options.kobo) {
    return 'kobo';
  }
  if (mimetype === 'application/pdf' && options.pdfcrop) {
    return 'pdfcrop';
  }
  return null;
}

/** Predicts the display filename after conversion without running it (pure function). */
function predictConvertedFilename(
  sanitised: string,
  mimetype: string,
  device: Ereader | null,
  options: ConversionOptions
): string {
  const intent = intentFor(mimetype, device, options);
  return intent ? backendFor(intent).outputName(sanitised) : sanitised;
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

const FILE_TOO_LARGE = `File too large — the limit is ${formatLimit(MAX_FILE_SIZE)} per file.`;

const CONVERSION_GUIDANCE: Record<ConversionIntent, string> = {
  kobo: 'Could not convert this EPUB to the Kobo format. Turn off the "Kobo format" option and send it again — Kobo readers open standard EPUBs fine, just without the kepub enhancements.',
  kindle:
    'Could not convert this EPUB to the Kindle format. Turn off the "Kindle format" option to send the original EPUB instead.',
  pdfcrop: 'Could not crop this PDF. Turn off "Crop PDF margins" to send the original PDF.',
};

const FALLBACK_GUIDANCE =
  'Conversion failed. Try sending the file again with the conversion options turned off to transfer the original file.';

async function runConversion(
  filePath: string,
  mimetype: string,
  device: Ereader | null,
  options: ConversionOptions,
  key: string
): Promise<{ convertedPath: string; conversionTool: string | null }> {
  const intent = intentFor(mimetype, device, options);
  if (!intent) {
    return { convertedPath: filePath, conversionTool: null };
  }
  const backend = backendFor(intent);
  logger.info({ key, intent, tool: backend.tool, mimetype }, 'Conversion started');
  const startedAt = Date.now();
  const convertedPath = await convert(intent, filePath);
  logger.info(
    { key, intent, tool: backend.tool, durationMs: Date.now() - startedAt },
    'Conversion succeeded'
  );
  return { convertedPath, conversionTool: backend.tool };
}

export function makeUploadRouter(
  keys: Map<string, KeyInfo>,
  notifySSE: (key: string, info: KeyInfo) => void
): express.Router {
  const router = express.Router();

  const uploadLimiter = makeLimiter(UPLOAD_RATE_LIMIT_MAX, {
    message: { error: 'Too many uploads. Please try again in a few minutes.' },
  });

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

  router.post('/upload', requireXhr, uploadLimiter, (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        // LIMIT_FILE_SIZE leaves a partial file on disk; clean it up before responding.
        // fileFilter errors set req.file to undefined (no disk write), so this is a no-op there.
        if (req.file) {
          deleteFile(req.file.path);
        }
        logger.warn({ err }, 'Upload rejected');
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: FILE_TOO_LARGE });
        } else {
          res.status(400).json({ error: (err as Error).message });
        }
        return;
      }

      const key = ((req.body?.key as string) ?? '').toUpperCase();
      if (!isValidKey(key)) {
        res.status(400).json({ error: 'Invalid key format' });
        if (req.file) {
          deleteFile(req.file.path);
        }
        return;
      }
      if (!keys.has(key)) {
        res.status(400).json({ error: `Unknown key: ${key}` });
        if (req.file) {
          deleteFile(req.file.path);
        }
        return;
      }

      const info = keys.get(key)!;
      expireKey(key, keys);

      let submittedUrl: string | null = null;
      const rawUrl = ((req.body?.url as string) ?? '').trim();
      if (rawUrl) {
        if (rawUrl.length > 2048) {
          res.status(400).json({ error: 'URL too long' });
          if (req.file) {
            deleteFile(req.file.path);
          }
          return;
        }
        if (!isValidUrl(rawUrl)) {
          res.status(400).json({ error: 'Invalid URL: only http and https are allowed' });
          if (req.file) {
            deleteFile(req.file.path);
          }
          return;
        }
        if (info.urls.length >= MAX_URLS_PER_KEY) {
          res.status(400).json({ error: 'URL limit reached' });
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
        res.status(400).json({ error: 'No file or URL provided' });
        return;
      }

      if (req.file) {
        if (req.file.size === 0) {
          res.status(400).json({ error: 'Invalid file submitted (empty file)' });
          deleteFile(req.file.path);
          return;
        }

        const { mimetype, detectedMime } = await detectMimetype(req.file.path, req.file.mimetype);

        const isEpub =
          mimetype === TYPE_EPUB || path.extname(req.file.originalname).toLowerCase() === '.epub';
        if (isEpub && !(await hasZipEndRecord(req.file.path))) {
          logger.warn(
            { key, mimetype, detectedMime, size: req.file.size },
            'Upload rejected: invalid EPUB'
          );
          res.status(422).json({ error: invalidEpubMessage(req.file.originalname) });
          deleteFile(req.file.path);
          return;
        }

        if (!ALLOWED_TYPES.has(mimetype) && !(detectedMime && ALLOWED_TYPES.has(detectedMime))) {
          const ext = path.extname(req.file.originalname).substring(1);
          logger.warn({ key, mimetype, ext }, 'Upload rejected: unsupported type');
          res.status(400).json({
            error: `Unsupported file type: ${req.file.originalname} (${detectedMime ?? mimetype})`,
          });
          deleteFile(req.file.path);
          return;
        }

        if (info.files.length + info.pendingUploads >= MAX_FILES_PER_KEY) {
          res.status(400).json({
            error: `File limit reached - this session supports up to ${MAX_FILES_PER_KEY} files`,
          });
          deleteFile(req.file.path);
          return;
        }

        const conversionOptions: ConversionOptions = {
          kindle: !!(req.body?.kindle ?? req.body?.kindlegen),
          kobo: !!(req.body?.kobo ?? req.body?.kepubify),
          pdfcrop: !!(req.body?.pdfcrop ?? req.body?.pdfcropmargins),
        };

        const device = detectEreader(info.agent);
        const sanitised = sanitiseFilename(req.file.originalname, {
          transliterate: !!req.body?.transliteration,
          isKindle: device === 'Kindle',
        });

        const predicted = predictConvertedFilename(sanitised, mimetype, device, conversionOptions);
        const finalName = uniqueFilename(predicted, [
          ...info.files.map((f) => f.name),
          ...info.pendingFilenames,
        ]);

        // Reserve slot, filename, and disk pessimistically before any await
        info.pendingUploads++;
        info.pendingFilenames.push(finalName);
        reservePendingDisk(req.file.size);

        try {
          let metadataDiff: MetadataDiff | undefined;
          let metadataFailed = false;
          if (req.body?.fetchmetadata && mimetype === TYPE_EPUB) {
            try {
              logger.info({ key }, 'Fetching metadata from Google Books');
              metadataDiff = await updateEpubMetadata(req.file.path);
              logger.info({ key, changes: Object.keys(metadataDiff).length }, 'Metadata updated');
            } catch (metaErr) {
              logger.warn({ err: metaErr, key }, 'Metadata fetch skipped');
              metadataFailed = true;
            }
          }

          let convertedPath: string;
          let conversionTool: string | null;
          const conversionStartedAt = Date.now();
          try {
            ({ convertedPath, conversionTool } = await runConversion(
              req.file.path,
              mimetype,
              device,
              conversionOptions,
              key
            ));
          } catch (convErr) {
            const ref = newErrorRef();
            deleteFile(req.file.path);
            const durationMs = Date.now() - conversionStartedAt;
            if (convErr instanceof QueueFullError) {
              logger.warn({ key, durationMs }, 'Conversion rejected: too many in progress');
              res.set('Retry-After', '30').status(503).json({
                error: 'Too many conversions in progress — please try again in a moment.',
              });
              return;
            }
            const tool = convErr instanceof ConversionError ? convErr.tool : null;
            const intent = convErr instanceof ConversionError ? convErr.intent : undefined;
            const turnOff = (intent && CONVERSION_GUIDANCE[intent]) ?? FALLBACK_GUIDANCE;
            if (convErr instanceof ConversionError && convErr.toolMissing) {
              logger.error({ err: convErr, key, tool, intent, ref }, 'Converter is not installed');
              res.status(500).json({ error: turnOff, ref });
              return;
            }
            if (convErr instanceof ConversionError && convErr.timedOut) {
              logger.error(
                { err: convErr, key, tool, intent, ref, durationMs },
                'Conversion timed out'
              );
              res.status(504).json({ error: turnOff, ref });
              return;
            }
            logger.warn({ err: convErr, key, tool, intent, ref, durationMs }, 'Conversion failed');
            res.status(400).json({
              error: (convErr instanceof ConversionError && convErr.userMessage) || turnOff,
              ref,
            });
            return;
          }

          const { size: convertedSize } = await fs.promises.stat(convertedPath);
          if (convertedSize > MAX_FILE_SIZE) {
            deleteFile(convertedPath);
            logger.warn({ key, convertedSize }, 'Upload rejected: converted file too large');
            res.status(413).json({ error: 'Converted file too large' });
            return;
          }

          if (getEffectiveDiskUsage() - req.file.size + convertedSize > MAX_DISK_BYTES) {
            deleteFile(convertedPath);
            logger.warn(
              { key, convertedSize, diskUsage: getEffectiveDiskUsage() },
              'Upload rejected: disk limit reached'
            );
            res.status(507).json({ error: 'Insufficient storage' });
            return;
          }

          if (keys.get(key) !== info) {
            deleteFile(convertedPath);
            logger.warn({ key }, 'Upload discarded: session ended during processing');
            res.status(410).json({
              error: 'This session has ended. Enter the new key from your e-reader and try again.',
            });
            return;
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
            {
              key,
              filename: finalName,
              ext: path.extname(finalName).slice(1),
              mimetype,
              converted: conversionTool !== null,
              size: convertedSize,
              originalSize: req.file.size,
              ip: clientIp(req),
            },
            'File staged'
          );
          notifySSE(key, info);

          res.json({
            device: device ?? 'your device',
            filename: finalName,
            conversionTool,
            url: submittedUrl,
            metadataFailed,
          });
        } finally {
          info.pendingUploads--;
          info.pendingFilenames = info.pendingFilenames.filter((n) => n !== finalName);
          releasePendingDisk(req.file.size);
        }
        return;
      }

      notifySSE(key, info);
      res.json({ url: submittedUrl });
    });
  });

  return router;
}
