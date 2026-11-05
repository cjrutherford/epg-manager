import { test, expect } from '@playwright/test';
import { signIn } from '../fixture/helpers';

/**
 * Visual baselines.
 *
 * These run in the opt-in `visual` project: antialiasing and font rasterisation
 * differ between machines, so a baseline generated on the Linux CI image is not
 * meaningful on macOS. The functional suite remains the blocking gate; this
 * project catches token/theme drift on the two screens that are most sensitive
 * to it.
 *
 * Regenerate with:
 *   npx playwright test e2e/visual --project=visual --update-snapshots
 */
const THEMES = ['cinematic-noir', 'daylight', 'high-contrast', 'tuner-daemon', 'midnight-forest'];

test.describe('Visual baselines', () => {
    test('login screen in every supported theme', async ({ page }) => {
        test.setTimeout(60_000);
        for (const theme of THEMES) {
            await page.goto('/admin');
            await page.evaluate(t => {
                document.body.className = document.body.className.replace(/theme-[\w-]+/g, '').trim() + ` theme-${t}`;
            }, theme);
            await page.waitForTimeout(250);
            await expect(page.locator('.login-form')).toHaveScreenshot(`login-${theme}.png`, {
                animations: 'disabled',
                maxDiffPixelRatio: 0.01
            });
        }
    });

    test('settings screen keeps its section layout and save bar', async ({ page }) => {
        await signIn(page);
        await page.goto('/admin/settings');
        await expect(page.locator('.page-header h1')).toHaveText('Settings');
        await expect(page.locator('.settings-save-bar')).toBeVisible();
        await expect(page.locator('.settings-page')).toHaveScreenshot('settings.png', {
            animations: 'disabled',
            maxDiffPixelRatio: 0.01,
            mask: [page.locator('.metadata-section'), page.locator('.toast-container')]
        });
    });
});
