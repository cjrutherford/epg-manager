/**
 * scraper-repo adapter — iptv-org/epg and any fork of it.
 *
 * The catalogue comes from the repo's `sites/<site>/*.channels.xml` files;
 * guide data comes from driving `epg-grabber` against a site config. The grab
 * itself is delegated to the existing, well-tested grabber rather than
 * reimplemented — the value here is that it now sits behind the same contract
 * as every other kind, so callers stop special-casing it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DB_DIR } from '../../../db';
import { parseIptvOrgChannelsXmlStream } from '../../iptv-org-parser';
import type {
    AdapterContext, CatalogResult, CatalogRow, ChannelRef,
    ProbeResult, ProgrammeRow, SourceAdapter, Window
} from '../adapter';
import type { SourceDescriptor } from '../descriptor';

/** Where a scraper repo is checked out. */
export function repoDir(descriptor: SourceDescriptor): string {
    const configured = (descriptor as any).repoDir as string | undefined;
    return path.join(DB_DIR, configured || 'iptv-org-epg');
}

/** The site this descriptor covers, e.g. `iptv-org:tvguide.co.uk` -> `tvguide.co.uk`. */
export function siteFromDescriptor(descriptor: SourceDescriptor): string {
    const fromConfig = (descriptor as any).site as string | undefined;
    if (fromConfig) return fromConfig;
    const id = descriptor.id;
    const colon = id.indexOf(':');
    return colon >= 0 ? id.slice(colon + 1) : id;
}

/** Read one site's channel catalogue out of a checked-out repo. */
export async function readSiteCatalog(sitesDir: string, site: string): Promise<CatalogRow[]> {
    const sitePath = path.join(sitesDir, site);
    const rows: CatalogRow[] = [];

    let files: string[];
    try {
        files = fs.readdirSync(sitePath).filter(name => name.endsWith('.channels.xml'));
    } catch {
        return rows;
    }

    for (const file of files) {
        const input = fs.createReadStream(path.join(sitePath, file), { encoding: 'utf8' });
        await parseIptvOrgChannelsXmlStream(input, async (row) => {
            if (!row.site || !row.site_id) return;
            rows.push({
                name: row.name,
                xmltvId: row.xmltv_id,
                site: String(row.site),
                siteId: String(row.site_id),
                lang: row.lang || 'en'
            });
        });
    }

    return rows;
}

export const scraperRepoAdapter: SourceAdapter = {
    kind: 'scraper-repo',

    async probe(descriptor, _ctx): Promise<ProbeResult> {
        const sitesDir = path.join(repoDir(descriptor), 'sites');
        const site = siteFromDescriptor(descriptor);

        if (!fs.existsSync(sitesDir)) {
            return {
                ok: false, provides: [], sample: {}, counts: {}, warnings: [],
                error: {
                    code: 'REPO_MISSING',
                    message: 'The scraper repository has not been downloaded yet — sync sources first'
                }
            };
        }

        try {
            const rows = await readSiteCatalog(sitesDir, site);
            return {
                ok: rows.length > 0,
                provides: ['guide'],
                detectedKind: 'scraper-repo',
                sample: {},
                counts: { channels: rows.length },
                warnings: rows.length === 0
                    ? [`No channel catalogue found for site "${site}"`]
                    : []
            };
        } catch (e: any) {
            return {
                ok: false, provides: [], sample: {}, counts: {}, warnings: [],
                error: { code: 'PARSE_FAILED', message: e.message }
            };
        }
    },

    async syncCatalog(descriptor, ctx): Promise<CatalogResult> {
        const sitesDir = path.join(repoDir(descriptor), 'sites');
        const site = siteFromDescriptor(descriptor);

        if (!fs.existsSync(sitesDir)) {
            throw new Error('The scraper repository has not been downloaded yet');
        }

        const rows = await readSiteCatalog(sitesDir, site);
        const warnings: string[] = [];
        if (rows.length === 0) {
            warnings.push(`No channels parsed for site "${site}"`);
        }
        ctx.log(`${site}: catalogued ${rows.length} channel(s)`, 'info');

        return { rows, notModified: false, warnings };
    },

    /**
     * Guide data for specific channels. Delegates to the existing grabber,
     * which owns the site-config handling, per-site batching, failure decay
     * and auto-disable behaviour.
     */
    async *fetchGuide(
        descriptor: SourceDescriptor,
        refs: ChannelRef[],
        window: Window,
        ctx: AdapterContext
    ): AsyncIterable<ProgrammeRow> {
        if (refs.length === 0) return;

        const site = siteFromDescriptor(descriptor);
        const { grabSiteBatch } = await import('../../grabber.js');

        const results = await grabSiteBatch(
            site,
            refs.map(ref => ({ xmltvId: ref.xmltvId, site_id: ref.siteId, lang: ref.lang })),
            String(window.days)
        );

        const ok = results.filter((result: { success: boolean }) => result.success).length;
        ctx.log(`${site}: grabbed ${ok}/${results.length} channel(s)`, ok > 0 ? 'info' : 'warning');

        // The grabber writes programmes directly; nothing is yielded here.
        // Kept as an async iterable so guide-providing kinds share one shape.
        return;
    }
};
