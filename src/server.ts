import http from 'http';
import fs from 'fs/promises';
import express from 'express';
import { createApp } from './app.js';
import { logger } from './logger.js';
import { PORT, UPLOAD_DIR, MAX_EXPIRE_MS, UPLOAD_CLEANUP_INTERVAL_MS } from './config.js';
import { cleanExpiredUploads } from './cleanup.js';

async function main(): Promise<void> {
  const { app, keys } = createApp();

  await cleanExpiredUploads(UPLOAD_DIR, keys, MAX_EXPIRE_MS);
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const server = http.createServer(app);

  const cleanupTimer = setInterval(
    () => void cleanExpiredUploads(UPLOAD_DIR, keys, MAX_EXPIRE_MS),
    UPLOAD_CLEANUP_INTERVAL_MS
  );

  function shutdown() {
    clearInterval(cleanupTimer);
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Handle Expect: 100-continue — send the interim response before Express
  // reads the body, so large uploads aren't streamed before validation.
  server.on('checkContinue', (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeContinue();
    app(req as express.Request, res as express.Response, () => {});
  });

  server.listen(PORT, () => {
    logger.info({ port: PORT }, `book-drop listening on http://localhost:${PORT}`);
  });
}

process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err: Error) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
