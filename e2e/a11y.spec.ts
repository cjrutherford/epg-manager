import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './fixture/helpers';

/**
 * Accessibility gate.
 *
 * The custom UX checks catch structure, labels, targets and overflow; axe
 * catches the broader WCAG rule set. Only serious/critical findings fail the
 * build — the full report is still useful during triage.
 */
async function expectNoSeriousViolations(page: any, label: string): Promise<void> {
    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
    const serious = results.violations.filter(violation => ['serious', 'critical'].includes(violation.impact || ''));
    const summarised = serious.map(violation => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map(node => node.target)
    }));
    expect(summarised, `${label} has serious accessibility violations`).toEqual([]);
}

test.describe('Accessibility gate', () => {
    test('public screens pass axe-core', async ({ page }) => {
        await page.goto('/watch');
        await page.waitForTimeout(1500);
        await page.mouse.move(600, 300);
        await expectNoSeriousViolations(page, 'Watch');

        await page.goto('/admin');
        await page.waitForTimeout(600);
        await expectNoSeriousViolations(page, 'Login');
    });

    test('admin screens pass axe-core', async ({ page }) => {
        await signIn(page);
        for (const route of ['dashboard', 'channels', 'sources', 'dvr', 'diagnostics', 'settings']) {
            await page.goto(`/admin/${route}`);
            await page.waitForTimeout(800);
            await expectNoSeriousViolations(page, route);
        }
    });

    test('mobile Watch passes axe-core', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/watch');
        await page.waitForTimeout(1500);
        await page.mouse.move(200, 300);
        await expectNoSeriousViolations(page, 'Mobile Watch');
    });
});
