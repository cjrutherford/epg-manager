import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

@Component({
    selector: 'app-dvr',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './dvr.component.html',
    styleUrl: './dvr.component.css'
})
export class DvrComponent implements OnInit {
    recordings: any[] = [];
    loading = true;
    showScheduleModal = false;

    // New recording form
    channels: any[] = [];
    newRec = { channelId: '', title: '', startTime: '', endTime: '' };

    constructor(private api: ApiService) { }

    ngOnInit(): void {
        this.loadRecordings();
    }

    async loadRecordings(): Promise<void> {
        this.loading = true;
        try {
            this.recordings = await this.api.getDvr().toPromise() || [];
        } catch { this.recordings = []; }
        finally { this.loading = false; }
    }

    async openScheduleModal(): Promise<void> {
        try {
            this.channels = await this.api.getMapping().toPromise() || [];
            this.channels = this.channels.filter(c => c.enabled);
        } catch { this.channels = []; }

        const now = new Date();
        const end = new Date(now.getTime() + 3600000);
        this.newRec.startTime = now.toISOString().slice(0, 16);
        this.newRec.endTime = end.toISOString().slice(0, 16);
        this.newRec.channelId = '';
        this.newRec.title = '';
        this.showScheduleModal = true;
    }

    async submitSchedule(): Promise<void> {
        if (!this.newRec.channelId || !this.newRec.title || !this.newRec.startTime || !this.newRec.endTime) {
            alert('All fields are required'); return;
        }
        const channel = this.channels.find(c => c.id === this.newRec.channelId);
        if (!channel?.url) { alert('Invalid channel'); return; }
        try {
            await this.api.scheduleDvr({
                channel_id: this.newRec.channelId,
                program_title: this.newRec.title,
                start_time: new Date(this.newRec.startTime).toISOString(),
                end_time: new Date(this.newRec.endTime).toISOString(),
                stream_url: channel.url
            }).toPromise();
            this.showScheduleModal = false;
            await this.loadRecordings();
        } catch { alert('Failed to schedule'); }
    }

    async stopRecording(id: number): Promise<void> {
        if (!confirm('Stop this recording?')) return;
        try {
            await this.api.stopDvr(id).toPromise();
            await this.loadRecordings();
        } catch { alert('Failed to stop'); }
    }

    async deleteRecording(id: number): Promise<void> {
        if (!confirm('Delete this recording?')) return;
        try {
            await this.api.deleteDvr(id).toPromise();
            await this.loadRecordings();
        } catch { alert('Failed to delete'); }
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
}
