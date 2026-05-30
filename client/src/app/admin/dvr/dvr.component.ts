import { Component, OnInit, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

@Component({
    selector: 'app-dvr',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './dvr.component.html',
    styleUrl: './dvr.component.css'
})
export class DvrComponent implements OnInit {
    @Input() isOverlay = false;
    @Input() guideChannels: any[] | null = null;
    @Output() close = new EventEmitter<void>();

    recordings: any[] = [];
    loading = true;
    showScheduleModal = false;
    storageUsed = 0;
    storageTotal = 1;

    // New recording form
    channels: any[] = [];
    selectedChannelPrograms: any[] = [];
    selectedProgram: any = null;
    newRec = { channelId: '', title: '', startTime: '', endTime: '' };

    constructor(private api: ApiService, private toast: ToastService) { }

    ngOnInit(): void {
        this.loadAll();
    }

    async loadAll(): Promise<void> {
        this.loading = true;
        try {
            const [recordings, storage] = await Promise.all([
                this.api.getDvrSchedules().toPromise().catch(() => []),
                this.api.getDvrStorage().toPromise().catch(() => ({ usedBytes: 0, totalBytes: 1 }))
            ]);
            this.recordings = recordings || [];
            const s = storage as { usedBytes: number; totalBytes: number };
            this.storageUsed = s.usedBytes;
            this.storageTotal = s.totalBytes;
        } catch { this.recordings = []; }
        finally { this.loading = false; }
    }

    async openScheduleModal(): Promise<void> {
        if (this.guideChannels && this.guideChannels.length > 0) {
            this.channels = this.guideChannels;
        } else {
            try {
                const res = await this.api.getGuide().toPromise();
                this.channels = res?.channels || [];
            } catch { this.channels = []; }
        }

        const now = new Date();
        const end = new Date(now.getTime() + 3600000);
        this.newRec.startTime = now.toISOString().slice(0, 16);
        this.newRec.endTime = end.toISOString().slice(0, 16);
        this.newRec.channelId = '';
        this.newRec.title = '';
        this.selectedChannelPrograms = [];
        this.selectedProgram = null;
        this.showScheduleModal = true;
    }

    onChannelSelect(): void {
        const ch = this.channels.find(c => c.id === this.newRec.channelId);
        if (ch && ch.programs && ch.programs.length > 0) {
            this.selectedChannelPrograms = ch.programs;
        } else {
            this.selectedChannelPrograms = [];
        }
        this.selectedProgram = null;
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

    async submitSchedule(): Promise<void> {
        if (!this.newRec.channelId || !this.newRec.title || !this.newRec.startTime || !this.newRec.endTime) {
            this.toast.show('All fields are required', 'warning'); return;
        }
        const channel = this.channels.find(c => c.id === this.newRec.channelId);
        const streamUrl = channel?.stream_url || channel?.url;
        if (!streamUrl) { this.toast.show('Invalid channel', 'error'); return; }
        try {
            await this.api.scheduleRecording({
                channel_id: this.newRec.channelId,
                program_title: this.newRec.title,
                start_time: new Date(this.newRec.startTime).toISOString(),
                end_time: new Date(this.newRec.endTime).toISOString(),
                stream_url: streamUrl
            }).toPromise();
            this.showScheduleModal = false;
            this.toast.show('Recording scheduled', 'success');
            await this.loadAll();
        } catch { this.toast.show('Failed to schedule', 'error'); }
    }

    async stopRecording(id: number): Promise<void> {
        if (!confirm('Stop this recording?')) return;
        try {
            await this.api.stopDvr(id).toPromise();
            await this.loadAll();
        } catch { this.toast.show('Failed to stop', 'error'); }
    }

    async deleteRecording(id: number): Promise<void> {
        if (!confirm('Delete this recording?')) return;
        try {
            await this.api.cancelRecording(id).toPromise();
            await this.loadAll();
        } catch { this.toast.show('Failed to delete', 'error'); }
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

    fmtBytes(bytes: number): string {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
}
