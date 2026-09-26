/**
 * Repair strategies, ordered cheapest-first.
 *
 * Every strategy reports what it would do before doing it, never deletes
 * anything it did not create, and returns a structured result so the caller
 * can decide whether to keep going.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createLogger } from './log.js';
import { platformSuffix, tryRequire, run, hasCommand, pkgConfig, sharpPlatform } from './runtime.js';
import { listVendored, lookupVendored, sharpBinaryName } from './vendor.js';
import { requireBuiltinBindingPath } from './recipes/require-builtin.js';
import {
  LANDLOCK_LAUNCHER_NAME,
  NODE_ADDON_SYSTEM_PACKAGE,
  flockBindingPath,
  landlockLauncherPath,
  nodeAddonSystemManifest,
  nodeAddonSystemPlatform,
  nodeAddonSystemPlatformPackage,
  nodeAddonSystemPlatformPackageDir,
  reportLibc,
} from './recipes/node-addon-system.js';
import {
  RIPGREP_BINARY_NAME,
  VSCODE_RIPGREP_PACKAGE,
  ripgrepBinaryPath,
  ripgrepManifest,
  ripgrepPlatform,
  ripgrepPlatformPackage,
  ripgrepPlatformPackageDir,
} from './recipes/ripgrep.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const vendorDir = path.join(packageRoot, 'vendor');
const require_ = createRequire(import.meta.url);

/**
 * @typedef {object} StrategyResult
 * @property {string} name
 * @property {'applied' | 'skipped' | 'failed' | 'noop'} status
 * @property {string} detail
 * @property {string[]} [artifacts]
 */

/**
 * Whether a package's vendored file for the current runtime is an addon that
 * can be `require`d or an executable that has to be spawned.
 * @param {string} packageName
 * @returns {'addon' | 'executable' | undefined}
 */
export function vendoredKind(packageName) {
  const entry = listVendored().find(
    (candidate) => candidate.package === packageName && candidate.platform === sharpPlatform(),
  );
  return entry?.kind;
}

/**
 * Whether any vendored prebuild ships for the current runtime.
 * @param {string} packageName
 * @returns {boolean}
 */
export function hasVendoredBinding(packageName) {
  return listVendored().some((entry) => entry.package === packageName && entry.platform === sharpPlatform());
}

/**
 * Resolve the on-disk directory of an installed package.
 * @param {string} request
 * @param {string} [from]
 * @returns {string | undefined}
 */
export function resolvePackageDir(request, from) {
  const req = from ? createRequire(path.join(from, 'noop.js')) : require_;
  try {
    // Packages commonly restrict their `exports` map, so `<pkg>/package.json`
    // is not always resolvable. Walk up from the entry point instead.
    return packageRootOf(req.resolve(request));
  } catch {
    try {
      return packageRootOf(req.resolve(`${request}/package.json`));
    } catch {
      return undefined;
    }
  }
}

/**
 * Walk up from a resolved file until the owning package.json is found.
 * @param {string} file
 * @returns {string}
 */
