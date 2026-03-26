#!/bin/sh
set -e

DB_DIR="${DB_DIR:-/app/data}"
PORT="${PORT:-3000}"
SSR_PORT="${SSR_PORT:-4000}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"

echo "┌─────────────────────────────────────────┐"
echo "│         EPG Manager Starting Up         │"
echo "├─────────────────────────────────────────┤"
echo "│  Port:         ${PORT}"
echo "│  SSR Port:     ${SSR_PORT}"
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

# Ensure database directory writable
if [ ! -w "${DB_DIR}" ]; then
    echo "WARNING: ${DB_DIR} is not writable. Check volume permissions."
fi

exec "$@"
