import { test, expect, type Page } from '@playwright/test';
import { apiToken, authHeaders, signIn } from './fixture/helpers';

// Sign-in is rate limited and the fixture is shared, so these run in order.
test.describe.configure({ mode: 'serial' });

/**
 * UX guardrails.
 *
 * These are deliberately mechanical: they do not judge taste, they catch the
 * regressions that made the review embarrassing — a control outside the
 * viewport, an icon pinned to a corner, a stream that fails without telling
 * the viewer, and a desktop table left to clip on a phone.
 */

async function loginAndResize(page: Page, width: number, height: number): Promise<void> {
    await signIn(page);
    await page.setViewportSize({ width, height });
}

async function offscreenControls(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const vw = window.innerWidth;
        const results: string[] = [];
        document.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [role="button"]').forEach(el => {
            if (el.closest('[inert]')) return;
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            if (r.right > vw + 1 || r.left < -1) {
                const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim().slice(0, 40);
                results.push(`${el.tagName.toLowerCase()} "${label}" at ${Math.round(r.left)}..${Math.round(r.right)} (viewport ${vw})`);
            }
        });
        return results;
    });
}

async function unnamedButtons(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const results: string[] = [];
        document.querySelectorAll<HTMLElement>('button').forEach(el => {
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') return;
            const name = el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim();
            if (!name) results.push(el.outerHTML.slice(0, 140));
        });
        return results;
    });
}

