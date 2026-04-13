# BookDrop

A self-hostable web service for sending ebooks to a Kobo, Kindle, or Tolino through its built-in browser — no account, no cloud, no cables.

Live at [bookdrop.cc](https://bookdrop.cc) · Forked from [send2ereader](https://github.com/daniel-j/send2ereader) by [djazz](https://github.com/daniel-j)

## How it works

1. Open the site in your ereader's browser — it shows a 4-character key and a QR code.
2. Scan the QR code with your phone to open the upload page with the key pre-filled, or enter the key manually on any computer.
3. Pick one or more files and click **Upload and send**.
4. Download links appear on the ereader within seconds.

Supported formats: EPUB, MOBI, PDF, CBZ, CBR, HTML, TXT.

Optional conversions (requires external tools — see below):

- EPUB → KEPUB (Kobo, via kepubify) — better typography and font control
- EPUB → MOBI (Kindle, via KindleGen) — Kindle doesn't support EPUB natively
- PDF margin cropping (via pdfCropMargins) — fills more of the small screen
- Update EPUB metadata from Google Books — patches title, author, publisher, etc. and shows a before/after diff on the download page (requires a `GOOGLE_BOOKS_API_KEY`)

## Running locally

### Prerequisites

- Node.js 22 or later
- pnpm (`npm install -g pnpm` or via [corepack](https://nodejs.org/api/corepack.html))
- _(Optional)_ [kepubify](https://pgaskin.net/kepubify/) in `PATH`
- _(Optional)_ [KindleGen](http://web.archive.org/web/*/http://kindlegen.s3.amazonaws.com/kindlegen*) in `PATH`
- _(Optional)_ [pdfCropMargins](https://github.com/abarker/pdfCropMargins) (`pip install pdfCropMargins`)

### Development

```sh
pnpm install
pnpm dev        # watches SCSS and TypeScript; starts Express on :3001
```

### Production

```sh
pnpm build      # compiles SCSS to client/public/ and TypeScript to dist/
pnpm start      # runs dist/server.js
```

### Tests & linting

```sh
pnpm test
pnpm typecheck
pnpm lint
```

Uses Node.js's built-in test runner (`node:test`) — no extra test framework needed.

## Environment variables

Copy `.env.example` to `.env` to customise these values.

| Variable               | Default      | Description                                                                                   |
| ---------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | _(unset)_    | Set to `test` to disable HSTS and `upgrade-insecure-requests` (e.g. for local HTTP dev)       |
| `PORT`                 | `3001`       | HTTP port the server listens on                                                               |
| `UPLOAD_DIR`           | `uploads`    | Directory for temporary file storage                                                          |
| `EXPIRE_DELAY_MS`      | `300000`     | Inactivity timeout per key (ms)                                                               |
| `MAX_EXPIRE_MS`        | `3600000`    | Hard maximum key lifetime (ms)                                                                |
| `MAX_FILE_SIZE`        | `838860800`  | Upload size limit in bytes (800 MB)                                                           |
| `MAX_DISK_BYTES`       | `1073741824` | Total upload directory size cap in bytes (1 GB); uploads returning 507 when exceeded          |
| `MAX_FILES_PER_KEY`    | `5`          | Max files staged per session key; further uploads return 400                                  |
| `MAX_URLS_PER_KEY`     | `20`         | Max URLs staged per session key; further submissions return 400                               |
| `MAX_KEYS_PER_IP`      | `3`          | Max concurrent sessions per IP; further requests return 429                                   |
| `RATE_LIMIT_WINDOW_MS` | `900000`     | Rate-limit window for `/generate` (ms)                                                        |
| `RATE_LIMIT_MAX`       | `20`         | Max key generations per window per IP                                                         |
| `LOG_LEVEL`            | `info`       | Pino log level (`trace`, `debug`, `info`, `warn`, `error`)                                    |
| `GOOGLE_BOOKS_API_KEY` | _(unset)_    | Google Books API key for EPUB metadata enrichment; without it the API may rate-limit requests |

## Docker

```sh
docker compose build
docker compose up -d
```

The service will be available at `http://localhost:3001`.
