import { ChangeDetectorRef, Component, OnDestroy, OnInit, Input, Output, EventEmitter } from '@angular/core';
import { ConfirmService } from '../../services/confirm.service';
import { ModalFocusDirective } from '../../services/modal-focus.directive';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ApiService, SeriesRule } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ClientRecordingService } from '../../services/client-recording.service';
import { ClientRecording } from '../../services/client-recording.types';
import { DvrService } from '../../services/dvr.service';

@Component({
    selector: 'app-dvr',
    standalone: true,
    imports: [CommonModule, FormsModule, ModalFocusDirective],
    templateUrl: './dvr.component.html',
    styleUrl: './dvr.component.css'
})
export class DvrComponent implements OnInit, OnDestroy {
    @Input() isOverlay = false;
    @Input() guideChannels: any[] | null = null;
    @Output() close = new EventEmitter<void>();

    recordings: any[] = [];
    localRecordings: ClientRecording[] = [];
    recordingsTab: 'system' | 'my' = 'system';
    loading = true;
    showScheduleModal = false;
    storageUsed = 0;
    storageTotal = 1;
    storageFree = 0;
    storageRecordings = 0;
    retention: { mode: string; maxAgeDays: number; minFreeBytes: number } | null = null;

    // New recording form
    channels: any[] = [];
    selectedChannelPrograms: any[] = [];
    selectedProgram: any = null;
    programSearchQuery = '';
    channelSearchQuery = '';
    playingServerRec: any = null;
    recordSeries = false;
    newRec = { channelId: '', title: '', startTime: '', endTime: '' };

    seriesRules: SeriesRule[] = [];
    showSeriesRules = false;
    runningSeriesPass = false;

    // Retention and padding were read by the recorder from the day they landed
    // but there was nowhere to set them.
    showDvrSettings = false;
    savingDvrSettings = false;
    dvrSettings = {
        retention_mode: 'age',
        retention_days: 30,
        size_budget_gb: 50,
        min_free_gb: 2,
        padding_start_seconds: 0,
        padding_end_seconds: 120
    };

    private localRecordingsSub: Subscription | null = null;

    constructor(
        private api: ApiService,
        private toast: ToastService,
        private cdr: ChangeDetectorRef,
        private clientRecordings: ClientRecordingService,
        private dvr: DvrService,
        private confirm: ConfirmService
    ) { }

    ngOnInit(): void {
        this.localRecordingsSub = this.clientRecordings.recordings$.subscribe(recordings => {
            this.localRecordings = recordings;
            this.cdr.markForCheck();
        });
        this.loadAll();
    }

    ngOnDestroy(): void {
        if (this.localRecordingsSub) {
            this.localRecordingsSub.unsubscribe();
            this.localRecordingsSub = null;
        }
    }

    async loadAll(): Promise<void> {
        this.loading = true;
        try {
            const [recordings, storage, rules] = await Promise.all([
                this.api.getDvrSchedules().toPromise().catch(() => []),
                this.api.getDvrStorage().toPromise().catch(() => null),
                this.api.getSeriesRules().toPromise().catch(() => []),
                this.clientRecordings.refresh().catch(() => undefined)
            ]);
            this.seriesRules = rules || [];
            this.recordings = (recordings || []).map((rec: any) => {
                let startTime = rec.start_time;
                let endTime = rec.end_time;
                if (startTime && typeof startTime === 'string' && !startTime.includes('-') && !startTime.includes(':')) {
                    const parsed = this.parseEpgTime(startTime);
                    if (parsed) startTime = parsed.toISOString();
                }
                if (endTime && typeof endTime === 'string' && !endTime.includes('-') && !endTime.includes(':')) {
                    const parsed = this.parseEpgTime(endTime);
                    if (parsed) endTime = parsed.toISOString();
                }
                return {
                    ...rec,
                    start_time: startTime,
                    end_time: endTime
                };
            });
            if (storage) {
                this.applyStorageSettings(storage);
                this.storageUsed = storage.usedBytes;
                this.storageTotal = storage.totalBytes || 1;
                this.storageFree = storage.freeBytes ?? 0;
                this.storageRecordings = storage.recordingsBytes ?? 0;
                this.retention = storage.retention ?? null;
            }
        } catch { this.recordings = []; }
        finally {
            this.loading = false;
            this.cdr.detectChanges();
        }
    }

