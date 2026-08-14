# Tuner Daemon — Hardening Workplan

Single source of truth for the remediation effort. Consolidates the process audit, the UI &
source-retrieval audit, and the source acquisition architecture into one tracked backlog.

**Status:** Wave 4 in progress — 18 of 26 done, S16c paused
**Suite score at baseline:** 2.5 / 5 (process) · 2.3 / 5 (UI)
**Last updated:** 2026-08-13

---

## How this is scored

Each process was scored 1–5 on three axes and combined into a weighted composite.

| Audit | Axes | Weights |
| :--- | :--- | :--- |
| Process | Consistency · Survivability · User-friendliness | 0.30 / 0.40 / 0.30 |
| UI | Truthfulness · Task completion · Craft & access | 0.40 / 0.35 / 0.25 |

Bands: **Critical** < 2.0 · **High** 2.0–2.4 · **Medium** 2.5–3.2 · **Sound** > 3.2

---

## Baseline scores

### Processes (17)

| Process | C | S | U | Score | Band |
| :--- | :-: | :-: | :-: | :-: | :--- |
| Series Pass automation | 1 | 1 | 1 | 1.0 | Critical |
| Authentication & session | 2 | 1 | 2 | 1.6 | Critical |
| System reset | 3 | 1 | 2 | 1.9 | Critical |
| DVR recording engine | 2 | 2 | 2 | 2.0 | High |
| Live stream proxy | 3 | 1 | 3 | 2.2 | High |
| Recording storage & delivery | 2 | 2 | 3 | 2.3 | High |
| Job orchestration & progress | 2 | 2 | 3 | 2.3 | High |
| Playlist ingestion | 3 | 2 | 3 | 2.6 | Medium |
| Export generation | 3 | 2 | 3 | 2.6 | Medium |
| Deployment & lifecycle | 3 | 2 | 3 | 2.6 | Medium |
| Configuration & settings | 2 | 3 | 3 | 2.7 | Medium |
| Browser-local recording | 2 | 3 | 3 | 2.7 | Medium |
| Channel matching & overrides | 3 | 3 | 3 | 3.0 | Medium |
| Metadata enrichment | 3 | 3 | 3 | 3.0 | Medium |
| EPG source management | 4 | 3 | 3 | 3.3 | Sound |
| EPG grab pipeline | 3 | 4 | 3 | 3.4 | Sound |
| Watch playback & guide | 3 | 4 | 4 | 3.7 | Sound |

### UI surfaces (7)

| Screen | T | C | A | Score | Band |
| :--- | :-: | :-: | :-: | :-: | :--- |
| Settings | 1 | 2 | 2 | 1.6 | Critical |
| Diagnostics | 1 | 3 | 3 | 2.2 | High |
| Channel Manager | 3 | 2 | 2 | 2.4 | High |
| DVR | 2 | 3 | 2 | 2.4 | High |
| Admin shell & login | 2 | 3 | 3 | 2.6 | Medium |
| Dashboard | 3 | 3 | 2 | 2.8 | Medium |
| Watch | 3 | 4 | 3 | 3.35 | Sound |

---

## Defect register

Defects are referenced by id from slice descriptions. `D` = process audit, `R` = source retrieval,
`X` = cross-cutting UI.

| ID | Defect | Location | Slice |
| :-- | :--- | :--- | :-- |
| D1 | Reset unlinks the open SQLite file; misses 6 tables | `server.ts:738` | S3 |
| D2 | HLS segments never deleted while streaming | `stream.ts:59` | S1 |
| D3 | No cap on concurrent ffmpeg stream processes | `server.ts:2300` | S1 |
| D4 | Series Pass wired at 3 layers of 4, never fires | `recorder.ts:440` | S8 ✅ |
| D5 | Sessions die on restart; no TTL, no rate limit | `server.ts:44` | S5 |
| D6 | Path traversal on recording read and delete | `server.ts:1674,1691` | S2 |
| D7 | Whole data dir is a public static mount — **confirmed exploitable**, `/files/local.db` returns 200 | `server.ts:70` | S7 |
| D8 | Shutdown drops recordings on the floor | `server.ts:842` | S4 |
| D9 | `epg.xml` written over the file being served | `epg.ts:914` | S11 |
| R1 | XMLTV ingest path never called | `epg.ts:156` | S16b |
| R2 | EPGShare direct feeds never fetched | `epg-sources.ts:73` | S16b |
| R3 | All iptv-org sources marked success regardless | `iptv-org.ts:218` | S15 |
| R4 | Catalogue deleted before replacement parsed | `iptv-org.ts:86` | S16 |
| R5 | Grab counter counts channels it never queues | `pipeline.ts:58` | S17 |
| R6 | Source sync overwrites user-set priority | `iptv-org.ts:186` | S15 |
| X1 | Accessibility effectively absent | all templates | S22 |
| X2 | Fonts load from public CDN | `index.html` | S22 |
| X3 | Nine themes, none light | `styles.css` | S22 |
| X4 | Feedback vanishes before it can be acted on | `toast.service.ts` | S23 |
| X5 | Two icon systems, 63 inline styles | all templates | S22 |
| X6 | Screens fetch overlapping data from divergent endpoints | `api.service.ts` | S21 |
| X7 | `e2e/ui.spec.ts` is stale and effectively non-functional — asserts the pre-rename app name ("EPG Manager" vs "Tuner Daemon") and assumes a seeded database. Fails on a clean checkout with **and** without changes, so it gates nothing. | `e2e/ui.spec.ts` | S24 |

---

## Backlog

25 slices in 5 waves. Waves are ordered so later work lands on stable ground.
Size: **S** ≈ a session · **M** ≈ a day · **L** ≈ multi-day.

### Wave 1 — Stop the bleeding
> Nothing unbounded, nothing destroyed. No new features.

