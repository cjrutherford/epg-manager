import { Injectable } from '@angular/core';

export interface Toast {
    id: number;
    message: string;
    type: 'success' | 'error' | 'warning' | 'info';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
    private counter = 0;
    toasts: Toast[] = [];

    show(message: string, type: Toast['type'] = 'info') {
        const id = ++this.counter;
        this.toasts.push({ id, message, type });
        setTimeout(() => this.dismiss(id), 4000);
    }

    dismiss(id: number) {
        this.toasts = this.toasts.filter(t => t.id !== id);
    }
}
