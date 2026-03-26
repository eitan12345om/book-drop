import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX } from './config.js';
import { logger } from './logger.js';
import type { KeyInfo } from './types.js';
import { isEreaderAgent } from './utils.js';
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

  // Middleware
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
  app.use(
    helmet({
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
        },
      },
    })
  );
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

  // Routes
  app.get('/health', (_req, res) => res.send('ok'));
  app.use(makeKeysRouter(keys, sseClients));
  app.use(makeUploadRouter(keys, notifySSE));

  app.post('/share', (_req, res) => res.redirect('/'));
  app.get('/receive', (req, res, next) => {
    void serveHtml(VIEWS_DIR, 'download.html', nonceMap.get(req) ?? '', res, next);
  });
  app.get('/', (req, res, next) => {
    const page = isEreaderAgent(req.get('user-agent') ?? '') ? 'download.html' : 'upload.html';
    void serveHtml(VIEWS_DIR, page, nonceMap.get(req) ?? '', res, next);
  });

  return { app, keys };
}
