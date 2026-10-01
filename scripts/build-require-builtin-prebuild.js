#!/usr/bin/env node
/**
 * Regenerate the vendored `node-addon-require-builtin` prebuild.
 *
 * Upstream publishes binaries only for darwin/linux-x64/linux-arm64/win32, so
 * the runtime this tool was written for (linux-loong64) has no registry
 * artefact to fall back on. This script compiles the real upstream addon from
 * the source submodule with the LoongArch64 overlay applied and files the result
 * where `nbr repair` looks for an offline prebuild:
 *
 *   vendor/node-addon-require-builtin/<version>/<platform>/require_builtin.node
 *
 * It is a development tool, not part of the repair path:
 *
 *   node scripts/build-require-builtin-prebuild.js
 *
 * The version directory comes from the upstream workspace manifest, which is
 * also the version the published entry package uses.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { buildRequireBuiltin } from '../lib/strategies.js';
import {
  REQUIRE_BUILTIN_BINARY_NAME,
  REQUIRE_BUILTIN_UPSTREAM_DIR,
  probeRequireBuiltin,
  requireBuiltinBindingPath,
} from '../lib/recipes/require-builtin.js';
import { platformSuffix, sharpPlatform } from '../lib/runtime.js';
import { vendorRoot } from '../lib/vendor.js';

const upstreamVersion = readJson(path.join(REQUIRE_BUILTIN_UPSTREAM_DIR, 'package.json'))?.version;
if (!upstreamVersion) {
  console.error(`cannot read the upstream version from ${REQUIRE_BUILTIN_UPSTREAM_DIR}/package.json`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nbr-prebuild-'));
const packageDir = path.join(scratch, 'node_modules', 'node-addon-require-builtin');

try {
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify({ name: 'node-addon-require-builtin', version: upstreamVersion, main: 'lib/index.js' }, null, 2)}\n`,
  );

  const report = buildRequireBuiltin({ packageDir });
  console.log(`${report.status}: ${report.detail}`);
  if (report.status !== 'applied') process.exit(1);

  const built = requireBuiltinBindingPath(packageDir, platformSuffix());
  const destinationDir = path.join(vendorRoot, 'node-addon-require-builtin', upstreamVersion, sharpPlatform());
  const destination = path.join(destinationDir, REQUIRE_BUILTIN_BINARY_NAME);
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(built, destination);
  fs.chmodSync(destination, 0o755);

  // Load the artefact back and make the private probe run: for this addon that
  // means actually calling requireBuiltin, not just dlopen-ing the binary.
  const probe = probeRequireBuiltin(packageDir, { bindingPath: built, direct: true });
  if (!probe.ok) {
    console.error(`built binding failed its probe: ${probe.error?.message ?? 'unknown error'}`);
    process.exit(1);
  }

  console.log(`wrote ${path.relative(process.cwd(), destination)} (${fs.statSync(destination).size} bytes)`);
  console.log(`probe: ${probe.summary}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

/**
 * Read a JSON file, returning undefined instead of throwing.
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
