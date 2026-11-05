import { test, expect } from '@playwright/test';
import { signIn } from './fixture/helpers';

/**
 * Runtime locale and RTL shell.
 *
 * Arabic is the RTL proof: the document direction changes before hydration,
 * the shell mirrors, and the guide keeps its LTR time axis. Switching back to
 * English must restore the LTR document without a reload.
 */
test.describe('Locale and RTL', () => {
    test('Arabic mirrors the shell and English restores it', async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('tuner_daemon_locale', 'ar'));
        await page.goto('/admin');

        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(page.getByRole('button', { name: 'تسجيل الدخول' })).toBeVisible();

        await signIn(page);
        await expect(page.getByRole('link', { name: 'لوحة التحكم' })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

        const language = page.locator('.sidebar-footer .lang-select');
        await language.selectOption('en');
        await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
        await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    });

    test('Arabic admin fits 390px without horizontal overflow', async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('tuner_daemon_locale', 'ar'));
        await signIn(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/admin/dashboard');
        await expect(page.locator('.page-header h1')).toBeVisible({ timeout: 15000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    });

    test('Arabic Watch keeps the guide axis left-to-right', async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('tuner_daemon_locale', 'ar'));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/watch');
        await page.waitForTimeout(1800);
        await page.keyboard.press('g');
        await expect(page.locator('.guide-panel')).toBeVisible({ timeout: 10000 });

        const direction = await page.locator('.guide-panel').evaluate(el => getComputedStyle(el).direction);
        expect(direction).toBe('ltr');
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    });
});
