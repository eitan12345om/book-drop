# ── Stage 0: kepubify ─────────────────────────────────────────────────────────
FROM golang:alpine AS kepubify-builder
RUN go install github.com/pgaskin/kepubify/v4/cmd/kepubify@v4.0.4

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:lts-slim AS builder

RUN corepack enable pnpm

WORKDIR /build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN HUSKY=0 pnpm install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./
COPY client ./client

RUN pnpm build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:lts-slim

WORKDIR /usr/src/app

# ── kepubify ────────────────────────────────────────────────────────────────
COPY --from=kepubify-builder /go/bin/kepubify /usr/local/bin/kepubify

# ── kindlegen + pdfCropMargins ──────────────────────────────────────────────
# kindlegen: 32-bit i386 binary (needs libc6:i386 multiarch + curl to fetch).
# pdfCropMargins: pipx-managed venv; --only-binary=pymupdf avoids a source build.
ENV PIPX_HOME=/opt/pipx
ENV PIPX_BIN_DIR=/usr/local/bin
RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        curl ca-certificates libc6:i386 pipx && \
    curl -fsSL https://github.com/zzet/fp-docker/raw/f2b41fb0af6bb903afd0e429d5487acc62cb9df8/kindlegen_linux_2.6_i386_v2_9.tar.gz -o kindlegen.tar.gz && \
    echo "9828db5a2c8970d487ada2caa91a3b6403210d5d183a7e3849b1b206ff042296  kindlegen.tar.gz" | sha256sum -c - && \
    mkdir kindlegen && tar xf kindlegen.tar.gz -C kindlegen && \
    install -m 0755 kindlegen/kindlegen /usr/local/bin/kindlegen && \
    rm -rf kindlegen kindlegen.tar.gz && \
    pipx install pdfCropMargins --pip-args="--only-binary=pymupdf" && \
    rm -rf /var/lib/apt/lists/*

# ── Production dependencies ─────────────────────────────────────────────────
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ── Copy build artifacts ─────────────────────────────────────────────────────
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/client/public ./client/public
COPY client/views ./client/views

# ── Runtime setup ───────────────────────────────────────────────────────────
RUN mkdir uploads && \
    groupadd --system appgroup && \
    useradd --system --gid appgroup --home-dir /usr/src/app appuser && \
    chown -R appuser:appgroup /usr/src/app
USER appuser

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/health || exit 1
CMD ["node", "dist/server.js"]
