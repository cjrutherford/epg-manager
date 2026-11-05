import { Component, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { Theme, ThemeService } from '../services/theme.service';

/**
 * One theme picker for both shells.
 *
 * Admin and Watch grew separate menus with different labels, row shapes and
 * selected states. The panel now owns the list, the four curated choices, the
 * "all themes" disclosure and the scroll behaviour; each shell only supplies
 * the trigger it already uses.
 */
@Component({
    selector: 'app-theme-menu',
    standalone: true,
    host: {
        '[class.theme-menu--left]': 'align === "left"',
        '[class.theme-menu--up]': 'placement === "up"'
    },
    imports: [CommonModule, LucideAngularModule],
    template: `
        <div class="theme-menu" [class.theme-menu--left]="align === 'left'" role="group" aria-label="Theme">
            <div class="theme-menu__title">Appearance</div>
            <div class="theme-menu__list">
                @for (theme of visibleThemes; track theme.key) {
                <button type="button" class="theme-row"
                    [class.theme-row--active]="theme.key === themeService.getCurrentThemeKey()"
                    [attr.aria-pressed]="theme.key === themeService.getCurrentThemeKey()"
                    (click)="choose(theme.key)">
                    <span class="theme-dots" aria-hidden="true">
                        <span class="theme-dot" [style.background]="theme.primaryColor"></span>
                        <span class="theme-dot" [style.background]="theme.bgColor"></span>
                    </span>
                    <span class="theme-row__text">
                        <span class="theme-row__name">{{ theme.name }}</span>
                        @if (theme.description) {
                        <span class="theme-row__desc">{{ theme.description }}</span>
                        }
                    </span>
                    @if (theme.key === themeService.getCurrentThemeKey()) {
                    <lucide-icon name="check" class="icon theme-row__check" aria-hidden="true"></lucide-icon>
                    }
                </button>
                }
            </div>
            @if (!showAll && themeService.getThemes().length > featuredCount) {
            <button type="button" class="theme-more" (click)="showAll = true">
                Show all {{ themeService.getThemes().length }} themes
            </button>
            }
            <p class="theme-menu__hint">Applies to Watch and Admin.</p>
        </div>
    `,
    styles: [`
        :host {
            display: block;
            position: absolute;
            top: calc(100% + 8px);
            right: 0;
            z-index: 260;
            width: min(300px, calc(100vw - 24px));
        }

        :host(.theme-menu--left) {
            right: auto;
            left: 0;
        }

        :host(.theme-menu--up) {
            top: auto;
            bottom: calc(100% + 8px);
        }

        .theme-menu {
            background: var(--bg-deep);
            border: var(--border-glass);
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-glass);
            padding: var(--space-lg);
            max-height: min(480px, calc(100vh - 112px));
            overflow-y: auto;
            overscroll-behavior: contain;
            scrollbar-width: thin;
            scrollbar-color: rgba(var(--color-primary-rgb), 0.3) transparent;
        }

        .theme-menu::-webkit-scrollbar { width: 8px; }
        .theme-menu::-webkit-scrollbar-thumb {
            background: rgba(var(--color-primary-rgb), 0.25);
            border-radius: var(--radius-pill);
        }

        .theme-menu__title {
            font-family: var(--font-heading);
            font-size: var(--font-xs);
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--color-primary);
            padding: 0 var(--space-2xs) var(--space-sm);
            border-bottom: 1px solid var(--border-subtle);
            margin-bottom: var(--space-sm);
        }

        .theme-menu__list {
            display: flex;
            flex-direction: column;
            gap: var(--space-2xs);
        }

        .theme-row {
            display: flex;
            align-items: center;
            gap: var(--space-md);
            width: 100%;
            padding: var(--space-sm) var(--space-md);
            border: 1px solid transparent;
            border-radius: var(--radius-sm);
            background: transparent;
            color: var(--text-primary);
            font: inherit;
            text-align: left;
            cursor: pointer;
        }

        .theme-row:hover { background: var(--bg-surface-hover); }

        .theme-row--active {
            border-color: rgba(var(--color-primary-rgb), 0.4);
            background: rgba(var(--color-primary-rgb), 0.1);
            color: var(--color-primary);
        }

        .theme-dots {
            display: flex;
            gap: var(--space-3xs);
            flex: none;
        }

        .theme-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: 1px solid var(--border-medium);
        }

        .theme-row__text {
            display: flex;
            flex-direction: column;
            gap: 1px;
            min-width: 0;
            flex: 1;
        }

        .theme-row__name {
            font-size: var(--font-sm);
            font-weight: 600;
        }

        .theme-row__desc {
            font-size: var(--font-xs);
            color: var(--text-muted);
            line-height: 1.3;
        }

        .theme-row__check {
            flex: none;
            color: var(--color-primary);
        }

        .theme-more {
            width: 100%;
            margin-top: var(--space-sm);
            padding: var(--space-xs) var(--space-sm);
            border: 1px dashed var(--border-medium);
            border-radius: var(--radius-sm);
            background: transparent;
            color: var(--text-secondary);
            font: inherit;
            font-size: var(--font-xs);
            cursor: pointer;
        }

        .theme-more:hover {
            color: var(--color-primary);
            border-color: rgba(var(--color-primary-rgb), 0.4);
        }

        .theme-menu__hint {
            margin: var(--space-sm) 0 0;
            font-size: var(--font-xs);
            color: var(--text-muted);
            line-height: 1.4;
        }
    `]
})
export class ThemeMenuComponent {
    /** Which edge of the trigger the panel is anchored to. */
    @Input() align: 'left' | 'right' = 'right';
    /** Open above the trigger when the trigger sits near the bottom edge. */
    @Input() placement: 'up' | 'down' = 'down';

    @Output() selected = new EventEmitter<string>();
    @Output() closed = new EventEmitter<void>();

    showAll = false;
    readonly featuredCount = 5;

    constructor(public themeService: ThemeService) { }

    get visibleThemes(): Theme[] {
        const themes = this.themeService.getThemes();
        if (this.showAll) return themes;
        const featured = themes.slice(0, this.featuredCount);
        const current = themes.find(theme => theme.key === this.themeService.getCurrentThemeKey());
        if (current && !featured.includes(current)) featured.push(current);
        return featured;
    }

    choose(key: string): void {
        this.themeService.setTheme(key);
        this.selected.emit(key);
    }

    @HostListener('document:keydown.escape')
    onEscape(): void {
        this.closed.emit();
    }

}
