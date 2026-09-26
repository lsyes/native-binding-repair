/**
 * require_builtin — native binding for `node-addon-require-builtin` on
 * LoongArch64 (loong64).
 *
 * The upstream package ships a prebuilt binary per platform and no portable
 * source path: every published build resolves Node's internal
 * `requireBuiltin()` at runtime by locating the
 * `node::PrincipalRealm::builtin_module_require()` getter, decoding the field
 * offset out of that getter's machine code, and reading the field out of the
 * realm belonging to the current v8 context. Upstream publishes no binary for
 * linux-loong64, which is what breaks `dsh`'s HMR loader on this machine.
 *
 * This file implements the same N-API contract for loong64, so the loader in
 * `node-addon-native-custom-loader` accepts it as a local build. Two
 * deliberate differences from the upstream x64/x86/arm64 probes:
 *
 *   1. The exported getter is *called* instead of decoding its address
 *      arithmetic. Node's loong64 builds export `node::Realm::GetCurrent()`
 *      and `PrincipalRealm::builtin_module_require()` as dynamic symbols, and
 *      both are leaf functions taking a single pointer and returning a single
 *      pointer, so they can be called directly:
 *
 *          _ZNK4node14PrincipalRealm22builtin_module_requireEv:
 *              ld.d  $a0, $a0, 520
 *              ret
 *
 *      Calling the symbol keeps working when the field offset changes between
 *      Node releases, which is the failure mode a hardcoded offset would have.
 *   2. The resolved value is verified through N-API (`typeof === 'function'`
 *      and `name === 'requireBuiltin'`) rather than through v8 internals, so a
 *      wrong field or a wrong realm fails closed with a diagnostic instead of
 *      firing a stray pointer.
 *
 * Everything else matches the upstream variant: `requireBuiltin(id)` forwards
 * any internal module id, `isAllowedInternalId(id)` reports `true`, and
 * `getNativeBindingInfo()` describes the binary to the loader.
 */

#include <node_api.h>
#include <node_version.h>
#include <v8.h>

#include <dlfcn.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr const char* kProduct = "node-addon-require-builtin";
constexpr const char* kMode = "runtime-probe";
constexpr const char* kBackend = "napi";
constexpr const char* kAbi = "napi-v9";
constexpr int kNapiVersion = 9;

/** `node::Realm::GetCurrent(v8::Local<v8::Context>)`. */
constexpr const char* kRealmGetCurrentSymbol =
    "_ZN4node5Realm10GetCurrentEN2v85LocalINS1_7ContextEEE";

/**
 * Getter candidates, most specific first. Both realms keep
 * `builtin_module_require` in the same slot, and the shadow realm getter adds
 * a type check, so either is an acceptable source for the function.
 */
constexpr const char* kGetterSymbols[] = {
    "_ZNK4node14PrincipalRealm22builtin_module_requireEv",
    "_ZNK4node12shadow_realm11ShadowRealm22builtin_module_requireEv",
};

constexpr const char* kExpectedFunctionName = "requireBuiltin";

// ---------------------------------------------------------------------------
// napi_value <-> v8::Local<v8::Value>
//
// Node defines napi_value as the tagged pointer that a v8::Local<v8::Value>
// stores; src/js_native_api_v8.h does exactly these two conversions in
// JsValueFromV8LocalValue()/V8LocalValueFromJsValue(). Reusing the same
// representation is what lets the internal v8 function found by the probe be
// handed to N-API calls without re-creating it.
// ---------------------------------------------------------------------------

inline napi_value ToNapi(v8::Local<v8::Value> value) {
  return reinterpret_cast<napi_value>(*value);
}

inline v8::Local<v8::Value> LocalFromPointer(void* pointer) {
  static_assert(sizeof(v8::Local<v8::Value>) == sizeof(pointer),
                "v8::Local must stay a single tagged pointer");
  v8::Local<v8::Value> local;
  std::memcpy(&local, &pointer, sizeof(pointer));
  return local;
}

