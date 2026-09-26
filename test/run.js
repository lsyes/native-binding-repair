/**
 * Dependency-free test runner.
 *
 * Every assertion here is about behaviour that broke in the field: the exact
 * sharp failure text, the loader's filename rules, and the guarantee that a
 * repair is idempotent and never touches unrelated files.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { diagnose } from '../lib/diagnose.js';
import { listVendored, lookupVendored, sharpBinaryName } from '../lib/vendor.js';
import { linuxLibc, platformSuffix, sharpPlatform, nodeAbi } from '../lib/runtime.js';
import { sharpBindingFilename, isPrebuiltPlatform } from '../lib/recipes/sharp.js';
import { installHook, removeHook } from '../lib/hook.js';
import { createLogger } from '../lib/log.js';
import { globalModuleRoots } from '../lib/repair.js';
import {
  VSCODE_RIPGREP_PACKAGE,
  isRipgrepPrebuilt,
  ripgrepPlatform,
  ripgrepPlatformPackage,
} from '../lib/recipes/ripgrep.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const cli = path.join(packageRoot, 'bin', 'nbr.js');
const quietLogger = createLogger({ quiet: true });

let passed = 0;
let failed = 0;

/**
 * Run one named test, reporting pass/fail without stopping the suite.
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed++;
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}

/**
 * Create a scratch directory that is removed afterwards.
 * @param {string} prefix
 * @returns {string}
 */
function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/**
 * Build a throwaway `node_modules/sharp` whose binding is missing, using the
 * real sharp JavaScript from wherever this machine has it installed. Returns
 * the package directory.
 * @param {string} root
 * @returns {string}
 */
function makeFakeSharp(root) {
  const modulesDir = path.join(root, 'node_modules');
  const packageDir = path.join(modulesDir, 'sharp');
  fs.mkdirSync(packageDir, { recursive: true });
  const source = findInstalledSharp();
  if (!source) {
    // Without a real sharp on disk, a stand-in keeps the file-placement
    // assertions meaningful; the loader assertions are skipped by callers.
    fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'dist', 'index.cjs'), 'module.exports = require("../src/build/Release/sharp.js");\n');
  } else {
    for (const file of ['package.json', 'dist', 'lib', 'src']) {
      const from = path.join(source, file);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(packageDir, file), { recursive: true });
    }
    // sharp's JavaScript entry point needs its own runtime dependencies; copy
    // them alongside so the fixture is a faithful, loadable install.
    const siblings = path.dirname(source);
    for (const dependency of ['detect-libc', 'semver', '@img', 'node-addon-api']) {
      const from = path.join(siblings, dependency);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(modulesDir, dependency), { recursive: true });
    }
    // Remove any existing binding so the repair has real work to do, and strip
    // copied build artefacts that would otherwise make the tree look healthy.
    fs.rmSync(path.join(packageDir, 'src', 'build'), { recursive: true, force: true });
  }
  // Preserve the real manifest when we have one: sharp reads its own
  // `config.libvips` from here, so a synthetic manifest would break the very
  // loader these tests exercise.
  const manifestPath = path.join(packageDir, 'package.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = '0.35.4';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } else {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'sharp', version: '0.35.4', main: './dist/index.cjs' }, null, 2),
    );
  }
  return packageDir;
}

/**
 * Load sharp from a fake tree, reporting the error instead of throwing.
 * @param {string} root
 * @returns {{ ok: boolean, error?: Error, versions?: Record<string, string> }}
 */
