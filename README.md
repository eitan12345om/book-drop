# BookDrop

A self-hostable web service for sending ebooks to a Kobo, Kindle, or Tolino through its built-in browser — no account, no cloud, no cables.

Live at [bookdrop.cc](https://bookdrop.cc) · Forked from [send2ereader](https://github.com/daniel-j/send2ereader) by [djazz](https://github.com/daniel-j)

## How it works

1. Open the site in your ereader's browser — it shows a 4-character key and a QR code.
2. Scan the QR code with your phone to open the upload page with the key pre-filled, or enter the key manually on any computer.
3. Pick one or more files and click **Upload and send**.
4. Download links appear on the ereader within seconds.

Supported formats: EPUB, MOBI, AZW3, PDF, CBZ, CBR, HTML, TXT, PNG, JPG.

Optional conversions (requires external tools — see below):

- EPUB → KEPUB (Kobo) — better typography and font control
- EPUB → AZW3 (Kindle) — Kindle doesn't support EPUB natively
- PDF margin cropping (via pdfCropMargins) — fills more of the small screen
- Update EPUB metadata from Google Books — patches title, author, publisher, etc. and shows a before/after diff on the download page (requires a `GOOGLE_BOOKS_API_KEY`)

Kindle conversions run through [calibre](https://calibre-ebook.com/) by default. calibre copes
with malformed EPUBs that KindleGen rejects — a dangling table-of-contents anchor, for
instance, makes KindleGen discard an otherwise finished book — and runs natively where
KindleGen, a 32-bit x86 binary, has to be emulated. [KindleGen](http://web.archive.org/web/*/http://kindlegen.s3.amazonaws.com/kindlegen*)
is still selectable via `KINDLE_CONVERTER`.

Kobo conversions stay on [kepubify](https://pgaskin.net/kepubify/) by default. It converts a
typical book in a fraction of a second, where calibre takes several, and Kobo books are most
of the conversions a busy instance does. calibre is selectable via `KOBO_CONVERTER` for books
kepubify rejects. PDF cropping has no calibre equivalent: calibre lays out PDFs it generates
rather than trimming the pages of an existing one.

## Running locally

### Prerequisites

- Node.js 26 or later
- pnpm 12 (see [pnpm installation](https://pnpm.io/installation), or `pnpm self-update` from pnpm 11.10+)
- _(Optional)_ [calibre](https://calibre-ebook.com/download) 8.0 or later, with `ebook-convert` in `PATH` — earlier versions cannot write KEPUB, if `KOBO_CONVERTER=calibre`
- _(Optional)_ [kepubify](https://pgaskin.net/kepubify/) in `PATH`
- _(Optional)_ [KindleGen](http://web.archive.org/web/*/http://kindlegen.s3.amazonaws.com/kindlegen*) in `PATH`, if `KINDLE_CONVERTER=kindlegen`
- _(Optional)_ [pdfCropMargins](https://github.com/abarker/pdfCropMargins) (`pip install pdfCropMargins`)

Missing tools are logged at startup and only break the conversion that needs them; sending
files still works.

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

`pnpm test` never runs a converter, so it passes on a machine with none installed. The
conversions themselves are covered separately, against the compiled output, skipping any
tool that is absent:

```sh
pnpm build && pnpm test:integration

# or against the image, where every tool is present:
docker run --rm -v "$PWD/tests:/usr/src/app/tests:ro" --entrypoint node \
  book-drop --test tests/integration/conversion.test.mjs
```

## Environment variables

Copy `.env.example` to `.env` to customise these values.

| Variable                     | Default      | Description                                                                                                                                                    |
| ---------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISABLE_HSTS`               | _(unset)_    | Set to `1` to disable HSTS and `upgrade-insecure-requests`. Use only when serving plain HTTP without a TLS-terminating reverse proxy.                          |
| `PORT`                       | `3001`       | HTTP port the server listens on                                                                                                                                |
| `UPLOAD_DIR`                 | `uploads`    | Directory for temporary file storage                                                                                                                           |
| `EXPIRE_DELAY_MS`            | `300000`     | Inactivity timeout per key (ms)                                                                                                                                |
| `MAX_EXPIRE_MS`              | `3600000`    | Hard maximum key lifetime (ms)                                                                                                                                 |
| `MAX_FILE_SIZE`              | `104857600`  | Upload size limit in bytes (100 MB)                                                                                                                            |
| `MAX_DISK_BYTES`             | `1073741824` | Total upload directory size cap in bytes (1 GB); uploads returning 507 when exceeded                                                                           |
| `MAX_FILES_PER_KEY`          | `5`          | Max files staged per session key; further uploads return 400                                                                                                   |
| `MAX_URLS_PER_KEY`           | `20`         | Max URLs staged per session key; further submissions return 400                                                                                                |
| `MAX_KEYS_PER_IP`            | `3`          | Max concurrent sessions per IP; further requests return 429                                                                                                    |
| `RATE_LIMIT_WINDOW_MS`       | `900000`     | Rate-limit window for `/generate` (ms)                                                                                                                         |
| `RATE_LIMIT_MAX`             | `20`         | Max key generations per window per IP                                                                                                                          |
| `LOG_LEVEL`                  | `info`       | Pino log level (`trace`, `debug`, `info`, `warn`, `error`)                                                                                                     |
| `UPLOAD_CLEANUP_INTERVAL_MS` | `3600000`    | How often the orphaned-file cleanup worker runs (ms); defaults to `MAX_EXPIRE_MS`                                                                              |
| `GOOGLE_BOOKS_API_KEY`       | _(unset)_    | Google Books API key for EPUB metadata enrichment; without it the API may rate-limit requests                                                                  |
| `KOBO_CONVERTER`             | `kepubify`   | Tool behind the "Kobo format" option: `kepubify` or `calibre`                                                                                                  |
| `KINDLE_CONVERTER`           | `calibre`    | Tool behind the "Kindle format" option: `calibre` or `kindlegen`                                                                                               |
| `KINDLE_OUTPUT_FORMAT`       | `azw3`       | Format calibre produces for Kindle: `azw3` or `mobi`. AZW3 suits modern Kindles; MOBI is for pre-2011 models. Ignored by `kindlegen`, which always writes MOBI |
| `MAX_CONCURRENT_CONVERSIONS` | _(`CPUS`)_   | Conversions allowed to run at the same time; the rest queue. Defaults to `CPUS`, capped at 4                                                                   |
| `MAX_QUEUED_CONVERSIONS`     | _(2× above)_ | Uploads allowed to wait for a slot; beyond this, uploads are refused with 503                                                                                  |
| `MAX_CONVERSION_WAIT_MS`     | `20000`      | How long a queued upload waits for a slot before being refused with 503                                                                                        |
| `CONVERSION_TIMEOUT_MS`      | `55000`      | How long one conversion may run before it is stopped and the upload answered with 504 (minimum 1000)                                                           |

## Docker

```sh
docker compose build
docker compose up -d
```

The service will be available at `http://localhost:3001` (or whatever PORT you use).

The image ships calibre, kepubify and KindleGen, so either converter can be switched with
an environment variable and no rebuild. calibre is by far the largest thing in it, adding
around 800 MB (measured at roughly 1.4 GB unpacked with it, 650 MB without, on arm64). To
trade flexibility for size, build with `--build-arg INSTALL_KINDLEGEN=0` to drop KindleGen,
or `--build-arg INSTALL_CALIBRE=0` to drop calibre, which then needs
`KINDLE_CONVERTER=kindlegen`.

Conversions are CPU-bound, so the container's CPU allowance is what decides how many books
it can convert at once. Running more of them than there are CPUs does not add throughput, it
just makes each one slower — and since the conversion timeout is wall clock, enough of them
at once makes them all fail together. They are therefore limited to
`MAX_CONCURRENT_CONVERSIONS` at a time; further uploads wait briefly and are then refused
with a 503 rather than being admitted to a queue they would time out in.

In practice there is one number to set. `CPUS` and `MEM_LIMIT` in `.env` size the
container, and `MAX_CONCURRENT_CONVERSIONS` defaults to `CPUS` so the limit follows the
hardware without being stated twice. Reckon on one CPU per concurrent conversion and
around 250 MB of memory for each, plus room for the app itself. On a 2-vCPU host:

```sh
CPUS=2.0
MEM_LIMIT=4g
```

Fewer CPUs than conversions still works — they simply share, and each takes
correspondingly longer. The default stops following `CPUS` above four, which is a memory
guard rather than a CPU one: cores tend to outnumber spare gigabytes, and four conversions
already want a gigabyte between them. Set `MAX_CONCURRENT_CONVERSIONS` explicitly to go
higher, and raise `MEM_LIMIT` with it. Whatever ends up in force is logged at startup
under `Conversion limits`.

Memory beyond that buys nothing: a spare 8 GB will not convert a book any faster than a
spare 8 MB. If uploads are being refused with a 503, the `queuedMs` and `durationMs` fields
in the conversion logs show whether the queue is too short or the CPU too slow.

Behind Cloudflare, the whole upload has to be answered within 100 seconds, or the
uploader sees Cloudflare's error page instead of BookDrop's message. The defaults keep the
worst case — a 15-second metadata lookup, `MAX_CONVERSION_WAIT_MS` in the queue, then
`CONVERSION_TIMEOUT_MS` converting — at 90 seconds, leaving room for the upload itself. If
conversions are timing out on a slow host, lower `MAX_QUEUED_CONVERSIONS` so fewer uploads
wait behind a slow one, rather than raising either timeout past that budget.

Serving plain HTTP (no reverse-proxy TLS)? Set `DISABLE_HSTS=1` — see env vars above.
