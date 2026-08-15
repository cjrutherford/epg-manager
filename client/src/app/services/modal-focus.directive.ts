import { AfterViewInit, Directive, ElementRef, EventEmitter, OnDestroy, Output } from '@angular/core';

/**
 * Dialog behaviour for the modals, in one place.
 *
 * Every modal in the app was a `<div class="modal-content">` with a click
 * handler. That means: no dialog semantics for a screen reader, Tab walks
 * straight out of the modal into the page behind it, Escape does nothing, and
 * focus stays wherever it was when the modal opened — which for a keyboard user
 * is usually nowhere useful.
 *
 * Applying `appModalFocus` gives an element `role="dialog"`, `aria-modal`,
 * focus on open, a focus trap, Escape to close, and focus returned to whatever
 * opened it.
 */
@Directive({
    selector: '[appModalFocus]',
    standalone: true,
    host: {
        'role': 'dialog',
        'aria-modal': 'true',
        'tabindex': '-1',
        '(keydown)': 'onKeydown($event)'
    }
})
export class ModalFocusDirective implements AfterViewInit, OnDestroy {
    /** Emitted on Escape, so the host can close however it already closes. */
    @Output() dismiss = new EventEmitter<void>();

    private previouslyFocused: HTMLElement | null = null;

    private static readonly FOCUSABLE = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    constructor(private host: ElementRef<HTMLElement>) { }

    ngAfterViewInit(): void {
        if (typeof document === 'undefined') return;

        this.previouslyFocused = document.activeElement as HTMLElement | null;

        // Prefer the first real control; fall back to the dialog itself so the
        // screen reader announces it rather than staying on the page behind.
        const first = this.focusable()[0];
        (first ?? this.host.nativeElement).focus({ preventScroll: true });
    }

    ngOnDestroy(): void {
        // Returning focus is what makes a modal feel like a detour rather than
        // a dead end for anyone not using a mouse.
        this.previouslyFocused?.focus?.({ preventScroll: true });
    }

    private focusable(): HTMLElement[] {
        return Array.from(
            this.host.nativeElement.querySelectorAll<HTMLElement>(ModalFocusDirective.FOCUSABLE)
        ).filter(el => el.offsetParent !== null || el === document.activeElement);
    }

    onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.stopPropagation();
            this.dismiss.emit();
            return;
        }

        if (event.key !== 'Tab') return;

        const elements = this.focusable();
        if (elements.length === 0) {
            // Nothing to move to; keep focus on the dialog rather than letting
            // it escape to the page behind.
            event.preventDefault();
            return;
        }

        const first = elements[0];
        const last = elements[elements.length - 1];
        const active = document.activeElement as HTMLElement;

        if (event.shiftKey && (active === first || active === this.host.nativeElement)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }
}
