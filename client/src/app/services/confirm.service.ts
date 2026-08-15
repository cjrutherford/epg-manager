import { Injectable, signal } from '@angular/core';

/**
 * Application confirmations, replacing `window.confirm`.
 *
 * The native dialog cannot be styled, cannot be themed, blocks the whole
 * renderer, and gives no room to say what is actually about to happen — every
 * one of the fourteen call sites had to compress its warning into a single
 * unformatted sentence. It also looks like a browser security prompt, which is
 * the wrong register for "delete this recording".
 */

export interface ConfirmRequest {
    title: string;
    /** The consequence, in plain words. */
    message: string;
    /** Extra detail shown smaller, for what is at stake. */
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Styles the confirm button as destructive. */
    destructive?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
    resolve: (value: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
    private readonly pendingSignal = signal<PendingConfirm | null>(null);
    readonly pending = this.pendingSignal.asReadonly();

    /**
     * Ask, and resolve to what the user chose. Reads the same way at the call
     * site as `confirm()` did: `if (!await confirm.ask(...)) return;`
     */
    ask(request: ConfirmRequest): Promise<boolean> {
        // A second request while one is open would orphan the first; answer the
        // outstanding one as a cancel rather than losing its promise.
        const outstanding = this.pendingSignal();
        if (outstanding) outstanding.resolve(false);

        return new Promise<boolean>(resolve => {
            this.pendingSignal.set({
                confirmLabel: 'Confirm',
                cancelLabel: 'Cancel',
                destructive: false,
                ...request,
                resolve
            });
        });
    }

    respond(value: boolean): void {
        const pending = this.pendingSignal();
        if (!pending) return;
        this.pendingSignal.set(null);
        pending.resolve(value);
    }
}
