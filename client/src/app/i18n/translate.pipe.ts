import { Pipe, PipeTransform } from '@angular/core';
import { I18nService } from './i18n.service';

/** Impure so a locale change re-renders existing templates without a reload. */
@Pipe({ name: 't', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
    constructor(private i18n: I18nService) { }

    transform(key: string, params?: Record<string, string | number>): string {
        return this.i18n.t(key, params);
    }
}
