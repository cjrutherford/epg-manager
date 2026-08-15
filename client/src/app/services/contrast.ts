/**
 * WCAG contrast arithmetic, so "does this theme read?" is a measurement rather
 * than a judgement call.
 *
 * The app ships nine themes. Checking them by eye means checking one and
 * assuming the rest, which is how a semantic colour ends up illegible in the
 * two themes nobody opened.
 */

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** Parse `#rgb`, `#rrggbb`, or `r, g, b`. Returns null for anything else. */
export function parseColor(value: string): Rgb | null {
    const text = String(value || '').trim();

    const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const digits = hex[1];
        const full = digits.length === 3
            ? digits.split('').map(c => c + c).join('')
            : digits;
        return {
            r: parseInt(full.slice(0, 2), 16),
            g: parseInt(full.slice(2, 4), 16),
            b: parseInt(full.slice(4, 6), 16)
        };
    }

    const triple = text.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
    if (triple) {
        const [r, g, b] = [triple[1], triple[2], triple[3]].map(Number);
        if ([r, g, b].every(n => n >= 0 && n <= 255)) return { r, g, b };
    }

    return null;
}

function channelLuminance(value: number): number {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance, per WCAG 2.1. */
export function relativeLuminance(color: Rgb): number {
    return 0.2126 * channelLuminance(color.r)
        + 0.7152 * channelLuminance(color.g)
        + 0.0722 * channelLuminance(color.b);
}

/** Contrast ratio between two colours, from 1 (identical) to 21 (black/white). */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
    const a = relativeLuminance(foreground);
    const b = relativeLuminance(background);
    const lighter = Math.max(a, b);
    const darker = Math.min(a, b);
    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Compose a translucent colour over an opaque one, so a ratio reflects what is
 * actually on screen rather than the token in isolation.
 */
export function composite(foreground: Rgb, background: Rgb, alpha: number): Rgb {
    const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
    return {
        r: mix(foreground.r, background.r),
        g: mix(foreground.g, background.g),
        b: mix(foreground.b, background.b)
    };
}

export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3.0;

export function meetsAA(ratio: number, large = false): boolean {
    return ratio >= (large ? WCAG_AA_LARGE : WCAG_AA_NORMAL);
}

export interface ThemePalette {
    name: string;
    tokens: Record<string, string>;
}

/**
 * Pull every theme block out of the stylesheet.
 *
 * `:root` is the default theme; `body.theme-x` blocks are the alternatives.
 * Each inherits any token it does not redefine from `:root`, which is why the
 * base is merged in.
 */
export function extractThemes(css: string): ThemePalette[] {
    const readTokens = (block: string): Record<string, string> => {
        const tokens: Record<string, string> = {};
        for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
            tokens[match[1]] = match[2].trim();
        }
        return tokens;
    };

    const blockAfter = (index: number): string => {
        const open = css.indexOf('{', index);
        if (open === -1) return '';
        let depth = 1;
        let i = open + 1;
        while (i < css.length && depth > 0) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') depth--;
            i++;
        }
        return css.slice(open + 1, i - 1);
    };

    const rootIndex = css.search(/(^|\n):root\s*\{/);
    const base = rootIndex === -1 ? {} : readTokens(blockAfter(rootIndex));

    const themes: ThemePalette[] = [{ name: 'default', tokens: base }];

    for (const match of css.matchAll(/(^|\n)body\.theme-([\w-]+)\s*\{/g)) {
        const tokens = readTokens(blockAfter(match.index!));
        themes.push({ name: match[2], tokens: { ...base, ...tokens } });
    }

    return themes;
}

export interface ContrastFailure {
    theme: string;
    pair: string;
    ratio: number;
    required: number;
}

/**
 * Check the pairs that carry meaning: body text on the page, and the semantic
 * colours a user is expected to read as status.
 */
export function auditTheme(palette: ThemePalette): ContrastFailure[] {
    const failures: ContrastFailure[] = [];
    const background = parseColor(palette.tokens['--bg-deep'] || '');
    if (!background) return failures;

    const check = (tokenName: string, label: string, large: boolean) => {
        const color = parseColor(palette.tokens[tokenName] || '');
        if (!color) return;
        const ratio = contrastRatio(color, background);
        const required = large ? WCAG_AA_LARGE : WCAG_AA_NORMAL;
        if (ratio < required) {
            failures.push({ theme: palette.name, pair: label, ratio, required });
        }
    };

    check('--text-primary', 'body text', false);
    check('--text-secondary', 'secondary text', false);

    // Semantic colours are used for badges and short status labels, which are
    // bold and count as large text.
    for (const token of ['--color-success', '--color-danger', '--color-warning', '--color-info', '--color-primary']) {
        check(token, token.replace('--color-', '') + ' status', true);
    }

    return failures;
}
