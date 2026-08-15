import { expect, test } from '@playwright/test';
import { FIXTURE } from './fixture/seed';
import { goToSection, signIn } from './fixture/helpers';

/**
 * Covers S9: a missed window is not a failure, failures explain themselves,
 * and padding and retention are settable.
 *
 * All of this was verified once by hand against a live server. These are the
 * assertions that make it stay true.
 */
// Retrying a recording and saving settings both change state other specs read,
// so these run serially in the destructive project.
test.describe.configure({ mode: 'serial' });

test.describe('DVR lifecycle', () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await goToSection(page, 'DVR', 'DVR');
    });

    const cardFor = (page: import('@playwright/test').Page, title: string) =>
        page.locator('.recording-card').filter({ hasText: title });

    test('a missed window says so, and does not offer a pointless retry', async ({ page }) => {
        const card = cardFor(page, FIXTURE.missedRecordingTitle);
        await expect(card).toBeVisible();

        // "Missed", not "Failed" — the distinction S9 exists for.
        await expect(card.locator('.badge')).toHaveText('Missed');
        await expect(card.locator('.recording-error')).toContainText('window closed');

        // Its window is long past, so retrying could not record anything.
        await expect(card.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    });

    test('a missed reason is not painted as an error', async ({ page }) => {
        const missed = cardFor(page, FIXTURE.missedRecordingTitle).locator('.recording-error');
        const failed = cardFor(page, FIXTURE.retryableRecordingTitle).locator('.recording-error');

        const colourOf = (locator: typeof missed) =>
            locator.evaluate(el => getComputedStyle(el).color);

        expect(await colourOf(missed)).not.toBe(await colourOf(failed));
    });

    test('a failure names its cause and can be retried while the window is open', async ({ page }) => {
        const card = cardFor(page, FIXTURE.retryableRecordingTitle);
        await expect(card).toBeVisible();
        await expect(card.locator('.badge')).toHaveText('Failed');

        // A reason a person can act on, not "Output file not found".
        await expect(card.locator('.recording-error')).toContainText('could not be reached');

        const retry = card.getByRole('button', { name: 'Try again' });
        await expect(retry).toBeVisible();
        await retry.click();

        await expect(page.locator('.toast')).toContainText('Back on the schedule');
        await expect(cardFor(page, FIXTURE.retryableRecordingTitle).locator('.badge'))
            .not.toHaveText('Failed');
    });

    test('recording settings round-trip through the API', async ({ page }) => {
        await page.getByRole('button', { name: /Recording Settings/ }).click();

        const startPadding = page.getByLabel('Start recording early')
            .or(page.locator('.dvr-setting:has-text("Start recording early") input'));
        await startPadding.first().fill('45');

        await page.getByRole('button', { name: 'Save settings' }).click();
        await expect(page.locator('.toast')).toContainText('DVR settings saved');

        await page.reload();
        await page.getByRole('button', { name: /Recording Settings/ }).click();
        await expect(startPadding.first()).toHaveValue('45');
    });
});