function requireFakeSharp(root) {
  const entry = path.join(root, 'node_modules', 'sharp', 'dist', 'index.cjs');
  if (!fs.existsSync(entry)) return { ok: false, error: new Error('no sharp entry point in fixture') };
  try {
    const loaded = createRequire(entry)(entry);
    return { ok: true, versions: loaded.versions };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Build a throwaway `node_modules/@vscode/ripgrep` that has no platform
 * package, using the real entry package from wherever this machine has it.
 * Returns the scratch root.
 * @returns {string}
 */
function makeFakeRipgrep() {
  const root = scratch('nbr-rg');
  const scopeDir = path.join(root, 'node_modules', '@vscode');
  const packageDir = path.join(scopeDir, 'ripgrep');
  const source = findInstalledRipgrepEntry();
  fs.mkdirSync(packageDir, { recursive: true });
  if (source) {
    fs.cpSync(source, packageDir, { recursive: true });
  } else {
    // A stand-in with the same resolution behaviour keeps the tests meaningful
    // on machines without a real @vscode/ripgrep install.
    fs.writeFileSync(
      path.join(packageDir, 'lib', 'index.js'),
      'export const rgPath = "unresolved";\n',
      { mode: 0o644, flag: 'w' },
    );
  }
  // The platform package is what npm skipped upstream, so remove any copy the
  // fixture brought along.
  fs.rmSync(path.join(scopeDir, `ripgrep-${ripgrepPlatform()}`), { recursive: true, force: true });
  return root;
}

/**
 * Find a real `@vscode/ripgrep` entry package to copy the fixture from.
 * @returns {string | undefined}
 */
function findInstalledRipgrepEntry() {
  const probes = [
    process.env.NBR_TEST_VSCODE_RIPGREP_DIR,
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@vscode', 'ripgrep'),
  ].filter(Boolean);
  for (const candidate of probes) {
    if (candidate && fs.existsSync(path.join(candidate, 'lib', 'index.js'))) return candidate;
  }
  return undefined;
}

/**
 * Find a real sharp installation to copy fixtures from, if one exists.
 * @returns {string | undefined}
 */function findInstalledSharp() {
  const probes = [
    process.env.NBR_TEST_SHARP_DIR,
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'sharp'),
  ].filter(Boolean);
  for (const candidate of probes) {
    if (candidate && fs.existsSync(path.join(candidate, 'dist', 'index.cjs'))) return candidate;
  }
  return undefined;
}

/**
 * Block the thread for a few milliseconds so filesystem timestamps advance.
 * @param {number} ms
 */
function burnTime(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Intentional busy wait; the alternative is an async test for mtime.
  }
}

process.stdout.write(`native-binding-repair tests\nruntime: ${platformSuffix()} (sharp target ${sharpPlatform()}, ${nodeAbi()})\n\n`);

process.stdout.write('diagnosis\n');

await test('classifies the real sharp loongarch failure', () => {
  const log = `Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry attachment-local (@deepseek-ai/dsh-attachment-local): Could not load the "sharp" module using the linux-loong64 runtime
Possible solutions:
- Manually install libvips >= 8.18.6
- Add WebAssembly-based dependencies:
    npm install sharp @img/sharp-wasm32`;
  const verdict = diagnose(log);
  assert.equal(verdict.kind, 'unsupported-arch');
  assert.match(verdict.summary, /sharp/);
  assert.equal(verdict.retriable, true);
});

await test('classifies a packaged native addon without a binding', () => {
  const verdict = diagnose('ERR No usable native binding found for node-addon-require-builtin-linux-loong64-gnu (auto)');
  assert.equal(verdict.kind, 'unsupported-arch');
  assert.equal(verdict.missingPackage, 'node-addon-require-builtin-linux-loong64-gnu');
});

await test('does not claim to fix a genuinely missing shared library', () => {
  const verdict = diagnose('Error: libvips-cpp.so.42: cannot open shared object file: No such file or directory');
  assert.equal(verdict.kind, 'missing-shared-library');
  assert.equal(verdict.missingSoname, 'libvips-cpp.so.42');
  assert.equal(verdict.retriable, false);
});

await test('classifies the @vscode/ripgrep platform-package failure', () => {
  const verdict = diagnose(
    'Could not find @vscode/ripgrep-linux-loong64. '
    + 'Ensure optionalDependencies are installed for this platform (linux-loong64).',
  );
  assert.equal(verdict.kind, 'unsupported-arch');
  assert.equal(verdict.missingPackage, '@vscode/ripgrep-linux-loong64');
  assert.equal(verdict.retriable, true);
});

