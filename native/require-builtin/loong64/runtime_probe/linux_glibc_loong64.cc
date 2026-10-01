// LoongArch64 getter parser for the upstream `node-addon-require-builtin`
// addon.
//
// Overlaid onto `packages/native/src/` of vendor/node-addon-require-builtin-src
// at build time; see lib/recipes/require-builtin.js. It is the LoongArch64
// counterpart of runtime_probe/linux_glibc_x64.cc and keeps the same two-stage
// decode contract.
//
// On loong64 Node compiles `PrincipalRealm::builtin_module_require()` as a
// framed leaf accessor, so the whole body does not fit the standard 16-byte
// window and the wide-window retry is what actually succeeds. Node 26.10.0
// disassembles to:
//
//   addi.d $sp, $sp, -16         02ffc063
//   st.d   $fp, $sp, 8           29c02076
//   addi.d $fp, $sp, 16          02c04076
//   ld.d   $fp, $sp, 8           28c02076
//   ld.d   $a0, $a0, 520         28c82084   <- the Realm field, 0x208
//   addi.d $sp, $sp, 16          02c04063
//   ret                          4c000020
//
// The walker therefore skips only frame bookkeeping ($sp-relative addi.d /
// st.d / ld.d), permits exactly one `ld.d $a0, $a0, imm`, and requires the body
// to terminate with `ret`. Anything else fails closed, exactly like the
// x86-64 and AArch64 walkers.

#include "getter_decoder.h"
#include "helper.h"

#include <array>
#include <cstring>
#include <string>
#include <string_view>

namespace esplus::node::require_builtin {
namespace {

// A Realm field is a pointer-sized word a short distance into the object. The
// bound matches the x86-64/AArch64 walkers' constant; those helpers live in
// getter_decoder.cc's anonymous namespace, so the value is restated here.
constexpr size_t kMaxReasonableRealmOffset = 0x4000;

// LoongArch64 registers this accessor touches.
constexpr uint32_t kRegSp = 3;
constexpr uint32_t kRegA0 = 4;   // `this` argument and return register
constexpr uint32_t kRegFp = 22;

// 2RI12 encoding: opcode in bits [31:22], signed imm12 in [21:10], rj in
// [9:5], rd in [4:0]. These are the base encodings of the three instructions a
// field accessor can contain.
constexpr uint32_t kOpcodeMask = 0xffc00000u;
constexpr uint32_t kOpAddiD = 0x02c00000u;
constexpr uint32_t kOpLdD = 0x28c00000u;
constexpr uint32_t kOpStD = 0x29c00000u;

// `ret` is the `jr $ra` alias (jirl $zero, $ra, 0); `nop` is emitted for
// alignment between functions.
constexpr uint32_t kRet = 0x4c000020u;
constexpr uint32_t kNop = 0x03400000u;

uint32_t InsnRd(uint32_t insn) {
  return insn & 0x1fu;
}

uint32_t InsnRj(uint32_t insn) {
  return (insn >> 5) & 0x1fu;
}

// Bits [21:10], sign-extended from 12 bits.
int32_t InsnSi12(uint32_t insn) {
  const uint32_t raw = (insn >> 10) & 0xfffu;
  return static_cast<int32_t>(raw << 20) >> 20;
}

bool IsPlausibleOffset(size_t offset) {
  return offset != 0 && offset <= kMaxReasonableRealmOffset &&
      (offset % alignof(void*)) == 0;
}

// Frame bookkeeping a getter may carry: `addi.d <reg>, $sp, imm` adjusts the
// stack, and `st.d`/`ld.d <reg>, $sp, imm` spill or restore the frame pointer.
// The base register must be $sp, so this cannot hide a load through `this`.
bool IsLoong64FrameInsn(uint32_t insn) {
  if (InsnRj(insn) != kRegSp) return false;
  const uint32_t opcode = insn & kOpcodeMask;
  if (opcode == kOpAddiD) return true;
  if (opcode == kOpStD || opcode == kOpLdD) return InsnRd(insn) == kRegFp;
  return false;
}

// `ld.d $a0, $a0, imm`: load the returned handle from `this` into the return
// register. Both registers are pinned, mirroring the AArch64 matcher's
// `ldr x0, [x0, #imm]`, so a getter reading a different object or returning a
// different register fails closed.
bool DecodeLdDFromThis(uint32_t insn, size_t* offset) {
  if ((insn & kOpcodeMask) != kOpLdD) return false;
  if (InsnRj(insn) != kRegA0 || InsnRd(insn) != kRegA0) return false;
  const int32_t imm = InsnSi12(insn);
  if (imm <= 0) return false;
  *offset = static_cast<size_t>(imm);
  return true;
}

Result<GetterPattern> MatchLoong64FieldGetter(void* getter,
                                              std::string_view platform_tag,
                                              size_t window_bytes) {
  if (window_bytes > kHardenedGetterCodeWindowBytes) {
    window_bytes = kHardenedGetterCodeWindowBytes;
  }
  const size_t words = window_bytes / sizeof(uint32_t);
  if (words == 0) {
    return Result<GetterPattern>::Failure(Status::Failure(
        ProbeStatus::kUnsupportedNoGetter,
        "loong64 getter window is too small to decode"));
  }

  std::array<uint32_t, kHardenedGetterCodeWindowBytes / sizeof(uint32_t)> code{};
  std::memcpy(code.data(), getter, words * sizeof(code[0]));

  bool found_load = false;
  bool has_frame = false;
  size_t offset = 0;

  for (size_t index = 0; index < words; index++) {
    const uint32_t insn = code[index];

    if (insn == kRet) {
      if (!found_load) {
        return Result<GetterPattern>::Failure(Status::Failure(
            ProbeStatus::kUnsupportedNoGetter,
            "loong64 getter returned without loading a field"));
      }
      if (!IsPlausibleOffset(offset)) {
        return Result<GetterPattern>::Failure(Status::Failure(
            ProbeStatus::kUnsupportedNoGetter,
            "loong64 parsed getter offset is implausible"));
      }
      GetterPattern pattern;
      pattern.offset = offset;
      std::string text(platform_tag);
      text += has_frame ? " frame-ld-d-[this-imm]-ret"
                        : " ld-d-[this-imm]-ret";
      pattern.pattern = std::move(text);
      return Result<GetterPattern>::Ok(pattern);
    }

    if (insn == kNop) continue;
    if (IsLoong64FrameInsn(insn)) {
      has_frame = true;
      continue;
    }

    size_t candidate = 0;
    if (DecodeLdDFromThis(insn, &candidate)) {
      if (found_load) {
        return Result<GetterPattern>::Failure(Status::Failure(
            ProbeStatus::kUnsupportedNoGetter,
            "loong64 getter loads more than one field"));
      }
      found_load = true;
      offset = candidate;
      continue;
    }

    return Result<GetterPattern>::Failure(Status::Failure(
        ProbeStatus::kUnsupportedNoGetter,
        "loong64 getter contains an unrecognized instruction"));
  }

  return Result<GetterPattern>::Failure(Status::Failure(
      ProbeStatus::kUnsupportedNoGetter,
      "loong64 getter did not terminate with ret"));
}

}  // namespace

Result<GetterPattern> ParseLinuxGlibcLoong64BuiltinModuleRequireGetterOffset(
    void* getter) {
  // The standard window first, then the 32-byte window the framed accessor
  // needs, matching the other Linux parsers.
  return DecodeGetterWithWideWindowRetry(getter, "linux-glibc-loong64",
                                         MatchLoong64FieldGetter);
}

}  // namespace esplus::node::require_builtin
