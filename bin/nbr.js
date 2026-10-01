#!/usr/bin/env node
/**
 * nbr - native binding repair.
 *
 * Commands:
 *   nbr doctor            audit the current tree, change nothing
 *   nbr repair            repair every known package that is installed
 *   nbr repair sharp      repair one package
 *   nbr explain <log>     classify a captured failure log
 *   nbr prebuilds         list the bindings bundled with this tool
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { audit, repairPackage, KNOWN_PACKAGES } from '../lib/repair.js';
import { diagnose, guessFailingCommand } from '../lib/diagnose.js';
import { createLogger, paint } from '../lib/log.js';
import { describeRuntime, sharpPlatform, platformSuffix } from '../lib/runtime.js';
import { listVendored, vendoredVersions } from '../lib/vendor.js';
import { detectPackageManager, managerInstall, reportSystemDependencies } from '../lib/strategies.js';
import { sharpSystemRequirements } from '../lib/recipes/sharp.js';

const HELP = `nbr - repair missing native Node.js bindings

Usage
  nbr <command> [options]

Commands
  doctor [pkg]          report binding health without modifying anything
  repair [pkg]          locate and repair the native binding (default: all known)
  run -- <cmd>          run a command, repairing a missing binding and retrying
  hook install          register a preload so repairs happen automatically
  hook remove           unregister the preload
  explain <file|->      classify a captured error log and print the recommended fix
  prebuilds             list prebuilt bindings bundled with this tool
  deps [pkg]            report missing system libraries

Options
  --cwd <dir>           project directory to inspect (default: current directory)
  --dry-run             describe the actions without performing them
  --no-repair           with run: never attempt a repair
  --json                emit machine-readable JSON
  --verbose             include per-step detail
  --quiet               only report problems
  -h, --help            show this help
  -v, --version         show the tool version

Examples
  nbr doctor
  nbr repair sharp
  nbr repair @vscode/ripgrep
  nbr run -- dsh web
  dsh web 2>&1 | nbr explain -
  nbr repair --cwd /opt/app --verbose
`;

/**
 * Parse argv into a command plus options. The surface is deliberately tiny so
 * the tool can be invoked from a package.json script with no dependencies.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {
    command: '',
    args: [],
    cwd: process.cwd(),
    dryRun: false,
    json: false,
    verbose: false,
    quiet: false,
    help: false,
    version: false,
    repair: true,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Everything after `--` belongs to the wrapped command, untouched.
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    switch (arg) {
      case '--cwd':
        options.cwd = path.resolve(argv[++i] ?? process.cwd());
        break;
      case '--dry-run':
      case '-n':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--no-repair':
        options.repair = false;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        if (arg.startsWith('--cwd=')) options.cwd = path.resolve(arg.slice(6));
        else positional.push(arg);
    }
  }
  options.command = positional.shift() ?? '';
  options.args = positional;
  return options;
}

/**
 * Entry point.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logger = createLogger({ verbose: options.verbose, quiet: options.quiet });

  if (options.version) {
    logger.raw('0.1.1');
    return 0;
  }
  if (options.help || options.command === '' || options.command === 'help') {
    logger.raw(HELP);
    return 0;
  }

  switch (options.command) {
    case 'doctor':
      return commandDoctor(options, logger);
    case 'repair':
      return commandRepair(options, logger);
    case 'run':
      return commandRun(options, logger);
    case 'hook':
      return commandHook(options, logger);
    case 'explain':
      return commandExplain(options, logger);
    case 'prebuilds':
      return commandPrebuilds(options, logger);
    case 'deps':
      return commandDeps(options, logger);
    default:
      logger.error(`unknown command: ${options.command}`);
      logger.raw(HELP);
      return 2;
  }
}

/**
 * `run`: execute a command, repairing a missing binding and retrying once.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {import('../lib/log.js').Logger} logger
 */
async function commandRun(options, logger) {
  const [command, ...args] = options.args;
  if (!command) {
    logger.error('run requires a command, e.g. nbr run -- dsh web');
    return 2;
  }
  const { runWithRepair } = await import('../lib/wrap.js');
  const code = await runWithRepair({
    command,
    args,
    cwd: options.cwd,
    repair: options.repair,
    verbose: options.verbose,
    quiet: options.quiet,
    logger,
  });
  return code;
}

/**
 * `hook`: register or unregister the preload.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {import('../lib/log.js').Logger} logger
 */
