# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:lts-alpine AS builder

RUN corepack enable pnpm

WORKDIR /build

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

RUN pnpm build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:lts-alpine

WORKDIR /usr/src/app

# ── kepubify ────────────────────────────────────────────────────────────────
RUN apk add --no-cache curl && \
    KEPUBIFY_VERSION=v4.0.4 && \
    curl -fsSL "https://github.com/pgaskin/kepubify/releases/download/${KEPUBIFY_VERSION}/kepubify-linux-64bit" -o /usr/local/bin/kepubify && \
    curl -fsSL "https://github.com/pgaskin/kepubify/releases/download/${KEPUBIFY_VERSION}/SHA256SUMS" -o SHA256SUMS && \
    grep "kepubify-linux-64bit$" SHA256SUMS | sha256sum -c - && \
    chmod +x /usr/local/bin/kepubify && \
    rm SHA256SUMS

# ── kindlegen ───────────────────────────────────────────────────────────────
RUN curl -fsSL https://github.com/zzet/fp-docker/raw/f2b41fb0af6bb903afd0e429d5487acc62cb9df8/kindlegen_linux_2.6_i386_v2_9.tar.gz -o kindlegen_linux_2.6_i386_v2_9.tar.gz && \
    echo "9828db5a2c8970d487ada2caa91a3b6403210d5d183a7e3849b1b206ff042296  kindlegen_linux_2.6_i386_v2_9.tar.gz" | sha256sum -c - && \
    mkdir kindlegen && \
    tar xf kindlegen_linux_2.6_i386_v2_9.tar.gz --directory kindlegen && \
    cp kindlegen/kindlegen /usr/local/bin/kindlegen && \
    chmod +x /usr/local/bin/kindlegen && \
    rm -rf kindlegen kindlegen_linux_2.6_i386_v2_9.tar.gz

# ── pdfCropMargins ──────────────────────────────────────────────────────────
RUN apk add --no-cache pipx
ENV PATH="$PATH:/root/.local/bin"
RUN pipx install pdfCropMargins

# ── Production dependencies ─────────────────────────────────────────────────
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Copy build artifacts ─────────────────────────────────────────────────────
COPY --from=builder /build/dist ./dist
COPY client/public ./client/public

# ── Runtime setup ───────────────────────────────────────────────────────────
RUN mkdir uploads && \
    addgroup -S appgroup && adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /usr/src/app
USER appuser

EXPOSE 3001
CMD ["node", "dist/server.js"]
