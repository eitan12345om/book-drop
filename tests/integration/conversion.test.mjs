import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { brokenTocEpub, bigBookEpub, notAnEpub } from '../fixtures/epub.mjs';

const { convertWithCalibre, convertWithKepubify, backendFor, convert, ConversionError } =
  await import('../../dist/converter.js');

/** True when the executable can be started at all; conversions are skipped otherwise. */
function isInstalled(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !(result.error && result.error.code === 'ENOENT');
}

const hasCalibre = isInstalled('ebook-convert');
const hasKepubify = isInstalled('kepubify');

let workDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'book-drop-conversion-'));
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/** Writes bytes to a file named the way the upload route names them. */
async function stage(name, bytes) {
  const filePath = path.join(workDir, `file-${name}.epub`);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

/**
 * True when any document carries Kobo spans, which is what makes a kepub a kepub.
 * Every document is checked because the converters add filler pages of their own that
 * legitimately have no spans in them.
 */
async function hasKoboSpans(epubPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(epubPath));
  const documents = Object.keys(zip.files).filter((name) => /\.x?html$/i.test(name));
  assert.ok(documents.length > 0, 'converted book has no documents');
  for (const name of documents) {
    if ((await zip.file(name).async('string')).includes('koboSpan')) {
      return true;
    }
  }
  return false;
}

describe('calibre conversions', { skip: hasCalibre ? false : 'calibre is not installed' }, () => {
  it('writes a kepub Kobo devices will recognise, with Kobo markup inside', async () => {
    const input = await stage('kobo', await brokenTocEpub());
    const output = await convertWithCalibre(input, 'kepub');

    assert.ok(output.endsWith('.kepub.epub'), `expected .kepub.epub, got ${output}`);
    assert.ok(await hasKoboSpans(output), 'kepub is missing the Kobo spans that make it a kepub');
  });

  it('writes a Kindle file with the right container signature', async () => {
    const input = await stage('kindle', await brokenTocEpub());
    const output = await convertWithCalibre(input, 'azw3');

    assert.ok(output.endsWith('.azw3'), `expected .azw3, got ${output}`);
    const header = await fs.readFile(output);
    assert.strictEqual(header.subarray(60, 68).toString('latin1'), 'BOOKMOBI');
  });

  it('writes MOBI with a KF8 half for newer Kindles, as KindleGen did', async () => {
    const input = await stage('mobi', await brokenTocEpub());
    const output = await convertWithCalibre(input, 'mobi');

    assert.ok(output.endsWith('.mobi'), `expected .mobi, got ${output}`);
    const book = await fs.readFile(output);
    assert.strictEqual(book.subarray(60, 68).toString('latin1'), 'BOOKMOBI');
    // The record that separates the MOBI6 half from the KF8 one in a joint file.
    assert.ok(book.includes('BOUNDARY', 0, 'latin1'), 'MOBI has no KF8 half');
  });

  it('reports a rejected book as a conversion failure, not a missing tool', async () => {
    const input = await stage('garbage', notAnEpub());
    await assert.rejects(
      () => convert('kindle', input),
      (err) => {
        assert.ok(err instanceof ConversionError);
        assert.strictEqual(err.intent, 'kindle');
        assert.strictEqual(err.toolMissing, false, 'the tool ran; the book was the problem');
        assert.strictEqual(err.timedOut, false);
        return true;
      }
    );
  });

  it('produces the filename the upload route predicted before converting', async () => {
    const input = await stage('predicted', await brokenTocEpub());
    const predicted = backendFor('kindle').outputName(path.basename(input));
    const output = await convert('kindle', input);
    assert.strictEqual(path.basename(output), predicted);
  });

  it('converts a full-length book well inside the timeout', async () => {
    const input = await stage('big', await bigBookEpub(400));
    const startedAt = Date.now();
    const output = await convert('kindle', input);
    const elapsed = Date.now() - startedAt;

    const { size } = await fs.stat(output);
    assert.ok(size > 0);
    assert.ok(elapsed < 40_000, `400-chapter book took ${elapsed}ms`);
  });
});

describe(
  'kepubify conversions',
  { skip: hasKepubify ? false : 'kepubify is not installed' },
  () => {
    it('writes a kepub with Kobo markup', async () => {
      const input = await stage('kepubify', await brokenTocEpub());
      const output = await convertWithKepubify(input);

      assert.ok(output.endsWith('.kepub.epub'), `expected .kepub.epub, got ${output}`);
      assert.ok(await hasKoboSpans(output), 'kepub is missing the Kobo spans that make it a kepub');
    });
  }
);
