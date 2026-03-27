import path from 'path';
import express from 'express';
import QRCode from 'qrcode';
import { generateUniqueKey, expireKey, removeKey, clearFile } from '../keyStore.js';
import {
  MAX_EXPIRE_MS,
  MAX_ACTIVE_KEYS,
  MAX_KEYS_PER_IP,
  FILE_DELETE_DELAY_MS,
  RATE_LIMIT_MAX,
  STATUS_RATE_LIMIT_MAX,
  DELETE_RATE_LIMIT_MAX,
  EVENTS_RATE_LIMIT_MAX,
  DOWNLOAD_RATE_LIMIT_MAX,
} from '../config.js';
import { logger } from '../logger.js';
import type { KeyInfo } from '../types.js';
import { isValidKey, clientIp } from '../utils.js';
import { makeRequireKey, makeRequireMatchingAgent, makeLimiter } from '../middleware.js';

export function makeKeysRouter(
  keys: Map<string, KeyInfo>,
  sseClients: Map<string, express.Response>
): express.Router {
  const router = express.Router();
  const requireKey = makeRequireKey(keys);
  const requireMatchingAgent = makeRequireMatchingAgent(keys);

  const generateLimiter = makeLimiter(RATE_LIMIT_MAX);
  const statusLimiter = makeLimiter(STATUS_RATE_LIMIT_MAX, { skipSuccessfulRequests: true });
  const deleteLimiter = makeLimiter(DELETE_RATE_LIMIT_MAX);
  const eventsLimiter = makeLimiter(EVENTS_RATE_LIMIT_MAX);
  const downloadLimiter = makeLimiter(DOWNLOAD_RATE_LIMIT_MAX);

  router.post('/generate', generateLimiter, async (req, res) => {
    if (keys.size >= MAX_ACTIVE_KEYS) {
      logger.warn({ activeKeys: keys.size }, 'Key rejected: server busy');
      res.status(503).send('Server busy');
      return;
    }
    const ip = clientIp(req);
    const keysForIp = [...keys.values()].filter((k) => k.ip === ip).length;
    if (keysForIp >= MAX_KEYS_PER_IP) {
      logger.warn({ ip, keysForIp }, 'Key rejected: per-IP limit reached');
      res.status(429).send('Too many active sessions');
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
      ip,
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

    logger.info({ key, ip, activeKeys: keys.size }, 'Generated key');

    res.json({ key });
  });

  router.get('/qr/:key', generateLimiter, requireKey, async (req, res) => {
    const key: string = res.locals.key;
    const origin = `${req.protocol}://${req.get('host')}`;
    const uploadUrl = `${origin}/?key=${key}`;
    const png = await QRCode.toBuffer(uploadUrl, { margin: 1 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  });

  router.get('/status/:key', statusLimiter, requireMatchingAgent, (req, res) => {
    const key: string = res.locals.key;
    const info: KeyInfo = res.locals.keyInfo;
    expireKey(key, keys);
    res.json({
      alive: info.alive,
      file: info.file ? { name: info.file.name, metadataDiff: info.file.metadataDiff } : null,
      urls: info.urls,
    });
  });

  router.get('/device/:key', generateLimiter, requireKey, (_req, res) => {
    const info: KeyInfo = res.locals.keyInfo;
    const agent = info.agent.toLowerCase();
    const device = agent.includes('kobo')
      ? 'Kobo'
      : agent.includes('kindle')
        ? 'Kindle'
        : agent.includes('tolino')
          ? 'Tolino'
          : 'unknown';
    res.json({ device });
  });

  router.get('/events/:key', eventsLimiter, requireMatchingAgent, (req, res) => {
    const key: string = res.locals.key;
    const info: KeyInfo = res.locals.keyInfo;

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
    logger.info({ key }, 'SSE client connected');

    const snapshot = {
      alive: info.alive,
      file: info.file ? { name: info.file.name } : null,
      urls: info.urls,
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    (res as unknown as { flush?: () => void }).flush?.();

    const maxDurationTimer = setTimeout(() => {
      res.write('event: expired\ndata: {}\n\n');
      (res as unknown as { flush?: () => void }).flush?.();
      res.end();
      sseClients.delete(key);
      logger.info({ key }, 'SSE connection reached max duration');
    }, 30 * 60_000).unref();

    req.on('close', () => {
      clearTimeout(maxDurationTimer);
      sseClients.delete(key);
    });
  });

  router.delete('/file/:key', deleteLimiter, (req, res) => {
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
    clearFile(info);
    res.send('ok');
  });

  router.get('/:filename', downloadLimiter, (req, res, next) => {
    const key = (req.query.key as string | undefined)?.toUpperCase();
    if (!key || !isValidKey(key)) {
      return next();
    }

    const filename = decodeURIComponent(req.params.filename as string);
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
            clearFile(info);
          }
        }, FILE_DELETE_DELAY_MS).unref();
      }
    });

    if (info.agent.includes('Kindle')) {
      res.download(absPath, filename);
    } else {
      res.sendFile(absPath);
    }
  });

  return router;
}