    async openScheduleModal(): Promise<void> {
        const now = new Date();
        const end = new Date(now.getTime() + 3600000);
        this.newRec.startTime = now.toISOString().slice(0, 16);
        this.newRec.endTime = end.toISOString().slice(0, 16);
        this.newRec.channelId = '';
        this.newRec.title = '';
        this.selectedChannelPrograms = [];
        this.selectedProgram = null;
        this.programSearchQuery = '';
        this.recordSeries = false;
        this.showScheduleModal = true;
        this.cdr.detectChanges();

        if (this.guideChannels && this.guideChannels.length > 0) {
            this.channels = (this.guideChannels || []).filter(c => c.enabled !== 0);
        } else {
            try {
                const res = await this.api.getGuide().toPromise();
                const raw = res?.channels || [];
                this.channels = raw.filter((c: any) => c.enabled !== 0);
                if (this.channels.length === 0) {
                    const allChannels = await this.api.getChannels().toPromise();
                    const raw = allChannels || [];
                this.channels = raw.filter((c: any) => c.enabled !== 0);
                }
            } catch {
                try {
                    const allChannels = await this.api.getChannels().toPromise();
                    const raw = allChannels || [];
                this.channels = raw.filter((c: any) => c.enabled !== 0);
                } catch {
                    this.channels = [];
                }
            }
        }

        this.cdr.detectChanges();
    }

    async onChannelSelect(): Promise<void> {
        this.selectedChannelPrograms = [];
        this.selectedProgram = null;
        this.programSearchQuery = '';
        this.recordSeries = false;
        if (!this.newRec.channelId) {
            this.cdr.detectChanges();
            return;
        }
        try {
            const ch = this.channels.find(c => c.id === this.newRec.channelId);
            if (ch && ch.programs && ch.programs.length > 0) {
                this.selectedChannelPrograms = ch.programs;
            } else {
                const res = await this.api.getChannelPrograms(this.newRec.channelId).toPromise();
                this.selectedChannelPrograms = res?.programs || [];
            }
        } catch (e) {
            this.selectedChannelPrograms = [];
        } finally {
            this.cdr.detectChanges();
        }
    }

    get filteredPrograms(): any[] {
        if (!this.programSearchQuery) {
            return this.selectedChannelPrograms;
        }
        const query = this.programSearchQuery.toLowerCase();
        return this.selectedChannelPrograms.filter(p => (p.title || '').toLowerCase().includes(query));
    }

    selectProgramFromGuide(prog: any): void {
        this.selectedProgram = prog;
        this.recordSeries = this.recordSeries && this.isSeriesCandidate(prog, this.selectedChannelPrograms);
        this.onProgramSelect();
        this.cdr.detectChanges();
    }

    // Time parsing, series detection, byte formatting and the status
    // vocabulary all live in DvrService now — the Watch overlay had its own
    // copies and they had drifted apart.
    parseEpgTime(epgTime: string): Date | null {
        return this.dvr.parseEpgTime(epgTime);
    }

    onProgramSelect(): void {
        if (this.selectedProgram) {
            this.newRec.title = this.selectedProgram.title;
            const start = this.parseEpgTime(this.selectedProgram.start);
            const stop = this.parseEpgTime(this.selectedProgram.stop);
            if (start && stop) {
                // Format for datetime-local input
                this.newRec.startTime = new Date(start.getTime() - (start.getTimezoneOffset() * 60000)).toISOString().slice(0,16);
                this.newRec.endTime = new Date(stop.getTime() - (stop.getTimezoneOffset() * 60000)).toISOString().slice(0,16);
            }
        }
    }

