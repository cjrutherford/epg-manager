# Match / grab / enrich review — 5 Nov 2026

## Run

- Review instance with the US playlist and guide sources.
- 1,495 channels, 1,008 matched, 487 with no guide source.
- Full sync triggered from the Dashboard at 11:09:53 and cancelled at
  11:21:23 after **11 min 30 s**, with the guide phase still at 560/825.
- Browser: Chromium 1440×1100, live SSE progress and a separate mid-sync reload.

## What works

- SSE progress arrives promptly; per-phase bars, counts and logs update.
- Cancel responds quickly and stops the server job.
- Matching results are rich: exact/fuzzy type, score, confirm/clear and rematch
  per row; 67% match rate and 487 unmatched are visible.
- Source health shows upstream counts and grab success per source.

## UI/UX issues

| # | Severity | Issue | Evidence |
|---|---|---|---|
| 1 | P1 | Guide phase turns red/error while still progressing | The grab message “461/825 (437 ok, 24 failed…)” matches the generic `/failed/` classifier, so `stage-error` is set at 56% even though the phase is healthy. |
| 2 | P1 | No overall elapsed time, ETA or last-sync result | Only per-phase counts; after cancel + reload there is no “cancelled” or error banner and no last-run timestamp. |
| 3 | P1 | Reloading mid-sync loses the console history | The dashboard restored progress bars from `/api/job-status`, but only 3–4 log lines arrived after reload; the earlier logs were gone. |
| 4 | P2 | Stage names/order do not match what runs | “Artwork” is actually the IPTV-ORG metadata update; Enrich runs concurrently with Guide fetch but appears after it in the pipeline. |
| 5 | P2 | Running actions stay clickable | “Run full sync” remains enabled while running with “Will queue behind the running job”; repeated clicks can queue duplicate work. |
| 6 | P2 | Source reliability conflates fetch success with guide success | Sources show “success” while grab success is 0% (EPGShare, Pluto, DistroTV) with no reason or last error. |
| 7 | P2 | Unmatched channels have no reason or bulk path | Diagnostics shows 487 unmatched, but not “no guide source” vs “no candidate”; only per-row Rematch. |
| 8 | P2 | Low-confidence matches are presented as confirmed | A 0.12 fuzzy score is labelled “Confirmed” with no threshold legend or explanation. |
| 9 | P3 | No guide coverage/freshness summary | “28,794 programmes” is shown, but not “guide covers X days”, “last success”, or “N channels without future data”. |

## Performance

- **Total:** 11m30s and not complete; guide 560/825, enrich 459/519.
- **Breakdown observed:** playlist + IPTV-ORG metadata ~49 s; matching reached
  completion around 173 s; the guide grab is the long pole (~0.8 channels/s).
- **First-sync target:** Gate 2’s “under 2 minutes” is not met for a 1,495-channel
  / 825-guide-target library.
- **Frontend:** 120 frames over 2 s, average 16.7 ms, no long tasks >32 ms; page
  heap ~15 MB. The dashboard itself is not the bottleneck.
- **Server:** RSS peaked around 600 MB during metadata + pipeline; the full sync
  re-downloads IPTV-ORG data and re-grabs channels that may not have changed.
- **Logs:** the DOM cap is 500 entries, so a long sync does not grow without
  bound; the cost is history loss on reload, not runtime jank.

## Recommendations

1. **Fix the phase classifier (P1, S).** Set `stage-error` only on an explicit
   phase failure/cancel, never from “N failed” counts. Keep partial counts in the
   message.
2. **Add a job summary (P1, S).** Show started/elapsed, overall percent, last
   completed result and a persistent cancelled/failed banner from the job status
   API.
3. **Persist logs server-side (P1, M).** Keep a bounded ring buffer per job and
   return it from `/api/job-status`; the dashboard then reloads with history.
4. **Make grab incremental and concurrent (P1, M/L).** Skip sources that are not
   due, re-grab only stale/missing channels, and bound parallel site batches.
   Re-measure against the 2-minute target.
5. **Correct stage semantics and queue state (P2, S).** Rename Artwork →
   Metadata; show concurrent phases honestly; disable run buttons while running
   or label them “Queue another sync” with a confirmation.
6. **Make failures actionable (P2, M).** Source reliability columns for “fetch
   ok” vs “guide rows”, last error and a filter; unmatched reasons grouped with
   a bulk “Rematch filtered” action.
7. **Explain match confidence (P2, S).** Legend and tooltip for exact/fuzzy
   scores, plus a configurable minimum for “Confirmed”.
