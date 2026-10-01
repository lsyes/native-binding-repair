# native-binding-repair

Diagnose and automatically repair native Node.js bindings that are missing,
mismatched, or simply never published for your CPU architecture.

Native addons ship as prebuilt binaries per platform. When your platform is not
on that list — loongarch64 (`loong64`), riscv64, an older glibc, a new Node ABI —
the module fails at import time with a message like:

```
Error: Could not load the "sharp" module using the linux-loong64 runtime
```

The same thing happens to packages that ship a plain executable behind an
optional platform dependency. `@vscode/ripgrep`, which DSH's `grep` and `glob`
tools load lazily, has no package for loong64 at all, so every search fails:

```
Could not find @vscode/ripgrep-linux-loong64. Ensure optionalDependencies
are installed for this platform (linux-loong64).
```

This tool turns both classes of failure into a one-command fix. It prefers an
offline prebuild, falls back to compiling against your system libraries, and
never requires `sudo` for the repair itself.

## Quick start

```sh
# What is broken?
nbr doctor

# Fix it.
nbr repair

# Or repair one package (search tools are repaired this way too):
nbr repair @vscode/ripgrep

# Or run your app and let the wrapper fix it, then retry:
nbr run -- dsh web
```

To make repairs automatic from then on, register the preload:

```sh
nbr hook install
node --require native-binding-repair/preload your-app.js
```

## Why not just `npm rebuild`?

`npm rebuild` recompiles from source and needs a full toolchain plus development
headers. Both are often missing exactly where these failures happen. This tool
tries the cheapest option first:

| Order | Strategy | Needs network | Needs compiler | Needs root |
| --- | --- | --- | --- | --- |
| 1 | Bundled prebuild for this architecture | no | no | no |
| 2 | Compile from source (`node-gyp`, or the upstream sources) | no | yes | no |
| 3 | Platform optional dependency from the registry | yes | no | no |
| 4 | WebAssembly fallback | no | no | no |

A bundled prebuild is what makes the common case work offline and without a
compiler. When no bundle matches your platform, the tool tells you exactly which
system libraries to install rather than failing with a stack trace.

## Commands

### `nbr doctor [package]`

Reports binding health and changes nothing. Exits `0` when healthy, `1` when a
repair is needed, with `--json` for scripting. Resolution looks in the target
directory first, then in the global module roots, so a globally-installed CLI
such as `npm i -g dsh` is found without passing `--cwd`.

### `nbr repair [package]`

Applies strategies until the binding loads. Idempotent: a healthy tree is left
byte-for-byte alone, so it is safe in a postinstall script. Use `--dry-run` to
see the plan first.

With no argument it repairs every package it recognises: `sharp`,
`node-addon-require-builtin`, `@deepseek-ai/node-addon-system` and
`@vscode/ripgrep`.

### `nbr run -- <command>`

Runs your command with output streamed through unchanged. If it dies from a
missing binding, the wrapper repairs it and retries once. Exit codes and
`stdin`/`stdout`/`stderr` behave as if the wrapper were not there. This is the
right entry point for a long-running server such as `dsh web`.

### `nbr explain <file|->`

Classifies a captured failure log and prints the fix. Useful in bug reports:

```sh
dsh web 2>&1 | nbr explain -
```

### `nbr prebuilds`

Lists the bindings bundled with this installation and marks which ones match the
running runtime.

### `nbr hook install` / `nbr hook remove`

Registers or unregisters the preload in `package.json`. Existing scripts are
preserved exactly; removal restores the original manifest.

## Programmatic use

```js
import { repairPackage, diagnose } from 'native-binding-repair';

const report = repairPackage({ packageName: 'sharp' });
if (report.outcome === 'unrepaired') {
  console.error(report.notes.join('\n'));
  process.exitCode = 1;
}

// Classify an error you caught yourself.
console.log(diagnose(err).kind); // 'unsupported-arch' | 'abi-mismatch' | ...
```

## How the sharp repair works

sharp resolves its binary by exact filename, so the tool places a compiled
binding at the path sharp itself expects:

```
node_modules/sharp/src/build/Release/sharp-<platform>-<version>.node
```

Vendored binaries are keyed by package **and version**, so a binary built for one
sharp release is never copied into a different one. If the version does not
match, the tool falls through to building from source instead of installing
something subtly wrong.

## How the ripgrep repair works

`@vscode/ripgrep` ships no binary of its own. It builds a platform package name
from the running runtime and resolves the executable out of it:

```js
require.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/rg`)
```

That platform package is an *optional dependency*, published for x64, arm64,
arm, ia32, ppc64, s390x and riscv64 — never loong64. On loong64 npm installs the
entry package, skips the platform package, and the entry package throws as soon
as something asks it for a path:

```
Could not find @vscode/ripgrep-linux-loong64. Ensure optionalDependencies
are installed for this platform (linux-loong64).
```

The repair writes the missing platform package as a **sibling** of the entry
package, which is the only place Node's resolver looks:

```
node_modules/@vscode/ripgrep-<platform>-<arch>/
  package.json    <- the resolution target; without it Node still reports
                     "Cannot find module" even when bin/rg exists
  bin/rg          <- spawned directly by the consumer, so it must be executable
