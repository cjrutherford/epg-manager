import {
    announcementFor,
    applyQueueCap,
    ariaLiveFor,
    durationFor,
    findDuplicate,
    isPersistent,
    MAX_VISIBLE_TOASTS,
    type ToastLike,
    type ToastType
} from '../toast-policy';

const toast = (id: number, type: ToastType, message = `m${id}`): ToastLike => ({ id, type, message });

describe('durations', () => {
    it('keeps errors on screen until dismissed', () => {
        expect(durationFor('error')).toBeNull();
        expect(isPersistent('error')).toBe(true);
    });

    it('lets successes go', () => {
        expect(durationFor('success')).toBe(4000);
        expect(isPersistent('success')).toBe(false);
    });

    it('gives warnings longer than successes', () => {
        expect(durationFor('warning')!).toBeGreaterThan(durationFor('success')!);
    });
});

describe('applyQueueCap', () => {
    it('leaves a short queue alone', () => {
        const toasts = [toast(1, 'info'), toast(2, 'success')];
        expect(applyQueueCap(toasts)).toEqual(toasts);
    });

    it('drops the oldest transient messages past the cap', () => {
        const toasts = [1, 2, 3, 4, 5, 6].map(i => toast(i, 'success'));
        const kept = applyQueueCap(toasts);
        expect(kept).toHaveLength(MAX_VISIBLE_TOASTS);
        expect(kept.map(t => t.id)).toEqual([3, 4, 5, 6]);
    });

    // The point of the cap: a burst of successes must not push an error away.
    it('never drops an error to make room for a success', () => {
        const toasts = [
            toast(1, 'error'),
            ...[2, 3, 4, 5, 6].map(i => toast(i, 'success'))
        ];
        const kept = applyQueueCap(toasts);
        expect(kept.map(t => t.id)).toContain(1);
        expect(kept).toHaveLength(MAX_VISIBLE_TOASTS);
    });

    it('keeps every error even when they exceed the cap', () => {
        const toasts = [1, 2, 3, 4, 5, 6].map(i => toast(i, 'error'));
        expect(applyQueueCap(toasts)).toHaveLength(6);
    });

    it('preserves order rather than reshuffling as it trims', () => {
        const toasts = [
            toast(1, 'success'), toast(2, 'error'), toast(3, 'success'),
            toast(4, 'success'), toast(5, 'success'), toast(6, 'success')
        ];
        const kept = applyQueueCap(toasts).map(t => t.id);
        expect(kept).toEqual([...kept].sort((a, b) => a - b));
    });
});

describe('findDuplicate', () => {
    it('collapses an identical repeat', () => {
        const toasts = [toast(1, 'error', 'Stream unreachable')];
        expect(findDuplicate(toasts, 'Stream unreachable', 'error')?.id).toBe(1);
    });

    it('treats a different type as a different message', () => {
        const toasts = [toast(1, 'error', 'Saved')];
        expect(findDuplicate(toasts, 'Saved', 'success')).toBeUndefined();
    });

    it('returns nothing when the message is new', () => {
        expect(findDuplicate([toast(1, 'info', 'a')], 'b', 'info')).toBeUndefined();
    });
});

describe('announcements', () => {
    it('interrupts for errors and waits its turn otherwise', () => {
        expect(ariaLiveFor('error')).toBe('assertive');
        for (const type of ['success', 'warning', 'info'] as ToastType[]) {
            expect(ariaLiveFor(type)).toBe('polite');
        }
    });

    it('says the type, since colour and icon carry it visually', () => {
        expect(announcementFor('error', 'Sync failed')).toBe('Error: Sync failed');
        expect(announcementFor('success', 'Saved')).toBe('Success: Saved');
    });
});
