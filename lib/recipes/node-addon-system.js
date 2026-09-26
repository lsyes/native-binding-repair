/**
 * `@deepseek-ai/node-addon-system`-specific knowledge.
 *
 * The entry package is pure JavaScript plus two optional dependencies: the
 * platform package for the host
 * (`@deepseek-ai/node-addon-system-<platform>-<arch>`) carries a Landlock
 * launcher executable and a Node-API `flock` binding. Only darwin-arm64,
 * darwin-x64, linux-x64 and linux-arm64 are published, so every other Linux
 * architecture -- loong64 among them -- resolves nothing and `flock.js` dies
 * inside `require.resolve`:
 *
 *   Cannot find module '@deepseek-ai/node-addon-system-linux-loong64/package.json'
 *
 * That is not a bug in the consumer: the platform package never existed. The
 * entry package ships both C sources, so the missing package can be built
 * locally and dropped at the exact path the entry package resolves.
 *
 * Layout the loader expects, from `lib/flock.js` and `lib/index.js`:
 *
 *   node_modules/@deepseek-ai/node-addon-system-<platform>-<arch>/
 *     package.json          <- must resolve; `flock.js` starts from here
 *     bin/system.node       <- macOS
 *     bin/glibc/system.node <- Linux, glibc (chosen from the Node report)
 *     bin/musl/system.node  <- Linux, musl
 *     bin/landlock-run      <- Linux launcher, spawned by name
 *
 * `flock.js` picks the libc subdirectory from `process.report`, not from the
 * host, so on Linux only the subdirectory matching the running Node is ever
 * used.
 */

import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

/** The package whose platform optional dependency goes missing. */
export const NODE_ADDON_SYSTEM_PACKAGE = '@deepseek-ai/node-addon-system';

/** Filename of the compiled `flock` binding inside a platform package. */
export const FLOCK_BINDING_NAME = 'system.node';

/** Filename of the Landlock launcher inside a platform package. */
export const LANDLOCK_LAUNCHER_NAME = 'landlock-run';

/** Platforms the 0.1.x entry package declares as optionalDependencies. */
export const NODE_ADDON_SYSTEM_PREBUILT = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
]);

/**
 * The optional dependency name for a runtime, e.g.
 * `@deepseek-ai/node-addon-system-linux-loong64`.
 * @param {string} platform - runtime pair such as `linux-loong64`
 * @returns {string}
 */
export function nodeAddonSystemPlatformPackage(platform) {
  return `${NODE_ADDON_SYSTEM_PACKAGE}-${platform}`;
}

/**
 * The platform/arch pair the entry package builds its optional dependency name
 * from. This is `process.platform`/`process.arch` verbatim: the entry package
 * does not use the libc-qualified npm suffix, so a loong64 host looks for
 * `linux-loong64` and not `linux-loong64-gnu`.
 * @param {{ platform: string, arch: string }} [runtime]
 * @returns {string}
 */
export function nodeAddonSystemPlatform(runtime = process) {
  return `${runtime.platform}-${runtime.arch}`;
}

/**
 * The installed directory of the platform package for a runtime.
 *
 * npm installs the platform optional dependency as a *sibling* of the entry
 * package inside the same `node_modules/@deepseek-ai/` directory, which is also
 * where Node's resolver finds it, so the repair has to write beside the entry
 * package rather than inside it.
 * @param {string} entryPackageDir - directory of `@deepseek-ai/node-addon-system`
 * @param {string} [platform] - runtime pair such as `linux-loong64`
 * @returns {string}
 */
export function nodeAddonSystemPlatformPackageDir(entryPackageDir, platform = nodeAddonSystemPlatform()) {
  return path.join(path.dirname(entryPackageDir), baseNameOf(nodeAddonSystemPlatformPackage(platform)));
}

/**
 * The on-disk directory name of a package: npm strips the scope, because the
 * scope is already the containing directory.
 * @param {string} packageName
 * @returns {string}
 */
function baseNameOf(packageName) {
  const parts = packageName.split('/');
  return parts[parts.length - 1];
}

/**
 * Whether DeepSeek publishes a prebuilt platform package for a runtime.
 * Everything outside this set has to be built locally.
 * @param {string} platform
 * @returns {boolean}
 */
export function isNodeAddonSystemPrebuilt(platform) {
  return NODE_ADDON_SYSTEM_PREBUILT.has(platform);
}

/**
 * Where the `flock` binding has to land for one libc.
 * @param {string} platformPackageDir
 * @param {'glibc' | 'musl'} libc
 * @returns {string}
 */
export function flockBindingPath(platformPackageDir, libc) {
  return path.join(platformPackageDir, 'bin', libc, FLOCK_BINDING_NAME);
}

