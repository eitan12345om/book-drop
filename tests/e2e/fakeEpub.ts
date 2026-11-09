import JSZip from 'jszip';

const ZIP_END_RECORD = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

/** Returns bytes that pass the upload page's EPUB check without being a real EPUB. */
export function fakeEpub(text = 'fake epub'): Buffer {
  return Buffer.concat([Buffer.from(text), ZIP_END_RECORD]);
}

/** Returns a minimal zip laid out like an EPUB, with the uncompressed mimetype entry first. */
export function realEpub(): Promise<Buffer> {
  return new JSZip()
    .file('mimetype', 'application/epub+zip')
    .file('OEBPS/chapter.xhtml', `<p>${'Once upon a time. '.repeat(50)}</p>`)
    .generateAsync({ type: 'nodebuffer' });
}
