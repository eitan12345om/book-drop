import JSZip from 'jszip';

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function chapter(n, title, paragraphs) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title></head>
  <body>
    <h1 id="ch${n}">${title}</h1>
    ${Array.from({ length: paragraphs }, (_, i) => `<p>Paragraph ${i + 1} of ${title}. Le manoir, les fantômes gris, et une porte.</p>`).join('\n    ')}
  </body>
</html>`;
}

/**
 * An EPUB whose table of contents points at an anchor that exists nowhere in the book.
 *
 * This is the defect that made KindleGen abandon otherwise fine books in production
 * (E24010 followed by a fatal E24001), and the reason for moving to calibre.
 */
export async function brokenTocEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Broken TOC Anchor Test</dc:title>
    <dc:creator>Évelyne Brisou-Pellen</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:00000000-0000-4000-8000-000000000001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c0" href="text/part0000.html" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/part0001.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c0"/>
    <itemref idref="c1"/>
  </spine>
</package>`
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:00000000-0000-4000-8000-000000000001"/></head>
  <docTitle><text>Broken TOC Anchor Test</text></docTitle>
  <navMap>
    <navPoint id="n0" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="text/part0000.html#_idParaDest-1"/>
    </navPoint>
    <navPoint id="n1" playOrder="2">
      <navLabel><text>Chapter Two</text></navLabel>
      <content src="text/part0001.html#_idParaDest-1"/>
    </navPoint>
  </navMap>
</ncx>`
  );
  zip.file('OEBPS/text/part0000.html', chapter(0, 'Chapter One', 40));
  zip.file('OEBPS/text/part0001.html', chapter(1, 'Chapter Two', 40));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A book-sized EPUB, for exercising conversion under realistic CPU and memory limits. */
export async function bigBookEpub(chapters = 400) {
  const zip = new JSZip();
  const items = Array.from({ length: chapters }, (_, n) => n);
  const body = (n) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter ${n}</title><link rel="stylesheet" href="../styles/main.css" type="text/css"/></head>
  <body>
    <h1 id="ch${n}">Chapter ${n}</h1>
    ${Array.from(
      { length: 60 },
      (_, i) =>
        `<p class="body">Section ${i + 1}. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(4)}</p>`
    ).join('\n    ')}
  </body>
</html>`;

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER);
  zip.file(
    'OEBPS/styles/main.css',
    'body{margin:1em}p.body{text-indent:1.2em;margin:0 0 .4em}h1{page-break-before:always}'
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Timing Fixture: A Long Novel</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:00000000-0000-4000-8000-000000000002</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    ${items.map((n) => `<item id="c${n}" href="text/ch${n}.html" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${items.map((n) => `<itemref idref="c${n}"/>`).join('\n    ')}
  </spine>
</package>`
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:00000000-0000-4000-8000-000000000002"/></head>
  <docTitle><text>Timing Fixture</text></docTitle>
  <navMap>
    ${items.map((n) => `<navPoint id="n${n}" playOrder="${n + 1}"><navLabel><text>Chapter ${n}</text></navLabel><content src="text/ch${n}.html#ch${n}"/></navPoint>`).join('\n    ')}
  </navMap>
</ncx>`
  );
  for (const n of items) {
    zip.file(`OEBPS/text/ch${n}.html`, body(n));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Bytes that claim to be an EPUB but are not a ZIP, so any converter should refuse them. */
export function notAnEpub() {
  return Buffer.from('This is not a book, it is a sentence pretending to be one.\n');
}
