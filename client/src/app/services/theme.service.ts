import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface Theme {
    key: string;
    name: string;
    primaryColor: string;
    bgColor: string;
}

@Injectable({
    providedIn: 'root'
})
export class ThemeService {
    private isBrowser: boolean;
    private currentTheme = 'cinematic-noir';

    readonly themes: Theme[] = [
        { key: 'cinematic-noir', name: 'Cinematic Noir', primaryColor: '#e8a854', bgColor: '#050505' },
        { key: 'neon-cyberpunk', name: 'Neon Cyberpunk', primaryColor: '#00f0ff', bgColor: '#0c0614' },
        { key: 'midnight-forest', name: 'Midnight Forest', primaryColor: '#3cd070', bgColor: '#08100c' },
        { key: 'cosmic-purple', name: 'Cosmic Purple', primaryColor: '#a855f7', bgColor: '#090514' },
        { key: 'arctic-ice', name: 'Arctic Ice', primaryColor: '#2563eb', bgColor: '#f1f5f9' }
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
            localStorage.setItem('iptv_theme', themeKey);
            this.applyTheme(themeKey);
        }
    }

    private loadAndApplyTheme(): void {
        if (!this.isBrowser) return;

        try {
            const saved = localStorage.getItem('iptv_theme');
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
