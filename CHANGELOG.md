# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-09

### Added

- Multi-source EPG processing with streaming XML parser for memory-efficient handling
- Intelligent channel matching from IPTV-ORG metadata:
  - Exact ID match
  - Exact name match
  - Fuzzy name matching
- Custom EPG grabbing from IPTV-ORG site scrapers with fallback support
- TVMaze metadata enrichment (no API key required)
  - Adds genres and ratings to EPG programs
  - 7-day cache to minimize API calls
- Auto-disable channels with consistent grab failures (5 consecutive failures)
- Channel numbering starting at 700
- Web UI for configuration and channel management
  - Playlist source selection
  - Channel enable/disable with bulk actions
  - Manual EPG override search
  - Real-time progress monitoring
- Scheduled automation (daily at 2 AM)
- Docker support with multi-stage build

### API Endpoints

- `GET /api/health` - Health check with uptime and counts
- `GET /api/stats` - Comprehensive statistics
- `GET /api/channels/auto-disabled` - View auto-disabled channels
- `POST /api/channels/re-enable` - Re-enable auto-disabled channels
- `GET /api/config` - Get configuration
- `POST /api/config` - Save configuration
- `GET /api/mapping` - Get channel mapping status
- `POST /api/override` - Set manual EPG override
- `GET /api/playlists` - Available playlist sources
- `POST /api/select-epg` - Trigger full sync
- `POST /api/grab` - Trigger missing channel grab
- `POST /api/rebuild-files` - Regenerate M3U and XML files
- `GET /playlist.m3u` - Download generated playlist
- `GET /epg.xml` - Download generated EPG guide
