import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backendFor,
  convert,
  ConversionError,
  convertWithCalibre,
  convertWithKindlegen,
  convertWithKepubify,
  convertWithPdfCropMargins,
} from '../src/converter.js';

// These tests pass a non-existent file to each converter. If the tool is not installed,
// spawn immediately emits ENOENT; if it is installed, it exits quickly with a non-zero
// code (file not found). Either way the converter rejects and the test passes.

describe('convertWithKindlegen', () => {
  it('rejects with an error when kindlegen is not available or the file is invalid', async () => {
    await assert.rejects(
      () => convertWithKindlegen('/tmp/_book-drop_test.epub'),
      (err: Error) => {
        assert.ok(err instanceof Error);
        // Error message is sanitized: always contains the tool name
        assert.ok(
          err.message.toLowerCase().includes('kindlegen'),
          `Expected 'kindlegen' in error: ${err.message}`
        );
        return true;
      }
    );
  });

  it("gives KindleGen's reason for rejecting the book as the user message", async () => {
    const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-kindlegen-'));
    const script = path.join(fakeBinDir, 'kindlegen');
    await fs.writeFile(
      script,
      `#!/bin/sh
echo 'Info(prcgen):I1047: Added metadata dc:Title "Oliver Twist"'
echo 'Error(prcgen):E23006: Language not recognized in metadata. The dc:Language field is mandatory. Aborting.'
exit 2
`
    );
    await fs.chmod(script, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
    try {
      await assert.rejects(
        () => convertWithKindlegen(path.join(fakeBinDir, 'book.epub')),
        (err: ConversionError) => {
          assert.strictEqual(
            err.userMessage,
            "KindleGen couldn't convert this EPUB: Language not recognized in metadata. " +
              'Try adding it with an ebook editor tool.'
          );
          return true;
        }
      );
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});

describe('convertWithKepubify', () => {
  it('rejects with an error when kepubify is not available or the file is invalid', async () => {
    await assert.rejects(
      () => convertWithKepubify('/tmp/_book-drop_test.epub'),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes('kepubify'),
          `Expected 'kepubify' in error: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe('convertWithCalibre', () => {
  it('rejects with an error when ebook-convert is not available or the file is invalid', async () => {
    await assert.rejects(
      () => convertWithCalibre('/tmp/_book-drop_test.epub', 'azw3'),
      (err: Error) => {
        assert.ok(err instanceof ConversionError);
        assert.strictEqual((err as ConversionError).tool, 'calibre');
        assert.ok(
          err.message.toLowerCase().includes('ebook-convert'),
          `Expected 'ebook-convert' in error: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe('convertWithPdfCropMargins', () => {
  it('rejects with an error when pdfcropmargins is not available or the file is invalid', async () => {
    await assert.rejects(
      () => convertWithPdfCropMargins('/tmp/_book-drop_test.pdf'),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes('pdfcropmargins'),
          `Expected 'pdfcropmargins' in error: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe('backendFor', () => {
  it('defaults Kobo to kepubify, which is far faster, and Kindle to calibre', () => {
    assert.strictEqual(backendFor('kobo').tool, 'Kepubify');
    assert.strictEqual(backendFor('kindle').tool, 'calibre');
  });

  it('leaves PDF cropping on pdfCropMargins, which calibre cannot replace', () => {
    assert.strictEqual(backendFor('pdfcrop').tool, 'pdfCropMargins');
  });

  it('names Kobo output with the double extension Kobo devices require', () => {
    assert.strictEqual(backendFor('kobo').outputName('book.epub'), 'book.kepub.epub');
    assert.strictEqual(backendFor('kobo').outputName('book.kepub.epub'), 'book.kepub.epub');
  });

  it('names Kindle output with the configured format', () => {
    assert.strictEqual(backendFor('kindle').outputName('book.epub'), 'book.azw3');
    assert.strictEqual(backendFor('kindle').outputName('book.kepub.epub'), 'book.azw3');
  });

  it('leaves PDF filenames untouched', () => {
    assert.strictEqual(backendFor('pdfcrop').outputName('paper.pdf'), 'paper.pdf');
  });

  it('preserves dots in the book title when swapping the extension', () => {
    assert.strictEqual(
      backendFor('kindle').outputName('Vol. 2 - A.B.C..epub'),
      'Vol. 2 - A.B.C..azw3'
    );
  });
});

interface ResolvedBackend {
  tool: string;
  output: string;
}

/**
 * Resolves every intent's backend in a child process, because the environment is read once
 * when config is imported and cannot be changed afterwards from within this process.
 */
function backendsUnderEnv(env: Record<string, string>): Record<string, ResolvedBackend> {
  const script = `
    const { backendFor } = await import('./src/converter.js');
    const resolved = {};
    for (const intent of ['kobo', 'kindle', 'pdfcrop']) {
      const backend = backendFor(intent);
      resolved[intent] = { tool: backend.tool, output: backend.outputName('book.epub') };
    }
    console.log(JSON.stringify(resolved));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { env: { ...process.env, ...env, LOG_LEVEL: 'silent' }, encoding: 'utf8' }
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) as string);
}

describe('backend selection', () => {
  it('switches each e-reader format to its other tool when configured to', () => {
    const resolved = backendsUnderEnv({
      KOBO_CONVERTER: 'calibre',
      KINDLE_CONVERTER: 'kindlegen',
    });
    assert.strictEqual(resolved.kobo.tool, 'calibre');
    assert.strictEqual(resolved.kobo.output, 'book.kepub.epub');
    assert.strictEqual(resolved.kindle.tool, 'KindleGen');
    assert.strictEqual(resolved.kindle.output, 'book.mobi');
  });

  it('lets calibre write MOBI for pre-2011 Kindles', () => {
    const resolved = backendsUnderEnv({ KINDLE_OUTPUT_FORMAT: 'mobi' });
    assert.strictEqual(resolved.kindle.tool, 'calibre');
    assert.strictEqual(resolved.kindle.output, 'book.mobi');
  });

  it('ignores an unrecognised converter rather than starting with no backend', () => {
    const resolved = backendsUnderEnv({ KOBO_CONVERTER: 'calibree' });
    assert.strictEqual(resolved.kobo.tool, 'Kepubify');
  });
});

describe('convert', () => {
  it('tags failures with the intent so the route can explain which option to turn off', async () => {
    await assert.rejects(
      () => convert('kobo', '/tmp/_book-drop_test.epub'),
      (err: Error) => {
        assert.ok(err instanceof ConversionError);
        assert.strictEqual((err as ConversionError).intent, 'kobo');
        return true;
      }
    );
  });
});
