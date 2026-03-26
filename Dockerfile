# ── Stage 0: kepubify ─────────────────────────────────────────────────────────
FROM golang:alpine AS kepubify-builder
RUN go install github.com/pgaskin/kepubify/v4/cmd/kepubify@v4.0.4

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:lts-alpine AS builder

RUN corepack enable pnpm

WORKDIR /build

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./
COPY client/scss ./client/scss

RUN pnpm build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:lts-alpine

WORKDIR /usr/src/app

# ── kepubify ────────────────────────────────────────────────────────────────
COPY --from=kepubify-builder /go/bin/kepubify /usr/local/bin/kepubify

# ── kindlegen ───────────────────────────────────────────────────────────────
RUN apk add --no-cache curl && \
    curl -fsSL https://github.com/zzet/fp-docker/raw/f2b41fb0af6bb903afd0e429d5487acc62cb9df8/kindlegen_linux_2.6_i386_v2_9.tar.gz -o kindlegen_linux_2.6_i386_v2_9.tar.gz && \
    echo "9828db5a2c8970d487ada2caa91a3b6403210d5d183a7e3849b1b206ff042296  kindlegen_linux_2.6_i386_v2_9.tar.gz" | sha256sum -c - && \
    mkdir kindlegen && \
    tar xf kindlegen_linux_2.6_i386_v2_9.tar.gz --directory kindlegen && \
    cp kindlegen/kindlegen /usr/local/bin/kindlegen && \
    chmod +x /usr/local/bin/kindlegen && \
    rm -rf kindlegen kindlegen_linux_2.6_i386_v2_9.tar.gz

# ── pdfCropMargins ──────────────────────────────────────────────────────────
RUN apk add --no-cache pipx
ENV PIPX_HOME=/opt/pipx
ENV PIPX_BIN_DIR=/usr/local/bin
RUN pipx install pdfCropMargins

# ── Production dependencies ─────────────────────────────────────────────────
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ── Copy build artifacts ─────────────────────────────────────────────────────
COPY --from=builder /build/dist ./dist
COPY client/public ./client/public
COPY client/views ./client/views

# ── Runtime setup ───────────────────────────────────────────────────────────
RUN mkdir uploads && \
    addgroup -S appgroup && adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /usr/src/app
USER appuser

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1
CMD ["node", "dist/server.js"]
