FROM golang:alpine AS kepubify-builder
RUN go install github.com/pgaskin/kepubify/v5@v5.0.0

# No Linux arm64 release binary is published, so it is built from the pinned crate.
FROM rust:alpine AS kindling-builder
ARG KINDLING_VERSION=0.46.2
RUN apk add --no-cache musl-dev && \
    CARGO_PROFILE_RELEASE_STRIP=true \
    cargo install kindling-mobi --version "${KINDLING_VERSION}" --locked

FROM node:26-slim AS builder

# Keep in sync with "packageManager" in package.json.
COPY --from=ghcr.io/pnpm/pnpm:12.16.1 /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done

WORKDIR /build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN HUSKY=0 pnpm install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./
COPY client ./client

RUN pnpm build

FROM node:26-slim

WORKDIR /usr/src/app

COPY --from=kepubify-builder /go/bin/kepubify /usr/local/bin/kepubify
COPY --from=kindling-builder /usr/local/cargo/bin/kindling-cli /usr/local/bin/kindling-cli

# kindlegen is kept as a fallback (KINDLE_CONVERTER=kindlegen); it is a 32-bit i386
# binary and needs libc6:i386.
# curl must stay installed: HEALTHCHECK uses it.
# --only-binary=pymupdf avoids a source build of pdfCropMargins' dependency.
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

COPY --from=ghcr.io/pnpm/pnpm:12.16.1 /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/client/public ./client/public
COPY client/views ./client/views

# The app user can write only its uploads and home, not the code it runs.
RUN mkdir uploads && \
    groupadd --system appgroup && \
    useradd --system --gid appgroup --create-home --home-dir /home/appuser appuser && \
    chown appuser:appgroup uploads
USER appuser

ARG BOOKDROP_VERSION=dev
ENV BOOKDROP_VERSION=$BOOKDROP_VERSION

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/health || exit 1
CMD ["node", "dist/server.js"]
