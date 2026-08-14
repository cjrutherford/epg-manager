import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap, map } from 'rxjs';
import { Router } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';
import { ToastService } from './toast.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
    private tokenKey = 'epg_admin_token';
    private authenticated$ = new BehaviorSubject<boolean>(false);
    private isBrowser: boolean;
    private lastExpiryNoticeAt = 0;

    /**
     * Set when a session is rejected, so the login form can explain why the
     * user is suddenly looking at it. Cleared on the next successful sign-in.
     */
    sessionExpiredNotice = false;

    constructor(
        private http: HttpClient,
        private router: Router,
        private toast: ToastService,
        @Inject(PLATFORM_ID) platformId: Object
    ) {
        this.isBrowser = isPlatformBrowser(platformId);
        if (this.isBrowser) {
            this.authenticated$.next(this.hasToken());
        }
    }

    get isAuthenticated(): Observable<boolean> {
        return this.authenticated$.asObservable();
    }

    get isAuthenticatedSync(): boolean {
        return this.authenticated$.value;
    }

    getToken(): string | null {
        if (!this.isBrowser) return null;
        return localStorage.getItem(this.tokenKey);
    }

    hasToken(): boolean {
        if (!this.isBrowser) return false;
        return !!localStorage.getItem(this.tokenKey);
    }

    login(password: string): Observable<boolean> {
        return this.http.post<any>('/api/auth', { password }).pipe(
            tap(res => {
                if (res.success && res.token && this.isBrowser) {
                    localStorage.setItem(this.tokenKey, res.token);
                    this.sessionExpiredNotice = false;
                    this.authenticated$.next(true);
                }
            }),
            map(res => res.success)
        );
    }

    logout(): void {
        const token = this.getToken();
        if (token) {
            this.http.post('/api/auth/logout', {}, {
                headers: { 'Authorization': `Bearer ${token}` }
            }).subscribe();
        }
        this.clearSession();
        this.router.navigate(['/admin']);
    }

    private clearSession(): void {
        if (this.isBrowser) {
            localStorage.removeItem(this.tokenKey);
        }
        this.authenticated$.next(false);
    }

    /**
     * Called by the auth interceptor when the server rejects our token.
     * Announces it once — a page firing six parallel requests would otherwise
     * raise six identical prompts.
     */
    handleSessionExpired(): void {
        if (!this.hasToken()) return;

        // Set before clearSession(): that pushes authenticated$ = false, and the
        // shell reads this flag synchronously inside that subscription.
        this.sessionExpiredNotice = true;
        this.clearSession();

        // The admin shell swaps in the login form and states the reason there.
        // Elsewhere (the Watch surface has no login form) a toast is the only
        // place a viewer would ever see it.
        const now = Date.now();
        const onAdmin = this.isBrowser && this.router.url.startsWith('/admin');
        if (!onAdmin && now - this.lastExpiryNoticeAt > 5000) {
            this.lastExpiryNoticeAt = now;
            this.toast.show('Your session expired — please sign in again', 'warning');
        }

        // Only redirect someone who is actually in the admin console; a viewer
        // on /watch should not be yanked away from what they are watching.
        if (this.isBrowser && this.router.url.startsWith('/admin')) {
            this.router.navigate(['/admin']);
        }
    }

    checkAuth(): Observable<boolean> {
        const token = this.getToken();
        if (!token) {
            this.authenticated$.next(false);
            return new Observable(sub => { sub.next(false); sub.complete(); });
        }
        return this.http.get<any>('/api/auth/status', {
            headers: { 'Authorization': `Bearer ${token}` }
        }).pipe(
            tap(res => {
                if (res.authenticated) {
                    this.authenticated$.next(true);
                } else {
                    // 200 with authenticated:false — the token is dead but still
                    // in storage. Drop it, or the next reload retries a token the
                    // server has already forgotten.
                    this.clearSession();
                }
            }),
            map(res => res.authenticated)
        );
    }
}
