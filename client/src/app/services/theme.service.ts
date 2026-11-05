import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface Theme {
    key: string;
    name: string;
    primaryColor: string;
    bgColor: string;
    /** One line explaining what the theme is for, shown in the picker. */
    description?: string;
}

@Injectable({
    providedIn: 'root'
})
export class ThemeService {
    private isBrowser: boolean;
    private currentTheme = 'cinematic-noir';

    /**
     * Ordered so the first four are the curated choices in the picker.
     * Everything after them lives behind "Show all themes".
     */
    readonly themes: Theme[] = [
        { key: 'cinematic-noir', name: 'Cinematic Noir', description: 'Warm amber on near-black — the default', primaryColor: '#e8a854', bgColor: '#050505' },
        { key: 'daylight', name: 'Daylight', description: 'Warm paper and ink for bright rooms', primaryColor: '#955613', bgColor: '#f5efe5' },
        { key: 'high-contrast', name: 'High Contrast', description: 'Brighter borders and text for low vision', primaryColor: '#ffd23f', bgColor: '#000000' },
        { key: 'tuner-daemon', name: 'Tuner Daemon', description: 'Cyber-lime accents on deep navy', primaryColor: '#22c55e', bgColor: '#070a12' },
        { key: 'midnight-forest', name: 'Midnight Forest', description: 'Bioluminescent green and deep woodland', primaryColor: '#3cd070', bgColor: '#08100c' },
    ];

    constructor(@Inject(PLATFORM_ID) platformId: Object) {
        this.isBrowser = isPlatformBrowser(platformId);
        this.loadAndApplyTheme();
    }

    getThemes(): Theme[] {
        return this.themes;
    }

    getCurrentThemeKey(): string {
        return this.currentTheme;
    }

    setTheme(themeKey: string): void {
        const theme = this.themes.find(t => t.key === themeKey);
        if (!theme) return;

        this.currentTheme = themeKey;

        if (this.isBrowser) {
            localStorage.setItem('tuner_daemon_theme', themeKey);
            this.applyTheme(themeKey);
        }
    }

    private loadAndApplyTheme(): void {
        if (!this.isBrowser) return;

        try {
            const saved = localStorage.getItem('tuner_daemon_theme');
            if (saved && this.themes.some(t => t.key === saved)) {
                this.currentTheme = saved;
            }
        } catch (_) {}

        this.applyTheme(this.currentTheme);
    }

    private applyTheme(themeKey: string): void {
        if (!this.isBrowser) return;

        const body = document.body;
        // Remove all previous theme classes
        this.themes.forEach(t => {
            body.classList.remove(`theme-${t.key}`);
        });

        // Add selected theme class
        if (themeKey !== 'cinematic-noir') {
            body.classList.add(`theme-${themeKey}`);
        }
    }
}