    isAlreadyScheduled(channelId: string, programStart: string, programEnd: string): boolean {
        const pStart = this.parseEpgTime(programStart)?.getTime();
        const pEnd = this.parseEpgTime(programEnd)?.getTime();
        if (!pStart || !pEnd) return false;
        return this.recordings.some(r => {
            if (r.channel_id !== channelId) return false;
            const rStart = new Date(r.start_time).getTime();
            const rEnd = new Date(r.end_time).getTime();
            return rStart < pEnd && rEnd > pStart;
        });
    }

    async submitSchedule(): Promise<void> {
        if (!this.newRec.channelId || !this.newRec.title || !this.newRec.startTime || !this.newRec.endTime) {
            this.toast.show('All fields are required', 'warning'); return;
        }
        const channel = this.channels.find(c => c.id === this.newRec.channelId);
        if (!channel) { this.toast.show('Invalid channel', 'error'); return; }

        const canRecordSeries = this.isSeriesCandidate(this.selectedProgram, this.selectedChannelPrograms);
        if (this.recordSeries && (!this.selectedProgram || !canRecordSeries)) {
            this.toast.show('Please select a program from the guide search to record as a series', 'warning');
            return;
        }

        // A programme selected from the guide carries its own times and
        // metadata; a manually typed entry is described by the form. Either way
        // one shape goes to DvrService, which is the only place that schedules.
        const programme = this.selectedProgram && this.recordSeries
            ? {
                title: this.selectedProgram.title,
                start: this.selectedProgram.start,
                stop: this.selectedProgram.stop,
                sub_title: this.selectedProgram.sub_title,
                episode_num: this.selectedProgram.episode_num,
                description: this.selectedProgram.description,
                category: this.selectedProgram.category,
                rating: this.selectedProgram.rating,
                icon: this.selectedProgram.icon
            }
            : {
                title: this.newRec.title,
                start: new Date(this.newRec.startTime).toISOString(),
                stop: new Date(this.newRec.endTime).toISOString(),
                sub_title: this.selectedProgram?.sub_title,
                episode_num: this.selectedProgram?.episode_num,
                description: this.selectedProgram?.description,
                category: this.selectedProgram?.category,
                rating: this.selectedProgram?.rating,
                icon: this.selectedProgram?.icon
            };

        try {
            const outcome = await this.dvr.schedule({
                channel,
                programme,
                series: this.recordSeries,
                // The admin screen is always the server recorder — that is what
                // this screen manages.
                destination: 'server'
            });

            this.showScheduleModal = false;
            this.toast.show(outcome.message, 'success');
            await this.loadAll();
        } catch (e: any) {
            this.toast.show(this.dvr.describeError(e, 'Failed to schedule'), 'error');
        }
    }

    // ── DVR settings ────────────────────────────
    private applyStorageSettings(storage: any): void {
        const retention = storage?.retention;
        if (retention) {
            this.dvrSettings.retention_mode = retention.mode ?? this.dvrSettings.retention_mode;
            this.dvrSettings.retention_days = retention.maxAgeDays ?? this.dvrSettings.retention_days;
            if (retention.budgetBytes) this.dvrSettings.size_budget_gb = Math.round(retention.budgetBytes / 1024 ** 3);
            if (retention.minFreeBytes !== undefined) this.dvrSettings.min_free_gb = Math.round(retention.minFreeBytes / 1024 ** 3);
        }
        const padding = storage?.padding;
        if (padding) {
            this.dvrSettings.padding_start_seconds = padding.startSeconds ?? this.dvrSettings.padding_start_seconds;
            this.dvrSettings.padding_end_seconds = padding.endSeconds ?? this.dvrSettings.padding_end_seconds;
        }
    }

    toggleDvrSettings(): void {
        this.showDvrSettings = !this.showDvrSettings;
        this.cdr.detectChanges();
    }

    async saveDvrSettings(): Promise<void> {
        this.savingDvrSettings = true;
        this.cdr.detectChanges();
        try {
            await this.api.saveDvrSettings(this.dvrSettings).toPromise();
            this.toast.show('DVR settings saved', 'success');
            await this.loadAll();
        } catch (e: any) {
            this.toast.show(this.dvr.describeError(e, 'Could not save those settings'), 'error');
        } finally {
            this.savingDvrSettings = false;
            this.cdr.detectChanges();
        }
    }

