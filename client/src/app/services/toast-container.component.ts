import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from './toast.service';

@Component({
    selector: 'app-toast-container',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div class="toast-container">
      @for (toast of toastService.toasts(); track toast.id) {
        <div [class]="'toast toast-' + toast.type + ' ' + toast.type" (click)="toastService.dismiss(toast.id)">
          <span class="toast-icon">
            @if (toast.type === 'success') { ✓ }
            @else if (toast.type === 'error') { ✕ }
            @else if (toast.type === 'warning') { ⚠ }
            @else { ℹ }
          </span>
          <span class="toast-msg">{{ toast.message }}</span>
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
      cursor: pointer;
      overflow: hidden;
    }
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
    .toast-icon { font-weight: 700; font-size: 1rem; }
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
    constructor(public toastService: ToastService) { }
}