await test('classifies a ripgrep failure on a published platform as a skipped optional dep', () => {
  const verdict = diagnose(
    'Could not find @vscode/ripgrep-linux-x64. '
    + 'Ensure optionalDependencies are installed for this platform (linux-x64).',
  );
  assert.equal(verdict.kind, 'missing-prebuild');
  assert.equal(verdict.retriable, true);
});

await test('walks nested causes to find the root failure', () => {
  const inner = new Error('Could not load the "sharp" module using the linux-loong64 runtime');
  const middle = new Error('failed to import loader entry attachment-local', { cause: inner });
  const outer = new Error('plugin tree failed to load', { cause: middle });
  assert.equal(diagnose(outer).kind, 'unsupported-arch');
});

await test('reports unknown for unrelated errors', () => {
  const verdict = diagnose('TypeError: Cannot read properties of undefined');
  assert.equal(verdict.kind, 'unknown');
  assert.equal(verdict.retriable, false);
});

await test('detects an ABI mismatch', () => {
  const verdict = diagnose('Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 137.');
  assert.equal(verdict.kind, 'abi-mismatch');
});

process.stdout.write('\nruntime and recipes\n');

await test('detects glibc without spawning a compiler', () => {
  if (process.platform !== 'linux') return;
  assert.equal(linuxLibc(), 'glibc');
});

await test('sharp binding filename matches the loader convention', () => {
  assert.equal(sharpBindingFilename('0.35.4', 'linux-loong64'), 'sharp-linux-loong64-0.35.4.node');
  assert.equal(sharpBinaryName('0.35.4'), `sharp-${sharpPlatform()}-0.35.4.node`);
});

await test('knows which platforms sharp ships prebuilds for', () => {
  assert.equal(isPrebuiltPlatform('linux-x64'), true);
  assert.equal(isPrebuiltPlatform('linux-loong64'), false);
});

process.stdout.write('\nvendored registry\n');

await test('lists the bundled loongarch binding', () => {
  const entries = listVendored();
  assert.ok(entries.length > 0, 'expected at least one vendored binding');
  // Addons and executables are both indexed, and each says which it is, so a
  // caller never tries to `require` a spawnable binary.
  assert.ok(entries.every((entry) => entry.kind === 'addon' || entry.kind === 'executable'));
  assert.ok(entries.some((entry) => entry.kind === 'addon' && entry.path.endsWith('.node')));
  assert.ok(entries.every((entry) => entry.kind !== 'addon' || entry.path.endsWith('.node')));
});

await test('looks up a vendored binding by version', () => {
  const entry = lookupVendored('sharp', '0.35.4');
  if (sharpPlatform() !== 'linux-loong64') return; // the bundle is arch-specific
  assert.ok(entry, 'expected a vendored sharp 0.35.4 for this platform');
  assert.equal(entry.file, `sharp-${sharpPlatform()}-0.35.4.node`);
});

await test('refuses to hand out a binding for the wrong version', () => {
  assert.equal(lookupVendored('sharp', '9.9.9'), undefined);
});

process.stdout.write('\nripgrep\n');

await test('knows @vscode/ripgrep ships no binary for this architecture', () => {
  assert.equal(isRipgrepPrebuilt(ripgrepPlatform()), false);
  assert.equal(isRipgrepPrebuilt('linux-x64'), true);
  assert.equal(ripgrepPlatformPackage('linux-loong64'), '@vscode/ripgrep-linux-loong64');
});

await test('indexes the vendored rg as an executable, not an addon', () => {
  const entry = listVendored().find((candidate) => candidate.package === VSCODE_RIPGREP_PACKAGE);
  if (ripgrepPlatform() !== 'linux-loong64') return; // the bundle is arch-specific
  assert.ok(entry, 'expected a vendored rg for this platform');
  assert.equal(entry.kind, 'executable');
  assert.equal(entry.file, 'rg');
  assert.equal(entry.version, '1.18.0');
});