inline v8::Local<v8::Value> ToV8(napi_value value) {
  static_assert(sizeof(v8::Local<v8::Value>) == sizeof(value),
                "napi_value must stay a single tagged pointer");
  v8::Local<v8::Value> local;
  std::memcpy(&local, &value, sizeof(value));
  return local;
}

// ---------------------------------------------------------------------------
// Runtime probe
// ---------------------------------------------------------------------------

/** Call signature of the realm accessor: pointer in, pointer out. */
using RealmGetCurrentFn = void* (*)(void* context);
/** Call signature of the getter: `this` in, tagged function pointer out. */
using BuiltinRequireGetterFn = void* (*)(void* realm);

struct Probe {
  bool ok = false;
  std::string message;
  napi_ref ref = nullptr;
  std::string getterSymbol;
  void* getterAddress = nullptr;
  void* realm = nullptr;
  bool hasContext = false;
};

/**
 * Read a property off a resolved value and compare it to a literal. Used to
 * confirm that the field the getter returned really is Node's internal
 * requireBuiltin before the pointer is ever called.
 */
bool HasStringProperty(napi_env env, napi_value value, const char* property,
                       const char* expected) {
  napi_value field = nullptr;
  if (napi_get_named_property(env, value, property, &field) != napi_ok) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, field, nullptr, 0, &length) != napi_ok) return false;
  std::string text(length, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, field, text.data(), length + 1, &copied) != napi_ok) {
    return false;
  }
  return text == expected;
}

/** Run the probe once per napi_env and cache the resolved function. */
void RunProbe(napi_env env, Probe* probe) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  if (isolate == nullptr) {
    probe->message = "no current v8 isolate";
    return;
  }
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  probe->hasContext = !context.IsEmpty();
  if (!probe->hasContext) {
    probe->message = "no current v8 context";
    return;
  }

  RealmGetCurrentFn getRealm = reinterpret_cast<RealmGetCurrentFn>(
      dlsym(RTLD_DEFAULT, kRealmGetCurrentSymbol));
  if (getRealm == nullptr) {
    probe->message =
        "node::Realm::GetCurrent(v8::Local<v8::Context>) is not exported by this Node build";
    return;
  }

  // The argument is the tagged context pointer the local holds, which is what
  // the getter receives in $a0.
  probe->realm = getRealm(*context);
  if (probe->realm == nullptr) {
    probe->message = "node::Realm::GetCurrent() returned no realm for the current context";
    return;
  }

  std::vector<std::string> tried;
  for (const char* symbol : kGetterSymbols) {
    tried.emplace_back(symbol);
    void* address = dlsym(RTLD_DEFAULT, symbol);
    if (address == nullptr) continue;
    BuiltinRequireGetterFn getter = reinterpret_cast<BuiltinRequireGetterFn>(address);
    void* candidate = getter(probe->realm);
    if (candidate == nullptr) continue;

    napi_value value = ToNapi(LocalFromPointer(candidate));
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_function) continue;
    if (!HasStringProperty(env, value, "name", kExpectedFunctionName)) continue;

    if (napi_create_reference(env, value, 1, &probe->ref) != napi_ok) {
      probe->message = "could not create a strong reference to the internal requireBuiltin";
      return;
    }
    probe->getterSymbol = symbol;
    probe->getterAddress = address;
    probe->ok = true;
    return;
  }

  probe->message = "no exported builtin_module_require getter produced requireBuiltin";
  for (const std::string& symbol : tried) probe->message += "\n  tried: " + symbol;
}

void FinalizeProbe(napi_env env, void* data, void* /*hint*/) {
  Probe* probe = static_cast<Probe*>(data);
  if (probe == nullptr) return;
  if (probe->ref != nullptr) napi_delete_reference(env, probe->ref);
  delete probe;
}

/** Fetch (and on first use run) the per-env probe. */
Probe* ProbeFor(napi_env env) {
  void* data = nullptr;
  if (napi_get_instance_data(env, &data) != napi_ok) return nullptr;
  if (data != nullptr) return static_cast<Probe*>(data);
  Probe* probe = new Probe();
  if (napi_set_instance_data(env, probe, FinalizeProbe, nullptr) != napi_ok) {
    delete probe;
    return nullptr;
  }
  RunProbe(env, probe);
  return probe;
}

