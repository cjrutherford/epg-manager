# Tuner Daemon

A self-hosted, high-performance IPTV Playlist & EPG Management System featuring an automated DVR recording engine, live HLS stream proxying, intelligent channel matching, TVMaze metadata enrichment, and a modern Angular TV Watch client interface.

![Tuner Daemon Demo](demo-assets/epg-manager-demo.webp)

_Full workflow: Configure playlist & EPG sources → Real-time pipeline processing → Interactive channel mapping & overrides → High-performance TV Watch interface & DVR Manager_

---

## Key Features

### 📺 Live TV & Watch Interface
- **Modern Angular TV Player**: Premium dark mode TV watch interface built with fluid typography, custom themes, and glassmorphism styling.
- **High-Performance Virtualized EPG**: Sub-millisecond virtualized guide grid supporting 1,000+ channels and week-long EPG schedules without DOM lag.
- **Bulletproof HLS Streaming Engine**: Features a 5-minute stream keepalive engine, automated client heartbeat pings, HLS.js live sync, and watchdog stall auto-jump recovery.
- **Unified Lower-Third OSD Deck**: Cinematic bottom deck with live progress bar, episode metadata, category accents, and mascot branding.
- **Multiple Layout Modes**: Seamlessly toggle between Overlay, Side-by-Side, and Guide-Only popout views.

### 📹 DVR Recording System
- **FFmpeg Server-Side Recording Engine**: Record live streams to `.mp4` files with automatic multi-segment concatenating and error recovery.
- **Persistent Series Pass Rules**: Create `Series Rules` (`dvr_series_rules`) to automatically schedule upcoming episodes as new EPG data arrives.
- **Partial File Recovery**: Rebooting or interrupting the server automatically stitches existing `.part` files into playable partial video files rather than failing with 0 bytes.
- **Dynamic Stream URL Resolution**: Captures resolve live stream URLs from the database at execution time, preventing failures due to rotated token URLs.
- **Enabled Channel Protection**: Strict validation prevents scheduling recordings on disabled (`enabled = 0`) or hidden channels.
- **In-Browser Video Playback**: Stream and play completed server recordings directly inside the web browser or download them for offline viewing.
- **Browser Local Recordings**: Optional client-side Web Worker + IndexedDB recording for browser-only captures.

### ⚙️ EPG Processing & Playlist Management
- **Multi-Source EPG Processing**: Ingest guide data from IPTV-ORG site scrapers and global providers with priority ranking and automatic fallback.
- **Intelligent Channel Matching**: Combines exact TVG IDs, normalized string heuristics, fuzzy name matching, and manual XMLTV overrides.
- **TVMaze & TMDb Metadata Enrichment**: Real-time enrichment adding genres, ratings, episode numbers, descriptions, and high-resolution posters (cached for 7 days, no API key required!).
- **Failure Count Decay & Auto-Disabling**: Channels with 5 consecutive grab failures auto-disable, while server failure counters gracefully decay over 24-hour windows.
- **Persistent Background Jobs**: Background sync jobs (`sync_jobs`) log step progress via Server-Sent Events (SSE) and persist across server reboots.

---

## Quick Start

### Using Docker (Recommended)

```bash
# Build the Docker image
docker build -t tuner-daemon .

# Run container (exposing web client on 3000 and API on 4000)
docker run -d \
  -p 3000:3000 \
  -p 4000:4000 \
  -v $(pwd)/data:/app/data \
  --name tuner-daemon \
  tuner-daemon
```

Or using **Docker Compose**:

```bash
docker compose up --build -d
```

### Manual Setup

```bash
# Install dependencies
npm install

# Build both client and server
npm run build --prefix client
npm run build

# Start production server
npm start
```

---

## Configuration & Usage

1. Open `http://localhost:3000` in your browser.
2. Log in using the default admin password: `admin`.
3. Configure your M3U playlist source or select from pre-configured IPTV-ORG sources.
4. Set preferred language, priority order, and EPG duration.
5. Click **Start Full Sync** to ingest channels and guide data.

---

## API Reference

The table below is generated from `src/server.ts` by
`npx ts-node scripts/generate-api-docs.ts`, and a unit test fails if the two
disagree. Do not edit it by hand — it drifted badly when it was maintained that
way, listing an endpoint that never existed and omitting most of the ones that
did.