- [x] **S1 · Bound the stream proxy** — M — *done 2026-08-13*
  Added `delete_segments` + `hls_delete_threshold 6` to the HLS flags, capped concurrent streams at
  `MAX_ACTIVE_STREAMS` (default 6, env-overridable) with LRU eviction of the least-recently-touched
  idle session, added a mid-run orphan directory sweep on the existing 10s cleanup tick.
  *Fixes D2, D3.* → `src/services/stream.ts`, `src/services/stream-limits.ts`, `src/server.ts`
  - [x] A four-hour session holds a bounded number of `.ts` files
        — verified empirically: 40s live run retains 5 segments vs 40 on the old flags
  - [x] Requesting stream N+1 past the cap evicts the oldest idle stream, never the one being watched
        — `selectStreamToEvict` refuses to evict anything touched in the last 15s; a full house
        returns 503 `STREAM_LIMIT` rather than cutting off a viewer
  - [x] Killing the process leaves no orphan directories after next boot
        — boot purge already existed in `db.ts`; added `sweepOrphanDirs()` so directories orphaned
        while the server keeps running are reclaimed within 10s of passing a 60s grace period

- [x] **S2 · Harden recording file access and add retention** — M — *done 2026-08-13*
  One resolver (`resolveRecordingPath`) for all three recording routes; rejects any input carrying a
  directory component rather than normalising it away. Retention policy engine with four modes,
  defaulting to **30-day age expiry** (user decision, 2026-08-13). Free-space floor checked at both
  schedule time and record time. Storage gauge now reports the volume.
  *Fixes D6.* → `src/server.ts`, `src/recorder.ts`, `src/services/recording-storage.ts`, `dvr.component.*`
  - [x] Encoded traversal returns 400 on read and delete
        — verified against a live server: `..%2f`, `%2e%2e%2f`, nested paths and suffix tricks all 400
        on `/files/recordings/`, `/api/recordings/` and `/api/dvr/stream/`; legitimate filenames still 200
  - [x] Scheduling below the free-space floor fails at schedule time with a clear reason
        — `POST /api/dvr` returns 507 `INSUFFICIENT_STORAGE`; `runRecordingSession` re-checks and marks
        the row failed with the shortfall rather than spawning ffmpeg onto a full disk
  - [x] Retention prunes oldest-completed first and logs what it removed
        — only `completed` rows with a file are ever eligible; scheduled/in-flight/failed are excluded

  **Found during S2:** the hardened `/files/recordings/:filename` route was being shadowed by
  `app.use('/files', express.static(DB_DIR))` registered earlier in the file — `express.static`
  resolves `recordings/../local.db` *inside its own root* and served the database with a 200.
  Fixed by registering the validated route ahead of the static mount. **D7 is confirmed exploitable
  and still open:** `/files/local.db` remains directly downloadable. S7 owns it.

  Retention settings (all optional, defaults shown): `dvr_retention_mode=age`,
  `dvr_retention_days=30`, `dvr_size_budget_gb=50`, `dvr_min_free_gb=2`.
  Modes: `age` · `size` · `low-space` · `off`.

- [x] **S3 · Scoped reset that preserves the collection layer** — M — *done 2026-08-13*
  Four scopes (`guide` / `user` / `collection` / `all`), each truncating a declared table set in place.
  The database file is never unlinked. `GET /api/reset/preview?scope=` returns row and byte counts
  before anything is destroyed; the dashboard now opens a scope picker showing those counts instead of
  a native confirm. Refuses with 409 while a sync is running.
  *Fixes D1.* → `src/server.ts`, `src/services/reset-scopes.ts`, `dashboard.component.*`
  - [x] Reset user data leaves `epg_sources`, `epg_source_channels`, `iptv_org_map` and both reliability tables intact
        — verified live: after `scope=user`, channels/settings/programs 0 while map/src/site/tvmaze all retained
  - [x] A post-reset sync completes without re-downloading the iptv-org archive
        — `iptv-org-epg/` survives `guide` and `user`; only `collection` and `all` remove it
  - [x] Every table in the live schema belongs to exactly one declared scope
        — `checkScopeCoverage()` asserts it in tests against all 21 tables, and runs at boot to warn
        if a newly added table is unclassified
  - [x] The server keeps serving without a restart
        — `/api/health` 200 after reset, and a subsequent config write lands in the live file
        (inode unchanged), proving the unlinked-inode bug is gone

  Validated in a real browser: `e2e/reset-scopes.spec.ts`, 5 tests, all passing against the built
  Angular app — scope options, pre-flight counts, scope switching, cancel-issues-no-request, and
  confirm-leaves-server-serving.

  **Found by visual inspection (agent-browser), invisible to both suites:**
  1. The modal shipped with **no CSS at all** — the new `.reset-*` classes had no rules, and Angular
     scopes component styles so the `.modal-header` / `.modal-actions` / `.close-modal-btn` rules from
     other components never applied. DOM assertions passed the whole time.
  2. Once styled, the action buttons **overlapped the preview list by 52px**. Global `.modal-content`
     makes the element a scroll container (`max-height: 85vh; overflow-y: auto`); combined with
     `flex-direction: column`, children default to `flex-shrink: 1`, so the preview panel was squashed
     below its content height and its list overflowed onto the buttons. Fixed with
     `.reset-modal > * { flex-shrink: 0 }` — measured −72px (clearance) after.

- [x] **S4 · Drain on shutdown** — S — *done 2026-08-13*
  Five-step drain: stop schedulers and cancel the pipeline → close the HTTP server → SIGINT active
  recorders and wait for finalisation → kill transcodes → close the database. Unref'd hard-kill timer
  at `SHUTDOWN_GRACE_MS` (default 30s) so a stop can never hang.
  *Fixes D8.* → `src/server.ts`, `src/recorder.ts`
  - [x] `docker stop` during a recording produces a playable file, not a recovered `.part`
        — end-to-end test against a live HLS source: recorded ~2.5 min, sent SIGTERM mid-capture, got
        `status=completed`, a single 2.7 MB `.mp4`, no `.part` left, and `ffmpeg -f null -` full decode
        exit 0 (h264 320x240, 151.9s)
  - [x] Shutdown completes within the grace period every time
        — exited in 2s against a 30s grace

  **Also fixed:** `mergeRecordingParts()` spawned the concat and returned immediately, so awaiting it
  never waited for the merge. Now resolves on the concat's `close`/`error` — without this the drain
  would have reported success while the output file was still being written.
  Added `beginRecorderShutdown()` so a dying ffmpeg during shutdown salvages what was captured instead
  of scheduling a retry into a closing process.