napi_value ThrowProbeFailure(napi_env env, const Probe* probe) {
  std::string message = "node-addon-require-builtin: internal requireBuiltin is unavailable";
  if (probe != nullptr && !probe->message.empty()) message += ": " + probe->message;
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

napi_value RequireBuiltin(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok) {
    return ThrowProbeFailure(env, nullptr);
  }
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "requireBuiltin(moduleId) requires a module id");
    return nullptr;
  }

  Probe* probe = ProbeFor(env);
  if (probe == nullptr || !probe->ok) return ThrowProbeFailure(env, probe);

  napi_value function = nullptr;
  if (napi_get_reference_value(env, probe->ref, &function) != napi_ok || function == nullptr) {
    return ThrowProbeFailure(env, probe);
  }
  napi_value receiver = nullptr;
  napi_get_undefined(env, &receiver);

  napi_value result = nullptr;
  // A pending exception from the callee is reported as napi_pending_exception;
  // returning nullptr then propagates the original error untouched.
  if (napi_call_function(env, receiver, function, 1, args, &result) != napi_ok) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return nullptr;
    return ThrowProbeFailure(env, probe);
  }
  return result;
}

napi_value IsAllowedInternalId(napi_env env, napi_callback_info /*info*/) {
  // The unrestricted variant forwards every id; filtering is the caller's job.
  napi_value allowed = nullptr;
  napi_get_boolean(env, true, &allowed);
  return allowed;
}

napi_value GetNativeBindingInfo(napi_env env, napi_callback_info /*info*/) {
  Probe* probe = ProbeFor(env);

  napi_value info = nullptr;
  napi_create_object(env, &info);

  struct Field {
    const char* name;
    const char* value;
  };
  const Field strings[] = {
      {"mode", probe != nullptr && probe->ok ? kMode : "unavailable"},
      {"product", kProduct},
      {"backend", kBackend},
      {"abi", kAbi},
      {"binary_abi", kAbi},
      {"node", NODE_VERSION_STRING},
      {"platform", "linux"},
      {"arch", "loong64"},
  };
  for (const Field& field : strings) {
    napi_value value = nullptr;
    napi_create_string_utf8(env, field.value, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, info, field.name, value);
  }

  napi_value number = nullptr;
  napi_create_int32(env, kNapiVersion, &number);
  napi_set_named_property(env, info, "napi_version", number);

  napi_value flag = nullptr;
  napi_get_boolean(env, true, &flag);
  napi_set_named_property(env, info, "uses_node_addon_api", flag);

  napi_get_boolean(env, probe != nullptr && probe->hasContext, &flag);
  napi_set_named_property(env, info, "has_v8_context", flag);

  napi_get_boolean(env, probe != nullptr && probe->ok, &flag);
  napi_set_named_property(env, info, "require_builtin_resolved", flag);

  if (probe != nullptr && !probe->getterSymbol.empty()) {
    napi_value value = nullptr;
    napi_create_string_utf8(env, probe->getterSymbol.c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, info, "getter_symbol_name", value);
  }
  if (probe != nullptr && probe->getterAddress != nullptr) {
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%p", probe->getterAddress);
    napi_value value = nullptr;
    napi_create_string_utf8(env, buffer, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, info, "getter_address", value);
  }
  if (probe != nullptr && !probe->message.empty()) {
    napi_value value = nullptr;
    napi_create_string_utf8(env, probe->message.c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, info, "probe_error", value);
  }
  return info;
}

}  // namespace

NAPI_MODULE_INIT() {
  const napi_property_descriptor properties[] = {
      {"requireBuiltin", nullptr, RequireBuiltin, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"isAllowedInternalId", nullptr, IsAllowedInternalId, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"getNativeBindingInfo", nullptr, GetNativeBindingInfo, nullptr, nullptr,
       nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports,
                             sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok) {
    napi_throw_error(env, nullptr, "failed to define the require-builtin exports");
  }
  return exports;
}
