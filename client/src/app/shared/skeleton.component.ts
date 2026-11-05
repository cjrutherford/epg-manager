import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Loading skeletons for data screens.
 *
 * A centred spinner made the page collapse and then jump when content arrived.
 * The skeleton reserves the final geometry, so the layout does not move and the
 * wait is legible as "rows are coming" rather than "something is happening".
 */
@Component({
    selector: 'app-skeleton',
    standalone: true,
    imports: [CommonModule],
    template: `
        <div class="skeleton" [class.skeleton--cards]="variant === 'cards'" role="status" [attr.aria-label]="label">
            <span class="sr-only">{{ label }}</span>
            @if (variant === 'cards') {
                @for (row of rowList; track row) {
                <div class="skeleton__card">
                    <span class="skeleton__line skeleton__line--title"></span>
                    <span class="skeleton__line skeleton__line--wide"></span>
                    <span class="skeleton__line"></span>
                    <span class="skeleton__line skeleton__line--short"></span>
                </div>
                }
            } @else {
                <div class="skeleton__head">
                    <span class="skeleton__line skeleton__line--title"></span>
                </div>
                @for (row of rowList; track row) {
                <div class="skeleton__row">
                    <span class="skeleton__avatar"></span>
                    <span class="skeleton__line skeleton__line--wide"></span>
                    <span class="skeleton__line skeleton__line--short"></span>
                </div>
                }
            }
        </div>
    `,
    styles: [`
        :host { display: block; }

        .skeleton {
            background: var(--bg-card);
            border: var(--border-glass);
            border-radius: var(--radius-md);
            padding: var(--space-xl);
            overflow: hidden;
        }

        .skeleton__head {
            padding-bottom: var(--space-lg);
            border-bottom: 1px solid var(--border-subtle);
            margin-bottom: var(--space-sm);
        }

        .skeleton__row {
            display: flex;
            align-items: center;
            gap: var(--space-lg);
            padding: var(--space-lg) 0;
            border-bottom: 1px solid var(--border-subtle);
        }

        .skeleton__row:last-child {
            border-bottom: none;
        }

        .skeleton__avatar {
            width: 28px;
            height: 28px;
            flex: none;
            border-radius: var(--radius-sm);
            background: rgba(var(--color-primary-rgb), 0.12);
        }

        .skeleton__line {
            display: block;
            height: 10px;
            width: 24%;
            border-radius: var(--radius-pill);
            background: linear-gradient(90deg, rgba(var(--color-primary-rgb), 0.07) 0%, rgba(var(--color-primary-rgb), 0.18) 50%, rgba(var(--color-primary-rgb), 0.07) 100%);
            background-size: 200% 100%;
            animation: skeleton-shimmer 1.4s ease-in-out infinite;
        }

        .skeleton__line--title { width: 22%; height: 14px; }
        .skeleton__line--wide { width: 42%; }
        .skeleton__line--short { width: 14%; margin-left: auto; }

        .skeleton__card {
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-md);
            padding: var(--space-xl);
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
        }

        .skeleton--cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: var(--space-xl);
            background: transparent;
            border: none;
            padding: 0;
        }

        .skeleton--cards .skeleton__line { width: 70%; }
        .skeleton--cards .skeleton__line--title { width: 45%; }
        .skeleton--cards .skeleton__line--short { width: 35%; margin-left: 0; }

        @keyframes skeleton-shimmer {
            0% { background-position: 100% 0; }
            100% { background-position: -100% 0; }
        }

        @media (prefers-reduced-motion: reduce) {
            .skeleton__line { animation: none; }
        }
    `]
})
export class SkeletonComponent {
    @Input() variant: 'table' | 'cards' = 'table';
    @Input() rows = 6;
    @Input() label = 'Loading';

    get rowList(): number[] {
        return Array.from({ length: Math.max(1, this.rows) }, (_, i) => i);
    }
}
