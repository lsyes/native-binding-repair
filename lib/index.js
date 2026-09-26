/**
 * Public API for native-binding-repair.
 *
 * @example
 * import { repairPackage } from 'native-binding-repair';
 * const report = repairPackage({ packageName: 'sharp' });
 * if (report.outcome !== 'repaired' && report.outcome !== 'already-working') {
 *   process.exitCode = 1;
 * }
 */

export { audit, repairAll, repairPackage, probePackage, KNOWN_PACKAGES } from './repair.js';
export { diagnose, guessFailingCommand } from './diagnose.js';
export { applyVendoredBinding, buildFromSource, verifyBinding, vendoredKind } from './strategies.js';
export { listVendored, lookupVendored, vendoredVersions, sharpBinaryName } from './vendor.js';
export {
  describeRuntime,
  hasCommand,
  linuxLibc,
  nodeAbi,
  platformSuffix,
  sharpPlatform,
} from './runtime.js';
export { sharpSystemRequirements, isPrebuiltPlatform } from './recipes/sharp.js';
export {
  VSCODE_RIPGREP_PACKAGE,
  isRipgrepPrebuilt,
  probeVscodeRipgrep,
  ripgrepPlatform,
  ripgrepPlatformPackage,
} from './recipes/ripgrep.js';
export { createLogger } from './log.js';
export const version = '0.1.0';
