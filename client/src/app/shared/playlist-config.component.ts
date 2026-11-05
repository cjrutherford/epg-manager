import { Component, EventEmitter, Output, ChangeDetectorRef, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ApiService } from '../services/api.service';
import { ToastService } from '../services/toast.service';

interface PlaylistItem {
    url: string;
    name: string;
    label: string;
    category: string;
    host: string;
    pathSummary: string;
    channelCountEstimate: number | null;
    importedCount: number;
}

interface PresetItem {
    id: string;
    label: string;
    url: string;
    category: string;
    channelCountEstimate: number | null;
}

/**
 * Playlist selection, now owned by Sources.
 *
 * This used to live inside Settings, where the user configured a playlist on
 * one page and diagnosed it on another. The component keeps the whole
 * selection flow together: presets, a custom URL, the IPTV-ORG catalogue and
 * the save action that reconciles the source registry.
 */
@Component({
    selector: 'app-playlist-config',
    standalone: true,
    imports: [CommonModule, FormsModule, LucideAngularModule],
    templateUrl: './playlist-config.component.html',
    styleUrl: './playlist-config.component.css'
})
export class PlaylistConfigComponent implements OnInit {
    @Output() saved = new EventEmitter<void>();

    selectedPlaylists: string[] = [];
    allPlaylists: PlaylistItem[] = [];
    presets: PresetItem[] = [];
    catalogFiles: PlaylistItem[] = [];
    customUrl = '';
    search = '';
    category = 'all';
    loading = true;
    saving = false;
    catalogLoading = false;
    syncing = false;
    catalogOpen = false;
    dirty = false;
    error: string | null = null;

    constructor(
        private api: ApiService,
        private toast: ToastService,
        private cdr: ChangeDetectorRef
    ) { }

    ngOnInit(): void {
        this.load();
    }

    async load(): Promise<void> {
        this.loading = true;
        this.error = null;
        try {
            const [config, playlists, catalog] = await Promise.all([
                this.api.getConfig().toPromise(),
                this.api.getPlaylists().toPromise().catch(() => null),
                this.api.getSourceCatalog().toPromise().catch(() => [])
            ]);
            const urls = Array.isArray(config?.playlist_urls) ? config.playlist_urls : [];
            this.selectedPlaylists = urls;
            this.allPlaylists = playlists?.items || [];
            this.presets = (catalog || []).filter((entry: PresetItem) => entry.category === 'fast');
        } catch (e: any) {
            this.error = e?.error?.error || 'Could not load your playlists.';
        } finally {
            this.loading = false;
            this.cdr.markForCheck();
        }
    }

    get selectedDetails(): PlaylistItem[] {
        return this.selectedPlaylists.map(url => {
            const known = this.allPlaylists.find(item => item.url === url)
                || this.catalogFiles.find(item => item.url === url);
            if (known) return known;

            // Quick presets (Plex, Pluto, …) are in the catalogue but not in
            // the imported-playlist response until the first sync. Without
            // this lookup the chip fell back to the URL's filename, which for
            // every built-in is "all".
            const preset = this.presets.find(item => item.url === url);
            if (preset) {
                return {
                    url,
                    name: preset.label,
                    label: preset.label,
                    category: preset.category,
                    host: this.hostFor(url),
                    pathSummary: url,
                    channelCountEstimate: preset.channelCountEstimate,
                    importedCount: 0
                };
            }

            const label = this.labelFor(url);
            return {
                url,
                name: label,
                label,
                category: 'custom',
                host: this.hostFor(url),
                pathSummary: url,
                channelCountEstimate: null,
                importedCount: 0
            };
        });
    }

    get selectedImportedChannels(): number {
        return this.selectedDetails.reduce((sum, item) => sum + (item.importedCount || 0), 0);
    }

    get selectedEstimatedChannels(): number {
        return this.selectedDetails.reduce((sum, item) => sum + (item.channelCountEstimate || 0), 0);
    }

    isSelected(url: string): boolean {
        return this.selectedPlaylists.includes(url);
    }

    addPreset(url: string): void {
        if (!url || this.isSelected(url)) return;
        this.selectedPlaylists.push(url);
        this.dirty = true;
        this.toast.show('Playlist added. Save to update Sources.', 'info');
    }

    addCustom(): void {
        const url = this.customUrl.trim();
        if (!url) return;
        if (!this.isSelected(url)) this.selectedPlaylists.push(url);
        this.customUrl = '';
        this.dirty = true;
    }

    remove(url: string): void {
        this.selectedPlaylists = this.selectedPlaylists.filter(item => item !== url);
        this.dirty = true;
    }

    async openCatalog(): Promise<void> {
        this.catalogOpen = true;
        if (this.catalogFiles.length > 0 || this.catalogLoading) return;
        this.catalogLoading = true;
        try {
            const files = await this.api.getIptvOrgPlaylists().toPromise() || [];
            this.catalogFiles = (files || []).map((file: any) => this.toItem(file));
        } catch {
            this.toast.show('Could not load the channel catalogues.', 'error');
        } finally {
            this.catalogLoading = false;
            this.cdr.markForCheck();
        }
    }

    async syncCatalog(): Promise<void> {
        this.syncing = true;
        try {
            await this.api.syncIptvOrgPlaylists().toPromise();
            this.catalogFiles = [];
            await this.openCatalog();
            this.toast.show('Channel catalogue synced.', 'success');
        } catch {
            this.toast.show('Could not sync the channel catalogue.', 'error');
        } finally {
            this.syncing = false;
            this.cdr.markForCheck();
        }
    }

    toggleCatalogItem(url: string): void {
        if (this.isSelected(url)) this.remove(url);
        else {
            this.selectedPlaylists.push(url);
            this.dirty = true;
        }
    }

    get filteredCatalog(): PlaylistItem[] {
        const query = this.search.trim().toLowerCase();
        return this.catalogFiles
            .filter(item => this.category === 'all' || item.category === this.category)
            .filter(item => !query || [item.label, item.name, item.host, item.pathSummary].join(' ').toLowerCase().includes(query))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    get categories(): string[] {
        return [...new Set(this.catalogFiles.map(item => item.category))].sort();
    }

    async save(): Promise<void> {
        if (this.saving) return;
        this.saving = true;
        try {
            await this.api.saveConfig({ playlist_urls: this.selectedPlaylists }).toPromise();
            this.dirty = false;
            this.toast.show('Playlists saved. Run a sync to import channels.', 'success');
            this.saved.emit();
        } catch (e: any) {
            this.toast.show(e?.error?.error || 'Could not save playlists.', 'error');
        } finally {
            this.saving = false;
            this.cdr.markForCheck();
        }
    }

    labelFor(url: string): string {
        const known = this.allPlaylists.find(item => item.url === url)
            || this.catalogFiles.find(item => item.url === url)
            || this.presets.find(item => item.url === url);
        if (known?.label) return known.label;
        const file = url.split('/').filter(Boolean).pop() || url;
        return file.replace(/\.(m3u8?|xml|gz)$/i, '') || this.hostFor(url);
    }

    hostFor(url: string): string {
        try { return new URL(url).hostname; } catch { return 'local'; }
    }

    private toItem(file: any): PlaylistItem {
        return {
            url: file.url,
            name: file.name || file.label || file.url,
            label: file.label || file.name || file.url,
            category: file.category || 'catalogue',
            host: file.host || this.hostFor(file.url),
            pathSummary: file.pathSummary || file.url,
            channelCountEstimate: file.channelCountEstimate ?? null,
            importedCount: file.importedCount || 0
        };
    }
}
