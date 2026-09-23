// FFI: SheenBidi (UAX #9) for the text layout port. The only file besides
// fonts_ffi.cpp that includes SheenBidi.

#include "text_unicode.hpp"

#include <algorithm>

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#endif
#include <SheenBidi/SheenBidi.h>
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

namespace premation::raster {

BidiClass bidi_class_of(char32_t cp) {
  switch (SBCodepointGetBidiType(cp)) {
    case SBBidiTypeL: return BidiClass::L;
    case SBBidiTypeR: return BidiClass::R;
    case SBBidiTypeAL: return BidiClass::AL;
    case SBBidiTypeBN: return BidiClass::BN;
    case SBBidiTypeNSM: return BidiClass::NSM;
    case SBBidiTypeAN: return BidiClass::AN;
    case SBBidiTypeEN: return BidiClass::EN;
    case SBBidiTypeET: return BidiClass::ET;
    case SBBidiTypeES: return BidiClass::ES;
    case SBBidiTypeCS: return BidiClass::CS;
    case SBBidiTypeWS: return BidiClass::WS;
    case SBBidiTypeS: return BidiClass::S;
    case SBBidiTypeB: return BidiClass::B;
    case SBBidiTypeLRI: return BidiClass::LRI;
    case SBBidiTypeRLI: return BidiClass::RLI;
    case SBBidiTypeFSI: return BidiClass::FSI;
    case SBBidiTypePDI: return BidiClass::PDI;
    case SBBidiTypeLRE: return BidiClass::LRE;
    case SBBidiTypeRLE: return BidiClass::RLE;
    case SBBidiTypeLRO: return BidiClass::LRO;
    case SBBidiTypeRLO: return BidiClass::RLO;
    case SBBidiTypePDF: return BidiClass::PDF;
    default: return BidiClass::ON;
  }
}

namespace {

bool removed_by_x9(BidiClass c) {
  return c == BidiClass::BN || c == BidiClass::LRE || c == BidiClass::RLE || c == BidiClass::LRO ||
         c == BidiClass::RLO || c == BidiClass::PDF;
}
bool l1_trailing(BidiClass c) {
  return c == BidiClass::WS || c == BidiClass::LRI || c == BidiClass::RLI || c == BidiClass::FSI ||
         c == BidiClass::PDI || removed_by_x9(c);
}

}  // namespace

BidiResolution resolve_bidi(const std::vector<char32_t>& cps, int direction) {
  BidiResolution out;
  out.levels.assign(cps.size(), 0);
  if (cps.empty()) {
    out.paragraphLevel = direction == 1 ? 1 : 0;
    return out;
  }
  std::vector<std::uint32_t> u32(cps.begin(), cps.end());
  SBCodepointSequence seq{SBStringEncodingUTF32, u32.data(), u32.size()};
  SBAlgorithmRef alg = SBAlgorithmCreate(&seq);
  const SBLevel base = direction == 1 ? 1 : direction == 0 ? 0 : SBLevelDefaultLTR;
  bool first = true;
  SBUInteger offset = 0;
  while (offset < u32.size()) {
    SBParagraphRef para = SBAlgorithmCreateParagraph(alg, offset, u32.size() - offset, base);
    if (para == nullptr) break;
    const SBUInteger len = SBParagraphGetLength(para);
    const int pl = SBParagraphGetBaseLevel(para);
    const SBLevel* lv = SBParagraphGetLevelsPtr(para);
    for (SBUInteger i = 0; i < len; ++i) out.levels[offset + i] = lv[i];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    // L1 over the paragraph: separators, and whitespace / isolate formatting
    // before a separator or the paragraph end, back to the paragraph level.
    bool trailing = true;
    for (SBUInteger k = len; k-- > 0;) {
      const BidiClass c = bidi_class_of(cps[offset + k]);
      if (c == BidiClass::S || c == BidiClass::B) {
        out.levels[offset + k] = pl;
        trailing = true;
      } else if (trailing && l1_trailing(c)) {
        out.levels[offset + k] = pl;
      } else {
        trailing = false;
      }
    }
    if (first) {
      out.paragraphLevel = pl;
      first = false;
    }
    SBParagraphRelease(para);
    if (len == 0) break;
    offset += len;
  }
  SBAlgorithmRelease(alg);
  return out;
}

BidiResolution cluster_bidi(const std::vector<std::string>& clusters, int direction) {
  std::vector<char32_t> cps;
  std::vector<std::size_t> firstCp;
  for (const auto& cl : clusters) {
    firstCp.push_back(cps.size());
    const auto c = code_points(cl);
    cps.insert(cps.end(), c.begin(), c.end());
    if (cl.empty()) cps.push_back(0xFEFF);
  }
  const BidiResolution r = resolve_bidi(cps, direction);
  BidiResolution out;
  out.paragraphLevel = r.paragraphLevel;
  for (const std::size_t k : firstCp) out.levels.push_back(k < r.levels.size() ? r.levels[k] : r.paragraphLevel);
  return out;
}

void reset_line_end(const std::vector<std::string>& clusters, std::vector<int>& levels, int paragraphLevel) {
  for (std::size_t i = std::min(clusters.size(), levels.size()); i-- > 0;) {
    const auto& cl = clusters[i];
    const BidiClass c = cl.empty() ? BidiClass::BN : bidi_class_of(code_points(cl).front());
    if (l1_trailing(c)) levels[i] = paragraphLevel;
    else break;
  }
}

std::vector<int> visual_order(const std::vector<int>& levels) {
  std::vector<int> order(levels.size());
  for (std::size_t i = 0; i < order.size(); ++i) order[i] = static_cast<int>(i);
  if (levels.empty()) return order;
  const int mx = *std::ranges::max_element(levels);
  const int mn = *std::ranges::min_element(levels);
  const int minOdd = mn % 2 == 1 ? mn : mn + 1;
  for (int lv = mx; lv >= minOdd; --lv) {
    std::size_t i = 0;
    while (i < order.size()) {
      if (levels[static_cast<std::size_t>(order[i])] < lv) { ++i; continue; }
      std::size_t j = i;
      while (j < order.size() && levels[static_cast<std::size_t>(order[j])] >= lv) ++j;
      std::reverse(order.begin() + static_cast<std::ptrdiff_t>(i), order.begin() + static_cast<std::ptrdiff_t>(j));
      i = j;
    }
  }
  return order;
}

bool has_strong_rtl(std::string_view text) {
  for (const char32_t cp : code_points(text)) {
    const BidiClass c = bidi_class_of(cp);
    if (c == BidiClass::R || c == BidiClass::AL) return true;
  }
  return false;
}

int paragraph_level_of(std::string_view text) {
  int depth = 0;
  for (const char32_t cp : code_points(text)) {
    const BidiClass c = bidi_class_of(cp);
    if (c == BidiClass::LRI || c == BidiClass::RLI || c == BidiClass::FSI) ++depth;
    else if (c == BidiClass::PDI) { if (depth > 0) --depth; }
    else if (c == BidiClass::B) return 0;
    else if (depth == 0 && (c == BidiClass::L || c == BidiClass::R || c == BidiClass::AL)) return c == BidiClass::L ? 0 : 1;
  }
  return 0;
}

}  // namespace premation::raster
