import { test, expect } from '@playwright/test';
import { signIn } from './fixture/helpers';

/**
 * Reliability notices.
 *
 * Degradation should be visible without opening a menu: an offline viewer and
 * a stale guide get a status banner above the player, not a silent failure.
 */
test.describe('Reliability notices', () => {
    test('an offline viewer sees a status banner', async ({ page, context }) => {
        await page.goto('/watch');
        await page.waitForTimeout(1200);

        await context.setOffline(true);
        await expect(page.locator('.watch-notice')).toBeVisible();
        await expect(page.locator('.watch-notice')).toContainText("You're offline");
        await expect(page.locator('.watch-notice')).toHaveAttribute('role', 'status');

        await context.setOffline(false);
        await expect(page.locator('.watch-notice')).toBeHidden();
    });

    test('a stale guide offers a path to run a sync', async ({ page }) => {
        await page.route('**/api/has-data', route => route.fulfill({
            json: {
                hasChannels: true,
                hasPrograms: true,
                hasPlaylist: true,
                lastGuideAt: Date.now() - 48 * 60 * 60 * 1000,
                isEmpty: false
            }
        }));

        await page.goto('/watch');
        const notice = page.locator('.watch-notice');
        await expect(notice).toBeVisible();
        await expect(notice).toContainText('Guide data is more than a day old');
        await expect(notice.getByRole('link', { name: 'Run a sync' })).toBeVisible();
    });
});

test.describe('Dashboard degradation notice', () => {
    test('a stale guide is visible above the dashboard and can start a sync', async ({ page }) => {
        await signIn(page);
        await page.route('**/api/has-data', route => route.fulfill({
            json: {
                hasChannels: true,
                hasPrograms: true,
                hasPlaylist: true,
                lastGuideAt: Date.now() - 48 * 60 * 60 * 1000,
                isEmpty: false
            }
        }));
        await page.goto('/admin/dashboard');
        const notice = page.locator('.reliability-notice');
        await expect(notice).toBeVisible();
        await expect(notice).toContainText('Guide data is more than a day old');
        await expect(notice.getByRole('button', { name: 'Run full sync' })).toBeVisible();
    });
});
