/**
 * Vendored prebuild registry.
 *
 * Layout on disk:
 *   vendor/<package>/<version>/<platform>/<binary>
 *
 * The version directory exists so a vendored binary can never be copied into a
 * package whose ABI it does not match; the caller asks for a version and gets
 * either an exact hit or nothing.
 *
 * Not every vendored binary is a Node addon. `@vscode/ripgrep` resolves a
 * platform package that carries a plain executable, so the registry indexes
 * both `.node` addons and the `rg`/`rg.exe` executables; each entry records
 * whether it expects to be loaded with `require` or spawned.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { sharpPlatform } from './runtime.js';

const require = createRequire(import.meta.url);
const vendorRoot = path.resolve(path.dirname(require.resolve('../package.json')), 'vendor');

/**
 * @typedef {object} VendorEntry
 * @property {string} package
 * @property {string} version
 * @property {string} platform
 * @property {string} file
 * @property {string} path
 * @property {'addon' | 'executable'} kind - how the consumer uses the file
 */

/**
 * Filenames the registry indexes besides `.node` addons.
 *
 * `rg`/`rg.exe` are the executables `@vscode/ripgrep` spawns. `landlock-run`
 * is not listed: it is a companion of the `system.node` addon and travels with
 * it through the node-addon-system recipe instead.
 */
const EXECUTABLE_NAMES = new Set(['rg', 'rg.exe']);

/**
 * Every vendored prebuild this installation can offer.
 * @returns {VendorEntry[]}
 */
export function listVendored() {
  const entries = [];
  if (!fs.existsSync(vendorRoot)) return entries;
  for (const { name: packageName, dir: packageDir } of packageDirs()) {
    for (const version of readdirSafe(packageDir)) {
      const versionDir = path.join(packageDir, version);
      if (!isDir(versionDir)) continue;
      for (const platform of readdirSafe(versionDir)) {
        const platformDir = path.join(versionDir, platform);
        if (!isDir(platformDir)) continue;
        for (const file of readdirSafe(platformDir)) {
          const kind = file.endsWith('.node') ? 'addon' : EXECUTABLE_NAMES.has(file) ? 'executable' : undefined;
          if (!kind) continue;
          entries.push({
            package: packageName,
            version,
            platform,
            file,
            path: path.join(platformDir, file),
            kind,
          });
        }
      }
    }
  }
  return entries;
}

/**
 * Every vendored package directory, expanding npm scopes so a scoped package
 * is stored under its real published name rather than an escaped alias.
 * @returns {Array<{ name: string, dir: string }>}
 */
function packageDirs() {
  const found = [];
  for (const entry of readdirSafe(vendorRoot)) {
    const dir = path.join(vendorRoot, entry);
    if (!isDir(dir)) continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirSafe(dir)) {
        const scopedDir = path.join(dir, scoped);
        if (!isDir(scopedDir)) continue;
        found.push({ name: `${entry}/${scoped}`, dir: scopedDir });
      }
      continue;
    }
    found.push({ name: entry, dir });
  }
  return found;
}

/**
 * The vendored prebuild for a package/version on the current runtime.
 * @param {string} packageName
 * @param {string} version
 * @param {{ platform?: string }} [options]
 * @returns {VendorEntry | undefined}
 */
export function lookupVendored(packageName, version, options = {}) {
  const platform = options.platform ?? sharpPlatform();
  const direct = listVendored().find(
    (entry) => entry.package === packageName && entry.version === version && entry.platform === platform,
  );
  return direct;
}

/**
 * All versions vendored for a package on the current runtime.
 * @param {string} packageName
 * @returns {string[]}
 */
export function vendoredVersions(packageName) {
  const platform = sharpPlatform();
  return [...new Set(
    listVendored()
      .filter((entry) => entry.package === packageName && entry.platform === platform)
      .map((entry) => entry.version),
  )].sort();
}

/**
 * The filename sharp itself would look for, given a version.
 * @param {string} version
 * @returns {string}
 */
export function sharpBinaryName(version) {
  return `sharp-${sharpPlatform()}-${version}.node`;
}

/**
 * readdir that yields [] instead of throwing.
 * @param {string} dir
 * @returns {string[]}
 */
function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Whether a path is a directory.
 * @param {string} target
 * @returns {boolean}
 */
function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export { vendorRoot };
export default { listVendored, lookupVendored, sharpBinaryName, vendoredVersions, vendorRoot };
