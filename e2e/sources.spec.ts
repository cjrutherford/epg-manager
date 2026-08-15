import { expect, test } from '@playwright/test';
import { FIXTURE } from './fixture/seed';
import { goToSection, signIn } from './fixture/helpers';

/**
 * Covers S18: the Sources screen, and the probe-first add flow that was the
 * point of it — you find out what a source really contains before it writes
 * anything.
 */
test.describe('Sources', () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
        await goToSection(page, 'Sources', 'Sources');
    });

    test('summarises both families and filters by them', async ({ page }) => {
        const stats = page.locator('.stat');
        await expect(stats).toHaveCount(4);

        // The seeded sources plus the one the server migrates from playlist_urls.
        await expect(stats.nth(0).locator('.stat__value')).toHaveText(String(FIXTURE.sourceCount));

        const rowCount = () => page.locator('tbody tr').count();
        const all = await rowCount();
        expect(all).toBe(FIXTURE.sourceCount);

        // Filtering to guide sources narrows the table. Polled rather than read
        // once: the count is asserted after Angular re-renders, not before.
        await stats.nth(2).click();
        await expect(page.locator('tbody tr')).not.toHaveCount(all);
        const guideOnly = await rowCount();
        expect(guideOnly).toBeGreaterThan(0);

        await stats.nth(0).click();
        await expect(page.locator('tbody tr')).toHaveCount(all);
    });

    test('every source reports its health in words', async ({ page }) => {
        const health = page.locator('.health').first();
        await expect(health).toBeVisible();
        await expect(health).toHaveText(/Working|No channels|Failing|Not synced yet/);
    });

    test('probing tells you what is there before anything is written', async ({ request, page }) => {
        const before = await page.evaluate(async () => {
            const token = localStorage.getItem('epg_admin_token');
            const res = await fetch('/api/sources', { headers: { Authorization: `Bearer ${token}` } });
            return (await res.json()).length;
        });

        // A source that cannot be reached: the probe must say so rather than
        // register it and fail later.
        const probe = await page.evaluate(async () => {
            const token = localStorage.getItem('epg_admin_token');
            const res = await fetch('/api/sources/probe', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: 'probe-only', kind: 'm3u', label: 'probe-only',
                    provides: ['channels'], enabled: true, priority: 0,
                    fetch: { url: 'http://probe.invalid/nothing.m3u', refresh: '12h', conditional: true }
                })
            });
            return { status: res.status, body: await res.json() };
        });

        expect(probe.body.ok).toBe(false);
        expect(probe.body.error?.message).toBeTruthy();

        // Nothing was registered by probing.
        const after = await page.evaluate(async () => {
            const token = localStorage.getItem('epg_admin_token');
            const res = await fetch('/api/sources', { headers: { Authorization: `Bearer ${token}` } });
            return (await res.json()).length;
        });
        expect(after).toBe(before);
    });

    test('the add dialog will not commit an unprobed source', async ({ page }) => {
        await page.getByRole('button', { name: '+ Add source' }).click();

        const dialog = page.locator('[role="dialog"]');
        await expect(dialog).toBeVisible();

        // The confirm action stays disabled until a probe has succeeded.
        const addBtn = dialog.getByRole('button', { name: /^Add source$/ });
        await dialog.locator('input[type="text"]').first().fill('http://probe.invalid/nothing.m3u');
        await expect(addBtn).toBeDisabled();
    });

    test('export produces something that can be imported back', async ({ page }) => {
        await page.getByRole('button', { name: 'Export / import' }).click();

        const dialog = page.locator('[role="dialog"]');
        await expect(dialog).toBeVisible();

        const exported = await dialog.locator('textarea').first().inputValue();
        expect(exported.length).toBeGreaterThan(10);

        const parsed = JSON.parse(exported);
        const list = Array.isArray(parsed) ? parsed : parsed.sources;
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBe(FIXTURE.sourceCount);
    });
});
