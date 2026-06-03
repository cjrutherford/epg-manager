import { Injectable, signal } from '@angular/core';

export interface Toast {
    id: number;
    message: string;
    type: 'success' | 'error' | 'warning' | 'info';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
    private counter = 0;
    private readonly toastsSignal = signal<Toast[]>([]);
    readonly toasts = this.toastsSignal.asReadonly();

    show(message: string, type: Toast['type'] = 'info') {
        const id = ++this.counter;
        this.toastsSignal.update(toasts => [...toasts, { id, message, type }]);
        setTimeout(() => this.dismiss(id), 4000);
    }

    dismiss(id: number) {
        this.toastsSignal.update(toasts => toasts.filter(t => t.id !== id));
    }
}
