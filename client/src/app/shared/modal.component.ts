import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { ModalFocusDirective } from '../services/modal-focus.directive';

let modalTitleSequence = 0;

/**
 * One dialog shell for the application.
 *
 * It keeps the focus trap and Escape contract from `appModalFocus`, but also
 * owns the backdrop, the heading and the close control. The nine hand-built
 * modals had four different close treatments and two of them had no dialog
 * semantics at all; every call site now gets the same behaviour.
 */
@Component({
    selector: 'app-modal',
    standalone: true,
    imports: [CommonModule, LucideAngularModule, ModalFocusDirective],
    template: `
        <div class="modal-backdrop" (click)="closed.emit()">
            <div class="modal-content"
                 [ngClass]="panelClass"
                 [style.max-width]="maxWidth || null"
                 appModalFocus
                 (dismiss)="closed.emit()"
                 [attr.aria-labelledby]="resolvedTitleId"
                 (click)="$event.stopPropagation()">
                @if (title) {
                <div class="modal-header">
                    @if (heading === 'h3') {
                    <h3 [id]="resolvedTitleId">{{ title }}</h3>
                    } @else {
                    <h2 [id]="resolvedTitleId">{{ title }}</h2>
                    }
                    <button type="button" class="close-modal-btn" aria-label="Close" (click)="closed.emit()">
                        <lucide-icon name="x" class="icon"></lucide-icon>
                    </button>
                </div>
                }
                <ng-content></ng-content>
            </div>
        </div>
    `,
    styles: [`
        :host { display: contents; }

        .modal-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: var(--space-xl);
            margin-bottom: var(--space-xl);
        }

        .modal-header h2,
        .modal-header h3 {
            margin: 0;
            font-family: var(--font-heading);
            font-size: var(--font-2xl);
            line-height: 1.15;
            color: var(--text-primary);
        }

        .close-modal-btn {
            flex: none;
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-sm);
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
        }

        .close-modal-btn:hover {
            color: var(--text-primary);
            border-color: var(--border-medium);
            background: var(--bg-surface-hover);
        }
    `]
})
export class ModalComponent {
    @Input() title = '';
    @Input() heading: 'h2' | 'h3' = 'h2';
    @Input() panelClass: string | string[] = '';
    @Input() maxWidth = '';
    /** Stable ids are useful to callers and tests that already target a modal. */
    @Input() titleId = '';

    @Output() closed = new EventEmitter<void>();

    private readonly generatedId = `app-modal-title-${++modalTitleSequence}`;

    get resolvedTitleId(): string {
        return this.titleId || this.generatedId;
    }
}
