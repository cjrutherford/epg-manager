import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked, Inject, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { SseService } from '../services/sse.service';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

@Component({
    selector: 'app-admin-layout',
    standalone: true,
    imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, FormsModule],
    templateUrl: './admin-layout.component.html',
    styleUrl: './admin-layout.component.css'
})
export class AdminLayoutComponent implements OnInit, OnDestroy, AfterViewChecked {
    @ViewChild('logContainer') logContainerRef!: ElementRef<HTMLDivElement>;

    isAuthenticated = false;
    password = '';
    loginError = '';
    sidebarOpen = true;
    isMobile = false;

    // Status panel
    statusPanelOpen = false;
    statusPanelHeight = 280;
    logs: { message: string; level: string; time: Date }[] = [];
    progressBars: Record<string, { current: number; total: number; message: string; completed: boolean }> = {};

    // Drag resize
    private isDragging = false;
    private dragStartY = 0;
    private dragStartHeight = 0;
    private boundDragMove: any;
    private boundDragEnd: any;
    private shouldScrollLogs = false;

    private subscriptions: Subscription[] = [];
    private isBrowser: boolean;

    constructor(
        public auth: AuthService,
        private sse: SseService,
        @Inject(PLATFORM_ID) platformId: Object
    ) {
        this.isBrowser = isPlatformBrowser(platformId);
    }

    ngOnInit(): void {
        if (this.isBrowser) {
            this.isMobile = window.innerWidth < 768;
            if (this.isMobile) this.sidebarOpen = false;

            this.boundDragMove = this.onDragMove.bind(this);
            this.boundDragEnd = this.onDragEnd.bind(this);
        }

        this.auth.checkAuth().subscribe(ok => {
            this.isAuthenticated = ok;
            if (ok && this.isBrowser) {
                this.sse.connect();
                this.setupSseListeners();
            }
        });
    }

    ngOnDestroy(): void {
        this.subscriptions.forEach(s => s.unsubscribe());
        if (this.isBrowser) {
            this.sse.disconnect();
            document.removeEventListener('mousemove', this.boundDragMove);
            document.removeEventListener('mouseup', this.boundDragEnd);
            document.removeEventListener('touchmove', this.boundDragMove);
            document.removeEventListener('touchend', this.boundDragEnd);
        }
    }

    ngAfterViewChecked(): void {
        if (this.shouldScrollLogs && this.logContainerRef) {
            const el = this.logContainerRef.nativeElement;
            el.scrollTop = el.scrollHeight; // scroll to bottom (newest logs appended)
            this.shouldScrollLogs = false;
        }
    }

    login(): void {
        this.loginError = '';
        this.auth.login(this.password).subscribe({
            next: ok => {
                if (ok) {
                    this.isAuthenticated = true;
                    this.password = '';
                    this.sse.connect();
                    this.setupSseListeners();
                } else {
                    this.loginError = 'Invalid password';
                }
            },
            error: () => { this.loginError = 'Authentication failed'; }
        });
    }

    logout(): void {
        this.sse.disconnect();
        this.auth.logout();
        this.isAuthenticated = false;
    }

    toggleSidebar(): void {
        this.sidebarOpen = !this.sidebarOpen;
    }

    toggleStatusPanel(): void {
        this.statusPanelOpen = !this.statusPanelOpen;
    }

    private setupSseListeners(): void {
        this.subscriptions.push(
            this.sse.logEvents.subscribe(evt => {
                this.logs.push({ ...evt, time: new Date() });
                if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
                this.shouldScrollLogs = true;
            }),
            this.sse.progressEvents.subscribe(evt => {
                const existing = this.progressBars[evt.phase];
                // Don't overwrite a completed bar with a non-completed event
                if (existing?.completed && !evt.completed) return;
                this.progressBars[evt.phase] = {
                    current: evt.current,
                    total: evt.total,
                    message: evt.message || evt.label || '',
                    completed: evt.completed || false
                };
                if (!this.statusPanelOpen) this.statusPanelOpen = true;
            })
        );
    }

    getProgress(phase: string): number {
        const p = this.progressBars[phase];
        if (!p || p.total === 0) return 0;
        return Math.round((p.current / p.total) * 100);
    }

    get activePhases(): string[] {
        const order = ['match', 'grab', 'enrich'];
        const keys = Object.keys(this.progressBars);
        // Show phases in match → grab → enrich order, then any unknown phases
        return order.filter(p => keys.includes(p)).concat(keys.filter(p => !order.includes(p)));
    }

    getPhaseLabel(phase: string): string {
        const labels: Record<string, string> = {
            match: '🔗 Matching',
            grab: '📡 Grabbing EPG',
            enrich: '🎬 Enriching'
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

    // ── Status Panel Drag Resize ──
    onDragStart(event: MouseEvent | TouchEvent): void {
        if (!this.isBrowser) return;
        event.preventDefault();
        this.isDragging = true;
        this.dragStartY = 'touches' in event ? event.touches[0].clientY : event.clientY;
        this.dragStartHeight = this.statusPanelHeight;
        document.addEventListener('mousemove', this.boundDragMove);
        document.addEventListener('mouseup', this.boundDragEnd);
        document.addEventListener('touchmove', this.boundDragMove);
        document.addEventListener('touchend', this.boundDragEnd);
    }

    private onDragMove(event: MouseEvent | TouchEvent): void {
        if (!this.isDragging || !this.isBrowser) return;
        const clientY = 'touches' in event ? (event as TouchEvent).touches[0].clientY : (event as MouseEvent).clientY;
        const delta = this.dragStartY - clientY;
        this.statusPanelHeight = Math.max(150, Math.min(window.innerHeight * 0.7, this.dragStartHeight + delta));
    }

    private onDragEnd(): void {
        this.isDragging = false;
        if (!this.isBrowser) return;
        document.removeEventListener('mousemove', this.boundDragMove);
        document.removeEventListener('mouseup', this.boundDragEnd);
        document.removeEventListener('touchmove', this.boundDragMove);
        document.removeEventListener('touchend', this.boundDragEnd);
    }
}
