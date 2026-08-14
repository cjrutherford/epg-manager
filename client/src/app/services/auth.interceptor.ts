import { inject } from '@angular/core';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Attaches the admin token to API calls and handles expiry in one place.
 *
 * Before this, every one of ~45 ApiService methods built its own headers by
 * hand — two had already forgotten, and nothing handled 401 at all, so an
 * expired session degraded into silently empty panels instead of a prompt.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
    const auth = inject(AuthService);

    const token = auth.getToken();
    const request = token && isApiRequest(req.url)
        ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
        : req;

    return next(request).pipe(
        catchError((error: unknown) => {
            if (error instanceof HttpErrorResponse && error.status === 401 && isApiRequest(req.url)) {
                // Only meaningful if we thought we were signed in. An anonymous
                // viewer hitting an admin endpoint gets the error surfaced by the
                // caller instead — no point prompting someone who never logged in.
                if (token) {
                    auth.handleSessionExpired();
                }
            }
            return throwError(() => error);
        })
    );
};

/** Auth endpoints manage their own credentials; everything else under /api gets the token. */
function isApiRequest(url: string): boolean {
    return url.includes('/api/') && !url.includes('/api/auth');
}
