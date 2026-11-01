import crypto from 'node:crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import type express from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import JSZip from 'jszip';
import { transliterate } from 'transliteration';
import { logger } from './logger.js';
import type { MetadataDiff } from './types.js';
import { GOOGLE_BOOKS_API_KEY } from './config.js';

export const KEY_REGEX = /^[23456789ACDEFGHJKLMNPRSTUVWXYZ]{4}$/;

/** Returns true if k is a valid 4-character session key. */
export function isValidKey(k: string): boolean {
  return KEY_REGEX.test(k);
}

export const TYPE_EPUB = 'application/epub+zip';
export const TYPE_MOBI = 'application/x-mobipocket-ebook';
export const TYPE_AZW3 = 'application/vnd.amazon.mobi8-ebook';

export const ALLOWED_TYPES = new Set([
  TYPE_EPUB,
  TYPE_MOBI,
  TYPE_AZW3,
  'application/pdf',
  'application/vnd.comicbook+zip',
  'application/vnd.comicbook-rar',
  'text/html',
  'text/plain',
  'application/zip',
  'application/x-rar-compressed',
  'image/png',
  'image/jpeg',
]);

export const ALLOWED_EXTENSIONS = new Set([
  'epub',
  'mobi',
  'azw3',
  'pdf',
  'cbz',
  'cbr',
  'html',
  'txt',
  'png',
  'jpg',
  'jpeg',
]);

const ZIP_END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_END_RECORD_SIZE = 22;
// The end record is followed by a comment of at most 65,535 bytes.
const ZIP_END_SEARCH_BYTES = ZIP_END_RECORD_SIZE + 0xffff;

/** Returns true if the file ends with a zip end-of-central-directory record, as every complete EPUB does. */
export async function hasZipEndRecord(filePath: string): Promise<boolean> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ZIP_END_SEARCH_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    if (length < ZIP_END_RECORD_SIZE) {
      return false;
    }
    return buf.lastIndexOf(ZIP_END_SIGNATURE, length - ZIP_END_RECORD_SIZE) !== -1;
  } finally {
    await handle.close();
  }
}

/** Returns the user-facing error for a file that claims to be an EPUB but isn't a complete zip. */
export function invalidEpubMessage(filename: string): string {
  return `\u201c${filename}\u201d isn\u2019t a valid EPUB file. It may be damaged or not fully downloaded. Try downloading it again.`;
}

export type Ereader = 'Kobo' | 'Kindle' | 'Tolino';

// Match only tokens no phone or desktop browser sends: a false positive serves a phone
// the receive page, where it can't upload.
const EREADER_PATTERNS: ReadonlyArray<[Ereader, RegExp]> = [
  ['Kobo', /kobo/i],
  ['Kindle', /kindle/i],
  ['Tolino', /tolino/i],
];

/** Returns the e-reader family a user-agent belongs to, or null if it isn't a recognised e-reader. */
export function detectEreader(agent: string): Ereader | null {
  for (const [name, pattern] of EREADER_PATTERNS) {
    if (pattern.test(agent)) {
      return name;
    }
  }
  return null;
}

/** Returns true if the user-agent string looks like an e-reader browser. */
export function isEreaderAgent(agent: string): boolean {
  return detectEreader(agent) !== null || agent.includes('eReader');
}

