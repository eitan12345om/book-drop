import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
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
