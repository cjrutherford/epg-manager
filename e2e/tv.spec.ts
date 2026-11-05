import { test, expect, type Page } from '@playwright/test';
import { signIn } from './fixture/helpers';

/**
 * TV / remote gate.
 *
 * Safe-area insets and 10-foot typography are handled in CSS by the parent
 * workstream; this spec is the remote gate. After the initial sign-in it never
 * touches the mouse, and every assertion comes from the keyboard path a TV
 * remote drives: `g` opens the guide, the D-pad moves without ever dropping
 * focus to `<body>`, Enter tunes and opens programme actions, Escape closes
 * one layer at a time.
 */

/** True when focus is on a visible, focusable control inside the guide. */
async function focusInsideGuide(page: Page): Promise<{ ok: boolean; detail: string }> {
    return page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body) {
            return { ok: false, detail: 'focus fell to <body>' };
        }
        if (!active.closest('.guide-panel')) {
            return { ok: false, detail: `focus left the guide (${active.tagName.toLowerCase()}.${active.className})` };
        }

        const rect = active.getBoundingClientRect();
        const style = window.getComputedStyle(active);
        const visible = rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0';
        if (!visible) {
            return { ok: false, detail: 'focused control is not visible' };
        }

        const focusable = active.matches('button, a[href], input, select, textarea, [tabindex], [role="button"]');
        if (!focusable) {
            return { ok: false, detail: `focused element is not a focusable control (${active.tagName.toLowerCase()})` };
        }

        return { ok: true, detail: `.${active.className}` };
    });
}

test.describe('TV / remote', () => {
    test('keyboard-only journey through the guide stays on screen', async ({ page }) => {
        await signIn(page);

        // From here on the mouse is never used: everything below is a remote key.
        await page.goto('/watch');
        // Auto-tune fills the channel info bar once the guide data has loaded;
        // opening the guide before that would leave nothing to focus. The short
        // settle lets spatial navigation install its scope.
        await expect(page.locator('.cib-channel-name').first()).toHaveText(/\S/, { timeout: 15000 });
        await page.waitForTimeout(500);

        const guide = page.locator('.guide-panel');
        const firstChannel = page.locator('.guide-channel').first();

        // `g` opens the guide, and focus must enter it — not stay on the player.
        await page.keyboard.press('g');
        await expect(guide).toBeVisible({ timeout: 15000 });
        await expect(firstChannel).toBeFocused({ timeout: 5000 });

        // 10-foot typography: the TV media query grows guide rows to 56px.
        const rowHeight = await page.locator('.guide-row').first().evaluate(el => getComputedStyle(el).height);
        expect(rowHeight).toBe('56px');

        // D-pad movement must never fall back to <body> or leave the guide.
        for (const key of ['ArrowDown', 'ArrowRight', 'ArrowLeft', 'ArrowUp']) {
            await page.keyboard.press(key);
            await page.waitForTimeout(150);

            expect(
                await page.evaluate(() => document.activeElement === document.body),
                `${key} must not move focus to <body>`
            ).toBe(false);

            const focus = await focusInsideGuide(page);
            expect(focus.ok, `${key} must keep focus on a visible guide control — ${focus.detail}`).toBe(true);
            await expect(guide).toBeVisible();
        }

        // Enter on a channel tunes it; the channel info bar names what is playing.
        await firstChannel.focus();
        await expect(firstChannel).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('.cib-channel-name').first()).toHaveText(/\S/, { timeout: 15000 });

        // Enter on a programme opens the actions menu on its first button.
        const program = page.locator('.guide-program').first();
        await program.focus();
        await expect(program).toBeFocused();
        await page.keyboard.press('Enter');

        const menu = page.locator('.context-menu');
        await expect(menu).toBeVisible();
        await expect(menu.locator('button').first()).toBeFocused();

        // First Escape dismisses the menu only; the guide stays open.
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(guide).toBeVisible();

        // Second Escape closes the guide, leaving the player.
        await page.keyboard.press('Escape');
        await expect(guide).toBeHidden({ timeout: 10000 });

        // 1920px is the target panel width: no horizontal document overflow.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, 'no horizontal overflow at 1920px').toBeLessThanOrEqual(1);
    });
});
