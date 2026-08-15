import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef } from '@angular/core';
import { ModalFocusDirective } from '../../services/modal-focus.directive';
import { CommonModule } from '@angular/common';
import { ApiService, ResetPreview, ResetScope } from '../../services/api.service';
import { SseService } from '../../services/sse.service';
import { ToastService } from '../../services/toast.service';
import { Subscription } from 'rxjs';

interface ResetScopeOption {
    scope: ResetScope;
    label: string;
    blurb: string;
    danger: boolean;
}

interface SyncStage {
    id: string;
    label: string;
    icon: string;
    status: 'idle' | 'active' | 'done' | 'error';
}

@Component({
    selector: 'app-dashboard',
    standalone: true,
    imports: [CommonModule, ModalFocusDirective],
    templateUrl: './dashboard.component.html',
    styleUrl: './dashboard.component.css'
})
export class DashboardComponent implements OnInit, OnDestroy, AfterViewChecked {
    @ViewChild('logContainer') logContainerRef!: ElementRef<HTMLDivElement>;

    stats: any = null;
    health: any = null;
    jobStatus: any = null;
    dataState: { hasChannels: boolean; hasPrograms: boolean; hasPlaylist: boolean; isEmpty: boolean } | null = null;
    loading = true;
    syncStarted = false;
    progressCollapsed = true;

    showResetModal = false;
    resetScope: ResetScope = 'guide';
    resetPreview: ResetPreview | null = null;
    resetPreviewLoading = false;

    readonly resetScopeOptions: ResetScopeOption[] = [
        {
            scope: 'guide',
            label: 'Clear guide data',
            blurb: 'Programme listings and grab history. Channels, recordings and downloaded catalogues are kept.',
            danger: false
        },
        {
            scope: 'user',
            label: 'Reset my data',
            blurb: 'Channels, settings, overrides and recordings. Downloaded catalogues are kept, so the next sync is fast.',
            danger: true
        },
        {
            scope: 'collection',
            label: 'Rebuild collection cache',
            blurb: 'Downloaded catalogues and learned source reliability. Your channels and recordings are kept.',
            danger: false
        },
        {
            scope: 'all',
            label: 'Erase everything',
            blurb: 'Every table and every cached file. The next sync starts from nothing.',
            danger: true
        }
    ];

    logs: { message: string; level: string; time: Date }[] = [];
    progressBars: Record<string, { current: number; total: number; message: string; completed: boolean }> = {};
    shouldScrollLogs = false;

    stages: SyncStage[] = [
        { id: 'playlist', label: 'Playlist', icon: '📋', status: 'idle' },
        { id: 'metadata', label: 'Metadata', icon: '🧭', status: 'idle' },
        { id: 'match', label: 'Match', icon: '🔗', status: 'idle' },
        { id: 'grab', label: 'EPG Grab', icon: '📡', status: 'idle' },
        { id: 'enrich', label: 'Enrich', icon: '🎬', status: 'idle' },
        { id: 'rebuild', label: 'Rebuild', icon: '📦', status: 'idle' },
    ];

    private subs: Subscription[] = [];

    constructor(
        private api: ApiService,
        private sse: SseService,
        private toast: ToastService,
        private cdr: ChangeDetectorRef
    ) { }

    ngOnInit(): void {
        this.loadData();
        this.setupSseListeners();

        // Check if sync is already running in background
        this.api.getJobStatus().subscribe(status => {
            if (status && status.running) {
                this.syncStarted = true;
                this.progressCollapsed = false;
                if (status.progress) {
                    for (const [phase, data] of Object.entries(status.progress)) {
                        const progData = data as any;
                        this.progressBars[phase] = {
                            current: progData.current,
                            total: progData.total,
                            message: progData.message || progData.label || '',
                            completed: progData.completed || false
                        };
                        this.applyStageStatus(phase, progData.message || '', progData.completed || false);
                    }
                }
                this.cdr.markForCheck();
            }
        });
    }

