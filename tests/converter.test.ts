import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  backendFor,
  convert,
  ConversionError,
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
  it('resolves each intent to the tool that serves it', () => {
    assert.strictEqual(backendFor('kobo').tool, 'Kepubify');
    assert.strictEqual(backendFor('kindle').tool, 'KindleGen');
    assert.strictEqual(backendFor('pdfcrop').tool, 'pdfCropMargins');
  });

  it('names Kobo output with the double extension Kobo devices require', () => {
    assert.strictEqual(backendFor('kobo').outputName('book.epub'), 'book.kepub.epub');
    assert.strictEqual(backendFor('kobo').outputName('book.kepub.epub'), 'book.kepub.epub');
  });

  it('names Kindle output with the format the backend produces', () => {
    assert.strictEqual(backendFor('kindle').outputName('book.epub'), 'book.mobi');
    assert.strictEqual(backendFor('kindle').outputName('book.kepub.epub'), 'book.mobi');
  });

  it('leaves PDF filenames untouched', () => {
    assert.strictEqual(backendFor('pdfcrop').outputName('paper.pdf'), 'paper.pdf');
  });

  it('preserves dots in the book title when swapping the extension', () => {
    assert.strictEqual(
      backendFor('kindle').outputName('Vol. 2 - A.B.C..epub'),
      'Vol. 2 - A.B.C..mobi'
    );
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
