import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ConversionError,
  convertWithKindlegen,
  convertWithKindling,
  convertWithKepubify,
  convertWithPdfCropMargins,
} from '../src/converter.js';

// These tests pass a non-existent file to each converter. If the tool is not installed,
// spawn immediately emits ENOENT; if it is installed, it exits quickly with a non-zero
// code (file not found). Either way the converter rejects and the test passes.

/** Runs fn with an executable called name, made from script, first on PATH. */
async function withFakeTool(name: string, script: string, fn: () => Promise<void>): Promise<void> {
  const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), `fake-${name}-`));
  await fs.writeFile(path.join(fakeBinDir, name), script, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(fakeBinDir, { recursive: true, force: true });
  }
}

/** Stages an upload the way the upload route names them, in a fresh directory. */
async function stageUpload(): Promise<{ uploadDir: string; input: string }> {
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uploads-'));
  const input = path.join(uploadDir, 'file-1700000000000-abc.epub');
  await fs.writeFile(input, 'not really an epub');
  return { uploadDir, input };
}

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
    const script = `#!/bin/sh
echo 'Info(prcgen):I1047: Added metadata dc:Title "Oliver Twist"'
echo 'Error(prcgen):E23006: Language not recognized in metadata. The dc:Language field is mandatory. Aborting.'
exit 2
`;
    await withFakeTool('kindlegen', script, async () => {
      const { uploadDir, input } = await stageUpload();
      await assert.rejects(
        () => convertWithKindlegen(input),
        (err: ConversionError) => {
          assert.ok(err instanceof ConversionError);
          assert.strictEqual(
            err.userMessage,
            "KindleGen couldn't convert this EPUB: Language not recognized in metadata. " +
              'Try adding it with an ebook editor tool.'
          );
          return true;
        }
      );
      await fs.rm(uploadDir, { recursive: true, force: true });
    });
  });
});

describe('convertWithKindling', () => {
  it('rejects with an error when kindling is not available or the file is invalid', async () => {
    await assert.rejects(
      () => convertWithKindling('/tmp/_book-drop_test.epub'),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes('kindling'),
          `Expected 'kindling' in error: ${err.message}`
        );
        return true;
      }
    );
  });

  it('writes a MOBI beside the upload, built with the options BookDrop relies on', async () => {
    const { uploadDir, input } = await stageUpload();
    const argsFile = path.join(uploadDir, '..', `${path.basename(uploadDir)}-args`);
    // build <input> -o <output> ...: records its arguments and writes the output.
    const script = `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
echo mobi > "$4"
`;
    await withFakeTool('kindling-cli', script, async () => {
      const output = await convertWithKindling(input);

      assert.strictEqual(output, path.join(uploadDir, 'file-1700000000000-abc.mobi'));
      assert.strictEqual(await fs.readFile(output, 'utf8'), 'mobi\n');
      assert.deepStrictEqual(await fs.readdir(uploadDir), ['file-1700000000000-abc.mobi']);
      assert.deepStrictEqual((await fs.readFile(argsFile, 'utf8')).trim().split('\n'), [
        'build',
        'file-1700000000000-abc.epub',
        '-o',
        'file-1700000000000-abc.mobi',
        '--legacy-mobi',
        '--no-validate',
        '--no-embed-source',
        '--no-hd-images',
        '--doc-type',
        'ebok',
      ]);
    });
    await fs.rm(argsFile, { force: true });
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('leaves no copy of the book behind when kindling fails part-way', async () => {
    const { uploadDir, input } = await stageUpload();
    // kindling unpacks the book beside its input, and a failure leaves that copy there.
    const script = `#!/bin/sh
mkdir ".kindling_epub_$(basename "$2" .epub)_1"
echo 'Error extracting EPUB: invalid Zip archive: Could not find EOCD'
echo 'Error(prcgen):E24000: Could not process input file'
exit 1
`;
    await withFakeTool('kindling-cli', script, async () => {
      await assert.rejects(
        () => convertWithKindling(input),
        (err: Error) => {
          assert.match(err.message, /kindling-cli exited with code 1/);
          assert.doesNotMatch(err.message, /file-1700000000000-abc/);
          return true;
        }
      );
      assert.deepStrictEqual(await fs.readdir(uploadDir), []);
    });
    await fs.rm(uploadDir, { recursive: true, force: true });
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
