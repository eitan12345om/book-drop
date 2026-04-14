import crypto from 'node:crypto';
import fs from 'fs';
import type { KeyInfo } from './types.js';
import { logger } from './logger.js';
import { EXPIRE_DELAY_MS } from './config.js';

let diskUsageBytes = 0;
let pendingDiskBytes = 0;

export function addDiskUsage(bytes: number): void {
  diskUsageBytes += bytes;
}
export function subtractDiskUsage(bytes: number): void {
  diskUsageBytes = Math.max(0, diskUsageBytes - bytes);
}
export function getDiskUsage(): number {
  return diskUsageBytes;
}
export function reservePendingDisk(bytes: number): void {
  pendingDiskBytes += bytes;
}
export function releasePendingDisk(bytes: number): void {
  pendingDiskBytes = Math.max(0, pendingDiskBytes - bytes);
}
export function getEffectiveDiskUsage(): number {
  return diskUsageBytes + pendingDiskBytes;
}

/** Cancels all download timers, unlinks all staged files, subtracts their sizes, and empties info.files. */
export function clearFiles(info: KeyInfo): void {
  if (info.files.length > 1) {
    logger.warn({ count: info.files.length }, 'Clearing multiple staged files');
  }
  for (const file of info.files) {
    if (file.downloadTimer) {
      clearTimeout(file.downloadTimer);
    }
    subtractDiskUsage(file.size);
    fs.unlink(file.path, (err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err }, 'Error deleting file');
        addDiskUsage(file.size); // rollback: file is still on disk
      }
    });
  }
  info.files = [];
}

export const KEY_CHARS = '23456789ACDEFGHJKLMNPRSTUVWXYZ';
export const KEY_LENGTH = 4;

/** Generates a random session key from KEY_CHARS. */
export function randomKey(): string {
  return Array.from(
    { length: KEY_LENGTH },
    () => KEY_CHARS[crypto.randomInt(KEY_CHARS.length)]
  ).join('');
}

/** Generates a key that does not collide with any existing key in the map, or returns null if too many attempts fail. */
export function generateUniqueKey(keys: Map<string, KeyInfo>): string | null {
  let attempts = 0;
  let key: string;
  do {
    if (++attempts > Math.max(keys.size * 2 + 20, 100)) {
      return null;
    }
    key = randomKey();
  } while (keys.has(key));
  return key;
}

/** Removes a key from the map, cancels its timers, and deletes its staged files. */
export function removeKey(key: string, keys: Map<string, KeyInfo>): void {
  const info = keys.get(key);
  if (!info) {
    return;
  }
  info.onRemove?.();
  if (info.timer) {
    clearTimeout(info.timer);
  }
  clearFiles(info);
  keys.delete(key);
  logger.info({ key }, 'Key removed');
}

/** Resets the inactivity expiry timer for a key and updates its alive timestamp. */
export function expireKey(key: string, keys: Map<string, KeyInfo>): void {
  const info = keys.get(key);
  if (!info) {
    return;
  }
  if (info.timer) {
    clearTimeout(info.timer);
  }
  info.timer = setTimeout(() => removeKey(key, keys), EXPIRE_DELAY_MS).unref();
  info.alive = new Date();
}
