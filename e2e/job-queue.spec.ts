import { expect, test } from '@playwright/test';
import { apiToken, authHeaders, goToSection, signIn } from './fixture/helpers';

/**
 * Covers S10: one queue behind every background action.
 *
 * Before it, four endpoints each decided for themselves what to do when
 * something was already running — three refused the caller and one ran
 * regardless, rewriting the output files underneath a sync.
 *
 * These run in the destructive project: starting a job changes what every
 * other spec would see.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Background job queue', () => {
    test('a second request queues or folds in rather than running alongside', async ({ request }) => {
        const token = await apiToken(request);
        const headers = authHeaders(token);

        // `rebuild` is local and quick, so this exercises the queue rather than
        // the network.
        const first = await request.post('/api/jobs', {
            headers, data: { kind: 'rebuild' }
        });
        expect(first.ok()).toBeTruthy();

        const second = await request.post('/api/jobs', {
            headers, data: { kind: 'rebuild' }
        });
        const body = await second.json();

        // Whatever the timing, the answer is never "both are running now".
        expect(['run-now', 'queued', 'coalesced']).toContain(body.decision);
        expect(body.message).toBeTruthy();

        // And the status endpoint never reports two jobs in flight.
        const status = await (await request.get('/api/job-status', { headers })).json();
        if (status.activeJob) {
            expect(status.queuedJobs.every((job: any) => job.id !== status.activeJob.id)).toBe(true);
        }
    });

    test('an unknown job kind is refused by name', async ({ request }) => {
        const token = await apiToken(request);
        const response = await request.post('/api/jobs', {
            headers: authHeaders(token),
            data: { kind: 'drop_everything' }
        });

        expect(response.status()).toBe(400);
        expect((await response.json()).error).toContain('kind must be one of');
    });

    test('removing a queued job that does not exist says so', async ({ request }) => {
        const token = await apiToken(request);
        const response = await request.delete('/api/jobs/queued/not-a-real-id', {
            headers: authHeaders(token)
        });

        expect(response.status()).toBe(404);
        expect((await response.json()).error).toContain('No queued job');
    });

    test('the reported schedule follows the configured one, without a restart', async ({ request }) => {
        const token = await apiToken(request);
        const headers = authHeaders(token);

        const before = await (await request.get('/api/job-status', { headers })).json();
        expect(before.schedule.expression).toBeTruthy();
        expect(before.schedule.description).toBeTruthy();

        await request.post('/api/config', { headers, data: { sync_cron: '15 4 * * 1-5' } });

        const after = await (await request.get('/api/job-status', { headers })).json();
        expect(after.schedule.expression).toBe('15 4 * * 1-5');
        expect(after.schedule.description).toContain('Monday');
        expect(after.schedule.nextRunAt).toBeTruthy();

        // An unreadable expression is refused and the previous one kept.
        const bad = await request.post('/api/config', { headers, data: { sync_cron: 'sometimes' } });
        expect(bad.status()).toBe(400);

        const unchanged = await (await request.get('/api/job-status', { headers })).json();
        expect(unchanged.schedule.expression).toBe('15 4 * * 1-5');

        await request.post('/api/config', { headers, data: { sync_cron: '0 2,14 * * *' } });
    });

    test('Reset is unavailable during a job, and says why', async ({ page, request }) => {
        await signIn(page);

        const token = await apiToken(request);
        await request.post('/api/jobs', {
            headers: authHeaders(token), data: { kind: 'full_sync' }
        });

        await goToSection(page, 'Dashboard', 'Dashboard');

        const reset = page.locator('.action-card').filter({ hasText: 'Reset data' });
        await expect(reset).toBeDisabled();
        await expect(reset).toContainText('Unavailable while a sync is running');

        // The others queue rather than being refused, so they say that instead
        // of looking broken.
        const sync = page.locator('.action-card').filter({ hasText: 'Run full sync' });
        await expect(sync).toContainText('Will queue behind the running job');

        await request.post('/api/sync/cancel', { headers: authHeaders(token) });
    });
});
