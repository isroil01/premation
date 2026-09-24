// Intl.Segmenter word segmentation for lineBreak.ts's word joins (E3).
//
// V8's Intl.Segmenter({granularity: 'word'}) is ICU's word BreakIterator, and
// `isWordLike` is its rule status in [UBRK_WORD_NONE_LIMIT, UBRK_WORD_IDEO_LIMIT)
// (V8 js-segments.cc CurrentSegmentIsWordLike). The joins lineBreak.ts takes
// from it are the dictionary breaks inside scripts written without spaces
// (Thai, Lao, Khmer, Myanmar) and the boundaries between scripts, so a rule
// port without ICU's dictionaries cannot reproduce them: this file runs ICU.
//
// ICU is loaded from the OS at first use through its stable C API (ubrk_*):
// every desktop OS ships it — Windows 10 1903+ `icu.dll`, macOS
// `libicucore.dylib`, Linux `libicuuc.so.NN` (symbols suffixed `_NN`). No ICU
// header or import library is needed at build time; the five entry points are
// declared here with ICU's C ABI. When no ICU loads, word_segments returns
// nullopt and the caller takes lineBreak.ts's no-Segmenter branch (spaces and
// hyphens only). The OS's ICU version can differ from Chromium's bundled one;
// the dictionaries rarely change a break (see native/README.md § Text).
//
// This is the only file that talks to ICU (the native FFI rule).

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

#include "line_break.hpp"

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#else
#  include <dlfcn.h>
#endif

