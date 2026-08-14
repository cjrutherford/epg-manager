import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAtomicWriteStream, writeFileAtomic } from '../atomic-write';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const target = () => path.join(dir, 'epg.xml');
const leftovers = () => fs.readdirSync(dir).filter(f => f.includes('.tmp-'));

describe('writeFileAtomic', () => {
    it('writes the file', () => {
        writeFileAtomic(target(), '<tv></tv>');
        expect(fs.readFileSync(target(), 'utf8')).toBe('<tv></tv>');
    });

    it('replaces an existing file wholesale', () => {
        fs.writeFileSync(target(), 'old content that is quite long');
        writeFileAtomic(target(), 'new');
        expect(fs.readFileSync(target(), 'utf8')).toBe('new');
    });

    it('leaves no temp files behind', () => {
        writeFileAtomic(target(), 'x'.repeat(100_000));
        expect(leftovers()).toEqual([]);
    });

    it('never leaves the target partially written', () => {
        // The target only ever changes at the rename, so at no point between
        // the old and new content does a reader see a fragment.
        fs.writeFileSync(target(), 'COMPLETE-OLD');
        const seen: string[] = [];

        const originalRename = fs.renameSync;
        const spy = jest.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
            // Sample the target immediately before the swap.
            seen.push(fs.readFileSync(to, 'utf8'));
            return originalRename(from, to);
        }) as any);

        writeFileAtomic(target(), 'COMPLETE-NEW');
        spy.mockRestore();

        expect(seen).toEqual(['COMPLETE-OLD']);
        expect(fs.readFileSync(target(), 'utf8')).toBe('COMPLETE-NEW');
    });
});

describe('createAtomicWriteStream', () => {
    it('publishes only on commit', async () => {
        fs.writeFileSync(target(), 'PREVIOUS');
        const stream = createAtomicWriteStream(target());

        await stream.write('<?xml version="1.0"?>\n<tv>\n');
        await stream.write('  <channel id="a" />\n');

        // Mid-write, a reader still gets the whole previous file.
        expect(fs.readFileSync(target(), 'utf8')).toBe('PREVIOUS');

        await stream.write('</tv>');
        await stream.commit();

        expect(fs.readFileSync(target(), 'utf8')).toContain('</tv>');
        expect(leftovers()).toEqual([]);
    });

    it('writes to a temp path in the same directory, so the rename is atomic', () => {
        const stream = createAtomicWriteStream(target());
        expect(path.dirname(stream.tempPath)).toBe(dir);
        return stream.abort();
    });

    it('leaves the previous file untouched when aborted', async () => {
        fs.writeFileSync(target(), 'PREVIOUS');
        const stream = createAtomicWriteStream(target());
        await stream.write('half a document');
        await stream.abort();

        expect(fs.readFileSync(target(), 'utf8')).toBe('PREVIOUS');
        expect(leftovers()).toEqual([]);
    });

    it('creates the target when there was none', async () => {
        const stream = createAtomicWriteStream(target());
        await stream.write('fresh');
        await stream.commit();
        expect(fs.readFileSync(target(), 'utf8')).toBe('fresh');
    });

    it('handles a document larger than the stream buffer', async () => {
        const stream = createAtomicWriteStream(target());
        const chunk = 'y'.repeat(64 * 1024);
        for (let i = 0; i < 40; i++) await stream.write(chunk);
        await stream.commit();

        expect(fs.statSync(target()).size).toBe(chunk.length * 40);
        expect(leftovers()).toEqual([]);
    });

    it('reports a failure instead of publishing a broken file', async () => {
        // A directory that does not exist stands in for the disk going away.
        const missing = path.join(dir, 'gone', 'epg.xml');
        const stream = createAtomicWriteStream(missing);

        await expect(
            stream.write('partial').then(() => stream.commit())
        ).rejects.toThrow();

        expect(fs.existsSync(missing)).toBe(false);
    });

    it('does not clobber the target when the export is abandoned mid-write', async () => {
        fs.writeFileSync(target(), 'PREVIOUS');
        const stream = createAtomicWriteStream(target());
        await stream.write('<?xml version="1.0"?>\n<tv>\n  <channel id="a" />\n');
        // No closing </tv>: the export gave up half way.
        await stream.abort();

        expect(fs.readFileSync(target(), 'utf8')).toBe('PREVIOUS');
        expect(leftovers()).toEqual([]);
    });
});
