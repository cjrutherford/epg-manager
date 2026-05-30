#!/bin/sh
set -e

DB_DIR="${DB_DIR:-/app/data}"
PORT="${PORT:-3000}"
API_PORT="${API_PORT:-4000}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"

echo "┌─────────────────────────────────────────┐"
echo "│         EPG Manager Starting Up         │"
echo "├─────────────────────────────────────────┤"
echo "│  Port:         ${PORT}"
echo "│  API Port:     ${API_PORT}"
echo "│  Data Dir:     ${DB_DIR}"
echo "│  IPTV-ORG EPG: ${DB_DIR}/iptv-org-epg"
echo "│  Recordings:   ${DB_DIR}/recordings"
echo "└─────────────────────────────────────────┘"

# Validate iptv-org-epg exists (cloned during Docker build)
if [ ! -d "${DB_DIR}/iptv-org-epg" ]; then
    echo "WARNING: iptv-org-epg not found at ${DB_DIR}/iptv-org-epg"
    echo "Channel matching will not work. Rebuild the image."
fi

# Ensure recordings directory exists
mkdir -p "${DB_DIR}/recordings"

# Ensure writable runtime paths without recursively chowning the full bundled data tree.
# A full chown of /app/data is extremely expensive because the image includes
# a large iptv-org dataset there, and it delays the UI becoming available.
echo "Ensuring runtime paths are writable for epg user..."
chown epg:epg "${DB_DIR}" || true
chown -R epg:epg "${DB_DIR}/recordings" || true
if [ -e "/app/node_modules/axios/index.js" ]; then
    chown epg:epg "/app/node_modules/axios/index.js" || true
fi

# Best-effort fix for common host bind-mount cases without walking the whole tree.
for path in local.db local.db-wal local.db-shm playlist.m3u epg.xml; do
    if [ -e "${DB_DIR}/${path}" ]; then
        chown epg:epg "${DB_DIR}/${path}" || true
    fi
done

# Start SSR App in the background
if [ -f "client/dist/client/server/server.mjs" ]; then
    echo "Starting Angular SSR app on port ${PORT}..."
    su-exec epg node client/dist/client/server/server.mjs &
fi

echo "Starting Backend API on port ${API_PORT}..."
exec su-exec epg "$@"
