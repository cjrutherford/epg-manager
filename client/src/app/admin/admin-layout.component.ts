import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked, Inject, PLATFORM_ID, ChangeDetectorRef } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { ApiService } from '../services/api.service';
import { SseService } from '../services/sse.service';
import { ThemeService } from '../services/theme.service';
import { ToastContainerComponent } from '../services/toast-container.component';
import { ToastService } from '../services/toast.service';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { LucideAngularModule } from 'lucide-angular';

@Component({
    selector: 'app-admin-layout',
    standalone: true,
    imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, FormsModule, LucideAngularModule, ToastContainerComponent],
    templateUrl: './admin-layout.component.html',
    styleUrl: './admin-layout.component.css'
})
export class AdminLayoutComponent implements OnInit, OnDestroy, AfterViewChecked {
    isAuthenticated = false;
    password = '';
    loginError = '';
    sidebarOpen = true;
    isMobile = false;
    themePickerOpen = false;

    private subscriptions: Subscription[] = [];
    private isBrowser: boolean;

    constructor(
        public auth: AuthService,
        private api: ApiService,
        private sse: SseService,
        public themeService: ThemeService,
        public toast: ToastService,
        private cdr: ChangeDetectorRef,
        @Inject(PLATFORM_ID) platformId: Object
    ) {
        this.isBrowser = isPlatformBrowser(platformId);
    }

    ngOnInit(): void {
        if (this.isBrowser) {
            this.isMobile = window.innerWidth < 768;
            if (this.isMobile) this.sidebarOpen = false;
        }

        this.subscriptions.push(
            this.auth.checkAuth().subscribe(ok => {
                this.isAuthenticated = ok;
                if (ok && this.isBrowser) {
                    this.sse.connect();
                }
                this.cdr.detectChanges();
            })
        );
    }

    ngOnDestroy(): void {
        this.subscriptions.forEach(s => s.unsubscribe());
        if (this.isBrowser) {
            this.sse.disconnect();
        }
    }

    ngAfterViewChecked(): void {
    }

    login(): void {
        this.loginError = '';
        this.subscriptions.push(
            this.auth.login(this.password).subscribe({
                next: ok => {
                    if (ok) {
                        this.isAuthenticated = true;
                        this.password = '';
                        this.sse.connect();
                    } else {
                        this.loginError = 'Invalid password';
                    }
                    this.cdr.detectChanges();
                },
                error: (err) => {
                    this.loginError = err?.error?.error || 'Authentication failed';
                    this.cdr.detectChanges();
                }
            })
        );
    }

    logout(): void {
        this.sse.disconnect();
        this.auth.logout();
        this.isAuthenticated = false;
    }

    toggleSidebar(): void {
        this.sidebarOpen = !this.sidebarOpen;
    }

    toggleThemePicker(): void {
        this.themePickerOpen = !this.themePickerOpen;
    }

    setTheme(key: string): void {
        this.themeService.setTheme(key);
    }
}