test.describe('UX guardrails — desktop', () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test('every page stays inside the viewport at 1440px', async ({ page }) => {
        for (const route of ['dashboard', 'channels', 'sources', 'dvr', 'diagnostics', 'settings']) {
            await page.goto(`/admin/${route}`);
            await expect(page.locator('.page-header h1')).toBeVisible({ timeout: 15000 });
            await page.waitForTimeout(400);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
            expect(await offscreenControls(page)).toEqual([]);
        }
    });

    test('admin and Watch stay inside the viewport at 320, 390, 768, 1024 and 1440', async ({ page }) => {
        const routes = ['dashboard', 'channels', 'sources', 'dvr', 'diagnostics', 'settings'];
        for (const [width, height] of [[320, 720], [390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
            await page.setViewportSize({ width, height });
            for (const route of routes) {
                await page.goto(`/admin/${route}`);
                await expect(page.locator('.page-header h1')).toBeVisible({ timeout: 15000 });
                await page.waitForTimeout(250);
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
                expect(overflow, `${route} overflows at ${width}px`).toBeLessThanOrEqual(1);
            }

            await page.goto('/watch');
            await page.waitForTimeout(1200);
            const watchOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(watchOverflow, `Watch overflows at ${width}px`).toBeLessThanOrEqual(1);
        }
    });

    test('icon buttons are centred and named', async ({ page }) => {
        await page.goto('/watch');
        await page.waitForTimeout(2000);
        await page.mouse.move(700, 300);
        await page.waitForTimeout(300);

        const geometry = await page.evaluate(() => {
            return [...document.querySelectorAll<HTMLElement>('.icon-btn')]
                .filter(button => button.offsetParent !== null)
                .map(button => {
                    const buttonRect = button.getBoundingClientRect();
                    const icon = button.querySelector('svg');
                    if (!icon) return null;
                    const iconRect = icon.getBoundingClientRect();
                    return {
                        title: button.getAttribute('title') || button.getAttribute('aria-label') || '',
                        dx: Math.abs((buttonRect.left + buttonRect.width / 2) - (iconRect.left + iconRect.width / 2)),
                        dy: Math.abs((buttonRect.top + buttonRect.height / 2) - (iconRect.top + iconRect.height / 2)),
                    };
                })
                .filter(Boolean);
        });

        expect(geometry.length).toBeGreaterThan(0);
        for (const button of geometry as Array<{ title: string; dx: number; dy: number }>) {
            expect(button.dx, `${button.title} icon is horizontally centred`).toBeLessThanOrEqual(3);
            expect(button.dy, `${button.title} icon is vertically centred`).toBeLessThanOrEqual(3);
        }
        expect(await unnamedButtons(page)).toEqual([]);
    });
});

test.describe('UX guardrails — mobile', () => {
    test('Watch keeps every control on-screen and exposes one info surface', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/watch');
        await page.waitForTimeout(2500);
        await page.mouse.move(200, 300);
        await page.waitForTimeout(300);

        expect(await offscreenControls(page)).toEqual([]);
        await expect(page.locator('.channel-info-block')).toBeVisible();

        // The OSD and the channel bar used to occupy the same coordinates.
        const overlap = await page.evaluate(() => {
            const bar = document.querySelector('.channel-info-block')?.getBoundingClientRect();
            const osd = document.querySelector('.info-overlay') as HTMLElement | null;
            if (!bar || !osd || getComputedStyle(osd).display === 'none') return 0;
            const r = osd.getBoundingClientRect();
            return Math.max(0, Math.min(bar.bottom, r.bottom) - Math.max(bar.top, r.top));
        });
        expect(overlap).toBe(0);

        // Opening the guide must not push its own panel outside the viewport,
        // and the timeline + rows must share a horizontal scroll surface.
        await page.keyboard.press('g');
        await page.waitForTimeout(800);
        await expect(page.locator('.guide-panel')).toBeVisible();

        const guide = await page.evaluate(() => {
            const panel = document.querySelector('.guide-panel')!.getBoundingClientRect();
            const scroll = document.querySelector('.guide-scroll') as HTMLElement | null;
            return {
                left: panel.left,
                right: panel.right,
                viewport: window.innerWidth,
                scrollable: !!scroll && scroll.scrollWidth > scroll.clientWidth + 4,
                overflowX: scroll ? getComputedStyle(scroll).overflowX : 'missing',
            };
        });
        expect(guide.left).toBeGreaterThanOrEqual(-1);
        expect(guide.right).toBeLessThanOrEqual(guide.viewport + 1);
        expect(guide.overflowX).toBe('auto');
        expect(guide.scrollable).toBe(true);
    });

    test('Channels reflows into cards and keeps the row action reachable', async ({ page }) => {
        await loginAndResize(page, 390, 844);
        await page.goto('/admin/channels');
        await expect(page.locator('.page-header h1')).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(800);

        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        expect(await offscreenControls(page)).toEqual([]);

        // The header is gone, rows are cards, and Edit is still visible.
        await expect(page.locator('.channel-scroll thead')).toBeHidden();
        const firstRow = page.locator('.channel-scroll tbody tr:not(.expanded-row):not(.virtual-spacer)').first();
        await expect(firstRow).toBeVisible();
        const rowBox = await firstRow.boundingBox();
        expect(rowBox!.height).toBeGreaterThan(100);
        await expect(firstRow.locator('button', { hasText: 'Edit' })).toBeVisible();
    });

    test('Sources reflows into labelled cards without clipping', async ({ page }) => {
        await loginAndResize(page, 390, 844);
        await page.goto('/admin/sources');
        await expect(page.locator('.page-header h1')).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(800);

        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        expect(await offscreenControls(page)).toEqual([]);
        await expect(page.locator('.sources-page thead')).toBeHidden();
        await expect(page.locator('.sources-page tbody tr').first()).toBeVisible();
        await expect(page.locator('.row-actions').first()).toBeVisible();
    });

    test('Diagnostics tables reflow into labelled cards', async ({ page }) => {
        await loginAndResize(page, 390, 844);
        await page.goto('/admin/diagnostics');
        await expect(page.locator('.page-header h1')).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(1000);

        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        expect(await offscreenControls(page)).toEqual([]);
        await expect(page.locator('.table-container thead').first()).toBeHidden();
        await expect(page.locator('.table-container tbody tr').first()).toBeVisible();
        await expect(page.locator('.actions-cell').first()).toBeVisible();
    });
});