function packageRootOf(file) {
  let dir = path.dirname(file);
  for (let depth = 0; depth < 40; depth++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(file);
}

/**
 * Strategy: install a vendored prebuilt binding straight into the package that
 * needs it. This works with no compiler, no network access and no root
 * privileges, which is what makes it the first strategy to try.
 * @param {{ packageName: string, version: string, targetDir?: string, logger?: ReturnType<typeof createLogger>, dryRun?: boolean }} options
 * @returns {StrategyResult}
 */
export function applyVendoredBinding(options) {
  const logger = options.logger ?? createLogger();
  const entry = lookupVendored(options.packageName, options.version);
  if (!entry) {
    const available = listVendored()
      .filter((candidate) => candidate.package === options.packageName && candidate.platform === sharpPlatform())
      .map((candidate) => candidate.version);
    return {
      name: 'vendored-binding',
      status: 'skipped',
      detail: available.length
        ? `no vendored ${options.packageName} ${options.version}; bundled versions: ${[...new Set(available)].join(', ')}`
        : `no vendored ${options.packageName} binding for ${sharpPlatform()}`,
    };
  }
  const targetDir = options.targetDir;
  if (!targetDir) {
    return {
      name: 'vendored-binding',
      status: 'skipped',
      detail: `cannot locate an installed copy of ${options.packageName} to repair`,
    };
  }
  const recipe = vendorRecipes[options.packageName];
  if (!recipe) {
    return {
      name: 'vendored-binding',
      status: 'skipped',
      detail: `no install recipe for ${options.packageName}`,
    };
  }
  const plan = recipe.plan({
    targetDir,
    entry,
    version: options.version,
    libc: reportLibc(),
  });
  if (options.dryRun) {
    return {
      name: 'vendored-binding',
      status: 'applied',
      detail: `would install ${entry.file} into ${plan.summary}`,
      artifacts: [...plan.files.map((file) => file.destination), ...plan.manifests.map((m) => m.destination)],
    };
  }
  const written = [];
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.destination), { recursive: true });
    fs.copyFileSync(file.source, file.destination);
    fs.chmodSync(file.destination, file.mode ?? 0o755);
    written.push(file.destination);
  }
  // A locally built platform package needs its own manifest: its consumer
  // resolves the package by asking for `<package>/package.json`, so this file
  // is the difference between "resolvable" and "Cannot find module".
  for (const manifest of plan.manifests) {
    fs.mkdirSync(path.dirname(manifest.destination), { recursive: true });
    fs.writeFileSync(manifest.destination, `${JSON.stringify(manifest.value, null, 2)}\n`);
    written.push(manifest.destination);
  }
  logger.detail(`installed ${entry.file} -> ${written[0]}`);
  return {
    name: 'vendored-binding',
    status: 'applied',
    detail: `installed ${entry.file} into ${plan.summary}`,
    artifacts: written,
  };
}

/**
 * What one install recipe wants written: the binaries to copy (with their
 * source, destination and mode) plus any manifests to generate beside them.
 * @typedef {object} InstallPlan
 * @property {Array<{ source: string, destination: string, mode?: number }>} files
 * @property {Array<{ destination: string, value: unknown }>} manifests
 * @property {string} summary
 *
 * Per-package install recipes describing where a binary must land. sharp's
 * loader requires the exact `<platform>-<version>` filename, so the vendored
 * file is renamed to match the installed package version when they differ.
 * @type {Record<string, { plan: (context: { targetDir: string, entry: import('./vendor.js').VendorEntry, version: string, libc: 'glibc' | 'musl' }) => InstallPlan }>}
 */
