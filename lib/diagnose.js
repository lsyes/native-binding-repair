/**
 * Failure classification.
 *
 * A missing native binding shows up in several different disguises. The goal
 * of this module is to turn any of them into one structured verdict so the
 * repair strategies can be chosen mechanically instead of by reading prose.
 */

import process from 'node:process';

import { VSCODE_RIPGREP_PREBUILT } from './recipes/ripgrep.js';

/**
 * @typedef {'missing-prebuild'
 *   | 'module-not-found'
 *   | 'unsupported-arch'
 *   | 'unsupported-libc'
 *   | 'abi-mismatch'
 *   | 'missing-shared-library'
 *   | 'missing-system-library'
 *   | 'unknown'} FailureKind
 */

/**
 * @typedef {object} Diagnosis
 * @property {FailureKind} kind
 * @property {string} summary
 * @property {string[]} evidence
 * @property {string | undefined} missingPackage
 * @property {string | undefined} missingSoname
 * @property {string | undefined} missingLibrary
 * @property {boolean} retriable
 */

const PREBUILD_PATTERNS = [
  /Could not load the "(\w[\w-]*)" module using the ([\w-]+) runtime/i,
  /No usable native binding found for ([\w@/.-]+)/i,
  /No prebuilt binary candidate in ([\w-]+)/i,
  /Cannot find module '([^']*\.node)'/i,
  /was compiled against a different Node\.js version/i,
];

/**
 * The failure `@vscode/ripgrep` prints when npm skipped its platform optional
 * dependency, which is every architecture upstream does not publish for:
 *
 *   Could not find @vscode/ripgrep-linux-loong64.
 *   Ensure optionalDependencies are installed for this platform (linux-loong64).
 *
 * This one is worth its own pattern because the text says "Could not *find*"
 * rather than "Could not *load*", and because the fix is to supply a platform
 * package rather than to rebuild anything.
 */
const RIPGREP_PLATFORM_PATTERN =
  /Could not find (@vscode\/ripgrep-[\w.-]+)\.\s*Ensure optionalDependencies are installed for this platform \(([\w-]+)\)/i;

const ARCH_PATTERNS = [
  /unsupported architecture/i,
  /Cannot find module '@?[\w@/.-]*'?.*(arm64|x64|loong64|riscv64|s390x|ppc64)/i,
];

/**
 * A scoped package's *platform* optional dependency that was never published.
 *
 * This is the shape `@deepseek-ai/node-addon-system` fails in: the entry
 * package is installed and pure JavaScript, so nothing looks wrong until the
 * loader resolves the platform package and Node reports the missing manifest.
 * The `package.json` suffix is what distinguishes it from an ordinary missing
 * dependency, and the architecture in the middle is what makes it repairable.
 */
const PLATFORM_PACKAGE_PATTERN =
  /Cannot find module '((?:@[\w.-]+\/)?[\w.-]+-(?:arm64|x64|ia32|arm|loong64|riscv64|s390x|ppc64|ppc64le)\/package\.json)'/i;

/**
 * Interpret a thrown error (or a captured log blob) as a native-binding failure.
 * @param {unknown} input
 * @param {{ runtime?: string }} [context]
 * @returns {Diagnosis}
 */
