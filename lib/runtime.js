/**
 * Runtime introspection helpers.
 *
 * Everything here is intentionally dependency-free so the repair tool keeps
 * working on platforms where `npm install` itself is the fragile step (for
 * example loongarch64 hosts whose registry mirror has no matching prebuild).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Read the ELF interpreter of a binary, which is the cheapest reliable way to
 * tell glibc from musl on Linux.
 * @param {string} file
 * @returns {string | undefined}
 */
export function elfInterpreter(file) {
  try {
    const buf = fs.readFileSync(file);
    // e_ident: magic, class, data. Only little-endian 64/32-bit ELF is handled;
    // Node itself is never big-endian on Linux in practice.
    if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return undefined;
    const is64 = buf[4] === 2;
    const isLE = buf[5] === 1;
    if (!isLE) return undefined;
    const readWord = is64
      ? (offset) => Number(buf.readBigUInt64LE(offset))
      : (offset) => buf.readUInt32LE(offset);
    // 32-bit ELF has a different program-header offset; only 64-bit is needed here.
    if (!is64) return undefined;
    const phoff = readWord(0x20);
    const phentsize = buf.readUInt16LE(0x36);
    const phnum = buf.readUInt16LE(0x38);
    if (!phoff || !phentsize || !phnum) return undefined;
    for (let i = 0; i < phnum; i++) {
      const ph = phoff + i * phentsize;
      if (ph + phentsize > buf.length) break;
      const type = buf.readUInt32LE(ph);
      if (type !== 3) continue; // PT_INTERP
      const offset = readWord(ph + 0x08);
      const size = readWord(ph + 0x20);
      if (!offset || !size || offset + size > buf.length) return undefined;
      return buf.toString('utf8', offset, offset + size).replace(/\0+$/, '');
    }
  } catch {
    // Unreadable binaries simply have no interpreter information.
  }
  return undefined;
}

/**
 * Detect the C library backing the current Node process.
 * @returns {'glibc' | 'musl' | undefined}
 */
export function linuxLibc() {
  if (process.platform !== 'linux') return undefined;
  const interpreter = elfInterpreter(process.execPath);
  if (interpreter) return /musl/.test(interpreter) ? 'musl' : 'glibc';
  try {
    const maps = fs.readFileSync('/proc/self/maps', 'utf8');
    if (/musl/.test(maps)) return 'musl';
    if (/libc\.so\.6|libc-2\./.test(maps)) return 'glibc';
  } catch {
    // /proc is not always mounted (containers, some BSDs).
  }
  try {
    const report = process.report?.getReport?.();
    if (report?.header?.glibcVersionRuntime) return 'glibc';
  } catch {
    // Report generation is best-effort.
  }
  return undefined;
}

/**
 * The npm-style platform suffix used by the optionalDependency prebuild
 * convention (`linux-x64-gnu`, `darwin-arm64`, ...).
 * @returns {string}
 */
export function platformSuffix() {
  const { platform, arch } = process;
  if (platform === 'linux') {
    const libc = linuxLibc() === 'musl' ? 'musl' : 'gnu';
    return `linux-${arch}-${libc}`;
  }
  if (platform === 'win32') return `win32-${arch}-msvc`;
  return `${platform}-${arch}`;
}

/**
 * The prebuild directory suffix sharp uses (`linux-loong64`), which omits libc.
 * @returns {string}
 */
export function sharpPlatform() {
  const { platform, arch } = process;
  if (platform === 'linux' && linuxLibc() === 'musl') return `linuxmusl-${arch}`;
  return `${platform}-${arch}`;
}

/**
 * Node ABI tag, e.g. `node-v137`.
 * @returns {string}
 */
export function nodeAbi() {
  return `node-v${process.versions.modules}`;
}

/**
 * Run a command and return its trimmed stdout, or undefined when it fails.
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {string | undefined}
 */
export function tryExec(command, args = [], options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Whether a command exists on PATH.
 * @param {string} command
 * @returns {boolean}
 */
export function hasCommand(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return Boolean(tryExec(probe, [command]));
}

/**
 * Attempt to require a module, returning the error instead of throwing.
 * @param {string} request
 * @param {string} [from]
 * @returns {{ module?: unknown, error?: Error, resolved?: string }}
 */
export function tryRequire(request, from) {
  const req = from ? createRequire(pathToFileUrl(from)) : require;
  try {
    const resolved = req.resolve(request);
    return { module: req(request), resolved };
  } catch (error) {
    return { error: /** @type {Error} */ (error) };
  }
}

/**
 * Convert an absolute path to a file:// URL, tolerating platform differences.
 * @param {string} file
 * @returns {string}
 */
export function pathToFileUrl(file) {
  const normalized = path.resolve(file).replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

/**
 * `pkg-config` lookup that returns undefined instead of throwing.
 * @param {string} module
 * @param {...string} args
 * @returns {string | undefined}
 */
export function pkgConfig(module, ...args) {
  return tryExec('pkg-config', [...args, module]);
}

/**
 * Describe the running runtime in a single log line.
 * @returns {string}
 */
export function describeRuntime() {
  const libc = process.platform === 'linux' ? ` ${linuxLibc() ?? 'unknown-libc'}` : '';
  return `${process.platform}-${process.arch}${libc} node ${process.versions.node} (abi ${nodeAbi()})`;
}

/**
 * Run a command with inherited stdio, returning its exit status.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {number}
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export default {
  describeRuntime,
  elfInterpreter,
  hasCommand,
  linuxLibc,
  nodeAbi,
  pathToFileUrl,
  pkgConfig,
  platformSuffix,
  run,
  sharpPlatform,
  tryExec,
  tryRequire,
};