    // ── Series rules ────────────────────────────
    async loadSeriesRules(): Promise<void> {
        try {
            this.seriesRules = (await this.api.getSeriesRules().toPromise()) || [];
        } catch {
            this.seriesRules = [];
        } finally {
            this.cdr.detectChanges();
        }
    }

    toggleSeriesRules(): void {
        this.showSeriesRules = !this.showSeriesRules;
        this.cdr.detectChanges();
    }

    async deleteSeriesRule(rule: SeriesRule): Promise<void> {
        const upcoming = rule.upcoming_count || 0;
        const stop = await this.confirm.ask({
            title: 'Stop recording this series?',
            message: `Future episodes of '${rule.series_title}' will no longer be added to the schedule.`,
            confirmLabel: 'Stop series',
            destructive: true
        });
        if (!stop) return;

        // Asked separately: removing the rule and discarding what it already
        // booked are different intentions.
        const cancelUpcoming = upcoming > 0 && await this.confirm.ask({
            title: 'Cancel the episodes it already booked?',
            message: `${upcoming} episode(s) are on the schedule from this series.`,
            detail: 'Leave them if you still want those recordings.',
            confirmLabel: `Cancel ${upcoming} episode(s)`,
            cancelLabel: 'Keep them',
            destructive: true
        });

        try {
            const result: any = await this.api.deleteSeriesRule(rule.id, cancelUpcoming).toPromise();
            this.toast.show(
                result?.cancelled ? `Series stopped, ${result.cancelled} scheduled episode(s) cancelled` : 'Series stopped',
                'success'
            );
            await this.loadAll();
        } catch {
            this.toast.show('Could not stop that series', 'error');
        }
    }

    async runSeriesPass(): Promise<void> {
        this.runningSeriesPass = true;
        this.cdr.detectChanges();
        try {
            const result = await this.api.runSeriesRules().toPromise();
            const scheduled = result?.scheduled || 0;
            this.toast.show(
                scheduled > 0 ? `Scheduled ${scheduled} new episode(s)` : 'No new episodes in the guide yet',
                scheduled > 0 ? 'success' : 'info'
            );
            await this.loadAll();
        } catch {
            this.toast.show('Could not check series rules', 'error');
        } finally {
            this.runningSeriesPass = false;
            this.cdr.detectChanges();
        }
    }

    /**
     * A failed or missed recording can only be retried while its window is
     * still open. Offering the button on a programme that finished yesterday
     * would just be another control that does nothing.
     */
    canRetry(rec: any): boolean {
        if (rec.status !== 'failed' && rec.status !== 'missed') return false;
        const end = this.dvr.parseEpgTime(rec.end_time);
        return !!end && end.getTime() > Date.now();
    }

    async retryRecording(rec: any): Promise<void> {
        try {
            await this.api.retryRecording(rec.id).toPromise();
            this.toast.show('Back on the schedule', 'success');
            await this.loadAll();
        } catch (e: any) {
            this.toast.show(this.dvr.describeError(e, 'Could not retry that recording'), 'error');
        }
    }

    async stopRecording(id: number): Promise<void> {
        const confirmed = await this.confirm.ask({
            title: 'Stop this recording?',
            message: 'Whatever has been captured so far will be kept.',
            confirmLabel: 'Stop recording',
            destructive: true
        });
        if (!confirmed) return;
        try {
            await this.api.stopDvr(id).toPromise();
            await this.loadAll();
        } catch { this.toast.show('Failed to stop', 'error'); }
    }

    async playLocalRecording(rec: ClientRecording): Promise<void> {
        const url = await this.clientRecordings.createPlaybackUrl(rec.id);
        if (!url) {
            this.toast.show('No captured video segments are available for this recording', 'warning');
            return;
        }
        window.open(url, '_blank');
    }

    async downloadLocalRecording(rec: ClientRecording): Promise<void> {
        await this.clientRecordings.download(rec.id);
    }

    async cancelLocalRecording(rec: ClientRecording): Promise<void> {
        await this.clientRecordings.cancel(rec.id);
        await this.clientRecordings.refresh();
        this.toast.show('Local recording cancelled', 'success');
    }

