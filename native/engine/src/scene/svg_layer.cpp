// SVG in the scene builder (D2w) — see svg_layer.hpp.

#include "svg_layer.hpp"

#include <array>
#include <fstream>
#include <iterator>
#include <sstream>

#include "image_decode.hpp"
#include "svg_render.hpp"

namespace premation::scene {
namespace {

/// svgSanitize.ts SVG_SANITIZE_POLICY_VERSION.
constexpr double kSanitizePolicy = 2;

/// btoa over the UTF-8 bytes (svgToDataUrl).
std::string base64(std::string_view bytes) {
  static constexpr std::string_view kAlpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((bytes.size() + 2) / 3 * 4);
  std::size_t i = 0;
  for (; i + 2 < bytes.size(); i += 3) {
    const std::uint32_t v = (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[i])) << 16U) |
                            (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[i + 1])) << 8U) |
                            static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[i + 2]));
    out.push_back(kAlpha[(v >> 18U) & 63U]);
    out.push_back(kAlpha[(v >> 12U) & 63U]);
    out.push_back(kAlpha[(v >> 6U) & 63U]);
    out.push_back(kAlpha[v & 63U]);
  }
  const std::size_t rest = bytes.size() - i;
  if (rest > 0) {
    std::uint32_t v = static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[i])) << 16U;
    if (rest == 2) v |= static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[i + 1])) << 8U;
    out.push_back(kAlpha[(v >> 18U) & 63U]);
    out.push_back(kAlpha[(v >> 12U) & 63U]);
    out.push_back(rest == 2 ? kAlpha[(v >> 6U) & 63U] : '=');
    out.push_back('=');
  }
  return out;
}

std::string lower(std::string_view s) {
  std::string o(s);
  for (char& c : o) c = c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
  return o;
}

}  // namespace

SvgLayerSource svg_layer_source(const doc::Node& n) {
  SvgLayerSource out;
  const doc::Component* c = n.comp("svg");
  if (c == nullptr) return out;
  const doc::Json& p = c->props;
  const doc::Json& stored = p.at("sanitizedMarkup");
  if (!stored.is_string() || stored.str().empty()) return out;
  const doc::Json& policy = p.at("sanitizePolicy");
  const bool current = policy.is_number() && policy.num() == kSanitizePolicy;
  if (!current && p.at("sourceMarkup").is_string() && !p.at("sourceMarkup").str().empty()) {
    // readSvgLayer re-sanitizes an old layer from its source; the sanitizer is not ported.
    out.unported.emplace_back("SVG layer stored under an older sanitize policy");
  }
  if (p.at("livePlayback").is_bool() && p.at("livePlayback").b()) {
    out.unported.emplace_back("live SVG playback (SMIL / CSS animation)");
  }
  out.src = "data:image/svg+xml;base64," + base64(stored.str());
  return out;
}

bool is_svg_src(std::string_view src) {
  // isSvgBlob: the blob's type (a data: URL states it), or a .svg path.
  if (src.size() >= 18 && lower(src.substr(0, 18)) == "data:image/svg+xml") return true;
  if (src.starts_with("data:")) return false;
  std::string_view path = src;
  const std::size_t q = path.find_first_of("?#");
  if (q != std::string_view::npos) path = path.substr(0, q);
  return lower(path).ends_with(".svg");
}

raster::RasterOutput rasterize_svg_src(std::string_view src, const std::optional<std::string>& fill,
                                       const std::string& filePath) {
  raster::RasterOutput out;
  std::string markup;
  if (src.starts_with("data:")) {
    auto m = raster::svg::svg_markup_from_data_url(src);
    if (!m) {
      out.error = "SVG data URL did not decode";
      return out;
    }
    markup = std::move(*m);
  } else {
    std::ifstream in(filePath, std::ios::binary);
    if (!in) {
      out.error = "SVG file did not open: " + filePath;
      return out;
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    markup = ss.str();
  }
  raster::svg::RasterizeOptions opts;
  opts.fillColor = fill;
  opts.decodeImage = [](std::span<const std::uint8_t> bytes, raster::svg::Bitmap& bm) {
    DecodedImage img;
    std::string err;
    if (!decode_image_bytes(bytes, img, err)) return false;
    bm.width = img.width;
    bm.height = img.height;
    bm.rgba = std::move(img.rgba);
    return true;
  };
  return raster::svg::rasterize_svg(markup, opts);
}

}  // namespace premation::scene
