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
 */

import path from 'node:path';

/** The filename the loader requires for a locally built binding. */
export const REQUIRE_BUILTIN_BINARY_NAME = 'require_builtin.node';

/** The N-API version the loader asks for when it probes local builds. */
export const REQUIRE_BUILTIN_NAPI_TAG = 'napi-v9';

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
