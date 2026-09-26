/**
 * Preload entry point (`node --require native-binding-repair/preload app.js`).
 *
 * Runs before the host application's first line, so a broken binding is
 * repaired before anything tries to load it. This is the "set it and forget it"
 * path: it costs a directory existence check when everything is healthy, and it
 * never throws into the host process.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { repairPackage, probePackage, probeFor } from './repair.js';
import { hasVendoredBinding, resolvePackageDir } from './strategies.js';
import { createLogger } from './log.js';

/**
 * Packages to pre-check. Only packages with a cheap offline repair path are
 * listed, so preloading never triggers a build or a network call.
 *
 * `@vscode/ripgrep` belongs here even though it is not a native addon: DSH
 * loads it lazily at the first grep, so a broken one does not stop the process
 * from starting -- it stops the search tools from working, which is harder to
 * notice and to attribute.
 */
const WATCHED = ['sharp', '@vscode/ripgrep'];

/**
 * Probe a package with the health check its own loader would use.
 * @param {string} packageDir
 * @param {string} packageName
 * @returns {{ ok: boolean }}
 */
function probe(packageDir, packageName) {
  // Non-addon packages resolve a platform package and spawn a binary; asking
  // `probeFor` keeps the preload honest about what "healthy" means for them.
  const version = readVersion(packageDir) ?? '0.0.0';
  return packageName === 'sharp'
    ? probePackage(packageDir, packageName)
    : probeFor(packageDir, packageName, version);
}

/**
 * Read a package version without importing it.
 * @param {string} packageDir
 * @returns {string | undefined}
 */
function readVersion(packageDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function main() {
  if (process.env.NBR_DISABLE === '1') return;
  const verbose = process.env.NBR_VERBOSE === '1';
  // Stay silent unless asked to explain itself: a preload must not decorate
  // the host application's output during normal operation.
  const logger = createLogger({ verbose: false, quiet: true });

  for (const packageName of WATCHED) {
    if (!hasVendoredBinding(packageName)) continue;
    let packageDir;
    try {
      packageDir = resolvePackageDir(packageName, process.cwd());
    } catch {
      continue;
    }
    if (!packageDir) continue;

    // Fast path: the binding is already in place, so do nothing at all.
    const result = probe(packageDir, packageName);
    if (result.ok) continue;

    try {
      const report = repairPackage({ packageName, packageDir, quietProbe: true, logger });
      if (report.outcome === 'repaired' && verbose) {
        process.stderr.write(`nbr: repaired ${packageName} native binding\n`);
      }
    } catch (error) {
      if (verbose) process.stderr.write(`nbr: repair attempt failed: ${error.message}\n`);
    }
  }
}

try {
  main();
} catch {
  // A preload must never be the reason an application fails to start.
}

export {};
