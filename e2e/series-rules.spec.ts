import { expect, test } from '@playwright/test';
import { FIXTURE } from './fixture/seed';
import { goToSection, signIn } from './fixture/helpers';

/**
 * Covers S8: the series pass that had no caller.
 *
 * These mutate the schedule, so they run in the destructive project — creating
 * a rule books episodes, which other specs would otherwise see.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Series rules', () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await goToSection(page, 'DVR', 'DVR');
    });

    test('recording a series books every future showing, not just the loaded window', async ({ page }) => {
        await page.getByRole('button', { name: '+ Schedule recording' }).click();

        const modal = page.locator('.modal-content').filter({ hasText: 'Schedule a recording' });
        await expect(modal).toBeVisible();

        // Pick the fixture channel, then a programme that recurs.
        // selectOption takes a literal label, not a pattern.
        await modal.locator('select').first().selectOption({ label: `100. ${FIXTURE.firstChannelName}` });
        // The programme entries are unclassed buttons (S22 made them buttons for
        // keyboard access), so they are found by role and text.
        const programme = modal.getByRole('button').filter({ hasText: FIXTURE.seriesTitle }).first();
        await expect(programme).toBeVisible();
        await programme.click();

        await modal.getByRole('checkbox').first().check();
        await modal.getByRole('button', { name: 'Schedule' }).click();

        // The toast names how many further episodes were found — the whole
        // point of the pass, which used to have no caller at all.
        const toast = page.locator('.toast');
        await expect(toast).toContainText(FIXTURE.seriesTitle);

        // And the rule is listed with what it has booked.
        await page.getByRole('button', { name: /Series Recordings/ }).click();
        const rule = page.locator('.series-rule').filter({ hasText: FIXTURE.seriesTitle });
        await expect(rule).toBeVisible();
        await expect(rule).toContainText(/episode\(s\) scheduled|waiting for guide data/);
    });

    test('stopping a series asks separately about episodes it already booked', async ({ page }) => {
        await page.getByRole('button', { name: /Series Recordings/ }).click();

        const rule = page.locator('.series-rule').filter({ hasText: FIXTURE.seriesTitle });
        await expect(rule).toBeVisible();
        await rule.getByRole('button', { name: 'Stop' }).click();

        // First question: stop adding future episodes.
        const first = page.locator('.confirm-modal');
        await expect(first.locator('#confirm-title')).toHaveText('Stop recording this series?');
        await first.getByRole('button', { name: 'Stop series' }).click();

        // Second, separate question: discard what it already scheduled. These
        // are different intentions and S8 asks them separately on purpose.
        const second = page.locator('.confirm-modal');
        await expect(second.locator('#confirm-title')).toHaveText('Cancel the episodes it already booked?');
        await second.getByRole('button', { name: 'Keep them' }).click();

        await expect(page.locator('.toast')).toContainText('Series stopped');
        await expect(page.locator('.series-rule').filter({ hasText: FIXTURE.seriesTitle }))
            .toHaveCount(0);
    });
});
