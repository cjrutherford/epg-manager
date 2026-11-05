import { Component, Input } from '@angular/core';

/**
 * Page title, one-line purpose and optional actions.
 *
 * Every admin screen already used the same `.page-header` classes, but wrote
 * the wrapper by hand. The component keeps the shared vocabulary and makes the
 * title/action relationship one decision.
 */
@Component({
    selector: 'app-page-header',
    standalone: true,
    template: `
        <header class="page-header">
            <div class="page-header__text">
                <h1>{{ title }}</h1>
                @if (subtitle) { <p class="page-sub">{{ subtitle }}</p> }
            </div>
            <div class="page-header__actions">
                <ng-content></ng-content>
            </div>
        </header>
    `
})
export class PageHeaderComponent {
    @Input() title = '';
    @Input() subtitle = '';
}
