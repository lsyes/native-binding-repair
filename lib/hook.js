/**
 * Zero-config installation into a project.
 *
 * `nbr hook install` appends a tiny preload to the project's package.json so
 * every `npm run` script, and any `node` run inside the project, repairs a
 * missing binding before the app hits it. The hook is deliberately small and
 * fails open: if anything about it is wrong, the app still starts normally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(here, 'preload.js');

/**
 * @typedef {object} HookResult
 * @property {'installed' | 'already-present' | 'removed' | 'absent' | 'failed'} status
 * @property {string} detail
 */

/**
 * Install the preload hook into a project's package.json.
 * @param {{ cwd: string, logger?: ReturnType<typeof createLogger>, dryRun?: boolean }} options
 * @returns {HookResult}
 */
export function installHook(options) {
  const logger = options.logger ?? createLogger();
  const manifestPath = path.join(options.cwd, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return { status: 'failed', detail: `no package.json in ${options.cwd}` };
  }
  let manifest;
  let original;
  try {
    original = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(original);
  } catch (error) {
    return { status: 'failed', detail: `cannot parse package.json: ${error.message}` };
  }

  // npm exposes this array to every `npm run` script, which is the least
  // invasive place to hook: no global state, no NODE_OPTIONS mutation, and it
  // disappears the moment the entry is removed.
  manifest.nbr = { ...(manifest.nbr ?? {}), autoRepair: true };
  const preload = `--require ${preloadPath}`;
  if (manifest.nbr?.preload === preload) {
    return { status: 'already-present', detail: 'nbr is already registered' };
  }
  // Register the preload path rather than rewriting the user's scripts. The
  // project opts in by running one of the generated helper scripts, which keeps
  // existing scripts byte-identical.
  const scripts = { ...(manifest.scripts ?? {}) };
  scripts['nbr:node'] = `node --require ${preloadPath}`;
  manifest.scripts = scripts;
  manifest.nbr = { ...(manifest.nbr ?? {}), autoRepair: true, preload };

  if (options.dryRun) {
    return { status: 'installed', detail: `would register nbr in ${manifestPath}` };
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  logger.detail(`registered nbr in ${manifestPath}`);
  return {
    status: 'installed',
    detail: `start your app with \`node --require ${preloadPath} <entrypoint>\` to auto-repair bindings`,
  };
}

/**
 * Remove the hook again.
 * @param {{ cwd: string, logger?: ReturnType<typeof createLogger>, dryRun?: boolean }} options
 * @returns {HookResult}
 */
export function removeHook(options) {
  const manifestPath = path.join(options.cwd, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return { status: 'failed', detail: `no package.json in ${options.cwd}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { status: 'failed', detail: `cannot parse package.json: ${error.message}` };
  }
  if (!manifest.nbr && !manifest.scripts?.['nbr:node']) {
    return { status: 'absent', detail: 'no nbr hook registered here' };
  }
  if (options.dryRun) {
    return { status: 'removed', detail: `would unregister nbr from ${manifestPath}` };
  }
  delete manifest.nbr;
  if (manifest.scripts) {
    delete manifest.scripts['nbr:node'];
    if (Object.keys(manifest.scripts).length === 0) delete manifest.scripts;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { status: 'removed', detail: `unregistered nbr from ${manifestPath}` };
}

export { preloadPath };
export default { installHook, preloadPath, removeHook };