    ngOnDestroy(): void {
        this.subs.forEach(s => s.unsubscribe());
    }

    ngAfterViewChecked(): void {
        if (this.shouldScrollLogs && this.logContainerRef) {
            const el = this.logContainerRef.nativeElement;
            el.scrollTop = el.scrollHeight;
            this.shouldScrollLogs = false;
        }
    }

    toggleProgressCollapse(): void {
        this.progressCollapsed = !this.progressCollapsed;
    }

    async loadData(): Promise<void> {
        this.loading = true;
        try {
            const [stats, health, job, dataState] = await Promise.all([
                this.api.getStats().toPromise(),
                this.api.getHealth().toPromise(),
                this.api.getJobStatus().toPromise().catch(() => null),
                this.api.getHasData().toPromise().catch(() => null)
            ]);
            this.stats = stats;
            this.health = health;
            this.jobStatus = job;
            this.dataState = dataState ?? null;
        } catch (e) {
            console.error('Failed to load dashboard', e);
        } finally {
            this.loading = false;
            this.cdr.markForCheck();
        }
    }

    get isEmpty(): boolean {
        return this.dataState?.isEmpty === true && !this.syncStarted;
    }

    setupSseListeners(): void {
        this.subs.push(
            this.sse.logEvents.subscribe(evt => {
                this.logs.push({ ...evt, time: new Date() });
                if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
                this.shouldScrollLogs = true;
                this.cdr.markForCheck();
            }),
            this.sse.progressEvents.subscribe(evt => {
                const phase = evt.phase;

                this.progressBars[phase] = {
                    current: evt.current,
                    total: evt.total,
                    message: evt.message || evt.label || '',
                    completed: evt.completed || false
                };

                this.syncStarted = true;
                this.progressCollapsed = false;

                this.applyStageStatus(phase, evt.message || evt.label || '', evt.completed || false);
                this.cdr.markForCheck();
            }),
            this.sse.reportEvents.subscribe(() => {
                this.syncStarted = false;
                this.loadData();
                this.cdr.markForCheck();
            })
        );
    }

    getProgress(phase: string): number {
        const p = this.progressBars[phase];
        if (!p || p.total === 0) return 0;
        return Math.round((p.current / p.total) * 100);
    }

    get activePhases(): string[] {
        const order = ['playlist', 'metadata', 'match', 'grab', 'enrich', 'rebuild'];
        const keys = Object.keys(this.progressBars);
        return order.filter(p => keys.includes(p)).concat(keys.filter(p => !order.includes(p)));
    }

    getPhaseLabel(phase: string): string {
        const labels: Record<string, string> = {
            playlist: '📋 Playlist',
            metadata: '🧭 Metadata',
            match: '🔗 Matching',
            grab: '📡 Grabbing EPG',
            enrich: '🎬 Enriching',
            rebuild: '📦 Rebuilding Files'
        };
        return labels[phase] || phase;
    }

    clearLogs(): void {
        this.logs = [];
    }

    clearCompletedProgress(): void {
        for (const phase of Object.keys(this.progressBars)) {
            if (this.progressBars[phase].completed) {
                delete this.progressBars[phase];
            }
        }
    }

    /** Called from the empty-state banner to kick off the very first sync. */
    triggerInitialSync(): void {
        this.syncStarted = true;
        this.progressCollapsed = false;
        this.resetStages();
        this.sse.connect();
        this.api.runFullSync().subscribe({
            next: () => { },
            error: (e) => {
                this.toast.show('Sync failed to start: ' + e.message, 'error');
                this.syncStarted = false;
                this.cdr.markForCheck();
            }
        });
    }

    runFullSync(): void {
        this.syncStarted = true;
        this.progressCollapsed = false;
        this.resetStages();
        this.sse.connect();
        this.api.runFullSync().subscribe({
            next: (res) => { if (!res.success) this.toast.show(res.message || 'Sync failed', 'error'); },
            error: (e) => this.toast.show('Sync failed: ' + e.message, 'error')
        });
    }

