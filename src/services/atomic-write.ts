/**
 * Write output files without ever exposing a half-written one.
 *
 * `playlist.m3u` and `epg.xml` were written straight over the paths being
 * served. A player fetching `/epg.xml` while a rebuild was running received
 * whatever had been flushed so far — a truncated XML document with no closing
 * `</tv>`, which most clients treat as a corrupt guide rather than a retry.
 *
 * Everything here writes to a sibling temp file and renames over the target.
 * `rename(2)` within a directory is atomic, so a reader sees either the whole
 * previous file or the whole new one, never a mixture.
 */

import fs from 'fs';
import path from 'path';

function tempPathFor(target: string): string {
    const dir = path.dirname(target);
    const base = path.basename(target);
    // Same directory: rename is only atomic within a filesystem.
    return path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
}

/** Best-effort flush to disk so a crash cannot leave a renamed-but-empty file. */
function syncAndClose(fd: number): void {
    try {
        fs.fsyncSync(fd);
    } catch (_) {
        // Not every filesystem supports fsync; the rename is still atomic.
    }
    fs.closeSync(fd);
}

/** Write a complete string to `target`, atomically. */
export function writeFileAtomic(target: string, contents: string | Buffer): void {
    const tmp = tempPathFor(target);
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, contents);
        syncAndClose(fd);
    } catch (e) {
        try { fs.closeSync(fd); } catch (_) { /* already closed */ }
        try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
        throw e;
    }
    fs.renameSync(tmp, target);
}

export interface AtomicStream {
    /** Write a chunk. Resolves once the chunk has been accepted. */
    write(chunk: string): Promise<void>;
    /** Finish and publish the file at its target path. */
    commit(): Promise<void>;
    /** Give up and leave the existing file untouched. */
    abort(): Promise<void>;
    /** The temp path being written, for diagnostics. */
    readonly tempPath: string;
}

/**
 * Stream a large file into place atomically.
 *
 * Used for `epg.xml`, which is written in batches and can run to tens of
 * megabytes — buffering it all to hand to `writeFileAtomic` would defeat the
 * streaming the export does deliberately.
 */
export function createAtomicWriteStream(target: string): AtomicStream {
    const tmp = tempPathFor(target);
    const stream = fs.createWriteStream(tmp);
    let failure: Error | null = null;

    stream.on('error', (err: Error) => { failure = err; });

    const cleanup = () => {
        try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
    };

    return {
        tempPath: tmp,

        write(chunk: string): Promise<void> {
            if (failure) return Promise.reject(failure);
            return new Promise<void>((resolve, reject) => {
                // Respect backpressure: a large guide can outrun the disk.
                const flushed = stream.write(chunk, err => (err ? reject(err) : undefined));
                if (flushed) resolve();
                else stream.once('drain', () => resolve());
            });
        },

        commit(): Promise<void> {
            return new Promise<void>((resolve, reject) => {
                stream.end(() => {
                    if (failure) {
                        cleanup();
                        reject(failure);
                        return;
                    }
                    try {
                        // Only now does the target change, in one step.
                        fs.renameSync(tmp, target);
                        resolve();
                    } catch (e) {
                        cleanup();
                        reject(e);
                    }
                });
                stream.on('error', err => {
                    cleanup();
                    reject(err);
                });
            });
        },

        abort(): Promise<void> {
            return new Promise<void>(resolve => {
                stream.destroy();
                cleanup();
                resolve();
            });
        }
    };
}
