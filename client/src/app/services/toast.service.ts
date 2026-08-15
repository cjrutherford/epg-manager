import { Injectable, signal } from '@angular/core';
import {
    announcementFor,
    applyQueueCap,
    durationFor,
    findDuplicate,
    isPersistent,
    type ToastType
} from './toast-policy';

export interface Toast {
    id: number;
    message: string;
    type: ToastType;
    /** Stays until dismissed. Errors do; successes do not. */
    persistent: boolean;
    /** Bumped when an identical message repeats, instead of stacking a copy. */
    count: number;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
    private counter = 0;
    private readonly toastsSignal = signal<Toast[]>([]);
    readonly toasts = this.toastsSignal.asReadonly();

    /** What assistive technology should read out, newest last. */
    private readonly announcementSignal = signal<{ text: string; assertive: boolean } | null>(null);
    readonly announcement = this.announcementSignal.asReadonly();

    private timers = new Map<number, ReturnType<typeof setTimeout>>();
    private paused = false;
    private remaining = new Map<number, { startedAt: number; duration: number }>();

    show(message: string, type: ToastType = 'info') {
        // A repeat of the same message counts up rather than stacking.
        const existing = findDuplicate(this.toastsSignal(), message, type);
        if (existing) {
            this.toastsSignal.update(toasts =>
                toasts.map(t => (t.id === existing.id ? { ...t, count: t.count + 1 } : t))
            );
            this.restartTimer(existing.id, type);
            this.announce(type, message);
            return existing.id;
        }

        const id = ++this.counter;
        const toast: Toast = { id, message, type, persistent: isPersistent(type), count: 1 };

        this.toastsSignal.update(toasts => applyQueueCap([...toasts, toast]));

        // Anything the cap dropped must not leave a timer behind.
        this.reconcileTimers();
        this.startTimer(id, type);
        this.announce(type, message);
        return id;
    }

    dismiss(id: number) {
        this.clearTimer(id);
        this.toastsSignal.update(toasts => toasts.filter(t => t.id !== id));
    }

    dismissAll() {
        for (const id of [...this.timers.keys()]) this.clearTimer(id);
        this.toastsSignal.set([]);
    }

    /**
     * Hold every countdown while the pointer is over the stack. Reading a
     * message should not be a race against it disappearing.
     */
    pause() {
        if (this.paused) return;
        this.paused = true;
        const now = Date.now();
        for (const [id, timer] of this.timers) {
            clearTimeout(timer);
            const state = this.remaining.get(id);
            if (state) {
                state.duration = Math.max(0, state.duration - (now - state.startedAt));
            }
        }
        this.timers.clear();
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        for (const [id, state] of this.remaining) {
            if (!this.toastsSignal().some(t => t.id === id)) continue;
            state.startedAt = Date.now();
            this.timers.set(id, setTimeout(() => this.dismiss(id), state.duration));
        }
    }

    private startTimer(id: number, type: ToastType) {
        const duration = durationFor(type);
        if (duration === null) return;
        this.remaining.set(id, { startedAt: Date.now(), duration });
        if (!this.paused) {
            this.timers.set(id, setTimeout(() => this.dismiss(id), duration));
        }
    }

    private restartTimer(id: number, type: ToastType) {
        this.clearTimer(id);
        this.startTimer(id, type);
    }

    private clearTimer(id: number) {
        const timer = this.timers.get(id);
        if (timer) clearTimeout(timer);
        this.timers.delete(id);
        this.remaining.delete(id);
    }

    /** Drop timers for toasts the queue cap removed. */
    private reconcileTimers() {
        const live = new Set(this.toastsSignal().map(t => t.id));
        for (const id of [...this.timers.keys()]) {
            if (!live.has(id)) this.clearTimer(id);
        }
    }

    private announce(type: ToastType, message: string) {
        this.announcementSignal.set({
            text: announcementFor(type, message),
            assertive: type === 'error'
        });
    }
}