const vendorRecipes = {
  sharp: {
    plan: ({ targetDir, entry, version }) => {
      const releaseDir = path.join(targetDir, 'src', 'build', 'Release');
      const canonical = sharpBinaryName(version);
      const paths = [path.join(releaseDir, canonical)];
      if (entry.file !== canonical) paths.push(path.join(releaseDir, entry.file));
      return {
        files: paths.map((destination) => ({ source: entry.path, destination })),
        manifests: [],
        summary: releaseDir,
      };
    },
  },
  // node-addon-native-custom-loader builds the local fallback path from the
  // runtime suffix itself, so the binding only has to land at exactly that
  // path — no renaming and no package.json edits are involved.
  'node-addon-require-builtin': {
    plan: ({ targetDir, entry }) => {
      const destination = requireBuiltinBindingPath(targetDir, platformSuffix());
      return {
        files: [{ source: entry.path, destination }],
        manifests: [],
        summary: path.dirname(destination),
      };
    },
  },
  // @deepseek-ai/node-addon-system expects a whole platform package: the
  // entry package resolves `<platform-package>/package.json` and picks the
  // libc subdirectory from the Node report, so the repair materialises that
  // package next to the entry package instead of touching the entry package.
  [NODE_ADDON_SYSTEM_PACKAGE]: {
    plan: ({ targetDir: entryPackageDir, entry, version, libc }) => {
      const targetDir = nodeAddonSystemPlatformPackageDir(entryPackageDir, entry.platform);
      const sourceDir = path.dirname(entry.path);
      const files = [{ source: entry.path, destination: flockBindingPath(targetDir, libc) }];
      // The Landlock launcher is an executable rather than a `.node` file, so
      // the vendor registry does not index it; it travels as a sibling.
      const launcher = path.join(sourceDir, LANDLOCK_LAUNCHER_NAME);
      if (fs.existsSync(launcher)) {
        files.push({ source: launcher, destination: landlockLauncherPath(targetDir) });
      }
      const [platform, ...arch] = entry.platform.split('-');
      return {
        files,
        manifests: [{
          destination: path.join(targetDir, 'package.json'),
          value: nodeAddonSystemManifest({ platform, arch: arch.join('-'), version }),
        }],
        summary: targetDir,
      };
    },
  },
  // @vscode/ripgrep resolves `<platform-package>/bin/rg` with require.resolve,
  // so the platform package has to exist as a sibling of the entry package --
  // a binary inside the entry package is never found. Its name uses the raw
  // platform/arch pair (`linux-loong64`), matching the vendor directory key.
  [VSCODE_RIPGREP_PACKAGE]: {
    plan: ({ targetDir: entryPackageDir, entry, version }) => {
      const targetDir = ripgrepPlatformPackageDir(entryPackageDir, entry.platform);
      const [platform, ...arch] = entry.platform.split('-');
      return {
        files: [{ source: entry.path, destination: ripgrepBinaryPath(targetDir), mode: 0o755 }],
        manifests: [{
          destination: path.join(targetDir, 'package.json'),
          value: ripgrepManifest({ platform, arch: arch.join('-'), version }),
        }],
        summary: targetDir,
      };
    },
  },
};

/**
 * Strategy: compile a platform package from the C sources the entry package
 * ships.
 *
 * `@deepseek-ai/node-addon-system` bundles `src/flock.c` and `src/main.c` for
 * auditability but publishes binaries only for four platforms. On the rest
 * (loong64, riscv64, ...) neither the registry nor this tool's vendor
 * directory can supply a prebuild, which leaves a local compile as the only
 * offline route — and it works without a `binding.gyp` because the sources are
 * plain C against Node-API and libc.
 * @param {{ packageDir: string, logger?: ReturnType<typeof createLogger>, dryRun?: boolean }} options
 * @returns {StrategyResult}
 */
