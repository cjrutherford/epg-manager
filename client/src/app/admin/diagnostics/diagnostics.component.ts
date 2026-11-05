import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ConfirmService } from '../../services/confirm.service';
import { ModalComponent } from '../../shared/modal.component';
import { StatComponent } from '../../shared/stat.component';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { StateComponent } from '../../shared/state.component';
import { SkeletonComponent } from '../../shared/skeleton.component';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { LucideAngularModule } from 'lucide-angular';

@Component({
    selector: 'app-diagnostics',
    standalone: true,
    imports: [CommonModule, FormsModule, LucideAngularModule, ModalComponent, StatComponent, PageHeaderComponent, StateComponent, SkeletonComponent],
    templateUrl: './diagnostics.component.html',
    styleUrls: ['./diagnostics.component.css', '../../shared/data-table.css']
})
export class DiagnosticsComponent implements OnInit {
    activeTab: 'matches' | 'sources' = 'matches';
    analysis: any = null;
    /** Set when the load failed, so an error is not shown as an empty list. */
    loadError: string | null = null;
    sources: any[] = [];
    epgSources: any[] = [];
    loading = true;
    syncingSources = false;

    // Matching filter/search
    searchQuery = '';
    filterStatus: 'all' | 'matched' | 'unmatched' = 'all';

    // Manual Rematch Modal
    showRematchModal = false;
    selectedChannel: any = null;
    rematchQuery = '';
    rematchResults: any[] = [];
    rematchLoading = false;

    constructor(
        private api: ApiService,
        private toast: ToastService,
        private cdr: ChangeDetectorRef,
        private confirm: ConfirmService,
        private route: ActivatedRoute
    ) { }

    ngOnInit(): void {
        // Sources links here with ?tab=sources; keep the deep link working.
        const tab = this.route.snapshot.queryParamMap.get('tab');
        if (tab === 'sources' || tab === 'matches') this.activeTab = tab;
        this.loadAll();
    }

    async loadAll(): Promise<void> {
        this.loading = true;
        this.cdr.markForCheck();
        try {
            const [analysis, sources, epgSources] = await Promise.all([
                this.api.getMatchAnalysis().toPromise(),
                this.api.getGrabSources().toPromise(),
                this.api.getEpgSources().toPromise()
            ]);
            this.analysis = analysis;
            this.sources = sources || [];
            this.epgSources = epgSources || [];
        } catch (e: any) {
            this.loadError = e?.status === 0
                ? 'Could not reach the server.'
                : (e?.error?.error || 'Something went wrong loading the diagnostics.');
            this.toast.show('Failed to load diagnostics data: ' + e.message, 'error');
        } finally {
            this.loading = false;
            this.cdr.markForCheck();
        }
    }

    get filteredChannels(): any[] {
        if (!this.analysis?.channels) return [];
        const query = this.searchQuery.toLowerCase();
        
        return this.analysis.channels.filter((ch: any) => {
            const matchesQuery = (ch.name || '').toLowerCase().includes(query) ||
                                 (ch.matched_epg_id || '').toLowerCase().includes(query) ||
                                 (ch.match_type || '').toLowerCase().includes(query) ||
                                 (ch.group || '').toLowerCase().includes(query);
                                 
            if (!matchesQuery) return false;
            
            if (this.filterStatus === 'matched') return !!ch.matched_epg_id;
            if (this.filterStatus === 'unmatched') return !ch.matched_epg_id;
            return true;
        });
    }

    openRematchModal(ch: any): void {
        this.selectedChannel = ch;
        this.rematchQuery = ch.name;
        this.rematchResults = [];
        this.showRematchModal = true;
        this.searchRematchEpg();
    }

    async searchRematchEpg(): Promise<void> {
        if (!this.rematchQuery.trim()) {
            this.rematchResults = [];
            return;
        }
        this.rematchLoading = true;
        this.cdr.markForCheck();
        try {
            const results = await this.api.searchEpg(this.rematchQuery).toPromise();
            this.rematchResults = results || [];
        } catch (e: any) {
            this.toast.show('Search failed: ' + e.message, 'error');
        } finally {
            this.rematchLoading = false;
            this.cdr.markForCheck();
        }
    }

    async selectRematchEpg(candidate: any): Promise<void> {
        if (!this.selectedChannel) return;
        try {
            await this.api.setOverride(this.selectedChannel.id, candidate.id).toPromise();
            this.toast.show(`Guide match set for '${this.selectedChannel.name}'`, 'success');
            this.showRematchModal = false;
            await this.loadAll();
        } catch (e: any) {
            this.toast.show('Failed to set guide match: ' + e.message, 'error');
        }
    }

    async clearChannelMatch(ch: any): Promise<void> {
        const confirmed = await this.confirm.ask({
            title: 'Clear this guide match?',
            message: `'${ch.name}' will have no guide data until it is matched again.`,
            detail: 'The next sync may re-match it automatically.',
            confirmLabel: 'Clear match',
            destructive: true
        });
        if (!confirmed) return;
        try {
            await this.api.setOverride(ch.id, null).toPromise();
            this.toast.show(`Guide match cleared for '${ch.name}'`, 'success');
            await this.loadAll();
        } catch (e: any) {
            this.toast.show('Failed to clear match: ' + e.message, 'error');
        }
    }

    getSuccessRateClass(rate: number): string {
        if (rate >= 90) return 'text-success';
        if (rate >= 50) return 'text-warning';
        return 'text-danger';
    }

    getSuccessRate(source: any): number {
        const total = source.channels_success + source.channels_failure;
        if (total === 0) return 0;
        return Math.round((source.channels_success / total) * 100);
    }

    async toggleEpgSource(source: any): Promise<void> {
        const nextEnabled = !source.enabled;
        source.enabled = nextEnabled;
        this.cdr.markForCheck();
        try {
            await this.api.toggleEpgSource(source.key, nextEnabled).toPromise();
            this.toast.show(`${source.label || source.site} ${nextEnabled ? 'enabled' : 'disabled'}`, 'success');
        } catch (e: any) {
            source.enabled = !nextEnabled;
            this.toast.show('Failed to update guide source: ' + e.message, 'error');
        } finally {
            this.cdr.markForCheck();
        }
    }

    async syncEpgSources(): Promise<void> {
        this.syncingSources = true;
        this.cdr.markForCheck();
        try {
            await this.api.syncEpgSources().toPromise();
            this.toast.show('Guide source sync started.', 'success');
        } catch (e: any) {
            this.toast.show('Failed to start guide source sync: ' + e.message, 'error');
        } finally {
            this.syncingSources = false;
            this.cdr.markForCheck();
        }
    }
}
