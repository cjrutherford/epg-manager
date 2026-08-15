import fs from 'fs';
import path from 'path';

/**
 * The scale exists so that "how big is this text" and "how much space goes
 * here" are answered once, not re-decided per rule. These tests are what stop
 * it drifting back: before this slice there were 42 distinct font sizes and 25
 * distinct spacing values, which is not a system with exceptions but the
 * absence of one.
 */

const clientSrc = path.resolve(__dirname, '../../..');
const sharedStylesheet = path.join(clientSrc, 'styles.css');
const adminDir = path.join(clientSrc, 'app/admin');

function stylesheetsUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...stylesheetsUnder(full));
        else if (entry.name.endsWith('.css')) found.push(full);
    }
    return found;
}

const adminStylesheets = stylesheetsUnder(adminDir);
const shared = fs.readFileSync(sharedStylesheet, 'utf8');

/** The token block itself is where raw values are supposed to live. */
function withoutTokenBlocks(css: string): string {
    return css.replace(/(?::root|body\.theme-[\w-]+)\s*\{[\s\S]*?\n\}/g, '');
}

describe('the type scale', () => {
    it('is declared once, with every step', () => {
        for (const step of ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl']) {
            expect(shared).toContain(`--font-${step}:`);
        }
    });

    it('is used instead of raw font sizes across the admin surface', () => {
        const offenders: string[] = [];
        for (const file of adminStylesheets) {
            const css = fs.readFileSync(file, 'utf8');
            for (const match of css.matchAll(/font-size:\s*([0-9.]+(?:rem|px))/g)) {
                offenders.push(`${path.basename(file)}: ${match[1]}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('is used instead of raw font sizes in the shared stylesheet', () => {
        const offenders = [...withoutTokenBlocks(shared).matchAll(/font-size:\s*([0-9.]+(?:rem|px))/g)]
            .map(m => m[1]);
        expect(offenders).toEqual([]);
    });
});

describe('the spacing scale', () => {
    it('is declared once, with every step', () => {
        for (const step of ['3xs', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl']) {
            expect(shared).toContain(`--space-${step}:`);
        }
    });

    it('is used instead of raw spacing across the admin surface', () => {
        const offenders: string[] = [];
        for (const file of adminStylesheets) {
            const css = fs.readFileSync(file, 'utf8');
            for (const match of css.matchAll(/(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?:\s*([^;{}]*\b\d+px\b[^;{}]*)/g)) {
                // Negative offsets are positioning, not spacing, and stay literal.
                if (/-\d+px/.test(match[1])) continue;
                offenders.push(`${path.basename(file)}: ${match[1].trim()}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('the radius scale', () => {
    it('covers the pill shape that was written as 999px throughout', () => {
        expect(shared).toContain('--radius-pill:');
    });

    it('is used instead of raw radii across the admin surface', () => {
        const offenders: string[] = [];
        for (const file of adminStylesheets) {
            const css = fs.readFileSync(file, 'utf8');
            for (const match of css.matchAll(/border-radius:\s*(\d+px)/g)) {
                offenders.push(`${path.basename(file)}: ${match[1]}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('colour', () => {
    it('never hardcodes a colour in admin stylesheets', () => {
        const offenders: string[] = [];
        for (const file of adminStylesheets) {
            const css = fs.readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '');   // comments may cite the old value
            for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
                offenders.push(`${path.basename(file)}: ${match[0]}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('gives every theme a readable label colour for solid fills', () => {
        expect(shared).toContain('--color-danger-text:');
        expect(shared).toContain('--color-primary-text:');
    });
});
