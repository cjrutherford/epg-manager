import { isTransientError } from '../services/patch-axios';

describe('Retry & Resilience Improvements', () => {
    describe('isTransientError', () => {
        it('identifies status 429 and 503 as transient errors', () => {
            expect(isTransientError({ response: { status: 429 } })).toBe(true);
            expect(isTransientError({ response: { status: 502 } })).toBe(true);
            expect(isTransientError({ response: { status: 503 } })).toBe(true);
            expect(isTransientError({ response: { status: 504 } })).toBe(true);
        });

        it('identifies network error codes as transient', () => {
            expect(isTransientError({ code: 'ETIMEDOUT' })).toBe(true);
            expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
            expect(isTransientError({ code: 'ECONNREFUSED' })).toBe(true);
        });

        it('does not treat 404 or 400 as transient errors', () => {
            expect(isTransientError({ response: { status: 404 } })).toBe(false);
            expect(isTransientError({ response: { status: 400 } })).toBe(false);
            expect(isTransientError(null)).toBe(false);
        });
    });
});
