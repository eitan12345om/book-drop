# book-drop

A self-hostable web service for sending ebooks to a Kobo, Kindle, or Tolino
ereader through its built-in browser — no account, no cloud, no cables.

## How it works

1. Open `http://your-server/` in your ereader's browser — it shows a unique 4-character key.
2. On your computer, go to the same URL, enter the key, pick a file, and click **Upload and send**.
3. A download link appears on the ereader within seconds.

Supported formats: EPUB, MOBI, PDF, CBZ, CBR, HTML, TXT.

Optional conversion (requires external tools — see below):

- EPUB → KEPUB (Kobo, via kepubify) — better typography and font control
- EPUB → MOBI (Kindle, via KindleGen) — Kindle doesn't support EPUB natively
- PDF margin cropping (via pdfCropMargins) — fills more of the small screen

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
pnpm dev        # starts Express on :3001, serving client/public/ directly
```

No build step required — the server serves `client/public/` as static files.

### Production build

```sh
pnpm build      # compiles TypeScript server to dist/
pnpm start      # runs dist/server.js
```

### Tests

```sh
pnpm test
```

Uses Node.js's built-in test runner (`node:test`) — no extra test framework needed.

### Type checking & lint

```sh
pnpm typecheck
pnpm lint
```

## Environment variables

| Variable               | Default     | Description                                                |
| ---------------------- | ----------- | ---------------------------------------------------------- |
| `PORT`                 | `3001`      | HTTP port the server listens on                            |
| `UPLOAD_DIR`           | `uploads`   | Directory for temporary file storage                       |
| `EXPIRE_DELAY_MS`      | `30000`     | Inactivity timeout per key (ms)                            |
| `MAX_EXPIRE_MS`        | `3600000`   | Hard maximum key lifetime (ms)                             |
| `MAX_FILE_SIZE`        | `838860800` | Upload size limit in bytes (800 MB)                        |
| `RATE_LIMIT_WINDOW_MS` | `900000`    | Rate-limit window for `/generate` (ms)                     |
| `RATE_LIMIT_MAX`       | `20`        | Max key generations per window per IP                      |
| `LOG_LEVEL`            | `info`      | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) |

Copy `.env.example` to `.env` to customise these values.

## Running with Docker

```sh
docker compose build
docker compose up -d
```

The service will be available at `http://localhost:3001`.

The Docker image uses a multi-stage build: the builder stage compiles the
TypeScript server; the production stage installs only runtime dependencies and
copies the compiled output alongside the static HTML files.
