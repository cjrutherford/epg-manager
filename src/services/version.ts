/**
 * One version, written in four places.
 *
 * The root package says 0.1.0, the client package says 0.0.0 and the Android
 * manifest says 1.0 — three answers to "which build is this?", which makes a
 * bug report from a user impossible to place. A release has to set all of them
 * from a single input, and a tag has to be checked against them before anything
 * is published under that name.
 *
 * Kept pure so the arithmetic and the rewriting rules are tested rather than
 * discovered during a release.
 */

export type ReleaseKind = 'major' | 'minor' | 'patch';

export interface SemVer {
    major: number;
    minor: number;
    patch: number;
    /** `-beta.1` and similar, without the leading dash. */
    prerelease?: string;
}

/** Parse `1.2.3` or `1.2.3-beta.1`, with or without a leading `v`. */
export function parseVersion(value: string): SemVer | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || '').trim());
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4]
    };
}

export function formatVersion(version: SemVer): string {
    const base = `${version.major}.${version.minor}.${version.patch}`;
    return version.prerelease ? `${base}-${version.prerelease}` : base;
}

/**
 * Next version for a release kind.
 *
 * A prerelease is dropped rather than incremented: `1.2.3-beta.1` becoming
 * final is `1.2.3`, not `1.2.4`.
 */
export function bumpVersion(current: SemVer, kind: ReleaseKind): SemVer {
    if (current.prerelease) {
        return { major: current.major, minor: current.minor, patch: current.patch };
    }
    switch (kind) {
        case 'major': return { major: current.major + 1, minor: 0, patch: 0 };
        case 'minor': return { major: current.major, minor: current.minor + 1, patch: 0 };
        case 'patch': return { major: current.major, minor: current.minor, patch: current.patch + 1 };
    }
}

/**
 * Android needs a monotonically increasing integer, and Play refuses an upload
 * whose code is not higher than the last. Deriving it from the version keeps
 * the two from drifting: 1.2.3 becomes 10203.
 */
export function androidVersionCode(version: SemVer): number {
    if (version.minor > 99 || version.patch > 99) {
        throw new Error(
            `Cannot derive an Android version code from ${formatVersion(version)}: ` +
            'minor and patch must each stay under 100.'
        );
    }
    return version.major * 10000 + version.minor * 100 + version.patch;
}

/** Set `"version"` in a package.json without disturbing anything else. */
export function setPackageVersion(json: string, version: string): string {
    if (!/"version"\s*:\s*"[^"]*"/.test(json)) {
        throw new Error('package.json has no "version" field to set');
    }
    return json.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`);
}

/** Set `versionName` and `versionCode` in an Android build.gradle. */
export function setGradleVersion(gradle: string, version: SemVer): string {
    if (!/versionName\s+"[^"]*"/.test(gradle)) {
        throw new Error('build.gradle has no versionName to set');
    }
    if (!/versionCode\s+\d+/.test(gradle)) {
        throw new Error('build.gradle has no versionCode to set');
    }
    return gradle
        .replace(/versionName\s+"[^"]*"/, `versionName "${formatVersion(version)}"`)
        .replace(/versionCode\s+\d+/, `versionCode ${androidVersionCode(version)}`);
}

/** Read the version out of a package.json. */
export function readPackageVersion(json: string): string | null {
    const match = /"version"\s*:\s*"([^"]*)"/.exec(json);
    return match ? match[1] : null;
}

export interface VersionCheck {
    ok: boolean;
    problems: string[];
}

/**
 * Does every file agree, and does the tag agree with them?
 *
 * Run before publishing: a release tagged v1.4.0 that ships a binary reporting
 * 0.1.0 is worse than no version at all, because it is believed.
 */
export function checkVersionsAgree(
    tag: string,
    files: { name: string; version: string | null }[]
): VersionCheck {
    const problems: string[] = [];

    const expected = parseVersion(tag);
    if (!expected) {
        return { ok: false, problems: [`"${tag}" is not a version tag like v1.2.3`] };
    }
    const wanted = formatVersion(expected);

    for (const file of files) {
        if (file.version === null) {
            problems.push(`${file.name} has no version field`);
        } else if (file.version !== wanted) {
            problems.push(`${file.name} says ${file.version}, tag says ${wanted}`);
        }
    }

    return { ok: problems.length === 0, problems };
}
