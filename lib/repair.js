/**
 * The repair planner.
 *
 * Given a set of installed packages and a runtime, decide which strategies can
 * help, run them cheapest-first, and stop as soon as the package actually
 * loads its binding again.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createLogger } from './log.js';
import { diagnose } from './diagnose.js';
import { describeRuntime, platformSuffix, sharpPlatform, tryRequire } from './runtime.js';
import {
  applyVendoredBinding,
  buildNodeAddonSystem,
  buildFromSource,
  hasVendoredBinding,
  installPlatformOptional,
  reportSystemDependencies,
  resolvePackageDir,
  useWasmFallback,
  verifyBinding,
} from './strategies.js';
import { isPrebuiltPlatform, sharpSystemRequirements } from './recipes/sharp.js';
import { requireBuiltinBindingPath, REQUIRE_BUILTIN_BINARY_NAME } from './recipes/require-builtin.js';
import {
  NODE_ADDON_SYSTEM_PACKAGE,
  flockBindingPath,
  landlockLauncherPath,
  nodeAddonSystemPlatform,
  nodeAddonSystemPlatformPackage,
  nodeAddonSystemPlatformPackageDir,
  probeNodeAddonSystem,
  reportLibc,
} from './recipes/node-addon-system.js';
import {
  VSCODE_RIPGREP_PACKAGE,
  probeVscodeRipgrep,
  ripgrepBinaryPath,
  ripgrepPlatformPackage,
  ripgrepPlatformPackageDir,
} from './recipes/ripgrep.js';
import { sharpBinaryName } from './vendor.js';

/** Packages this tool knows how to repair. */
export const KNOWN_PACKAGES = ['sharp', 'node-addon-require-builtin', NODE_ADDON_SYSTEM_PACKAGE, VSCODE_RIPGREP_PACKAGE];

/**
 * @typedef {object} RepairOptions
 * @property {string} [packageName]
 * @property {string} [packageDir]
 * @property {string} [cwd]
 * @property {boolean} [dryRun]
 * @property {boolean} [force]
 * @property {boolean} [verbose]
 * @property {ReturnType<typeof createLogger>} [logger]
 * @property {{ skipVendor?: boolean, skipSource?: boolean, skipWasm?: boolean, skipSystemPackages?: boolean }} [skip]
 */

/**
 * @typedef {object} RepairReport
 * @property {string} packageName
 * @property {string} packageDir
 * @property {string} version
 * @property {'repaired' | 'already-working' | 'would-repair' | 'unrepaired' | 'not-installed'} outcome
 * @property {Array<import('./strategies.js').StrategyResult>} attempts
 * @property {string[]} notes
 */

/**
 * Repair one package by locating it, auditing it, and applying strategies.
 * @param {RepairOptions} options
 * @returns {RepairReport}
 */
