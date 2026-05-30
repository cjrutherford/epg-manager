import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from './toast.service';

@Component({
    selector: 'app-toast-container',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div class="toast-container">
      @for (toast of toastService.toasts; track toast.id) {
        <div class="toast" [class]="'toast-' + toast.type" (click)="toastService.dismiss(toast.id)">
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
    }
    .toast-icon { font-weight: 700; font-size: 1rem; }
    .toast-msg { line-height: 1.4; }
    .toast-success .toast-icon { color: #4ade80; }
    .toast-error .toast-icon { color: #f87171; }
    .toast-warning .toast-icon { color: #fbbf24; }
    .toast-info .toast-icon { color: #60a5fa; }
    @keyframes toast-in {
      from { opacity: 0; transform: translateX(20px); }
      to { opacity: 1; transform: translateX(0); }
    }
  `]
})
export class ToastContainerComponent {
    constructor(public toastService: ToastService) { }
}
