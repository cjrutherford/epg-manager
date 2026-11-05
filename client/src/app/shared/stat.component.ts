import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

export type StatTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

/**
 * The statistic card used by Dashboard, Sources and Diagnostics.
 *
 * The three screens had drifted: Sources used buttons as filters, Diagnostics
 * hard-coded a different tone for the same meaning, and Dashboard invented its
 * own status mapping. The markup is the same `.stat` vocabulary the tests
 * already assert on; the component only makes the variants explicit.
 */
@Component({
    selector: 'app-stat',
    standalone: true,
    imports: [CommonModule],
    host: { class: 'stat-host' },
    template: `
        @if (interactive) {
        <button type="button" class="stat"
            [ngClass]="classes"
            [attr.aria-pressed]="pressed"
            (click)="pressedChange.emit()">
            <span class="stat__value">{{ value }}</span>
            <span class="stat__label">{{ label }}</span>
            @if (detail) { <span class="stat__detail">{{ detail }}</span> }
        </button>
        } @else {
        <div class="stat" [ngClass]="classes">
            <span class="stat__value">{{ value }}</span>
            <span class="stat__label">{{ label }}</span>
            @if (detail) { <span class="stat__detail">{{ detail }}</span> }
        </div>
        }
    `,
    styles: [`
        :host { display: contents; }
    `]
})
export class StatComponent {
    @Input() value: string | number = '';
    @Input() label = '';
    @Input() detail = '';
    @Input() tone: StatTone = 'neutral';
    /** Sources uses its cards as filters. */
    @Input() interactive = false;
    @Input() pressed = false;
    @Input() active = false;

    @Output() pressedChange = new EventEmitter<void>();

    get classes(): Record<string, boolean> {
        return {
            [`stat--${this.tone}`]: this.tone !== 'neutral',
            'is-active': this.active
        };
    }
}
