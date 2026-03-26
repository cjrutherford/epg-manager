import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap, map } from 'rxjs';
import { Router } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';

@Injectable({ providedIn: 'root' })
export class AuthService {
    private tokenKey = 'epg_admin_token';
    private authenticated$ = new BehaviorSubject<boolean>(false);
    private isBrowser: boolean;

    constructor(private http: HttpClient, private router: Router, @Inject(PLATFORM_ID) platformId: Object) {
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
        if (this.isBrowser) {
            localStorage.removeItem(this.tokenKey);
        }
        this.authenticated$.next(false);
        this.router.navigate(['/admin']);
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
            tap(res => this.authenticated$.next(res.authenticated)),
            map(res => res.authenticated)
        );
    }
}
