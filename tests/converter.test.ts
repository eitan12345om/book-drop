import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
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

/** A tiny EPUB whose zip directory claims its chapter unpacks to chapterSize bytes. */
async function epubClaiming(chapterSize: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('OEBPS/ch1.xhtml', '<html/>');
  const book = await zip.generateAsync({ type: 'nodebuffer' });
  book.writeUInt32LE(chapterSize, book.lastIndexOf(Buffer.from('PK\x01\x02', 'latin1')) + 24);
  return book;
}

async function stageUpload(
  name = 'file-1700000000000-abc.epub',
  book?: Buffer
): Promise<{ uploadDir: string; input: string }> {
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uploads-'));
  const input = path.join(uploadDir, name);
  await fs.writeFile(input, book ?? (await epubClaiming(7)));
  return { uploadDir, input };
}

describe('convertWithKindlegen', () => {
  it('rejects with an error when kindlegen is not available or the file is invalid', async () => {
    await assert.rejects(
      () => convertWithKindlegen('/tmp/_book-drop_test.epub'),
      (err: Error) => {
        assert.ok(err instanceof Error);
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
  it("writes a MOBI beside the upload, running kindling with BookDrop's options but not its secrets", async () => {
    const { uploadDir, input } = await stageUpload();
    const argsFile = path.join(uploadDir, '..', `${path.basename(uploadDir)}-args`);
    const envFile = `${argsFile}-env`;
    const script = `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
env > "${envFile}"
echo mobi > "$4"
`;
    process.env.GOOGLE_BOOKS_API_KEY = 'test-secret';
    await withFakeTool('kindling-cli', script, async () => {
      const output = await convertWithKindling(input);

      assert.strictEqual(output, path.join(uploadDir, 'file-1700000000000-abc.mobi'));
      assert.deepStrictEqual(await fs.readdir(uploadDir), ['file-1700000000000-abc.mobi']);
      assert.deepStrictEqual((await fs.readFile(argsFile, 'utf8')).trim().split('\n'), [
        'build',
        'in.epub',
        '-o',
        'out.mobi',
        '--legacy-mobi',
        '--no-validate',
        '--no-embed-source',
        '--no-hd-images',
        '--doc-type',
        'ebok',
      ]);
      assert.doesNotMatch(await fs.readFile(envFile, 'utf8'), /test-secret/);
    });
    delete process.env.GOOGLE_BOOKS_API_KEY;
    await fs.rm(argsFile, { force: true });
    await fs.rm(envFile, { force: true });
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('keeps the converted book when the EPUB was uploaded under another extension', async () => {
    const { uploadDir, input } = await stageUpload('file-1700000000000-abc.zip');
    await withFakeTool('kindling-cli', '#!/bin/sh\necho mobi > "$4"\n', async () => {
      const output = await convertWithKindling(input);

      assert.strictEqual(output, path.join(uploadDir, 'file-1700000000000-abc.mobi'));
      assert.deepStrictEqual(await fs.readdir(uploadDir), ['file-1700000000000-abc.mobi']);
    });
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('leaves no copy of the book behind when kindling fails part-way', async () => {
    const { uploadDir, input } = await stageUpload();
    const script = `#!/bin/sh
mkdir ".kindling_epub_$(basename "$2" .epub)_1"
echo 'Error extracting EPUB: invalid Zip archive: Could not find EOCD'
echo 'Error(prcgen):E24000: Could not process input file'
exit 1
`;
    await withFakeTool('kindling-cli', script, async () => {
      await assert.rejects(() => convertWithKindling(input), /exited with code 1/);
      assert.deepStrictEqual(await fs.readdir(uploadDir), []);
    });
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('rejects a zip whose directory claims to be larger than the file, without reading it', async () => {
    const book = await epubClaiming(7);
    book.writeUInt32LE(0xf0000000, book.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1')) + 12);
    const { uploadDir, input } = await stageUpload(undefined, book);
    await withFakeTool('kindling-cli', '#!/bin/sh\nexit 0\n', async () => {
      await assert.rejects(() => convertWithKindling(input), /Corrupt zip/);
    });
    assert.deepStrictEqual(await fs.readdir(uploadDir), []);
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('refuses an EPUB whose end record hides its entries, without running kindling', async () => {
    const book = await epubClaiming(300_000_000);
    book.writeUInt16LE(0, book.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1')) + 10);
    const { uploadDir, input } = await stageUpload(undefined, book);
    const ranFile = `${uploadDir}-ran`;
    await withFakeTool('kindling-cli', `#!/bin/sh\ntouch "${ranFile}"\n`, async () => {
      await assert.rejects(() => convertWithKindling(input), /Corrupt zip/);
    });
    await assert.rejects(fs.access(ranFile), { code: 'ENOENT' });
    assert.deepStrictEqual(await fs.readdir(uploadDir), []);
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('refuses an EPUB that unpacks to more than 256 MB without running kindling', async () => {
    const { uploadDir, input } = await stageUpload(undefined, await epubClaiming(300_000_000));
    const ranFile = `${uploadDir}-ran`;
    await withFakeTool('kindling-cli', `#!/bin/sh\ntouch "${ranFile}"\n`, async () => {
      await assert.rejects(
        () => convertWithKindling(input),
        (err: ConversionError) => {
          assert.ok(err instanceof ConversionError);
          assert.match(err.userMessage, /too large to convert/);
          return true;
        }
      );
    });
    await assert.rejects(fs.access(ranFile), { code: 'ENOENT' });
    assert.deepStrictEqual(await fs.readdir(uploadDir), []);
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
  it(
    'runs pdfcropmargins as the first process to kill if memory runs out',
    { skip: process.platform !== 'linux' && 'choom is Linux-only' },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfcrop-'));
      const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-pdfcropmargins-'));
      // -s -u -o <output> <input>: reports its OOM score adjustment as the cropped PDF.
      await fs.writeFile(
        path.join(fakeBinDir, 'pdfcropmargins'),
        '#!/bin/sh\ncat /proc/self/oom_score_adj > "$4"\n',
        {
          mode: 0o755,
        }
      );
      const input = path.join(dir, 'file-1700000000000-abc.pdf');
      await fs.writeFile(input, '%PDF-1.4');
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
      try {
        const output = await convertWithPdfCropMargins(input);
        assert.strictEqual((await fs.readFile(output, 'utf8')).trim(), '1000');
      } finally {
        process.env.PATH = originalPath;
        await fs.rm(fakeBinDir, { recursive: true, force: true });
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  );

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
