# calibre is the default converter for both Kobo and Kindle. The single-purpose tools
# it replaces are still installed by default so KOBO_CONVERTER / KINDLE_CONVERTER can be
# switched back at runtime; build with INSTALL_LEGACY_TOOLS=0 to drop them, or
# INSTALL_CALIBRE=0 for an image that only has the originals.
ARG INSTALL_CALIBRE=1
ARG INSTALL_LEGACY_TOOLS=1
ARG CALIBRE_VERSION=9.12.0

# ── Stage 0: kepubify ─────────────────────────────────────────────────────────
FROM golang:alpine AS kepubify-builder
RUN go install github.com/pgaskin/kepubify/v4/cmd/kepubify@v4.0.4

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
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

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:26-slim

WORKDIR /usr/src/app

ARG INSTALL_CALIBRE
ARG INSTALL_LEGACY_TOOLS
ARG CALIBRE_VERSION

# ── kepubify ────────────────────────────────────────────────────────────────
# Staged via /tmp because COPY cannot be made conditional on a build argument.
COPY --from=kepubify-builder /go/bin/kepubify /tmp/kepubify

# ── pdfCropMargins ──────────────────────────────────────────────────────────
# No calibre equivalent exists: calibre lays out PDFs it generates rather than
# trimming the page boxes of an existing one, so this tool is always installed.
# pipx-managed venv; --only-binary=pymupdf avoids a source build.
ENV PIPX_HOME=/opt/pipx
ENV PIPX_BIN_DIR=/usr/local/bin
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates pipx && \
    pipx install pdfCropMargins --pip-args="--only-binary=pymupdf" && \
    rm -rf /var/lib/apt/lists/*

# ── kindlegen + kepubify (legacy, optional) ─────────────────────────────────
# kindlegen: 32-bit i386 binary, so it needs libc6:i386 multiarch.
RUN set -eux; \
    if [ "${INSTALL_LEGACY_TOOLS}" = "1" ]; then \
      install -m 0755 /tmp/kepubify /usr/local/bin/kepubify; \
      dpkg --add-architecture i386; \
      apt-get update; \
      apt-get install -y --no-install-recommends libc6:i386; \
      curl -fsSL https://github.com/zzet/fp-docker/raw/f2b41fb0af6bb903afd0e429d5487acc62cb9df8/kindlegen_linux_2.6_i386_v2_9.tar.gz -o kindlegen.tar.gz; \
      echo "9828db5a2c8970d487ada2caa91a3b6403210d5d183a7e3849b1b206ff042296  kindlegen.tar.gz" | sha256sum -c -; \
      mkdir kindlegen && tar xf kindlegen.tar.gz -C kindlegen; \
      install -m 0755 kindlegen/kindlegen /usr/local/bin/kindlegen; \
      rm -rf kindlegen kindlegen.tar.gz /var/lib/apt/lists/*; \
    fi; \
    rm -f /tmp/kepubify

# ── calibre (optional) ──────────────────────────────────────────────────────
# Only the libraries libQt6Gui declares at load time are needed; calibre's own Qt,
# Python and ICU are bundled. QtWebEngine is not required because we never produce
# PDF output. QT_QPA_PLATFORM keeps Qt from looking for a display.
RUN set -eux; \
    if [ "${INSTALL_CALIBRE}" = "1" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        xz-utils libxcb1 libegl1 libglx0 libopengl0 libfontconfig1 libfreetype6 \
        libx11-6 libxkbcommon0; \
      arch="$(dpkg --print-architecture)"; \
      case "$arch" in \
        amd64) calibre_arch=x86_64; sha=7cf8f5334503ac8f74b9e0b038c17df2dd2827405133ae7118f3aeb38e07ad76 ;; \
        arm64) calibre_arch=arm64;  sha=a7942d5d4a40ab02a4bf7503b058e17298b1fcff4491b460cf4e0a594c0f9197 ;; \
        *) echo "calibre publishes no binary for $arch" >&2; exit 1 ;; \
      esac; \
      curl -fsSL "https://download.calibre-ebook.com/${CALIBRE_VERSION}/calibre-${CALIBRE_VERSION}-${calibre_arch}.txz" -o calibre.txz; \
      echo "${sha}  calibre.txz" | sha256sum -c -; \
      mkdir -p /opt/calibre; \
      tar xf calibre.txz -C /opt/calibre; \
      rm calibre.txz; \
      ln -sf /opt/calibre/ebook-convert /usr/local/bin/ebook-convert; \
      rm -rf /var/lib/apt/lists/*; \
    fi
ENV QT_QPA_PLATFORM=offscreen

# ── Production dependencies ─────────────────────────────────────────────────
COPY --from=ghcr.io/pnpm/pnpm:12.16.1 /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done

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

ARG BOOKDROP_VERSION=dev
ENV BOOKDROP_VERSION=$BOOKDROP_VERSION

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/health || exit 1
CMD ["node", "dist/server.js"]