await test('repairs a @vscode/ripgrep install whose platform package was skipped', () => {
  const entry = lookupVendored(VSCODE_RIPGREP_PACKAGE, '1.18.0');
  if (!entry) return; // only meaningful where a vendored rg exists
  const root = makeFakeRipgrep();
  const platformDir = path.join(root, 'node_modules', '@vscode', 'ripgrep-linux-loong64');
  assert.equal(fs.existsSync(platformDir), false);

  runCli(['repair', VSCODE_RIPGREP_PACKAGE, '--cwd', root]);

  const binary = path.join(platformDir, 'bin', 'rg');
  assert.equal(fs.existsSync(binary), true, 'platform package binary should be installed');
  assert.equal(fs.existsSync(path.join(platformDir, 'package.json')), true, 'the package must be resolvable');
  assert.equal(fs.statSync(binary).mode & 0o777, 0o755, 'rg should be executable');

  // The repaired tree must now resolve and run the way the consumer does.
  const req = createRequire(path.join(root, 'node_modules', '@vscode', 'ripgrep', 'lib', 'index.js'));
  const resolved = req.resolve(`${ripgrepPlatformPackage()}/bin/rg`);
  assert.equal(resolved, binary);
  const version = execFileSync(resolved, ['--no-config', '--version'], { encoding: 'utf8' });
  assert.match(version, /^ripgrep /);
  fs.rmSync(root, { recursive: true, force: true });
});