```

Note the name has no libc suffix: it is `linux-loong64`, not
`linux-loong64-gnu`. The manifest deliberately declares no `exports` map, since
the consumer resolves an internal subpath that an exports map would forbid.

The binary is vendored as a plain executable rather than a `.node` addon, and
the registry records that distinction, so a caller never tries to `require` it.
Vendored as `vendor/@vscode/ripgrep/<version>/<platform>/rg`; supplying your own
copy is a matter of dropping a `rg` there.

In DSH this failure is unusually quiet: the entry package is imported lazily by
the `grep` and `glob` tools, so the process starts normally and only the search
tools fail, with `SEARCH_FAILED` pointing at the tool rather than at the missing
binary.

## How the require-builtin repair works

`node-addon-require-builtin` is how `dsh` reaches Node's internal module loader.
It ships one prebuilt `.node` per platform behind an optional dependency, and
that list stops at darwin, linux-x64, linux-arm64 and win32: there is no
loong64 binary, and upstream's installer deliberately fails closed rather than
compile an unvalidated one at install time. There is a loong64 local-build
fallback path, though, and `node-addon-native-custom-loader` derives it from
the runtime, so the repair only has to put a binding there:

```
node_modules/node-addon-require-builtin/build/napi/napi-v9-<platform>/require_builtin.node
```

Upstream (`github.com/deepseek-ai/dsh-node-addon-require-builtin`) is public, so
the repair compiles the real addon rather than a look-alike. Two pieces make
that work:

- The source tree is vendored as the git submodule
  `vendor/node-addon-require-builtin-src`, pinned to the revision the overlay
  was written against. On Linux upstream builds with a plain `c++ -shared`
  invocation, so no `pnpm`, `tsx` or `node-gyp` is involved and nothing needs
  the network.
- Upstream's N-API backend decodes the private getter's machine code per
  architecture, and has no LoongArch64 entry — a stock source build loads and
  then fails closed. `native/require-builtin/loong64/` is that missing port: it
  recognizes the framed `ld.d $a0, $a0, imm; ...; ret` accessor LoongArch64 Node
  emits, plus the dispatch, declaration and arch-name lines it needs. The overlay
  is applied to a scratch copy of the submodule and every anchor must match
  exactly once, so a moved upstream revision fails loudly instead of compiling
  something subtly different. The node-addon-api headers upstream requires are
  vendored under `native/require-builtin/node-addon-api/` for the same reason.

The prebuild bundled with this tool is produced from that source by
`npm run build:prebuild`, which compiles it, files it under
`vendor/node-addon-require-builtin/<version>/<platform>/`, and then loads it back
and calls `requireBuiltin()` before reporting success. The build-from-source
strategy applies the same overlay for runtimes with no matching prebuild; it
needs the submodule checked out (`git submodule update --init`), a C++ toolchain
and Node headers.

### Verifying it

Upstream's `getNativeBindingInfo()` is a static descriptor compiled into the
addon, so a binary that `require`s cleanly can still fail the private runtime
probe. `nbr doctor` therefore calls `requireBuiltin()` itself; that call is the
only thing that proves the probe resolved.

With the binding repaired, `dsh`'s HMR service no longer needs
`--expose-internals`: `@deepseek-ai/cordis-plugin-loader` and `dsh-app-boot`
both fall back to `require('node-addon-require-builtin').requireBuiltin(id)`,
which now works in a plain process.

If a repair is not possible — the submodule is not checked out and no prebuild
matches the runtime — the older workarounds still apply. Either launch with the
flag directly:

```sh
node --expose-internals "$(command -v dsh)" web
```

or set the profile to reload patches at startup instead of live, in
`~/.dsh/profiles/web/package.json`:

```json
{ "dsh": { "profile": { "patchReload": "startup" } } }
```

## Requirements

- Node.js 20.9 or newer
- For the build-from-source strategies only:
  - a C/C++ toolchain plus Node's public headers (`<prefix>/include/node`)
  - for sharp, the relevant development headers (`libvips-dev` and
    `libglib2.0-dev`)
  - for `node-addon-require-builtin`, the upstream submodule checked out
    (`git submodule update --init vendor/node-addon-require-builtin-src`); the
    node-addon-api headers it needs are vendored here

The tool reports the exact install command for your package manager when those
headers are missing.

## Development

The upstream source for `node-addon-require-builtin` is a submodule:

```sh
git clone --recurse-submodules <this repository>
# or, in an existing checkout:
git submodule update --init vendor/node-addon-require-builtin-src
```

Regenerate the bundled loong64 prebuild from that source with:

```sh
npm run build:prebuild
```

## Environment variables

| Variable | Effect |
| --- | --- |
| `NBR_DISABLE=1` | Preload does nothing |
| `NBR_VERBOSE=1` | Preload logs what it repaired |
| `NBR_TEST_SHARP_DIR` | Where the test suite finds a sharp install to copy fixtures from |
| `NBR_TEST_VSCODE_RIPGREP_DIR` | Where the test suite finds a `@vscode/ripgrep` entry package to copy fixtures from |
| `NBR_TEST_REQUIRE_BUILTIN_DIR` | Where the test suite finds a `node-addon-require-builtin` entry package to copy fixtures from |
| `CXX` | Compiler used by the `node-addon-require-builtin` source build (defaults to `c++`, then `g++`, `clang++`) |
| `NODE_INCLUDE_DIR` | Node public headers directory, when they are not under the running Node prefix |

## License

GPL-3.0
