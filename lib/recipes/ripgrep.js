/**
 * `@vscode/ripgrep`-specific knowledge.
 *
 * The entry package is a handful of ESM lines: it builds a platform package
 * name from `process.platform`/`process.arch` and resolves
 *
 *   @vscode/ripgrep-<platform>-<arch>/bin/rg
 *
 * with `require.resolve`. The binary therefore arrives as an *optional
 * dependency*, and optionalDependencies are published for a fixed set of
 * architectures only (x64, arm64, arm, ia32, ppc64, s390x, riscv64 -- never
 * loong64). On every other host npm installs the entry package, skips the
 * platform package, and the entry package throws at import time:
 *
 *   Could not find @vscode/ripgrep-linux-loong64. Ensure optionalDependencies
 *   are installed for this platform (linux-loong64).
 *
 * This is not a broken installation: the platform package was never published.
 * The failure surfaces late, at the first search, which is why DSH's `grep` and
 * `glob` tools stop working rather than the process refusing to start.
 *
 * The repair mirrors `@deepseek-ai/node-addon-system`: the missing platform
 * package is materialised as a *sibling* of the entry package, because that is
 * the only place Node's resolver looks for it. Two files matter:
 *
 *   node_modules/@vscode/ripgrep-<platform>-<arch>/
 *     package.json    <- resolution target; without it Node reports
 *                        "Cannot find module ..." even when bin/rg exists
 *     bin/rg          <- spawned directly by the consumer
 *
 * Note that the platform package name uses the raw `process.arch` without a
 * libc suffix (`linux-loong64`, not `linux-loong64-gnu`), so the libc never
 * enters the layout.
 *
 * This variant matters in practice because DSH ships the entry package and
 * resolves it lazily inside its `grep` and `glob` tools: the process starts
 * fine and then every search fails with `SEARCH_FAILED`, which points at the
 * search tool rather than at the missing binary.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

import { tryExec } from '../runtime.js';

/** The entry package that resolves the missing platform package. */
export const VSCODE_RIPGREP_PACKAGE = '@vscode/ripgrep';

/** Filename of the binary inside a platform package. */
export const RIPGREP_BINARY_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg';

/**
 * Platforms `@vscode/ripgrep` 1.x declares as optionalDependencies. Everything
 * outside this set has to be supplied locally.
 */
export const VSCODE_RIPGREP_PREBUILT = new Set([
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
  'win32-ia32',
  'linux-x64',
  'linux-arm64',
  'linux-arm',
  'linux-ppc64',
  'linux-riscv64',
  'linux-s390x',
  'linux-ia32',
]);

/**
 * The platform/arch pair the entry package builds its optional dependency name
 * from. Read from the same source the entry package uses, including its
 * `npm_config_arch` escape hatch for cross-installs.
 * @param {{ platform: string, arch: string }} [runtime]
 * @returns {string}
 */
export function ripgrepPlatform(runtime = process) {
  const arch = process.env.npm_config_arch || runtime.arch;
  return `${runtime.platform}-${arch}`;
}

/**
 * The optional dependency name for a runtime, e.g.
 * `@vscode/ripgrep-linux-loong64`.
 * @param {string} [platform]
 * @returns {string}
 */
export function ripgrepPlatformPackage(platform = ripgrepPlatform()) {
  return `${VSCODE_RIPGREP_PACKAGE}-${platform}`;
}

/**
 * The installed directory of the platform package for a runtime.
 *
 * npm places an optional dependency as a sibling of the entry package inside
 * the same scope directory, which is also where Node's resolver finds it, so a
 * repair writes beside the entry package rather than inside it.
 * @param {string} entryPackageDir - directory of `@vscode/ripgrep`
 * @param {string} [platform]
 * @returns {string}
 */
