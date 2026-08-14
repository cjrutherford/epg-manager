import { ChangeDetectorRef, Component, OnDestroy, OnInit, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ApiService, SeriesRule } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { ClientRecordingService } from '../../services/client-recording.service';
import { ClientRecording } from '../../services/client-recording.types';

@Component({
    selector: 'app-dvr',
    standalone: true,
    imports: [CommonModule, FormsModule],
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

    private localRecordingsSub: Subscription | null = null;

    constructor(
        private api: ApiService,
        private toast: ToastService,
        private cdr: ChangeDetectorRef,
        private clientRecordings: ClientRecordingService
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

    parseEpgTime(epgTime: string): Date | null {
        if (!epgTime) return null;
        const match = epgTime.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
        if (!match) return null;
        const [, y, m, d, h, mn, s, tz] = match;
        const isoStr = `${y}-${m}-${d}T${h}:${mn}:${s}${tz ? tz.replace(/(\d{2})(\d{2})$/, '$1:$2') : 'Z'}`;
        const date = new Date(isoStr);
        return isNaN(date.getTime()) ? null : date;
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
        const streamUrl = channel?.stream_url || channel?.url;
        if (!streamUrl) { this.toast.show('Invalid channel', 'error'); return; }

        const canRecordSeries = this.isSeriesCandidate(this.selectedProgram, this.selectedChannelPrograms);
        if (this.recordSeries && (!this.selectedProgram || !canRecordSeries)) {
            this.toast.show('Please select a program from the guide search to record as a series', 'warning');
            return;
        }

        try {
            if (this.recordSeries && this.selectedProgram) {
                // One call creates the rule and books every future showing the
                // server can see. The client used to loop the loaded guide
                // window, so anything arriving later was simply missed.
                const start = this.parseEpgTime(this.selectedProgram.start);
                const stop = this.parseEpgTime(this.selectedProgram.stop);
                const result: any = await this.api.scheduleRecording({
                    channel_id: this.newRec.channelId,
                    channel_name: channel?.name,
                    program_title: this.selectedProgram.title,
                    start_time: (start || new Date(this.newRec.startTime)).toISOString(),
                    end_time: (stop || new Date(this.newRec.endTime)).toISOString(),
                    stream_url: streamUrl,
                    thumbnail: this.selectedProgram.icon || channel?.logo || channel?.tvg_logo,
                    sub_title: this.selectedProgram.sub_title,
                    episode_num: this.selectedProgram.episode_num,
                    description: this.selectedProgram.description,
                    rating: this.selectedProgram.rating,
                    category: this.selectedProgram.category,
                    record_series: true
                }).toPromise();

                this.showScheduleModal = false;
                const extra = result?.seriesEpisodesScheduled || 0;
                this.toast.show(
                    extra > 0
                        ? `Recording '${this.selectedProgram.title}' — ${extra} further episode(s) scheduled, and new ones as the guide updates`
                        : `Recording every episode of '${this.selectedProgram.title}' as the guide updates`,
                    'success'
                );
                await this.loadSeriesRules();
            } else {
                await this.api.scheduleRecording({
                    channel_id: this.newRec.channelId,
                    channel_name: channel?.name,
                    program_title: this.newRec.title,
                    start_time: new Date(this.newRec.startTime).toISOString(),
                    end_time: new Date(this.newRec.endTime).toISOString(),
                    stream_url: streamUrl,
                    thumbnail: this.selectedProgram?.icon || channel?.logo || channel?.tvg_logo,
                    sub_title: this.selectedProgram?.sub_title,
                    episode_num: this.selectedProgram?.episode_num,
                    description: this.selectedProgram?.description,
                    rating: this.selectedProgram?.rating,
                    category: this.selectedProgram?.category
                }).toPromise();
                this.showScheduleModal = false;
                this.toast.show('Recording scheduled', 'success');
            }
            await this.loadAll();
        } catch (e: any) {
            // 401 = admin scope, 507 = disk floor, 409 = duplicate — all worth naming
            const detail = e?.status === 401 || e?.status === 403
                ? 'Your session has expired — sign in again to schedule recordings'
                : e?.error?.error || 'Failed to schedule';
            this.toast.show(detail, 'error');
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
        if (!confirm(`Stop recording '${rule.series_title}'? Future episodes will no longer be added.`)) return;

        // Asked separately: removing the rule and discarding what it already
        // booked are different intentions.
        const cancelUpcoming = upcoming > 0
            && confirm(`Also cancel the ${upcoming} episode(s) it has already scheduled?`);

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

    async stopRecording(id: number): Promise<void> {
        if (!confirm('Stop this recording?')) return;
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
        if (!confirm(`Delete '${rec.programTitle}' from this device?`)) return;
        await this.clientRecordings.delete(rec.id);
        await this.clientRecordings.refresh();
        this.toast.show('Local recording deleted', 'success');
    }

    async deleteRecording(id: number, status: string): Promise<void> {
        const isScheduled = status === 'scheduled';
        const confirmMsg = isScheduled
            ? 'Are you sure you want to cancel this scheduled recording?'
            : 'Are you sure you want to delete this recording?';
        
        if (!confirm(confirmMsg)) return;

        try {
            await this.api.cancelRecording(id).toPromise();
            this.toast.show(isScheduled ? 'Scheduled recording cancelled' : 'Recording deleted', 'success');
            await this.loadAll();
        } catch {
            this.toast.show(isScheduled ? 'Failed to cancel scheduled recording' : 'Failed to delete recording', 'error');
        }
    }

    getStatusClass(status: string): string {
        switch (status) {
            case 'recording': return 'badge-success';
            case 'scheduled': return 'badge-primary';
            case 'completed': return 'badge-warning';
            case 'failed': return 'badge-danger';
            default: return '';
        }
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
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
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
        if (!program?.title) return false;
        if (program.episode_num || program.sub_title) return true;

        const category = String(program.category || '').toLowerCase();
        const blockedCategories = ['movie', 'film', 'sports', 'news', 'event', 'special', 'shopping'];
        if (blockedCategories.some(blocked => category.includes(blocked))) return false;

        const showCategories = ['series', 'show', 'entertainment', 'comedy', 'drama', 'animation', 'kids', 'documentary'];
        const title = String(program.title).trim().toLowerCase();
        const repeatCount = programs.filter(candidate => String(candidate?.title || '').trim().toLowerCase() === title).length;
        return repeatCount > 1 && showCategories.some(showCategory => category.includes(showCategory));
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
