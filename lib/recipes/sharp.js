/**
 * sharp-specific knowledge.
 *
 * sharp is the most common source of "prebuild missing on an unusual
 * architecture" failures because its binding is distributed only as
 * per-platform optionalDependencies. Knowing its loader rules lets the repair
 * tool place a binary exactly where sharp will look for it.
 */

/**
 * The filename sharp's loader requires inside `src/build/Release/`.
 * @param {string} version
 * @param {string} platform
 * @returns {string}
 */
export function sharpBindingFilename(version, platform) {
  return `sharp-${platform}-${version}.node`;
}

/**
 * System libraries sharp needs at *runtime* (libvips plus its transitive
 * dependencies). Listed per package manager so the reported command is
 * copy-pasteable.
 */
export const sharpSystemRequirements = [
  {
    pkgConfig: 'vips-cpp',
    apt: 'libvips-dev',
    dnf: 'vips-devel',
    pacman: 'libvips',
    apk: 'vips-dev',
  },
  {
    pkgConfig: 'glib-2.0',
    apt: 'libglib2.0-dev',
    dnf: 'glib2-devel',
    pacman: 'glib2',
    apk: 'glib-dev',
  },
];

/**
 * The optional dependency name sharp uses for a runtime.
 * @param {string} platform
 * @returns {string}
 */
export function sharpOptionalPackage(platform) {
  return `@img/sharp-${platform}`;
}

/**
 * Parse the version out of a sharp binary filename.
 * @param {string} file
 * @returns {string | undefined}
 */
export function versionFromBinaryName(file) {
  const match = file.match(/^sharp-[\w-]+-(\d+\.\d+\.\d+[^.\\/]*)\.node$/);
  return match?.[1];
}

/**
 * Whether sharp publishes a prebuild for this platform at all.
 * @param {string} platform
 * @returns {boolean}
 */
export function isPrebuiltPlatform(platform) {
  return SHARP_PREBUILT_PLATFORMS.has(platform);
}

/** Platforms sharp 0.35.x publishes binaries for. */
export const SHARP_PREBUILT_PLATFORMS = new Set([
  'darwin-arm64', 'darwin-x64',
  'freebsd-arm64', 'freebsd-x64',
  'linux-arm', 'linux-arm64', 'linux-ppc64', 'linux-riscv64', 'linux-s390x', 'linux-wasm32', 'linux-x64',
  'linuxmusl-arm64', 'linuxmusl-x64',
  'win32-arm64', 'win32-ia32', 'win32-x64',
]);

export default {
  SHARP_PREBUILT_PLATFORMS,
  isPrebuiltPlatform,
  sharpBindingFilename,
  sharpOptionalPackage,
  sharpSystemRequirements,
  versionFromBinaryName,
};
