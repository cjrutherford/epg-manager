import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isLocalFileTarget,
    isRejection,
    isUnchanged,
    resolveLocalSource,
    statLocalSource
} from '../local-file';

let base: string;

beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'local-source-'));
});

afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
});

describe('isLocalFileTarget', () => {
    it('recognises absolute paths and file urls', () => {
        expect(isLocalFileTarget('/data/lineup.m3u')).toBe(true);
        expect(isLocalFileTarget('file:///data/lineup.m3u')).toBe(true);
    });

    it('leaves http sources to the http client', () => {
        for (const url of ['http://x/a.m3u', 'https://x/a.m3u', '', '   ', 'a.m3u']) {
            expect(isLocalFileTarget(url)).toBe(false);
        }
    });
});

describe('resolveLocalSource', () => {
    it('resolves a path inside the data directory', () => {
        const result = resolveLocalSource(path.join(base, 'lineup.m3u'), base);
        expect(isRejection(result)).toBe(false);
        expect((result as any).absolutePath).toBe(path.join(base, 'lineup.m3u'));
    });

    it('resolves a file url', () => {
        const result = resolveLocalSource('file://' + path.join(base, 'lineup.m3u'), base);
        expect((result as any).absolutePath).toBe(path.join(base, 'lineup.m3u'));
    });

    it('decodes percent-escapes in a file url', () => {
        const result = resolveLocalSource('file://' + base + '/my%20lineup.m3u', base);
        expect((result as any).absolutePath).toBe(path.join(base, 'my lineup.m3u'));
    });

    it('treats a leading slash as absolute, not as relative to the data directory', () => {
        // `/lineup.m3u` means the filesystem root, so it is outside the data
        // directory and refused. Rewriting it to `<data>/lineup.m3u` would be
        // friendlier and more surprising: the path would not mean what it says.
        const result = resolveLocalSource('/lineup.m3u', base);
        expect(isRejection(result)).toBe(true);
    });

    it('refuses to escape the data directory, rather than clamping', () => {
        for (const attempt of [
            path.join(base, '../../etc/passwd'),
            'file:///etc/passwd',
            path.join(base, 'subdir/../../../etc/shadow')
        ]) {
            const result = resolveLocalSource(attempt, base);
            expect(isRejection(result)).toBe(true);
            expect((result as any).reason).toMatch(/must live inside/);
        }
    });

    it('allows a nested path within the directory', () => {
        const result = resolveLocalSource(path.join(base, 'lineups/uk/all.m3u'), base);
        expect(isRejection(result)).toBe(false);
        expect((result as any).absolutePath).toBe(path.join(base, 'lineups/uk/all.m3u'));
    });

    it('rejects anything that is not a local reference', () => {
        const result = resolveLocalSource('https://example.com/a.m3u', base);
        expect(isRejection(result)).toBe(true);
    });

    it('does not treat a sibling directory with a shared prefix as inside', () => {
        const sibling = base + '-other';
        const result = resolveLocalSource(sibling + '/a.m3u', base);
        expect(isRejection(result)).toBe(true);
    });
});

describe('statLocalSource', () => {
    it('reports size and modification time', () => {
        const file = path.join(base, 'a.m3u');
        fs.writeFileSync(file, '#EXTM3U\n');
        const stat = statLocalSource(file);
        expect(stat.sizeBytes).toBe(8);
        expect(stat.lastModified).toMatch(/GMT$/);
    });

    it('names a missing file', () => {
        expect(() => statLocalSource(path.join(base, 'nope.m3u'))).toThrow(/No such file/);
    });

    it('refuses a directory', () => {
        expect(() => statLocalSource(base)).toThrow(/Not a file/);
    });
});

describe('isUnchanged', () => {
    const stat = { sizeBytes: 100, lastModified: 'Thu, 14 Aug 2026 12:00:00 GMT' };

    it('is the local equivalent of a 304', () => {
        expect(isUnchanged(stat, 'Thu, 14 Aug 2026 12:00:00 GMT')).toBe(true);
    });

    it('reads the file when it has been touched', () => {
        expect(isUnchanged(stat, 'Thu, 14 Aug 2026 11:00:00 GMT')).toBe(false);
    });

    it('reads the file when the size changed under an unchanged mtime', () => {
        expect(isUnchanged(stat, 'Thu, 14 Aug 2026 12:00:00 GMT', 90)).toBe(false);
    });

    it('reads the file when there is nothing to compare against', () => {
        expect(isUnchanged(stat, undefined)).toBe(false);
    });
});
