/**
 * `node-addon-require-builtin`-specific knowledge.
 *
 * The package is a thin JavaScript wrapper around a per-platform optional
 * dependency; `node-addon-native-custom-loader` picks the binary. Unlike
 * sharp, its loader has a documented local-build fallback whose path is fully
 * determined by the runtime, so a repair can drop a binding there and the
 * wrapper will pick it up without any registry access.
 *
 * That fallback is what this tool uses on architectures the package never
 * published a binary for (loong64 among them).
 *
 * Upstream — https://github.com/deepseek-ai/dsh-node-addon-require-builtin —
 * is a pnpm monorepo that publishes prebuilds only for darwin/linux-x64/
 * linux-arm64/win32, and its `packages/native/src/runtime_{context,probe}/
 * platform.cc` dispatch tables have no LoongArch64 entry, so a stock source
 * build fails closed on loong64. This module carries the overlay that adds the
 * missing port: two new translation units plus the dispatch, arch-name and
 * declaration lines they need.
 *
 * The overlay is applied to a scratch copy of the submodule, never to the
 * submodule itself, and every anchor must match exactly once or the overlay
 * refuses to run — that is what keeps a moved upstream revision from silently
 * producing a wrong binary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tryExec, tryRequire } from '../runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root of this tool. */
export const requireBuiltinPackageRoot = path.resolve(here, '..', '..');

/** The filename the loader requires for a locally built binding. */
export const REQUIRE_BUILTIN_BINARY_NAME = 'require_builtin.node';

/** The N-API version the loader asks for when it probes local builds. */
export const REQUIRE_BUILTIN_NAPI_TAG = 'napi-v9';

/**
 * The upstream checkout, added to this repository as a git submodule.
 *
 * It is a development source tree rather than a published artefact: `npm pack`
 * does not carry submodules, so a tarball install keeps the offline prebuild
 * path and reports the missing source tree instead of pretending to build.
 */
export const REQUIRE_BUILTIN_UPSTREAM_DIR = path.join(
  requireBuiltinPackageRoot,
  'vendor',
  'node-addon-require-builtin-src',
);

/** Upstream's native source directory. */
export const REQUIRE_BUILTIN_UPSTREAM_SRC = path.join(
  REQUIRE_BUILTIN_UPSTREAM_DIR,
  'packages',
  'native',
  'src',
);

/** Where this tool's LoongArch64 port lives, mirroring upstream-relative paths. */
export const REQUIRE_BUILTIN_OVERLAY_DIR = path.join(
  requireBuiltinPackageRoot,
  'native',
  'require-builtin',
  'loong64',
);

/**
 * The node-addon-api headers this overlay is known to compile against. They are
 * vendored under `native/` because upstream needs ^8.9.0 and a machine may only
 * carry an older copy (DSH ships 7.1.1, which lacks the `std::string_view`
 * overload upstream's constructor uses).
 */
export const REQUIRE_BUILTIN_NAPI_DIR = path.join(
  requireBuiltinPackageRoot,
  'native',
  'require-builtin',
  'node-addon-api',
);

/** The node-addon-api major version upstream requires. */
export const REQUIRE_BUILTIN_NAPI_MIN_MAJOR = 8;

/**
 * The upstream revision the overlay was written against. A different checkout
 * is still attempted — every anchor below is verified — but it is reported so
 * a moved revision is visible in the repair log rather than inferred from a
 * mysterious compile error.
 */
export const REQUIRE_BUILTIN_UPSTREAM_COMMIT =
  '36e2a4c9505fd4d05216f2fa9745676cd06d0012';

/**
 * Translation units the overlay adds to upstream's `packages/native/src`.
 * @type {string[]}
 */
export const REQUIRE_BUILTIN_OVERLAY_FILES = [
  'runtime_context/linux_glibc_loong64.cc',
  'runtime_probe/linux_glibc_loong64.cc',
];

/**
 * Lines the overlay injects into existing upstream files. Each anchor has to
 * appear exactly once: a silent zero or two matches would mean the upstream
 * revision moved under the overlay, which must fail loudly.
 * @type {Array<{ file: string, anchor: string, insert: string }>}
 */
