import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../../services/api.service';
import { SseService } from '../../services/sse.service';

@Component({
    selector: 'app-dashboard',
    standalone: true,
    imports: [CommonModule],
    templateUrl: './dashboard.component.html',
    styleUrl: './dashboard.component.css'
})
export class DashboardComponent implements OnInit {
    stats: any = null;
    health: any = null;
    jobStatus: any = null;
    loading = true;

    constructor(private api: ApiService, private sse: SseService) { }

    ngOnInit(): void {
        this.loadData();
    }

    async loadData(): Promise<void> {
        this.loading = true;
        try {
            const [stats, health, job] = await Promise.all([
                this.api.getStats().toPromise(),
                this.api.getHealth().toPromise(),
                this.api.getJobStatus().toPromise().catch(() => null)
            ]);
            this.stats = stats;
            this.health = health;
            this.jobStatus = job;
        } catch (e) {
            console.error('Failed to load dashboard', e);
        } finally {
            this.loading = false;
        }
    }

    runFullSync(): void {
        this.sse.connect();
        this.api.runFullSync().subscribe({
            next: (res) => { if (!res.success) alert(res.message || 'Sync failed'); },
            error: (e) => alert('Sync failed: ' + e.message)
        });
    }

    rebuildFiles(): void {
        if (!confirm('Rebuild M3U/XML from database?')) return;
        this.api.rebuildFiles().subscribe({
            next: (res) => { if (res.success) alert('Files rebuilt!'); },
            error: (e) => alert('Rebuild failed: ' + e.message)
        });
    }

    grabMissing(): void {
        this.sse.connect();
        this.api.grabMissing().subscribe({
            next: (res) => { },
            error: (e) => alert('Grab failed: ' + e.message)
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