async function commandHook(options, logger) {
  const action = options.args[0] ?? 'install';
  const { installHook, removeHook } = await import('../lib/hook.js');
  if (action === 'install') {
    const result = installHook({ cwd: options.cwd, logger, dryRun: options.dryRun });
    if (result.status === 'failed') {
      logger.error(result.detail);
      return 1;
    }
    logger.ok(result.detail);
    return 0;
  }
  if (action === 'remove' || action === 'uninstall') {
    const result = removeHook({ cwd: options.cwd, logger, dryRun: options.dryRun });
    if (result.status === 'failed') {
      logger.error(result.detail);
      return 1;
    }
    logger.ok(result.detail);
    return 0;
  }
  logger.error(`unknown hook action: ${action} (expected install or remove)`);
  return 2;
}

/**
 * `doctor`: audit and report.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {import('../lib/log.js').Logger} logger
 */
function commandDoctor(options, logger) {
  const target = options.args[0];
  const packages = target ? [target] : KNOWN_PACKAGES;
  if (!options.json) logger.step(`runtime: ${describeRuntime()}`);
  const reports = [];
  for (const packageName of packages) {
    reports.push(...audit({ packageName, cwd: options.cwd, verbose: options.verbose, logger, quietProbe: true }));
  }
  if (options.json) {
    logger.raw(JSON.stringify({ runtime: describeRuntime(), reports: summarize(reports) }, null, 2));
  } else {
    for (const report of reports) {
      if (report.outcome === 'already-working') {
        logger.ok(`${report.packageName}@${report.version} is healthy`);
      } else if (report.outcome === 'not-installed') {
        logger.info(`${report.packageName} is not installed in ${options.cwd}`);
      } else {
        logger.warn(`${report.packageName}@${report.version} needs repair`);
        for (const note of report.notes) logger.detail(note);
        for (const attempt of report.attempts) {
          if (attempt.status === 'applied' || attempt.status === 'skipped') {
            logger.detail(`${attempt.name}: ${attempt.detail}`);
          }
        }
        logger.info(`run: nbr repair ${report.packageName}`);
      }
    }
  }
  return reports.every((report) => report.outcome === 'already-working' || report.outcome === 'not-installed') ? 0 : 1;
}

/**
 * `repair`: apply strategies.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {import('../lib/log.js').Logger} logger
 */
function commandRepair(options, logger) {
  const target = options.args[0];
  const packages = target ? [target] : KNOWN_PACKAGES;
  const reports = [];
  for (const packageName of packages) {
    const report = repairPackage({
      packageName,
      cwd: options.cwd,
      dryRun: options.dryRun,
      verbose: options.verbose,
      logger,
    });
    reports.push(report);
    if (report.outcome === 'would-repair') {
      const plan = report.attempts.find((attempt) => attempt.status === 'applied');
      logger.step(`dry run: ${plan?.detail ?? `${report.packageName} can be repaired`}`);
    } else if (report.outcome === 'already-working') {
      logger.ok(`${report.packageName}@${report.version} is healthy`);
    }
  }
  if (options.json) {
    logger.raw(JSON.stringify({ runtime: describeRuntime(), reports: summarize(reports) }, null, 2));
  }
  const failed = reports.filter((report) => report.outcome === 'unrepaired');
  if (failed.length) {
    logger.error(`unrepaired: ${failed.map((report) => report.packageName).join(', ')}`);
    return 1;
  }
  return 0;
}

/**
 * `explain`: classify a captured log.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {import('../lib/log.js').Logger} logger
 */
function commandExplain(options, logger) {
  const source = options.args[0];
  if (!source) {
    logger.error('explain requires a file path or - to read stdin');
    return 2;
  }
  let text;
  if (source === '-') {
    text = fs.readFileSync(0, 'utf8');
  } else {
    if (!fs.existsSync(source)) {
      logger.error(`file not found: ${source}`);
      return 2;
    }
    text = fs.readFileSync(source, 'utf8');
  }
  const verdict = diagnose(text, { runtime: sharpPlatform() });
  if (options.json) {
    logger.raw(JSON.stringify({ verdict, failingCommand: guessFailingCommand(text) }, null, 2));
    return verdict.kind === 'unknown' ? 1 : 0;
  }
  logger.step(`classification: ${verdict.kind}`);
  logger.info(verdict.summary);
  for (const line of verdict.evidence) logger.detail(line);
  logger.raw('');
  logger.raw(recommendation(verdict));
  return verdict.kind === 'unknown' ? 1 : 0;
}

