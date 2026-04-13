import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import type express from 'express';
import {
  isValidKey,
  isValidUrl,
  isEreaderAgent,
  clientIp,
  doTransliterate,
  deleteFile,
  readEpubMetadata,
  writeEpubMetadata,
  fetchGoogleBooksMetadata,
  updateEpubMetadata,
} from '../src/utils.js';

// ── EPUB metadata helpers ────────────────────────────────────────────────────

/** Builds a minimal valid EPUB ZIP at a temp path with the given DC metadata fields. */
async function makeTempEpub(metadata: Record<string, string>): Promise<string> {
  const dcElements = Object.entries(metadata)
    .map(([k, v]) => `    <dc:${k}>${v}</dc:${k}>`)
    .join('\n');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${dcElements}
  </metadata>
</package>`;
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  const zip = new JSZip();
  zip.file('META-INF/container.xml', container);
  zip.file('OEBPS/content.opf', opf);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const tmpPath = path.join(
    os.tmpdir(),
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}.epub`
  );
  await fsp.writeFile(tmpPath, buf);
  return tmpPath;
}

describe('readEpubMetadata', () => {
  it('extracts title, creator, publisher from OPF', async () => {
    const tmpPath = await makeTempEpub({
      title: 'Pride and Prejudice',
      creator: 'Jane Austen',
      publisher: 'T. Egerton',
    });
    try {
      const meta = await readEpubMetadata(tmpPath);
      assert.strictEqual(meta.title, 'Pride and Prejudice');
      assert.strictEqual(meta.creator, 'Jane Austen');
      assert.strictEqual(meta.publisher, 'T. Egerton');
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  });

  it('returns empty string for missing fields', async () => {
    const tmpPath = await makeTempEpub({ title: 'Only Title' });
    try {
      const meta = await readEpubMetadata(tmpPath);
      assert.strictEqual(meta.title, 'Only Title');
      assert.strictEqual(meta.creator, '');
      assert.strictEqual(meta.publisher, '');
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  });
});

describe('writeEpubMetadata', () => {
  it('patches existing fields and round-trips correctly', async () => {
    const tmpPath = await makeTempEpub({ title: 'Old Title', creator: 'Old Author' });
    try {
      await writeEpubMetadata(tmpPath, { title: 'New Title', creator: 'New Author' });
      const meta = await readEpubMetadata(tmpPath);
      assert.strictEqual(meta.title, 'New Title');
      assert.strictEqual(meta.creator, 'New Author');
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  });

  it('inserts fields that were not present before', async () => {
    const tmpPath = await makeTempEpub({ title: 'A Book' });
    try {
      await writeEpubMetadata(tmpPath, { publisher: 'New Publisher' });
      const meta = await readEpubMetadata(tmpPath);
      assert.strictEqual(meta.title, 'A Book');
      assert.strictEqual(meta.publisher, 'New Publisher');
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  });
});

describe('fetchGoogleBooksMetadata', () => {
  let originalFetch: typeof global.fetch;

  before(() => {
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('returns mapped fields from a Google Books response', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        totalItems: 1,
        items: [
          {
            volumeInfo: {
              title: 'Pride and Prejudice',
              authors: ['Jane Austen'],
              publisher: 'Penguin',
              publishedDate: '2002',
              description: 'A classic novel.',
              categories: ['Fiction'],
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const meta = await fetchGoogleBooksMetadata('Pride and Prejudice', 'Jane Austen');
    assert.strictEqual(meta.title, 'Pride and Prejudice');
    assert.strictEqual(meta.creator, 'Jane Austen');
    assert.strictEqual(meta.publisher, 'Penguin');
    assert.strictEqual(meta.date, '2002');
    assert.strictEqual(meta.subject, 'Fiction');
  });

  it('throws when no results are returned', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ totalItems: 0, items: [] }),
    })) as unknown as typeof fetch;

    await assert.rejects(() => fetchGoogleBooksMetadata('Unknown Book XYZ', ''), /No results/);
  });

  it('throws when the API returns a non-ok status', async () => {
    global.fetch = mock.fn(async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchGoogleBooksMetadata('A Book', 'An Author'),
      /Google Books API error/
    );
  });
});

describe('updateEpubMetadata', () => {
  let originalFetch: typeof global.fetch;

  before(() => {
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('returns a diff of changed fields', async () => {
    const tmpPath = await makeTempEpub({ title: 'Old Title', creator: 'Old Author' });
    try {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          totalItems: 1,
          items: [
            {
              volumeInfo: {
                title: 'New Title',
                authors: ['New Author'],
                publisher: 'Some Publisher',
              },
            },
          ],
        }),
      })) as unknown as typeof fetch;

      const diff = await updateEpubMetadata(tmpPath);
      assert.strictEqual(diff.title?.before, 'Old Title');
      assert.strictEqual(diff.title?.after, 'New Title');
      assert.strictEqual(diff.creator?.before, 'Old Author');
      assert.strictEqual(diff.creator?.after, 'New Author');
      assert.ok('publisher' in diff);
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  });

  it('returns empty diff when fetched metadata matches existing', async () => {
    const tmpPath = await makeTempEpub({ title: 'Same Title', creator: 'Same Author' });
    try {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          totalItems: 1,
          items: [{ volumeInfo: { title: 'Same Title', authors: ['Same Author'] } }],
        }),
      })) as unknown as typeof fetch;

      const diff = await updateEpubMetadata(tmpPath);
      assert.strictEqual(Object.keys(diff).length, 0);
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  });

  it('propagates fetch errors to the caller', async () => {
    const tmpPath = await makeTempEpub({ title: 'A Book', creator: 'An Author' });
    try {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ totalItems: 0, items: [] }),
      })) as unknown as typeof fetch;

      await assert.rejects(() => updateEpubMetadata(tmpPath), /No results/);
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  });
});

