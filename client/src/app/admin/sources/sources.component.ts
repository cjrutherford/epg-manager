import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ModalFocusDirective } from '../../services/modal-focus.directive';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, ProbeResult, SourceRecord } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

type Family = 'all' | 'channels' | 'guide';

@Component({
    selector: 'app-sources',
    standalone: true,
    imports: [CommonModule, FormsModule, ModalFocusDirective],
    templateUrl: './sources.component.html',
    styleUrl: './sources.component.css'
})
export class SourcesComponent implements OnInit {
    sources: SourceRecord[] = [];
    loading = true;
    family: Family = 'all';

    // Add flow
    showAddModal = false;
    newUrl = '';
    newLabel = '';
    newKind: 'm3u' | 'xmltv' = 'm3u';
    probing = false;
    probe: ProbeResult | null = null;
    probeError = '';
    adding = false;

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
        try {
            this.sources = (await this.api.getSources().toPromise()) || [];
        } catch {
            this.sources = [];
            this.toast.show('Could not load sources', 'error');
        } finally {
            this.loading = false;
            this.cdr.detectChanges();
        }
    }

    get visibleSources(): SourceRecord[] {
        const family = this.family;
        if (family === 'all') return this.sources;
        return this.sources.filter(source => source.provides.includes(family));
    }

    get channelSourceCount(): number {
        return this.sources.filter(s => s.provides.includes('channels')).length;
    }

    get guideSourceCount(): number {
        return this.sources.filter(s => s.provides.includes('guide')).length;
    }

    get failingCount(): number {
        return this.sources.filter(s => this.healthOf(s) === 'failed').length;
    }

    /** One word for how a source is doing, derived from what it actually reported. */
    healthOf(source: SourceRecord): 'ok' | 'empty' | 'failed' | 'pending' {
        if (source.lastError) return 'failed';
        switch (source.lastSyncStatus) {
            case 'success': return 'ok';
            case 'empty': return 'empty';
            case 'failed': return 'failed';
            default: return 'pending';
        }
    }

    healthLabel(source: SourceRecord): string {
        switch (this.healthOf(source)) {
            case 'ok': return 'Working';
            case 'empty': return 'No channels';
            case 'failed': return 'Failing';
            default: return 'Not synced yet';
        }
    }

    lastSyncLabel(source: SourceRecord): string {
        if (!source.lastSyncAt) return 'never';
        const date = new Date(source.lastSyncAt);
        if (Number.isNaN(date.getTime())) return 'never';
        return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    // ── Add flow ────────────────────────────────
    openAdd(): void {
        this.showAddModal = true;
        this.newUrl = '';
        this.newLabel = '';
        this.newKind = 'm3u';
        this.probe = null;
        this.probeError = '';
        this.cdr.detectChanges();
    }

    closeAdd(): void {
        this.showAddModal = false;
        this.probe = null;
        this.cdr.detectChanges();
    }

    /** Guess the kind from the url so the user rarely has to choose. */
    onUrlChange(): void {
        this.probe = null;
        this.probeError = '';
        const url = this.newUrl.toLowerCase();
        if (/\.xml(\.gz)?($|\?)/.test(url) || url.includes('xmltv')) {
            this.newKind = 'xmltv';
        } else if (/\.m3u8?($|\?)/.test(url)) {
            this.newKind = 'm3u';
        }
    }

    private buildDescriptor() {
        const label = this.newLabel.trim() || this.newUrl.split('/').pop() || this.newUrl;
        return {
            id: label,
            kind: this.newKind,
            label,
            provides: this.newKind === 'xmltv' ? ['guide'] : ['channels'],
            enabled: true,
            priority: 0,
            fetch: {
                url: this.newUrl.trim(),
                compression: this.newUrl.toLowerCase().endsWith('.gz') ? 'gzip' : 'none',
                refresh: '12h',
                conditional: true
            }
        };
    }

    async runProbe(): Promise<void> {
        if (!this.newUrl.trim()) return;
        this.probing = true;
        this.probe = null;
        this.probeError = '';
        this.cdr.detectChanges();

        try {
            this.probe = (await this.api.probeSource(this.buildDescriptor()).toPromise()) || null;
            if (this.probe?.error) {
                this.probeError = this.probe.error.message;
            }
        } catch (e: any) {
            this.probeError = e?.error?.errors?.join('; ') || e?.error?.error || 'Could not reach that source';
        } finally {
            this.probing = false;
            this.cdr.detectChanges();
        }
    }

    get canAdd(): boolean {
        return !!this.probe && this.probe.ok && !this.adding;
    }

    async confirmAdd(): Promise<void> {
        this.adding = true;
        try {
            await this.api.addSource(this.buildDescriptor()).toPromise();
            this.toast.show('Source added', 'success');
            this.showAddModal = false;
            await this.load();
        } catch (e: any) {
            this.toast.show(e?.error?.error || 'Could not add that source', 'error');
        } finally {
            this.adding = false;
            this.cdr.detectChanges();
        }
    }

    // ── Row actions ─────────────────────────────
    async toggle(source: SourceRecord): Promise<void> {
        try {
            await this.api.toggleSource(source.key, !source.enabled).toPromise();
            source.enabled = !source.enabled;
            this.cdr.detectChanges();
        } catch {
            this.toast.show('Could not change that source', 'error');
        }
    }

    async remove(source: SourceRecord): Promise<void> {
        if (!confirm(`Remove "${source.label}"? Guide data it supplied will be removed too. Other sources are unaffected.`)) {
            return;
        }
        try {
            const result: any = await this.api.removeSource(source.key).toPromise();
            this.toast.show(
                result?.programmesRemoved
                    ? `Removed, along with ${result.programmesRemoved} programme(s) it supplied`
                    : 'Source removed',
                'success'
            );
            await this.load();
        } catch {
            this.toast.show('Could not remove that source', 'error');
        }
    }

    async exportAll(): Promise<void> {
        try {
            const data = await this.api.exportSources().toPromise();
            this.exportJson = JSON.stringify(data, null, 2);
            this.showExportModal = true;
            this.cdr.detectChanges();
        } catch {
            this.toast.show('Could not export sources', 'error');
        }
    }

    showExportModal = false;
    exportJson = '';
    importJson = '';

    closeExport(): void {
        this.showExportModal = false;
        this.importJson = '';
        this.cdr.detectChanges();
    }

    async runImport(): Promise<void> {
        let parsed: any;
        try {
            parsed = JSON.parse(this.importJson);
        } catch {
            this.toast.show('That is not valid JSON', 'error');
            return;
        }

        try {
            const summary: any = await this.api.importSources(parsed).toPromise();
            const parts = [`${summary.added} added`];
            if (summary.skipped) parts.push(`${summary.skipped} already present`);
            if (summary.errors?.length) parts.push(`${summary.errors.length} rejected`);
            this.toast.show(parts.join(', '), summary.errors?.length ? 'warning' : 'success');
            this.closeExport();
            await this.load();
        } catch {
            this.toast.show('Could not import those sources', 'error');
        }
    }

    async copyExport(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.exportJson);
            this.toast.show('Copied to clipboard', 'success');
        } catch {
            this.toast.show('Could not copy', 'error');
        }
    }
}
