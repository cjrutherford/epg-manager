# Competitive UX notes — Tuner Daemon, Jellyfin Live TV, Threadfin/xTeVe

Phase 4 asks for a comparison against two comparable self-hosted tools. This is
the short version; it focuses on credible gaps, not feature parity for its own
sake.

## Snapshot

| Dimension | Jellyfin Live TV | Threadfin / xTeVe | Tuner Daemon |
|---|---|---|---|
| Onboarding | Tuner discovery or manual M3U, then guide and mapping; stream limit up front | Single wizard: tuner count, guide mode, M3U, XMLTV | First-run checklist, probe-before-save, presets; channels and guide still in separate add paths |
| Guide/player | Programs, Guide, Channels, Recordings, Schedule, Series | Admin/proxy only | Player + guide on one screen, 3 layouts, search, categories, favourites, 1k+ virtualised rows |
| Remote/TV | Native apps, quality varies; reported focus/TV-mode regressions | N/A | Remote-only Playwright gate, D-pad guide, 56px TV rows |
| Accessibility | Not a strength; hidden focus and keyboard regressions reported | No credible evidence | axe 0, Lighthouse 100, five AA themes, 12px floor; manual SR still pending |
| Status/error | Tuner status, weak conflict explanations | Availability %, errors, logs, active streams | Source health, sync pipeline, stale/offline notices, “Stay Tuned”, diagnostics |

## Credible gaps to close

1. **One guided add-live-TV pass (M).** Pair M3U + XMLTV, probe both, show
   coverage/matching and ask for simultaneous streams in one flow. Today the
   playlist picker and the generic source dialog are separate.
2. **Programme detail without hover/right-click (M).** Jellyfin exposes details
   and recording in a normal detail surface; Tuner Daemon relies on a hover
   tooltip and a context menu.
3. **Visible player deck and announcements (M).** Add play/pause, Live state,
   captions/audio/quality when present, channel-change OSD, and polite live
   region announcements.
4. **Channel overrides and true bulk edit (M).** Threadfin’s map editor edits
   name, group, logo, category, number and backups. Tuner Daemon can edit fewer
   fields and does not preserve all overrides across sync.
5. **Import filters (M).** Include/exclude rules by group or name, with a
   preview, before a 10k-channel playlist lands in the database.
6. **Capacity and recording conflicts (M).** Surface active/max streams and the
   source of the limit; warn before overlapping recordings exceed capacity.
7. **Per-series options (M).** New episodes only and keep-N, alongside the
   existing title/channel rules.
8. **Backup stream URLs (L).** A resilience differentiator, not a Gate 4
   blocker.

## Deliberately out of scope

HDHomeRun emulation, native Android TV/Roku/Apple TV apps, multi-user accounts,
parental controls, Schedules Direct, transcoding ladders and a media library.
Those are media-server breadth, not the tuner/guide job.

## Sources

- Jellyfin Live TV docs: <https://jellyfin.org/docs/general/server/live-tv/>
- Jellyfin Live TV setup: <https://jellyfin.org/docs/general/server/live-tv/setup-guide>
- Jellyfin client list: <https://jellyfin.org/docs/general/clients/>
- Jellyfin web keyboard regression: <https://github.com/jellyfin/jellyfin-web/issues/7936>
- Jellyfin hidden focus issue: <https://github.com/jellyfin/jellyfin-web/issues/6600>
- Threadfin: <https://github.com/Threadfin/Threadfin>
- xTeVe configuration: <https://github.com/xteve-project/xTeVe-Documentation/blob/master/en/configuration.md>
