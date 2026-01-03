# EPG Manager

A self-hosted EPG (Electronic Program Guide) management system that matches IPTV playlists with guide data from multiple sources.

## Features

- **Multi-Source EPG Processing**: Fetch guide data from IPTV-ORG site scrapers with automatic fallback
- **Intelligent Channel Matching**: Uses IPTV-ORG metadata, fuzzy matching, and manual overrides
- **Custom Grabber Integration**: Automatically fetches guide data for channels from 1000+ sites
- **TVMaze Metadata Enrichment**: Enhance EPG data with ratings and genres (no API key required!)
- **Auto-Disable Failing Channels**: Channels with consistent grab failures are automatically disabled
- **Channel Numbering**: Channels are numbered starting at 700 for easy organization
- **Automated Updates**: Scheduled cron job updates playlists and EPG data daily at 2 AM
- **Web UI**: Configuration interface for playlist/EPG source selection and channel mapping

## Quick Start

### Using Docker (Recommended)

```bash
docker build -t epg-manager .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data --name epg-manager epg-manager
```

### Manual Setup

```bash
npm install
npm run build
npm start
```

## Configuration

1. Open `http://localhost:3000` in your browser
2. Select a playlist source (e.g., IPTV-ORG country lists)
3. Configure preferred language and EPG duration (days)
4. Click "Save Configuration" to begin processing

### TVMaze Metadata Enrichment

Enhance your EPG with ratings and genres from TVMaze - **no API key required!**

1. In the EPG Manager web UI, enable "Metadata Enrichment"
2. That's it! The system will query TVMaze API in real-time for each unique show title

The enrichment process will:

- Match program titles to TVMaze shows
- Add ratings and genres to programs
- Cache results for 7 days to minimize API calls
- Rate limit requests to respect TVMaze's API

## API Endpoints

### Core Endpoints

| Endpoint               | Method | Description                       |
| ---------------------- | ------ | --------------------------------- |
| `/api/config`          | GET    | Get current configuration         |
| `/api/config`          | POST   | Save configuration                |
| `/api/playlists`       | GET    | List available playlist sources   |
| `/api/mapping`         | GET    | Get channel mapping status        |
| `/api/override`        | POST   | Set manual EPG override           |
| `/api/channels/toggle` | POST   | Enable/disable channels           |
| `/api/select-epg`      | POST   | Trigger full sync                 |
| `/api/grab`            | POST   | Trigger grab for missing channels |
| `/api/rebuild-files`   | POST   | Regenerate M3U and XML files      |

### Production Endpoints

| Endpoint                      | Method | Description                         |
| ----------------------------- | ------ | ----------------------------------- |
| `/api/health`                 | GET    | Health check with uptime and counts |
| `/api/stats`                  | GET    | Comprehensive statistics            |
| `/api/channels/auto-disabled` | GET    | View auto-disabled channels         |
| `/api/channels/re-enable`     | POST   | Re-enable auto-disabled channels    |

### Metadata Endpoints

| Endpoint                    | Method | Description                            |
| --------------------------- | ------ | -------------------------------------- |
| `/api/metadata/config`      | GET    | Get metadata enrichment configuration  |
| `/api/metadata/config`      | POST   | Save metadata enrichment configuration |
| `/api/metadata/enrich`      | POST   | Trigger manual metadata enrichment     |
| `/api/metadata/stats`       | GET    | Get enrichment statistics              |
| `/api/metadata/clear-cache` | POST   | Clear metadata cache                   |

### File Endpoints

| Endpoint        | Method | Description                          |
| --------------- | ------ | ------------------------------------ |
| `/playlist.m3u` | GET    | Download generated playlist          |
| `/epg.xml`      | GET    | Download generated EPG guide         |
| `/files/*`      | GET    | Static file access to data directory |

## Generated Files

- `data/playlist.m3u` - Filtered playlist with matched channels
- `data/epg.xml` - Merged EPG guide with TVMaze metadata (if enabled)
- `data/local.db` - SQLite database with settings, mappings, and metadata cache

## Environment Variables

| Variable | Default     | Description                                |
| -------- | ----------- | ------------------------------------------ |
| `DB_DIR` | `/app/data` | Directory for database and generated files |
| `PORT`   | `3000`      | HTTP server port                           |

## Channel Numbering

Channels are automatically numbered starting at **700**. This provides a dedicated range that doesn't conflict with typical OTA or cable channel numbers.

## Auto-Disable Feature

Channels that fail EPG grabbing **5 consecutive times** across all available sites are automatically disabled. You can:

- View disabled channels via `GET /api/channels/auto-disabled`
- Re-enable channels via `POST /api/channels/re-enable`
- Manually enable channels in the web UI

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Testing

The project includes comprehensive unit tests (Jest) and end-to-end tests (Playwright).

### Unit Tests

```bash
# Run all unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

**Test coverage:**

- `src/services/__tests__/metadata.test.ts` - Title normalization (25 tests)
- `src/services/__tests__/epg.test.ts` - ID/name normalization, XML escaping (24 tests)

### End-to-End Tests

```bash
# Install Playwright browsers (first time only)
npx playwright install chromium

# Run all e2e tests
npm run test:e2e

# Run with visible browser
npm run test:e2e -- --headed

# Run specific test file
npm run test:e2e -- e2e/api.spec.ts
```

**E2E test coverage:**

- `e2e/api.spec.ts` - All API endpoints (11 tests)
- `e2e/ui.spec.ts` - Web UI interactions (14 tests)

> **Note:** E2E tests automatically start the server on port 3101 using a separate `test-data` directory.

## License

MIT
