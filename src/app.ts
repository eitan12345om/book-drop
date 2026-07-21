import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { DISABLE_HSTS } from './config.js';
import { logger } from './logger.js';
import type { KeyInfo } from './types.js';
import { isEreaderAgent, extractSharedUrl } from './utils.js';
import { serveHtml, makeNotifySSE } from './middleware.js';
import { makeKeysRouter } from './routes/keys.js';
import { makeUploadRouter } from './routes/upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Creates and returns the Express application and the active keys map. */
export function createApp(options?: { staticDir?: string; viewsDir?: string }) {
  const STATIC_DIR = options?.staticDir ?? path.join(__dirname, '../client/public');
  const VIEWS_DIR = options?.viewsDir ?? path.join(__dirname, '../client/views');
  const keys = new Map<string, KeyInfo>();
  const sseClients = new Map<string, express.Response>();
  const app = express();

  const nonceMap = new WeakMap<IncomingMessage, string>();
  const notifySSE = makeNotifySSE(sseClients);

  app.use(
    compression({
      filter: (req, res) => {
        if (req.path.startsWith('/events/')) {
          return false;
        }
        return compression.filter(req, res);
      },
    })
  );
  app.use((req, _res, next) => {
    nonceMap.set(req, crypto.randomBytes(16).toString('base64'));
    next();
  });
  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
    );
    next();
  });
  app.use(
    helmet({
      hsts: DISABLE_HSTS ? false : { maxAge: 31536000, includeSubDomains: true },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", (req) => `'nonce-${nonceMap.get(req) ?? ''}'`],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          workerSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: DISABLE_HSTS ? null : [],
        },
      },
    })
  );
  app.set('trust proxy', 1);

  app.get('/health', (_req, res) => {
    logger.debug('health check');
    res.send('ok');
  });

  app.use((req, res, next) => {
    if (!DISABLE_HSTS && !req.secure) {
      res
        .status(400)
        .type('text')
        .send(
          'Book-Drop is configured to use HSTS, but you connected over HTTP. Either connect over HTTPS or set environment variable "DISABLE_HSTS=1" to disable.'
        );

      return;
    }

    next();
  });

  app.use(express.static(STATIC_DIR));

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

  app.use(makeKeysRouter(keys, sseClients, notifySSE));
  app.use(makeUploadRouter(keys, notifySSE));

  // Web Share Target. A service worker normally handles /share client-side; this is
  // the fallback when it isn't yet controlling the page. Shared files can't be recovered
  // here (no session), but a shared link can — extract it and hand it to the upload page.
  // multer().none() parses the multipart text fields; a stray file field just errors,
  // which we swallow and treat as "no url".
  const parseShare = multer().none();
  app.post('/share', (req, res) => {
    parseShare(req, res, () => {
      const url = extractSharedUrl((req.body ?? {}) as { url?: unknown; text?: unknown });
      res.redirect(303, url ? `/?shared_url=${encodeURIComponent(url)}` : '/');
    });
  });
  app.get('/receive', (req, res, next) => {
    const ereaderClass = isEreaderAgent(req.get('user-agent') ?? '') ? 'ereader' : '';
    void serveHtml(VIEWS_DIR, 'download.html', nonceMap.get(req) ?? '', res, next, {
      EREADER_CLASS_PLACEHOLDER: ereaderClass,
    });
  });
  app.get('/', (req, res, next) => {
    const ua = req.get('user-agent') ?? '';
    const isEreader = isEreaderAgent(ua);
    const page = isEreader ? 'download.html' : 'upload.html';
    const extras = isEreader ? { EREADER_CLASS_PLACEHOLDER: 'ereader' } : undefined;
    void serveHtml(VIEWS_DIR, page, nonceMap.get(req) ?? '', res, next, extras);
  });

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof URIError) {
        res.status(400).json({ error: 'Bad request.' });
        return;
      }
      logger.error({ err }, 'Unhandled error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error.' });
      }
    }
  );

  return { app, keys };
}
