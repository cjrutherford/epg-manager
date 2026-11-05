import { Inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { EN } from './messages.en';
import { AR } from './messages.ar';

export type LocaleCode = 'en' | 'ar';

/**
 * Runtime UI locale.
 *
 * A self-hosted binary cannot ship one build per locale, so the catalogue is
 * resolved at runtime and persisted locally. It is separate from the guide's
 * preferred content language (`config.preferred_lang`).
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
    locale: LocaleCode = 'en';
    private readonly isBrowser: boolean;
    private readonly catalogues: Record<LocaleCode, Record<string, string>> = { en: EN, ar: AR };

    constructor(@Inject(PLATFORM_ID) platformId: Object) {
        this.isBrowser = isPlatformBrowser(platformId);
        if (!this.isBrowser) return;
        const stored = localStorage.getItem('tuner_daemon_locale');
        if (stored === 'ar' || stored === 'en') this.locale = stored;
        this.applyDocument();
    }

    get isRtl(): boolean {
        return this.locale === 'ar';
    }

    setLocale(locale: LocaleCode): void {
        this.locale = locale;
        if (this.isBrowser) {
            localStorage.setItem('tuner_daemon_locale', locale);
            this.applyDocument();
        }
    }

    /** Falls back key-by-key to English so a partial catalogue never blanks the UI. */
    t(key: string, params?: Record<string, string | number>): string {
        const template = this.catalogues[this.locale][key] ?? EN[key] ?? key;
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
    }

    private applyDocument(): void {
        document.documentElement.lang = this.locale;
        document.documentElement.dir = this.isRtl ? 'rtl' : 'ltr';
    }
}
