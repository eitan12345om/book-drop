/** Reads an integer from the environment, returning fallback if absent or non-numeric. */
export function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) {
    return fallback;
  }
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

/**
 * Reads a count from the environment, never returning less than min.
 *
 * Clamping matters most for a concurrency limit, where zero reads like "no limit" but
 * would mean the opposite: no conversion could ever claim a slot, so every upload would
 * wait out the queue timeout and be refused. The effective values are logged at startup.
 */
export function envCount(key: string, fallback: number, min: number): number {
  return Math.max(min, envInt(key, fallback));
}

/** Reads one of a fixed set of values from the environment, returning fallback if unset or unrecognised. */
export function envChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const val = process.env[key]?.trim().toLowerCase();
  return allowed.includes(val as T) ? (val as T) : fallback;
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
export const MAX_FILES_PER_KEY = envInt('MAX_FILES_PER_KEY', 5);
export const MAX_URLS_PER_KEY = envInt('MAX_URLS_PER_KEY', 20);
export const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY ?? '';
export const DISABLE_HSTS = process.env.DISABLE_HSTS === '1';
// Injected into HTML, so restricted to characters that are safe there.
export const BOOKDROP_VERSION = /^[\w.+-]{1,64}$/.test(process.env.BOOKDROP_VERSION ?? '')
  ? process.env.BOOKDROP_VERSION!
  : 'dev';
export const SSE_MAX_DURATION_MS = envInt('SSE_MAX_DURATION_MS', 30 * 60_000);

export const KOBO_CONVERTER = envChoice(
  'KOBO_CONVERTER',
  ['calibre', 'kepubify'] as const,
  'kepubify'
);
export const KINDLE_CONVERTER = envChoice(
  'KINDLE_CONVERTER',
  ['calibre', 'kindlegen'] as const,
  'calibre'
);
export const KINDLE_OUTPUT_FORMAT = envChoice(
  'KINDLE_OUTPUT_FORMAT',
  ['azw3', 'mobi'] as const,
  'azw3'
);

export const MAX_CONCURRENT_CONVERSIONS = envCount(
  'MAX_CONCURRENT_CONVERSIONS',
  Math.min(envCount('CPUS', 1, 1), 4),
  1
);
export const MAX_QUEUED_CONVERSIONS = envCount(
  'MAX_QUEUED_CONVERSIONS',
  MAX_CONCURRENT_CONVERSIONS * 2,
  0
);
export const MAX_CONVERSION_WAIT_MS = envCount('MAX_CONVERSION_WAIT_MS', 20_000, 0);
export const CONVERSION_TIMEOUT_MS = envCount('CONVERSION_TIMEOUT_MS', 55_000, 1_000);
export const METADATA_TIMEOUT_MS = 15_000;
export const SSE_HEARTBEAT_MS = envInt('SSE_HEARTBEAT_MS', 25_000);
export const UPLOAD_CLEANUP_INTERVAL_MS = envInt('UPLOAD_CLEANUP_INTERVAL_MS', MAX_EXPIRE_MS);
