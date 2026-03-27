/** Reads an integer from the environment, returning fallback if absent or non-numeric. */
export function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) {
    return fallback;
  }
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

export const PORT = envInt('PORT', 3001);
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? 'uploads';
export const EXPIRE_DELAY_MS = envInt('EXPIRE_DELAY_MS', 300_000);
export const MAX_EXPIRE_MS = envInt('MAX_EXPIRE_MS', 3_600_000);
export const MAX_FILE_SIZE = envInt('MAX_FILE_SIZE', 100 * 1024 * 1024);
export const MAX_ACTIVE_KEYS = envInt('MAX_ACTIVE_KEYS', 100);
export const FILE_DELETE_DELAY_MS = envInt('FILE_DELETE_DELAY_MS', 60_000);
export const RATE_LIMIT_WINDOW_MS = envInt('RATE_LIMIT_WINDOW_MS', 15 * 60_000);
export const RATE_LIMIT_MAX = envInt('RATE_LIMIT_MAX', 20);
export const STATUS_RATE_LIMIT_MAX = envInt('STATUS_RATE_LIMIT_MAX', 120);
export const UPLOAD_RATE_LIMIT_MAX = envInt('UPLOAD_RATE_LIMIT_MAX', 10);
export const DELETE_RATE_LIMIT_MAX = envInt('DELETE_RATE_LIMIT_MAX', 20);
export const EVENTS_RATE_LIMIT_MAX = envInt('EVENTS_RATE_LIMIT_MAX', 5);
export const DOWNLOAD_RATE_LIMIT_MAX = envInt('DOWNLOAD_RATE_LIMIT_MAX', 20);
export const MAX_KEYS_PER_IP = envInt('MAX_KEYS_PER_IP', 3);
export const MAX_DISK_BYTES = envInt('MAX_DISK_BYTES', 1 * 1024 * 1024 * 1024);
export const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY ?? '';
