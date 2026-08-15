import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from './toast.service';

@Component({
    selector: 'app-toast-container',
    standalone: true,
    imports: [CommonModule],
    template: `
    <!-- Announcements go through a live region: a toast is a visual event, and
         without this a screen reader user is told nothing at all. Two regions,
         because a politeness level cannot be changed after the fact. -->
    <div class="visually-hidden" role="status" aria-live="polite">
      @if (announcement(); as a) { @if (!a.assertive) { {{ a.text }} } }
    </div>
    <div class="visually-hidden" role="alert" aria-live="assertive">
      @if (announcement(); as a) { @if (a.assertive) { {{ a.text }} } }
    </div>

    <div class="toast-container"
         (mouseenter)="toastService.pause()"
         (mouseleave)="toastService.resume()"
         (focusin)="toastService.pause()"
         (focusout)="toastService.resume()">
      @for (toast of toastService.toasts(); track toast.id) {
        <div [class]="'toast toast-' + toast.type + ' ' + toast.type"
             [class.toast-persistent]="toast.persistent">
          <span class="toast-icon" aria-hidden="true">
            @if (toast.type === 'success') { ✓ }
            @else if (toast.type === 'error') { ✕ }
            @else if (toast.type === 'warning') { ⚠ }
            @else { ℹ }
          </span>
          <span class="toast-msg">
            {{ toast.message }}
            @if (toast.count > 1) {
              <span class="toast-count">×{{ toast.count }}</span>
            }
          </span>
          <button type="button" class="toast-close"
                  [attr.aria-label]="'Dismiss: ' + toast.message"
                  (click)="toastService.dismiss(toast.id)">✕</button>
        </div>
      }
    </div>
  `,
    styles: [`
    .toast-container {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: none;
    }
    .toast {
      position: relative;
      pointer-events: auto;
      display: flex; align-items: center; gap: 10px;
      padding: 12px 20px; border-radius: 10px;
      background: var(--bg-glass); backdrop-filter: blur(20px);
      border: var(--border-glass);
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      font-size: 0.85rem; color: var(--text-primary);
      animation: toast-in 0.25s ease-out;
      max-width: 400px;
      overflow: hidden;
    }
    /* The countdown bar is a lie on a toast that never expires. */
    .toast-persistent::after { display: none; }
    .toast::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      border-radius: 0 0 10px 10px;
      animation: toast-progress 4s linear forwards;
    }
    .toast-icon { font-weight: 700; font-size: 1rem; flex: none; }
    .toast-count {
      margin-left: 6px;
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
    }
    .toast-close {
      flex: none;
      margin-left: auto;
      background: none;
      border: none;
      color: inherit;
      opacity: 0.55;
      cursor: pointer;
      font-size: 0.9rem;
      line-height: 1;
      padding: 2px 4px;
    }
    .toast-close:hover { opacity: 1; }
    .visually-hidden {
      position: absolute;
      width: 1px; height: 1px;
      margin: -1px; padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }
    .toast-msg { line-height: 1.4; }
    .toast-success { border-left: 3px solid var(--color-success); }
    .toast-success .toast-icon { color: var(--color-success); }
    .toast-success::after { background: var(--color-success); }
    .toast-error { border-left: 3px solid var(--color-danger); }
    .toast-error .toast-icon { color: var(--color-danger); }
    .toast-error::after { background: var(--color-danger); }
    .toast-warning { border-left: 3px solid var(--color-warning); }
    .toast-warning .toast-icon { color: var(--color-warning); }
    .toast-warning::after { background: var(--color-warning); }
    .toast-info { border-left: 3px solid var(--color-info); }
    .toast-info .toast-icon { color: var(--color-info); }
    .toast-info::after { background: var(--color-info); }
    .toast-exiting {
      animation: toast-out 0.25s ease-in forwards;
    }
    @keyframes toast-in {
      from { opacity: 0; transform: translateX(20px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes toast-out {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(20px); }
    }
    @keyframes toast-progress {
      from { width: 100%; }
      to { width: 0%; }
    }
  `]
})
export class ToastContainerComponent {
    readonly announcement = this.toastService.announcement;

    constructor(public toastService: ToastService) { }
}