namespace premation::raster {
namespace {

// ── ICU C ABI (unicode/ubrk.h, unicode/utypes.h) ────────────────────────────
struct UBreakIterator;
using UErrorCode = int;          // enum UErrorCode; > 0 is a failure
constexpr int kUbrkWord = 1;     // UBRK_WORD
constexpr std::int32_t kUbrkDone = -1;
constexpr std::int32_t kWordNoneLimit = 100;  // UBRK_WORD_NONE_LIMIT
constexpr std::int32_t kWordIdeoLimit = 500;  // UBRK_WORD_IDEO_LIMIT

using FnOpen = UBreakIterator* (*)(int, const char*, const char16_t*, std::int32_t, UErrorCode*);
using FnSetText = void (*)(UBreakIterator*, const char16_t*, std::int32_t, UErrorCode*);
using FnFirst = std::int32_t (*)(UBreakIterator*);
using FnNext = std::int32_t (*)(UBreakIterator*);
using FnStatus = std::int32_t (*)(const UBreakIterator*);
using FnClose = void (*)(UBreakIterator*);

struct Icu {
  FnOpen open = nullptr;
  FnSetText setText = nullptr;
  FnFirst first = nullptr;
  FnNext next = nullptr;
  FnStatus status = nullptr;
  FnClose close = nullptr;
  std::string info;
  [[nodiscard]] bool ok() const noexcept { return open && setText && first && next && status && close; }
};

void* open_library(const char* name) {
#if defined(_WIN32)
  return reinterpret_cast<void*>(LoadLibraryA(name));
#else
  return dlopen(name, RTLD_NOW | RTLD_LOCAL);
#endif
}

void* symbol(void* lib, const std::string& name) {
#if defined(_WIN32)
  return reinterpret_cast<void*>(GetProcAddress(static_cast<HMODULE>(lib), name.c_str()));
#else
  return dlsym(lib, name.c_str());
#endif
}

template <class Fn>
Fn as_fn(void* p) {
  return reinterpret_cast<Fn>(p);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): the C ABI entry point
}

/// Bind the six entry points with `suffix` ("" or "_74"); false if any is missing.
bool bind(void* lib, const std::string& suffix, Icu& icu) {
  const auto get = [&](const char* base) { return symbol(lib, std::string(base) + suffix); };
  icu.open = as_fn<FnOpen>(get("ubrk_open"));
  icu.setText = as_fn<FnSetText>(get("ubrk_setText"));
  icu.first = as_fn<FnFirst>(get("ubrk_first"));
  icu.next = as_fn<FnNext>(get("ubrk_next"));
  icu.status = as_fn<FnStatus>(get("ubrk_getRuleStatus"));
  icu.close = as_fn<FnClose>(get("ubrk_close"));
  return icu.ok();
}

Icu load_icu() {
  Icu icu;
  constexpr int kNewest = 99;
  constexpr int kOldest = 50;
  const auto try_lib = [&](const std::string& name, int version) {
    void* lib = open_library(name.c_str());
    if (lib == nullptr) return false;
    // Unsuffixed first (Windows, macOS, ICU built with U_DISABLE_RENAMING), then
    // the version the file name says, then any version (a bare libicuuc.so).
    if (bind(lib, "", icu)) {
      icu.info = name;
      return true;
    }
    for (int v = version > 0 ? version : kNewest; v >= (version > 0 ? version : kOldest); --v) {
      if (bind(lib, "_" + std::to_string(v), icu)) {
        icu.info = "icu " + std::to_string(v) + " (" + name + ")";
        return true;
      }
    }
    return false;  // the handle stays open: a loaded library is process-lifetime anyway
  };
#if defined(_WIN32)
  if (try_lib("icu.dll", 0) || try_lib("icuuc.dll", 0)) return icu;
#elif defined(__APPLE__)
  if (try_lib("/usr/lib/libicucore.A.dylib", 0) || try_lib("libicucore.dylib", 0)) return icu;
#else
  for (int v = kNewest; v >= kOldest; --v) {
    if (try_lib("libicuuc.so." + std::to_string(v), v)) return icu;
  }
  if (try_lib("libicuuc.so", 0)) return icu;
#endif
  return Icu{};
}

const Icu& icu() {
  static const Icu kIcu = load_icu();  // thread-safe static init
  return kIcu;
}

std::atomic<bool> gDisabled{false};  // test seam only

/// One word iterator per thread, opened on first use (ubrk_open is costly and
/// an iterator is not thread-safe); closed when the thread exits.
struct IteratorCloser {
  void operator()(UBreakIterator* it) const noexcept {
    if (it != nullptr) icu().close(it);
  }
};

UBreakIterator* thread_iterator() {
  thread_local std::unique_ptr<UBreakIterator, IteratorCloser> it;
  thread_local bool tried = false;
  if (!tried) {
    tried = true;
    UErrorCode err = 0;
    // V8 segments with the default locale; ICU's word rules are the root
    // rules for every locale Chromium ships except a few with tailorings
    // that do not touch the scripts the joins matter for.
    UBreakIterator* raw = icu().open(kUbrkWord, "en_US", nullptr, 0, &err);
    if (err <= 0) it.reset(raw);
    else if (raw != nullptr) icu().close(raw);
  }
  return it.get();
}

}  // namespace

std::optional<std::vector<WordSegment>> word_segments(std::u16string_view text) {
  if (gDisabled || !icu().ok()) return std::nullopt;
  UBreakIterator* it = thread_iterator();
  if (it == nullptr) return std::nullopt;
  UErrorCode err = 0;
  icu().setText(it, text.data(), static_cast<std::int32_t>(text.size()), &err);
  if (err > 0) return std::nullopt;
  std::vector<WordSegment> out;
  std::int32_t start = icu().first(it);
  for (std::int32_t end = icu().next(it); end != kUbrkDone; end = icu().next(it)) {
    const std::int32_t status = icu().status(it);
    out.push_back({static_cast<std::size_t>(start), status >= kWordNoneLimit && status < kWordIdeoLimit});
    start = end;
  }
  // The iterator keeps a pointer to `text`; point it away before the caller's buffer dies.
  icu().setText(it, u"", 0, &err);
  return out;
}

std::string word_segmenter_info() { return icu().ok() ? icu().info : std::string(); }

void set_word_segmenter_disabled_for_test(bool disabled) { gDisabled = disabled; }

}  // namespace premation::raster
