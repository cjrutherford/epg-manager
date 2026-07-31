# Tuner Daemon — Client Interface

The frontend client for **Tuner Daemon** is built with **Angular 17** (Standalone Components, OnPush Change Detection, Signals) and **Vanilla CSS** featuring a modern dark-mode aesthetic, custom theme engine, glassmorphism UI elements, and fluid typography.

## Key Features & Architecture

### 1. Watch TV Interface (`src/app/watch/`)
- **Cinematic Media Player**: Integrated HLS.js video player with automated stall recovery, watchdog monitoring, and low-latency live synchronization.
- **Virtualized EPG Grid**: Sub-millisecond virtual scrolling guide grid supporting thousands of channels and multi-day EPG data.
- **Unified Bottom Bar (OSD)**: Merged channel info, now-playing title, episode metadata, ratings, and live progress bar into a unified TV lower third deck.
- **Dynamic Layout Switcher**: Popout dropdown menu allowing users to switch between **Overlay**, **Side-by-Side**, and **Guide-Only** layouts.
- **Stream Keepalive Heartbeat**: Sends automatic background heartbeats (`/api/stream/keepalive/:id`) to ensure live stream processes remain active.

### 2. Admin Dashboard (`src/app/admin/`)
- **Dashboard**: System health, active sync jobs, channel mapping stats, and quick actions.
- **Channel Manager**: Searchable channel list with bulk enable/disable toggles, EPG override modal, and group filter.
- **DVR Manager**: System DVR management, Series Pass rules, storage gauge, and in-browser playback for completed `.mp4` recordings.
- **Settings**: Source selection (IPTV-ORG/EPGShare), priority ordering, language filters, and automated schedule configuration.
- **Diagnostics**: Technical stream statistics overlay tracking resolution, bitrate, codecs, buffer depth, and dropped frames.

### 3. Services & State Management (`src/app/services/`)
- `api.service.ts`: REST API client for backend communication.
- `sse.service.ts`: Server-Sent Events subscriber for realtime sync progress, log streaming, and automatic reconnection.
- `theme.service.ts`: Manages color token themes (Noir Default, Neon Cyberpunk, Arctic Ice, Sunset Gold, Emerald Synth).
- `client-recording.service.ts`: Web Worker + IndexedDB service for in-browser local recording capture.

---

## Development Commands

```bash
# Install dependencies
npm install

# Start Angular development server (http://localhost:4200)
npm run start

# Build production bundle
npm run build
```
