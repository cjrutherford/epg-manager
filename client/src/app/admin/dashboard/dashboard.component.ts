import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../../services/api.service';
import { SseService } from '../../services/sse.service';
import { ToastService } from '../../services/toast.service';
import { Subscription } from 'rxjs';

interface SyncStage {
    id: string;
    label: string;
    icon: string;
    status: 'idle' | 'active' | 'done' | 'error';
}

@Component({
    selector: 'app-dashboard',
    standalone: true,
    imports: [CommonModule],
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

    resetSystem(): void {
        if (!confirm('WARNING: Are you sure you want to reset the system? This will delete all channels, matched guides, manual overrides, cache, and settings. This action cannot be undone!')) {
            return;
        }
        this.loading = true;
        this.api.resetSystem().subscribe({
            next: (res) => {
                if (res.success) {
                    this.toast.show('System reset successfully!', 'success');
                    this.syncStarted = false;
                    this.loadData();
                } else {
                    this.toast.show('Reset failed: ' + (res.message || 'Unknown error'), 'error');
                    this.loading = false;
                }
            },
            error: (e) => {
                this.toast.show('Reset failed: ' + e.message, 'error');
                this.loading = false;
            }
        });
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
