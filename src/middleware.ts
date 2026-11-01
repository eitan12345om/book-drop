import fsp from 'fs/promises';
import path from 'path';
import type express from 'express';
import rateLimit from 'express-rate-limit';
import { isValidKey, clientNetwork } from './utils.js';
import { logger } from './logger.js';
import type { KeyInfo } from './types.js';
import { RATE_LIMIT_WINDOW_MS } from './config.js';

export function makeLimiter(
  max: number,
  extras?: Partial<Parameters<typeof rateLimit>[0]>
): ReturnType<typeof rateLimit> {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => clientNetwork(req),
    ...extras,
  });
}

export async function serveHtml(
  viewsDir: string,
  file: string,
  nonce: string,
  res: express.Response,
  next: express.NextFunction,
  extras?: Record<string, string>
): Promise<void> {
  try {
    const raw = await fsp.readFile(path.join(viewsDir, file), 'utf-8');
    let content = raw.replace(/NONCE_PLACEHOLDER/g, nonce);
    if (content === raw) {
      logger.warn({ file }, 'serveHtml: no NONCE_PLACEHOLDER found — nonce not injected');
    }
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        content = content.replaceAll(key, value);
      }
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(content);
  } catch (err) {
    next(err);
  }
}

// CSRF protection: cross-origin forms can't set this header.
export const requireXhr: express.RequestHandler = (req, res, next) => {
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  next();
};

export function makeNotifySSE(sseClients: Map<string, express.Response>) {
  return function notifySSE(key: string, info: KeyInfo): void {
    const sse = sseClients.get(key);
    if (!sse) {
      logger.warn({ key }, 'notifySSE: no SSE client registered');
      return;
    }
    const payload = {
      alive: info.alive,
      files: info.files.map((f) => ({ name: f.name, metadataDiff: f.metadataDiff })),
      urls: info.urls,
    };
    sse.write(`data: ${JSON.stringify(payload)}\n\n`);
    (sse as unknown as { flush?: () => void }).flush?.();
  };
}

export function makeRequireKey(keys: Map<string, KeyInfo>): express.RequestHandler {
  return function requireKey(req, res, next) {
    const key = (req.params.key as string | undefined)?.toUpperCase() ?? '';
    if (!isValidKey(key)) {
      res.status(400).json({ error: 'Invalid key format.' });
      return;
    }
    const info = keys.get(key);
    if (!info) {
      res.status(404).json({ error: 'Unknown key.' });
      return;
    }
    res.locals.key = key;
    res.locals.keyInfo = info;
    next();
  };
}

export function makeRequireMatchingAgent(keys: Map<string, KeyInfo>): express.RequestHandler {
  return function requireMatchingAgent(req, res, next) {
    const key = (req.params.key as string | undefined)?.toUpperCase() ?? '';
    if (!isValidKey(key)) {
      res.status(400).json({ error: 'Invalid key format.' });
      return;
    }
    const info = keys.get(key);
    if (!info) {
      res.status(404).json({ error: 'Unknown key.' });
      return;
    }
    const ua = req.headers['user-agent'] ?? '';
    if (info.agent !== ua) {
      logger.warn({ key, expected: info.agent, got: ua }, 'UA mismatch');
      res.status(404).json({ error: 'Unknown key.' });
      return;
    }
    res.locals.key = key;
    res.locals.keyInfo = info;
    next();
  };
}