export function repairPackage(options = {}) {
  const logger = options.logger ?? createLogger({ verbose: options.verbose });
  const packageName = options.packageName ?? 'sharp';
  const baseDir = options.cwd ?? process.cwd();
  const packageDir = options.packageDir
    ?? resolveWithGlobalFallback(packageName, baseDir);
  const attempts = [];
  const notes = [];

  if (!options.quietProbe) logger.step(`probing ${packageName} on ${describeRuntime()}`);

  if (!packageDir) {
    return {
      packageName,
      packageDir: '',
      version: '',
      outcome: 'not-installed',
      attempts,
      notes: [`${packageName} is not resolvable from ${baseDir}`],
    };
  }
  if (!options.quietProbe) logger.info(`found ${packageName} at ${packageDir}`);

  const version = readVersion(packageDir) ?? '0.0.0';
  if (!options.quietProbe) logger.info(`version ${version}, runtime target ${sharpPlatform()}`);

  const probe = probeFor(packageDir, packageName, version);
  if (probe.ok) {
    if (!options.quietProbe) logger.ok(`${packageName} already loads its native binding`);
    return { packageName, packageDir, version, outcome: 'already-working', attempts, notes };
  }
  // The binding can be healthy while the package's JavaScript entry point fails
  // for an unrelated reason (a missing pure-JS dependency, for instance). Treat
  // a loadable binding as the source of truth so repairs stay idempotent.
  const bindingProbe = probeBindingFile(packageDir, packageName, version);
  if (bindingProbe?.ok) {
    if (!options.quietProbe) logger.ok(`${packageName} native binding is present (${bindingProbe.summary})`);
    notes.push(probe.error?.message?.split('\n')[0] ?? 'package entry point did not load');
    return { packageName, packageDir, version, outcome: 'already-working', attempts, notes };
  }
  if (probe.error) {
    const verdict = diagnose(probe.error, { runtime: sharpPlatform() });
    logger.warn(`${verdict.summary}`);
    for (const line of verdict.evidence) logger.detail(line);
    notes.push(verdict.summary);
  }

  const skip = options.skip ?? {};

  if (!skip.skipSystemPackages && packageName === 'sharp') {
    const dependencyReport = reportSystemDependencies({ required: sharpSystemRequirements, logger });
    attempts.push(dependencyReport);
    if (dependencyReport.status === 'failed') {
      logger.warn(dependencyReport.detail);
      notes.push(dependencyReport.detail);
    }
  }

  if (!skip.skipVendor && hasVendoredBinding(packageName)) {
    const result = applyVendoredBinding({
      packageName,
      version,
      targetDir: packageDir,
      logger: options.quietProbe ? createLogger({ quiet: true }) : logger,
      dryRun: options.dryRun,
    });
    attempts.push(result);
  }

  if (!options.dryRun && attempts.some((attempt) => attempt.status === 'applied')) {
    // Verify at the level the strategy actually operated on. A package whose
    // loader entry point is absent from a stripped tree would otherwise be
    // misreported as unrepaired even though its binding is now correct.
    const recheck = probeBindingFile(packageDir, packageName, version) ?? probeFor(packageDir, packageName, version);
    if (recheck.ok) {
      logger.ok(`${packageName} now loads its native binding (${recheck.summary})`);
      return { packageName, packageDir, version, outcome: 'repaired', attempts, notes };
    }
    if (recheck.error) {
      logger.detail(`still failing: ${recheck.error.message.split('\n')[0]}`);
    }
  }

  if (!skip.skipWasm) {
    const wasm = useWasmFallback({ logger, packageName, sharpPackageDir: packageDir });
    attempts.push(wasm);
    if (wasm.status === 'failed') logger.warn(wasm.detail);
  }

  if (!skip.skipSource) {
    const source = packageName === NODE_ADDON_SYSTEM_PACKAGE
      ? buildNodeAddonSystem({ packageDir, logger, dryRun: options.dryRun })
      : buildFromSource({
          packageDir,
          logger,
          dryRun: options.dryRun,
          extraEnv: packageName === 'sharp' ? { SHARP_FORCE_GLOBAL_LIBVIPS: 'true' } : {},
        });
    attempts.push(source);
    if (source.status === 'failed') logger.warn(source.detail);
    if (!options.dryRun && source.status === 'applied') {
      const recheck = probeFor(packageDir, packageName, version);
      if (recheck.ok) {
        logger.ok(`${packageName} built and now loads (${recheck.summary})`);
        return { packageName, packageDir, version, outcome: 'repaired', attempts, notes };
      }
      if (recheck.error) logger.detail(`still failing: ${recheck.error.message.split('\n')[0]}`);
    }
  }

  // Only reachable when no offline strategy worked, so a registry round-trip is
  // worthwhile. Skip it outright when the platform is known to have no
  // published binary, which turns a guaranteed 404 into a clear message.
  if (!skip.skipWasm && !skip.skipSource && packageName === 'sharp' && isPrebuiltPlatform(sharpPlatform())) {
    const optional = installPlatformOptional({ packageName: '@img/sharp', packageDir, logger, dryRun: options.dryRun });
    attempts.push(optional);
  } else if (packageName === 'sharp' && !isPrebuiltPlatform(sharpPlatform()) && !skip.skipWasm) {
    notes.push(`sharp publishes no prebuilt binary for ${sharpPlatform()}`);
  }

  if (!options.dryRun && !attempts.some((attempt) => attempt.status === 'applied')) {
    logger.error(`no strategy could repair ${packageName} on ${sharpPlatform()}`);
  }

  // A dry run that found a workable strategy is a success: it means "repair
  // would fix this", which is what callers script against.
  const wouldRepair = options.dryRun && attempts.some((attempt) => attempt.status === 'applied');
  return {
    packageName,
    packageDir,
    version,
    outcome: wouldRepair ? 'would-repair' : 'unrepaired',
    attempts,
    notes,
  };
}

