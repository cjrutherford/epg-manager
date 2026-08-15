# ── Stage 1: Build Server ────────────────────
FROM node:20-alpine AS server-builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ── Stage 2: Build Client ────────────────────
FROM node:20-alpine AS client-builder

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/tsconfig*.json ./
COPY client/angular.json ./
COPY client/server.ts ./server.ts
COPY client/src ./src
RUN npx ng build

# ── Stage 3: Build iptv-org EPG ──────────────
FROM node:20-alpine AS epg-builder

WORKDIR /tmp

RUN apk add --no-cache git && \
    git clone --depth 1 https://github.com/iptv-org/epg.git iptv-org-epg && \
    cd iptv-org-epg && npm install && \
    rm -rf .git

# ── Stage 4: Production ─────────────────────
FROM node:20-alpine

RUN apk add --no-cache \
    ffmpeg \
    curl \
    git \
    tini \
    su-exec \
    unzip

WORKDIR /app

# Create non-root user
RUN addgroup -S epg && adduser -S epg -G epg

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server
COPY --from=server-builder /app/dist ./dist

# Compiled client
COPY --from=client-builder /app/client/dist ./client/dist

# Client node_modules needed for Angular SSR server runtime (iconv-lite etc.)
# The SSR server at dist/client/server/ resolves modules up to dist/client/
COPY --from=client-builder /app/client/node_modules ./client/node_modules
RUN ln -s /app/client/node_modules /app/client/dist/client/node_modules

# iptv-org EPG data (pre-built)
COPY --chown=epg:epg --from=epg-builder /tmp/iptv-org-epg ./data/iptv-org-epg

# Startup script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Data directory with proper permissions
ENV DB_DIR=/app/data
ENV PORT=3000
ENV API_PORT=4000

RUN mkdir -p /app/data/recordings && \
    chown epg:epg /app/data /app/data/recordings

EXPOSE 3000 4000

# Both processes must answer. Probing only the API meant a dead SSR client —
# the entire user interface — left the container reporting healthy.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS "http://localhost:${API_PORT:-4000}/api/health" >/dev/null \
     && curl -fsS -o /dev/null "http://localhost:${PORT:-3000}/" \
     || exit 1

ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", "dist/server.js"]
