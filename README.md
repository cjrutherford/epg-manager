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

### Core & Pipeline APIs

| Endpoint | Method | Auth | Description |
| :--- | :---: | :---: | :--- |
| `/api/health` | GET | No | System health check, uptime, and database counts |
| `/api/stats` | GET | No | Detailed statistics on channels, programs, and grabber status |
| `/api/has-data` | GET | No | Checks if initial playlist/EPG sync data exists |
| `/api/job-status` | GET | No | Returns active and historical background sync job state |
| `/api/job-cancel` | POST | Yes | Requests cancellation of active background sync pipeline |
| `/api/auth` | POST | No | Authenticates admin password and issues Bearer token |

### Channel & Mapping APIs

| Endpoint | Method | Auth | Description |
| :--- | :---: | :---: | :--- |
| `/api/channels` | GET | Yes | List all channels with matched EPG mappings |
| `/api/channels/toggle` | POST | Yes | Bulk enable/disable specific channels |
| `/api/override` | POST | Yes | Save manual XMLTV EPG override for a channel |
| `/api/channels/auto-disabled` | GET | Yes | View channels auto-disabled due to grab failures |
| `/api/channels/re-enable` | POST | Yes | Re-enable auto-disabled channels |

### DVR & Streaming APIs

| Endpoint | Method | Auth | Description |
| :--- | :---: | :---: | :--- |
| `/api/dvr` | GET | Yes | List all scheduled, recording, and completed server DVR recordings |
| `/api/dvr` | POST | Yes | Schedule a new recording (validates channel `enabled = 1`) |
| `/api/dvr/stop/:id` | POST | Yes | Stop an active server recording |
| `/api/dvr/:id` | DELETE | Yes | Cancel or delete a scheduled/completed recording |
| `/api/dvr/storage` | GET | Yes | Check disk space usage and total volume capacity |
| `/api/dvr/stream/:filename` | GET | No | Stream completed MP4 recording file for in-browser playback |
| `/api/dvr/series-rules` | GET | Yes | List active automated Series Pass rules |
| `/api/dvr/series-rules/:id` | DELETE | Yes | Delete a Series Pass rule |
| `/api/stream/keepalive/:id` | GET | No | Extends stream idle timeout for active live HLS proxy session |
| `/api/recordings/system` | GET | No | Public read-only system recording list for Watch UI |

### Generated Export Files

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/playlist.m3u` | GET | Download processed, re-numbered M3U playlist |
| `/epg.xml` | GET | Download merged XMLTV EPG guide with TVMaze metadata |
| `/files/*` | GET | Direct access to data directory files and HLS stream segments |

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
