import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const { convertWithKindling } = await import('../../dist/converter.js');

const installed = !spawnSync('kindling-cli', ['--version'], { stdio: 'ignore' }).error;

/**
 * A small, valid EPUB with neither a cover nor a language: KindleGen refused books without
 * a language (#47), and kindling's own publishing checks refuse books without a cover.
 */
async function bookWithoutCoverOrLanguage() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Integration Test Book</dc:title>
    <dc:creator>BookDrop</dc:creator>
    <dc:identifier id="bookid">urn:uuid:5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f"/></head>
  <docTitle><text>Integration Test Book</text></docTitle>
  <navMap><navPoint id="n1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="ch1.xhtml"/></navPoint></navMap>
</ncx>`
  );
  zip.file(
    'OEBPS/ch1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>
<body><h1>Chapter 1</h1><p>${'The quick brown fox jumps over the lazy dog. '.repeat(200)}</p></body></html>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Reads the EXTH metadata records from a MOBI's first record, keyed by record type. */
function exthRecords(book) {
  const record0 = book.readUInt32BE(78);
  const mobiHeader = record0 + 16;
  const exth = mobiHeader + book.readUInt32BE(mobiHeader + 4);
  assert.strictEqual(book.subarray(exth, exth + 4).toString('latin1'), 'EXTH');
  const records = new Map();
  let offset = exth + 12;
  for (let i = book.readUInt32BE(exth + 8); i > 0; i--) {
    const type = book.readUInt32BE(offset);
    const length = book.readUInt32BE(offset + 4);
    records.set(type, book.subarray(offset + 8, offset + length));
    offset += length;
  }
  return records;
}

describe('kindling conversions', { skip: installed ? false : 'kindling is not installed' }, () => {
  let uploadDir;

  before(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'book-drop-kindling-'));
  });

  after(async () => {
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('turns a book with no cover or language into a MOBI every Kindle can open', async () => {
    const input = path.join(uploadDir, 'file-1700000000000-abc.epub');
    await fs.writeFile(input, await bookWithoutCoverOrLanguage());

    const output = await convertWithKindling(input);

    assert.strictEqual(output, path.join(uploadDir, 'file-1700000000000-abc.mobi'));
    assert.deepStrictEqual(await fs.readdir(uploadDir), ['file-1700000000000-abc.mobi']);
    const book = await fs.readFile(output);
    assert.strictEqual(book.subarray(60, 68).toString('latin1'), 'BOOKMOBI');
    // The record that separates the MOBI6 half from the KF8 one in a joint file.
    assert.ok(book.includes('BOUNDARY', 0, 'latin1'), 'MOBI has no KF8 half');
    const exth = exthRecords(book);
    assert.strictEqual(exth.get(501)?.toString('latin1'), 'EBOK');
    assert.ok(exth.has(113), 'no ASIN, so the Kindle library cannot show a cover');
  });

  it('rejects a file that is not an EPUB and leaves nothing of it behind', async () => {
    const input = path.join(uploadDir, 'file-1700000000001-def.epub');
    await fs.writeFile(input, 'this is not a zip archive');
    const existing = (await fs.readdir(uploadDir)).filter((name) => name !== path.basename(input));

    await assert.rejects(() => convertWithKindling(input), /Not a zip archive/);
    assert.deepStrictEqual(await fs.readdir(uploadDir), existing);
  });

  it(
    'stops kindling at its memory cap on a book within the size limit',
    {
      skip: process.platform === 'linux' ? false : 'the memory cap is Linux-only',
    },
    async () => {
      const input = path.join(uploadDir, 'file-1700000000002-ghi.epub');
      const zip = await JSZip.loadAsync(await bookWithoutCoverOrLanguage());
      const chapter = Buffer.alloc(250_000_000, 'a');
      zip.file('OEBPS/ch1.xhtml', chapter, { compression: 'STORE' });
      await fs.writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
      const existing = (await fs.readdir(uploadDir)).filter(
        (name) => name !== path.basename(input)
      );

      await assert.rejects(() => convertWithKindling(input), /killed by SIGABRT/);
      assert.deepStrictEqual(await fs.readdir(uploadDir), existing);
    }
  );
});