export const REQUIRE_BUILTIN_OVERLAY_INSERTS = [
  {
    file: 'runtime_context/helper.h',
    anchor: [
      'Result<CurrentContextRead> ReadLinuxGlibcX64CurrentV8Context(',
      '    void* isolate,',
      '    const CurrentContextSymbols& symbols);',
    ].join('\n'),
    insert: [
      '',
      'Result<CurrentContextRead> ReadLinuxGlibcLoong64CurrentV8Context(',
      '    void* isolate,',
      '    const CurrentContextSymbols& symbols);',
    ].join('\n'),
  },
  {
    file: 'runtime_probe/parser.h',
    anchor:
      'Result<GetterPattern> ParseLinuxGlibcX64BuiltinModuleRequireGetterOffset(void* getter);',
    insert: [
      '',
      'Result<GetterPattern> ParseLinuxGlibcLoong64BuiltinModuleRequireGetterOffset(void* getter);',
    ].join('\n'),
  },
  {
    file: 'runtime_context/platform.cc',
    anchor: [
      '#elif defined(__linux__) && defined(__GLIBC__) && defined(__x86_64__)',
      '  return ReadLinuxGlibcX64CurrentV8Context(isolate, symbols);',
    ].join('\n'),
    insert: [
      '',
      '#elif defined(__linux__) && defined(__GLIBC__) && defined(__loongarch_lp64)',
      '  return ReadLinuxGlibcLoong64CurrentV8Context(isolate, symbols);',
    ].join('\n'),
  },
  {
    file: 'runtime_probe/platform.cc',
    anchor: [
      '#elif defined(__linux__) && defined(__GLIBC__) && defined(__x86_64__)',
      '  return ParseLinuxGlibcX64BuiltinModuleRequireGetterOffset(getter);',
    ].join('\n'),
    insert: [
      '',
      '#elif defined(__linux__) && defined(__GLIBC__) && defined(__loongarch_lp64)',
      '  return ParseLinuxGlibcLoong64BuiltinModuleRequireGetterOffset(getter);',
    ].join('\n'),
  },
  {
    file: 'native_types.cc',
    anchor: [
      '#elif defined(__x86_64__) || defined(_M_X64)',
      '  return "x64";',
    ].join('\n'),
    insert: [
      '',
      '#elif defined(__loongarch_lp64)',
      '  return "loong64";',
    ].join('\n'),
  },
];

/**
 * The exact translation-unit list upstream's `scripts/build.ts` compiles for
 * the Linux N-API backend, plus the overlay's two files. It is duplicated here
 * because the repair runs the compiler directly: the repository's own build
 * script needs `tsx`, and a repair must not depend on the network or on a
 * package manager.
 * @type {string[]}
 */
export const REQUIRE_BUILTIN_UPSTREAM_SOURCES = [
  'node_api_addon.cc',
  'debug_trace.cc',
  'native_types.cc',
  'runtime_symbol.cc',
  'require_builtin_probe.cc',
  'runtime_context/helper.cc',
  'runtime_context/platform.cc',
  'runtime_context/darwin_arm64.cc',
  'runtime_context/darwin_x64.cc',
  'runtime_context/linux_glibc_arm64.cc',
  'runtime_context/linux_glibc_x64.cc',
  'runtime_context/linux_glibc_loong64.cc',
  'runtime_context/win32_arm64.cc',
  'runtime_context/win32_x64.cc',
  'runtime_context/win32_ia32.cc',
  'runtime_context/runtime_profile.cc',
  'runtime_context/runtime_profile_napi.cc',
  'runtime_compat_napi.cc',
  'runtime_probe/helper.cc',
  'runtime_probe/platform.cc',
  'runtime_probe/getter_decoder.cc',
  'runtime_probe/posix.cc',
  'runtime_probe/win32_common.cc',
  'runtime_probe/darwin_arm64.cc',
  'runtime_probe/darwin_x64.cc',
  'runtime_probe/linux_glibc_arm64.cc',
  'runtime_probe/linux_glibc_x64.cc',
  'runtime_probe/linux_glibc_loong64.cc',
  'runtime_probe/win32_arm64.cc',
  'runtime_probe/win32_x64.cc',
  'runtime_probe/win32_ia32.cc',
];

