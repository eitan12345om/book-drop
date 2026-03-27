import http from 'http';
import fs from 'fs/promises';
import express from 'express';
import { createApp } from './app.js';
import { logger } from './logger.js';
import { PORT, UPLOAD_DIR } from './config.js';

async function main(): Promise<void> {
  await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const { app } = createApp();

  const server = http.createServer(app);

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

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
