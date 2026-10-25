/**
 * Follow the upstream `node-addon-require-builtin` source and rebuild the
 * LoongArch64 prebuild that this tool vendors.
 *
 * Upstream has no LoongArch64 release and no stable source-build contract. An
 * update therefore has to be transactional: fetch a release, update the
 * submodule, verify that the overlay still applies, compile, probe the result,
 * and only then update the pinned commit in the repair recipe. A failed update
 * restores the previous submodule commit, prebuild and pin.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createLogger } from './log.js';
import {
  REQUIRE_BUILTIN_BINARY_NAME,
  REQUIRE_BUILTIN_UPSTREAM_DIR,
} from './recipes/require-builtin.js';
import { sharpPlatform } from './runtime.js';
import { vendorRoot } from './vendor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const recipeFile = path.join(here, 'recipes', 'require-builtin.js');
const rebuildScript = path.join(packageRoot, 'scripts', 'build-require-builtin-prebuild.js');
const commitPattern = /(export const REQUIRE_BUILTIN_UPSTREAM_COMMIT\s*=\s*\n\s*')([0-9a-f]{40})(';)/;

/**
 * @typedef {object} UpstreamUpdateReport
 * @property {'up-to-date' | 'update-available' | 'would-update' | 'updated' | 'failed'} status
 * @property {string} detail
 * @property {string} currentCommit
 * @property {string} targetCommit
 * @property {string} currentVersion
 * @property {string} targetVersion
 * @property {string} [artifact]
 * @property {boolean} [rolledBack]
 */

/**
 * Fetch the configured upstream branch, update the vendored checkout, and
 * rebuild the current runtime's prebuild.
 *
 * `check` stops after reporting whether the checkout is behind. `dryRun`
 * additionally describes the exact checkout/build it would perform.
 * `force` rebuilds even when the checkout already points at the remote head.
 *
 * @param {{
 *   repoDir?: string,
 *   vendorRoot?: string,
 *   pinFile?: string,
 *   remote?: string,
 *   branch?: string,
 *   check?: boolean,
 *   dryRun?: boolean,
 *   force?: boolean,
 *   captureOutput?: boolean,
 *   logger?: ReturnType<typeof createLogger>,
 *   rebuild?: (context: {
 *     repoDir: string,
 *     commit: string,
 *     version: string,
 *     artifact: string,
 *     logger: ReturnType<typeof createLogger>,
 *     captureOutput: boolean,
 *   }) => void | { ok?: boolean, detail?: string }
 * }} [options]
 * @returns {UpstreamUpdateReport}
 */