### Wave 2 — Make identity real
> One auth model, enforced the same way on every surface.

- [x] **S5 · Durable sessions with expiry** — M — *done 2026-08-14*
  Sessions persist in `admin_sessions`, **stored hashed** (sha256) so a database read cannot hand over
  live sessions. In-memory index keeps the hot path a map lookup. TTL default 168h
  (`SESSION_TTL_HOURS`), swept at boot and hourly. Constant-time password compare via length-safe
  hashing. Per-IP login throttle (8 failures / 15 min, then 429 + `Retry-After`).
  *Fixes D5.* → `src/server.ts`, `src/db.ts`, `src/services/sessions.ts`
  - [x] A restart does not log anyone out
        — same token after restart: `/api/config` 200, `/api/auth/status` `{authenticated:true}`
  - [x] Tokens stop working after the TTL and are removed from storage
        — expired row → 401, and 0 rows left after the boot sweep
  - [x] Repeated bad passwords are throttled
        — attempts 1–8 return 401, 9+ return 429 with `Retry-After: 900`; the correct password is also
        refused while blocked, and existing sessions keep working throughout

  Weak-password warning fires at boot when `ADMIN_PASSWORD` is a default, to both the log stream and
  stderr. **Note:** any `emitLog` before `tui.init()` is never rendered — that is why the original
  "Initializing database…" line has never appeared either. Worth a cleanup in S14.

  New table `admin_sessions` is classified in a new **SYSTEM** reset class, cleared only by `all` —
  clearing it during "reset my data" would sign the admin out mid-flow and read as a bug.

- [x] **S6 · One HTTP path in the client** — S — *done 2026-08-14 (shipped in 1ae7e9d)*
  `authInterceptor` attaches the token and handles 401 in one place, registered ahead of the existing
  `serverUrlInterceptor` so it sees relative `/api/` urls.
  → `client/src/app/services/auth.interceptor.ts`, `auth.service.ts`, `api.service.ts`, `app.config.ts`
  - [x] No component calls `authHeaders()` directly
        — 44 call sites removed, helper deleted, 0 occurrences left in `client/src`
  - [x] An expired session produces one visible prompt, not silent blank panels
        — browser-verified: revoking a session mid-use swaps the shell to the login form reading
        "Your session expired — please sign in again", and clears the stored token
  - [x] `getRecordings()` and `getActiveRecordings()` return data
        — both previously called auth-required endpoints with no header; they now inherit it

  **Two bugs found while verifying, both mine:** `AdminLayoutComponent` snapshotted `isAuthenticated`
  once in `ngOnInit`, leaving the admin UI rendered as if signed in with every panel empty; and
  `handleSessionExpired()` set its notice flag *after* `clearSession()` had already pushed the state
  change the shell reads, so the login form appeared with no explanation. Both fixed.

  **Bookkeeping note:** this entry sat unchecked until 2026-08-14 even though the work shipped in the
  wave 2 commit — an earlier scripted edit to this file failed to match and I did not assert on it.
  The code was always there; the record was wrong.

- [x] **S7 · Draw the viewer / admin line** — M — *done 2026-08-13, pulled forward*
  Replaced `express.static(DB_DIR)` with three explicit mounts: `/files/streams` (viewer),
  `/files/recordings/:filename` via the validated resolver (viewer), `/files/iptv-org-playlists`
  behind `requireAuth` (admin). Everything else under `/files` 404s. Removed the public
  `/api/debug-channels`. Favourites and hidden channels are viewer scope in both directions.
  *Fixes D7.* → `src/server.ts`, `watch.component.ts`, `dvr.component.ts`, `settings.component.html`
  - [x] Reads and writes of the same resource share one auth rule
        — favourites/hidden verified anonymously: GET 200, POST 200, read-back `["c1"]`, DELETE 200
  - [x] `local.db` is not fetchable over HTTP
        — `/files/local.db`, `-wal`, `-shm`, `http-cache/*`, `epg.xml`, `playlist.m3u` and
        `/files/../local.db` all 404 anonymously; body is `{"error":"Not found"}`
  - [x] Any denied action shows the reason instead of being swallowed
        — `describeApiError()` maps 401/403 → "Sign in on the Admin page to schedule server
        recordings", 507 → the disk shortfall, 409 → already scheduled

  **Scope decisions taken:**
  - Viewer scope: guide, categories, programmes, stream + keepalive, system recordings list,
    `/playlist.m3u` and `/epg.xml` (the documented Plex/Jellyfin integration), favourites, hidden.
  - Admin scope: all configuration, channel management, sync, DVR scheduling, metadata, sources, reset.
  - **Deviation from the original slice text:** keepalive stays viewer scope. Requiring a session
    would break anonymous watching, which is the product's core use case; the real mitigation for
    "anyone can hold a transcode open" is S1's concurrency cap and idle eviction, which is in place.
  - Settings' export URLs corrected to `/playlist.m3u` and `/epg.xml` — the old `/files/...` copies
    would have 404'd under the new mounts (and `/files/guide.xml` never existed at all).

### Wave 3 — Source acquisition layer
> Sources must be honest and extensible before the UI can show them.
> Full design: see `docs/source-architecture` notes and the published architecture doc.

- [x] **S15 · Source registry and descriptor model** — M — *done 2026-08-14*
  `epg_sources` renamed to `sources` (data-preserving, idempotent) and widened with `kind`,
  `provides`, `config_json`, `credential_ref` and per-sync health columns. Added
  `source_credentials` and `epg_source_channels_staging`. Descriptor model with validation,
  normalisation, refresh scheduling and redaction in `src/services/sources/descriptor.ts`.
  *Fixes R3, R6.* → `src/db.ts`, `src/services/sources/descriptor.ts`, `iptv-org.ts`, `server.ts`
  - [x] Every existing source and playlist survives migration as a descriptor
        — verified against a database built on the old schema: both guide sources kept their
        `enabled` state and priority, both configured playlists became `m3u` channel sources with
        stored descriptors, restart is idempotent (4 rows, no duplication, no errors)
  - [~] Status and error are recorded per source from real outcomes
        — implemented: the blanket "everything succeeded" UPDATE is replaced by per-source status
        derived from what each actually imported (`success` / `empty` / `failed`), with per-site parse
        errors attributed to their source. **Not yet observed on a real catalogue sync** — that needs
        a full iptv-org download; will be confirmed during S16.
  - [x] Credentials never appear in API responses or logs
        — a source seeded with `http://bob:hunter2@…?password=hunter2` returns zero occurrences of
        the secret in `/api/epg-sources`; the value stays server-side and the client sees a redacted
        url plus a `hasCredentials` flag

  Also fixes **R6**: catalogue refresh no longer resets user-set `priority` (it already left
  `enabled` alone).

  **Deviation:** the workplan said "widen `epg_sources` into `sources`". I did rename it rather than
  widen in place — the registry now holds playlists too, so keeping the old name would have been the
  same "name says X, code does Y" drift the audit catalogues. 16 references across 6 files updated;
  the rename is guarded and idempotent.

