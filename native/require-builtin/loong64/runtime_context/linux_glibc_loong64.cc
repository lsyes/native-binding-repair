// LoongArch64 port for the upstream `node-addon-require-builtin` addon.
//
// Overlaid onto `packages/native/src/` of vendor/node-addon-require-builtin-src
// at build time; see lib/recipes/require-builtin.js. It mirrors the Linux
// glibc x86-64/arm64 readers: LoongArch64 follows the same Itanium-style member
// ABI, so `this` arrives in $a0 and the returned `v8::Local<T>` is a single
// pointer in $a0. The hidden struct-return pointer that the MSVC ABI needs is
// Windows-only and cannot reach this translation unit.

#include "helper.h"

namespace esplus::node::require_builtin {

Result<CurrentContextRead> ReadLinuxGlibcLoong64CurrentV8Context(
    void* isolate,
    const CurrentContextSymbols& symbols) {
  return ReadDirectCurrentV8Context("linux-glibc-loong64", isolate, symbols);
}

}  // namespace esplus::node::require_builtin
