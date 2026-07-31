# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-31

### Added
- **DVR System Overhaul**:
  - Persistent Series Pass Rules (`dvr_series_rules`) engine auto-scheduling upcoming episodes across EPG updates.
  - Boot partial file recovery (`cleanupStaleRecordings()`) merging `.part` files into playable MP4 media on server restarts.
  - Dynamic stream URL resolution at recording start time to prevent stale stream failures.
  - Strict channel status validation (`enabled !== 0`) across client schedule modals and backend `POST /api/dvr`.
  - In-browser playback streaming endpoint (`GET /api/dvr/stream/:filename`) and HTML5 video modal for completed server recordings.
  - Channel text search filter in DVR schedule modal for large playlists (1,000+ channels).

- **Bulletproof Live Streaming & Keepalive Engine**:
  - Increased `StreamManager` inactive stream cleanup timeout from 60s to 5 minutes (`300000ms`).
  - Added `/api/stream/keepalive/:id` endpoint and client-side 10s heartbeat ping interval in `WatchComponent`.
  - HLS.js live streaming configuration (`liveSyncDurationCount`, `liveDurationInfinity`) and watchdog stall recovery for continuous live playback.

- **Watch TV Interface & UI Polish**:
  - High-performance virtualized EPG grid supporting 1,000+ channels with sub-millisecond scrolling.
  - Unified lower-third OSD deck with live program progress bar, episode numbers, and category accents.
  - Hover-driven "Guide Layout" popout menu in lower third deck with Overlay, Side-by-Side, and Guide-Only options.
  - Custom mascot branding for app headers and fallback channel logos.
  - Expanded 5-theme color engine (Noir, Neon Cyberpunk, Arctic Ice, Sunset Gold, Emerald Synth).

- **Reliability Infrastructure & Background Pipeline**:
  - Smart Axios HTTP retry engine with exponential backoff and random jitter for HTTP `429` rate limits and network drops.
  - Persistent SQLite `sync_jobs` queue tracking job status, progress snapshots, and boot recovery.
  - Channel grab failure count decay over 24-hour windows.

---

## [0.1.0] - 2026-01-09

### Added
- Multi-source EPG processing with streaming XML parser for memory-efficient handling
- Intelligent channel matching from IPTV-ORG metadata
- Custom EPG grabbing from IPTV-ORG site scrapers with fallback support
- TVMaze metadata enrichment (genres, ratings, 7-day cache)
- Auto-disable channels with consistent grab failures (5 consecutive failures)
- Channel numbering starting at 700
- Web UI for configuration and channel management
- Scheduled automation (daily at 2 AM)
- Docker support with multi-stage build
