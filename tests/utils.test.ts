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
  clientNetwork,
  doTransliterate,
  deleteFile,
  extractSharedUrl,
  formatLimit,
  readEpubMetadata,
  writeEpubMetadata,
  fetchGoogleBooksMetadata,
  updateEpubMetadata,
  hasZipEndRecord,
  readZipEntries,
  MAX_ZIP_INDEX_BYTES,
} from '../src/utils.js';

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

describe('hasZipEndRecord', () => {
  async function check(buf: Buffer): Promise<boolean> {
    const tmpPath = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random()}.epub`);
    await fsp.writeFile(tmpPath, buf);
    try {
      return await hasZipEndRecord(tmpPath);
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  }

  it('accepts a zip whose comment ends with the end-record signature', async () => {
    const zip = new JSZip().file('mimetype', 'application/epub+zip');
    const buf = await zip.generateAsync({ type: 'nodebuffer', comment: 'PK\x05\x06' });
    assert.strictEqual(await check(buf), true);
  });

  it('rejects a file too short to hold an end record', async () => {
    assert.strictEqual(await check(Buffer.from('PK\x05\x06')), false);
  });
});

describe('readZipEntries', () => {
  async function read(buf: Buffer) {
    const tmpPath = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random()}.epub`);
    await fsp.writeFile(tmpPath, buf);
    try {
      return await readZipEntries(tmpPath);
    } finally {
      await fsp.unlink(tmpPath).catch(() => {});
    }
  }

  /** Offset of the end record, which JSZip writes last when there is no comment. */
  const endOffset = (buf: Buffer) => buf.length - 22;

  const twoEntries = () =>
    new JSZip()
      .file('mimetype', 'application/epub+zip', { compression: 'STORE' })
      .file('OEBPS/chapter.xhtml', 'a'.repeat(10_000), {
        compression: 'DEFLATE',
        createFolders: false,
      });

  it('lists every entry with its compressed and uncompressed size', async () => {
    const entries = await read(await twoEntries().generateAsync({ type: 'nodebuffer' }));
    assert.deepStrictEqual(
      entries.map((e) => e.name),
      ['mimetype', 'OEBPS/chapter.xhtml']
    );
    assert.strictEqual(entries[0].compressedSize, 20);
    assert.strictEqual(entries[0].uncompressedSize, 20);
    assert.strictEqual(entries[1].uncompressedSize, 10_000);
    assert.ok(entries[1].compressedSize < 1_000);
  });

  it('tolerates a comment, even one containing the end-record signature', async () => {
    const buf = await twoEntries().generateAsync({
      type: 'nodebuffer',
      comment: 'PK\x05\x06 not the end',
    });
    assert.strictEqual((await read(buf)).length, 2);
  });

  it('throws on a file cut off before its end record', async () => {
    const buf = await twoEntries().generateAsync({ type: 'nodebuffer' });
    await assert.rejects(read(buf.subarray(0, buf.length - 10)));
  });

  it('throws when the index claims to lie past the end of the file', async () => {
    const buf = await twoEntries().generateAsync({ type: 'nodebuffer' });
    buf.writeUInt32LE(buf.length, endOffset(buf) + 16);
    await assert.rejects(read(buf));
  });

  it('throws when the index holds fewer entries than the end record counts', async () => {
    const buf = await twoEntries().generateAsync({ type: 'nodebuffer' });
    buf.writeUInt16LE(3, endOffset(buf) + 10);
    await assert.rejects(read(buf));
  });

  it('throws, rather than searching forever, on a lone end record with a wrong comment length', async () => {
    const buf = Buffer.alloc(22);
    buf.writeUInt32LE(0x06054b50, 0);
    buf.writeUInt16LE(1, 20);
    await assert.rejects(read(buf));
  });

  it('throws when the end record counts fewer entries than the index holds', async () => {
    const buf = await twoEntries().generateAsync({ type: 'nodebuffer' });
    buf.writeUInt16LE(0, endOffset(buf) + 10);
    await assert.rejects(read(buf));
  });

  it('throws on an index larger than any convertible EPUB needs, before reading it', async () => {
    const dirSize = MAX_ZIP_INDEX_BYTES + 1;
    const buf = Buffer.alloc(dirSize + 22);
    const end = dirSize;
    buf.writeUInt32LE(0x06054b50, end);
    buf.writeUInt16LE(1, end + 10);
    buf.writeUInt32LE(dirSize, end + 12);
    buf.writeUInt32LE(0, end + 16);
    await assert.rejects(read(buf), /too large/);
  });

  it('throws on a ZIP64 archive', async () => {
    const buf = await twoEntries().generateAsync({ type: 'nodebuffer' });
    buf.writeUInt16LE(0xffff, endOffset(buf) + 10);
    await assert.rejects(read(buf), /ZIP64/);
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

describe('formatLimit', () => {
  it('shows whole megabytes without a decimal', () => {
    assert.strictEqual(formatLimit(100 * 1024 * 1024), '100 MB');
  });

  it('keeps one decimal place for fractional megabytes', () => {
    assert.strictEqual(formatLimit(2.5 * 1024 * 1024), '2.5 MB');
  });

  it('falls back to kilobytes below one megabyte', () => {
    assert.strictEqual(formatLimit(1024), '1 KB');
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

describe('clientNetwork', () => {
  const from = (ip: string) =>
    ({ headers: { 'cf-connecting-ip': ip }, ip: '10.0.0.1' }) as unknown as express.Request;

  it('gives two IPv6 addresses in the same /56 the same network', () => {
    assert.strictEqual(
      clientNetwork(from('2001:db8:1:ab00::1')),
      clientNetwork(from('2001:db8:1:abff:ffff::2'))
    );
  });

  it('tells IPv6 addresses in different /56 networks apart', () => {
    assert.notStrictEqual(
      clientNetwork(from('2001:db8:1:ab00::1')),
      clientNetwork(from('2001:db8:1:ac00::1'))
    );
  });

  it('leaves an IPv4 address as it is', () => {
    assert.strictEqual(clientNetwork(from('1.2.3.4')), '1.2.3.4');
  });

  it('reduces an IPv4-mapped IPv6 address to the IPv4 address', () => {
    assert.strictEqual(clientNetwork(from('::ffff:1.2.3.4')), '1.2.3.4');
  });

  it('falls back to req.ip when CF-Connecting-IP is absent', () => {
    const req = { headers: {}, ip: '10.0.0.1' } as unknown as express.Request;
    assert.strictEqual(clientNetwork(req), '10.0.0.1');
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

describe('extractSharedUrl', () => {
  it('returns a valid url from the dedicated url field', () => {
    assert.strictEqual(
      extractSharedUrl({ url: 'https://example.com/book.epub' }),
      'https://example.com/book.epub'
    );
  });

  it('trims surrounding whitespace on the url field', () => {
    assert.strictEqual(
      extractSharedUrl({ url: '  https://example.com/x  ' }),
      'https://example.com/x'
    );
  });

  it('falls back to the first http(s) URL embedded in text (Android puts links here)', () => {
    assert.strictEqual(
      extractSharedUrl({ text: 'Great read: https://example.com/article check it out' }),
      'https://example.com/article'
    );
  });

  it('prefers the url field over a url in text', () => {
    assert.strictEqual(
      extractSharedUrl({ url: 'https://a.example/one', text: 'https://b.example/two' }),
      'https://a.example/one'
    );
  });

  it('takes the first URL when text has several', () => {
    assert.strictEqual(
      extractSharedUrl({ text: 'https://first.example/a and https://second.example/b' }),
      'https://first.example/a'
    );
  });

  it('strips trailing punctuation from a URL in text', () => {
    assert.strictEqual(
      extractSharedUrl({ text: 'see (https://example.com/page).' }),
      'https://example.com/page'
    );
  });

  it('strips a run of mixed trailing punctuation', () => {
    assert.strictEqual(
      extractSharedUrl({ text: 'look: https://example.com/page!?!).' }),
      'https://example.com/page'
    );
  });

  it('handles a long run of punctuation inside a URL in linear time', () => {
    const text = `https://example.com/${'!'.repeat(100_000)}x`;
    const start = performance.now();
    assert.strictEqual(extractSharedUrl({ text }), null);
    const elapsedMs = performance.now() - start;
    assert.ok(elapsedMs < 500, `took ${Math.round(elapsedMs)} ms`);
  });

  it('rejects non-http(s) schemes in the url field and falls through to text', () => {
    assert.strictEqual(
      extractSharedUrl({ url: 'javascript:alert(1)', text: 'https://safe.example/ok' }),
      'https://safe.example/ok'
    );
  });

  it('rejects a javascript: url with no http fallback', () => {
    assert.strictEqual(extractSharedUrl({ url: 'javascript:alert(1)' }), null);
  });

  it('rejects a url longer than 2048 chars', () => {
    const huge = `https://example.com/${'a'.repeat(2100)}`;
    assert.strictEqual(extractSharedUrl({ url: huge }), null);
  });

  it('returns null when there is no url anywhere', () => {
    assert.strictEqual(extractSharedUrl({ text: 'just some plain text, no link' }), null);
    assert.strictEqual(extractSharedUrl({}), null);
  });

  it('tolerates non-string / missing fields', () => {
    assert.strictEqual(
      extractSharedUrl({ url: undefined as unknown as string, text: 42 as unknown as string }),
      null
    );
  });
});
