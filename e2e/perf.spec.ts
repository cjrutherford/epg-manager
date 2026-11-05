import { test, expect, type Page } from '@playwright/test';
import { signIn } from './fixture/helpers';

// Two frame loops running at once would make each sample depend on the other
// test's CPU load, so keep the measurements sequential.
test.describe.configure({ mode: 'serial' });

/**
 * Performance regression guards.
 *
 * The thresholds here are deliberately loose. They exist to catch catastrophic
 * regressions on shared CI hardware — a guide that starts dropping every other
 * frame, or a theme switch that stalls the main thread — not to certify the
 * 60fps / 1,000-channel budget from the roadmap. That budget needs a trace on
 * reference hardware; a shared runner cannot make that claim, and pretending it
 * can would make the suite flaky rather than informative.
 */

/**
 * Wait until Watch has loaded a channel (and therefore guide data).
 *
 * `.cib-channel-name` lives in the channel info card and is populated by
 * `loadGuide()` when it auto-tunes the first channel. Checking its text rather
 * than its visibility avoids racing the idle timer, which hides the card after
 * a few seconds of no input.
 */
async function waitForChannels(page: Page): Promise<void> {
    await expect.poll(
        () => page.evaluate(() => document.querySelector('.cib-channel-name')?.textContent?.trim() ?? ''),
        { timeout: 20000, message: 'wait for Watch to load channels' }
    ).not.toBe('');
}

test.describe('performance guardrails', () => {
    test('guide scrolling keeps a usable frame rate', async ({ page }) => {
        test.setTimeout(60000);

        await signIn(page);
        await page.goto('/watch');
        await waitForChannels(page);

        // `#guideRows` is an Angular template reference, not a DOM id, so it
        // never reaches the document. `.guide-rows` is the rendered container
        // and is the selector the application itself styles as the vertical
        // scroll surface (`overflow-y: auto`).
        await page.keyboard.press('g');
        await expect(page.locator('.guide-panel')).toBeVisible({ timeout: 20000 });
        await expect(page.locator('.guide-rows .guide-row').first()).toBeVisible({ timeout: 20000 });

        const measurement = await page.evaluate(async () => {
            const rows = document.querySelector<HTMLElement>('.guide-rows');
            if (!rows) throw new Error('Could not find the guide row container (.guide-rows)');

            const durationMs = 2000;
            // Two guide rows per step; rows are 44px high in watch.guide.css.
            const stepPx = 88;
            const deltas: number[] = [];
            let scrollSteps = 0;
            let direction = 1;

            rows.scrollTop = 0;

            await new Promise<void>(resolve => {
                let last: number | null = null;
                const started = performance.now();

                const tick = (now: number) => {
                    if (last !== null) deltas.push(now - last);
                    last = now;

                    // Ping-pong through the scroll range so the guide keeps
                    // moving for the full sample even when the viewport can
                    // show most of a short fixture.
                    const maxScroll = Math.max(0, rows.scrollHeight - rows.clientHeight);
                    if (maxScroll > 0) {
                        let next = rows.scrollTop + direction * stepPx;
                        if (next >= maxScroll) {
                            next = maxScroll;
                            direction = -1;
                        } else if (next <= 0) {
                            next = 0;
                            direction = 1;
                        }
                        rows.scrollTop = next;
                        scrollSteps++;
                    }

                    if (now - started < durationMs) requestAnimationFrame(tick);
                    else resolve();
                };

                requestAnimationFrame(tick);
            });

            return {
                deltas,
                scrollSteps,
                scrollHeight: rows.scrollHeight,
                clientHeight: rows.clientHeight,
            };
        });

        const { deltas, scrollSteps, scrollHeight, clientHeight } = measurement;
        const sorted = [...deltas].sort((a, b) => a - b);
        const average = deltas.length > 0
            ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
            : 0;
        // Nearest-rank p95: the smallest interval that is at least as large as
        // 95% of the samples.
        const p95 = sorted.length > 0
            ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
            : 0;
        const longest = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
        const over32 = deltas.filter(value => value > 32).length;

        const summary = {
            frameCount: deltas.length,
            avgMs: Number(average.toFixed(1)),
            p95Ms: Number(p95.toFixed(1)),
            longestMs: Number(longest.toFixed(1)),
            over32Ms: over32,
            scrollSteps,
            scrollHeight,
            clientHeight,
        };

        const report = `[perf] guide scroll: ${JSON.stringify(summary)}`;
        console.log(report);
        test.info().annotations.push({ type: 'perf', description: report });

        // Generous floor: a normal CI machine should comfortably collect about
        // 120 frames here. These assertions catch a guide that has become
        // pathologically slow, not one that misses the 60fps target.
        //
        // p95 alone is a poor guard on a shared runner: with only ~70 samples,
        // one scheduling hiccup moves it a whole frame interval, and a runner
        // painting at 20fps reports exactly 50ms. The average is a steadier
        // signal, and the p95 ceiling only has to catch a slide show.
        expect(summary.frameCount, `frame samples collected during the 2s scroll (${report})`).toBeGreaterThan(30);
        expect(summary.avgMs, `average frame interval (${report})`).toBeLessThan(50);
        expect(summary.p95Ms, `p95 frame interval (${report})`).toBeLessThan(100);
    });

    test('switching to High Contrast paints inside the CI budget', async ({ page }) => {
        test.setTimeout(60000);

        await signIn(page);
        await page.goto('/watch');
        await waitForChannels(page);

        /*
         * Use the body-class contract rather than the theme menu.
         *
         * ThemeService#applyTheme does exactly this: strips every `theme-*`
         * class and adds `theme-<key>` to <body>. Driving it directly removes
         * the player-chrome visibility race from the measurement while still
         * exercising the style recalculation, layout and paint that the menu
         * ultimately triggers.
         */
        const result = await page.evaluate(async () => {
            const body = document.body;

            const clearThemeClasses = () => {
                Array.from(body.classList)
                    .filter(name => name.startsWith('theme-'))
                    .forEach(name => body.classList.remove(name));
            };

            const readTheme = () => {
                const themeClass = Array.from(body.classList).find(name => name.startsWith('theme-'));
                // Cinematic Noir is the default and has no class of its own.
                return themeClass ? themeClass.slice('theme-'.length) : 'cinematic-noir';
            };

            const from = readTheme();

            // A fresh context starts on the default theme, but keep the sample
            // meaningful if something has already selected High Contrast.
            if (from === 'high-contrast') {
                clearThemeClasses();
                void body.offsetHeight;
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            }

            const started = performance.now();
            clearThemeClasses();
            body.classList.add('theme-high-contrast');
            localStorage.setItem('tuner_daemon_theme', 'high-contrast');

            // The second callback runs after the browser has had a chance to
            // style, lay out and paint the frame produced by the class change.
            await new Promise<void>(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });

            return {
                from,
                applied: body.classList.contains('theme-high-contrast'),
                elapsedMs: performance.now() - started,
            };
        });

        const summary = {
            from: result.from,
            applied: result.applied,
            ms: Number(result.elapsedMs.toFixed(1)),
        };

        const report = `[perf] theme switch: ${JSON.stringify(summary)}`;
        console.log(report);
        test.info().annotations.push({ type: 'perf', description: report });

        expect(result.applied, `High Contrast class applied (${report})`).toBe(true);
        // Generous CI ceiling: the real theme budget is much tighter (the
        // roadmap argues for well under 150ms on reference hardware).
        expect(summary.ms, `time to the next two paints (${report})`).toBeLessThan(500);
    });
});