export function updateRequireBuiltinUpstream(options = {}) {
  const logger = options.logger ?? createLogger();
  const repoDir = options.repoDir ?? REQUIRE_BUILTIN_UPSTREAM_DIR;
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? 'master';
  const vendorDir = options.vendorRoot ?? vendorRoot;
  const pinFile = options.pinFile ?? recipeFile;

  if (!fs.existsSync(path.join(repoDir, 'package.json'))) {
    return failed(`upstream source checkout is missing: ${repoDir}`);
  }

  const currentCommit = gitText(repoDir, ['rev-parse', 'HEAD']);
  if (!currentCommit) {
    return failed(`cannot read the current upstream commit from ${repoDir}`);
  }
  const currentVersion = readManifestVersion(path.join(repoDir, 'package.json')) ?? 'unknown';

  const status = git(repoDir, ['status', '--porcelain', '--untracked-files=no']);
  if (status.error) {
    return failed(`cannot inspect the upstream checkout: ${status.error.message}`);
  }
  const dirty = status.stdout.trim();

  logger.step(`checking ${remote}/${branch} for a newer node-addon-require-builtin`);
  const fetched = git(repoDir, ['fetch', remote, branch]);
  if (fetched.status !== 0) {
    return failed(`git fetch ${remote} ${branch} failed: ${lastLine(fetched.stderr || fetched.stdout)}`);
  }

  const targetCommit = gitText(repoDir, ['rev-parse', `${remote}/${branch}`]);
  if (!targetCommit) {
    return failed(`cannot resolve ${remote}/${branch}`);
  }
  const targetManifest = gitText(repoDir, ['show', `${targetCommit}:package.json`]);
  const targetVersion = parseManifestVersion(targetManifest);
  if (!targetVersion) {
    return failed(`upstream commit ${short(targetCommit)} has no readable package version`);
  }

  const changed = currentCommit !== targetCommit;
  const base = {
    currentCommit,
    targetCommit,
    currentVersion,
    targetVersion,
  };

  if (!changed && !options.force) {
    logger.ok(`upstream ${targetVersion} is current (${short(targetCommit)})`);
    return {
      ...base,
      status: 'up-to-date',
      detail: `node-addon-require-builtin ${targetVersion} is already current`,
    };
  }

  if (options.check) {
    const detail = changed
      ? `node-addon-require-builtin ${targetVersion} is available at ${short(targetCommit)}`
      : `node-addon-require-builtin ${targetVersion} is current; --force would rebuild it`;
    logger.info(detail);
    return { ...base, status: changed ? 'update-available' : 'up-to-date', detail };
  }

  if (dirty) {
    return failed(
      `upstream checkout has local changes; commit or discard them before updating:\n${dirty}`,
      base,
    );
  }

  const artifact = path.join(
    vendorDir,
    'node-addon-require-builtin',
    targetVersion,
    sharpPlatform(),
    REQUIRE_BUILTIN_BINARY_NAME,
  );

  if (options.dryRun) {
    const detail = `would update ${short(currentCommit)} -> ${short(targetCommit)} `
      + `(${currentVersion} -> ${targetVersion}) and rebuild ${artifact}`;
    logger.info(detail);
    return { ...base, status: 'would-update', detail, artifact };
  }

  let pinText;
  try {
    pinText = fs.readFileSync(pinFile, 'utf8');
  } catch (error) {
    return failed(`cannot read the upstream pin ${pinFile}: ${error.message}`, base);
  }
  const pinMatch = pinText.match(commitPattern);
  if (!pinMatch) {
    return failed(`cannot find REQUIRE_BUILTIN_UPSTREAM_COMMIT in ${pinFile}`, base);
  }

  let backup;
  try {
    backup = backupArtifact(artifact);
  } catch (error) {
    return failed(`cannot back up the existing prebuild: ${error.message}`, base);
  }
  let checkoutChanged = false;
  let pinChanged = false;
  try {
    if (changed) {
      const checkout = git(repoDir, ['checkout', '--detach', targetCommit]);
      if (checkout.status !== 0) {
        throw new Error(`git checkout ${short(targetCommit)} failed: ${lastLine(checkout.stderr)}`);
      }
      checkoutChanged = true;
    }

    const rebuild = options.rebuild ?? rebuildVendoredPrebuild;
    const result = rebuild({
      repoDir,
      commit: targetCommit,
      version: targetVersion,
      artifact,
      logger,
      captureOutput: Boolean(options.captureOutput),
    });
    if (result === false || result?.ok === false) {
      throw new Error(result?.detail || 'the prebuild rebuild failed');
    }
    if (!fs.existsSync(artifact)) {
      throw new Error(`the rebuild completed without producing ${artifact}`);
    }

    const nextPinText = pinText.replace(commitPattern, `$1${targetCommit}$3`);
    if (nextPinText !== pinText) {
      pinChanged = true;
      fs.writeFileSync(pinFile, nextPinText);
    }

    logger.ok(`updated upstream to ${targetVersion} (${short(targetCommit)})`);
    logger.ok(`rebuilt ${artifact}`);
    return {
      ...base,
      status: 'updated',
      detail: `updated node-addon-require-builtin ${currentVersion} -> ${targetVersion}`,
      artifact,
    };
  } catch (error) {
    restoreFile(pinFile, pinText, pinChanged);
    restoreArtifact(artifact, backup.artifact);
    let rolledBack = true;
    if (checkoutChanged) {
      const rollback = git(repoDir, ['checkout', '--detach', currentCommit]);
      rolledBack = rollback.status === 0;
      if (rollback.status !== 0) {
        logger.warn(`rollback to ${short(currentCommit)} failed: ${lastLine(rollback.stderr)}`);
      }
    }
    logger.warn(`update failed and was rolled back to ${short(currentCommit)}`);
    return failed(`${error.message}; rolled back to ${short(currentCommit)}`, {
      ...base,
      rolledBack,
    });
  } finally {
    if (backup.directory) fs.rmSync(backup.directory, { recursive: true, force: true });
  }
}

