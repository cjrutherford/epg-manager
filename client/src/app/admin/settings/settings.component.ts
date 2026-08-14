import { ChangeDetectorRef, Component, OnInit, Inject, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

@Component({
    selector: 'app-settings',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './settings.component.html',
    styleUrl: './settings.component.css'
})
export class SettingsComponent implements OnInit {
    playlists: any[] = [];
    playlistSummary = { selectedCount: 0, importedChannels: 0, estimatedChannels: 0 };

    // Config
    selectedPlaylists: string[] = [];
    customPlaylistUrl = '';
    epgDays = 2;
    savingConfig = false;

    // Channel Numbering
    // Matches the server default; these used to disagree, so the value you
    // saw depended on whether the server had an explicit setting stored.
    channelNumberingMode: string = 'auto-group';
    customRangesArray: { category: string, startNum: number }[] = [];

    // iptv-org browser
    iptvOrgFiles: PlaylistViewModel[] = [];
    iptvOrgLoading = false;
    iptvOrgSyncing = false;
    iptvOrgSearchQuery = '';
    iptvOrgCategoryFilter = 'all';
    iptvOrgSortKey: 'name' | 'category' | 'channelCount' | 'selected' = 'selected';
    iptvOrgSortDir: 'asc' | 'desc' = 'asc';

    // Built-in source catalogue (served by the API — no hardcoded list here)
    builtInPresets: BuiltInPreset[] = [];

    preferredLang = '';
    readonly languages = [
        { code: '', label: 'Any language' },
        { code: 'en', label: 'English' },
        { code: 'es', label: 'Spanish' },
        { code: 'fr', label: 'French' },
        { code: 'de', label: 'German' },
        { code: 'it', label: 'Italian' },
        { code: 'pt', label: 'Portuguese' },
        { code: 'nl', label: 'Dutch' },
        { code: 'pl', label: 'Polish' },
        { code: 'ru', label: 'Russian' },
        { code: 'ar', label: 'Arabic' }
    ];

    // Metadata
    metadataEnabled = false;
    metadataStats: any = null;

    loading = true;
    private isBrowser: boolean;

    constructor(
        private api: ApiService,
        private toast: ToastService,
        private cdr: ChangeDetectorRef,
        @Inject(PLATFORM_ID) platformId: Object
    ) {
        this.isBrowser = isPlatformBrowser(platformId);
    }

    ngOnInit(): void {
        this.loadAll();
    }

    async loadAll(): Promise<void> {
        this.loading = true;
        try {
            const [playlistResponse, config, metaConfig, catalog] = await Promise.all([
                this.api.getPlaylists().toPromise().catch(() => []),
                this.api.getConfig().toPromise().catch(() => ({})),
                this.api.getMetadataConfig().toPromise().catch(() => ({ enabled: false })),
                this.api.getSourceCatalog().toPromise().catch(() => [])
            ]);
            this.builtInPresets = (catalog || []).filter(entry => entry.category === 'fast');
            this.playlists = playlistResponse?.items || [];
            this.playlistSummary = playlistResponse?.summary || { selectedCount: 0, importedChannels: 0, estimatedChannels: 0 };

            // Load playlist_urls array, falling back to single playlist_url
            if (config?.playlist_urls && Array.isArray(config.playlist_urls)) {
                this.selectedPlaylists = config.playlist_urls;
            } else if (config?.playlist_url) {
                this.selectedPlaylists = [config.playlist_url];
            } else {
                this.selectedPlaylists = [];
            }

            this.epgDays = config?.epg_days || 2;
            this.preferredLang = config?.preferred_lang || '';
            
            // Channel Numbering
            this.channelNumberingMode = config?.channel_numbering_mode || 'auto-group';
            try {
                const ranges = JSON.parse(config?.custom_channel_ranges || '{}');
                this.customRangesArray = Object.keys(ranges).map(k => ({ category: k, startNum: ranges[k] }));
            } catch (e) {
                this.customRangesArray = [];
            }

            this.metadataEnabled = metaConfig?.enabled ?? true;
            if (this.metadataEnabled) this.loadMetadataStats();
        } catch (e) {
            console.error(e);
        } finally {
            this.loading = false;
            this.cdr.detectChanges();
        }
    }

    async loadIptvOrgPlaylists(): Promise<void> {
        this.iptvOrgLoading = true;
        try {
            const files = await this.api.getIptvOrgPlaylists().toPromise() || [];
            this.iptvOrgFiles = (files || []).map((file: any) => this.toPlaylistViewModel(file));
        } catch (e) {
            console.error('Failed to load iptv-org list', e);
            this.iptvOrgFiles = [];
        } finally {
            this.iptvOrgLoading = false;
            this.cdr.detectChanges();
        }
    }

    async syncIptvOrgRepo(): Promise<void> {
        this.iptvOrgSyncing = true;
        try {
            this.toast.show('Downloading and syncing IPTV-ORG repository...', 'info');
            await this.api.syncIptvOrgPlaylists().toPromise();
            this.toast.show('IPTV-ORG repository synced successfully!', 'success');
            await this.loadIptvOrgPlaylists();
        } catch (e) {
            this.toast.show('Failed to sync iptv-org repository. Check terminal logs.', 'error');
        } finally {
            this.iptvOrgSyncing = false;
            this.cdr.detectChanges();
        }
    }

    get filteredIptvOrgFiles(): PlaylistViewModel[] {
        const q = this.iptvOrgSearchQuery.toLowerCase();
        const filtered = this.iptvOrgFiles.filter((file) => {
            const matchesSearch = !q || [file.name, file.label, file.host, file.pathSummary].join(' ').toLowerCase().includes(q);
            const matchesCategory = this.iptvOrgCategoryFilter === 'all'
                || (this.iptvOrgCategoryFilter === 'selected' && this.isPlaylistSelected(file.url))
                || file.category === this.iptvOrgCategoryFilter;
            return matchesSearch && matchesCategory;
        });

        return [...filtered].sort((a, b) => this.comparePlaylists(a, b));
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

    addPresetPlaylist(url: string): void {
        if (!url) return;
        if (!this.selectedPlaylists.includes(url)) {
            this.selectedPlaylists.push(url);
            this.toast.show(`Added preset playlist: ${url}`, 'success');
        } else {
            this.toast.show(`Playlist already added`, 'info');
        }
        this.cdr.markForCheck();
    }

    removePlaylist(url: string): void {
        const idx = this.selectedPlaylists.indexOf(url);
        if (idx >= 0) {
            this.selectedPlaylists.splice(idx, 1);
        }
    }

    /** Derive a short display label from a URL */
    playlistLabel(url: string): string {
        const known = this.playlists.find((playlist) => playlist.url === url) || this.iptvOrgFiles.find((playlist) => playlist.url === url);
        if (known?.label) return known.label;
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

    /** Per-field messages from the last rejected save, keyed by setting name. */
    fieldErrors: Record<string, string> = {};

    async saveConfig(): Promise<void> {
        this.savingConfig = true;
        try {
            const rangesObj: Record<string, number> = {};
            for (const item of this.customRangesArray) {
                if (item.category.trim()) rangesObj[item.category.trim()] = item.startNum;
            }

            // playlist_url is derived from the list server-side now, so it is
            // no longer sent as a second copy that could disagree with it.
            await this.api.saveConfig({
                playlist_urls: this.selectedPlaylists,
                epg_days: this.epgDays,
                preferred_lang: this.preferredLang,
                channel_numbering_mode: this.channelNumberingMode,
                custom_channel_ranges: JSON.stringify(rangesObj)
            }).toPromise();
            this.fieldErrors = {};
            this.toast.show('Configuration saved', 'success');
        } catch (e: any) {
            // The API names each offending field, so the form can point at them
            // rather than showing one opaque failure.
            const errors: { field: string; message: string }[] = e?.error?.errors || [];
            this.fieldErrors = {};
            for (const item of errors) this.fieldErrors[item.field] = item.message;

            this.toast.show(
                errors.length > 0
                    ? `Not saved — ${errors.length} setting(s) need attention`
                    : (e?.error?.error || 'Save failed'),
                'error'
            );
        }
        finally {
            this.savingConfig = false;
            this.cdr.detectChanges();
        }
    }

    addCustomRange(): void {
        this.customRangesArray.push({ category: '', startNum: 100 });
    }

    removeCustomRange(index: number): void {
        this.customRangesArray.splice(index, 1);
    }

    async toggleMetadata(): Promise<void> {
        try {
            await this.api.saveMetadataConfig({ enabled: this.metadataEnabled }).toPromise();
            if (this.metadataEnabled) this.loadMetadataStats();
            this.toast.show(this.metadataEnabled ? 'Metadata enrichment enabled' : 'Metadata enrichment disabled', 'success');
        } catch { this.toast.show('Failed to update metadata config', 'error'); }
    }

    async loadMetadataStats(): Promise<void> {
        try {
            this.metadataStats = await this.api.getMetadataStats().toPromise();
        } catch { }
    }

    async triggerEnrichment(): Promise<void> {
        try {
            const res: any = await this.api.triggerEnrichment().toPromise();
            this.toast.show(res?.message || 'Enrichment started', 'success');
        } catch { this.toast.show('Failed to start enrichment', 'error'); }
    }

    async refreshImdbData(): Promise<void> {
        if (!confirm('Download fresh IMDb dataset? This may take a while.')) return;
        try {
            const res: any = await this.api.refreshImdbData().toPromise();
            this.toast.show(res?.message || 'Refresh started', 'success');
        } catch { this.toast.show('Failed to refresh IMDb data', 'error'); }
    }

    async clearCache(): Promise<void> {
        if (!confirm('Clear all cached metadata?')) return;
        try {
            await this.api.clearMetadataCache().toPromise();
            this.toast.show('Cache cleared', 'success');
            this.loadMetadataStats();
        } catch { this.toast.show('Failed to clear cache', 'error'); }
    }

    copyUrl(path: string): void {
        if (!this.isBrowser) return;
        const url = window.location.origin + path;
        navigator.clipboard.writeText(url).then(() => this.toast.show('Copied: ' + url, 'success'));
    }

    get selectedPlaylistDetails(): PlaylistViewModel[] {
        return this.selectedPlaylists.map((url) => {
            const match = this.playlists.find((playlist) => playlist.url === url)
                || this.iptvOrgFiles.find((playlist) => playlist.url === url);
            return match || this.toPlaylistViewModel({ url, name: this.playlistLabel(url), label: this.playlistLabel(url), category: 'custom', sourceType: 'custom', host: 'custom', pathSummary: url, channelCountEstimate: null, importedCount: 0 });
        });
    }

    get selectedPlaylistScope() {
        const selected = this.selectedPlaylistDetails;
        const importedChannels = selected.reduce((sum, item) => sum + (item.importedCount || 0), 0);
        const estimatedChannels = selected.reduce((sum, item) => sum + (item.channelCountEstimate || 0), 0);
        const isLargeSelection = selected.length >= 8 || estimatedChannels >= 2000 || this.epgDays >= 5;
        return {
            selectedCount: selected.length,
            importedChannels,
            estimatedChannels,
            isLargeSelection
        };
    }

    private comparePlaylists(a: PlaylistViewModel, b: PlaylistViewModel): number {
        const dir = this.iptvOrgSortDir === 'asc' ? 1 : -1;
        let left: string | number = '';
        let right: string | number = '';

        switch (this.iptvOrgSortKey) {
            case 'category':
                left = a.category;
                right = b.category;
                break;
            case 'channelCount':
                left = a.channelCountEstimate || 0;
                right = b.channelCountEstimate || 0;
                break;
            case 'selected':
                left = this.isPlaylistSelected(a.url) ? 1 : 0;
                right = this.isPlaylistSelected(b.url) ? 1 : 0;
                if (left === right) {
                    left = a.label.toLowerCase();
                    right = b.label.toLowerCase();
                }
                break;
            default:
                left = a.label.toLowerCase();
                right = b.label.toLowerCase();
                break;
        }

        if (left < right) return -1 * dir;
        if (left > right) return 1 * dir;
        return 0;
    }

    private toPlaylistViewModel(file: any): PlaylistViewModel {
        return {
            name: file.name,
            url: file.url,
            label: file.label || file.name,
            category: file.category || 'custom',
            sourceType: file.sourceType || 'custom',
            host: file.host || 'custom',
            pathSummary: file.pathSummary || file.url,
            channelCountEstimate: file.channelCountEstimate ?? null,
            importedCount: file.importedCount || file.count || 0
        };
    }
}

interface BuiltInPreset {
    id: string;
    label: string;
    url: string;
    category: string;
    channelCountEstimate: number | null;
}

interface PlaylistViewModel {
    name: string;
    url: string;
    label: string;
    category: string;
    sourceType: string;
    host: string;
    pathSummary: string;
    channelCountEstimate: number | null;
    importedCount: number;
}