/**
 * Resolve a package from the target directory, then from the global module
 * roots. Globally-installed CLIs (`npm i -g dsh`) are the common case for this
 * tool's users, and they are not reachable from the project's own tree.
 * @param {string} packageName
 * @param {string} baseDir
 * @returns {string | undefined}
 */
function resolveWithGlobalFallback(packageName, baseDir) {
  const local = resolvePackageDir(packageName, baseDir);
  if (local) return local;
  for (const root of globalModuleRoots()) {
    for (const candidate of globalCandidates(root, packageName)) {
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
  }
  return undefined;
}

/**
 * Bounded set of places a globally-installed CLI may keep a dependency.
 *
 * A global install of `dsh` keeps sharp at `@deepseek-ai/dsh/node_modules/sharp`
 * rather than at the top level, and Node's resolver cannot reach it from
 * outside that package. Only the top level and one package level deep are
 * searched: deep enough for the real CLI layouts, shallow enough to stay fast
 * and predictable.
 * @param {string} root
 * @param {string} packageName
 * @returns {string[]}
 */
function globalCandidates(root, packageName) {
  const candidates = [path.join(root, packageName)];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      candidates.push(path.join(root, entry.name, packageName));
      let scoped = [];
      try {
        scoped = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scoped) {
        if (!scopedEntry.isDirectory()) continue;
        candidates.push(path.join(root, entry.name, scopedEntry.name, 'node_modules', packageName));
      }
    } else {
      candidates.push(path.join(root, entry.name, 'node_modules', packageName));
    }
  }
  return candidates;
}

/**
 * Candidate global `node_modules` directories for the running Node install.
 * @returns {string[]}
 */
