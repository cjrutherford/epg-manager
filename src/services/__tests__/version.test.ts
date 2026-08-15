import {
    androidVersionCode,
    bumpVersion,
    checkVersionsAgree,
    formatVersion,
    parseVersion,
    readPackageVersion,
    setGradleVersion,
    setPackageVersion
} from '../version';

describe('parseVersion', () => {
    it('reads a plain version', () => {
        expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
    });

    it('tolerates the tag prefix', () => {
        expect(parseVersion('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    });

    it('keeps a prerelease', () => {
        expect(parseVersion('1.2.3-beta.1')?.prerelease).toBe('beta.1');
    });

    it('refuses anything else rather than guessing', () => {
        for (const bad of ['', '1.2', 'v1', 'latest', '1.2.3.4', 'one.two.three']) {
            expect(parseVersion(bad)).toBeNull();
        }
    });
});

describe('bumpVersion', () => {
    const v = parseVersion('1.4.7')!;

    it('resets the fields below the one it raises', () => {
        expect(formatVersion(bumpVersion(v, 'major'))).toBe('2.0.0');
        expect(formatVersion(bumpVersion(v, 'minor'))).toBe('1.5.0');
        expect(formatVersion(bumpVersion(v, 'patch'))).toBe('1.4.8');
    });

    it('promotes a prerelease to the release it was leading up to', () => {
        const beta = parseVersion('2.0.0-beta.3')!;
        expect(formatVersion(bumpVersion(beta, 'patch'))).toBe('2.0.0');
        expect(formatVersion(bumpVersion(beta, 'major'))).toBe('2.0.0');
    });
});

describe('androidVersionCode', () => {
    it('increases with the version, which is what Play requires', () => {
        const codes = ['0.1.0', '0.1.1', '0.2.0', '1.0.0', '1.0.1']
            .map(v => androidVersionCode(parseVersion(v)!));
        const sorted = [...codes].sort((a, b) => a - b);
        expect(codes).toEqual(sorted);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('encodes the version legibly', () => {
        expect(androidVersionCode(parseVersion('1.2.3')!)).toBe(10203);
        expect(androidVersionCode(parseVersion('0.1.0')!)).toBe(100);
    });

    it('refuses a version it cannot encode, rather than colliding silently', () => {
        expect(() => androidVersionCode(parseVersion('1.100.0')!)).toThrow(/under 100/);
        expect(() => androidVersionCode(parseVersion('1.0.100')!)).toThrow(/under 100/);
    });
});

describe('setPackageVersion', () => {
    it('sets the version and leaves the rest alone', () => {
        const json = '{\n  "name": "thing",\n  "version": "0.1.0",\n  "scripts": {}\n}';
        const updated = setPackageVersion(json, '1.2.3');
        expect(updated).toContain('"version": "1.2.3"');
        expect(updated).toContain('"name": "thing"');
        expect(readPackageVersion(updated)).toBe('1.2.3');
    });

    it('does not touch a version inside a dependency', () => {
        const json = '{\n  "version": "0.1.0",\n  "dependencies": { "x": "1.0.0" }\n}';
        expect(setPackageVersion(json, '2.0.0')).toContain('"x": "1.0.0"');
    });

    it('fails loudly when there is nothing to set', () => {
        expect(() => setPackageVersion('{}', '1.0.0')).toThrow(/no "version" field/);
    });
});

describe('setGradleVersion', () => {
    const gradle = `
android {
    defaultConfig {
        applicationId "net.example.app"
        versionCode 1
        versionName "1.0"
    }
}`;

    it('sets both fields from one version', () => {
        const updated = setGradleVersion(gradle, parseVersion('1.2.3')!);
        expect(updated).toContain('versionName "1.2.3"');
        expect(updated).toContain('versionCode 10203');
    });

    it('leaves the application id alone', () => {
        expect(setGradleVersion(gradle, parseVersion('1.2.3')!))
            .toContain('applicationId "net.example.app"');
    });

    it('fails loudly on a file it does not recognise', () => {
        expect(() => setGradleVersion('android {}', parseVersion('1.0.0')!)).toThrow(/versionName/);
    });
});

describe('checkVersionsAgree', () => {
    it('passes when everything matches the tag', () => {
        const result = checkVersionsAgree('v1.2.3', [
            { name: 'package.json', version: '1.2.3' },
            { name: 'client/package.json', version: '1.2.3' }
        ]);
        expect(result).toEqual({ ok: true, problems: [] });
    });

    it('names every file that disagrees, not just the first', () => {
        const result = checkVersionsAgree('v1.2.3', [
            { name: 'package.json', version: '0.1.0' },
            { name: 'client/package.json', version: '0.0.0' }
        ]);
        expect(result.ok).toBe(false);
        expect(result.problems).toHaveLength(2);
        expect(result.problems[0]).toContain('package.json says 0.1.0, tag says 1.2.3');
    });

    it('reports a missing version field', () => {
        const result = checkVersionsAgree('v1.0.0', [{ name: 'client/package.json', version: null }]);
        expect(result.problems[0]).toContain('no version field');
    });

    it('rejects a tag that is not a version', () => {
        expect(checkVersionsAgree('nightly', []).ok).toBe(false);
    });

    it('accepts the tag with or without its prefix', () => {
        expect(checkVersionsAgree('1.2.3', [{ name: 'p', version: '1.2.3' }]).ok).toBe(true);
    });
});
