import { test, expect } from '@playwright/test';
import { signIn } from './fixture/helpers';

/**
 * Cross-browser smoke path.
 *
 * Chrome is the primary suite. This spec runs the same critical path in
 * Firefox and WebKit: sign in, load an admin data screen, open Watch and open
 * the guide. It deliberately avoids codec-dependent assertions.
 */
test('critical path works in every supported engine', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('.page-header h1')).toHaveText('Dashboard');

    await page.goto('/admin/sources');
    await expect(page.locator('.page-header h1')).toHaveText('Sources');
    await expect(page.locator('.source-label').first()).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

    await page.goto('/watch');
    await page.waitForTimeout(2000);
    await page.keyboard.press('g');
    await expect(page.locator('.guide-panel')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.guide-channel').first()).toBeVisible();
});
