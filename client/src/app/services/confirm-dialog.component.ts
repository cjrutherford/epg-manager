import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConfirmService } from './confirm.service';
import { ModalFocusDirective } from './modal-focus.directive';

/**
 * Rendered once at the app root. Uses the same focus-trapping directive as
 * every other modal, so a confirmation traps focus, closes on Escape, and
 * returns focus to whatever asked — none of which the native dialog it
 * replaces could be made to do consistently.
 */
@Component({
    selector: 'app-confirm-dialog',
    standalone: true,
    imports: [CommonModule, ModalFocusDirective],
    template: `
    @if (confirmService.pending(); as request) {
      <div class="modal-backdrop" (click)="confirmService.respond(false)">
        <div class="modal-content confirm-modal"
             appModalFocus
             (dismiss)="confirmService.respond(false)"
             aria-labelledby="confirm-title"
             aria-describedby="confirm-message"
             (click)="$event.stopPropagation()">
          <h2 id="confirm-title">{{ request.title }}</h2>
          <p id="confirm-message" class="confirm-message">{{ request.message }}</p>
          @if (request.detail) {
            <p class="confirm-detail">{{ request.detail }}</p>
          }
          <div class="confirm-actions">
            <button type="button" class="btn btn-secondary"
                    (click)="confirmService.respond(false)">
              {{ request.cancelLabel }}
            </button>
            <button type="button"
                    class="btn"
                    [class.btn-primary]="!request.destructive"
                    [class.btn-destructive]="request.destructive"
                    (click)="confirmService.respond(true)">
              {{ request.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
    styles: [`
    .confirm-modal {
      max-width: 460px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    /* .modal-content is a scroll container; without this the actions can be
       squashed under the message, which is how the reset modal broke in S3. */
    .confirm-modal > * { flex-shrink: 0; }
    .confirm-modal h2 { margin: 0; }
    .confirm-message {
      margin: 0;
      color: var(--text-primary);
      line-height: 1.55;
    }
    .confirm-detail {
      margin: 0;
      color: var(--text-secondary);
      font-size: 0.85rem;
      line-height: 1.5;
    }
    .confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 4px;
    }
    .btn-destructive {
      background: rgba(var(--color-danger-rgb), 0.14);
      color: var(--color-danger);
      border: 1px solid rgba(var(--color-danger-rgb), 0.4);
    }
    .btn-destructive:hover {
      background: rgba(var(--color-danger-rgb), 0.22);
    }
  `]
})
export class ConfirmDialogComponent {
    constructor(public confirmService: ConfirmService) { }
}
