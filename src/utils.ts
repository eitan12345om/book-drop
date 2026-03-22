import fs from 'fs';
import { transliterate } from 'transliteration';
import { logger } from './logger.js';

export const KEY_REGEX = /^[23456789ACDEFGHJKLMNPRSTUVWXYZ]{4}$/;

/** Returns true if k is a valid 4-character session key. */
export function isValidKey(k: string): boolean {
  return KEY_REGEX.test(k);
}

export const TYPE_EPUB = 'application/epub+zip';
export const TYPE_MOBI = 'application/x-mobipocket-ebook';

export const ALLOWED_TYPES = new Set([
  TYPE_EPUB,
  TYPE_MOBI,
  'application/pdf',
  'application/vnd.comicbook+zip',
  'application/vnd.comicbook-rar',
  'text/html',
  'text/plain',
  'application/zip',
  'application/x-rar-compressed',
]);

export const ALLOWED_EXTENSIONS = new Set(['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'html', 'txt']);

/** Returns true if the user-agent string looks like an e-reader browser. */
export function isEreaderAgent(agent: string): boolean {
  const lower = agent.toLowerCase();
  return (
    lower.includes('kobo') ||
    lower.includes('kindle') ||
    lower.includes('tolino') ||
    agent.includes('eReader')
  );
}

/** Returns true if raw is a valid http or https URL. */
export function isValidUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Schedules an async unlink of filePath, logging non-ENOENT errors. */
export function deleteFile(filePath: string): void {
  fs.unlink(filePath, (err) => {
    if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error({ err, filePath }, 'Failed to delete file');
    }
  });
}

/** Transliterates non-ASCII characters in the filename stem while preserving the extension. */
export function doTransliterate(filename: string): string {
  const parts = filename.split('.');
  const ext = `.${parts.splice(-1).join('.')}`;
  return transliterate(parts.join('.')) + ext;
}
