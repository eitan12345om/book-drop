import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from '../src/app.js';
import {
  MAX_ACTIVE_KEYS,
  MAX_KEYS_PER_IP,
  MAX_DISK_BYTES,
  MAX_FILES_PER_KEY,
  MAX_URLS_PER_KEY,
  FILE_DELETE_DELAY_MS,
} from '../src/config.js';
import { addDiskUsage, subtractDiskUsage, getDiskUsage } from '../src/keyStore.js';
import { buildSuccessMessage } from '../src/routes/upload.js';
import type { KeyInfo } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '../static');
const VIEWS_DIR = path.join(__dirname, '../static-views');

before(async () => {
  await fs.mkdir('uploads', { recursive: true });
  // Create minimal stub HTML files so the route tests don't depend on a build
  await fs.mkdir(STATIC_DIR, { recursive: true });
  await fs.mkdir(VIEWS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(VIEWS_DIR, 'upload.html'),
    '<html><body>upload<script nonce="NONCE_PLACEHOLDER"></script></body></html>'
  );
  await fs.writeFile(
    path.join(VIEWS_DIR, 'download.html'),
    '<html><body>key<script nonce="NONCE_PLACEHOLDER"></script></body></html>'
  );
});

after(async () => {
  await fs.rm('uploads', { recursive: true, force: true });
  await fs.rm(VIEWS_DIR, { recursive: true, force: true });
});

async function generateKey(agent = 'Mozilla/5.0 TestBrowser') {
  const { app, keys } = createApp();
  const res = await request(app).post('/generate').set('User-Agent', agent);
  return { app, keys, key: res.body.key as string, status: res.status };
}

// ---------------------------------------------------------------------------
describe('POST /generate', () => {
  it('returns 200 with a 4-character key', async () => {
    const { app } = createApp();
    const res = await request(app).post('/generate').set('User-Agent', 'TestBrowser/1.0');
    assert.strictEqual(res.status, 200);
    assert.match(res.body.key, /^[2-9A-Z]{4}$/);
  });

  it('GET /qr/:key returns a PNG image', async () => {
    const { app, key } = await generateKey('Kobo/1.0 Test');
    const res = await request(app).get(`/qr/${key}`).set('User-Agent', 'Kobo/1.0 Test');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.ok(res.body.length > 0);
  });

  it('stores the user-agent in the key info', async () => {
    const agent = 'Kobo/1.0 Test';
    const { keys, key } = await generateKey(agent);
    assert.strictEqual(keys.get(key)?.agent, agent);
  });

  it('removes the old key when a valid abandon key is provided', async () => {
    const { app, key: oldKey, keys } = await generateKey('TestBrowser/1.0');
    assert.ok(keys.has(oldKey));
    await request(app).post(`/generate?abandon=${oldKey}`).set('User-Agent', 'TestBrowser/1.0');
    assert.ok(!keys.has(oldKey), 'old key should be removed from the store');
  });

  it('ignores an unknown abandon key without error', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/generate?abandon=ZZZZ')
      .set('User-Agent', 'TestBrowser/1.0');
    assert.strictEqual(res.status, 200);
    assert.match(res.body.key, /^[2-9A-Z]{4}$/);
  });

  it('generates unique keys on successive calls', async () => {
    const { app, keys } = createApp();
    const agent = 'TestBrowser/1.0';
    const r1 = await request(app).post('/generate').set('User-Agent', agent);
    const r2 = await request(app).post('/generate').set('User-Agent', agent);
    assert.strictEqual(r1.body.key.length, 4);
    assert.strictEqual(r2.body.key.length, 4);
    assert.ok(keys.has(r1.body.key));
    assert.ok(keys.has(r2.body.key));
  });
});

// ---------------------------------------------------------------------------
describe('GET /status/:key', () => {
  it('returns 404 for an unknown key', async () => {
    const { app } = createApp();
    const res = await request(app).get('/status/ZZZZ').set('User-Agent', 'TestBrowser');
    assert.strictEqual(res.status, 404);
    assert.ok('error' in res.body);
  });

  it('returns empty files/urls for a freshly generated key', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, key } = await generateKey(agent);
    const res = await request(app).get(`/status/${key}`).set('User-Agent', agent);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.files, []);
    assert.deepStrictEqual(res.body.urls, []);
  });

  it('returns 403 when user-agent does not match', async () => {
    const { app, key } = await generateKey('BrowserA/1.0');
    const res = await request(app).get(`/status/${key}`).set('User-Agent', 'BrowserB/2.0');
    assert.strictEqual(res.status, 403);
  });

  it('reflects file info after it has been set', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    const info = keys.get(key)!;
    info.files = [
      {
        name: 'book.epub',
        path: '/tmp/book.epub',
        size: 0,
        uploaded: new Date(),
        downloadTimer: null,
      },
    ];

    const res = await request(app).get(`/status/${key}`).set('User-Agent', agent);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.files.length, 1);
    assert.strictEqual(res.body.files[0].name, 'book.epub');
  });
});