await test('ripgrep repair is idempotent', () => {
  const entry = lookupVendored(VSCODE_RIPGREP_PACKAGE, '1.18.0');
  if (!entry) return;
  const root = makeFakeRipgrep();
  runCli(['repair', VSCODE_RIPGREP_PACKAGE, '--cwd', root]);
  const binary = path.join(root, 'node_modules', '@vscode', 'ripgrep-linux-loong64', 'bin', 'rg');
  const first = fs.statSync(binary).mtimeMs;
  burnTime(20);
  runCli(['repair', VSCODE_RIPGREP_PACKAGE, '--cwd', root]);
  assert.equal(fs.statSync(binary).mtimeMs, first, 'a healthy tree should not be rewritten');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('doctor exits non-zero for a ripgrep install missing its binary', () => {
  const entry = lookupVendored(VSCODE_RIPGREP_PACKAGE, '1.18.0');
  if (!entry) return;
  const root = makeFakeRipgrep();
  const { status } = runCliResult(['doctor', VSCODE_RIPGREP_PACKAGE, '--cwd', root]);
  assert.equal(status, 1, 'doctor should signal a broken search tool');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('doctor treats an unrunnable ripgrep binary as broken', () => {
  const entry = lookupVendored(VSCODE_RIPGREP_PACKAGE, '1.18.0');
  if (!entry) return;
  const root = makeFakeRipgrep();
  const platformDir = path.join(root, 'node_modules', '@vscode', 'ripgrep-linux-loong64');
  fs.mkdirSync(path.join(platformDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(platformDir, 'package.json'), JSON.stringify({ name: '@vscode/ripgrep-linux-loong64', version: '1.18.0' }));
  // Present, resolvable and executable, but not a program: exactly the shape a
  // truncated download or a wrong-architecture copy leaves behind.
  fs.writeFileSync(path.join(platformDir, 'bin', 'rg'), 'not an executable\n', { mode: 0o755 });
  const { status } = runCliResult(['doctor', VSCODE_RIPGREP_PACKAGE, '--cwd', root]);
  assert.equal(status, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

await test('preload repairs a broken ripgrep before the application starts', () => {
  const entry = lookupVendored(VSCODE_RIPGREP_PACKAGE, '1.18.0');
  if (!entry) return;
  const root = makeFakeRipgrep();
  const preload = path.join(packageRoot, 'lib', 'preload.js');
  const probe = `import('@vscode/ripgrep').then(m => console.log('RGPATH', m.rgPath))`;
  const { status, stdout } = runCliResult(
    ['run', '--cwd', root, '--', process.execPath, '--require', preload, '--input-type=module', '-e', probe],
  );
  assert.equal(status, 0, 'the preload should have repaired the platform package first');
  assert.match(stdout, /RGPATH .*ripgrep-linux-loong64\/bin\/rg/);
  fs.rmSync(root, { recursive: true, force: true });
});

process.stdout.write('\nrepair pipeline\n');

await test('repairs a sharp install stripped of its binding', () => {
  const entry = lookupVendored('sharp', '0.35.4');
  if (!entry) return; // only meaningful where a vendored binding exists
  const root = scratch('nbr-repair');
  const packageDir = makeFakeSharp(root);
  const releaseDir = path.join(packageDir, 'src', 'build', 'Release');
  assert.equal(fs.existsSync(path.join(releaseDir, sharpBinaryName('0.35.4'))), false);

  runCli(['repair', 'sharp', '--cwd', root]);
  assert.equal(fs.existsSync(path.join(releaseDir, sharpBinaryName('0.35.4'))), true, 'binding should be installed');
  const mode = fs.statSync(path.join(releaseDir, sharpBinaryName('0.35.4'))).mode & 0o777;
  assert.equal(mode, 0o755, 'binding should be executable');

  // The repaired tree must now survive the real loader, not just contain a file.
  const loaded = requireFakeSharp(root);
  assert.equal(loaded.ok, true, `repaired package should load: ${loaded.error?.message}`);
  fs.rmSync(root, { recursive: true, force: true });
});

await test('repair is idempotent', () => {
  const entry = lookupVendored('sharp', '0.35.4');
  if (!entry) return;
  const root = scratch('nbr-idem');
  const packageDir = makeFakeSharp(root);
  runCli(['repair', 'sharp', '--cwd', root]);
  const first = fs.statSync(path.join(packageDir, 'src', 'build', 'Release', sharpBinaryName('0.35.4'))).mtimeMs;
  // Wait long enough that a rewrite would be visible in the mtime.
  burnTime(20);
  runCli(['repair', 'sharp', '--cwd', root]);
  const second = fs.statSync(path.join(packageDir, 'src', 'build', 'Release', sharpBinaryName('0.35.4'))).mtimeMs;
  assert.equal(first, second, 'a healthy tree should not be rewritten');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('dry run changes nothing on disk', () => {
  const entry = lookupVendored('sharp', '0.35.4');
  if (!entry) return;
  const root = scratch('nbr-dry');
  const packageDir = makeFakeSharp(root);
  const { status, stdout } = runCliResult(['repair', 'sharp', '--cwd', root, '--dry-run']);
  assert.equal(status, 0, 'a plan that can be executed is a success');
  assert.match(stdout, /dry run/);
  assert.equal(fs.existsSync(path.join(packageDir, 'src', 'build')), false, 'dry run must not create directories');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('doctor exits non-zero when a binding is missing', () => {
  const entry = lookupVendored('sharp', '0.35.4');
  if (!entry) return;
  const root = scratch('nbr-doctor');
  makeFakeSharp(root);
  const { status } = runCliResult(['doctor', 'sharp', '--cwd', root]);
  assert.equal(status, 1, 'doctor should signal an unhealthy tree');
  fs.rmSync(root, { recursive: true, force: true });
});

process.stdout.write('\nauto-repair wrapper\n');

await test('run reports the wrapped command exit code unchanged', () => {
  const { status } = runCliResult(['run', '--', process.execPath, '-e', 'process.exit(7)']);
  assert.equal(status, 7);
});

await test('run streams output from the wrapped command', () => {
  const { stdout, status } = runCliResult(['run', '--', process.execPath, '-e', 'console.log("forwarded-marker")']);
  assert.equal(status, 0);
  assert.match(stdout, /forwarded-marker/);
});

await test('run repairs a broken tree and retries the command', () => {
  const entry = lookupVendored('sharp', '0.35.4');
  if (!entry) return;
  const root = scratch('nbr-run');
  makeFakeSharp(root);
  const { status, stdout } = runCliResult(
    ['run', '--cwd', root, '--', process.execPath, '-e', 'const s=require("sharp"); console.log("OK", s.versions.sharp)'],
  );
  assert.equal(status, 0, 'the retry should succeed');
  assert.match(stdout, /OK/);
  fs.rmSync(root, { recursive: true, force: true });
});

await test('preload repairs before the application starts', () => {
  const entry = lookupVendored('sharp', '0.35.4');
  if (!entry) return;
  const root = scratch('nbr-preload');
  makeFakeSharp(root);
  const preload = path.join(packageRoot, 'lib', 'preload.js');
  const { status, stdout } = runCliResult(
    ['run', '--cwd', root, '--', process.execPath, '--require', preload, '-e', 'const s=require("sharp"); console.log("PRELOADED", s.versions.sharp)'],
  );
  assert.equal(status, 0, 'the preload should have repaired the binding before require');
  assert.match(stdout, /PRELOADED/);
  fs.rmSync(root, { recursive: true, force: true });
});

process.stdout.write('\nexplain command\n');

await test('explain reads a log from stdin and names the fix', () => {
  const log = 'Error: Could not load the "sharp" module using the linux-loong64 runtime\n';
  const { status, stdout } = runCliResult(['explain', '-'], { input: log });
  assert.equal(status, 0);
  assert.match(stdout, /unsupported-arch/);
  assert.match(stdout, /nbr repair/);
});

await test('explain exits non-zero for an unrecognized log', () => {
  const { status } = runCliResult(['explain', '-'], { input: 'TypeError: nope\n' });
  assert.equal(status, 1);
});

await test('explain recommends the ripgrep repair, not the sharp one', () => {
  const log = 'Could not find @vscode/ripgrep-linux-loong64. '
    + 'Ensure optionalDependencies are installed for this platform (linux-loong64).\n';
  const { status, stdout } = runCliResult(['explain', '-'], { input: log });
  assert.equal(status, 0);
  assert.match(stdout, /nbr repair @vscode\/ripgrep/);
  assert.doesNotMatch(stdout, /libvips-dev/, 'sharp-specific advice must not be offered here');
});

process.stdout.write('\nhook lifecycle\n');

await test('hook install preserves existing scripts and remove restores them', () => {
  const root = scratch('nbr-hook');
  const manifestPath = path.join(root, 'package.json');
  const before = { name: 'x', version: '1.0.0', scripts: { dev: 'node index.js' } };
  fs.writeFileSync(manifestPath, JSON.stringify(before, null, 2));

  installHook({ cwd: root, logger: quietLogger });
  const installed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(installed.scripts.dev, 'node index.js', 'existing scripts must survive');
  assert.ok(installed.nbr?.preload, 'preload should be registered');

  const again = installHook({ cwd: root, logger: quietLogger });
  assert.equal(again.status, 'already-present', 'installing twice is a no-op');

  removeHook({ cwd: root, logger: quietLogger });
  const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(after, before, 'removal should restore the original manifest');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('hook remove is safe on a project that never installed it', () => {
  const root = scratch('nbr-hook2');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'y', version: '1.0.0' }));
  assert.equal(removeHook({ cwd: root, logger: quietLogger }).status, 'absent');
  fs.rmSync(root, { recursive: true, force: true });
});

process.stdout.write('\ncli surface\n');

await test('global module roots point at real directories', () => {
  const roots = globalModuleRoots();
  assert.ok(Array.isArray(roots));
  for (const root of roots) {
    assert.equal(fs.statSync(root).isDirectory(), true, `${root} should be a directory`);
  }
});

await test('help lists every documented command', () => {
  const { stdout, status } = runCliResult(['--help']);
  assert.equal(status, 0);
  for (const command of ['doctor', 'repair', 'run', 'hook', 'explain', 'prebuilds', 'deps']) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`), `help should mention ${command}`);
  }
});

await test('an unknown command exits 2', () => {
  assert.equal(runCliResult(['frobnicate']).status, 2);
});

await test('prebuilds --json is valid JSON describing this runtime', () => {
  const { stdout, status } = runCliResult(['prebuilds', '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.vendorTarget, sharpPlatform());
  assert.ok(Array.isArray(parsed.entries));
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

/**
 * Run the CLI, asserting a clean exit.
 * @param {string[]} args
 */
function runCli(args) {
  const result = runCliResult(args);
  assert.equal(result.status, 0, `nbr ${args.join(' ')} failed: ${result.stderr}`);
}

/**
 * Run the CLI and capture everything.
 * @param {string[]} args
 * @param {{ input?: string }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCliResult(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      input: options.input ?? '',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}
