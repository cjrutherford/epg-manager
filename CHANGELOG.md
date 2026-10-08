# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0](https://github.com/cjrutherford/epg-manager/compare/v0.3.1...v0.4.0) (2026-10-08)


### Features

* add in-app update notifications, release workflows, and compose image pinning ([e13241e](https://github.com/cjrutherford/epg-manager/commit/e13241e7e5b34bc736500d2fbdaeca73aa9466ca))


### Bug Fixes

* **api:** correct xmltv timestamp formatting in channel programs and guide queries ([32da3ae](https://github.com/cjrutherford/epg-manager/commit/32da3aeab912d5e76dd765794c182ce8aa730faa))
* **ci:** resolve e2e fixture race condition, retry delays, and edge build platform ([80fce31](https://github.com/cjrutherford/epg-manager/commit/80fce31d31a3ea08b5fccd616e78b388d5c00511))
* **e2e:** decouple reset project order and eliminate job-queue dashboard race ([79e1ec3](https://github.com/cjrutherford/epg-manager/commit/79e1ec3e142a83f1c1d0651241d4ad2008541d45))
* **e2e:** fix dvr manual schedule timing, watch overlay controls, and job queue dashboard race ([dae3cdc](https://github.com/cjrutherford/epg-manager/commit/dae3cdc7e762e9f33c33ea84d609afad4b5664ab))
* proxy and serve playlist and epg files from advertised and legacy paths ([ea29333](https://github.com/cjrutherford/epg-manager/commit/ea293337261dd08065ccb18bee40e6a8027edb0f))
* sync disabled channels between settings and list ([827b485](https://github.com/cjrutherford/epg-manager/commit/827b485c818f291881f7f45af4fc593d785d6408))

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