- [x] **S16 · Adapter contract and acquisition core** — L — *done 2026-08-14*
  Contract (`adapter.ts`), fetch policy (`http-policy.ts`), shared HTTP client (`fetcher.ts`),
  built-in catalogue (`catalog.ts`) and stage-and-swap (`staging.ts`). The iptv-org catalogue
  refresh now stages and swaps instead of deleting first.
  *Fixes R4.* → `src/services/sources/`, `iptv-org.ts`, `server.ts`, `playlist-metadata.ts`
  - [x] A full sync produces the same result as before, through adapters
        — `m3u`, `bundle` and `scraper-repo` are implemented behind the contract and registered;
        playlist import now runs through the `m3u` adapter. Verified live against a 250-channel
        fixture: 250 imported, all with tvg_id, logo, group, url and channel number intact, and a
        changed playlist correctly re-imported at 300.
  - [x] A failed catalogue sync leaves the previous catalogue intact
        — proven three ways: a mid-parse failure leaves the live catalogue at 2 rows; a refresh that
        parses to nothing refuses to swap and reports "keeping the previous 2 channel(s)"; a good
        refresh swaps cleanly to 3. Per-source, so one bad site cannot empty another's catalogue.
  - [x] An unchanged feed refreshes with a 304 and no re-parse
        — against a live HTTP server: first fetch 200 / 1,277,811 bytes, second fetch **304 / 0 bytes**
        with `notModified: true`, so the caller skips parsing entirely. Validators cached per source
        in `source_validators`.
  - [x] FAST presets exist in exactly one place
        — the three copies (server.ts `FAST_PRESETS`, the branching in `describePlaylist()`, and the
        hardcoded buttons in the Settings template) are gone. `catalog.ts` is the only definition;
        Settings renders from `GET /api/sources/catalog`.

  The catalogue also carries EPGShare 01's ten regional feeds as ordinary entries — previously
  defined in `epg-sources.ts` with no caller at all (R2). They are wired up by the xmltv adapter
  in S16b.

  **Regression I introduced and caught by running it:** routing playlist import through the adapter
  meant an unchanged playlist returned 304, the adapter yielded nothing, and the existing
  delete-then-reinsert wiped all 250 channels and wrote zero. "Unchanged" and "empty" are not the
  same thing and an iterable cannot express the difference, so the context now exposes
  `lastFetchNotModified` and the import skips entirely when nothing changed. Re-verified both ways:
  unchanged re-sync keeps 250, changed re-sync imports 300. This is a good argument for finishing
  S12 (non-destructive playlist import) sooner rather than later.

- [x] **S16b · Direct XMLTV ingestion** — M — *done 2026-08-14*
  `xmltv` adapter with its own streaming SAX parser (channels, programmes, categories, ratings,
  icons), gzip support, and a sample limit so probing a national guide doesn't hold it all in memory.
  EPGShare 01's ten regional feeds were registered in the catalogue in S16.
  *Fixes R1, R2.* → `src/services/sources/adapters/xmltv.ts`, `sources/index.ts`
  - [x] A channel with no scraper coverage gets guide data from a direct feed
        — end to end against a gzipped 50-channel / 48-hour feed: probe reported 50 channels and
        2.00 days, catalogue returned 50 rows, and **2,400 programmes** were ingested and persisted
  - [x] Programmes are attributable to the feed that supplied them
        — all 2,400 rows carry the source key; `persistProgrammes` replaces only that source's rows
  - [x] Disabling a feed removes only its programmes
        — removing the feed left its own rows at 0 and another source's row untouched

  **Two ordering bugs found by running it, both invisible to unit tests:**
  1. **Probe poisoned the conditional cache.** Probing a source stored its validators, so the very
     next real sync answered 304 and pulled nothing — a source would look empty immediately after
     being added. Probes now run on a context that neither reads nor writes validators.
  2. **`syncCatalog` starved `fetchGuide`.** Both fetch the same document for a whole-feed kind, and
     the first stored validators, so the second got a 304 and yielded zero programmes. One fetch is
     now shared per context, which also halves the bandwidth.

  Verified separately with a fresh context that a genuine second cycle still gets its 304.

- [x] **S25 · Streaming playlist parse** — M — *done 2026-08-14 (third criterion accepted, not proven)*
  A line-based streaming M3U parser plus a streaming HTTP fetch, so neither the body nor the parsed
  array is held whole. Replaces `iptv-playlist-parser` on the import path.
  → `src/services/sources/m3u-stream.ts`, `fetcher.ts`, `adapters/m3u.ts`
  - [x] The streaming parser agrees with the library it replaces
        — equivalence tested on a fixture covering quoted commas in `group-title`, commas in channel
        names, missing attributes, unicode, and `#EXTGRP`; plus a generated 1,000-channel playlist
        where name, url, tvg-id and group all match exactly
  - [x] Fetch and parse no longer scale with playlist size
        — 50,000 channels went from **+68.6 MB to +17.5 MB** of heap, a 75% reduction. 150,000
        channels import successfully at +32.3 MB into an empty database.
  - [x] **Peak memory is strictly flat** — **accepted by Chris on 2026-08-14** as satisfied by the
        75% reduction, rather than proven. Recording it that way so the distinction survives: the
        parse and fetch are flat; the residual below is real and unfixed.
        The same 150,000-channel playlist costs +32.3 MB against an empty database and +54.4 MB
        against one already holding 50,150 channels. What still scales is the in-memory preservation
        index — the existing-channel lookup maps and the used-id set that avoid collisions and keep
        user state (enabled, EPG match, channel number). The parse itself is flat.
        **To close it:** stage raw rows first, then do preservation and collision handling as a SQL
        join over `channels_staging`, so SQLite holds the index instead of the heap. That is a
        behavioural change to id assignment and deserves its own slice rather than being bolted on.