export function buildNodeAddonSystem(options) {
  const logger = options.logger ?? createLogger();
  const packageDir = options.packageDir;
  const flockSource = path.join(packageDir, 'src', 'flock.c');
  const launcherSource = path.join(packageDir, 'src', 'main.c');
  if (!fs.existsSync(flockSource)) {
    return {
      name: 'build-node-addon-system',
      status: 'skipped',
      detail: `no C sources inside ${packageDir}`,
    };
  }
  const compiler = firstAvailable(['cc', 'gcc', 'clang']);
  if (!compiler) {
    return {
      name: 'build-node-addon-system',
      status: 'skipped',
      detail: 'no C compiler (cc, gcc or clang) is installed',
    };
  }
  const includeDir = path.join(path.dirname(process.execPath), '..', 'include', 'node');
  if (!fs.existsSync(path.join(includeDir, 'node_api.h'))) {
    return {
      name: 'build-node-addon-system',
      status: 'skipped',
      detail: `Node headers are not installed at ${includeDir}`,
    };
  }
  const platformDir = nodeAddonSystemPlatformPackageDir(packageDir);
  const binding = flockBindingPath(platformDir, reportLibc());
  const launcher = landlockLauncherPath(platformDir);
  if (options.dryRun) {
    return {
      name: 'build-node-addon-system',
      status: 'applied',
      detail: `would compile ${path.basename(flockSource)} and ${path.basename(launcherSource)} into ${path.basename(platformDir)} with ${compiler}`,
      artifacts: [binding, launcher],
    };
  }

  const manifest = path.join(platformDir, 'package.json');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.mkdirSync(path.dirname(launcher), { recursive: true });

  logger.info(`compiling flock binding with ${compiler}`);
  const bindingStatus = run(compiler, [
    '-O2', '-fPIC', '-shared',
    `-I${includeDir}`,
    flockSource,
    '-o', binding,
  ]);
  if (bindingStatus !== 0 || !fs.existsSync(binding)) {
    return {
      name: 'build-node-addon-system',
      status: 'failed',
      detail: `${compiler} exited with status ${bindingStatus} building ${path.basename(binding)}`,
    };
  }

  let launcherStatus = 0;
  if (fs.existsSync(launcherSource)) {
    logger.info(`compiling landlock launcher with ${compiler}`);
    launcherStatus = run(compiler, ['-O2', '-static', launcherSource, '-o', launcher]);
  }
  if (launcherStatus !== 0) {
    // Landlock is the sandbox rung, not the binding that failed to load: a host
    // whose toolchain cannot link it statically still gets a working `flock`.
    logger.warn(`landlock launcher did not build (${compiler} exited with ${launcherStatus}); flock is still repaired`);
    fs.rmSync(launcher, { force: true });
  } else {
    fs.chmodSync(launcher, 0o755);
  }

  const version = readManifestVersion(packageDir) ?? '0.0.0';
  const [platform, ...archParts] = nodeAddonSystemPlatform().split('-');
  fs.writeFileSync(manifest, `${JSON.stringify(nodeAddonSystemManifest({
    platform,
    arch: archParts.join('-'),
    version,
  }), null, 2)}\n`);

  return {
    name: 'build-node-addon-system',
    status: 'applied',
    detail: `built ${path.basename(binding)}${launcherStatus === 0 ? ' and the Landlock launcher' : ''} into ${platformDir}`,
    artifacts: [binding, launcher, manifest].filter((file) => fs.existsSync(file)),
  };
}

/**
 * Read a package version without importing the package.
 * @param {string} packageDir
 * @returns {string | undefined}
 */
