import { expect, test } from '@playwright/test';
import { FIXTURE } from '../fixture/seed';

/**
 * A recorded walkthrough for the documentation.
 *
 * This is not a regression test — it exists to produce a video, so it moves at
 * a readable pace and narrates itself through the page rather than asserting
 * exhaustively. It still asserts enough that a broken UI produces a broken
 * recording rather than a misleading one.
 *
 * Run it on its own:
 *   npx playwright test e2e/docs --project=docs
 */
test.use({
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
});

/** Long enough to follow on screen without being tedious. */
const BEAT = 900;

async function beat(page: import('@playwright/test').Page, ms = BEAT) {
    await page.waitForTimeout(ms);
}

test('a tour of the admin interface', async ({ page }) => {
    // ── Sign in ──
    await page.goto('/admin');
    const password = page.locator('input[type="password"]').first();
    await expect(password).toBeVisible({ timeout: 15000 });
    await beat(page);

    await password.fill(FIXTURE.adminPassword);
    await beat(page, 400);
    await page.locator('button[type="submit"], .login-form button').first().click();

    // ── Dashboard ──
    await expect(page.locator('.page-header h1')).toHaveText('Dashboard', { timeout: 15000 });
    await expect(page.locator('.stat').first()).toBeVisible();
    await beat(page, 1600);

    // ── Channels ──
    await page.getByRole('link', { name: 'Channels' }).click();
    await expect(page.locator('.page-header h1')).toHaveText('Channels');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await beat(page, 1200);

    // Filtering, which is the thing people actually do here.
    const filter = page.getByLabel('Filter channels by name or category');
    await filter.fill('AAA');
    await beat(page, 1200);
    await expect(page.getByText(FIXTURE.firstChannelName)).toBeVisible();
    await beat(page);
    await filter.fill('');
    await beat(page, 600);

    // ── Sources ──
    await page.getByRole('link', { name: 'Sources' }).click();
    await expect(page.locator('.page-header h1')).toHaveText('Sources');
    await expect(page.locator('.stat').first()).toBeVisible();
    await beat(page, 1600);

    // ── DVR ──
    await page.getByRole('link', { name: 'DVR' }).click();
    await expect(page.locator('.page-header h1')).toHaveText('DVR');
    await beat(page, 1400);

    // ── EPG & Matches ──
    await page.getByRole('link', { name: 'EPG & Matches' }).click();
    await expect(page.locator('.page-header h1')).toHaveText('EPG & Matches');
    await expect(page.locator('.stat').first()).toBeVisible();
    await beat(page, 1600);

    // ── Settings ──
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.locator('.page-header h1')).toHaveText('Settings');
    await beat(page, 1600);
});