/**
 * Where the Landlock launcher has to land. The entry package spawns it by
 * absolute path, so it has exactly one location and must be executable.
 * @param {string} platformPackageDir
 * @returns {string}
 */
export function landlockLauncherPath(platformPackageDir) {
  return path.join(platformPackageDir, 'bin', LANDLOCK_LAUNCHER_NAME);
}

/**
 * Every file a repair writes into the platform package, so callers can report
 * and verify them together.
 * @param {string} platformPackageDir
 * @param {'glibc' | 'musl'} libc
 * @returns {string[]}
 */
export function nodeAddonSystemBindingPaths(platformPackageDir, libc) {
  return [
    path.join(platformPackageDir, 'package.json'),
    flockBindingPath(platformPackageDir, libc),
    landlockLauncherPath(platformPackageDir),
  ];
}

/**
 * Check the package the way its own loader does.
 *
 * Resolving the binding directly would hide the most common failure — a
 * platform package that was never written — because the repair's own file
 * layout is what the real loader has to find. So this walks the loader's exact
 * path: resolve `<platform-package>/package.json` from inside the entry
 * package, then load the binding from the libc subdirectory the loader picks
 * out of the Node report.
 * @param {string} entryPackageDir
 * @param {{ libc?: 'glibc' | 'musl' }} [options]
 * @returns {{ ok: boolean, summary?: string, error?: Error }}
 */
export function probeNodeAddonSystem(entryPackageDir, options = {}) {
  const libc = options.libc ?? reportLibc();
  const platform = nodeAddonSystemPlatform();
  const platformPackage = nodeAddonSystemPlatformPackage(platform);
  let manifest;
  try {
    // `createRequire` from the entry package is what makes this faithful: it
    // uses the loader's own resolution roots, not the repair tool's.
    const req = createRequire(path.join(entryPackageDir, 'lib', 'flock.js'));
    manifest = req.resolve(`${platformPackage}/package.json`);
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error) };
  }
  const binding = path.join(path.dirname(manifest), 'bin', libc, FLOCK_BINDING_NAME);
  if (!fs.existsSync(binding)) {
    return {
      ok: false,
      error: new Error(`platform package ${platformPackage} is installed but ${binding} is missing`),
    };
  }
  try {
    const req = createRequire(path.join(entryPackageDir, 'lib', 'flock.js'));
    const loaded = req(binding);
    if (typeof loaded?.tryLock !== 'function') {
      return { ok: false, error: new Error(`${binding} does not export tryLock`) };
    }
    const launcher = landlockLauncherPath(path.dirname(manifest));
    return {
      ok: true,
      summary: `flock binding at ${path.relative(entryPackageDir, binding)}`
        + (fs.existsSync(launcher) ? ', Landlock launcher present' : ' (no Landlock launcher)'),
    };
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error) };
  }
}

/**
 * The libc the entry package's loader would select.
 *
 * `lib/flock.js` reads `process.report.getReport().header.glibcVersionRuntime`
 * and treats its absence as musl, which is a property of the running Node
 * rather than of the host, so this mirrors it instead of probing the filesystem.
 * @returns {'glibc' | 'musl'}
 */
export function reportLibc() {
  try {
    const report = process.report?.getReport?.();
    return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
  } catch {
    return 'glibc';
  }
}

/**
 * The manifest for the locally built platform package.
 *
 * `flock.js` calls `require.resolve(pkg + '/package.json')`, so this file has
 * to exist; the binary location is derived from the file's own directory, so
 * nothing else in it is read. `os`/`cpu` are declared the way npm would for a
 * real platform package, which keeps a copied tree honest about where it may be
 * installed.
 * @param {{ platform: string, arch: string, version: string }} options
 * @returns {Record<string, unknown>}
 */
export function nodeAddonSystemManifest(options) {
  const { platform, arch, version } = options;
  const runtime = `${platform}-${arch}`;
  const manifest = {
    name: nodeAddonSystemPlatformPackage(runtime),
    version,
    description: `Locally built system primitives (flock binding, Landlock launcher) for ${runtime}.`,
    os: [platform],
    cpu: [arch],
    files: ['bin'],
    license: 'BSD-3-Clause',
  };
  if (platform === 'linux') manifest.libc = ['glibc', 'musl'];
  return manifest;
}

export default {
  FLOCK_BINDING_NAME,
  LANDLOCK_LAUNCHER_NAME,
  NODE_ADDON_SYSTEM_PACKAGE,
  NODE_ADDON_SYSTEM_PREBUILT,
  flockBindingPath,
  isNodeAddonSystemPrebuilt,
  landlockLauncherPath,
  nodeAddonSystemBindingPaths,
  nodeAddonSystemManifest,
  nodeAddonSystemPlatform,
  nodeAddonSystemPlatformPackage,
  nodeAddonSystemPlatformPackageDir,
  probeNodeAddonSystem,
  reportLibc,
};
