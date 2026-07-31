import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class StorageService {
    private isBrowser: boolean;
    private backendFavorites: Set<string> = new Set();
    private backendHidden: Set<string> = new Set();
    private initialized = false;

    constructor(@Inject(PLATFORM_ID) platformId: Object, private api: ApiService) {
        this.isBrowser = isPlatformBrowser(platformId);
    }

    async init(): Promise<void> {
        if (this.initialized || !this.isBrowser) {
            this.initialized = true;
            return;
        }

        try {
            const [favs, hidden] = await Promise.all([
                this.api.getFavorites().toPromise(),
                this.api.getHiddenChannels().toPromise()
            ]);
            
            this.backendFavorites = new Set(favs || []);
            this.backendHidden = new Set(hidden || []);
            
            // Merge with localStorage (localStorage takes precedence for offline use)
            const localFavs = this.getLocalFavorites();
            const localHidden = this.getLocalHiddenChannels();
            
            localFavs.forEach(id => this.backendFavorites.add(id));
            localHidden.forEach(id => this.backendHidden.add(id));
            
            this.initialized = true;
        } catch (e) {
            // Fallback to localStorage only
            this.backendFavorites = this.getLocalFavorites();
            this.backendHidden = this.getLocalHiddenChannels();
            this.initialized = true;
        }
    }

    private getLocalFavorites(): Set<string> {
        if (!this.isBrowser) return new Set();
        try {
            const saved = localStorage.getItem('tuner_daemon_favorites');
            return saved ? new Set(JSON.parse(saved)) : new Set();
        } catch { return new Set(); }
    }

    private getLocalHiddenChannels(): Set<string> {
        if (!this.isBrowser) return new Set();
        try {
            const saved = localStorage.getItem('tuner_daemon_hidden_channels');
            return saved ? new Set(JSON.parse(saved)) : new Set();
        } catch { return new Set(); }
    }

    private saveLocalFavorites(favorites: Set<string>): void {
        if (!this.isBrowser) return;
        localStorage.setItem('tuner_daemon_favorites', JSON.stringify([...favorites]));
    }

    private saveLocalHidden(hidden: Set<string>): void {
        if (!this.isBrowser) return;
        localStorage.setItem('tuner_daemon_hidden_channels', JSON.stringify([...hidden]));
    }

    // ── Favorites ───────────────────────────────
    getFavorites(): Set<string> {
        return this.backendFavorites;
    }

    async toggleFavorite(channelId: string): Promise<Set<string>> {
        const isFav = this.backendFavorites.has(channelId);
        
        if (isFav) {
            this.backendFavorites.delete(channelId);
            try {
                await this.api.removeFavorite(channelId).toPromise();
            } catch { /* offline */ }
        } else {
            this.backendFavorites.add(channelId);
            try {
                await this.api.addFavorite(channelId).toPromise();
            } catch { /* offline */ }
        }
        
        // Also save to localStorage as backup
        this.saveLocalFavorites(this.backendFavorites);
        
        return this.backendFavorites;
    }

    isFavorite(channelId: string): boolean {
        return this.backendFavorites.has(channelId);
    }

    // ── Hidden Channels ─────────────────────────
    getHiddenChannels(): Set<string> {
        return this.backendHidden;
    }

    async toggleHidden(channelId: string): Promise<Set<string>> {
        const isHidden = this.backendHidden.has(channelId);
        
        if (isHidden) {
            this.backendHidden.delete(channelId);
            try {
                await this.api.unhideChannel(channelId).toPromise();
            } catch { /* offline */ }
        } else {
            this.backendHidden.add(channelId);
            try {
                await this.api.hideChannel(channelId).toPromise();
            } catch { /* offline */ }
        }
        
        // Also save to localStorage as backup
        this.saveLocalHidden(this.backendHidden);
        
        return this.backendHidden;
    }

    isHidden(channelId: string): boolean {
        return this.backendHidden.has(channelId);
    }

    // ── Last Channel ────────────────────────────
    getLastChannel(): string | null {
        if (!this.isBrowser) return null;
        return localStorage.getItem('tuner_daemon_last_channel');
    }

    setLastChannel(channelId: string): void {
        if (this.isBrowser) localStorage.setItem('tuner_daemon_last_channel', channelId);
    }

    // ── Volume ──────────────────────────────────
    getVolume(): number {
        if (!this.isBrowser) return 0.8;
        const saved = localStorage.getItem('tuner_daemon_volume');
        return saved !== null ? parseFloat(saved) : 0.8;
    }

    setVolume(volume: number): void {
        if (this.isBrowser) localStorage.setItem('tuner_daemon_volume', String(volume));
    }

    getMuted(): boolean {
        if (!this.isBrowser) return false;
        return localStorage.getItem('tuner_daemon_muted') === 'true';
    }

    setMuted(muted: boolean): void {
        if (this.isBrowser) localStorage.setItem('tuner_daemon_muted', String(muted));
    }
}