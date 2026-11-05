# Design operations
How Tuner Daemon keeps its interface coherent after the initial design pass:
contribution, versioning, deprecation, review and release. The contract page
`docs/component-contracts.html` defines what a component is; this document is
the process for changing it.

**Owner:** front-end lead. **Reviewers:** product designer, QA/accessibility,
and the backend engineer when failure states or performance are involved.
## 1. Contributing a component or visual variant
**Reuse first.** Check `docs/component-contracts.html` and
`client/src/app/shared/` for `app-state`, `app-status-badge`, `app-modal`,
`app-skeleton`, `app-page-header`, `data-table.css` and the `.btn`, `.input`,
`.badge`, `.glass-card` primitives. Tokens live in `client/src/styles.css`; a raw
hex is a defect. A new component is justified only when the existing one cannot
do the job without a prop that changes its meaning; "it looks slightly different"
is a variant request. Record the reason in the PR.

**Contract entry first.** Edit `docs/component-contracts.html` before the code:

- Add a section or row with **Variant**, **Use** and **Contract** columns, listing
  required markup, classes, inputs and semantic tokens.
- Document all states below; data surfaces also need loading via `app-skeleton`.
- Update the page's example if interactive, and add a dated change-log entry (§2).

- **Default** — tokens only; no page-specific overrides.
- **Hover** — pointer feedback; never the only signal for an action.
- **Focus** — `:focus-visible`, 2 px outline, 2 px offset; never `outline: none` alone.
- **Disabled** — 45% opacity, no pointer events, `disabled`/`aria-disabled`; say why nearby.
- **Error** — `aria-invalid`, error text via `aria-describedby`; keep values on failed save.
- **Empty** — name the next action, not the absence; use `app-state` for page-level empties.

**Responsive and accessibility.** Test at 320, 390, 768, 1024 and 1440 px in all
five themes (`cinematic-noir`, `daylight`, `high-contrast`, `tuner-daemon`,
`midnight-forest`); no horizontal page scroll or clipped primary action. Tables
reflow to labelled cards below 768 px (`.data-table`). Automated floor:
```bash
npx playwright test e2e/a11y.spec.ts e2e/aria.spec.ts --project=e2e
npx playwright test e2e/ux.spec.ts e2e/keyboard.spec.ts --project=e2e
npx playwright test e2e/tv.spec.ts --project=tv
```
Zero axe serious/critical findings. Icon-only controls have accessible names;
touch targets are at least 44 × 44 px; motion respects `prefers-reduced-motion`;
colour is never the only signal.

**Visual baseline.** Add the state to `e2e/visual/visual.spec.ts` and generate
the baseline on the Linux CI image:
```bash
npx playwright test e2e/visual --project=visual --update-snapshots
```
Snapshots live in `e2e/visual/visual.spec.ts-snapshots/`. A baseline update is a
reviewed change, not a test fix: attach before/after images to the PR. Existing
baselines cover login in every theme and Settings; theme-sensitive components
must add their own.
### PR checklist
- [ ] Reuse decision recorded; no duplicate variant.
- [ ] Contract entry and change-log line added.
- [ ] Six states implemented and shown in the contract example.
- [ ] Responsive check at 320–1440 px, all five themes.
- [ ] axe serious/critical = 0; focus visible; accessible name present.
- [ ] Keyboard and D-pad path verified; Escape closes overlays.
- [ ] Visual baseline added or intentionally updated, diff attached.
- [ ] `npm run css:check` passes with no new duplicate rules.
- [ ] Screenshots (before/after) and CI run linked in the PR.
- [ ] Ticket and phase named; no unrelated visual changes.
## 2. Component versioning
The design system has its own **DS** version, separate from the app in
`package.json`. The version and dated change log sit at the top of
`docs/component-contracts.html`. **Major** means breaking; **minor** adds a
component, variant, state or token; **patch** fixes without changing markup,
classes, keyboard behaviour or token meaning.

Stable names are the API: `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`,
`.btn-danger`, `.input`, `.field-error`, `.badge`, `.glass-card`, `.data-table`,
`.state`, `.state--error`, `.login-form`, `.settings-page`,
`.settings-save-bar`, `.guide-panel`. Playwright and downstream screens depend on
these; renaming one is breaking even if it looks internal.

Breaking changes:

- Renaming/removing a class above; changing required markup, DOM order, the component selector or input.
- Changing the keyboard contract: focus order, Tab/Shift+Tab, Escape, arrows, Enter/Space, D-pad.
- Changing a token's meaning (e.g. `--color-primary` becoming background-only), even at the same value.
- Removing a required state, changing an accessible name/role, or invalidating baselines without review.

Visual refinements within the same tokens are not breaking but still need a
visual diff and review. Announce breaks with a conventional commit so
release-please bumps the app major and writes the changelog:
```
feat(ds)!: rename .btn-ghost to .btn-quiet

BREAKING CHANGE: .btn-ghost is removed in DS 2.0; use .btn-quiet.
```
Add the `design-system:breaking` label, announce it in the weekly review, and put
the migration snippet in the contract change log and release notes. Never ship a
breaking selector change in a patch.
## 3. Deprecation
1. **Mark.** Add `@deprecated` JSDoc, `data-deprecated="<replacement>"` on the
   wrapper/selector, and a contract deprecated-table row.
2. **Document the replacement.** Give the old → new mapping and a snippet; update
   the example so new work cannot copy the old form.
