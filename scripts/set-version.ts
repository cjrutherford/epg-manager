/**
 * Write one version into every place that carries one.
 *
 *   npx ts-node scripts/set-version.ts 1.2.3     set an exact version
 *   npx ts-node scripts/set-version.ts minor     bump from the current one
 *   npx ts-node scripts/set-version.ts --check v1.2.3   verify without writing
 *
 * The `--check` form is what a release runs before publishing anything: a
 * release tagged v1.4.0 that ships a binary reporting 0.1.0 is worse than no
 * version at all, because it will be believed.
 */
import fs from 'fs';
import path from 'path';
import {
    bumpVersion, checkVersionsAgree, formatVersion, parseVersion,
    readPackageVersion, setGradleVersion, setPackageVersion,
    type ReleaseKind
} from '../src/services/version';

const root = path.resolve(__dirname, '..');
const PACKAGES = [
    path.join(root, 'package.json'),
    path.join(root, 'client/package.json')
];
const GRADLE = path.join(root, 'client/android/app/build.gradle');
const COMPOSE = path.join(root, 'docker-compose.yml');
const ENV_EXAMPLE = path.join(root, '.env.example');

const args = process.argv.slice(2);
const checking = args[0] === '--check';
const input = checking ? args[1] : args[0];

if (!input) {
    console.error('usage: set-version <major|minor|patch|X.Y.Z> | --check <tag>');
    process.exit(1);
}

const relative = (file: string) => path.relative(root, file);

if (checking) {
    const files = PACKAGES.map(file => ({
        name: relative(file),
        version: readPackageVersion(fs.readFileSync(file, 'utf8'))
    }));

    const gradle = fs.readFileSync(GRADLE, 'utf8');
    const gradleName = /versionName\s+"([^"]*)"/.exec(gradle);
    files.push({ name: relative(GRADLE), version: gradleName ? gradleName[1] : null });

    // Also check pinned compose TAG
    try {
        const compose = fs.readFileSync(COMPOSE, 'utf8');
        const m = /image:\s*ghcr\.io\/cjrutherford\/epg-manager:\$\{TAG:-(.+?)\}/.exec(compose);
        files.push({ name: relative(COMPOSE), version: m ? m[1].trim() : null });
    } catch {}
    try {
        const env = fs.readFileSync(ENV_EXAMPLE, 'utf8');
        const m2 = /^TAG=(.+)$/m.exec(env);
        files.push({ name: relative(ENV_EXAMPLE), version: m2 ? m2[1].trim() : null });
    } catch {}

    const result = checkVersionsAgree(input, files);
    if (!result.ok) {
        console.error(`Version check failed for ${input}:`);
        for (const problem of result.problems) console.error(`  - ${problem}`);
        process.exit(1);
    }
    console.log(`All versions agree with ${input}.`);
    process.exit(0);
}

const current = parseVersion(readPackageVersion(fs.readFileSync(PACKAGES[0], 'utf8')) || '0.0.0');
if (!current) {
    console.error('The root package.json does not carry a readable version.');
    process.exit(1);
}

const target = ['major', 'minor', 'patch'].includes(input)
    ? bumpVersion(current, input as ReleaseKind)
    : parseVersion(input);

if (!target) {
    console.error(`"${input}" is neither a release kind nor a version.`);
    process.exit(1);
}

const version = formatVersion(target);

for (const file of PACKAGES) {
    fs.writeFileSync(file, setPackageVersion(fs.readFileSync(file, 'utf8'), version));
    console.log(`  ${relative(file)} -> ${version}`);
}

fs.writeFileSync(GRADLE, setGradleVersion(fs.readFileSync(GRADLE, 'utf8'), target));
console.log(`  ${relative(GRADLE)} -> ${version}`);

if (fs.existsSync(COMPOSE)) {
    let compose = fs.readFileSync(COMPOSE, 'utf8');
    compose = compose.replace(
        /image:\s*ghcr\.io\/cjrutherford\/epg-manager:\$\{TAG:-.+?\}/,
        `image: ghcr.io/cjrutherford/epg-manager:\${TAG:-${version}}`
    );
    fs.writeFileSync(COMPOSE, compose);
    console.log(`  ${relative(COMPOSE)} -> ${version}`);
}
if (fs.existsSync(ENV_EXAMPLE)) {
    let env = fs.readFileSync(ENV_EXAMPLE, 'utf8');
    env = env.replace(/^TAG=.*$/m, `TAG=${version}`);
    fs.writeFileSync(ENV_EXAMPLE, env);
    console.log(`  ${relative(ENV_EXAMPLE)} -> ${version}`);
}

console.log(`\nVersion set to ${version}. Tag it with:  git tag v${version}`);
