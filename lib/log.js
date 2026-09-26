/**
 * Minimal leveled logger with stable prefixes so output stays scrapeable in CI.
 */

import process from 'node:process';

const colors = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

/**
 * Wrap text in an ANSI color when the terminal supports it.
 * @param {keyof typeof colors} name
 * @param {string} text
 * @returns {string}
 */
export function paint(name, text) {
  return useColor ? `${colors[name]}${text}${colors.reset}` : text;
}

/**
 * Create a logger sharing one verbosity configuration.
 * @param {{ verbose?: boolean, quiet?: boolean }} [options]
 */
export function createLogger(options = {}) {
  const verbose = Boolean(options.verbose);
  const quiet = Boolean(options.quiet);
  const write = (line) => process.stdout.write(`${line}\n`);
  const writeErr = (line) => process.stderr.write(`${line}\n`);

  return {
    /** @param {string} message */
    step(message) {
      if (!quiet) write(`${paint('cyan', 'nbr')} ${message}`);
    },
    /** @param {string} message */
    info(message) {
      if (!quiet) write(`  ${message}`);
    },
    /** @param {string} message */
    detail(message) {
      if (verbose && !quiet) write(`  ${paint('dim', message)}`);
    },
    /** @param {string} message */
    ok(message) {
      write(`  ${paint('green', '✓')} ${message}`);
    },
    /** @param {string} message */
    warn(message) {
      writeErr(`  ${paint('yellow', '!')} ${message}`);
    },
    /** @param {string} message */
    error(message) {
      writeErr(`  ${paint('red', '✗')} ${message}`);
    },
    /** @param {string} message */
    raw(message) {
      write(message);
    },
    get verbose() {
      return verbose;
    },
  };
}

/** @typedef {ReturnType<typeof createLogger>} Logger */

export default { createLogger, paint };
