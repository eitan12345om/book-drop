import path from 'path';
import fs from 'fs';
import express from 'express';
import QRCode from 'qrcode';
import {
  generateUniqueKey,
  expireKey,
  removeKey,
  clearFiles,
  subtractDiskUsage,
  addDiskUsage,
} from '../keyStore.js';
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
  SSE_MAX_DURATION_MS,
  SSE_HEARTBEAT_MS,
} from '../config.js';
import { logger } from '../logger.js';
import type { KeyInfo } from '../types.js';
import { isValidKey, clientIp } from '../utils.js';
import {
  makeRequireKey,
  makeRequireMatchingAgent,
  makeLimiter,
  requireXhr,
} from '../middleware.js';

export function makeKeysRouter(
  keys: Map<string, KeyInfo>,
  sseClients: Map<string, express.Response>,
  notifySSE: (key: string, info: KeyInfo) => void
): express.Router {
  const router = express.Router();
  const requireKey = makeRequireKey(keys);
  const requireMatchingAgent = makeRequireMatchingAgent(keys);

  const generateLimiter = makeLimiter(RATE_LIMIT_MAX);
  const statusLimiter = makeLimiter(STATUS_RATE_LIMIT_MAX, { skipSuccessfulRequests: true });
  const deleteLimiter = makeLimiter(DELETE_RATE_LIMIT_MAX);
  const eventsLimiter = makeLimiter(EVENTS_RATE_LIMIT_MAX);
  const downloadLimiter = makeLimiter(DOWNLOAD_RATE_LIMIT_MAX);

  router.post('/generate', requireXhr, generateLimiter, async (req, res) => {
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
      res.status(503).send('Server busy');
      return;
    }

    const info: KeyInfo = {
      created: new Date(),
      ip,
      agent,
      files: [],
      urls: [],
      timer: null,
      pendingUploads: 0,
      pendingFilenames: [],
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

    const abandonKey =
      typeof req.query.abandon === 'string' ? req.query.abandon.toUpperCase() : null;
    if (abandonKey && isValidKey(abandonKey) && keys.has(abandonKey)) {
      removeKey(abandonKey, keys);
    }

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
      files: info.files.map((f) => ({ name: f.name, metadataDiff: f.metadataDiff })),
      urls: info.urls,
    });
  });

  router.get('/device/:key', generateLimiter, (req, res) => {
    const key = (req.params.key as string | undefined)?.toUpperCase() ?? '';
    const info = isValidKey(key) ? keys.get(key) : undefined;
    if (!info) {
      res.json({ device: 'unknown' });
      return;
    }
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
      files: info.files.map((f) => ({ name: f.name, metadataDiff: f.metadataDiff })),
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
    }, SSE_MAX_DURATION_MS).unref();

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
      (res as unknown as { flush?: () => void }).flush?.();
    }, SSE_HEARTBEAT_MS).unref();

    req.on('close', () => {
      clearTimeout(maxDurationTimer);
      clearInterval(heartbeat);
      sseClients.delete(key);
    });
  });

  router.delete('/file/:key/:filename', requireXhr, deleteLimiter, (req, res) => {
    const key = (req.params.key as string).toUpperCase();
    if (!isValidKey(key)) {
      res.status(400).send('Invalid key format');
      return;
    }
    const info = keys.get(key);
    if (!info) {
      res.status(404).send('Unknown key');
      return;
    }
    let filename: string;
    try {
      filename = decodeURIComponent(req.params.filename as string);
    } catch {
      res.status(400).send('Bad filename');
      return;
    }
    const idx = info.files.findIndex((f) => f.name === filename);
    if (idx === -1) {
      res.status(404).send('File not found');
      return;
    }
    const fileEntry = info.files[idx];
    if (fileEntry.downloadTimer) {
      clearTimeout(fileEntry.downloadTimer);
    }
    subtractDiskUsage(fileEntry.size);
    fs.unlink(fileEntry.path, (err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err }, 'Error deleting file');
      }
    });
    info.files.splice(idx, 1);
    logger.info({ key, filename }, 'File deleted by user');
    notifySSE(key, info);
    res.send('ok');
  });

  router.delete('/file/:key', requireXhr, deleteLimiter, (req, res) => {
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
    clearFiles(info);
    notifySSE(key, info);
    res.send('ok');
  });

  router.get('/:filename', downloadLimiter, (req, res, next) => {
    const key = (req.query.key as string | undefined)?.toUpperCase();
    if (!key || !isValidKey(key)) {
      return next();
    }

    const filename = decodeURIComponent(req.params.filename as string);
    const info = keys.get(key);
    if (!info) {
      return next();
    }
    const fileEntry = info.files.find((f) => f.name === filename);
    if (!fileEntry) {
      return next();
    }

    expireKey(key, keys);
    logger.info({ filePath: fileEntry.path, filename }, 'Serving file');

    const absPath = path.resolve(fileEntry.path);
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && !fileEntry.downloadTimer) {
        fileEntry.downloadTimer = setTimeout(() => {
          logger.info({ key, filename }, 'File deleted after download delay');
          subtractDiskUsage(fileEntry.size);
          fs.unlink(fileEntry.path, (err) => {
            if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
              logger.error({ err }, 'Error deleting file after download');
              addDiskUsage(fileEntry.size); // rollback: file is still on disk
            }
          });
          info.files = info.files.filter((f) => f !== fileEntry);
          notifySSE(key, info);
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
