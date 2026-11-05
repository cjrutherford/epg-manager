import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { statusClass, statusLabel } from '../services/dvr-format';

/**
 * The recording lifecycle badge.
 *
 * Server DVR and browser recordings used two different visual vocabularies for
 * the same states. Both now render the same `.badge` with the same colour map.
 */
@Component({
    selector: 'app-status-badge',
    standalone: true,
    imports: [CommonModule],
    template: `<span class="badge" [ngClass]="toneClass">{{ text }}</span>`
})
export class StatusBadgeComponent {
    @Input() status = '';
    /** Override the derived label when a screen has a more specific word. */
    @Input() label = '';

    get toneClass(): string {
        return statusClass(this.status);
    }

    get text(): string {
        return this.label || statusLabel(this.status);
    }
}
