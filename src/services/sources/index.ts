/**
 * Acquisition entry point.
 *
 * Registers the adapters and builds the context they run in, so callers ask
 * for a kind and get a working adapter rather than reaching for a provider's
 * implementation directly.
 */

import { emitLog } from '../../events';
import { getAdapter, registerAdapter, registeredKinds, type AdapterContext } from './adapter';
import { fetchSource, loadValidators, saveValidators } from './fetcher';
import { m3uAdapter } from './adapters/m3u';
import { bundleAdapter } from './adapters/bundle';
import { scraperRepoAdapter } from './adapters/scraper-repo';

let registered = false;

export function registerBuiltInAdapters(): void {
    if (registered) return;
    registerAdapter(m3uAdapter);
    registerAdapter(bundleAdapter);
    registerAdapter(scraperRepoAdapter);
    registered = true;
}

/**
 * A context plus the freshness of its last fetch.
 *
 * Callers need to tell "the source is unchanged" apart from "the source is
 * empty". An adapter that streams rows cannot express that difference through
 * the iterable alone, and conflating them is dangerous: a caller that replaces
 * its data with whatever the adapter yielded would wipe everything the moment
 * an upstream answered 304.
 */
export interface SourceContext extends AdapterContext {
    readonly lastFetchNotModified: boolean;
}

/**
 * Build the context an adapter runs in. The fetcher is bound to the source so
 * conditional validators are stored and reused per source without the adapter
 * having to know they exist.
 */
export function createAdapterContext(sourceKey: string): SourceContext {
    let notModified = false;

    return {
        fetch: async (url, options = {}) => {
            const stored = await loadValidators(sourceKey);
            const result = await fetchSource(url, {
                ...options,
                etag: options.etag ?? stored.etag,
                lastModified: options.lastModified ?? stored.lastModified
            });
            notModified = result.notModified;
            if (!result.notModified) {
                await saveValidators(sourceKey, {
                    etag: result.etag ?? null,
                    lastModified: result.lastModified ?? null
                });
            }
            return result;
        },
        log: (message, level = 'info') => emitLog(message, level),
        credentials: null,
        get lastFetchNotModified() { return notModified; }
    };
}

export { getAdapter, registeredKinds };
export type { AdapterContext };
