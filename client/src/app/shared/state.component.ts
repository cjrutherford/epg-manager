import { Component, Input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

/**
 * A page-level state message (load failure, empty list, offline).
 *
 * The three admin error blocks were identical apart from their copy. The
 * component keeps the existing `.state` vocabulary, adds the icon in one place
 * and projects the recovery action so callers choose the right next step.
 */
@Component({
    selector: 'app-state',
    standalone: true,
    imports: [LucideAngularModule],
    template: `
        <div class="glass-card state" [class.state--error]="tone === 'error'">
            <lucide-icon [name]="icon" class="icon icon--xl state__icon"></lucide-icon>
            <h2 class="state__title">{{ title }}</h2>
            @if (message) { <p class="state__message">{{ message }}</p> }
            <ng-content></ng-content>
        </div>
    `
})
export class StateComponent {
    @Input() tone: 'error' | 'info' = 'info';
    @Input() icon = 'circle-alert';
    @Input() title = '';
    @Input() message = '';
}
