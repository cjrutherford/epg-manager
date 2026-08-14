/**
 * The shared HTTP client every adapter uses.
 *
 * Written once so caching, conditional requests, byte caps, timeouts and
 * backoff exist in exactly one place instead of being re-decided per call site.
 * Adapters never construct their own client.
 */

import axios from 'axios';
import * as zlib from 'zlib';
import { db } from '../../db';
import type { FetchResult } from './adapter';
import {
    backoffDelayMs,
    buildConditionalHeaders,
    exceedsByteCap,
    isNotModified,
    isRetryableError,
    isRetryableStatus,
    parseRetryAfter
} from './http-policy';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface ValidatorState {
    etag: string | null;
    lastModified: string | null;
}

/** Cached validators for a source, so an unchanged feed costs a 304. */
export async function loadValidators(sourceKey: string): Promise<ValidatorState> {
    try {
        const result = await db.execute({
            sql: 'SELECT etag, last_modified FROM source_validators WHERE source_key = ?',
            args: [sourceKey]
        });
        if (result.rows.length === 0) return { etag: null, lastModified: null };
        return {
            etag: result.rows[0].etag ? String(result.rows[0].etag) : null,
            lastModified: result.rows[0].last_modified ? String(result.rows[0].last_modified) : null
        };
    } catch (_) {
        return { etag: null, lastModified: null };
    }
}

export async function saveValidators(sourceKey: string, state: ValidatorState): Promise<void> {
    if (!state.etag && !state.lastModified) return;
    try {
        await db.execute({
            sql: `INSERT OR REPLACE INTO source_validators (source_key, etag, last_modified, updated_at)
                  VALUES (?, ?, ?, ?)`,
            args: [sourceKey, state.etag, state.lastModified, Date.now()]
        });
    } catch (e: any) {
        console.error('[Fetcher] Failed to store validators:', e.message);
    }
}

export interface FetchOptions {
    etag?: string | null;
    lastModified?: string | null;
    maxBytes?: number;
    timeoutMs?: number;
    gzip?: boolean;
    headers?: Record<string, string>;
}

/**
 * Fetch a source url with conditional support.
 *
 * Returns `notModified: true` and no body when the upstream answers 304 — the
 * caller skips parsing entirely, which is the difference between a 304 and
 * re-downloading and re-parsing a 250 MB guide twice a day.
 */
export async function fetchSource(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: timeoutMs,
                maxContentLength: maxBytes,
                maxBodyLength: maxBytes,
                decompress: true,
                // 304 is a success for our purposes, not an error
                validateStatus: status => (status >= 200 && status < 300) || status === 304,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept-Encoding': 'gzip, deflate',
                    ...buildConditionalHeaders({ etag: options.etag, lastModified: options.lastModified }),
                    ...(options.headers || {})
                }
            });

            const etag = headerValue(response.headers, 'etag');
            const lastModified = headerValue(response.headers, 'last-modified');

            if (isNotModified(response.status)) {
                return { notModified: true, status: 304, bytes: 0, etag, lastModified };
            }

            let body = Buffer.from(response.data);

            if (exceedsByteCap(body.length, maxBytes)) {
                throw new Error(`Response exceeded the ${maxBytes} byte cap`);
            }

            // axios decompresses transport gzip; a .gz payload is separate.
            if (options.gzip && isGzip(body)) {
                body = zlib.gunzipSync(body);
            }

            return {
                notModified: false,
                status: response.status,
                body,
                bytes: body.length,
                etag,
                lastModified
            };
        } catch (error: any) {
            lastError = error;

            const status = error?.response?.status;
            const retryable = (status && isRetryableStatus(status)) || isRetryableError(error);
            if (!retryable || attempt === MAX_ATTEMPTS) break;

            const retryAfter = parseRetryAfter(
                headerValue(error?.response?.headers, 'retry-after'),
                Date.now()
            );
            const delay = retryAfter ?? backoffDelayMs(attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError || new Error(`Failed to fetch ${url}`);
}

function headerValue(headers: any, name: string): string | null {
    if (!headers) return null;
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ? String(value) : null;
}

function isGzip(buffer: Buffer): boolean {
    return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}