// ---------------------------------------------------------------------------
describe('DELETE /file/:key', () => {
  it('returns 400 for an unknown key', async () => {
    const { app } = createApp();
    const res = await request(app).delete('/file/ZZZZ');
    assert.strictEqual(res.status, 400);
  });

  it('clears all files and returns ok', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    const info = keys.get(key)!;
    info.files = [
      {
        name: 'test.epub',
        path: '/tmp/nonexistent.epub',
        size: 0,
        uploaded: new Date(),
        downloadTimer: null,
      },
    ];

    const del = await request(app).delete(`/file/${key}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.text, 'ok');

    const status = await request(app).get(`/status/${key}`).set('User-Agent', agent);
    assert.deepStrictEqual(status.body.files, []);
  });
});

// ---------------------------------------------------------------------------
describe('DELETE /file/:key/:filename', () => {
  it('returns 404 for an unknown key', async () => {
    const { app } = createApp();
    const res = await request(app).delete('/file/ZZZZ/book.epub');
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 when the filename does not match any staged file', async () => {
    const { app, keys, key } = await generateKey();
    keys.get(key)!.files = [
      {
        name: 'real.epub',
        path: '/tmp/nonexistent.epub',
        size: 0,
        uploaded: new Date(),
        downloadTimer: null,
      },
    ];
    const res = await request(app).delete(`/file/${key}/other.epub`);
    assert.strictEqual(res.status, 404);
  });

  it('removes only the named file and leaves others intact', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    const info = keys.get(key)!;
    info.files = [
      {
        name: 'first.epub',
        path: '/tmp/nonexistent1.epub',
        size: 0,
        uploaded: new Date(),
        downloadTimer: null,
      },
      {
        name: 'second.epub',
        path: '/tmp/nonexistent2.epub',
        size: 0,
        uploaded: new Date(),
        downloadTimer: null,
      },
    ];

    const del = await request(app).delete(`/file/${key}/first.epub`);
    assert.strictEqual(del.status, 200);

    const status = await request(app).get(`/status/${key}`).set('User-Agent', agent);
    assert.strictEqual(status.body.files.length, 1);
    assert.strictEqual(status.body.files[0].name, 'second.epub');
  });

  it('URL-decodes the filename parameter', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    keys.get(key)!.files = [
      {
        name: 'my book.epub',
        path: '/tmp/nonexistent.epub',
        size: 0,
        uploaded: new Date(),
        downloadTimer: null,
      },
    ];

    const del = await request(app).delete(`/file/${key}/my%20book.epub`);
    assert.strictEqual(del.status, 200);

    const status = await request(app).get(`/status/${key}`).set('User-Agent', agent);
    assert.deepStrictEqual(status.body.files, []);
  });
});

// ---------------------------------------------------------------------------
describe('POST /upload', () => {
  it('rejects an unknown key', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/upload')
      .field('key', 'ZZZZ')
      .attach('file', Buffer.from('hello'), { filename: 'test.txt', contentType: 'text/plain' });
    assert.strictEqual(res.status, 400);
  });

  it('rejects an empty file', async () => {
    const { app, key } = await generateKey();
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.alloc(0), { filename: 'empty.txt', contentType: 'text/plain' });
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /empty/i);
  });

  it('accepts a plain text file (no conversion needed)', async () => {
    const { app, key } = await generateKey();
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('This is a test ebook.'), {
        filename: 'test.txt',
        contentType: 'text/plain',
      });
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Sent to/i);
  });

  it('stores file info on the key after a successful upload', async () => {
    const { app, keys, key } = await generateKey();
    await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('ebook content'), {
        filename: 'mybook.txt',
        contentType: 'text/plain',
      });
    const info = keys.get(key)!;
    assert.strictEqual(info.files.length, 1);
    assert.strictEqual(info.files[0].name, 'mybook.txt');
  });

  it('adds a URL when url field is provided', async () => {
    const { app, keys, key } = await generateKey();
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .field('url', 'https://example.com/article');
    assert.strictEqual(res.status, 200);
    assert.ok(keys.get(key)!.urls.includes('https://example.com/article'));
  });

  it('returns 400 when neither file nor url is provided', async () => {
    const { app, key } = await generateKey();
    const res = await request(app).post('/upload').field('key', key);
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /No file or URL/i);
  });

  it('rejects an invalid URL', async () => {
    const { app, key } = await generateKey();
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .field('url', 'javascript:alert(1)');
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /Invalid URL/i);
  });

  it('returns 400 when MAX_FILES_PER_KEY is reached', async () => {
    const { app, keys, key } = await generateKey();
    const info = keys.get(key)!;
    for (let i = 0; i < MAX_FILES_PER_KEY; i++) {
      info.files.push({
        name: `book${i}.txt`,
        path: `/tmp/book${i}.txt`,
        size: 10,
        uploaded: new Date(),
        downloadTimer: null,
      });
    }
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('one more'), {
        filename: 'extra.txt',
        contentType: 'text/plain',
      });
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /File limit/i);
  });

  it('returns 400 when pendingUploads already fills the slot (TOCTOU guard)', async () => {
    const { app, keys, key } = await generateKey();
    const info = keys.get(key)!;
    // Simulate MAX_FILES_PER_KEY in-flight uploads with no committed files
    info.pendingUploads = MAX_FILES_PER_KEY;
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('one more'), {
        filename: 'extra.txt',
        contentType: 'text/plain',
      });
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /File limit/i);
  });

  it('accumulates disk usage across multiple files for the same key', async () => {
    const { app, keys, key } = await generateKey();
    const diskBefore = getDiskUsage();

    await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('first book content'), {
        filename: 'first.txt',
        contentType: 'text/plain',
      });
    const afterFirst = getDiskUsage();
    assert.ok(afterFirst > diskBefore, 'disk usage should increase after first upload');

    await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('second book content'), {
        filename: 'second.txt',
        contentType: 'text/plain',
      });
    const afterSecond = getDiskUsage();
    assert.ok(afterSecond > afterFirst, 'disk usage should increase again after second upload');
    assert.strictEqual(keys.get(key)!.files.length, 2);
  });

  it('deduplicates display names when the same filename is uploaded twice', async () => {
    const { app, keys, key } = await generateKey();

    await request(app).post('/upload').field('key', key).attach('file', Buffer.from('first copy'), {
      filename: 'book.txt',
      contentType: 'text/plain',
    });

    await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('second copy'), {
        filename: 'book.txt',
        contentType: 'text/plain',
      });

    const info = keys.get(key)!;
    assert.strictEqual(info.files.length, 2);
    assert.strictEqual(info.files[0].name, 'book.txt');
    assert.strictEqual(info.files[1].name, 'book (2).txt');
  });

  it('deduplicates display names when the same filename is uploaded three times', async () => {
    const { app, keys, key } = await generateKey();

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/upload')
        .field('key', key)
        .attach('file', Buffer.from(`copy ${i}`), {
          filename: 'book.txt',
          contentType: 'text/plain',
        });
    }

    const info = keys.get(key)!;
    assert.strictEqual(info.files.length, 3);
    assert.strictEqual(info.files[0].name, 'book.txt');
    assert.strictEqual(info.files[1].name, 'book (2).txt');
    assert.strictEqual(info.files[2].name, 'book (3).txt');
  });

  it('returns 400 when MAX_URLS_PER_KEY is reached', async () => {
    const { app, keys, key } = await generateKey();
    const info = keys.get(key)!;
    for (let i = 0; i < MAX_URLS_PER_KEY; i++) {
      info.urls.push(`https://example.com/${i}`);
    }
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .field('url', 'https://example.com/overflow');
    assert.strictEqual(res.status, 400);
    assert.match(res.text, /URL limit/i);
  });
});

