import { test, expect } from '@playwright/test';
import { signIn } from './fixture/helpers';

/**
 * ARIA contract checks.
 *
 * Gate 2 accepts automated ARIA evidence in place of a manual screen-reader
 * session for this environment. These assertions cover the roles and names a
 * screen reader needs to announce on the two core surfaces: the guide/player
 * and the admin shell.
 */
test.describe('ARIA contract', () => {
    test('guide and player expose named controls', async ({ page }) => {
        await page.goto('/watch');
        await page.waitForTimeout(2000);
        await page.keyboard.press('g');
        await expect(page.locator('.guide-panel')).toBeVisible({ timeout: 10000 });

        await expect(page.getByRole('button', { name: /Tune to channel/ }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: /Open recording actions/ }).first()).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Search the guide' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Earlier in the guide' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Later in the guide' })).toBeVisible();

        await expect(page.getByLabel('Live TV player')).toBeVisible();
        await expect(page.getByLabel('Live TV stream')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Mute or unmute' })).toBeVisible();
    });

    test('admin shell exposes its navigation and page heading', async ({ page }) => {
        await signIn(page);
        for (const name of ['Dashboard', 'Channels', 'Sources', 'Recordings', 'Guide & matching', 'Settings']) {
            await expect(page.getByRole('link', { name })).toBeVisible();
        }
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
    });
});
