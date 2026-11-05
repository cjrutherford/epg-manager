import { EN } from '../../i18n/messages.en';
import { AR } from '../../i18n/messages.ar';

describe('UI locale catalogues', () => {
    it('covers the shell, first run and navigation in both languages', () => {
        const keys = [
            'login.signIn', 'nav.dashboard', 'nav.sources', 'nav.settings',
            'setup.title', 'setup.readyTitle', 'setup.watchCta'
        ];
        for (const key of keys) {
            expect(EN[key]).toBeTruthy();
            expect(AR[key]).toBeTruthy();
        }
    });

    it('keeps placeholders aligned between languages', () => {
        const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
        for (const key of Object.keys(EN)) {
            if (!AR[key]) continue;
            expect(placeholders(AR[key])).toEqual(placeholders(EN[key]));
        }
    });
});