test.describe('UX guardrails — failure and accessibility', () => {
    test('a stream that never starts becomes a visible, recoverable error', async ({ page }) => {
        test.setTimeout(40000);
        await page.goto('/watch');
        await expect(page.locator('.player-stay-tuned-overlay')).toBeVisible({ timeout: 25000 });
        await expect(page.locator('.player-stay-tuned-overlay')).toContainText(/not responding|offline|failed/i);
        await expect(page.locator('.player-stay-tuned-overlay button', { hasText: /retry connection/i })).toBeVisible();
        await expect(page.locator('.player-stay-tuned-overlay button', { hasText: /next/i })).toBeVisible();
    });

    test('every icon-only button has an accessible name', async ({ page }) => {
        await signIn(page);
        for (const route of ['dashboard', 'channels', 'sources', 'dvr', 'diagnostics', 'settings']) {
            await page.goto(`/admin/${route}`);
            await expect(page.locator('.page-header h1')).toBeVisible({ timeout: 15000 });
            expect(await unnamedButtons(page), `${route} has unnamed buttons`).toEqual([]);
        }
    });
});

test.describe('UX guardrails — cycle 2 system', () => {
    test('the theme menu fits the viewport and the choice survives a reload', async ({ page }) => {
        await signIn(page);
        await page.locator('.sidebar-theme-picker button').click();
        await expect(page.locator('app-theme-menu')).toBeVisible();

        const box = await page.locator('app-theme-menu .theme-menu').boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(900 + 1);

        await expect(page.getByRole('button', { name: /Daylight/ })).toBeVisible();
        await page.getByRole('button', { name: /High Contrast/ }).click();
        await expect.poll(() => page.evaluate(() => document.body.className)).toContain('theme-high-contrast');

        await page.reload();
        await expect.poll(() => page.evaluate(() => document.body.className)).toContain('theme-high-contrast');
    });

    test('modals use the shared dialog shell', async ({ page }) => {
        await signIn(page);
        await page.locator('button.action-card', { hasText: 'Reset data' }).click();

        const dialog = page.locator('[role="dialog"]').first();
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAttribute('aria-modal', 'true');
        await expect(dialog.locator('.close-modal-btn')).toBeVisible();
        await expect(dialog.locator('h2')).toContainText('Reset');

        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
    });
});

test.describe('UX guardrails — clarity', () => {
    test('the sources reliability link lands on the reliability tab', async ({ page }) => {
        await signIn(page);
        await page.goto('/admin/sources');
        await expect(page.locator('.page-header h1')).toHaveText('Sources');
        await page.getByRole('link', { name: 'Source reliability' }).click();
        await expect(page.locator('.page-header h1')).toHaveText('Guide & matching');
        await expect(page.locator('th:has-text("Guide scraper site")')).toBeVisible();
    });

    test('watch exposes a keyboard shortcut sheet', async ({ page }) => {
        await page.goto('/watch');
        await page.waitForTimeout(1500);
        await page.mouse.move(600, 300);
        await page.locator('.shortcuts-btn').click();
        const dialog = page.locator('[role="dialog"]').first();
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('h3')).toContainText('Keyboard shortcuts');
        await expect(dialog.getByText('Open or close the guide')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
    });
});

test.describe('UX guardrails — polish', () => {
    test('Watch has a heading, a main landmark and no micro text below 12px', async ({ page }) => {
        await page.goto('/watch');
        await page.waitForTimeout(1500);
        await page.mouse.move(600, 300);

        const structure = await page.evaluate(() => {
            const visible = (el: Element) => {
                const r = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const textSizes = [...document.querySelectorAll('body *')]
                .filter(el => visible(el) && el.children.length === 0 && (el.textContent || '').trim())
                .map(el => parseFloat(getComputedStyle(el).fontSize));
            return {
                headings: document.querySelectorAll('h1').length,
                mains: document.querySelectorAll('main').length,
                smallest: Math.min(...textSizes),
            };
        });

        expect(structure.headings).toBeGreaterThanOrEqual(1);
        expect(structure.mains).toBeGreaterThanOrEqual(1);
        expect(structure.smallest).toBeGreaterThanOrEqual(12);
    });

    test('primary touch controls are at least 44px on mobile Watch', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/watch');
        await page.waitForTimeout(1500);
        await page.mouse.move(200, 300);
        await page.waitForTimeout(300);

        for (const selector of ['.topbar .icon-btn', '.ch-btn', '.vol-btn']) {
            const sizes = await page.locator(selector).evaluateAll(elements => elements
                .filter(el => (el as HTMLElement).offsetParent !== null)
                .map(el => {
                    const r = el.getBoundingClientRect();
                    return { w: Math.round(r.width), h: Math.round(r.height) };
                }));
            for (const size of sizes) {
                expect(size.w, `${selector} width`).toBeGreaterThanOrEqual(43);
                expect(size.h, `${selector} height`).toBeGreaterThanOrEqual(43);
            }
        }
    });

    test('data screens show a skeleton while loading', async ({ page }) => {
        await signIn(page);
        await page.route('**/api/sources', async route => {
            await new Promise(resolve => setTimeout(resolve, 700));
            await route.continue();
        });
        await page.goto('/admin/sources');
        await expect(page.locator('app-skeleton')).toBeVisible();
        await expect(page.locator('.sources-page tbody tr').first()).toBeVisible({ timeout: 15000 });
    });
});

