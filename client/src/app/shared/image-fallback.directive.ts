import { Directive, HostListener, Input, OnChanges, SimpleChanges } from '@angular/core';

/**
 * Replace a failed channel/recording logo with a generated monogram.
 *
 * Channel logos are remote URLs. When one is missing, slow or blocked, the
 * browser draws its broken-image glyph and the alt text — which looks like a
 * rendering bug at exactly the moment a user is trying to work out what is
 * wrong. A data-URI monogram keeps the row intact and tells the user nothing
 * more than "this logo did not load".
 *
 * Usage:
 *   <img [src]="channel.logo" [appImageFallback]="channel.name" alt="">
 */
@Directive({
    selector: 'img[appImageFallback]',
    standalone: true
})
export class ImageFallbackDirective implements OnChanges {
    /** The human name used to derive the initials. */
    @Input('appImageFallback') name: string | null = '';

    /** Two-letter monogram, or one letter for a single-word name. */
    private failed = false;

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['name'] && !changes['name'].firstChange) {
            this.failed = false;
        }
    }

    @HostListener('error', ['$event'])
    onError(event: Event): void {
        if (this.failed) return;
        this.failed = true;

        const img = event.target as HTMLImageElement;
        img.src = this.monogram(this.name || img.alt || '?');
        img.classList.add('image-fallback--active');
    }

    private monogram(name: string): string {
        const words = String(name)
            .replace(/[^a-zA-Z0-9 ]/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        const initials = (words.length > 1
            ? words[0][0] + words[1][0]
            : (words[0] || '?').slice(0, 2)
        ).toUpperCase();

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">`
            + `<rect width="64" height="64" rx="10" fill="#1b1610"/>`
            + `<rect x="0.5" y="0.5" width="63" height="63" rx="9.5" fill="none" stroke="#3a2e1d"/>`
            + `<text x="32" y="41" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif"`
            + ` font-size="24" font-weight="700" fill="#d9a35e">${initials}</text>`
            + `</svg>`;

        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
}
