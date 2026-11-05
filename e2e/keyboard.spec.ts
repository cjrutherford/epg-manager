import { test, expect } from '@playwright/test';
import { signIn } from './fixture/helpers';

/**
 * Keyboard and D-pad paths.
 *
 * Gate 2 asks for a complete remote/keyboard path, not only axe-clean markup.
 * These checks cover the two surfaces that matter most: admin navigation and
 * the guide/player. Arrow-key movement is provided by spatial-navigation-js in
 * Watch; Enter activation is implemented on the guide cells themselves.
 */
test.describe('Keyboard and D-pad', () => {
    test('admin navigation is operable with the keyboard', async ({ page }) => {
        await signIn(page);
        const sources = page.locator('.nav-item', { hasText: 'Sources' });
        await sources.focus();
        await expect(sources).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('.page-header h1')).toHaveText('Sources');
    });

    test('guide channels and programmes are focusable and activatable', async ({ page }) => {
        await page.goto('/watch');
        await page.waitForTimeout(2000);
        await page.keyboard.press('g');
        await expect(page.locator('.guide-panel')).toBeVisible({ timeout: 10000 });

        const channel = page.locator('.guide-channel').first();
        await expect(channel).toHaveAttribute('tabindex', '-1');
        await expect(channel).toHaveAttribute('role', 'button');
        await expect(channel).toBeFocused();

        const before = await page.locator('.cib-channel-name').innerText().catch(() => '');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        const after = await page.locator('.cib-channel-name').innerText().catch(() => '');
        expect(after.length).toBeGreaterThan(0);

        // D-pad movement must stay inside the guide rather than falling to body.
        await channel.focus();
        for (const key of ['ArrowDown', 'ArrowRight', 'ArrowLeft', 'ArrowUp']) {
            await page.keyboard.press(key);
            await page.waitForTimeout(120);
            const inGuide = await page.evaluate(() => !!document.activeElement?.closest('.guide-panel'));
            expect(inGuide, `${key} keeps focus inside the guide`).toBe(true);
        }

        // A programme opens the recording menu; Escape returns to the programme.
        const program = page.locator('.guide-program').first();
        await expect(program).toHaveAttribute('tabindex', '-1');
        await program.focus();
        await page.keyboard.press('Enter');
        const menu = page.locator('.context-menu');
        await expect(menu).toBeVisible();
        await expect(menu.locator('button').first()).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(page.locator('.guide-panel')).toBeVisible();
        await expect(program).toBeFocused();
    });

    test('large text and high contrast keep the primary controls on screen', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto('/admin');
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            document.body.className = document.body.className.replace(/theme-[\w-]+/g, '').trim() + ' theme-high-contrast';
            document.documentElement.style.fontSize = '18px';
        });
        await expect(page.locator('.login-form')).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(1);
    });
});

test.describe('Touch wake', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('a tap wakes the lower-third controls after idle', async ({ page }) => {
        await page.goto('/watch');
        await page.waitForTimeout(2200);
        await page.touchscreen.tap(200, 300);
        const lowerThird = page.locator('.channel-info-block');
        await expect(lowerThird).not.toHaveClass(/ui-hidden/);

        await page.waitForTimeout(3600);
        await expect(lowerThird).toHaveClass(/ui-hidden/);

        await page.touchscreen.tap(200, 300);
        await expect(lowerThird).not.toHaveClass(/ui-hidden/);
        await expect(page.locator('button[title="Toggle Guide"]')).toBeVisible();
    });
});
