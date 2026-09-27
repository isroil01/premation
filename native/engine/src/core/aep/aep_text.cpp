#include "core/aep/aep_text.hpp"

#include <cmath>

#include "core/aep/cos.hpp"

namespace premation::doc::aep {

namespace {

const CosValue* document_of(const CosValue& root) { return cos_get(&root, {"1", "1", std::size_t{0}, "0"}); }

std::vector<std::string> font_table(const CosValue& root) {
  std::vector<std::string> out;
  const auto* table = cos_array(cos_get(&root, {"0", "1", "0"}));
  if (table == nullptr) return out;
  for (const CosValue& entry : *table) out.push_back(cos_string(cos_get(&entry, {"0", "0", "0"})).value_or(""));
  return out;
}

/// Last resort: the `/0` string of a dictionary that ALSO carries a `/5` style block.
std::optional<std::string> find_text_by_shape(const CosValue& root) {
  std::optional<std::string> found;
  cos_walk(&root, [&](const CosValue& node) {
    if (node.kind != CosValue::Kind::dict) return true;
    const auto text = cos_string(node.get("0"));
    if (!text || node.get("5") == nullptr || text->empty()) return true;
    found = *text;
    return false;
  });
  return found;
}

/// `raw.replace(/\r\n?/g, '\n')`.
std::string normalize_newlines(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
  for (std::size_t i = 0; i < raw.size(); ++i) {
    if (raw[i] == '\r') {
      out.push_back('\n');
      if (i + 1 < raw.size() && raw[i + 1] == '\n') ++i;
    } else {
      out.push_back(raw[i]);
    }
  }
  return out;
}

}  // namespace

std::optional<AepTextDocument> read_text_document(Bytes btdk) {
  const CosValue root = parse_cos(btdk);
  const CosValue* doc = document_of(root);
  std::optional<std::string> raw = cos_string(cos_get(doc, {"0"}));
  if (!raw) raw = find_text_by_shape(root);
  if (!raw) return std::nullopt;

  AepTextDocument out;
  out.text = normalize_newlines(*raw);
  const std::vector<std::string> fonts = font_table(root);
  const CosValue* style = cos_get(doc, {"6", "0", std::size_t{0}, "0", "0", "6"});
  const CosValue* paragraph = cos_get(doc, {"5", "0", std::size_t{0}, "0", "0", "5"});

  if (const auto fi = cos_number(cos_get(style, {"0"}))) {
    // `fonts[index]`: only a whole, in-range index names a font.
    if (*fi >= 0 && std::floor(*fi) == *fi && *fi < static_cast<double>(fonts.size())) {
      const std::string& f = fonts[static_cast<std::size_t>(*fi)];
      if (!f.empty()) out.font = f;
    }
  }
  if (const auto size = cos_number(cos_get(style, {"1"})); size && *size > 0) out.fontSize = *size;
  if (const auto tracking = cos_number(cos_get(style, {"8"})); tracking && *tracking != 0) out.tracking = *tracking;
  // Leading only means something with auto-leading off; AE stores 0 with the flag set.
  if (const auto leading = cos_number(cos_get(style, {"13"})); leading && *leading > 0) out.leading = *leading;
  if (const auto j = cos_number(cos_get(paragraph, {"0"}))) {
    if (*j == 0) out.justification = "left";
    else if (*j == 1) out.justification = "right";
    else if (*j == 2) out.justification = "center";
  }
  // `[a, r, g, b]` in 0–1 (SimplePaint stores alpha first).
  if (const auto* channels = cos_array(cos_get(style, {"53", "0", "1"})); channels != nullptr && channels->size() >= 4) {
    auto ch = [&](std::size_t i) { return cos_number(&(*channels)[i]).value_or(0); };
    out.fillColor = AepTextDocument::Rgb{ch(1), ch(2), ch(3)};
  }
  const auto boolAt = [&](std::string_view key) {
    const CosValue* v = cos_get(style, {key});
    return v != nullptr && v->kind == CosValue::Kind::boolean && v->boolean;
  };
  out.fauxBold = boolAt("2");
  out.fauxItalic = boolAt("3");
  const auto* runs = cos_array(cos_get(doc, {"6", "0"}));
  out.styleRuns = runs != nullptr ? runs->size() : 0;
  return out;
}

}  // namespace premation::doc::aep