// ---------------------------------------------------------------------------
describe('GET /', () => {
  it('serves the upload page for a regular browser', async () => {
    const { app } = createApp({ staticDir: STATIC_DIR, viewsDir: VIEWS_DIR });
    const res = await request(app).get('/').set('User-Agent', 'Mozilla/5.0 Chrome/120');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('upload'));
    assert.ok(!res.text.includes('NONCE_PLACEHOLDER'), 'nonce placeholder must be replaced');
  });

  it('serves the download page for a Kobo device', async () => {
    const { app } = createApp({ staticDir: STATIC_DIR, viewsDir: VIEWS_DIR });
    const res = await request(app)
      .get('/')
      .set('User-Agent', 'Mozilla/5.0 (Linux; Kobo Touch 4.39) AppleWebKit/537.36');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('key'));
    assert.ok(!res.text.includes('NONCE_PLACEHOLDER'), 'nonce placeholder must be replaced');
  });

  it('serves the download page for a Kindle device', async () => {
    const { app } = createApp({ staticDir: STATIC_DIR, viewsDir: VIEWS_DIR });
    const res = await request(app)
      .get('/')
      .set('User-Agent', 'Mozilla/5.0 (X11; Linux armv7l) Kindle/3.0');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('key'));
    assert.ok(!res.text.includes('NONCE_PLACEHOLDER'), 'nonce placeholder must be replaced');
  });
});