export function diagnose(input, context = {}) {
  const { text, error } = normalizeInput(input);
  const evidence = [];

  if (error?.code === 'ERR_DLOPEN_FAILED') evidence.push('ERR_DLOPEN_FAILED');
  if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') evidence.push('MODULE_NOT_FOUND');

  const ripgrepMatch = text.match(RIPGREP_PLATFORM_PATTERN);
  if (ripgrepMatch) {
    const [, missingPackage, platform] = ripgrepMatch;
    evidence.push(`platform package ${missingPackage} is not installed`);
    const prebuilt = VSCODE_RIPGREP_PREBUILT.has(platform);
    return {
      kind: prebuilt ? 'missing-prebuild' : 'unsupported-arch',
      summary: prebuilt
        ? `${missingPackage} is missing but published for ${platform}; reinstall with optional dependencies enabled`
        : `${missingPackage} was never published for ${platform}`,
      evidence,
      missingPackage,
      missingSoname: undefined,
      missingLibrary: undefined,
      retriable: true,
    };
  }

  const sharpMatch = text.match(PREBUILD_PATTERNS[0]);
  if (sharpMatch) {
    const [, moduleName, runtime] = sharpMatch;
    evidence.push(`module "${moduleName}" has no binding for ${runtime}`);
    const missingSoname = matchFirst(text, SONAME_PATTERN);
    if (missingSoname) {
      return {
        kind: 'missing-system-library',
        summary: `libvips needs ${missingSoname}, which is not installed`,
        evidence: [...evidence, `missing shared object ${missingSoname}`],
        missingPackage: undefined,
        missingSoname,
        missingLibrary: undefined,
        retriable: false,
      };
    }
    const archWorthy = /linux-loong|linux-riscv|linux-s390|linux-ppc/i.test(runtime);
    return {
      kind: archWorthy ? 'unsupported-arch' : 'missing-prebuild',
      summary: `${moduleName} cannot load its native binding on ${runtime}`,
      evidence,
      missingPackage: undefined,
      missingSoname: undefined,
      missingLibrary: undefined,
      retriable: true,
    };
  }

  const bindingMatch = text.match(PREBUILD_PATTERNS[1]);
  if (bindingMatch) {
    evidence.push(`no usable native binding for ${bindingMatch[1]}`);
    const platform = matchFirst(text, /\(([\w-]+)\)\s*$/m) ?? matchFirst(text, /node-addon-[\w-]*-([\w-]+-[\w-]+)/);
    return {
      kind: 'unsupported-arch',
      summary: `native addon ${bindingMatch[1]} has no binding${platform ? ` for ${platform}` : ''}`,
      evidence,
      missingPackage: bindingMatch[1],
      missingSoname: undefined,
      missingLibrary: undefined,
      retriable: true,
    };
  }

  const platformPackage = text.match(PLATFORM_PACKAGE_PATTERN);
  if (platformPackage) {
    const missingPackage = platformPackage[1].replace(/\/package\.json$/, '');
    evidence.push(`platform package ${missingPackage} is not installed`);
    const runtime = matchFirst(text, /-((?:arm64|x64|ia32|arm|loong64|riscv64|s390x|ppc64|ppc64le))\/package\.json/);
    return {
      kind: 'unsupported-arch',
      summary: `${missingPackage} was never published${runtime ? ` for ${runtime}` : ''}`,
      evidence,
      missingPackage,
      missingSoname: undefined,
      missingLibrary: undefined,
      retriable: true,
    };
  }

  const candidateMatch = text.match(PREBUILD_PATTERNS[2]);
  if (candidateMatch) {
    evidence.push(`prebuild index has no candidate for ${candidateMatch[1]}`);
    return {
      kind: 'unsupported-arch',
      summary: `no prebuilt binary published for ${candidateMatch[1]}`,
      evidence,
      missingPackage: undefined,
      missingSoname: undefined,
      missingLibrary: undefined,
      retriable: true,
    };
  }

  const nodeMatch = text.match(PREBUILD_PATTERNS[3]);
  if (nodeMatch) {
    evidence.push(`missing compiled binding ${nodeMatch[1]}`);
    return {
      kind: 'module-not-found',
      summary: `compiled binding ${nodeMatch[1]} is not present`,
      evidence,
      missingPackage: undefined,
      missingSoname: undefined,
      missingLibrary: undefined,
      retriable: true,
    };
  }

  if (PREBUILD_PATTERNS[4].test(text)) {
    evidence.push('binding was compiled for a different Node ABI');
    return {
      kind: 'abi-mismatch',
      summary: 'native binding was built for a different Node.js ABI version',
      evidence,
      missingPackage: undefined,
      missingSoname: undefined,
      missingLibrary: undefined,
      retriable: true,
    };
  }

  const soname = matchFirst(text, SONAME_PATTERN);
  if (soname) {
    evidence.push(`missing shared object ${soname}`);
    return {
      kind: 'missing-shared-library',
      summary: `a shared library dependency is missing (${soname})`,
      evidence,
      missingPackage: undefined,
      missingSoname: soname,
      missingLibrary: undefined,
      retriable: false,
    };
  }

  if (ARCH_PATTERNS.some((pattern) => pattern.test(text))) {
    evidence.push('unsupported architecture referenced in failure output');
    return {
      kind: 'unsupported-arch',
      summary: `the current architecture (${process.arch}) is not covered by published prebuilds`,
      evidence,
      missingPackage: undefined,
      missingSoname: undefined,
      missingLibrary: undefined,
      retriable: true,
    };
  }

  if (/libvips|vips-cpp/i.test(text) && /not found|error/i.test(text)) {
    evidence.push('libvips development files are unavailable');
    return {
      kind: 'missing-system-library',
      summary: 'libvips is missing or too old for this build of sharp',
      evidence,
      missingPackage: undefined,
      missingSoname: undefined,
      missingLibrary: 'libvips',
      retriable: false,
    };
  }

  return {
    kind: 'unknown',
    summary: context.runtime
      ? `unrecognized native-binding failure on ${context.runtime}`
      : 'unrecognized native-binding failure',
    evidence: error?.message ? [error.message] : [],
    missingPackage: undefined,
    missingSoname: undefined,
    missingLibrary: undefined,
    retriable: false,
  };
}

/**
 * Matches the whole soname, including its `lib` prefix, in a loader error such
 * as `libvips-cpp.so.42: cannot open shared object file`. The prefix is part of
 * the name being reported, so it must stay inside the capture group.
 */
const SONAME_PATTERN = /(?:^|[\s/])([\w.+-]+\.so(?:\.\d+)*): cannot open shared object file/i;

/**
 * Normalize the many shapes a caller might pass in.
 * @param {unknown} input
 * @returns {{ text: string, error: Error | undefined }}
 */
function normalizeInput(input) {
  if (input instanceof Error) {
    const parts = [input.message];
    let cause = /** @type {unknown} */ (input.cause);
    // AggregateError and nested `cause` chains both appear in the wild; walk a
    // bounded number of levels so cyclic causes cannot hang the CLI.
    for (let depth = 0; cause && depth < 5; depth++) {
      const next = cause instanceof Error ? cause : new Error(String(cause));
      parts.push(next.message);
      cause = next.cause;
    }
    if (typeof input.stack === 'string') parts.push(input.stack);
    return { text: parts.join('\n'), error: input };
  }
  if (typeof input === 'string') return { text: input, error: undefined };
  try {
    return { text: JSON.stringify(input), error: undefined };
  } catch {
    return { text: String(input), error: undefined };
  }
}

/**
 * First capture group of the first matching pattern.
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {string | undefined}
 */
function matchFirst(text, pattern) {
  const match = text.match(pattern);
  return match?.[1];
}

/**
 * Parse a mention like `/usr/bin/node` or `dsh` out of an error blob.
 * @param {string} text
 * @returns {string | undefined}
 */
export function guessFailingCommand(text) {
  const commandMatch = text.match(/^\s*([\w@/.-]+)\s+(?:web|serve|start|build|test|run|dev)\b/m);
  if (commandMatch) return commandMatch[1];
  const invocation = text.match(/\b(dsh|npm|pnpm|yarn|node)\s/);
  return invocation?.[1];
}

export default { diagnose, guessFailingCommand };