/** Returns a size limit as a round figure for display, e.g. "100 MB". */
export function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${+(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
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

export const MAX_SHARED_URL_LENGTH = 2048;

const TRAILING_PUNCTUATION = new Set('.,;:!?)]}>"\'');

// A loop rather than a `[...]+$` regex: that regex backtracks quadratically on long
// punctuation runs that don't reach the end of the string.
function trimTrailingPunctuation(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(s[end - 1])) {
    end--;
  }
  return s.slice(0, end);
}

/**
 * Extracts a shareable http(s) URL from Web Share Target fields.
 * Prefers the dedicated `url` field; falls back to the first http(s) URL found in
 * `text` (many Android apps, including Chrome, put a shared link in `text`, not `url`).
 * Trailing punctuation is trimmed. Returns null when no valid, in-bounds URL is present.
 *
 * NOTE: A minimal copy of this logic lives in client/public/sw.js (a service worker
 * can't import from src/). Keep the two in sync — this is the canonical, tested one.
 */
export function extractSharedUrl(fields: { url?: unknown; text?: unknown }): string | null {
  const url = typeof fields.url === 'string' ? fields.url.trim() : '';
  if (url && url.length <= MAX_SHARED_URL_LENGTH && isValidUrl(url)) {
    return url;
  }
  const text = typeof fields.text === 'string' ? fields.text : '';
  const match = text.match(/https?:\/\/[^\s]+/i);
  if (match) {
    const candidate = trimTrailingPunctuation(match[0]);
    if (candidate.length <= MAX_SHARED_URL_LENGTH && isValidUrl(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Returns the real client IP, preferring Cloudflare's CF-Connecting-IP header over req.ip. */
export function clientIp(req: express.Request): string {
  return (req.headers['cf-connecting-ip'] as string) ?? req.ip ?? 'unknown';
}

/**
 * Returns the client's network for counting requests and sessions: its IPv4 address, or the
 * /56 an IPv6 address belongs to, since one household is usually handed a whole /56.
 */
export function clientNetwork(req: express.Request): string {
  return ipKeyGenerator(clientIp(req));
}

/** Returns a short ID that ties an error shown to a user to its log entry. */
export function newErrorRef(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** Schedules an async unlink of filePath, logging non-ENOENT errors. */
export function deleteFile(filePath: string): void {
  fs.unlink(filePath, (err) => {
    if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error({ err, filePath }, 'Failed to delete file');
    }
  });
}

const DC_FIELDS = ['title', 'creator', 'publisher', 'date', 'description', 'subject'] as const;

/** Extracts the text content of a single Dublin Core element from an OPF string. */
function extractDcField(opf: string, field: string): string {
  const m = opf.match(new RegExp(`<dc:${field}[^>]*>([^<]*)<\\/dc:${field}>`, 'i'));
  return m ? m[1].trim() : '';
}

/** Replaces or inserts a Dublin Core element value in an OPF string. */
function setDcField(opf: string, field: string, value: string): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pattern = new RegExp(`(<dc:${field}[^>]*>)[^<]*(<\\/dc:${field}>)`, 'i');
  if (pattern.test(opf)) {
    return opf.replace(pattern, `$1${escaped}$2`);
  }
  return opf.replace(/(<\/metadata>)/i, `    <dc:${field}>${escaped}</dc:${field}>\n    $1`);
}

/** Reads the OPF path from META-INF/container.xml in a loaded JSZip. */
async function getOpfPath(zip: JSZip): Promise<string> {
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) {
    throw new Error('EPUB missing META-INF/container.xml');
  }
  const m = container.match(/full-path="([^"]+\.opf)"/i);
  if (!m) {
    throw new Error('Could not find OPF path in container.xml');
  }
  return m[1];
}

/** Reads Dublin Core metadata fields from an EPUB file. */
export async function readEpubMetadata(filePath: string): Promise<Record<string, string>> {
  const buf = await fsp.readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const opfPath = await getOpfPath(zip);
  const opf = await zip.file(opfPath)?.async('string');
  if (!opf) {
    throw new Error(`OPF file not found: ${opfPath}`);
  }
  return Object.fromEntries(DC_FIELDS.map((f) => [f, extractDcField(opf, f)]));
}

/** Patches Dublin Core metadata fields in an EPUB file in-place. */
export async function writeEpubMetadata(
  filePath: string,
  metadata: Record<string, string>
): Promise<void> {
  const buf = await fsp.readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const opfPath = await getOpfPath(zip);
  let opf = await zip.file(opfPath)?.async('string');
  if (!opf) {
    throw new Error(`OPF file not found: ${opfPath}`);
  }
  for (const [field, value] of Object.entries(metadata)) {
    opf = setDcField(opf, field, value);
  }
  zip.file(opfPath, opf);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fsp.writeFile(filePath, out);
}

/** Fetches book metadata from the Google Books API by title and/or author. Throws if no match. */
export async function fetchGoogleBooksMetadata(
  title: string,
  author: string
): Promise<Record<string, string>> {
  if (!title && !author) {
    throw new Error('No title or author to search');
  }
  const parts = [title && `intitle:${title}`, author && `inauthor:${author}`].filter(Boolean);
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.searchParams.set('q', parts.join('+'));
  url.searchParams.set('maxResults', '1');
  if (GOOGLE_BOOKS_API_KEY) {
    url.searchParams.set('key', GOOGLE_BOOKS_API_KEY);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Google Books API error: ${res.status}`);
  }
  const data = (await res.json()) as {
    totalItems?: number;
    items?: Array<{ volumeInfo: Record<string, unknown> }>;
  };
  if (!data.items?.length) {
    throw new Error('No results from Google Books');
  }
  const v = data.items[0].volumeInfo;
  const result: Record<string, string> = {};
  if (typeof v.title === 'string' && v.title) {
    result.title = v.title;
  }
  if (Array.isArray(v.authors) && v.authors.length > 0) {
    result.creator = String(v.authors[0]);
  }
  if (typeof v.publisher === 'string' && v.publisher) {
    result.publisher = v.publisher;
  }
  if (typeof v.publishedDate === 'string' && v.publishedDate) {
    result.date = v.publishedDate;
  }
  if (typeof v.description === 'string' && v.description) {
    const d = v.description;
    result.description = d.length > 300 ? `${d.slice(0, 297)}…` : d;
  }
  if (Array.isArray(v.categories) && v.categories.length > 0) {
    result.subject = String(v.categories[0]);
  }
  if (Object.keys(result).length === 0) {
    throw new Error('No usable metadata in response');
  }
  return result;
}

/** Fetches metadata from Google Books and applies it to an EPUB, returning a diff of changes. */
export async function updateEpubMetadata(filePath: string): Promise<MetadataDiff> {
  const before = await readEpubMetadata(filePath);
  const fetched = await fetchGoogleBooksMetadata(before.title ?? '', before.creator ?? '');
  await writeEpubMetadata(filePath, fetched);
  const after = await readEpubMetadata(filePath);
  const diff: MetadataDiff = {};
  for (const key of Object.keys(fetched)) {
    if ((before[key] ?? '') !== (after[key] ?? '')) {
      diff[key] = { before: before[key] ?? '', after: after[key] ?? '' };
    }
  }
  return diff;
}

/** Transliterates non-ASCII characters in the filename stem while preserving the extension. */
export function doTransliterate(filename: string): string {
  const parts = filename.split('.');
  const ext = `.${parts.splice(-1).join('.')}`;
  return transliterate(parts.join('.')) + ext;
}
