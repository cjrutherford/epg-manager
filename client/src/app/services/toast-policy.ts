/**
 * How long a message stays, and how many can stack up.
 *
 * Every toast used to vanish after four seconds regardless of what it said, so
 * an error raised while the user was looking at something else — or away from
 * the desk — was simply gone. A success that disappears is fine; the action
 * succeeded. A failure that disappears leaves someone with a system that did
 * not do what they asked and no way to find out why.
 */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

/** Milliseconds before auto-dismiss; `null` means it stays until dismissed. */
export const TOAST_DURATIONS: Record<ToastType, number | null> = {
    success: 4000,
    info: 4000,
    // Errors and warnings persist. The user dismisses them when they have read
    // them, which is the only reliable signal that they have.
    warning: 8000,
    error: null
};

/** Most toasts on screen at once; older ones are dropped first. */
export const MAX_VISIBLE_TOASTS = 4;

export function durationFor(type: ToastType): number | null {
    return TOAST_DURATIONS[type];
}

export function isPersistent(type: ToastType): boolean {
    return durationFor(type) === null;
}

export interface ToastLike {
    id: number;
    message: string;
    type: ToastType;
}

/**
 * Trim the queue to the cap, dropping transient messages before persistent
 * ones. A burst of successes must never push an error off the screen.
 */
export function applyQueueCap<T extends ToastLike>(toasts: T[], max = MAX_VISIBLE_TOASTS): T[] {
    if (toasts.length <= max) return toasts;

    const persistent = toasts.filter(t => isPersistent(t.type));
    const transient = toasts.filter(t => !isPersistent(t.type));

    // Keep every persistent message, then fill the remaining room with the
    // newest transient ones.
    const room = Math.max(0, max - persistent.length);
    const keptTransient = transient.slice(-room);

    // Preserve original order so the list does not reshuffle as it trims.
    const kept = new Set<T>([...persistent, ...keptTransient]);
    return toasts.filter(t => kept.has(t));
}

/**
 * Repeat messages collapse instead of stacking. A sync that fails on twelve
 * channels should say so once, not bury the screen.
 */
export function findDuplicate<T extends ToastLike>(toasts: T[], message: string, type: ToastType): T | undefined {
    return toasts.find(t => t.message === message && t.type === type);
}

/**
 * How a message is announced to assistive technology.
 *
 * `assertive` interrupts what the screen reader is saying; that is right for a
 * failure and rude for a confirmation.
 */
export function ariaLiveFor(type: ToastType): 'assertive' | 'polite' {
    return type === 'error' ? 'assertive' : 'polite';
}

/** Screen readers get no colour or icon, so the type has to be said. */
export function announcementFor(type: ToastType, message: string): string {
    const prefix: Record<ToastType, string> = {
        success: 'Success',
        error: 'Error',
        warning: 'Warning',
        info: 'Note'
    };
    return `${prefix[type]}: ${message}`;
}