describe('GET /receive', () => {
  it('always serves the download page regardless of user-agent', async () => {
    const { app } = createApp({ staticDir: STATIC_DIR, viewsDir: VIEWS_DIR });
    const res = await request(app).get('/receive').set('User-Agent', 'Mozilla/5.0 Chrome/120');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('key'));
    assert.ok(!res.text.includes('NONCE_PLACEHOLDER'), 'nonce placeholder must be replaced');
  });
});

// ---------------------------------------------------------------------------
describe('CSP / nonce injection', () => {
  it('sets Cache-Control: no-store on HTML responses', async () => {
    const { app } = createApp({ staticDir: STATIC_DIR, viewsDir: VIEWS_DIR });
    const res = await request(app).get('/').set('User-Agent', 'Mozilla/5.0 Chrome/120');
    assert.strictEqual(res.status, 200);
    assert.ok(
      res.headers['cache-control']?.includes('no-store'),
      'HTML must not be cached (nonce reuse risk)'
    );
  });

  it('injects the same nonce into the CSP header and the HTML body', async () => {
    const { app } = createApp({ staticDir: STATIC_DIR, viewsDir: VIEWS_DIR });
    const res = await request(app).get('/').set('User-Agent', 'Mozilla/5.0 Chrome/120');
    assert.strictEqual(res.status, 200);
    // Extract nonce from HTML (nonce="<value>")
    const nonceMatch = res.text.match(/nonce="([^"]+)"/);
    assert.ok(nonceMatch, 'HTML should contain a nonce attribute');
    const nonce = nonceMatch[1];
    // CSP header (report-only or enforced) should reference the same nonce
    const cspHeader =
      res.headers['content-security-policy-report-only'] ?? res.headers['content-security-policy'];
    assert.ok(cspHeader, 'CSP header must be present');
    assert.ok(cspHeader.includes(`'nonce-${nonce}'`), `CSP header should contain nonce-${nonce}`);
  });
});

// ---------------------------------------------------------------------------
describe('POST /generate — per-IP limit', () => {
  it('returns 429 when MAX_KEYS_PER_IP is reached from the same IP', async () => {
    const { app } = createApp();
    const agent = 'TestBrowser/1.0';
    for (let i = 0; i < MAX_KEYS_PER_IP; i++) {
      const res = await request(app).post('/generate').set('User-Agent', agent);
      assert.strictEqual(res.status, 200);
    }
    const res = await request(app).post('/generate').set('User-Agent', agent);
    assert.strictEqual(res.status, 429);
  });
});

// ---------------------------------------------------------------------------
describe('POST /generate — capacity', () => {
  it('returns 503 when MAX_ACTIVE_KEYS is reached', async () => {
    const { app, keys } = createApp();
    const fakeInfo: KeyInfo = {
      created: new Date(),
      ip: '1.2.3.4',
      agent: 'test',
      files: [],
      urls: [],
      timer: null,
      pendingUploads: 0,
      pendingFilenames: [],
      alive: new Date(),
    };
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      keys.set(String(i).padStart(4, 'A').substring(0, 4) + i, fakeInfo);
    }
    const res = await request(app).post('/generate').set('User-Agent', 'TestBrowser');
    assert.strictEqual(res.status, 503);
  });
});