<!-- BEGIN API TABLE -->
| Endpoint | Method | Auth | Description |
| --- | --- | --- | --- |
| `/api/auth` | POST | No | — |
| `/api/auth/logout` | POST | No | — |
| `/api/auth/status` | GET | No | — |
| `/api/categories` | GET | No | Get distinct channel categories with counts |
| `/api/channel/:id/programs` | GET | No | Full schedule for one channel (next 24h) |
| `/api/channel/:id/stream` | GET | No | Redirect to the channel's stream URL |
| `/api/channels` | GET | Yes | Get all channels (lightweight list for admin UI) |
| `/api/channels-with-programs` | GET | Yes | with-programs - Returns channels with current/next program info |
| `/api/channels/:id` | PUT | Yes | Update a channel's settings |
| `/api/channels/auto-disabled` | GET | Yes | — |
| `/api/channels/favorites` | GET | No | Get all favorite channel IDs |
| `/api/channels/favorites` | POST | No | Add channel to favorites |
| `/api/channels/favorites/:id` | DELETE | No | Remove channel from favorites |
| `/api/channels/hidden` | GET | No | Get all hidden channel IDs |
| `/api/channels/hidden` | POST | No | Hide a channel |
| `/api/channels/hidden/:id` | DELETE | No | Unhide a channel |
| `/api/channels/re-enable` | POST | Yes | enable - Re-enable auto-disabled channels |
| `/api/channels/toggle` | POST | Yes | Enable/Disable channels (supports bulk) |
| `/api/config` | GET | Yes | — |
| `/api/config` | POST | Yes | Both paths, one handler — no chance of them drifting apart again. |
| `/api/dvr` | GET | Yes | — |
| `/api/dvr` | POST | Yes | — |
| `/api/dvr/:id` | DELETE | Yes | — |
| `/api/dvr/:id/retry` | POST | Yes | Put a failed or missed recording back on the schedule. Only meaningful while the window is still open, which the classifier decides rather than the caller. |
| `/api/dvr/series-rules` | GET | Yes | ── Series Rules API ── |
| `/api/dvr/series-rules/:id` | DELETE | Yes | — |
| `/api/dvr/series-rules/run` | POST | Yes | — |
| `/api/dvr/settings` | POST | Yes | Retention and padding. These were read by the recorder from the moment retention landed but there was nowhere to set them; the defaults were the only reachable values. |
| `/api/dvr/stop/:id` | POST | Yes | — |
| `/api/dvr/storage` | GET | Yes | Volume usage, plus the share taken by recordings |
| `/api/dvr/stream/:filename` | GET | No | browser playback |
| `/api/epg-files` | GET | Yes | — |
| `/api/epg-sources` | GET | Yes | — |
| `/api/epg-sources/:key/toggle` | POST | Yes | — |
| `/api/epg-sources/sync` | POST | Yes | — |
| `/api/grab` | POST | Yes | — |
| `/api/grab-logs` | GET | Yes | — |
| `/api/grab/sources` | GET | Yes | — |
| `/api/guide` | GET | No | EPG guide grid data for the streaming UI |
| `/api/has-data` | GET | No | data - Lightweight check: does the system have any channel/EPG data? No auth required so the dashboard can show the empty-state prompt before login. |
| `/api/health` | GET | No | Health check endpoint |
| `/api/iptv-org/playlists` | GET | Yes | org/playlists - List local iptv-org playlists |
| `/api/iptv-org/update-playlists` | POST | Yes | org/update-playlists - Force update iptv-org playlists |
| `/api/job-status` | GET | No | — |
| `/api/jobs` | POST | Yes | Ask for any background job by name, through the one door |
| `/api/jobs/queued/:id` | DELETE | Yes | Drop one job that has not started yet |
| `/api/mapping` | GET | Yes | Get all current channels and their match status |
| `/api/match/analysis` | GET | Yes | — |
| `/api/metadata/clear-cache` | POST | Yes | cache - Clear metadata cache |
| `/api/metadata/config` | GET | Yes | — |
| `/api/metadata/config` | POST | Yes | Save metadata configuration (no API key needed) |
| `/api/metadata/enrich` | POST | Yes | Manually trigger metadata enrichment |
| `/api/metadata/override` | POST | Yes | Save a metadata override |
| `/api/metadata/refresh-data` | POST | Yes | data - Force refresh IMDb datasets |
| `/api/metadata/search-tvmaze` | POST | Yes | tvmaze - Search for shows |
| `/api/metadata/stats` | GET | Yes | Get metadata enrichment statistics |
| `/api/override` | POST | Yes | Save a manual override |
| `/api/playlists` | DELETE | Yes | Remove a playlist URL |
| `/api/playlists` | GET | Yes | List all configured playlist URLs with channel counts |
| `/api/playlists` | POST | Yes | Add a new playlist URL and import channels |
| `/api/progress` | GET | No | — |
| `/api/rebuild-files` | POST | Yes | — |
| `/api/recordings` | GET | Yes | List all recordings |
| `/api/recordings/:filename` | DELETE | Yes | Delete a recording |
| `/api/recordings/active` | GET | Yes | Get currently active/upcoming recordings |
| `/api/recordings/system` | GET | No | Public read-only DVR listing for the watch UI |
| `/api/reset` | POST | Yes | Clear a declared scope, in place |
| `/api/reset/preview` | GET | Yes | What would this scope destroy? |
| `/api/search-epg` | GET | Yes | epg - Search available EPG channels |
| `/api/select-epg` | POST | Yes | — |
| `/api/settings` | GET | Yes | Kept as an alias of /api/config. It returned a different shape of the same table, which is how the two ever came to disagree. |
| `/api/settings` | POST | Yes | — |
| `/api/sources` | GET | Yes | — |
| `/api/sources` | POST | Yes | — |
| `/api/sources/:key` | DELETE | Yes | — |
| `/api/sources/:key/priority` | POST | Yes | — |
| `/api/sources/:key/toggle` | POST | Yes | — |
| `/api/sources/catalog` | GET | Yes | Built-in sources the UI can offer to add |
| `/api/sources/export` | GET | Yes | — |
| `/api/sources/import` | POST | Yes | — |
| `/api/sources/probe` | POST | Yes | — |
| `/api/stats` | GET | No | Comprehensive statistics |
| `/api/stream/keepalive/:id` | GET | No | — |
| `/api/sync` | POST | Yes | Clean alias for full pipeline trigger |
| `/api/sync-playlist` | POST | Yes | — |
| `/api/sync/cancel` | POST | Yes | Cancel any running sync process |
<!-- END API TABLE -->