/**
 * The node-addon-api version a candidate directory provides, or undefined when
 * it has no readable manifest.
 * @param {string} dir
 * @returns {string | undefined}
 */
export function nodeAddonApiVersion(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a directory holds a node-addon-api new enough for upstream.
 *
 * The vendored copy is tried first, so this only matters for copies discovered
 * on the machine: an older one (DSH ships 7.1.1) must be rejected rather than
 * handed to a compiler that will then fail on `std::string_view`.
 * @param {string} dir
 * @returns {boolean}
 */
export function isCompatibleNodeAddonApi(dir) {
  const version = nodeAddonApiVersion(dir);
  if (!version) return true;
  const major = Number.parseInt(version.split('.')[0], 10);
  return !Number.isFinite(major) || major >= REQUIRE_BUILTIN_NAPI_MIN_MAJOR;
}

/**
 * Whether the upstream source is present where the overlay expects it.
 *
 * The native sources are the real test, not `.git`: a checkout that has been
 * exported or copied without git metadata is still perfectly buildable, and
 * only the anchors need to match.
 * @returns {{ ok: true, srcDir: string } | { ok: false, reason: string }}
 */
export function requireBuiltinUpstreamState() {
  if (fs.existsSync(path.join(REQUIRE_BUILTIN_UPSTREAM_SRC, 'node_api_addon.cc'))) {
    return { ok: true, srcDir: REQUIRE_BUILTIN_UPSTREAM_SRC };
  }
  if (!fs.existsSync(REQUIRE_BUILTIN_UPSTREAM_DIR)) {
    return {
      ok: false,
      reason: `upstream sources are not checked out; run: git submodule update --init ${path.relative(requireBuiltinPackageRoot, REQUIRE_BUILTIN_UPSTREAM_DIR)}`,
    };
  }
  return {
    ok: false,
    reason: `upstream native sources are missing from ${REQUIRE_BUILTIN_UPSTREAM_SRC}`,
  };
}

/**
 * The commit the checked-out submodule sits at, or undefined when git is not
 * available to ask. Best-effort: the anchor checks are the real guard.
 * @returns {string | undefined}
 */
export function requireBuiltinUpstreamCommit() {
  return tryExec('git', ['-C', REQUIRE_BUILTIN_UPSTREAM_DIR, 'rev-parse', 'HEAD']);
}

/**
 * The version the checked-out upstream workspace declares. This is also the
 * version the published entry package uses, which is what makes it the right
 * thing to compare against an installed package: the sources in the submodule
 * only describe the addon contract of that release.
 * @returns {string | undefined}
 */
export function requireBuiltinUpstreamVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REQUIRE_BUILTIN_UPSTREAM_DIR, 'package.json'), 'utf8'),
    );
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copy the overlay's own sources over a scratch source tree and apply the
 * insertions. Throws when an anchor does not match exactly once, so a moved
 * upstream revision can never silently yield a miscompiled binding.
 * @param {string} srcDir
 * @returns {string[]} every file the overlay wrote
 */
