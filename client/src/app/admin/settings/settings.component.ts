import { ChangeDetectorRef, Component, OnInit, Inject, PLATFORM_ID } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { StatComponent } from '../../shared/stat.component';
import { SkeletonComponent } from '../../shared/skeleton.component';
import { ConfirmService } from '../../services/confirm.service';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

@Component({
    selector: 'app-settings',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterLink, LucideAngularModule, PageHeaderComponent, StatComponent, SkeletonComponent],
    templateUrl: './settings.component.html',
    styleUrl: './settings.component.css'
})
export class SettingsComponent implements OnInit {
    epgDays = 2;
    savingConfig = false;
    dirty = false;

    // Channel numbering
    channelNumberingMode: string = 'auto-group';
    customRangesArray: { category: string, startNum: number }[] = [];

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
        private confirm: ConfirmService,
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
            const [config, metaConfig] = await Promise.all([
                this.api.getConfig().toPromise().catch(() => ({})),
                this.api.getMetadataConfig().toPromise().catch(() => ({ enabled: false }))
            ]);

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
            this.dirty = false;
            if (this.metadataEnabled) this.loadMetadataStats();
        } catch (e) {
            console.error(e);
        } finally {
            this.loading = false;
            this.cdr.detectChanges();
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
                epg_days: this.epgDays,
                preferred_lang: this.preferredLang,
                channel_numbering_mode: this.channelNumberingMode,
                custom_channel_ranges: JSON.stringify(rangesObj)
            }).toPromise();
            this.fieldErrors = {};
            this.dirty = false;
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
        const confirmed = await this.confirm.ask({
            title: 'Download the IMDb dataset?',
            message: 'This downloads a large file and can take several minutes.',
            confirmLabel: 'Download'
        });
        if (!confirmed) return;
        try {
            const res: any = await this.api.refreshImdbData().toPromise();
            this.toast.show(res?.message || 'Refresh started', 'success');
        } catch { this.toast.show('Failed to refresh IMDb data', 'error'); }
    }

    async clearCache(): Promise<void> {
        const confirmed = await this.confirm.ask({
            title: 'Clear cached metadata?',
            message: 'Artwork, ratings and episode details will be fetched again as they are needed.',
            detail: 'Your channels and guide data are not affected.',
            confirmLabel: 'Clear cache',
            destructive: true
        });
        if (!confirmed) return;
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

}
