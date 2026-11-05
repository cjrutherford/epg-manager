import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService, LocaleCode } from '../i18n/i18n.service';
import { TranslatePipe } from '../i18n/translate.pipe';

@Component({
    selector: 'app-language-menu',
    standalone: true,
    imports: [FormsModule, TranslatePipe],
    template: `
        <label class="lang-menu">
            <span class="sr-only">{{ 'nav.language' | t }}</span>
            <select class="themed-input lang-select" [ngModel]="i18n.locale" (ngModelChange)="setLocale($event)"
                [attr.aria-label]="'nav.language' | t">
                <option value="en" lang="en">English</option>
                <option value="ar" lang="ar">العربية</option>
            </select>
        </label>
    `,
})
export class LanguageMenuComponent {
    constructor(public i18n: I18nService) { }

    setLocale(locale: LocaleCode): void {
        this.i18n.setLocale(locale);
    }
}
