import { expect, test } from '@playwright/test';
import { FIXTURE } from './fixture/seed';

/**
 * Proves the fixture is real before anything else relies on it.
 *
 * If these fail, every other failure in the suite is suspect — so they assert
 * the exact numbers `FIXTURE` promises rather than "more than zero", which is
 * the assertion that let the old suite pass against whatever happened to be in
 * someone's database.
 */
test.describe('the seeded fixture', () => {
    test('the API is up and reports the seeded channel counts', async ({ request }) => {
        const health = await request.get('/api/health');
        expect(health.ok()).toBeTruthy();

        const auth = await request.post('/api/auth', {
            data: { password: FIXTURE.adminPassword }
        });
        expect(auth.ok()).toBeTruthy();
        const { token } = await auth.json();
        expect(token).toBeTruthy();

        const channels = await request.get('/api/channels', {
            headers: { Authorization: `Bearer ${token}` }
        });
        expect(channels.ok()).toBeTruthy();
        const rows = await channels.json();
        expect(rows).toHaveLength(FIXTURE.channelCount);
    });

    test('the guide carries exactly the seeded programmes', async ({ request }) => {
        const auth = await request.post('/api/auth', { data: { password: FIXTURE.adminPassword } });
        const { token } = await auth.json();

        const stats = await request.get('/api/stats', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const body = await stats.json();
        expect(body.programs.total).toBe(FIXTURE.programmeCount);
    });

    test('the registry holds the seeded sources plus the migrated playlist', async ({ request }) => {
        const auth = await request.post('/api/auth', { data: { password: FIXTURE.adminPassword } });
        const { token } = await auth.json();

        const sources = await request.get('/api/sources', {
            headers: { Authorization: `Bearer ${token}` }
        });
        // Four, not three: the server migrates `playlist_urls` into the
        // registry at boot. Asserting the exact number keeps that visible.
        expect(await sources.json()).toHaveLength(FIXTURE.sourceCount);
    });

    test('the web server serves the application', async ({ page }) => {
        await page.goto('/admin');
        await expect(page.locator('app-root')).toBeAttached();
    });

    test('a wrong password is refused, so the fixture is not wide open', async ({ request }) => {
        const auth = await request.post('/api/auth', { data: { password: 'not-the-password' } });
        expect(auth.status()).toBe(401);
    });
});