### Generated Export Files

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/playlist.m3u` | GET | Download processed, re-numbered M3U playlist |
| `/epg.xml` | GET | Download merged XMLTV EPG guide with TVMaze metadata |
| `/files/streams/*` | GET | HLS segments for an active live stream |
| `/files/recordings/*` | GET | Completed DVR recording files |
| `/files/iptv-org-playlists/*` | GET | Cached iptv-org playlists (admin only) |

---

## Releases

Versions are set in one place and propagated. `package.json`, `client/package.json`
and the Android `build.gradle` used to say three different things — 0.1.0, 0.0.0
and 1.0 — which makes a bug report impossible to place against a build.

```bash
npm run version:set minor     # or patch, major, or an exact 1.4.0
npm run version:check v1.4.0  # verify every file agrees, without writing
```

Cutting a release:

1. Run the **Version** workflow (Actions → Version → Run workflow) and choose
   patch, minor or major. It runs the unit tests, sets the version in all three
   files, commits and pushes a `vX.Y.Z` tag.
2. The tag starts the **Release** workflow, which:
   - refuses to continue unless the tag matches every version in the repository
   - runs the unit and end-to-end suites
   - builds and pushes a multi-architecture image to GHCR, and to Docker Hub if
     `DOCKERHUB_USERNAME` is configured
   - builds the `mobile` and `tv` Android installers
   - publishes a GitHub Release with the installers and `docker-compose.yml`

Android builds are debug-signed by default, which installs by side-load without
anyone holding a release keystore. Set `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` to
produce signed release builds instead.

To build the installers locally:

```bash
npm run build:apk    # uses JAVA_HOME, or the JDK vendored under client/
```

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DB_DIR` | `/app/data` | Path to SQLite database (`local.db`), stream cache, and recordings folder |
| `PORT` | `3000` | HTTP port for Angular frontend & static web server |
| `API_PORT` | `4000` | HTTP port for backend REST API server |
| `ADMIN_PASSWORD` | `admin` | Password required for administrative actions |

---

## Development & Testing

```bash
# Run backend in dev mode with auto-reload
npm run dev

# Run Angular client in dev mode
cd client && npm run start

# Execute backend unit test suite (189+ tests)
npm test

# Run full end-to-end Playwright tests
npm run test:e2e

# Run 5-minute stream stability E2E test
npx playwright test e2e/stream-stability.spec.ts
```

---

## License

MIT
