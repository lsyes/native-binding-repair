# Vendored node-addon-api headers

The upstream `node-addon-require-builtin` N-API backend includes `<napi.h>`, so
compiling it from source needs the node-addon-api headers. Upstream declares
`node-addon-api: ^8.9.0`; version 7 does not provide the
`Napi::String::New(napi_env, std::string_view)` overload upstream uses, so an
older copy on the machine fails to compile.

These four headers are copied verbatim from the published
`node-addon-api@8.9.2` tarball (`npm pack node-addon-api@8.9.2`):

- `napi.h`
- `napi-inl.h`
- `napi-inl.deprecated.h`
- `package.json` (kept only so the build can read the version)
- `LICENSE.md` (MIT, retained as required)

Only the headers are vendored; the package's `tools/`, gyp files and JavaScript
entry point are not needed by a direct `c++ -shared` compile. They live here
rather than in `node_modules` so the source-build strategy works offline, with
a version this overlay is known to compile against.
