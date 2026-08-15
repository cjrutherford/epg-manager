import { expect, test } from '@playwright/test';
import { FIXTURE } from './fixture/seed';
import { goToSection, signIn } from './fixture/helpers';

/**
 * Covers S23: errors survive long enough to read, and the native confirm is
 * gone.
 *
 * The old blanket timeout was four seconds, so these deliberately wait longer
 * than that — a passing run means the message really did persist rather than
 * being caught in time.
 */
test.describe('Feedback', () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test('an error stays on screen well past the old four-second timeout', async ({ page }) => {
        await goToSection(page, 'Channels', 'Channels');

        // Make a save fail without touching the server: the request never
        // completes, which is what a dead server looks like to the client.
        await page.route('**/api/override', route => route.abort('failed'));

        await page.locator('tbody button:has-text("Edit")').first().click();
        const search = page.getByLabel('Search EPG channels to map');
        await expect(search).toBeVisible();

        // Clearing a mapping goes through the same failing route.
        await page.getByRole('button', { name: /Clear EPG Match/i }).click();

        const toast = page.locator('.toast-error');
        await expect(toast).toBeVisible();

        await page.waitForTimeout(9000);
        await expect(toast).toBeVisible();

        // It is dismissible, and has no countdown bar to imply otherwise.
        await toast.locator('.toast-close').click();
        await expect(toast).toHaveCount(0);
    });

    test('a success does not linger', async ({ page }) => {
        await goToSection(page, 'DVR', 'DVR');
        await page.getByRole('button', { name: /Recording Settings/ }).click();
        await page.getByRole('button', { name: 'Save settings' }).click();

        const toast = page.locator('.toast-success');
        await expect(toast).toBeVisible();
        await expect(toast).toHaveCount(0, { timeout: 15000 });
    });

    test('confirmation is an in-app dialog, never a browser one', async ({ page }) => {
        let nativeDialogs = 0;
        page.on('dialog', async dialog => { nativeDialogs++; await dialog.dismiss(); });

        await goToSection(page, 'DVR', 'DVR');

        const card = page.locator('.recording-card')
            .filter({ hasText: FIXTURE.scheduledRecordingTitle });
        await card.getByRole('button', { name: 'Cancel' }).click();

        const dialog = page.locator('.confirm-modal');
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAttribute('role', 'dialog');
        await expect(dialog).toHaveAttribute('aria-modal', 'true');

        // The title is a question and the body says what will happen.
        await expect(dialog.locator('#confirm-title')).toHaveText('Cancel this scheduled recording?');
        await expect(dialog.locator('#confirm-message')).not.toBeEmpty();

        // Escape closes it and nothing is cancelled.
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(card).toBeVisible();

        expect(nativeDialogs).toBe(0);
    });

    test('the confirm dialog keeps keyboard focus inside itself', async ({ page }) => {
        await goToSection(page, 'DVR', 'DVR');
        await page.locator('.recording-card')
            .filter({ hasText: FIXTURE.scheduledRecordingTitle })
            .getByRole('button', { name: 'Cancel' }).click();

        const dialog = page.locator('.confirm-modal');
        await expect(dialog).toBeVisible();

        for (let i = 0; i < 12; i++) {
            await page.keyboard.press('Tab');
        }

        const inside = await dialog.evaluate(el => el.contains(document.activeElement));
        expect(inside).toBe(true);
    });
});
