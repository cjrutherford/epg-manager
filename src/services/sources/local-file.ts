/**
 * Local files as a source transport.
 *
 * This started as a planned "file adapter", which was the wrong shape: parsing
 * already belongs to the `m3u` and `xmltv` adapters, and a file does not parse
 * differently for having come off a disk. The only thing actually missing was a
 * way to *reach* one — the fetch layer handed everything to axios, so a bare
 * path failed with "Invalid URL" and a `file://` url with "protocol mismatch".
 *
 * So this is a transport, not an adapter. Every existing adapter gains local
 * file support from it, and no new source kind is introduced.
 *
 * Reads are confined to the data directory. An admin configuring a source is
 * trusted, but "paste a path and we will read it" should not quietly become a
 * way to pull `/etc/passwd` through the sources screen.
 */

import fs from 'fs';
import path from 'path';

export interface LocalFileTarget {
    /** Absolute path on disk. */
    absolutePath: string;
}

export interface LocalFileRejection {
    reason: string;
}

/** Does this look like a local file reference rather than a URL? */
export function isLocalFileTarget(target: string): boolean {
    const value = String(target || '').trim();
    if (!value) return false;
    if (value.startsWith('file://')) return true;
    // A bare absolute path. Windows drive letters are not a supported host.
    return value.startsWith('/');
}

/** Strip the `file://` scheme, leaving a path. */
function toPath(target: string): string {
    const value = String(target).trim();
    if (!value.startsWith('file://')) return value;
    try {
        return decodeURIComponent(new URL(value).pathname);
    } catch {
        return value.slice('file://'.length);
    }
}

/**
 * Resolve a local target to a path inside `baseDir`, or explain why not.
 *
 * Rejects rather than clamps: silently rewriting a path the user asked for is
 * how a "safe" resolver ends up reading something nobody intended.
 */
export function resolveLocalSource(
    target: string,
    baseDir: string
): LocalFileTarget | LocalFileRejection {
    if (!isLocalFileTarget(target)) {
        return { reason: 'Not a local file reference' };
    }

    const raw = toPath(target);
    const base = path.resolve(baseDir);
    const resolved = path.resolve(base, raw);

    // `path.resolve` collapses `..`, so this catches traversal after the fact
    // rather than trying to spot it in the input.
    const withSeparator = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && !resolved.startsWith(withSeparator)) {
        return { reason: `Local sources must live inside ${base}` };
    }

    return { absolutePath: resolved };
}

export function isRejection(
    result: LocalFileTarget | LocalFileRejection
): result is LocalFileRejection {
    return (result as LocalFileRejection).reason !== undefined;
}

export interface LocalFileStat {
    sizeBytes: number;
    /** Modification time, used as a validator in place of Last-Modified. */
    lastModified: string;
}

/** Stat a resolved local source, or throw a message worth showing. */
export function statLocalSource(absolutePath: string): LocalFileStat {
    let stats: fs.Stats;
    try {
        stats = fs.statSync(absolutePath);
    } catch {
        throw new Error(`No such file: ${absolutePath}`);
    }
    if (!stats.isFile()) {
        throw new Error(`Not a file: ${absolutePath}`);
    }
    return {
        sizeBytes: stats.size,
        lastModified: stats.mtime.toUTCString()
    };
}

/**
 * Whether a local file is unchanged since the caller last read it.
 *
 * This is the local equivalent of a 304: mtime and size stand in for the
 * validators an HTTP server would have supplied, so an unchanged file is not
 * re-parsed on every refresh.
 */
export function isUnchanged(stat: LocalFileStat, previousLastModified?: string, previousSize?: number): boolean {
    if (!previousLastModified) return false;
    if (previousSize !== undefined && previousSize !== stat.sizeBytes) return false;
    return stat.lastModified === previousLastModified;
}
