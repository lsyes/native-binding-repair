/**
 * Run a command and, if it dies from a missing native binding, repair the
 * binding and run it again.
 *
 * This is the "never think about it again" path: the wrapper costs nothing when
 * the command works, and turns a hard failure into a one-time build plus a
 * transparent retry.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

import { diagnose } from './diagnose.js';
import { createLogger } from './log.js';
import { repairPackage } from './repair.js';
import { sharpPlatform } from './runtime.js';
import { NODE_ADDON_SYSTEM_PACKAGE } from './recipes/node-addon-system.js';
import { VSCODE_RIPGREP_PACKAGE } from './recipes/ripgrep.js';

/**
 * @typedef {object} WrapOptions
 * @property {string} command
 * @property {string[]} args
 * @property {string} [cwd]
 * @property {boolean} [repair]
 * @property {boolean} [verbose]
 * @property {boolean} [quiet]
 * @property {ReturnType<typeof createLogger>} [logger]
 * @property {Record<string, string | undefined>} [env]
 */

/**
 * Run a command, capturing output so a failure can be classified. Output is
 * streamed through as it arrives, so long-running commands behave normally;
 * a bounded tail is retained purely for failure classification.
 * @param {WrapOptions} options
 * @returns {Promise<number>} the exit code to propagate
 */
export async function runWithRepair(options) {
  const logger = options.logger ?? createLogger({ verbose: options.verbose, quiet: options.quiet });
  const first = await capture(options);

  if (first.code === 0) return 0;

  const verdict = diagnose(first.stderr || first.stdout, { runtime: sharpPlatform() });
  if (verdict.kind === 'unknown') return first.code;

  logger.warn(`${options.command} failed: ${verdict.summary}`);
  if (options.repair === false) return first.code;

  const packageName = packageNameFrom(verdict) ?? 'sharp';
  const report = repairPackage({
    packageName,
    cwd: options.cwd ?? process.cwd(),
    verbose: options.verbose,
    logger,
  });

  if (report.outcome !== 'repaired' && report.outcome !== 'already-working') {
    logger.error('automatic repair did not succeed; re-run without the wrapper to see the original error');
    return first.code;
  }

  logger.step(`retrying: ${options.command} ${options.args.join(' ')}`.trim());
  const second = await capture(options);
  return second.code;
}

/**
 * Spawn the command, forwarding both streams to this process as they arrive
 * while keeping a bounded tail of each for classification.
 * @param {WrapOptions} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function capture(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const stdout = new Tail();
    const stderr = new Tail();
    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: stdout.text, stderr: stderr.text }));
  });
}

/**
 * A bounded string buffer that keeps the most recent bytes. Failures report at
 * the end of a stream, so a tail window is the useful half to keep.
 */
class Tail {
  /** @param {number} [limit] */
  constructor(limit = 1 << 20) {
    this.limit = limit;
    this.text = '';
  }

  /** @param {Buffer | string} chunk */
  push(chunk) {
    this.text += chunk.toString();
    if (this.text.length > this.limit) this.text = this.text.slice(-this.limit);
  }
}

/**
 * Pick the package to repair out of a verdict.
 * @param {import('./diagnose.js').Diagnosis} verdict
 * @returns {string | undefined}
 */
function packageNameFrom(verdict) {
  const summary = verdict.summary.toLowerCase();
  if (summary.includes('sharp')) return 'sharp';
  if (verdict.missingPackage?.startsWith('@vscode/ripgrep')) return VSCODE_RIPGREP_PACKAGE;
  if (verdict.missingPackage?.startsWith(NODE_ADDON_SYSTEM_PACKAGE)) return NODE_ADDON_SYSTEM_PACKAGE;
  return verdict.missingPackage && !verdict.missingPackage.startsWith('@img/')
    ? verdict.missingPackage
    : undefined;
}

export default { runWithRepair };