/**
 * `prebuilds`: list bundled binaries.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {import('../lib/log.js').Logger} logger
 */
function commandPrebuilds(options, logger) {
  const entries = listVendored();
  if (options.json) {
    logger.raw(JSON.stringify({
      runtime: platformSuffix(),
      vendorTarget: sharpPlatform(),
      entries: entries.map(({ package: pkg, version, platform, file }) => ({ package: pkg, version, platform, file })),
    }, null, 2));
    return 0;
  }
  logger.step(`bundled prebuilt bindings (this runtime needs ${sharpPlatform()})`);
  if (entries.length === 0) {
    logger.info('none bundled');
    return 0;
  }
  for (const entry of entries) {
    const usable = entry.platform === sharpPlatform();
    const kind = entry.kind === 'executable' ? ' (executable)' : '';
    logger.raw(`  ${usable ? paint('green', '●') : paint('dim', '○')} ${entry.package}@${entry.version} ${entry.platform} ${paint('dim', `${entry.file}${kind}`)}`);
  }
  const sharpVersions = vendoredVersions('sharp');
  if (sharpVersions.length) logger.info(`sharp versions covered here: ${sharpVersions.join(', ')}`);
  return 0;
}

/**
 * `deps`: report missing system libraries.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {import('../lib/log.js').Logger} logger
 */
function commandDeps(options, logger) {
  const result = reportSystemDependencies({
    required: sharpSystemRequirements,
    logger: createLogger({ verbose: options.verbose, quiet: options.json }),
  });
  const manager = detectPackageManager();
  if (options.json) {
    logger.raw(JSON.stringify({
      manager,
      installCommand: managerInstall(manager),
      status: result.status,
      detail: result.detail,
    }, null, 2));
    return result.status === 'failed' ? 1 : 0;
  }
  logger.step(`system libraries for sharp`);
  if (result.status === 'noop') {
    logger.ok('all present');
    return 0;
  }
  logger.warn(result.detail);
  logger.info(`package manager: ${manager}`);
  return 1;
}

/**
 * Human-readable next step for a verdict.
 * @param {import('../lib/diagnose.js').Diagnosis} verdict
 * @returns {string}
 */
function recommendation(verdict) {
  switch (verdict.kind) {
    case 'unsupported-arch':
    case 'missing-prebuild':
      // sharp is the case that needs system headers; a package that resolves a
      // platform package (ripgrep) needs the platform package supplied instead,
      // and naming libvips there would send the reader down the wrong path.
      if (verdict.missingPackage?.startsWith('@vscode/ripgrep')) {
        return [
          'Recommended fix:',
          '  nbr repair @vscode/ripgrep',
          '',
          'This package resolves a platform package that was never published for',
          `your architecture (${verdict.missingPackage}). The repair supplies one`,
          'from the bundled ripgrep and places it where the resolver looks.',
        ].join('\n');
      }
      return [
        'Recommended fix:',
        '  nbr repair            # install a bundled prebuild, else build from source',
        '',
        'If this package does not ship a prebuild for your architecture, compiling it',
        'against the system library is usually the fastest route. On Debian/Ubuntu:',
        '  sudo apt-get install -y libvips-dev',
        '  nbr repair sharp',
      ].join('\n');
    case 'missing-system-library':
    case 'missing-shared-library':
      return [
        'Recommended fix:',
        `  install the missing library${verdict.missingSoname ? ` providing ${verdict.missingSoname}` : ''}`,
        verdict.missingLibrary ? `  sudo apt-get install -y ${verdict.missingLibrary}` : '  nbr deps',
      ].join('\n');
    case 'abi-mismatch':
      return [
        'Recommended fix:',
        '  rebuild the binding for this Node version:',
        '  nbr repair',
      ].join('\n');
    case 'module-not-found':
      return [
        'Recommended fix:',
        '  nbr repair            # build or install the missing compiled binding',
      ].join('\n');
    default:
      return [
        'No automatic fix is known for this failure.',
        'Re-run with --verbose, or open an issue with the full log.',
      ].join('\n');
  }
}

/**
 * Trim reports down to serializable essentials.
 * @param {import('../lib/repair.js').RepairReport[]} reports
 */
function summarize(reports) {
  return reports.map((report) => ({
    package: report.packageName,
    version: report.version,
    dir: report.packageDir,
    outcome: report.outcome,
    notes: report.notes,
    attempts: report.attempts,
  }));
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`nbr: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  },
);
