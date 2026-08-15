import fs from 'fs';
import path from 'path';
import {
    auditTheme,
    composite,
    contrastRatio,
    extractThemes,
    meetsAA,
    parseColor,
    relativeLuminance
} from '../contrast';

const css = fs.readFileSync(
    path.resolve(__dirname, '../../../styles.css'),
    'utf8'
);

describe('parseColor', () => {
    it('reads hex in both lengths', () => {
        expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
        expect(parseColor('#1d4ed8')).toEqual({ r: 29, g: 78, b: 216 });
    });

    it('reads an rgb triple, the form the theme tokens use', () => {
        expect(parseColor('37, 99, 235')).toEqual({ r: 37, g: 99, b: 235 });
    });

    it('returns null rather than a wrong colour', () => {
        for (const bad of ['', 'red', '#12', 'rgb(1,2,3)', '300, 0, 0']) {
            expect(parseColor(bad)).toBeNull();
        }
    });
});

describe('contrastRatio', () => {
    it('is 21 for black on white', () => {
        expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 1);
    });

    it('is 1 for a colour on itself', () => {
        expect(contrastRatio({ r: 80, g: 80, b: 80 }, { r: 80, g: 80, b: 80 })).toBeCloseTo(1, 5);
    });

    it('does not care which way round the arguments are', () => {
        const a = { r: 20, g: 30, b: 40 };
        const b = { r: 200, g: 210, b: 220 };
        expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
    });

    it('agrees with a known WCAG value', () => {
        // #767676 on white is the canonical 4.54:1 boundary case.
        expect(contrastRatio({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(4.54, 1);
    });
});

describe('relativeLuminance', () => {
    it('runs from 0 to 1', () => {
        expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
        expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    });
});

describe('composite', () => {
    it('blends toward the background as alpha falls', () => {
        const white = { r: 255, g: 255, b: 255 };
        const black = { r: 0, g: 0, b: 0 };
        expect(composite(white, black, 1)).toEqual(white);
        expect(composite(white, black, 0)).toEqual(black);
        expect(composite(white, black, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
    });
});

describe('meetsAA', () => {
    it('uses the right threshold for each text size', () => {
        expect(meetsAA(4.5)).toBe(true);
        expect(meetsAA(4.49)).toBe(false);
        expect(meetsAA(3.0, true)).toBe(true);
        expect(meetsAA(2.99, true)).toBe(false);
    });
});

describe('the shipped themes', () => {
    const themes = extractThemes(css);

    it('finds every theme in the stylesheet', () => {
        expect(themes.length).toBeGreaterThanOrEqual(9);
        expect(themes.map(t => t.name)).toContain('arctic-ice');
    });

    it('ships both a light and a dark theme', () => {
        const luminance = themes
            .map(t => ({ name: t.name, bg: parseColor(t.tokens['--bg-deep'] || '') }))
            .filter(t => t.bg)
            .map(t => ({ name: t.name, l: relativeLuminance(t.bg!) }));

        expect(luminance.some(t => t.l > 0.5)).toBe(true);  // a light theme
        expect(luminance.some(t => t.l < 0.1)).toBe(true);  // a dark theme
    });

    // The criterion: text and semantic colours must be readable in every theme,
    // not only in whichever one the developer happened to have open.
    it('passes WCAG AA on text and semantic colours in every theme', () => {
        const failures = themes.flatMap(auditTheme);
        const readable = failures.map(f =>
            `${f.theme}: ${f.pair} is ${f.ratio.toFixed(2)}:1, needs ${f.required}:1`
        );
        expect(readable).toEqual([]);
    });
});