// ---------------------------------------------------------------------------
describe('GET /:filename', () => {
  it('serves a staged file when key and filename match', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    const tmpFile = path.join('uploads', `test-serve-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'ebook content here');
    keys.get(key)!.files = [
      { name: 'mybook.txt', path: tmpFile, size: 0, uploaded: new Date(), downloadTimer: null },
    ];

    const res = await request(app).get(`/mybook.txt?key=${key}`).set('User-Agent', agent);
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('ebook content here'));

    await fs.rm(tmpFile, { force: true });
  });

  it('falls through (404) when the filename does not match any staged file', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    keys.get(key)!.files = [
      {
        name: 'real.txt',
        path: '/tmp/nonexistent.txt',
        size: 0,
        uploaded: new Date(),
        downloadTimer: null,
      },
    ];

    const res = await request(app).get(`/wrong.txt?key=${key}`).set('User-Agent', agent);
    assert.strictEqual(res.status, 404);
  });

  it('falls through without a key parameter', async () => {
    const { app } = createApp({ staticDir: STATIC_DIR });
    const res = await request(app).get('/somefile.epub');
    assert.strictEqual(res.status, 404);
  });

  it('falls through with an invalid key format', async () => {
    const { app } = createApp({ staticDir: STATIC_DIR });
    const res = await request(app).get('/somefile.epub?key=!!');
    assert.strictEqual(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('GET /:filename — download timer', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  it('sets downloadTimer on the FileInfo after a successful download', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    const tmpFile = path.join('uploads', `test-timer-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'timer test content');
    const fileEntry = {
      name: 'timer.txt',
      path: tmpFile,
      size: 18,
      uploaded: new Date(),
      downloadTimer: null,
    };
    keys.get(key)!.files = [fileEntry];

    const res = await request(app).get(`/timer.txt?key=${key}`).set('User-Agent', agent);
    assert.strictEqual(res.status, 200);
    assert.notStrictEqual(
      fileEntry.downloadTimer,
      null,
      'downloadTimer should be set after serving'
    );

    await fs.rm(tmpFile, { force: true });
  });

  it('removes the file from info.files after FILE_DELETE_DELAY_MS', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    const tmpFile = path.join('uploads', `test-autorm-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'timer test content');
    keys.get(key)!.files = [
      {
        name: 'autoremove.txt',
        path: tmpFile,
        size: 18,
        uploaded: new Date(),
        downloadTimer: null,
      },
    ];

    await request(app).get(`/autoremove.txt?key=${key}`).set('User-Agent', agent);
    assert.strictEqual(keys.get(key)!.files.length, 1, 'file should still be staged before delay');

    mock.timers.tick(FILE_DELETE_DELAY_MS + 1);
    assert.strictEqual(keys.get(key)!.files.length, 0, 'file should be removed after delay');

    await fs.rm(tmpFile, { force: true });
  });
});

// ---------------------------------------------------------------------------
describe('POST /upload — disk limit', () => {
  it('returns 507 when disk usage is at the limit', async () => {
    const { app, key } = await generateKey();
    addDiskUsage(MAX_DISK_BYTES);
    try {
      const res = await request(app)
        .post('/upload')
        .field('key', key)
        .attach('file', Buffer.from('This is a test ebook.'), {
          filename: 'test.txt',
          contentType: 'text/plain',
        });
      assert.strictEqual(res.status, 507);
    } finally {
      subtractDiskUsage(MAX_DISK_BYTES);
    }
  });
});

// ---------------------------------------------------------------------------
describe('POST /upload — unsupported file type', () => {
  it('returns 400 for a file with an unsupported extension', async () => {
    const { app, key } = await generateKey();
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('some content'), {
        filename: 'virus.exe',
        contentType: 'application/octet-stream',
      });
    assert.strictEqual(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
describe('POST /upload — temp file cleanup on rejection', () => {
  // Empty files are written to disk by multer (0-byte write), then rejected post-write.
  // Verifies the deleteFile call keeps the uploads dir clean after a validation failure.
  it('removes the temp file when an empty file is rejected', async () => {
    const { app, key } = await generateKey();
    const filesBefore = await fs.readdir('uploads');

    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.alloc(0), { filename: 'empty.txt', contentType: 'text/plain' });

    // Give the async deleteFile callback a tick to complete
    await new Promise((resolve) => setImmediate(resolve));

    const filesAfter = await fs.readdir('uploads');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(
      filesAfter.length,
      filesBefore.length,
      'no temp files should remain after an empty-file rejection'
    );
  });

  // Verifies that a file written to disk during a successful upload passes through cleanly,
  // and that the upload dir count matches after a sequence of accept + reject.
  it('does not accumulate temp files across a mix of accepted and rejected uploads', async () => {
    const { app, key } = await generateKey();
    const filesBefore = await fs.readdir('uploads');

    // Accepted upload — file is kept (counted in info.files, not in uploads as orphan)
    await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.from('good content'), {
        filename: 'good.txt',
        contentType: 'text/plain',
      });

    // Rejected upload (empty file) — temp file must be deleted
    await request(app)
      .post('/upload')
      .field('key', key)
      .attach('file', Buffer.alloc(0), { filename: 'empty.txt', contentType: 'text/plain' });

    await new Promise((resolve) => setImmediate(resolve));

    const filesAfter = await fs.readdir('uploads');
    // Only the accepted file should remain (filesBefore + 1)
    assert.strictEqual(
      filesAfter.length,
      filesBefore.length + 1,
      'only the accepted file should be in uploads — rejected upload must not leave an orphan'
    );
  });
});

// ---------------------------------------------------------------------------
describe('GET /device/:key', () => {
  it('returns 400 for an invalid key format', async () => {
    const { app } = createApp();
    const res = await request(app).get('/device/!!');
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for an unknown key', async () => {
    const { app } = createApp();
    const res = await request(app).get('/device/ZZZZ');
    assert.strictEqual(res.status, 404);
  });

  it('returns Kobo for a key registered by a Kobo device', async () => {
    const { app, key } = await generateKey('Mozilla/5.0 (Linux; Kobo Touch 4.39)');
    const res = await request(app).get(`/device/${key}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.device, 'Kobo');
  });

  it('returns Kindle for a key registered by a Kindle device', async () => {
    const { app, key } = await generateKey('Mozilla/5.0 (X11; Linux armv7l) Kindle/3.0');
    const res = await request(app).get(`/device/${key}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.device, 'Kindle');
  });

  it('returns Tolino for a key registered by a Tolino device', async () => {
    const { app, key } = await generateKey('Mozilla/5.0 (Linux; Android 4.4; Tolino)');
    const res = await request(app).get(`/device/${key}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.device, 'Tolino');
  });

  it('returns unknown for an unrecognised user-agent', async () => {
    const { app, key } = await generateKey('Mozilla/5.0 GenericBrowser/1.0');
    const res = await request(app).get(`/device/${key}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.device, 'unknown');
  });

  it('does not require the caller to match the registered user-agent', async () => {
    const { app, key } = await generateKey('Mozilla/5.0 (Linux; Kobo Touch 4.39)');
    const res = await request(app).get(`/device/${key}`).set('User-Agent', 'SomethingElse/1.0');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.device, 'Kobo');
  });
});

// ---------------------------------------------------------------------------
describe('malformed URLs', () => {
  it('returns 400 for invalid UTF-8 percent-encoding without stack trace', async () => {
    const { app } = createApp();
    const res = await request(app).get('/%2f%c0').set('User-Agent', 'TestBrowser/1.0');
    assert.strictEqual(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
describe('POST /generate — 503 body', () => {
  it('returns "Server busy" body when MAX_ACTIVE_KEYS is reached', async () => {
    const { app, keys } = createApp();
    const fakeInfo: KeyInfo = {
      created: new Date(),
      ip: '1.2.3.4',
      agent: 'test',
      files: [],
      urls: [],
      timer: null,
      pendingUploads: 0,
      pendingFilenames: [],
      alive: new Date(),
    };
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      keys.set(String(i).padStart(4, 'A').substring(0, 4) + i, fakeInfo);
    }
    const res = await request(app).post('/generate').set('User-Agent', 'TestBrowser');
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.text, 'Server busy');
  });
});

// ---------------------------------------------------------------------------
describe('buildSuccessMessage', () => {
  it('returns basic success message without optional fields', () => {
    const msg = buildSuccessMessage('your device', null, 'book.epub', null);
    assert.ok(msg.includes('Sent to your device'));
    assert.ok(msg.includes('Filename: book.epub'));
    assert.ok(!msg.includes('Metadata lookup failed'));
  });

  it('includes conversion tool when provided', () => {
    const msg = buildSuccessMessage('Kindle', 'KindleGen', 'book.mobi', null);
    assert.ok(msg.includes('converted with KindleGen'));
  });

  it('includes URL when provided', () => {
    const msg = buildSuccessMessage('your device', null, 'book.epub', 'https://example.com');
    assert.ok(msg.includes('URL added: https://example.com'));
  });

  it('appends metadata failure note when metadataFailed is true', () => {
    const msg = buildSuccessMessage('your device', null, 'book.epub', null, true);
    assert.ok(msg.includes('Metadata lookup failed'));
    assert.ok(msg.includes('original metadata kept'));
  });

  it('does not append metadata failure note when metadataFailed is false', () => {
    const msg = buildSuccessMessage('your device', null, 'book.epub', null, false);
    assert.ok(!msg.includes('Metadata lookup failed'));
  });
});

// ---------------------------------------------------------------------------
describe('POST /upload — metadata failure feedback', () => {
  it('includes metadata failure note in response when fetchmetadata is set and EPUB parsing fails', async () => {
    const { app, key } = await generateKey();
    // A buffer that declares itself as EPUB but is not a valid ZIP — causes readEpubMetadata to throw
    const fakeEpub = Buffer.from('not a real epub file');
    const res = await request(app)
      .post('/upload')
      .field('key', key)
      .field('fetchmetadata', '1')
      .attach('file', fakeEpub, { filename: 'book.epub', contentType: 'application/epub+zip' });
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Sent to/i);
    assert.match(res.text, /Metadata lookup failed/i);
  });
});

// ---------------------------------------------------------------------------
describe('GET /events/:key', () => {
  const agent = 'Kobo/4.0 TestDevice';
  let app: ReturnType<typeof createApp>['app'];
  let keys: ReturnType<typeof createApp>['keys'];
  let key: string;

  before(async () => {
    ({ app, keys } = createApp());
    const res = await request(app).post('/generate').set('User-Agent', agent);
    key = res.body.key;
  });

  it('returns 400 for invalid key format', async () => {
    const res = await request(app).get('/events/!!').set('User-Agent', agent);
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for unknown key', async () => {
    const res = await request(app).get('/events/ZZZZ').set('User-Agent', agent);
    assert.strictEqual(res.status, 404);
  });

  it('returns 403 for wrong user-agent', async () => {
    const res = await request(app).get(`/events/${key}`).set('User-Agent', 'Mozilla/5.0');
    assert.strictEqual(res.status, 403);
  });

  it('opens SSE stream with correct headers and sends initial state', async () => {
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        const req = http.request(
          {
            hostname: 'localhost',
            port,
            path: `/events/${encodeURIComponent(key)}`,
            headers: { 'User-Agent': agent },
          },
          (res) => {
            try {
              assert.strictEqual(res.statusCode, 200);
              assert.ok(res.headers['content-type']?.startsWith('text/event-stream'));
            } catch (e) {
              req.destroy();
              server.close(() => reject(e));
              return;
            }
            let buf = '';
            res.on('data', (chunk: Buffer) => {
              buf += chunk.toString();
              if (!buf.includes('\n\n')) {
                return;
              }
              req.destroy();
              server.close(() => {
                try {
                  const line = buf.split('\n').find((l) => l.startsWith('data:'))!;
                  const payload = JSON.parse(line.replace(/^data:\s*/, ''));
                  assert.ok('files' in payload && 'urls' in payload);
                  resolve();
                } catch (e) {
                  reject(e);
                }
              });
            });
          }
        );
        req.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ECONNRESET') {
            server.close(() => resolve());
            return;
          }
          server.close(() => reject(err));
        });
        req.end();
      });
    });
  });

  it('resets the inactivity timer when SSE connects', async () => {
    const aliceBefore = keys.get(key)!.alive.getTime();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        const req = http.request(
          {
            hostname: 'localhost',
            port,
            path: `/events/${encodeURIComponent(key)}`,
            headers: { 'User-Agent': agent },
          },
          (res) => {
            res.on('data', () => {
              req.destroy();
              server.close(() => {
                try {
                  assert.ok(keys.get(key)!.alive.getTime() > aliceBefore);
                  resolve();
                } catch (e) {
                  reject(e);
                }
              });
            });
          }
        );
        req.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ECONNRESET') {
            server.close(() => resolve());
            return;
          }
          server.close(() => reject(err));
        });
        req.end();
      });
    });
  });
});
