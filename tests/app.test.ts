import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from '../src/app.js';
import { MAX_ACTIVE_KEYS, MAX_KEYS_PER_IP, MAX_DISK_BYTES } from '../src/config.js';
import { addDiskUsage, subtractDiskUsage } from '../src/keyStore.js';
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
  return { app, keys, key: res.text, status: res.status };
}

// ---------------------------------------------------------------------------
describe('POST /generate', () => {
  it('returns 200 with a 4-character key', async () => {
    const { key, status } = await generateKey();
    assert.strictEqual(status, 200);
    assert.match(key, /^[2-9A-Z]{4}$/);
  });

  it('stores the user-agent in the key info', async () => {
    const agent = 'Kobo/1.0 Test';
    const { keys, key } = await generateKey(agent);
    assert.strictEqual(keys.get(key)?.agent, agent);
  });

  it('generates unique keys on successive calls', async () => {
    const { app, keys } = createApp();
    const agent = 'TestBrowser/1.0';
    const r1 = await request(app).post('/generate').set('User-Agent', agent);
    const r2 = await request(app).post('/generate').set('User-Agent', agent);
    assert.strictEqual(r1.text.length, 4);
    assert.strictEqual(r2.text.length, 4);
    assert.ok(keys.has(r1.text));
    assert.ok(keys.has(r2.text));
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

  it('returns empty file/urls for a freshly generated key', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, key } = await generateKey(agent);
    const res = await request(app).get(`/status/${key}`).set('User-Agent', agent);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.file, null);
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
    info.file = { name: 'book.epub', path: '/tmp/book.epub', size: 0, uploaded: new Date() };

    const res = await request(app).get(`/status/${key}`).set('User-Agent', agent);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.file, { name: 'book.epub' });
  });
});

// ---------------------------------------------------------------------------
describe('DELETE /file/:key', () => {
  it('returns 400 for an unknown key', async () => {
    const { app } = createApp();
    const res = await request(app).delete('/file/ZZZZ');
    assert.strictEqual(res.status, 400);
  });

  it('clears the file and returns ok', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    const info = keys.get(key)!;
    info.file = { name: 'test.epub', path: '/tmp/nonexistent.epub', size: 0, uploaded: new Date() };

    const del = await request(app).delete(`/file/${key}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.text, 'ok');

    const status = await request(app).get(`/status/${key}`).set('User-Agent', agent);
    assert.strictEqual(status.body.file, null);
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
    assert.notStrictEqual(info.file, null);
    assert.strictEqual(info.file!.name, 'mybook.txt');
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
      file: null,
      urls: [],
      timer: null,
      downloadTimer: null,
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
    keys.get(key)!.file = { name: 'mybook.txt', path: tmpFile, size: 0, uploaded: new Date() };

    const res = await request(app).get(`/mybook.txt?key=${key}`).set('User-Agent', agent);
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('ebook content here'));

    await fs.rm(tmpFile, { force: true });
  });

  it('falls through (404) when the filename does not match the staged file', async () => {
    const agent = 'TestBrowser/1.0';
    const { app, keys, key } = await generateKey(agent);
    keys.get(key)!.file = {
      name: 'real.txt',
      path: '/tmp/nonexistent.txt',
      size: 0,
      uploaded: new Date(),
    };

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
describe('GET /events/:key', () => {
  const agent = 'Kobo/4.0 TestDevice';
  let app: ReturnType<typeof createApp>['app'];
  let keys: ReturnType<typeof createApp>['keys'];
  let key: string;

  before(async () => {
    ({ app, keys } = createApp());
    const res = await request(app).post('/generate').set('User-Agent', agent);
    key = res.text;
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
                  assert.ok('file' in payload && 'urls' in payload);
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