export function globalModuleRoots() {
  const roots = [];
  const nodeDir = path.dirname(process.execPath);
  // nvm / system layouts both keep globals under <prefix>/lib/node_modules.
  roots.push(path.resolve(nodeDir, '..', 'lib', 'node_modules'));
  roots.push(path.resolve(nodeDir, '..', 'node_modules'));
  if (process.env.NODE_PATH) roots.push(...process.env.NODE_PATH.split(path.delimiter));
  return [...new Set(roots)].filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Load a package and report whether its native binding works.
 * @param {string} packageDir
 * @param {string} packageName
 * @returns {{ ok: boolean, summary?: string, error?: Error }}
 */
export function probePackage(packageDir, packageName = 'sharp') {
  const entryCandidates = entryPointsFor(packageName).map((relative) => path.join(packageDir, relative));
  const entry = entryCandidates.find((candidate) => fs.existsSync(candidate));
  if (!entry) {
    return { ok: false, error: new Error(`Cannot find module '${packageName}': no entry point inside ${packageDir}`) };
  }
  const result = tryRequire(entry);
  if (result.error) return { ok: false, error: result.error };
  const versions = /** @type {{ versions?: Record<string, string> }} */ (result.module).versions;
  const summary = versions?.sharp
    ? `sharp ${versions.sharp} / libvips ${versions.vips}`
    : 'module loaded';
  return { ok: true, summary };
}

/**
 * Health probe for one package: the package-specific probe when the a package
 * resolves its binding through something other than a plain JavaScript entry
 * point, otherwise the generic entry-point require.
 * @param {string} packageDir
 * @param {string} packageName
 * @param {string} version
 * @returns {{ ok: boolean, summary?: string, error?: Error }}
 */
export function probeFor(packageDir, packageName, version) {
  // `@deepseek-ai/node-addon-system` is pure JavaScript over an optional
  // platform dependency, so requiring its entry point always succeeds and says
  // nothing about the binding. Ask the loader's own resolution instead.
  if (packageName === NODE_ADDON_SYSTEM_PACKAGE) {
    const probe = probeNodeAddonSystem(packageDir);
    if (probe.ok || probe.error) return probe;
  }
  // `@vscode/ripgrep` is three lines of ESM over an optional platform package
  // and a plain executable, not a Node addon. Requiring the entry point does
  // exercise the real resolution, but the probe must not treat a resolved
  // `rg` as loadable by `require`, so the recipe's own check runs first.
  if (packageName === VSCODE_RIPGREP_PACKAGE) {
    return probeVscodeRipgrep(packageDir);
  }
  return probePackage(packageDir, packageName, version);
}

/**
 * Try to load the compiled binding directly, without going through the
 * package's JavaScript entry point.
 * @param {string} packageDir
 * @param {string} packageName
 * @param {string} version
 * @returns {{ ok: boolean, summary?: string, error?: Error } | undefined} undefined when no binding is expected
 */
export function probeBindingFile(packageDir, packageName, version) {
  // For this package the binding file's presence is not the question: the
  // loader has to *resolve the platform package* to find it, so a file at the
  // expected path proves nothing. Let the package-specific probe decide.
  if (packageName === NODE_ADDON_SYSTEM_PACKAGE) return undefined;
  // Same reasoning for `@vscode/ripgrep`: the consumer resolves a platform
  // package, and the binary is spawned rather than `require`d, so a bare file
  // check would both prove too little and misreport a working binary as an
  // unloadable addon.
  if (packageName === VSCODE_RIPGREP_PACKAGE) {
    const probe = probeVscodeRipgrep(packageDir);
    return probe.ok ? { ok: true, summary: probe.summary } : undefined;
  }
  const binding = expectedBindingPath(packageDir, packageName, version);
  if (!binding) return undefined;
  if (!fs.existsSync(binding)) return undefined;
  const result = tryRequire(binding);
  if (result.error) return { ok: false, error: result.error };
  const mod = /** @type {{ versions?: Record<string, string> }} */ (result.module);
  if (packageName === 'node-addon-require-builtin') {
    const info = mod.getNativeBindingInfo?.();
    return {
      ok: true,
      summary: info?.require_builtin_resolved
        ? `requireBuiltin resolved via ${info.getter_symbol_name ?? 'exported getter'}`
        : 'native binding loaded',
    };
  }
  const versions = mod.versions;
  return {
    ok: true,
    summary: versions?.sharp ? `sharp ${versions.sharp} / libvips ${versions.vips}` : 'native binding loaded',
  };
}

/**
 * The exact file a repaired binding has to occupy for a package, or undefined
 * when this tool has no recipe for it.
 * @param {string} packageDir
 * @param {string} packageName
 * @param {string} version
 * @returns {string | undefined}
 */
export function expectedBindingPath(packageDir, packageName, version) {
  if (packageName === 'sharp') {
    return path.join(packageDir, 'src', 'build', 'Release', sharpBinaryName(version));
  }
  if (packageName === 'node-addon-require-builtin') {
    return requireBuiltinBindingPath(packageDir, platformSuffix());
  }
  if (packageName === NODE_ADDON_SYSTEM_PACKAGE) {
    return flockBindingPath(nodeAddonSystemPlatformPackageDir(packageDir), reportLibc());
  }
  if (packageName === VSCODE_RIPGREP_PACKAGE) {
    return ripgrepBinaryPath(ripgrepPlatformPackageDir(packageDir));
  }
  return undefined;
}

/**
 * Candidate entry points for a package, most specific first.
 * @param {string} packageName
 * @returns {string[]}
 */
function entryPointsFor(packageName) {
  if (packageName === 'sharp') return ['dist/index.cjs', 'dist/index.mjs', 'lib/index.js'];
  if (packageName === 'node-addon-require-builtin') return ['lib/index.js', 'index.js'];
  if (packageName === VSCODE_RIPGREP_PACKAGE) return ['lib/index.js', 'index.js'];
  return ['dist/index.cjs', 'index.js'];
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

/**
 * Repair every known package that is installed in the target tree.
 * @param {RepairOptions} options
 * @returns {RepairReport[]}
 */
export function repairAll(options = {}) {
  const logger = options.logger ?? createLogger({ verbose: options.verbose });
  const reports = [];
  // A caller that named one package gets that package: `nbr doctor sharp`
  // must not quietly audit the rest of the tree.
  const packages = options.packageName ? [options.packageName] : KNOWN_PACKAGES;
  for (const packageName of packages) {
    const report = repairPackage({ ...options, packageName, logger });
    reports.push(report);
    if (report.outcome === 'not-installed') logger.detail(`${packageName} is not installed here`);
  }
  return reports;
}

/**
 * Audit without changing anything.
 * @param {RepairOptions} options
 * @returns {RepairReport[]}
 */
export function audit(options = {}) {
  return repairAll({ ...options, dryRun: true });
}

export { verifyBinding };
export default { audit, repairAll, repairPackage, probePackage };