    cancelSync(): void {
        if (!confirm('Are you sure you want to cancel the running sync process?')) return;
        this.api.cancelSync().subscribe({
            next: (res) => {
                if (res.success) {
                    this.toast.show('Cancellation request sent.', 'success');
                } else {
                    this.toast.show('Cancellation failed: ' + res.message, 'error');
                }
            },
            error: (e) => this.toast.show('Cancellation failed: ' + e.message, 'error')
        });
    }

    grabMissing(): void {
        this.syncStarted = true;
        this.progressCollapsed = false;
        this.resetStages();
        this.sse.connect();
        this.api.grabMissing().subscribe({
            next: (res) => { },
            error: (e) => this.toast.show('Grab failed: ' + e.message, 'error')
        });
    }

    private resetStages(): void {
        this.stages.forEach(s => s.status = 'idle');
        this.progressBars = {};
    }

    private setStageActive(id: string): void {
        const s = this.stages.find(s => s.id === id);
        if (s) s.status = 'active';
    }

    private setStageDone(id: string): void {
        const s = this.stages.find(s => s.id === id);
        if (s) s.status = 'done';
    }

    private setStageError(id: string): void {
        const s = this.stages.find(s => s.id === id);
        if (s) s.status = 'error';
    }

    private applyStageStatus(phase: string, message: string, completed: boolean): void {
        const stage = this.stages.find(s => s.id === phase);
        if (!stage) return;

        if (/cancelled|failed|error/i.test(message)) {
            this.setStageError(phase);
        } else if (completed) {
            this.setStageDone(phase);
        } else {
            this.setStageActive(phase);
        }
    }

    getStageClass(stage: SyncStage): string {
        return `stage-${stage.status}`;
    }

    rebuildFiles(): void {
        if (!confirm('Rebuild M3U/XML from database?')) return;
        this.api.rebuildFiles().subscribe({
            next: (res) => { if (res.success) this.toast.show('Files rebuilt!', 'success'); },
            error: (e) => this.toast.show('Rebuild failed: ' + e.message, 'error')
        });
    }

    // ── Reset ───────────────────────────────────
    openResetModal(): void {
        this.showResetModal = true;
        this.resetScope = 'guide';
        this.loadResetPreview();
    }

    closeResetModal(): void {
        this.showResetModal = false;
        this.resetPreview = null;
        this.cdr.markForCheck();
    }

    selectResetScope(scope: ResetScope): void {
        this.resetScope = scope;
        this.loadResetPreview();
    }

    loadResetPreview(): void {
        this.resetPreviewLoading = true;
        this.resetPreview = null;
        this.cdr.markForCheck();
        this.api.previewReset(this.resetScope).subscribe({
            next: preview => {
                this.resetPreview = preview;
                this.resetPreviewLoading = false;
                this.cdr.markForCheck();
            },
            error: () => {
                this.resetPreviewLoading = false;
                this.cdr.markForCheck();
            }
        });
    }

    fmtBytes(bytes: number): string {
        if (!bytes) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    confirmReset(): void {
        this.showResetModal = false;
        this.loading = true;
        this.api.resetSystem(this.resetScope).subscribe({
            next: (res) => {
                if (res.success) {
                    this.toast.show(`Reset complete — ${this.resetScopeLabel(this.resetScope)} cleared`, 'success');
                    this.syncStarted = false;
                    this.loadData();
                } else {
                    this.toast.show('Reset failed: ' + (res.message || 'Unknown error'), 'error');
                    this.loading = false;
                }
            },
            error: (e) => {
                // 409 means a sync is running — say so rather than "unknown error"
                this.toast.show(e?.error?.error || 'Reset failed: ' + e.message, 'error');
                this.loading = false;
            }
        });
    }

    resetScopeLabel(scope: ResetScope): string {
        switch (scope) {
            case 'guide': return 'guide data';
            case 'user': return 'your data';
            case 'collection': return 'collection cache';
            case 'all': return 'everything';
        }
    }

    formatUptime(seconds: number): string {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }
}
