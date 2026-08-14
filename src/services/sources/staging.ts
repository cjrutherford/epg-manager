/**
 * Stage-and-swap for catalogue refreshes.
 *
 * The previous refresh deleted the live catalogue *before* parsing its
 * replacement, so a failed or partial parse left the corpus truncated — and
 * because the whole routine was wrapped in a catch that only logged, the sync
 * carried on into matching against whatever survived (R4).
 *
 * Rows now land in a staging table and are swapped in one transaction, only
 * once the parse has succeeded. A failure leaves the previous catalogue exactly
 * where it was.
 */

import { db } from '../../db';
import type { CatalogRow } from './adapter';

const STAGING_TABLE = 'epg_source_channels_staging';
const LIVE_TABLE = 'epg_source_channels';

export interface SwapResult {
    staged: number;
    swapped: boolean;
    previousRows: number;
    reason?: string;
}

/** Clear any leftover staging rows for a source before a fresh refresh. */
export async function beginStaging(sourceKey: string): Promise<void> {
    await db.execute({
        sql: `DELETE FROM ${STAGING_TABLE} WHERE source_key = ?`,
        args: [sourceKey]
    });
}

/** Append catalogue rows to staging. Safe to call repeatedly while streaming. */
export async function stageRows(
    sourceKey: string,
    provider: string,
    rows: CatalogRow[]
): Promise<number> {
    if (rows.length === 0) return 0;

    const CHUNK = 250;
    let written = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
        const args = chunk.flatMap(row => [
            sourceKey, provider, row.name, row.xmltvId, row.lang || 'en', row.site, row.siteId
        ]);
        await db.execute({
            sql: `INSERT INTO ${STAGING_TABLE}
                    (source_key, provider, name, xmltv_id, lang, site, site_id)
                  VALUES ${placeholders}`,
            args
        });
        written += chunk.length;
    }

    return written;
}

export async function countStaged(sourceKey: string): Promise<number> {
    const result = await db.execute({
        sql: `SELECT COUNT(*) as c FROM ${STAGING_TABLE} WHERE source_key = ?`,
        args: [sourceKey]
    });
    return Number(result.rows[0]?.c || 0);
}

/**
 * Swap staged rows into the live catalogue for one source, in a transaction.
 *
 * Refuses to swap an empty staging set: a source that parsed to nothing is a
 * failure, and replacing a working catalogue with zero rows is precisely the
 * damage this exists to prevent. Pass `allowEmpty` only when a genuinely empty
 * catalogue is the correct outcome.
 */
export async function commitStaging(
    sourceKey: string,
    options: { allowEmpty?: boolean } = {}
): Promise<SwapResult> {
    const staged = await countStaged(sourceKey);
    const previous = await db.execute({
        sql: `SELECT COUNT(*) as c FROM ${LIVE_TABLE} WHERE source_key = ?`,
        args: [sourceKey]
    });
    const previousRows = Number(previous.rows[0]?.c || 0);

    if (staged === 0 && !options.allowEmpty) {
        await discardStaging(sourceKey);
        return {
            staged: 0,
            swapped: false,
            previousRows,
            reason: previousRows > 0
                ? `Refresh produced no rows; keeping the previous ${previousRows} channel(s)`
                : 'Refresh produced no rows'
        };
    }

    await db.execute('BEGIN TRANSACTION');
    try {
        await db.execute({
            sql: `DELETE FROM ${LIVE_TABLE} WHERE source_key = ?`,
            args: [sourceKey]
        });
        await db.execute({
            sql: `INSERT OR REPLACE INTO ${LIVE_TABLE}
                    (source_key, provider, name, xmltv_id, lang, site, site_id)
                  SELECT source_key, provider, name, xmltv_id, lang, site, site_id
                  FROM ${STAGING_TABLE} WHERE source_key = ?`,
            args: [sourceKey]
        });
        await db.execute({
            sql: `DELETE FROM ${STAGING_TABLE} WHERE source_key = ?`,
            args: [sourceKey]
        });
        await db.execute('COMMIT');
    } catch (e: any) {
        try { await db.execute('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
        return { staged, swapped: false, previousRows, reason: `Swap failed: ${e.message}` };
    }

    return { staged, swapped: true, previousRows };
}

/** Abandon a refresh. The live catalogue is untouched by construction. */
export async function discardStaging(sourceKey: string): Promise<void> {
    await db.execute({
        sql: `DELETE FROM ${STAGING_TABLE} WHERE source_key = ?`,
        args: [sourceKey]
    });
}

/** Drop staging rows left behind by a process that died mid-refresh. */
export async function clearAllStaging(): Promise<number> {
    const result = await db.execute(`DELETE FROM ${STAGING_TABLE}`);
    return result.rowsAffected || 0;
}