- [ ] **S16c · File adapter** — M — *scope reduced, see note*
  Upload adapter for local M3U/XMLTV — air-gapped setups, hand-curated lineups, testing.
  → `src/services/sources/adapters/file.ts`

  **Xtream deferred.** Originally bundled here. Two arguments against building it now: the existing
  `m3u` and `xmltv` adapters already cover the use case, because Xtream panels expose
  `get.php?...&type=m3u_plus` and `xmltv.php` endpoints that are an ordinary playlist and an
  ordinary guide feed — a user with a portal can add both today, with credentials redacted by S15.
  A bespoke adapter would add only category metadata, token refresh and a nicer add-flow. Against
  that, it is the one kind needing stored credentials, and the protocol's ecosystem skews heavily
  toward unlicensed resale. Not worth the surface area for the marginal gain. Revisit if a concrete
  need appears.

- [x] **S17 · Honest grab accounting** — S — *done 2026-08-14*
  `totalToGrab` is incremented per resolved id after the catalogue query rather than per matched id
  before it. Channels no enabled grab-capable source covers are collected as a distinct "no source"
  outcome and surfaced in the progress message and in `getGrabStats()`.
  *Fixes R5.* → `src/services/pipeline.ts`
  - [x] The grab phase reaches 100% and renders complete on every successful sync
        — the denominator now only counts queued channels, so `grabsCompleted >= totalToGrab`
        is reachable. Locked by a test asserting 2 rather than 3 for a batch where one of three
        channels has no source
  - [x] Channels with no available source are reported and countable
        — `noSource` count and ids exposed; progress reads "… , N with no source"

  **Test infrastructure fixed along the way:** `jest.mock('../../db')` plus a direct import of
  `src/__mocks__/db` gives two different module instances, so the call history stayed empty and the
  first five assertions failed misleadingly. Switched to the inline-factory pattern the other service
  tests already use. Also added a `moduleNameMapper` for NodeNext `.js` specifiers, without which
  `pipeline.ts`'s dynamic `import('./grabber.js')` cannot resolve under ts-jest — that had made the
  pipeline effectively untestable.

- [x] **S18 · Sources screen with probe-first add flow** — M — *done 2026-08-14*
  A Sources screen covering both families, backed by a registry module and nine API routes. Source
  management has moved out of Diagnostics, which was configuration filed under diagnosis.
  → `client/src/app/admin/sources/`, `src/services/sources/registry.ts`, `server.ts`
  - [x] Adding any supported source needs no code change
        — a guide feed and a playlist were both added through the UI by pasting a URL; kind is
        inferred from the url and stored as a descriptor
  - [x] Probe results are shown before anything is written
        — verified in a browser: probing a gzipped XMLTV feed reported 30 channels and 1.0 days
        coverage while the sources table still held **0 rows**, both before and after the probe.
        The playlist probe reported 120 channels with a sample of the first few names
  - [x] A failing source is visibly failing with its reason
        — a source carrying `last_error` renders a red "Failing" chip, its reason underneath, and
        increments the Failing counter in the summary
  - [x] A configuration can be exported and restored
        — export returned 2 descriptors; re-importing reported `{added: 0, skipped: 2}`; after
        deleting one source, re-importing restored it (`{added: 1, skipped: 1}`)

  Removing a source deletes only the rows attributed to it — provenance is what makes that safe.

### Wave 4 — Make every control do something
> Close the gap between what the UI offers and what the system does.

- [x] **S8 · Series Pass end to end** — L
  Call `autoScheduleSeriesRules()` from the scheduler tick and after every sync; fix its query to
  respect `manual_overrides`; send `record_series` from the DVR screen; add the missing client
  methods and a rules management panel.
  *Fixes D4.* → `src/services/series-rules.ts` (new), `src/recorder.ts`, `src/server.ts`,
  `src/services/pipeline.ts`, `api.service.ts`, `dvr.component.*`
  - [x] A rule created today schedules episodes that arrive in tomorrow's guide
        — inserted one future episode after the rule existed; the next pass booked exactly it
  - [x] Rules are listable and deletable from the UI
        — panel lists each rule with its channel and upcoming count; Stop asks separately whether
        to also cancel what it has already booked
  - [x] Re-running the pass never double-books an episode
        — ran the pass three times against an unchanged guide: 0, 0, 0
  - [x] Rules work on channels mapped by manual override
        — a channel with `matched_epg_id` cleared and an override row scheduled correctly; the
        old query returned nothing for it

  The pass was dead code with three defects, not one: no caller, no future filter, and a join that
  ignored `manual_overrides`. It now runs at boot, hourly, at the end of every pipeline run, and
  immediately when a rule is created.

  Dedupe compares start times within a 5-minute window rather than exactly. Found by testing:
  the endpoint stored the client's timestamp (`...04.690314+00:00`) while the pass computed its
  own from the guide row, and the same showing was booked twice eight seconds apart.

  Watch's series recording is left alone — it records in the browser, not on the server, so it is
  not a caller of this rule engine. Reconciling the two DVRs is S20.