    async deleteLocalRecording(rec: ClientRecording): Promise<void> {
        const confirmed = await this.confirm.ask({
            title: 'Delete this recording?',
            message: `'${rec.programTitle}' will be removed from this device.`,
            detail: 'Browser recordings are not stored on the server, so this cannot be undone.',
            confirmLabel: 'Delete',
            destructive: true
        });
        if (!confirmed) return;
        await this.clientRecordings.delete(rec.id);
        await this.clientRecordings.refresh();
        this.toast.show('Local recording deleted', 'success');
    }

    async deleteRecording(id: number, status: string): Promise<void> {
        const isScheduled = status === 'scheduled';
        const confirmed = await this.confirm.ask(isScheduled
            ? {
                title: 'Cancel this scheduled recording?',
                message: 'It will not be recorded when it airs.',
                confirmLabel: 'Cancel recording',
                cancelLabel: 'Keep it',
                destructive: true
            }
            : {
                title: 'Delete this recording?',
                message: 'The recording and its file will be removed from the server.',
                confirmLabel: 'Delete',
                destructive: true
            });
        if (!confirmed) return;

        try {
            await this.api.cancelRecording(id).toPromise();
            this.toast.show(isScheduled ? 'Scheduled recording cancelled' : 'Recording deleted', 'success');
            await this.loadAll();
        } catch {
            this.toast.show(isScheduled ? 'Failed to cancel scheduled recording' : 'Failed to delete recording', 'error');
        }
    }

    getStatusClass(status: string): string {
        return this.dvr.statusClass(status);
    }

    statusLabel(status: string): string {
        return this.dvr.statusLabel(status);
    }

    /** The reason a recording ended as it did, from either recorder. */
    failureReason(rec: any): string | null {
        return this.dvr.failureReason(rec);
    }

    get storagePct(): number {
        if (!this.storageTotal) return 0;
        return Math.min(100, Math.round((this.storageUsed / this.storageTotal) * 100));
    }

    get retentionSummary(): string {
        if (!this.retention) return '';
        switch (this.retention.mode) {
            case 'age':
                return `Recordings are deleted after ${this.retention.maxAgeDays} days`;
            case 'size':
                return 'Oldest recordings are deleted to stay within the size budget';
            case 'low-space':
                return 'Oldest recordings are deleted only when the disk runs low';
            default:
                return 'Recordings are kept until you delete them';
        }
    }

    fmtBytes(bytes: number): string {
        return this.dvr.formatBytes(bytes);
    }

    recordingEpisode(rec: any): string {
        return [rec.episode_num, rec.sub_title].filter(Boolean).join(' - ');
    }

    recordingTime(rec: any): string {
        const start = new Date(rec.start_time);
        const end = new Date(rec.end_time);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
        return `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }

    
    get filteredChannels(): any[] {
        if (!this.channelSearchQuery) return this.channels;
        const q = this.channelSearchQuery.toLowerCase();
        return this.channels.filter(c => 
            (c.name || '').toLowerCase().includes(q) || 
            (c.channel_number || '').toString().includes(q)
        );
    }

    playServerRecording(rec: any): void {
        this.playingServerRec = rec;
        this.cdr.detectChanges();
    }

    closeVideoModal(): void {
        this.playingServerRec = null;
        this.cdr.detectChanges();
    }

    recordingSize(rec: any): string {
        return this.fmtBytes(Number(rec.file_size || 0));
    }

    isSeriesCandidate(program: any, programs: any[] = []): boolean {
        return this.dvr.isSeriesCandidate(program, programs);
    }

    localRecordingEpisode(rec: ClientRecording): string {
        return [rec.episodeNum, rec.subTitle].filter(Boolean).join(' - ');
    }

    localRecordingTime(rec: ClientRecording): string {
        const start = new Date(rec.startTime);
        const end = new Date(rec.endTime);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
        return `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }

    localRecordingSize(rec: ClientRecording): string {
        return this.fmtBytes(rec.sizeBytes);
    }
}
