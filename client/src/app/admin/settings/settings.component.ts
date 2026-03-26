import { Component, OnInit, Inject, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

@Component({
    selector: 'app-settings',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './settings.component.html',
    styleUrl: './settings.component.css'
})
export class SettingsComponent implements OnInit {
    // Config
    playlists: any[] = [];
    selectedPlaylists: string[] = [];
    customPlaylistUrl = '';
    epgDays = 2;
    savingConfig = false;

    // iptv-org browser
    iptvOrgFiles: { name: string; url: string }[] = [];
    iptvOrgLoading = false;
    iptvOrgSearchQuery = '';

    // Metadata
    metadataEnabled = false;
    metadataStats: any = null;

    loading = true;
    private isBrowser: boolean;

    constructor(private api: ApiService, @Inject(PLATFORM_ID) platformId: Object) {
        this.isBrowser = isPlatformBrowser(platformId);
    }

    ngOnInit(): void {
        this.loadAll();
    }

    async loadAll(): Promise<void> {
        this.loading = true;
        try {
            const [playlists, config, metaConfig] = await Promise.all([
                this.api.getPlaylists().toPromise().catch(() => []),
                this.api.getConfig().toPromise().catch(() => ({})),
                this.api.getMetadataConfig().toPromise().catch(() => ({ enabled: false }))
            ]);
            this.playlists = playlists || [];

            // Load playlist_urls array, falling back to single playlist_url
            if (config?.playlist_urls && Array.isArray(config.playlist_urls)) {
                this.selectedPlaylists = config.playlist_urls;
            } else if (config?.playlist_url) {
                this.selectedPlaylists = [config.playlist_url];
            } else {
                this.selectedPlaylists = [];
            }

            this.epgDays = config?.epg_days || 2;
            this.metadataEnabled = metaConfig?.enabled || false;
            if (this.metadataEnabled) this.loadMetadataStats();
        } catch (e) {
            console.error(e);
        } finally {
            this.loading = false;
        }
    }

    async loadIptvOrgPlaylists(): Promise<void> {
        if (this.iptvOrgFiles.length > 0) return; // already loaded
        this.iptvOrgLoading = true;
        try {
            const dirs = await this.api.getIptvOrgPlaylists().toPromise() || [];
            // Each dir entry is a .m3u file or subdirectory
            const m3uFiles = dirs.filter((f: any) => f.name.endsWith('.m3u'));
            this.iptvOrgFiles = m3uFiles.map((f: any) => ({
                name: f.name.replace('.m3u', '').toUpperCase(),
                url: f.download_url || `https://raw.githubusercontent.com/iptv-org/iptv/master/streams/${f.name}`
            }));
        } catch (e) {
            console.error('Failed to load iptv-org list', e);
            this.iptvOrgFiles = [];
        } finally {
            this.iptvOrgLoading = false;
        }
    }

    get filteredIptvOrgFiles(): { name: string; url: string }[] {
        if (!this.iptvOrgSearchQuery) return this.iptvOrgFiles;
        const q = this.iptvOrgSearchQuery.toLowerCase();
        return this.iptvOrgFiles.filter(f => f.name.toLowerCase().includes(q));
    }

    isPlaylistSelected(url: string): boolean {
        return this.selectedPlaylists.includes(url);
    }

    toggleIptvOrgPlaylist(file: { name: string; url: string }): void {
        const idx = this.selectedPlaylists.indexOf(file.url);
        if (idx >= 0) {
            this.selectedPlaylists.splice(idx, 1);
        } else {
            this.selectedPlaylists.push(file.url);
        }
    }

    addCustomPlaylist(): void {
        const url = this.customPlaylistUrl.trim();
        if (!url) return;
        if (this.selectedPlaylists.includes(url)) {
            this.customPlaylistUrl = '';
            return;
        }
        this.selectedPlaylists.push(url);
        this.customPlaylistUrl = '';
    }

    removePlaylist(url: string): void {
        const idx = this.selectedPlaylists.indexOf(url);
        if (idx >= 0) {
            this.selectedPlaylists.splice(idx, 1);
        }
    }

    /** Derive a short display label from a URL */
    playlistLabel(url: string): string {
        // iptv-org raw URLs: extract the filename
        const match = url.match(/\/([^/]+)\.m3u$/i);
        if (match) return match[1].toUpperCase();
        // Custom URLs: show domain + truncated path
        try {
            const u = new URL(url);
            const shortPath = u.pathname.length > 30 ? '…' + u.pathname.slice(-28) : u.pathname;
            return u.hostname + shortPath;
        } catch {
            return url.length > 50 ? url.slice(0, 47) + '…' : url;
        }
    }

    async saveConfig(): Promise<void> {
        if (this.selectedPlaylists.length === 0) {
            alert('Select or enter at least one playlist URL');
            return;
        }

        this.savingConfig = true;
        try {
            await this.api.saveConfig({
                playlist_urls: this.selectedPlaylists,
                playlist_url: this.selectedPlaylists[0], // backward compat
                epg_days: this.epgDays
            }).toPromise();
            alert('Configuration saved!');
        } catch { alert('Save failed'); }
        finally { this.savingConfig = false; }
    }

    async toggleMetadata(): Promise<void> {
        try {
            await this.api.saveMetadataConfig({ enabled: this.metadataEnabled }).toPromise();
            if (this.metadataEnabled) this.loadMetadataStats();
        } catch { alert('Failed to update metadata config'); }
    }

    async loadMetadataStats(): Promise<void> {
        try {
            this.metadataStats = await this.api.getMetadataStats().toPromise();
        } catch { }
    }

    async triggerEnrichment(): Promise<void> {
        try {
            const res: any = await this.api.triggerEnrichment().toPromise();
            alert(res?.message || 'Enrichment started');
        } catch { alert('Failed'); }
    }

    async refreshImdbData(): Promise<void> {
        if (!confirm('Download fresh IMDb dataset? This may take a while.')) return;
        try {
            const res: any = await this.api.refreshImdbData().toPromise();
            alert(res?.message || 'Refresh started');
        } catch { alert('Failed'); }
    }

    async clearCache(): Promise<void> {
        if (!confirm('Clear all cached metadata?')) return;
        try {
            await this.api.clearMetadataCache().toPromise();
            alert('Cache cleared');
            this.loadMetadataStats();
        } catch { alert('Failed'); }
    }

    copyUrl(path: string): void {
        if (!this.isBrowser) return;
        const url = window.location.origin + path;
        navigator.clipboard.writeText(url).then(() => alert('Copied: ' + url));
    }
}