test.describe('UX guardrails — clean install', () => {
    const emptyData = {
        hasChannels: false,
        hasPrograms: false,
        hasPlaylist: false,
        isEmpty: true
    };

    test('Watch explains a clean install instead of showing a black screen', async ({ page }) => {
        await page.route('**/api/has-data', route => route.fulfill({ json: emptyData }));
        await page.route('**/api/guide*', route => route.fulfill({
            json: {
                channels: [],
                start: new Date().toISOString(),
                end: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
            }
        }));

        await page.goto('/watch');
        const empty = page.locator('.watch-empty-state');
        await expect(empty).toBeVisible({ timeout: 15000 });
        await expect(empty.locator('.wes-title')).toHaveText('No channels configured');
        await expect(empty.locator('#btn-go-to-admin')).toBeVisible();
    });

    test('first-run checklist keeps the watch moment until Watch is opened', async ({ page }) => {
        await signIn(page);
        await page.route('**/api/has-data', route => route.fulfill({
            json: { hasChannels: true, hasPrograms: true, hasPlaylist: true, isEmpty: false }
        }));
        await page.goto('/admin/dashboard');
        await expect(page.getByText("You're ready to watch")).toBeVisible();
        await expect(page.getByRole('link', { name: 'Watch your first channel' })).toBeVisible();

        await page.goto('/watch');
        await page.waitForTimeout(1200);

        await page.goto('/admin/dashboard');
        await expect(page.getByText("You're ready to watch")).toHaveCount(0);
    });

    test('Dashboard disables data actions until a source exists', async ({ page }) => {
        await signIn(page);
        await page.route('**/api/has-data', route => route.fulfill({ json: emptyData }));
        await page.goto('/admin/dashboard');
        await expect(page.locator('button.action-card', { hasText: 'Run full sync' })).toBeDisabled();
        await expect(page.locator('button.action-card', { hasText: 'Fetch guide data' })).toBeDisabled();
        await expect(page.locator('app-setup-checklist')).toBeVisible();
    });
});

test.describe('UX guardrails — playlist sources', () => {
    test('saving playlist URLs registers them as sources', async ({ request }) => {
        const token = await apiToken(request);
        const headers = authHeaders(token);
        const before = await (await request.get('/api/config', { headers })).json();
        const original = Array.isArray(before.playlist_urls) ? before.playlist_urls : [];
        const temp = 'http://fixture.invalid/regression-playlist.m3u';

        const save = await request.post('/api/config', {
            headers,
            data: { playlist_urls: [...original, temp] }
        });
        expect(save.ok()).toBeTruthy();

        const sources = await (await request.get('/api/sources', { headers })).json();
        expect(sources.map((source: any) => source.key)).toContain(`playlist:${temp}`);

        const hasData = await (await request.get('/api/has-data')).json();
        expect(hasData.hasPlaylist).toBe(true);

        // Restore the fixture and confirm the removed playlist left the registry.
        const restore = await request.post('/api/config', {
            headers,
            data: { playlist_urls: original }
        });
        expect(restore.ok()).toBeTruthy();
        const after = await (await request.get('/api/sources', { headers })).json();
        expect(after.map((source: any) => source.key)).not.toContain(`playlist:${temp}`);
    });
});
