# Gate 2 — usability and accessibility kit

Gate 2 is a **validation gate**, not only an engineering gate. The code can make
the paths available and measure the floor; the threshold itself needs five to
eight first-time participants. This document is the protocol, the scorecard and
the current evidence state.

## Gate 2 definition

- SUS ≥ 80.
- Task success ≥ 85% with no moderator rescue.
- Screen-reader and D-pad paths complete.
- Zero serious axe issues.
- Lighthouse accessibility ≥ 95.
- No P1/P2 open.
- First sync under 2 minutes on a clean install.

## Study setup

- **Participants:** 5–8 people who have not used Tuner Daemon. Mix of technical
  and non-technical; at least one screen-reader user and one keyboard-only user.
- **Session:** 30–40 minutes, remote or in person, think-aloud.
- **Moderator:** reads the task, does not point, does not rescue. A rescue is
  recorded as a task failure even if the participant eventually finishes.
- **Recording:** screen and audio with consent. Do not record credentials.
- **Environment:** the review fixture (`DB_DIR=.e2e-fixture` or the review
  database), not a production instance. Use the failure fixture for task 4.
- **Order:** rotate task order between participants to reduce learning effects.

## Tasks

| # | Task | Success looks like | Failure / rescue |
|---|---|---|---|
| 1 | Add a source | Opens Sources, adds a preset or custom playlist, saves, runs a sync, sees channels | Cannot find the playlist controls, saves the wrong page, needs help to start sync |
| 2 | Find why a channel has no guide | Starts from a channel with no guide, finds the source health or matching reason, explains it back | Opens the wrong screen, guesses, needs a pointer |
| 3 | Schedule a recording | Finds a programme, schedules it, sees it in Recordings with a scheduled state | Cannot find the schedule action or loses the confirmation |
| 4 | Recover a failed stream | Sees the failure, understands it, retries or returns to the guide within 15 seconds | Black screen with no explanation, no retry, needs rescue |

Record per task: success (yes/no), time, errors, rescue (yes/no), quotes.

## SUS

Use the standard 10-item SUS questionnaire after the tasks. Score with the
standard odd/even formula and multiply by 2.5. Report the mean and range; do not
round a single score up to the threshold.

## Scorecard template

| Participant | Task 1 | Task 2 | Task 3 | Task 4 | Success | Rescues | SUS | Notes |
|---|---|---|---|---|---|---|---|---|
| P1 | | | | | | | | |
| P2 | | | | | | | | |
| P3 | | | | | | | | |
| P4 | | | | | | | | |
| P5 | | | | | | | | |
| **Mean** | | | | | | | | |

Report separately: task success rate, mean time per task, error-recovery rate,
SUS mean, and every rescue verbatim.

## Accessibility protocol

1. **Screen reader:** NVDA + Firefox on Windows, or VoiceOver + Safari on macOS.
   Walk the guide and player: open guide, move between channels and programmes,
   read the current programme, schedule a recording, close the guide.
2. **Keyboard only:** unplug the mouse. Sign in, reach every admin screen, add a
   source, open Watch, open the guide, tune a channel, open a programme menu,
   close it with Escape, leave the guide.
3. **D-pad:** use the arrow keys as a remote. Confirm focus never falls to the
   page body and that Enter activates the focused control.
4. **Large text:** browser zoom 200% at 390 px and 1440 px. No horizontal page
   overflow; no clipped primary action.
5. **High contrast:** run the High Contrast theme through tasks 1–4.
6. **Reduced motion:** `prefers-reduced-motion: reduce`; no essential information
   depends on animation.

The automated floor is `npx playwright test e2e/a11y.spec.ts e2e/keyboard.spec.ts
--project=e2e --workers=1`, plus `npm run css:audit`.

## Cross-device matrix

| Target | How | Status |
|---|---|---|
| Chrome desktop | Main Playwright suite | Passing |
| Firefox desktop | `npm run test:cross-browser` | Harness ready; blocked by this host (Playwright does not support Firefox on Ubuntu 26.04) |
| Safari / WebKit | `npm run test:cross-browser` | Harness ready; same host limitation |
| Android shell | `npm run build:mobile` + device run | Needs a device/emulator |
| 320 / 390 / 768 / 1024 / 1440 | Viewport matrix in `e2e/ux.spec.ts` | Passing |
| TV / 10-foot | Remote-only run on a TV or TV emulator | Needs hardware |

## First-sync benchmark

On a clean database:

1. Start the server with an empty `DB_DIR`.
2. Add the smallest supported playlist and guide pair.
3. Start a full sync and record wall-clock time until the channel list is ready.
4. Repeat three times; report the median.

Target: under 120 seconds. Record source size and network conditions alongside
the number, or the result is not comparable.

## Current evidence

| Item | Status |
|---|---|
| axe serious/critical | **0** — full a11y suite |
| Lighthouse accessibility | **100** on Watch and Login |
| Viewport overflow 320–1440 | **0** — matrix test |
| Theme contrast | **5/5 themes pass WCAG AA** |
| Keyboard guide path | **Passing** — open, arrow, Enter, programme menu, Escape |
| D-pad focus containment | **Passing** — arrows stay in the guide while it is open |
| Screen reader manual pass | **Not run** — needs NVDA/VoiceOver |
| Cross-browser Firefox/WebKit | **Blocked on host** — browser installation unsupported |
| SUS / task success | **Not run** — needs participants |
| First sync timing | **Not measured** on clean install |

## Exit rule

Gate 2 closes only when the two human lines (SUS/task success and screen-reader
pass) and the hardware lines have evidence attached to this document. An
automated green suite is necessary but not sufficient.