3. **Keep it for one minor release.** Deprecated in DS 1.4, earliest removal DS
   1.5 and no earlier than the next app minor; it must keep working.
4. **Remove.** Delete code, contract row and marker; replace usages; add
   **Removed** to `CHANGELOG.md` and the contract log; update baselines.
   Removal is blocked while references remain.

CI enforces removal. In the removal PR, add a step to `.github/workflows/ci.yml`
that greps for the retired selector (the example uses `btn-legacy`); do not grep
`data-deprecated`, because active deprecations legitimately carry that marker:
```yaml
- name: No retired UI remains
  run: |
    ! grep -rn --include='*.ts' --include='*.html' 'btn-legacy' client/src
```
An extension needs front-end lead and designer sign-off in the PR plus a new
removal release in the contract page. Never let a deprecation become permanent
by silence.
## 4. Design review cadence

| Cadence | Attendees | Artifact reviewed | Output |
| --- | --- | --- | --- |
| Weekly, 30 min | Front-end lead (chair), designer, QA/a11y; backend when relevant | One screen, one state: live build or before/after screenshots, contract diff, axe output, viewport captures | Decision in the PR and contract change log |
| Monthly, 45 min | Same plus theme owner | `npm run css:audit`, all five theme contrast results, visual diffs, token changes | Token/theme decisions and a budget trend |
| Quarterly, 90 min | QA/a11y lead, front-end lead, designer | Manual screen-reader, keyboard, D-pad and 200% zoom audit; `e2e/a11y`, `e2e/aria`, `e2e/keyboard`, `e2e/tv` | Report at `docs/ux-review-YYYY-MM.html`; findings into the roadmap |

The weekly agenda is fixed: 5 min context, 15 min artifact review, 5 min decision,
5 min owner/date. One screen, one state, one decision; no decision means no merge.


## Release on merge

Merging to `main` is the release trigger. `.github/workflows/release-on-merge.yml`
waits for the CI workflow to succeed, then:

1. derives the bump from conventional commits since the last tag
   (`BREAKING CHANGE` → major, `feat:` → minor, otherwise patch);
2. writes the version with `scripts/set-version.ts` and verifies every version
   file agrees;
3. commits `chore(release): vX.Y.Z [skip ci]`, pushes the commit and the tag;
4. dispatches `release.yml` on that tag.

There is no release PR and no approval step. `release.yml` still runs the full
verification, publishes the Docker image, builds the APKs and creates the GitHub
release. The bot needs permission to push the release commit to `main`; if branch
protection forbids that, the workflow fails loudly rather than silently skipping
the release.

## 5. Release discipline
Every release, including patches, runs the UX gate before the tag:
```bash
npm run build && npm run build:client
npm test && npm run css:check
npx playwright test e2e/a11y.spec.ts e2e/aria.spec.ts e2e/ux.spec.ts \
  e2e/keyboard.spec.ts e2e/perf.spec.ts --project=e2e
npx playwright test e2e/tv.spec.ts --project=tv && npm run test:visual
```
`npm run css:check` fails below the 20% initial-CSS reduction or on any exact
duplicate rule; `npm run css:audit` prints per-route numbers. Visual baselines run
on the Linux CI image where generated; `npm run test:cross-browser` remains a
separate smoke job.

Attach evidence to the release (release notes or the release PR): CI run URL and
Playwright report for any retry; `css:audit` initial bytes per route and duplicate
count; the visual diff and any accepted baseline; axe summary (0 serious/critical)
and keyboard/TV results; contract change-log lines; open P1/P2 count. A release
with an open P1/P2 does not ship.

No silent scope creep: every UI change maps to a roadmap ticket or reviewed
contract change. Extra work gets a new Phase 4 backlog ticket (capped at twenty)
and gate-level justification; it does not ride along. The checklist is not
editable per release — change this document first.
## 6. Dashboard, scorecard and the roadmap
The monthly scorecard is the evidence ledger; the quality dashboard (Phase 4,
ticket 17) is its durable, linkable view. The scorecard format in
`docs/gate-2-usability-kit.md` records participants, task success, rescues, SUS,
time on task and error recovery. The dashboard adds automated signals:

| Signal | Source | 10 target |
| --- | --- | --- |
| SUS / task success | Monthly study | ≥85 / ≥95% |
| axe / Lighthouse accessibility | `e2e/a11y.spec.ts`, CI or manual run | 0 / 100 |
| Keyboard, SR and D-pad coverage | `e2e/keyboard.spec.ts`, `e2e/tv.spec.ts`, quarterly audit | All flows |
| Guide frame rate | `e2e/perf.spec.ts` | 60 fps at 1,000+ channels |
| Initial CSS / responsive overflow | `npm run css:audit`, `e2e/ux.spec.ts` | 20% down / 0 at 320–1440 px |
| P1/P2 findings | Review log | 0 for two releases |

Data is generated from CI and study records, never hand-copied; each row links to
its run or report. Monthly, compare the dashboard with the targets in
`docs/ux-roadmap-to-10.html` (Measurement). A red signal opens or reorders a
backlog item with an owner and date; green for two consecutive releases is closed
in the gate review, not deleted. P1/P2 findings are triaged the same day; P3s
enter the next phase. A two-month miss escalates to the gate review and can block
Gate 4, which requires two clean releases, SUS ≥85, task success ≥95%, zero
serious axe issues, a completed manual screen-reader audit, and design-system
adoption enforced in CI. Targets change only by a signed-off roadmap edit, never
by adjusting the dashboard.