- [x] **S9 · DVR lifecycle correctness** — M
  Mark past-due schedules as missed, add configurable pre/post padding, surface `error_message`,
  classify retries by failure type, keep `.part` files when concatenation fails.
  → `src/services/dvr-lifecycle.ts` (new), `src/recorder.ts`, `src/server.ts`, `dvr.component.*`
  - [x] A missed window reports "missed", never "failed: output file not found"
        — two rows left behind by an outage came back as `missed` with "the recording window closed
        about 25 hour(s) before the recorder reached it"; a third, still airing, started 15 minutes
        late and captured the remainder
  - [x] Padding is honoured on both ends
        — with 90s pre / 300s post, a programme due in 60 seconds started immediately and recorded
        1552s of a 1200s programme
  - [x] Every failed row shows a human-readable cause
        — a 404 stream failed once with "the channel has probably moved or been removed"; a refused
        connection retried at 5s, 10s, 20s, 40s then stopped with "(gave up after 5 attempts)"

  The scheduler used to start ffmpeg against any past-due row regardless of whether the window had
  closed, which is where "failed: Output file not found" came from — a message describing the
  symptom and hiding the cause.

  Retries are now classified rather than counted. ffmpeg reports everything as exit 1 plus a line
  of stderr, which was being discarded; the tail is kept and matched, so a permanent failure stops
  at once instead of five times over four minutes.

  Retention and padding got an API and a panel. Retention had been read by the recorder since S2
  but was unreachable from anywhere — the defaults were the only values it could ever have.

  Padding defaults to 0 before / 120s after. Post-padding is what a DVR is expected to do; starting
  early is left off because it overlaps whatever the channel was showing before.

- [ ] **S10 · One front door for background work** — L
  Every mutating background action behind a single job manager with a real queue. Report the actual
  cron cadence from configuration.
  → `src/job.ts`, `src/server.ts`, `src/services/pipeline.ts`
  - [ ] Two conflicting triggers queue instead of overlapping
  - [ ] Every background action appears in job status and can be cancelled
  - [ ] Reported schedule matches the configured schedule

- [x] **S19 · Close the settings loop** — S — *done 2026-08-14*
  `POST /api/config` now accepts and persists `channel_numbering_mode` and `custom_channel_ranges`,
  with validation. The numbering default is defined once server-side and both config endpoints report
  it. Added the language selector for `preferred_lang`, which the API had always accepted with no UI
  to set it.
  → `src/server.ts`, `settings.component.*`
  - [x] Every control round-trips: change, save, reload, still changed
        — browser-verified: set language to German and numbering to List in the UI, saved, reloaded;
        both survived in the UI and in `settings`. Invalid values are rejected with a reason
        (`channel_numbering_mode must be one of: …`, `custom_channel_ranges must be valid JSON`)
  - [x] Both copied output URLs resolve
        — `/playlist.m3u` and `/epg.xml` both 200 once generated (404 before, correctly). Fixed in S7;
        the old `/files/guide.xml` never existed at all
  - [x] Presets come from one place
        — zero hardcoded preset urls outside `catalog.ts`; the six FAST presets are served from
        `GET /api/sources/catalog`. Collapsed in S16

  The numbering feature was never broken — `epg.ts` has always read these settings. They were simply
  impossible to set from the only screen that offered to set them.

- [x] **S20 · One DVR, two presentations** — L
  Collapse the duplicate implementations into a shared DVR service plus one component rendering admin
  and overlay modes.
  → `services/dvr.service.ts` (new), `services/dvr-format.ts` (new), `dvr.component.*`,
  `watch.component.*`
  - [x] Scheduling logic exists once
        — no `clientRecordings.schedule` or `api.scheduleRecording` call remains outside DvrService;
        the four scheduling paths across the two components are now one
  - [x] Both surfaces produce identical results for the same programme
        — "Record Series" from Watch while signed in produced a server rule and 5 server rows, the
        same as the admin screen; signed out, the same action produced 1 browser recording and 0
        server rows
  - [x] Failure reasons render wherever a recording is listed
        — a missed recording shows "Missed" with its reason in both the admin list and the Watch
        overlay, in the muted note colour rather than error red

  Two recorders, not two copies of one: the server's survives a closed tab, the browser's is all an
  anonymous viewer has. DvrService picks between them and says which one it used, instead of the two
  screens each assuming a different answer.

  The consolidation found a live drift rather than just duplication. Watch's `parseEpgTime` stripped
  everything after the timestamp — including the `+0200` — and read every programme as UTC, while
  the DVR screen's copy applied the offset. The same feed placed shows in different hours depending
  on which screen you looked at.

  The framework-free half is a separate module so jest can reach it; `roots` now includes
  `client/src/app/services`. That is the first client-side unit test in the repo.

- [ ] **S21 · Channel Manager at real scale** — M
  Replace the 500-row truncation with virtual scrolling or server-side paging, debounce EPG search,
  scope search results to the requesting row, precompute match badges, resolve the two edit paths.
  *Fixes X6.* → `channel-manager.component.*`
  - [ ] Every channel is reachable at 2,000 channels
  - [ ] EPG search issues one request per pause, not per keystroke
  - [ ] Expanding a row never shows another row's candidates

### Wave 5 — Pay down the drift
> Make the code, the config, and the docs agree.

- [ ] **S11 · Atomic, deterministic exports** — S
  Temp file plus rename for both exports, `ORDER BY` on the paginated programme query, bind the
  channel id list, drop the `[DEBUG]` lines from the user log.
  *Fixes D9.* → `src/services/epg.ts`
  - [ ] Fetching `/epg.xml` during a rebuild always returns a complete document
  - [ ] Programme count in the file matches the count in the database

- [x] **S12 · Non-destructive playlist import** — M — *done 2026-08-14, pulled forward*
  Imports stream into `channels_staging` and swap per source in one transaction, only once the whole
  playlist has parsed. `/api/sync-playlist` now reloads every configured playlist. Orphaned staging
  rows are cleared at boot.
  → `src/server.ts`, `src/services/channel-staging.ts`
  - [x] Killing the process mid-import leaves the old channel set intact
        — `kill -9` on every server process during an import from a deliberately slow source: API
        unreachable afterwards, and the 150 existing channels survived untouched. Separately verified
        that staged rows never leak into live — 40 simulated partial rows sat in staging with 0
        appearing in `channels`.
  - [x] Reload refreshes all configured playlists
        — with two playlists configured, reload reports "Reloading 2 playlist(s)" and returns 350
        channels; previously it refreshed only the legacy single `playlist_url`
  - [x] **Peak memory is flat with respect to playlist size** — addressed by S25 and accepted;
        see S25 for the measurements and the remaining caveat.

  **A test of mine was wrong before it was right:** the first mid-import kill appeared to pass, then
  a later reading showed 50,150 channels. `npx ts-node` spawns several matching processes and
  `pgrep | head -1` had killed a wrapper while the real server finished the import. Re-run killing
  every matching pid and confirming the API was unreachable before trusting the numbers.

