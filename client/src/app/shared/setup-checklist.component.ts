import { Component, EventEmitter, Input, Output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '../i18n/translate.pipe';
import { LucideAngularModule } from 'lucide-angular';

/**
 * The first-run path: source → sync → watch.
 *
 * A brand-new install used to present the same dashboard as a configured one,
 * with the next step buried in an empty-state banner. The checklist appears
 * only while setup is incomplete and turns the three steps into a visible
 * sequence with one action at a time.
 */
@Component({
    selector: 'app-setup-checklist',
    standalone: true,
    imports: [RouterLink, LucideAngularModule, TranslatePipe],
    template: `
        @if (!hasWatched) {
        <section class="setup glass-card" aria-labelledby="setup-title">
            <div class="setup__head">
                <div>
                    <div class="setup__eyebrow">{{ 'setup.eyebrow' | t }}</div>
                    <h2 id="setup-title">{{ (allDone ? 'setup.readyTitle' : 'setup.title') | t }}</h2>
                    <p>{{ (allDone ? 'setup.readyIntro' : 'setup.intro') | t }}</p>
                </div>
                <span class="setup__count">{{ 'setup.doneCount' | t: { done: doneCount } }}</span>
            </div>

            <ol class="setup__steps">
                <li class="setup__step" [class.done]="hasSource">
                    <span class="setup__marker">
                        <lucide-icon [name]="hasSource ? 'check' : 'server'" class="icon"></lucide-icon>
                    </span>
                    <div class="setup__body">
                        <h3>{{ 'setup.sourceTitle' | t }}</h3>
                        <p>{{ 'setup.sourceBody' | t }}</p>
                    </div>
                    @if (!hasSource) {
                    <a class="btn btn-secondary small-btn" routerLink="/admin/sources">{{ 'setup.sourceAction' | t }}</a>
                    }
                </li>

                <li class="setup__step" [class.done]="hasChannels && hasPrograms">
                    <span class="setup__marker">
                        <lucide-icon [name]="hasChannels && hasPrograms ? 'check' : 'refresh-cw'" class="icon"></lucide-icon>
                    </span>
                    <div class="setup__body">
                        <h3>{{ 'setup.syncTitle' | t }}</h3>
                        <p>{{ 'setup.syncBody' | t }}</p>
                    </div>
                    @if (!(hasChannels && hasPrograms)) {
                        @if (hasSource) {
                        <button type="button" class="btn btn-primary small-btn" (click)="runSync.emit()">{{ 'setup.syncAction' | t }}</button>
                        } @else {
                        <span class="setup__hint">{{ 'setup.waiting' | t }}</span>
                        }
                    }
                </li>

                <li class="setup__step" [class.done]="hasChannels">
                    <span class="setup__marker">
                        <lucide-icon [name]="hasChannels ? 'check' : 'play'" class="icon"></lucide-icon>
                    </span>
                    <div class="setup__body">
                        <h3>{{ 'setup.watchTitle' | t }}</h3>
                        <p>{{ 'setup.watchBody' | t }}</p>
                    </div>
                    @if (hasChannels) {
                    <a class="btn btn-primary small-btn" routerLink="/watch">{{ 'setup.watchAction' | t }}</a>
                    }
                </li>
            </ol>

            @if (allDone) {
            <div class="setup__ready">
                <a class="btn btn-primary" routerLink="/watch">{{ 'setup.watchCta' | t }}</a>
                <span>{{ 'setup.watchHint' | t }}</span>
            </div>
            }
        </section>
        }
    `,
    styles: [`
        .setup {
            margin-bottom: var(--space-3xl);
        }

        .setup__head {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: var(--space-xl);
            margin-bottom: var(--space-xl);
        }

        .setup__eyebrow {
            font-size: var(--font-xs);
            letter-spacing: 0.12em;
            text-transform: uppercase;
            font-weight: 700;
            color: var(--color-primary);
            margin-bottom: var(--space-2xs);
        }

        .setup h2 {
            margin: 0 0 var(--space-2xs);
            font-size: var(--font-2xl);
        }

        .setup__head p {
            margin: 0;
            color: var(--text-secondary);
            font-size: var(--font-md);
            max-width: 60ch;
        }

        .setup__count {
            flex: none;
            font-family: var(--mono, monospace);
            font-size: var(--font-xs);
            color: var(--text-muted);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-pill, 999px);
            padding: var(--space-3xs) var(--space-md);
        }

        .setup__steps {
            list-style: none;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: var(--space-md);
        }

        .setup__step {
            display: grid;
            grid-template-columns: 36px minmax(0, 1fr) auto;
            align-items: center;
            gap: var(--space-lg);
            padding: var(--space-lg) var(--space-xl);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-md);
            background: var(--bg-surface);
        }

        .setup__step.done {
            border-color: rgba(var(--color-success-rgb), 0.35);
        }

        .setup__marker {
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            background: var(--bg-inset);
            color: var(--color-primary);
        }

        .setup__step.done .setup__marker {
            background: rgba(var(--color-success-rgb), 0.16);
            color: var(--color-success);
        }

        .setup__body h3 {
            margin: 0;
            font-size: var(--font-md);
        }

        .setup__hint {
            font-size: var(--font-sm);
            color: var(--text-muted);
        }

        .setup__body p {
            margin: 2px 0 0;
            font-size: var(--font-sm);
            color: var(--text-secondary);
        }

        .setup__ready {
            display: flex;
            align-items: center;
            gap: var(--space-lg);
            flex-wrap: wrap;
            margin-top: var(--space-xl);
            padding-top: var(--space-xl);
            border-top: 1px solid var(--border-subtle);
        }

        .setup__ready span {
            font-size: var(--font-sm);
            color: var(--text-muted);
        }

        @media (max-width: 640px) {
            .setup__head { flex-direction: column; }
            .setup__step {
                grid-template-columns: 36px minmax(0, 1fr);
            }
            .setup__step .btn {
                grid-column: 2;
                justify-self: start;
            }
        }
    `]
})
export class SetupChecklistComponent {
    @Input() hasSource = false;
    @Input() hasChannels = false;
    @Input() hasPrograms = false;
    @Input() hasWatched = false;

    @Output() runSync = new EventEmitter<void>();

    get allDone(): boolean {
        return this.hasSource && this.hasChannels && this.hasPrograms;
    }

    get doneCount(): number {
        return [this.hasSource, this.hasChannels && this.hasPrograms, this.hasChannels]
            .filter(Boolean).length;
    }
}
