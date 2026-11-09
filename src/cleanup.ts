import fsp from 'fs/promises';
import type { Stats } from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { KINDLING_WORK_DIR_PREFIX } from './converter.js';
import type { KeyInfo } from './types.js';

function getFileAgeMs(filePath: string, stat: Stats, now: number): number {
  const birthMs = Number(stat.birthtimeMs);
  // birthtimeMs is 0 on NFS and some other filesystems.
  if (birthMs > 0) {
    return now - birthMs;
  }
  const match = path.basename(filePath).match(/^file-(\d+)-/);
  return match ? now - parseInt(match[1], 10) : 0; // unknown age must never qualify for deletion
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
    // A conversion's scratch folder outlives it only if the server stopped mid-conversion.
    if (stat?.isDirectory() && f.startsWith(KINDLING_WORK_DIR_PREFIX)) {
      if (getFileAgeMs(filePath, stat, now) > maxAgeMs) {
        await fsp.rm(filePath, { recursive: true, force: true });
        deleted++;
      }
      continue;
    }
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