- [ ] **S13 · Consolidate configuration** — M
  Collapse `/api/settings` and `/api/config` into one typed, validated, defaulted contract. Retire the
  dual `playlist_url` write. Promote operational constants into settings.
  → `src/server.ts`, `settings.component.*`
  - [ ] One endpoint, one shape, defaults applied in one place
  - [ ] Invalid values rejected with a field-level message
  - [ ] Changing sync cadence takes effect without a restart

- [ ] **S24 · Make the e2e suite mean something** — M
  `e2e/ui.spec.ts` fails wholesale on a clean checkout — stale assertions from before the rename, and
  an assumption that channels are already seeded. A suite that fails either way gates nothing, so
  every future slice ships without UI regression cover. Fix the assertions, add a seeded fixture so
  data-dependent tests have data, and wire e2e into CI (currently only unit tests run).
  *Fixes X7.* → `e2e/`, `.github/workflows/ci.yml`, `playwright.config.ts`
  - [ ] `npx playwright test` passes from a clean checkout against a seeded fixture
  - [ ] CI runs e2e and fails the build on regression
  - [ ] No test depends on data a previous test created

- [ ] **S14 · Truth pass on repo and docs** — S
  Delete the unserved `src/public/` legacy UIs. Correct the README API table. Publish port 4000 in
  compose, probe both ports in the healthcheck, remove build artefacts from version control.
  → `README.md`, `Dockerfile`, `docker-compose.yml`, `.gitignore`
  - [ ] Every endpoint in the README resolves as documented
  - [ ] No unreachable UI code ships in the image
  - [ ] The healthcheck fails when either process is down

- [ ] **S22 · Design system and accessibility pass** — L
  Label every control, give modals dialog semantics with focus trapping and Escape, make clickable
  cards real buttons, visible focus throughout. Self-host the three fonts in use. Add a light theme
  driven by `prefers-color-scheme` with manual override, applied during SSR. Retire inline styles,
  settle on one icon system.
  *Fixes X1, X2, X3, X5.* → `styles.css`, `index.html`, all templates, `theme.service.ts`
  - [ ] Every interactive element is keyboard reachable with a visible focus ring
  - [ ] Modals trap focus, close on Escape, and announce themselves
  - [ ] The UI renders correctly with no external network access
  - [ ] Light and dark both pass contrast on text and semantic colours

- [ ] **S23 · Feedback that survives long enough to act on** — M
  Errors persistent and dismissible, successes transient; pause on hover, cap the queue, announce
  through a live region. Replace the 12 native confirms with the modal pattern. Disable job-triggering
  actions while a job runs and say why.
  *Fixes X4.* → `toast.service.ts`, `toast-container.component.ts`, `dashboard.component.*`
  - [ ] An error raised while the user is away is still readable when they return
  - [ ] No native browser dialogs remain
  - [ ] Actions unavailable during a sync look unavailable and explain themselves

---

## Source acquisition reference

Kept here so the adapter work in Wave 3 has its contract to hand.

### Adapter kinds

| Kind | Speaks | Provides | State |
| :--- | :--- | :--- | :--- |
| `m3u` | M3U / M3U8 over HTTP or file | channels | extract existing |
| `xmltv` | XMLTV, plain or gzipped | guide | connect `processEpg` |
| `bundle` | Zip/tar of many playlists or guides | channels or guide | extract existing |
| `scraper-repo` | Site configs via `epg-grabber` | guide | extract existing |
| `xtream` | Xtream Codes panel API | channels **and** guide | new |
| `file` | Uploaded M3U or XMLTV | channels or guide | new |

### Contract

```ts
interface SourceAdapter {
  kind: SourceKind
  probe(d: SourceDescriptor, ctx: Ctx): Promise<ProbeResult>
  syncCatalog(d: SourceDescriptor, ctx: Ctx): Promise<CatalogResult>
  fetchLineup?(d: SourceDescriptor, ctx: Ctx): AsyncIterable<ChannelRow>
  fetchGuide?(d: SourceDescriptor, refs: ChannelRef[], w: Window, ctx: Ctx): AsyncIterable<ProgrammeRow>
}
```

### Lifecycle

`probe` → `register` → `sync catalogue into staging` → `swap and record` → `refresh conditionally on
schedule` → `resolve conflicts by provenance`

### Reset data classification (S3)

| Wiped as user data | Preserved as collection data |
| :--- | :--- |
| `channels`, `manual_overrides`, `metadata_overrides` | `epg_sources`, `epg_source_channels` |
| `channel_favorites`, `channel_hidden` | `iptv_org_map` |
| `scheduled_recordings`, `dvr_series_rules`, recording files | `site_status`, `channel_site_status` |
| `epg_programs`, `epg_channels` | `tvmaze_cache`, `metadata_cache`, `episode_metadata_cache` |
| `settings` | `iptv-org-epg` / `iptv-org-playlists` archives |
| generated `playlist.m3u` / `epg.xml`, stream scratch | `sync_jobs` |

---

## Validation tooling

| Tool | Use | Status |
| :--- | :--- | :--- |
| Jest | Pure logic — policy helpers, scope coverage, path resolution | 215 tests, green |
| Playwright | DOM-level browser assertions, runs in CI | 16 tests, green (`reset-scopes`, `api`) |
| agent-browser | Visual and layout inspection — catches what DOM assertions can't | installed at `~/.local/share/pnpm/agent-browser` |

`agent-browser` earned its place immediately: in S3 it found two defects that Jest and Playwright both
passed straight through — a completely unstyled modal, then a 52px overlap between the action buttons
and the preview list. Use it on any slice that changes UI. Note the SSR server caches the bundle in
memory, so **restart it after `ng build`** or you will screenshot the previous build.

## Log