export function applyRequireBuiltinOverlay(srcDir) {
  const written = [];
  for (const relative of REQUIRE_BUILTIN_OVERLAY_FILES) {
    const source = path.join(REQUIRE_BUILTIN_OVERLAY_DIR, relative);
    const destination = path.join(srcDir, relative);
    if (!fs.existsSync(source)) {
      throw new Error(`overlay source is missing: ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    written.push(destination);
  }
  for (const edit of REQUIRE_BUILTIN_OVERLAY_INSERTS) {
    const file = path.join(srcDir, edit.file);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error(`overlay target is missing: ${edit.file}`);
    }
    const occurrences = text.split(edit.anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `overlay anchor for ${edit.file} matched ${occurrences} times (expected 1); `
        + 'the checked-out upstream revision does not match this overlay',
      );
    }
    fs.writeFileSync(file, text.replace(edit.anchor, `${edit.anchor}${edit.insert}`));
    written.push(file);
  }
  return written;
}

/**
 * Health probe for the package.
 *
 * Two details make this different from a plain `require` of the entry point.
 * The loader loads the native binary eagerly, but upstream's
 * `getNativeBindingInfo()` is a static descriptor compiled into the addon: it
 * says nothing about whether the private runtime probe works. That probe runs
 * only when `requireBuiltin(id)` is called, and a runtime the addon does not
 * understand makes the call throw with its diagnostics attached. A health
 * check therefore has to make the call.
 * @param {string} packageDir
 * @param {{ bindingPath?: string, direct?: boolean }} [options] `direct` skips
 *   the package entry point and loads the binding file itself, which is what
 *   the loader-independent check needs.
 * @returns {{ ok: boolean, summary?: string, error?: Error }}
 */
export function probeRequireBuiltin(packageDir, options = {}) {
  const entry = options.direct
    ? undefined
    : ['lib/index.js', 'index.js']
      .map((relative) => path.join(packageDir, relative))
      .find((candidate) => fs.existsSync(candidate));

  let loaded;
  if (entry) {
    loaded = tryRequire(entry);
  } else if (options.bindingPath && fs.existsSync(options.bindingPath)) {
    loaded = tryRequire(options.bindingPath);
  } else {
    return {
      ok: false,
      error: new Error(`Cannot find module 'node-addon-require-builtin': no entry point inside ${packageDir}`),
    };
  }
  if (loaded.error) return { ok: false, error: loaded.error };

  const loadedModule = /** @type {Record<string, unknown>} */ (loaded.module);
  const api = typeof loadedModule.requireBuiltin === 'function'
    ? loadedModule
    : /** @type {Record<string, unknown> | undefined} */ (loadedModule.default);
  if (!api || typeof api.requireBuiltin !== 'function') {
    return { ok: false, error: new Error('the loaded module does not expose requireBuiltin') };
  }

  try {
    const exports = api.requireBuiltin('internal/bootstrap/realm');
    if (!exports || typeof exports !== 'object') {
      return { ok: false, error: new Error('requireBuiltin returned no internal module') };
    }
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error) };
  }

  let summary = 'requireBuiltin resolved';
  try {
    const info = typeof api.getBindingInfo === 'function'
      ? /** @type {Record<string, string> | undefined} */ (api.getBindingInfo())
      : undefined;
    if (info?.backend) {
      summary += ` (${info.backend}/${info.product} ${info.abi}, ${info.bindingSource})`;
    }
  } catch {
    // Diagnostics are best-effort; a resolved requireBuiltin is the verdict.
  }
  return { ok: true, summary };
}

/**
 * Where `node-addon-native-custom-loader` looks for a local build of this
 * package, given the running runtime's platform suffix.
 * @param {string} packageDir
 * @param {string} platformSuffix
 * @returns {string}
 */
export function requireBuiltinBindingPath(packageDir, platformSuffix) {
  return path.join(
    packageDir,
    'build',
    REQUIRE_BUILTIN_NAPI_TAG.split('-')[0],
    `${REQUIRE_BUILTIN_NAPI_TAG}-${platformSuffix}`,
    REQUIRE_BUILTIN_BINARY_NAME,
  );
}

/**
 * The package this recipe applies to, and the name of the optional dependency
 * the loader would otherwise install.
 * @param {string} platformSuffix
 * @returns {string}
 */
export function requireBuiltinOptionalPackage(platformSuffix) {
  return `node-addon-require-builtin-${platformSuffix}`;
}

export default {
  REQUIRE_BUILTIN_BINARY_NAME,
  REQUIRE_BUILTIN_NAPI_TAG,
  requireBuiltinBindingPath,
  requireBuiltinOptionalPackage,
};
