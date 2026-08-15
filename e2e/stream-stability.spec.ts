import { test, expect } from '@playwright/test';

/**
 * Requires a real, playing stream — the fixture's URLs deliberately point
 * nowhere, so this cannot run against it. Set E2E_STREAM_URL to a live HLS
 * source to exercise it; otherwise it is skipped rather than left to fail and
 * be ignored, which is how a suite stops meaning anything.
 */
test.skip(!process.env.E2E_STREAM_URL, 'set E2E_STREAM_URL to run the 5-minute stability check');

test.describe('Live Stream Stability E2E (5+ Minutes)', () => {
    test.setTimeout(360000); // 6 minutes timeout

    test('watch interface stream plays continuously for 5+ minutes without stopping', async ({ page }) => {
        let keepAlivePings = 0;
        let lastTime = 0;
        let timeAdvances = 0;

        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('HLS') || text.includes('Watchdog') || text.includes('error')) {
                console.log('BROWSER LOG:', text);
            }
        });

        page.on('pageerror', err => {
            console.error('BROWSER ERROR:', err.message);
        });

        // Track keepalive requests
        page.on('request', req => {
            if (req.url().includes('/api/stream/keepalive/')) {
                keepAlivePings++;
            }
        });

        console.log('Navigating to watch interface...');
        await page.goto('/watch');
        await page.waitForSelector('.video-container', { timeout: 30000 });

        // Wait for video element
        const video = page.locator('video');
        await expect(video).toBeVisible({ timeout: 15000 });

        console.log('Waiting for live stream to start playing...');
        await page.waitForFunction(() => {
            const v = document.querySelector('video') as HTMLVideoElement;
            return v && !v.paused && v.currentTime > 0;
        }, { timeout: 30000 });

        console.log('Live stream actively playing. Monitoring stability for 5.5 minutes (330s)...');

        // Sample video playback every 10 seconds for 330 seconds (5.5 minutes)
        const sampleIntervalSec = 10;
        const totalDurationSec = 330;
        const totalSamples = Math.floor(totalDurationSec / sampleIntervalSec);

        for (let i = 1; i <= totalSamples; i++) {
            await page.waitForTimeout(sampleIntervalSec * 1000);

            const currentTime = await page.evaluate(() => {
                const v = document.querySelector('video') as HTMLVideoElement;
                return v ? v.currentTime : -1;
            });

            const isPaused = await page.evaluate(() => {
                const v = document.querySelector('video') as HTMLVideoElement;
                return v ? v.paused : true;
            });

            console.log(`[Sample ${i}/${totalSamples} @ ${i * sampleIntervalSec}s] video.currentTime: ${currentTime.toFixed(2)}s | paused: ${isPaused} | keepAlive pings: ${keepAlivePings}`);

            expect(isPaused).toBe(false);
            expect(currentTime).toBeGreaterThan(lastTime);

            lastTime = currentTime;
            timeAdvances++;
        }

        console.log(`SUCCESS: Stream played continuously for 5.5 minutes! Total time advances verified: ${timeAdvances}, Total keepAlive pings: ${keepAlivePings}`);
        expect(keepAlivePings).toBeGreaterThan(15);
    });
});
