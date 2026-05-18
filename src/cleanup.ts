import fsp from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';
import type { KeyInfo } from './types.js';

function getFileAgeMs(
  filePath: string,
  stat: Awaited<ReturnType<typeof fsp.stat>>,
  now: number
): number {
  const birthMs = Number(stat.birthtimeMs);
  // birthtimeMs may be 0 on NFS/some filesystems — fall back to filename timestamp
  if (birthMs > 0) {
    return now - birthMs;
  }
  const match = path.basename(filePath).match(/^file-(\d+)-/);
  return match ? now - parseInt(match[1], 10) : 0; // 0 = unknown age, don't delete
}

export async function cleanExpiredUploads(
  uploadDir: string,
  keys: Map<string, KeyInfo>,
  maxAgeMs: number,
  now = Date.now()
): Promise<void> {
  const trackedPaths = new Set([...keys.values()].flatMap((info) => info.files.map((f) => f.path)));
  const files = await fsp.readdir(uploadDir).catch(() => [] as string[]);
  let deleted = 0;
  let skipped = 0;
  for (const f of files) {
    const filePath = path.join(uploadDir, f);
    if (trackedPaths.has(filePath)) {
      skipped++;
      continue;
    }
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      continue;
    }
    if (getFileAgeMs(filePath, stat, now) > maxAgeMs) {
      await fsp.unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          logger.error({ err, filePath }, 'Failed to delete file');
        }
      });
      deleted++;
    }
  }
  logger.info({ deleted, skipped }, 'upload cleanup ran');
}