describe('isValidKey', () => {
  it('accepts a valid 4-char key', () => {
    assert.strictEqual(isValidKey('ACDF'), true);
  });

  it('rejects keys that are too short', () => {
    assert.strictEqual(isValidKey('ACD'), false);
  });

  it('rejects keys that are too long', () => {
    assert.strictEqual(isValidKey('ACDFG'), false);
  });

  it('rejects keys with disallowed characters (0, 1, O, I, B)', () => {
    assert.strictEqual(isValidKey('0000'), false);
    assert.strictEqual(isValidKey('OOOO'), false);
    assert.strictEqual(isValidKey('IIII'), false);
    assert.strictEqual(isValidKey('BBBB'), false);
  });

  it('rejects lowercase', () => {
    assert.strictEqual(isValidKey('acdf'), false);
  });
});

describe('isValidUrl', () => {
  it('accepts http URLs', () => {
    assert.strictEqual(isValidUrl('http://example.com'), true);
  });

  it('accepts https URLs', () => {
    assert.strictEqual(isValidUrl('https://example.com/path?q=1'), true);
  });

  it('rejects javascript: URLs', () => {
    assert.strictEqual(isValidUrl('javascript:alert(1)'), false);
  });

  it('rejects ftp: URLs', () => {
    assert.strictEqual(isValidUrl('ftp://example.com'), false);
  });

  it('rejects data: URLs', () => {
    assert.strictEqual(isValidUrl('data:text/html,<h1>hi</h1>'), false);
  });

  it('rejects malformed strings', () => {
    assert.strictEqual(isValidUrl('not a url'), false);
    assert.strictEqual(isValidUrl(''), false);
  });
});

describe('isEreaderAgent', () => {
  it('recognises Kobo', () => {
    assert.strictEqual(isEreaderAgent('Mozilla/5.0 (Linux; Kobo Touch 4.39)'), true);
  });

  it('recognises Kindle', () => {
    assert.strictEqual(isEreaderAgent('Mozilla/5.0 Kindle/3.0'), true);
  });

  it('recognises Tolino', () => {
    assert.strictEqual(isEreaderAgent('Mozilla/5.0 Tolino/1.0'), true);
  });

  it('recognises eReader user-agent string', () => {
    assert.strictEqual(isEreaderAgent('eReader/1.0 (Model X)'), true);
  });

  it('is case-insensitive for known brands', () => {
    assert.strictEqual(isEreaderAgent('KOBO/2.0'), true);
    assert.strictEqual(isEreaderAgent('kindle browser'), true);
  });

  it('rejects a regular browser', () => {
    assert.strictEqual(isEreaderAgent('Mozilla/5.0 Chrome/120 Safari/537.36'), false);
  });
});

describe('doTransliterate', () => {
  it('replaces non-ASCII characters in the stem while preserving the extension', () => {
    const result = doTransliterate('Ünïcödé-title.epub');
    assert.ok(result.endsWith('.epub'), `Expected .epub extension, got: ${result}`);
    // Only ASCII characters should remain after transliteration
    assert.strictEqual(/[^\u0021-\u007E\s.]/u.test(result), false);
  });

  it('leaves ASCII filenames unchanged', () => {
    assert.strictEqual(doTransliterate('my-book.epub'), 'my-book.epub');
  });

  it('handles filenames with multiple dots (preserves only the last extension)', () => {
    const result = doTransliterate('my.book.name.epub');
    assert.ok(result.endsWith('.epub'));
  });
});

describe('clientIp', () => {
  it('returns CF-Connecting-IP when present', () => {
    const req = {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
      ip: '10.0.0.1',
    } as unknown as express.Request;
    assert.strictEqual(clientIp(req), '1.2.3.4');
  });

  it('falls back to req.ip when CF-Connecting-IP is absent', () => {
    const req = { headers: {}, ip: '10.0.0.1' } as unknown as express.Request;
    assert.strictEqual(clientIp(req), '10.0.0.1');
  });

  it('returns unknown when both are absent', () => {
    const req = { headers: {}, ip: undefined } as unknown as express.Request;
    assert.strictEqual(clientIp(req), 'unknown');
  });
});

describe('deleteFile', () => {
  it('calls fs.unlink on the given path', () => {
    const unlinkMock = mock.method(fs, 'unlink', (_path: string, cb: Function) => cb(null));
    deleteFile('/tmp/test-delete.epub');
    assert.strictEqual(unlinkMock.mock.calls.length, 1);
    assert.strictEqual(unlinkMock.mock.calls[0].arguments[0], '/tmp/test-delete.epub');
    unlinkMock.mock.restore();
  });

  it('silently ignores ENOENT errors', () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const unlinkMock = mock.method(fs, 'unlink', (_path: string, cb: Function) => cb(enoent));
    assert.doesNotThrow(() => deleteFile('/tmp/nonexistent.epub'));
    unlinkMock.mock.restore();
  });
});