export function ripgrepPlatformPackageDir(entryPackageDir, platform = ripgrepPlatform()) {
  return path.join(path.dirname(entryPackageDir), baseNameOf(ripgrepPlatformPackage(platform)));
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
 * Whether upstream publishes a binary package for a platform.
 * @param {string} platform
 * @returns {boolean}
 */
export function isRipgrepPrebuilt(platform) {
  return VSCODE_RIPGREP_PREBUILT.has(platform);
}

/**
 * Where the binary has to land for the entry package's `require.resolve` to
 * find it.
 * @param {string} platformPackageDir
 * @returns {string}
 */
export function ripgrepBinaryPath(platformPackageDir) {
  return path.join(platformPackageDir, 'bin', RIPGREP_BINARY_NAME);
}

/**
 * Every file a repair writes into the platform package.
 * @param {string} platformPackageDir
 * @returns {string[]}
 */
export function ripgrepPackagePaths(platformPackageDir) {
  return [
    path.join(platformPackageDir, 'package.json'),
    ripgrepBinaryPath(platformPackageDir),
  ];
}

/**
 * The manifest for the locally supplied platform package.
 *
 * `@vscode/ripgrep` resolves `<platform-package>/bin/rg`, so this file is the
 * difference between "resolvable" and "Cannot find module". Deliberately no
 * `exports` field: the consumer asks for an internal subpath, which an exports
 * map would forbid. `os` and `cpu` are declared the way npm would for a real
 * platform package, which keeps a copied tree honest about where it may be
 * installed.
 * @param {{ platform: string, arch: string, version: string }} options
 * @returns {Record<string, unknown>}
 */
export function ripgrepManifest(options) {
  const { platform, arch, version } = options;
  return {
    name: ripgrepPlatformPackage(`${platform}-${arch}`),
    version,
    description: `ripgrep binary for ${platform}-${arch}, supplied locally because @vscode/ripgrep publishes no package for it.`,
    os: [platform],
    cpu: [arch],
    files: ['bin'],
    license: 'MIT',
  };
}

/**
 * Check the package the way its own loader does.
 *
 * Resolving the binary directly would hide the most common failure -- a
 * platform package that was never written -- because the repair's own file
 * layout is what the real loader has to find. So this walks the loader's exact
 * path: `require.resolve('<platform-package>/bin/rg')` from inside the entry
 * package, then run the resolved binary, because a present file proves nothing
 * about whether it can be spawned.
 * @param {string} entryPackageDir
 * @param {{ platform?: string }} [options]
 * @returns {{ ok: boolean, summary?: string, error?: Error }}
 */
export function probeVscodeRipgrep(entryPackageDir, options = {}) {
  const platformPackage = ripgrepPlatformPackage(options.platform);
  let binary;
  try {
    // Creating the `require` from the entry package's own file is what makes
    // this faithful: it uses the loader's resolution roots, not the tool's.
    const req = createRequire(path.join(entryPackageDir, 'lib', 'index.js'));
    binary = req.resolve(`${platformPackage}/bin/${RIPGREP_BINARY_NAME}`);
  } catch (error) {
    // Report the failure in the entry package's own words rather than as a
    // bare MODULE_NOT_FOUND: that is the text a user actually sees, and it is
    // what the diagnosis patterns are written against.
    const platform = options.platform ?? ripgrepPlatform();
    return {
      ok: false,
      error: new Error(
        `Could not find ${platformPackage}. `
        + `Ensure optionalDependencies are installed for this platform (${platform}).`,
        { cause: /** @type {Error} */ (error) },
      ),
    };
  }
  if (!fs.existsSync(binary)) {
    return {
      ok: false,
      error: new Error(`${platformPackage} is resolvable but ${binary} is missing`),
    };
  }
  const version = ripgrepVersion(binary);
  if (!version) {
    return {
      ok: false,
      error: new Error(`${binary} exists but is not a runnable ripgrep binary (wrong architecture or not executable)`),
    };
  }
  return { ok: true, summary: `${version} at ${path.relative(entryPackageDir, binary)}` };
}

/**
 * The first line of `rg --version`, or undefined when the file cannot run.
 *
 * `--no-config` keeps a host `RIPGREP_CONFIG_PATH` from influencing the probe,
 * matching how the consumer spawns the binary. The environment is inherited so
 * a binary that needs a custom loader still reports its version.
 * @param {string} binary
 * @returns {string | undefined}
 */
export function ripgrepVersion(binary) {
  const output = tryExec(binary, ['--no-config', '--version']);
  const first = output?.split('\n')[0]?.trim();
  return first && /^ripgrep\s/.test(first) ? first : undefined;
}

export default {
  RIPGREP_BINARY_NAME,
  VSCODE_RIPGREP_PACKAGE,
  VSCODE_RIPGREP_PREBUILT,
  isRipgrepPrebuilt,
  probeVscodeRipgrep,
  ripgrepBinaryPath,
  ripgrepManifest,
  ripgrepPackagePaths,
  ripgrepPlatform,
  ripgrepPlatformPackage,
  ripgrepPlatformPackageDir,
  ripgrepVersion,
};