| Date | Slice | Note |
| :--- | :--- | :--- |
| 2026-08-13 | — | Baseline audits complete. 24 slices across 5 waves. |
| 2026-08-13 | S1 | Done. Segment retention bounded (40 → 5 in a 40s control test), stream cap with idle-only LRU eviction, orphan sweep. 6 new unit tests; suite 189 → 195, all green. |
| 2026-08-13 | S2 | Decision: retention defaults to 30-day age expiry. Done. Traversal closed on all three recording routes and verified live; uncovered that `express.static` was shadowing the recordings route and serving `local.db` — route reordered, D7 confirmed exploitable and left to S7. 10 new unit tests; suite 195 → 205, all green. |
| 2026-08-13 | S3 | Decision applied: user data vs collection data split. Done. 4 scopes, in-place truncation, pre-flight preview, 409 during sync. Verified live that collection data survives a user reset and the server keeps serving. 10 new unit tests + 5 Playwright browser tests; unit suite 205 → 215. |
| 2026-08-13 | — | Found `e2e/ui.spec.ts` fails on a clean checkout with and without changes (stale post-rename assertions + assumes seeded data). Logged as X7, new slice S24. |
| 2026-08-13 | S3 | agent-browser visual pass found the reset modal had no CSS, then a 52px button/list overlap from flex-shrink inside a scroll container. Both fixed and re-verified by measurement. |
| 2026-08-13 | S4 | Done. Five-step drain with hard-kill fallback. Verified end-to-end: SIGTERM mid-recording of a live HLS source yields a completed, fully decodable MP4 in 2s. Also fixed `mergeRecordingParts` resolving before the concat finished. |
| 2026-08-13 | S7 | Done, pulled forward at user request. `/files` scoped to three explicit mounts; `local.db` no longer reachable (verified anonymously). Favourites/hidden made symmetric. Denied actions now name the reason. |
| 2026-08-14 | S5 | Done. Sessions persisted hashed with a 168h TTL, boot + hourly sweep, constant-time compare, per-IP throttle. Verified live: survives restart, expires from storage, throttles at 8 failures. 15 new unit tests; suite 215 → 230. |
| 2026-08-14 | S6 | Done. One interceptor replaces 44 hand-rolled header calls. Browser-verified expiry prompt. Found and fixed two of my own bugs: the shell snapshotted auth state once, and a flag was set after the subject that read it. |
| 2026-08-14 | — | Committed waves 1–2 as two commits plus a docs commit, no attribution trailers. |
| 2026-08-14 | S15 | Done. Source registry renamed and widened with descriptors; migration verified against an old-schema database. Per-source status replaces the blanket success UPDATE (R3); user priority preserved on refresh (R6); credentials redacted from API responses. 19 new unit tests; suite 230 → 249. |
| 2026-08-14 | S15 | Committed as 2793af6. |
| 2026-08-14 | S16 | Partial. Contract, fetch policy, HTTP client, built-in catalogue and stage-and-swap landed; R4 fixed and proven; 304 path proven (1.27 MB → 0 bytes); FAST presets reduced from three copies to one. Adapter port of scraper-repo/m3u/bundle still outstanding. 26 new unit tests; suite 249 → 275. |
| 2026-08-14 | S16 | Done. m3u/bundle/scraper-repo implemented behind the contract; playlist import runs through the m3u adapter and was verified live (250 in, 300 after a change). Caught and fixed a regression where a 304 wiped all channels. 13 new unit tests; suite 275 → 288. |
| 2026-08-14 | S12 | Pulled forward. Staging-and-swap for playlist imports; reload covers every configured playlist. Mid-import kill verified (after correcting a flawed test that killed an npx wrapper). Memory criterion measured and NOT met: +68.6 MB for 50k channels — needs a streaming parser. |
| 2026-08-14 | S16b | Done. xmltv adapter with a streaming SAX parser and gzip; 2,400 programmes ingested from a gzipped feed with full provenance. Found and fixed two fetch-ordering bugs: probe poisoned the conditional cache, and syncCatalog starved fetchGuide. 14 new unit tests; suite 288 → 302. |
| 2026-08-14 | S25 | New slice. Streaming M3U parser + streaming fetch, proven equivalent to the library it replaces. 50k channels: +68.6 MB -> +17.5 MB. Strictly-flat criterion still unmet; residual isolated to the in-memory preservation index, with a SQL-join path proposed. 19 new unit tests; suite 302 -> 321. |
| 2026-08-14 | S16c | Scope reduced to the file adapter. Xtream deferred: m3u + xmltv already cover portals via their get.php/xmltv.php endpoints, so a bespoke adapter adds little for the credential surface it costs. |
| 2026-08-14 | S17 | Done. Grab denominator counts only queued channels, so the phase can reach 100%; unsourced channels reported instead of absorbed. Fixed two test-infrastructure gaps that had made the pipeline untestable. 6 new unit tests; suite 321 -> 327. |
| 2026-08-14 | S18 | Done. Sources screen for both families, registry module, nine API routes. Probe-first add verified in a browser — 30 channels and 1.0 days reported with 0 rows written. Failure surfacing and export/restore round-trip verified. |
| 2026-08-14 | — | Chris accepted S25's flat-memory objective as satisfied by the 75% reduction. Recorded as accepted rather than proven. |
| 2026-08-14 | — | Corrected the S6 record: the work shipped in 1ae7e9d but an earlier scripted edit to this file silently failed to match, leaving it unchecked. |
| 2026-08-14 | S19 | Done. Config endpoint persists the numbering fields it used to drop; language selector added; defaults aligned across both config endpoints. UI round-trip browser-verified. |
| 2026-08-14 | S8 | Done. The series pass had no caller, no future filter, and a join blind to `manual_overrides`; all three fixed and each acceptance criterion verified against a live server on a copy of the real database. Rules panel added with a separate confirmation for cancelling already-booked episodes. Testing surfaced a duplicate-booking bug from comparing timestamps exactly — now a 5-minute window. 18 new unit tests; suite 327 -> 345. |
| 2026-08-14 | S9 | Done. Missed is now a state of its own, padding is configurable and honoured by both the scheduler and the recorder, and ffmpeg failures are classified from stderr instead of retried blindly five times. Retention finally got a UI — it had been readable-only since S2. Every criterion measured against a live server on a copy of the real database. 36 new unit tests. |
| 2026-08-14 | S20 | Done. One DvrService; four scheduling paths across two components became one. Verified both branches in a browser: signed in, Watch produces server rows identical to the admin screen; signed out, it produces browser recordings. Found that Watch's time parser discarded the UTC offset while the DVR screen's applied it. First client-side unit tests in the repo (jest roots widened). 26 new tests; suite 345 -> 407. |