/**
 * Run the existing prebuild script as a child process so its compiler output
 * remains separate from the updater's transaction logic.
 *
 * @param {{
 *   logger: ReturnType<typeof createLogger>,
 *   captureOutput: boolean,
 * }} context
 * @returns {{ ok: boolean, detail?: string }}
 */
function rebuildVendoredPrebuild(context) {
  context.logger.info('compiling and probing the new prebuild');
  const result = spawnSync(process.execPath, [rebuildScript], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: context.captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) {
    return { ok: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      detail: `prebuild script exited with status ${result.status}: `
        + lastLine(String(result.stderr || result.stdout || '')),
    };
  }
  return { ok: true };
}

/**
 * Save the current prebuild so a failed transaction can restore it
 * byte-for-byte. The pin text is already held in memory by the caller.
 *
 * @param {string} artifact
 * @returns {{ directory?: string, artifact?: string }}
 */
function backupArtifact(artifact) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nbr-upstream-backup-'));
  let artifactBackup;
  if (fs.existsSync(artifact)) {
    artifactBackup = path.join(directory, 'require_builtin.node');
    fs.copyFileSync(artifact, artifactBackup);
  }
  return { directory, artifact: artifactBackup };
}

/**
 * Restore a file only when the current operation changed it.
 * @param {string} file
 * @param {string | undefined} previous
 * @param {boolean} changed
 */
function restoreFile(file, previous, changed) {
  if (!changed || previous === undefined) return;
  fs.writeFileSync(file, previous);
}

/**
 * Restore a pre-existing artifact, or remove the one created by a failed run.
 * @param {string} artifact
 * @param {string | undefined} previous
 */
function restoreArtifact(artifact, previous) {
  if (previous) {
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.copyFileSync(previous, artifact);
  } else {
    fs.rmSync(artifact, { force: true });
  }
}

/**
 * Run git and capture both streams without throwing.
 * @param {string} repoDir
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string, error?: Error }}
 */
function git(repoDir, args) {
  const result = spawnSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

/**
 * Trimmed stdout from a successful git command.
 * @param {string} repoDir
 * @param {string[]} args
 * @returns {string | undefined}
 */
function gitText(repoDir, args) {
  const result = git(repoDir, args);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * @param {string} file
 * @returns {string | undefined}
 */
function readManifestVersion(file) {
  try {
    return parseManifestVersion(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * @param {string | undefined} text
 * @returns {string | undefined}
 */
function parseManifestVersion(text) {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text).version;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a failed report with the common fields filled in.
 * @param {string} detail
 * @param {{ currentCommit?: string, targetCommit?: string, currentVersion?: string, targetVersion?: string, rolledBack?: boolean }} [fields]
 * @returns {UpstreamUpdateReport}
 */
function failed(detail, fields = {}) {
  return {
    status: 'failed',
    detail,
    currentCommit: fields.currentCommit ?? '',
    targetCommit: fields.targetCommit ?? '',
    currentVersion: fields.currentVersion ?? '',
    targetVersion: fields.targetVersion ?? '',
    rolledBack: fields.rolledBack ?? false,
  };
}

/**
 * Last non-empty line, used to keep subprocess errors readable.
 * @param {string} text
 * @returns {string}
 */
function lastLine(text) {
  return text.trim().split('\n').filter(Boolean).at(-1) ?? 'no diagnostic output';
}

/**
 * @param {string} commit
 * @returns {string}
 */
function short(commit) {
  return commit.slice(0, 12);
}

export default { updateRequireBuiltinUpstream };
