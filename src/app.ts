import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileTypeFromFile } from 'file-type';
import sanitize from 'sanitize-filename';
import rateLimit from 'express-rate-limit';
import { generateUniqueKey, expireKey, removeKey } from './keyStore.js';
import {
  convertWithKindlegen,
  convertWithKepubify,
  convertWithPdfCropMargins,
} from './converter.js';
import {
  MAX_EXPIRE_MS,
  MAX_FILE_SIZE,
  MAX_ACTIVE_KEYS,
  FILE_DELETE_DELAY_MS,
  UPLOAD_DIR,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  STATUS_RATE_LIMIT_MAX,
  UPLOAD_RATE_LIMIT_MAX,
  DELETE_RATE_LIMIT_MAX,
  EVENTS_RATE_LIMIT_MAX,
} from './config.js';
import { logger } from './logger.js';
import type { KeyInfo } from './types.js';
import {
  isValidKey,
  isEreaderAgent,
  isValidUrl,
  deleteFile,
  doTransliterate,
  TYPE_EPUB,
  ALLOWED_TYPES,
  ALLOWED_EXTENSIONS,
} from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Creates and returns the Express application and the active keys map. */
export function createApp(options?: { staticDir?: string }) {
  const STATIC_DIR = options?.staticDir ?? path.join(__dirname, '../client/public');
  const keys = new Map<string, KeyInfo>();
  const sseClients = new Map<string, express.Response>();
  const app = express();

  function notifySSE(key: string, info: KeyInfo): void {
    const sse = sseClients.get(key);
    if (!sse) {
      return;
    }
    const payload = {
      alive: info.alive,
      file: info.file ? { name: info.file.name } : null,
      urls: info.urls,
    };
    sse.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  app.use(compression());
  app.use(helmet({ contentSecurityPolicy: false }));
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          ms: Date.now() - start,
          ua: req.get('user-agent'),
        },
        '%s %s %d',
        req.method,
        req.url,
        res.statusCode
      );
    });
    next();
  });
  app.use(express.static(STATIC_DIR));

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

  const generateLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const statusLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: STATUS_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });

  const uploadLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: UPLOAD_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const deleteLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: DELETE_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const eventsLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: EVENTS_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post('/generate', generateLimiter, (req, res) => {
    if (keys.size >= MAX_ACTIVE_KEYS) {
      logger.warn({ activeKeys: keys.size }, 'Key rejected: server busy');
      res.status(503).send('Server busy');
      return;
    }
    const agent = req.get('user-agent') ?? '';
    const key = generateUniqueKey(keys);
    if (!key) {
      logger.warn('Key rejected: could not generate unique key');
      res.status(503).send('error');
      return;
    }

    const info: KeyInfo = {
      created: new Date(),
      agent,
      file: null,
      urls: [],
      timer: null,
      downloadTimer: null,
      alive: new Date(),
    };
    info.onRemove = () => {
      const sse = sseClients.get(key);
      if (sse) {
        sse.write('event: expired\ndata: {}\n\n');
        sse.end();
        sseClients.delete(key);
      }
    };
    keys.set(key, info);
    expireKey(key, keys);

    setTimeout(() => {
      if (keys.get(key) === info) {
        logger.info({ key }, 'Key hard-expired');
        removeKey(key, keys);
      }
    }, MAX_EXPIRE_MS).unref();

    logger.info({ key, ip: req.ip, activeKeys: keys.size }, 'Generated key');
    res.send(key);
  });

  app.get('/status/:key', statusLimiter, (req, res) => {
    const key = (req.params.key as string).toUpperCase();
    if (!isValidKey(key)) {
      res.status(400).json({ error: 'Invalid key format' });
      return;
    }
    const info = keys.get(key);

    if (!info) {
      res.status(404).json({ error: 'Unknown key' });
      return;
    }

    const requestAgent = req.get('user-agent') ?? '';
    if (info.agent !== requestAgent) {
      logger.warn({ key, expected: info.agent, got: requestAgent }, 'UA mismatch for key');
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    expireKey(key, keys);
    res.json({
      alive: info.alive,
      file: info.file ? { name: info.file.name } : null,
      urls: info.urls,
    });
  });

  app.get('/events/:key', eventsLimiter, (req, res) => {
    const key = (req.params.key as string).toUpperCase();
    if (!isValidKey(key)) {
      res.status(400).json({ error: 'Invalid key format' });
      return;
    }
    const info = keys.get(key);
    if (!info) {
      res.status(404).json({ error: 'Unknown key' });
      return;
    }
    const requestAgent = req.get('user-agent') ?? '';
    if (info.agent !== requestAgent) {
      logger.warn({ key, expected: info.agent, got: requestAgent }, 'UA mismatch for SSE');
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Displace any existing connection for this key
    const existing = sseClients.get(key);
    if (existing) {
      existing.end();
      sseClients.delete(key);
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    sseClients.set(key, res);
    expireKey(key, keys);

    // Send current state immediately
    const snapshot = {
      alive: info.alive,
      file: info.file ? { name: info.file.name } : null,
      urls: info.urls,
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

    // Close after 30 minutes to prevent indefinitely held sockets
    const maxDurationTimer = setTimeout(() => {
      res.write('event: expired\ndata: {}\n\n');
      res.end();
      sseClients.delete(key);
      logger.info({ key }, 'SSE connection reached max duration');
    }, 30 * 60_000).unref();

    req.on('close', () => {
      clearTimeout(maxDurationTimer);
      sseClients.delete(key);
    });
  });

  app.delete('/file/:key', deleteLimiter, (req, res) => {
    const key = (req.params.key as string).toUpperCase();
    if (!isValidKey(key)) {
      res.status(400).send('Invalid key format');
      return;
    }
    const info = keys.get(key);
    if (!info) {
      res.status(400).send(`Unknown key: ${key}`);
      return;
    }
    if (info.file) {
      deleteFile(info.file.path);
      info.file = null;
    }
    res.send('ok');
  });

  app.post('/upload', uploadLimiter, (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        logger.warn({ err: (err as Error).message }, 'Upload rejected');
        res.status(400).send((err as Error).message);
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
        if (!info.urls.includes(rawUrl)) {
          info.urls.push(rawUrl);
          submittedUrl = rawUrl;
          logger.info({ key, url: rawUrl, ip: req.ip }, 'URL staged');
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

        let mimetype = req.file.mimetype;
        const detected = await fileTypeFromFile(req.file.path);
        if (mimetype === 'application/octet-stream' && detected) {
          mimetype = detected.mime;
        }
        // Normalise non-standard epub MIME type sent by some clients
        if (mimetype === 'application/epub') {
          mimetype = TYPE_EPUB;
        }

        if (!ALLOWED_TYPES.has(mimetype) && !(detected && ALLOWED_TYPES.has(detected.mime))) {
          const ext = path.extname(req.file.originalname).substring(1);
          logger.warn({ key, mimetype, ext }, 'Upload rejected: unsupported type');
          res
            .status(400)
            .send(
              `Unsupported file type: ${req.file.originalname} (${detected?.mime ?? mimetype})`
            );
          deleteFile(req.file.path);
          return;
        }

        let filename = req.file.originalname;
        if (req.body?.transliteration) {
          filename = sanitize(doTransliterate(filename));
        }
        // Kindle only supports a limited ASCII character set in filenames
        if (info.agent.includes('Kindle')) {
          filename = filename.replace(/[^.\w\-"'()]/g, '_');
        }

        let convertedPath: string;
        let conversionTool: string | null = null;

        try {
          if (mimetype === TYPE_EPUB && info.agent.includes('Kindle') && req.body?.kindlegen) {
            conversionTool = 'KindleGen';
            filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi');
            logger.info({ key, tool: conversionTool, mimetype }, 'Conversion started');
            convertedPath = await convertWithKindlegen(req.file.path);
            logger.info({ key, tool: conversionTool }, 'Conversion succeeded');
          } else if (mimetype === TYPE_EPUB && info.agent.includes('Kobo') && req.body?.kepubify) {
            conversionTool = 'Kepubify';
            filename = filename
              .replace(/\.kepub\.epub$/i, '.epub')
              .replace(/\.epub$/i, '.kepub.epub');
            logger.info({ key, tool: conversionTool, mimetype }, 'Conversion started');
            convertedPath = await convertWithKepubify(req.file.path);
            logger.info({ key, tool: conversionTool }, 'Conversion succeeded');
          } else if (mimetype === 'application/pdf' && req.body?.pdfcropmargins) {
            conversionTool = 'pdfCropMargins';
            logger.info({ key, tool: conversionTool, mimetype }, 'Conversion started');
            convertedPath = await convertWithPdfCropMargins(req.file.path);
            logger.info({ key, tool: conversionTool }, 'Conversion succeeded');
          } else {
            convertedPath = req.file.path;
          }
        } catch (convErr) {
          logger.error({ err: convErr, key, tool: conversionTool }, 'Conversion failed');
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

        if (info.file?.path) {
          deleteFile(info.file.path);
        }
        info.file = { name: filename, path: convertedPath, uploaded: new Date() };
        expireKey(key, keys);
        logger.info({ key, filename, size: convertedSize, ip: req.ip }, 'File staged');
        notifySSE(key, info);

        const deviceName = info.agent.includes('Kobo')
          ? 'Kobo'
          : info.agent.includes('Kindle')
            ? 'Kindle'
            : 'your device';

        const messages = [
          conversionTool
            ? `Sent to ${deviceName} (converted with ${conversionTool})`
            : `Sent to ${deviceName}`,
          `Filename: ${filename}`,
        ];
        if (submittedUrl) {
          messages.push(`URL added: ${submittedUrl}`);
        }
        res.send(messages.join('\n'));
        return;
      }

      notifySSE(key, info);
      res.send(`URL added: ${submittedUrl}`);
    });
  });

  app.post('/share', (_req, res) => {
    res.redirect('/');
  });

  app.get('/receive', (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'download.html'));
  });

  app.get('/:filename', (req, res, next) => {
    const key = (req.query.key as string | undefined)?.toUpperCase();
    if (!key) {
      return next();
    }
    if (!isValidKey(key)) {
      return next();
    }

    const filename = decodeURIComponent(req.params.filename);
    const info = keys.get(key);

    if (!info?.file || info.file.name !== filename) {
      return next();
    }

    expireKey(key, keys);
    logger.info({ filePath: info.file.path, filename }, 'Serving file');

    const absPath = path.resolve(info.file.path);

    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && info.file && !info.downloadTimer) {
        info.downloadTimer = setTimeout(() => {
          if (info.file) {
            logger.info({ key, filename }, 'File deleted after download delay');
            deleteFile(info.file.path);
            info.file = null;
          }
        }, FILE_DELETE_DELAY_MS);
      }
    });

    if (info.agent.includes('Kindle')) {
      res.download(absPath, filename);
    } else {
      res.sendFile(absPath);
    }
  });

  app.get('/', (req, res) => {
    const agent = req.get('user-agent') ?? '';
    const page = isEreaderAgent(agent) ? 'download.html' : 'upload.html';
    res.sendFile(path.join(STATIC_DIR, page));
  });

  return { app, keys };
}
