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
        { key: 'tuner-daemon', name: 'Tuner Daemon (Cyber Lime)', primaryColor: '#22c55e', bgColor: '#070a12' },
        { key: 'cinematic-noir', name: 'Cinematic Noir', primaryColor: '#e8a854', bgColor: '#050505' },
        { key: 'aether', name: 'Aether Vision', primaryColor: '#00f0ff', bgColor: '#05070e' },
        { key: 'pulse', name: 'Pulse Broadcast', primaryColor: '#ff007f', bgColor: '#0c0614' },
        { key: 'omni', name: 'Omni Station', primaryColor: '#3b82f6', bgColor: '#0b1120' },
        { key: 'midnight-forest', name: 'Midnight Forest', primaryColor: '#3cd070', bgColor: '#08100c' },
        { key: 'cosmic-purple', name: 'Cosmic Purple', primaryColor: '#a855f7', bgColor: '#090514' },
        { key: 'neon-cyberpunk', name: 'Neon Cyberpunk', primaryColor: '#e040fb', bgColor: '#110214' },
        { key: 'arctic-ice', name: 'Arctic Ice', primaryColor: '#4fc3f7', bgColor: '#020e14' }
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
