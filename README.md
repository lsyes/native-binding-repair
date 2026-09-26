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
| 2 | `node-gyp` build against system libraries | no | yes | no |
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

## Known cases this tool cannot fix

Some packages publish no native sources at all and deliberately "fail closed"
rather than compile an unvalidated binary. `node-addon-require-builtin` (used by
dsh for its HMR loader) is one: its README states that published installs do not
ship native sources. There is nothing to build, so the fix belongs with the
package that depends on it.

For dsh specifically, the HMR plugin needs `--expose-internals`, which Node
refuses to accept through `NODE_OPTIONS`. Either launch with the flag directly:

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
- For the build-from-source strategy only: a C/C++ toolchain and the relevant
  development headers (`libvips-dev` and `libglib2.0-dev` for sharp)

The tool reports the exact install command for your package manager when those
headers are missing.

## Environment variables

| Variable | Effect |
| --- | --- |
| `NBR_DISABLE=1` | Preload does nothing |
| `NBR_VERBOSE=1` | Preload logs what it repaired |
| `NBR_TEST_SHARP_DIR` | Where the test suite finds a sharp install to copy fixtures from |
| `NBR_TEST_VSCODE_RIPGREP_DIR` | Where the test suite finds a `@vscode/ripgrep` entry package to copy fixtures from |

## License

MIT