function readManifestVersion(packageDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first command present on PATH, or undefined.
 * @param {string[]} candidates
 * @returns {string | undefined}
 */
function firstAvailable(candidates) {
  return candidates.find((candidate) => hasCommand(candidate));
}

/**
 * Strategy: build the missing binding from source with node-gyp.
 * @param {{ packageDir: string, logger?: ReturnType<typeof createLogger>, dryRun?: boolean, nodeGypPath?: string, extraEnv?: Record<string, string> }} options
 * @returns {StrategyResult}
 */
export function buildFromSource(options) {
  const logger = options.logger ?? createLogger();
  const packageDir = options.packageDir;
  const sourceDir = path.join(packageDir, 'src');
  if (!fs.existsSync(path.join(sourceDir, 'binding.gyp'))) {
    return {
      name: 'build-from-source',
      status: 'skipped',
      detail: `no binding.gyp in ${sourceDir}`,
    };
  }
  if (!hasCommand('make') || !hasCommand('gcc') || !hasCommand('g++')) {
    return {
      name: 'build-from-source',
      status: 'skipped',
      detail: 'a C/C++ toolchain (gcc, g++, make) is required to build from source',
    };
  }
  const nodeGypPath = options.nodeGypPath ?? locateNodeGyp();
  if (!nodeGypPath) {
    return {
      name: 'build-from-source',
      status: 'skipped',
      detail: 'node-gyp is not available (npm normally bundles it)',
    };
  }
  const args = [nodeGypPath, 'rebuild', '--directory=src'];
  if (options.dryRun) {
    return {
      name: 'build-from-source',
      status: 'applied',
      detail: `would run: node ${args.join(' ')}`,
    };
  }
  logger.info(`building from source in ${sourceDir}`);
  const status = run(process.execPath, args, {
    cwd: packageDir,
    env: { ...options.extraEnv },
  });
  if (status !== 0) {
    return {
      name: 'build-from-source',
      status: 'failed',
      detail: `node-gyp rebuild exited with status ${status}`,
    };
  }
  return {
    name: 'build-from-source',
    status: 'applied',
    detail: 'node-gyp rebuild completed',
  };
}

/**
 * Find node-gyp, preferring the copy npm ships with the running Node install.
 * @returns {string | undefined}
 */
export function locateNodeGyp() {
  const candidates = [];
  const nodeDir = path.dirname(process.execPath);
  candidates.push(
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    path.join(nodeDir, 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  );
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  const globalRoot = tryGlobalNodeModules();
  if (globalRoot) {
    const bundled = path.join(globalRoot, 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
    if (fs.existsSync(bundled)) return bundled;
  }
  return undefined;
}

/**
 * Ask npm where global modules live. Returns undefined if npm is unavailable.
 * @returns {string | undefined}
 */
function tryGlobalNodeModules() {
  const result = tryRequire('npm');
  if (typeof result.module === 'object' && result.module) {
    const npm = /** @type {{ prefix?: string }} */ (result.module);
    if (typeof npm.prefix === 'string') return path.join(npm.prefix, 'lib', 'node_modules');
  }
  return undefined;
}

/**
 * Strategy: report which system libraries a package needs and which are absent.
 * @param {{ required?: Array<{ pkgConfig?: string, apt?: string, dnf?: string, pacman?: string, apk?: string }>, logger?: ReturnType<typeof createLogger> }} options
 * @returns {StrategyResult}
 */
export function reportSystemDependencies(options) {
  const logger = options.logger ?? createLogger();
  const required = options.required ?? [];
  const missing = [];
  for (const entry of required) {
    if (!entry.pkgConfig) continue;
    const version = pkgConfig(entry.pkgConfig, '--modversion');
    if (!version) missing.push(entry);
  }
  if (missing.length === 0) {
    return {
      name: 'system-dependencies',
      status: 'noop',
      detail: 'all required system libraries are present',
    };
  }
  const packages = missing.map((entry) => entry.apt).filter(Boolean);
  for (const entry of missing) {
    logger.warn(`missing ${entry.pkgConfig}${entry.apt ? ` (install ${entry.apt})` : ''}`);
  }
  const manager = detectPackageManager();
  const names = missing.map((entry) => entry[manager] ?? entry.apt).filter(Boolean);
  return {
    name: 'system-dependencies',
    status: 'failed',
    detail: names.length && manager !== 'unknown'
      ? `install system libraries with: sudo ${managerInstall(manager)} ${names.join(' ')}`
      : `install these development packages: ${packages.join(' ')}`,
  };
}

/**
 * Identify the host package manager.
 * @returns {'apt' | 'dnf' | 'pacman' | 'apk' | 'unknown'}
 */
export function detectPackageManager() {
  if (hasCommand('apt-get')) return 'apt';
  if (hasCommand('dnf')) return 'dnf';
  if (hasCommand('pacman')) return 'pacman';
  if (hasCommand('apk')) return 'apk';
  return 'unknown';
}

/**
 * The install subcommand for a package manager.
 * @param {'apt' | 'dnf' | 'pacman' | 'apk' | 'unknown'} manager
 * @returns {string}
 */
export function managerInstall(manager) {
  if (manager === 'apt') return 'apt-get install -y';
  if (manager === 'pacman') return 'pacman -S --needed';
  return 'install';
}

/**
 * Strategy: fall back to the WebAssembly build of sharp.
 * @param {{ logger?: ReturnType<typeof createLogger>, sharpPackageDir?: string, packageName?: string }} options
 * @returns {StrategyResult}
 */
export function useWasmFallback(options) {
  const logger = options.logger ?? createLogger();
  const packageName = options.packageName ?? 'sharp';
  const wasmModules = wasmEntryPoints[packageName];
  if (!wasmModules) {
    return { name: 'wasm-fallback', status: 'skipped', detail: `no WebAssembly build exists for ${packageName}` };
  }
  const packageDir = options.sharpPackageDir;
  const found = wasmModules
    .map((moduleName) => ({ moduleName, dir: packageDir ? resolvePackageDir(moduleName, packageDir) : resolvePackageDir(moduleName) }))
    .filter((entry) => entry.dir);
  if (found.length === 0) {
    return {
      name: 'wasm-fallback',
      status: 'failed',
      detail: `install the WebAssembly build manually: npm install ${wasmModules.join(' ')}`,
    };
  }
  logger.detail(`found ${found.map((entry) => entry.moduleName).join(', ')}`);
  return {
    name: 'wasm-fallback',
    status: 'applied',
    detail: `${found[0].moduleName} provides a WebAssembly binding for this runtime`,
    artifacts: found.map((entry) => entry.dir),
  };
}

/**
 * WebAssembly entry points per package, in preference order.
 * @type {Record<string, string[]>}
 */
const wasmEntryPoints = {
  sharp: ['@img/sharp-wasm32', '@img/sharp-webcontainers-wasm32'],
};

/**
 * Strategy: install the platform-specific optional dependency that npm skipped.
 * @param {{ packageName: string, packageDir?: string, logger?: ReturnType<typeof createLogger>, dryRun?: boolean }} options
 * @returns {StrategyResult}
 */
export function installPlatformOptional(options) {
  const logger = options.logger ?? createLogger();
  const packageName = options.packageName;
  const optionalName = `${packageName}-${platformSuffix()}`;
  const dir = resolvePackageDir(optionalName, options.packageDir);
  if (dir) {
    return {
      name: 'platform-optional',
      status: 'noop',
      detail: `${optionalName} is already installed`,
      artifacts: [dir],
    };
  }
  if (options.dryRun) {
    return {
      name: 'platform-optional',
      status: 'applied',
      detail: `would install ${optionalName}`,
    };
  }
  logger.info(`installing ${optionalName}`);
  try {
    const npm = hasCommand('npm') ? 'npm' : undefined;
    if (!npm) {
      return { name: 'platform-optional', status: 'skipped', detail: 'npm is not on PATH' };
    }
    const status = run('npm', [
      'install',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--include=optional',
      optionalName,
    ], { cwd: options.packageDir });
    if (status !== 0) {
      return {
        name: 'platform-optional',
        status: 'failed',
        detail: `npm install exited with status ${status}; the package may not exist for ${platformSuffix()}`,
      };
    }
    return {
      name: 'platform-optional',
      status: 'applied',
      detail: `installed ${optionalName}`,
    };
  } catch (error) {
    return { name: 'platform-optional', status: 'failed', detail: error.message };
  }
}

/**
 * Report every sharp-style binding problem visible in an installed tree.
 * @param {{ packageDir: string, logger?: ReturnType<typeof createLogger> }} options
 * @returns {StrategyResult}
 */
export function verifyBinding(options) {
  const logger = options.logger ?? createLogger();
  const packageDir = options.packageDir;
  const entry = path.join(packageDir, 'dist', 'index.cjs');
  if (!fs.existsSync(entry)) {
    return { name: 'verify', status: 'skipped', detail: `no dist/index.cjs inside ${packageDir}` };
  }
  const result = tryRequire(entry);
  if (result.error) {
    return { name: 'verify', status: 'failed', detail: result.error.message };
  }
  const versions = /** @type {{ versions?: Record<string, string> }} */ (result.module).versions;
  const summary = versions ? `sharp ${versions.sharp} / libvips ${versions.vips}` : 'module loaded';
  logger.detail(summary);
  return { name: 'verify', status: 'applied', detail: summary };
}

/**
 * The path this package would write a vendored sharp binding to.
 * @param {string} targetDir
 * @returns {string}
 */
export function sharpBindingPath(targetDir) {
  return path.join(targetDir, 'src', 'build', 'Release', `sharp-${sharpPlatform()}-0.0.0.node`);
}

export { packageRoot, vendorDir };
