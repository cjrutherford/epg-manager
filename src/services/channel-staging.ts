/**
 * Stage-and-swap for playlist imports.
 *
 * The previous import deleted a source's channels and then inserted the new
 * ones. Anything that went wrong in between — a network fault, a malformed
 * playlist, a killed process — left that source with no channels and no way to
 * tell it had happened. The user's own curation (enabled flags, EPG matches,
 * channel numbers) went with it.
 *
 * Rows now land in `channels_staging` and are swapped in one transaction, only
 * once the whole playlist has parsed.
 */

import { db } from '../db';
import type { PlaylistChannelRow } from './playlist-import';

export interface ChannelSwapResult {
    staged: number;
    swapped: boolean;
    previousRows: number;
    reason?: string;
}

async function countChannels(table: string, sourceUrl: string): Promise<number> {
    const result = await db.execute({
        sql: `SELECT COUNT(*) as c FROM ${table} WHERE source_url = ?`,
        args: [sourceUrl]
    });
    return Number(result.rows[0]?.c || 0);
}

/** Clear leftover staging rows for a source before a fresh import. */
export async function beginChannelStaging(sourceUrl: string): Promise<void> {
    await db.execute({
        sql: 'DELETE FROM channels_staging WHERE source_url = ?',
        args: [sourceUrl]
    });
}

/** Append a batch of parsed rows to staging. Safe to call repeatedly while streaming. */
export async function stageChannelRows(rows: PlaylistChannelRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const args = rows.flatMap(row => ([
        row.id,
        row.name,
        row.tvg_id,
        row.tvg_logo,
        row.group_title,
        row.url,
        row.source_url,
        row.channel_number,
        row.enabled,
        row.matched_epg_id,
        row.match_type
    ]));

    await db.execute('BEGIN TRANSACTION');
    try {
        await db.execute({
            sql: `INSERT INTO channels_staging
                    (id, name, tvg_id, tvg_logo, group_title, url, source_url,
                     channel_number, enabled, matched_epg_id, match_type)
                  VALUES ${placeholders}`,
            args
        });
        await db.execute('COMMIT');
    } catch (e) {
        try { await db.execute('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
        throw e;
    }

    return rows.length;
}

/**
 * Swap a source's staged channels into place.
 *
 * Refuses to swap an empty staging set over a non-empty live set: a playlist
 * that parsed to nothing is a failure, and replacing working channels with none
 * is the damage this exists to prevent.
 */
export async function commitChannelStaging(
    sourceUrl: string,
    options: { allowEmpty?: boolean } = {}
): Promise<ChannelSwapResult> {
    const staged = await countChannels('channels_staging', sourceUrl);
    const previousRows = await countChannels('channels', sourceUrl);

    if (staged === 0 && previousRows > 0 && !options.allowEmpty) {
        await discardChannelStaging(sourceUrl);
        return {
            staged: 0,
            swapped: false,
            previousRows,
            reason: `playlist produced no channels; keeping the previous ${previousRows}`
        };
    }

    await db.execute('BEGIN TRANSACTION');
    try {
        await db.execute({
            sql: 'DELETE FROM channels WHERE source_url = ?',
            args: [sourceUrl]
        });
        await db.execute({
            sql: `INSERT OR REPLACE INTO channels
                    (id, name, tvg_id, tvg_logo, group_title, url, source_url,
                     channel_number, enabled, matched_epg_id, match_type)
                  SELECT id, name, tvg_id, tvg_logo, group_title, url, source_url,
                         channel_number, enabled, matched_epg_id, match_type
                  FROM channels_staging WHERE source_url = ?`,
            args: [sourceUrl]
        });
        await db.execute({
            sql: 'DELETE FROM channels_staging WHERE source_url = ?',
            args: [sourceUrl]
        });
        await db.execute('COMMIT');
    } catch (e: any) {
        try { await db.execute('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
        return { staged, swapped: false, previousRows, reason: `swap failed: ${e.message}` };
    }

    return { staged, swapped: true, previousRows };
}

/** Abandon an import. The live channel set is untouched by construction. */
export async function discardChannelStaging(sourceUrl: string): Promise<void> {
    await db.execute({
        sql: 'DELETE FROM channels_staging WHERE source_url = ?',
        args: [sourceUrl]
    });
}

/** Drop staging rows left behind by a process that died mid-import. */
export async function clearAllChannelStaging(): Promise<number> {
    const result = await db.execute('DELETE FROM channels_staging');
    return result.rowsAffected || 0;
}
