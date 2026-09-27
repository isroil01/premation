#include "core/aep/aepx.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "fail.hpp"

namespace premation::doc::aep {

namespace {

constexpr std::string_view kRootElement = "AfterEffectsProject";
/// The XMP packet rides along as an element; in the binary file it is AFTER the tree.
constexpr std::string_view kNotAChunk = "ProjectXMPMetadata";
constexpr std::size_t kMaxDepth = 64;
constexpr std::size_t kMaxChunks = 4'000'000;

/// XML drops the padding: `Pin ` is written `<Pin>`. Restore it.
std::string fourcc_of(std::string_view name) {
  std::string s(name.substr(0, 4));
  while (s.size() < 4) s.push_back(' ');
  return s;
}

void append_utf8(std::string& out, std::uint32_t cp) {
  if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;  // a lone surrogate has no UTF-8 form
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0U | (cp >> 6U)));
    out.push_back(static_cast<char>(0x80U | (cp & 63U)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0U | (cp >> 12U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 63U)));
    out.push_back(static_cast<char>(0x80U | (cp & 63U)));
  } else {
    out.push_back(static_cast<char>(0xF0U | (cp >> 18U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 12U) & 63U)));
    out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 63U)));
    out.push_back(static_cast<char>(0x80U | (cp & 63U)));
  }
}

bool is_hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return c - 'A' + 10;
}
bool is_alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
bool is_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

/// The five predefined entities and numeric character references; anything else stays literal.
std::string decode_entities(std::string_view text) {
  if (text.find('&') == std::string_view::npos) return std::string(text);
  std::string out;
  out.reserve(text.size());
  std::size_t i = 0;
  while (i < text.size()) {
    if (text[i] != '&') {
      out.push_back(text[i++]);
      continue;
    }
    // `&(#x?[0-9a-fA-F]+|[a-zA-Z]+);`
    std::size_t j = i + 1;
    bool numeric = false;
    bool hexRef = false;
    if (j < text.size() && text[j] == '#') {
      numeric = true;
      ++j;
      if (j < text.size() && (text[j] == 'x' || text[j] == 'X')) {
        // `#x` then hex digits — but `#` + hex digits alone is also a match (decimal parse).
        if (j + 1 < text.size() && is_hex(text[j + 1])) {
          hexRef = true;
          ++j;
        }
      }
      const std::size_t digits = j;
      while (j < text.size() && is_hex(text[j])) ++j;
      if (j == digits) numeric = false;
    } else {
      const std::size_t letters = j;
      while (j < text.size() && is_alpha(text[j])) ++j;
      if (j == letters) {
        out.push_back(text[i++]);
        continue;
      }
    }
    if (j >= text.size() || text[j] != ';' || (text[i + 1] == '#' && !numeric)) {
      out.push_back(text[i++]);
      continue;
    }
    const std::string_view whole = text.substr(i, j + 1 - i);
    const std::string_view ref = text.substr(i + 1, j - i - 1);
    if (numeric) {
      // parseInt: the longest digit prefix of the radix.
      std::uint64_t code = 0;
      bool any = false;
      bool overflow = false;
      for (std::size_t k = hexRef ? 2 : 1; k < ref.size(); ++k) {
        const char c = ref[k];
        const int v = hexRef ? hex_val(c) : (c >= '0' && c <= '9' ? c - '0' : -1);
        if (v < 0) break;
        any = true;
        code = code * (hexRef ? 16U : 10U) + static_cast<std::uint64_t>(v);
        if (code > 0x10FFFF) overflow = true;
      }
      if (any && !overflow) append_utf8(out, static_cast<std::uint32_t>(code));
      else out.append(whole);
    } else if (ref == "amp") {
      out.push_back('&');
    } else if (ref == "lt") {
      out.push_back('<');
    } else if (ref == "gt") {
      out.push_back('>');
    } else if (ref == "quot") {
      out.push_back('"');
    } else if (ref == "apos") {
      out.push_back('\'');
    } else {
      out.append(whole);  // never resolved: a DOCTYPE entity is exactly the XXE we refuse
    }
    i = j + 1;
  }
  return out;
}

std::vector<std::uint8_t> hex_to_bytes(std::string_view hex) {
  std::string clean;
  clean.reserve(hex.size());
  for (const char c : hex) {
    if (!is_space(c)) clean.push_back(c);
  }
  if (clean.size() % 2 != 0) fail(api::ErrorCode::decode, "bdata has an odd number of hex digits");
  std::vector<std::uint8_t> out(clean.size() / 2);
  for (std::size_t i = 0; i < out.size(); ++i) {
    const char a = clean[i * 2];
    const char b = clean[i * 2 + 1];
    if (!is_hex(a) || !is_hex(b)) fail(api::ErrorCode::decode, "bdata contains a non-hexadecimal character");
    out[i] = static_cast<std::uint8_t>((hex_val(a) << 4) | hex_val(b));
  }
  return out;
}

struct Tag {
  std::string name;
  std::optional<std::string> bdata;
  bool selfClosing = false;
  bool closing = false;
};

bool attr_name_start(char c) { return is_alpha(c) || c == '_' || c == ':'; }
bool attr_name_char(char c) {
  return attr_name_start(c) || (c >= '0' && c <= '9') || c == '-' || c == '.';
}

/// The `bdata` attribute of a tag's attribute text (the only attribute the tree needs).
std::optional<std::string> find_bdata(std::string_view rest) {
  std::optional<std::string> found;
  std::size_t i = 0;
  while (i < rest.size()) {
    if (!attr_name_start(rest[i])) {
      ++i;
      continue;
    }
    const std::size_t nameStart = i;
    while (i < rest.size() && attr_name_char(rest[i])) ++i;
    const std::string_view name = rest.substr(nameStart, i - nameStart);
    std::size_t j = i;
    while (j < rest.size() && is_space(rest[j])) ++j;
    if (j >= rest.size() || rest[j] != '=') continue;
    ++j;
    while (j < rest.size() && is_space(rest[j])) ++j;
    if (j >= rest.size() || (rest[j] != '"' && rest[j] != '\'')) continue;
    const char q = rest[j];
    const std::size_t close = rest.find(q, j + 1);
    if (close == std::string_view::npos) {
      i = j + 1;
      continue;
    }
    if (name == "bdata") found = decode_entities(rest.substr(j + 1, close - j - 1));
    i = close + 1;
  }
  return found;
}

struct Scanner {
  std::string_view text;
  std::size_t pos = 0;

  /// The next tag at or after `pos`; character data before it (CDATA included) goes to `textOut`.
  std::optional<Tag> next(std::string& textOut) {
    textOut.clear();
    for (;;) {
      const std::size_t lt = text.find('<', pos);
      if (lt == std::string_view::npos) {
        pos = text.size();
        return std::nullopt;
      }
      textOut.append(text.substr(pos, lt - pos));
      const std::string_view at = text.substr(lt);
      if (at.starts_with("<!--")) {
        const std::size_t end = text.find("-->", lt + 4);
        pos = end == std::string_view::npos ? text.size() : end + 3;
        continue;
      }
      if (at.starts_with("<![CDATA[")) {
        const std::size_t end = text.find("]]>", lt + 9);
        const std::size_t stop = end == std::string_view::npos ? text.size() : end;
        textOut.append(text.substr(lt + 9, stop - (lt + 9)));
        pos = end == std::string_view::npos ? text.size() : end + 3;
        continue;
      }
      if (at.starts_with("<?")) {
        const std::size_t end = text.find("?>", lt + 2);
        pos = end == std::string_view::npos ? text.size() : end + 2;
        continue;
      }
      if (at.starts_with("<!")) {
        // A DOCTYPE or other declaration: skipped whole, never interpreted.
        const std::size_t end = text.find('>', lt + 2);
        pos = end == std::string_view::npos ? text.size() : end + 1;
        continue;
      }
      const std::size_t gt = text.find('>', lt);
      if (gt == std::string_view::npos) {
        pos = text.size();
        return std::nullopt;
      }
      std::string_view raw = text.substr(lt + 1, gt - lt - 1);
      pos = gt + 1;
      Tag tag;
      tag.closing = raw.starts_with('/');
      tag.selfClosing = raw.ends_with('/');
      std::string_view inner = raw;
      if (tag.closing) inner.remove_prefix(1);
      if (tag.selfClosing && !inner.empty()) inner.remove_suffix(1);
      while (!inner.empty() && is_space(inner.front())) inner.remove_prefix(1);
      while (!inner.empty() && is_space(inner.back())) inner.remove_suffix(1);
      std::size_t n = 0;
      while (n < inner.size() && !is_space(inner[n]) && inner[n] != '/' && inner[n] != '>') ++n;
      if (n == 0) continue;
      tag.name = std::string(inner.substr(0, n));
      if (!tag.closing) tag.bdata = find_bdata(inner.substr(n));
      return tag;
    }
  }
};

struct Frame {
  std::string name;
  std::vector<Chunk> children;
  std::string text;
  std::optional<std::vector<std::uint8_t>> bdata;
};

/// One finished element as the chunk it stands for; false when it is not a chunk.
bool frame_to_chunk(Frame& f, ChunkTree& tree, Chunk& out) {
  if (f.name == kNotAChunk) return false;
  if (f.name == "string") {
    // `<string>` is how AE writes a `Utf8` chunk in XML.
    const std::string decoded = decode_entities(f.text);
    tree.storage.emplace_back(decoded.begin(), decoded.end());
    out.id = "Utf8";
    out.hasBody = true;
    out.body = Bytes(tree.storage.back());
    return true;
  }
  const std::string id = fourcc_of(f.name);
  if (f.bdata) {
    tree.storage.push_back(std::move(*f.bdata));
    out.id = id;
    out.hasBody = true;
    out.body = Bytes(tree.storage.back());
    return true;
  }
  // Children present, or an element that is simply empty (an empty list is still a list).
  out.hasChildren = true;
  out.children = std::move(f.children);
  if (is_container_chunk_id(id)) {
    out.id = id;
  } else {
    out.id = "LIST";
    out.listType = id;
  }
  return true;
}

}  // namespace

ChunkTree parse_aepx(std::string_view xml) {
  if (xml.find(kRootElement) == std::string_view::npos) {
    fail(api::ErrorCode::decode, "not an After Effects XML project: no <AfterEffectsProject> element");
  }
  ChunkTree tree;
  bool haveRoot = false;
  Scanner sc{xml, 0};
  std::vector<Frame> stack;
  std::string text;
  std::size_t chunks = 0;
  for (;;) {
    std::optional<Tag> tag = sc.next(text);
    if (!text.empty() && !stack.empty() && stack.back().name == "string") stack.back().text += text;
    if (!tag) break;
    if (tag->closing) {
      if (stack.empty()) continue;  // a stray close tag — ignored rather than aborting the import
      Frame f = std::move(stack.back());
      stack.pop_back();
      if (stack.empty()) {
        if (f.name == kRootElement) {
          tree.root = Chunk{};
          tree.root.id = "RIFX";
          tree.root.listType = "Egg!";
          tree.root.hasChildren = true;
          tree.root.children = std::move(f.children);
          haveRoot = true;
        }
        continue;
      }
      Chunk c;
      if (frame_to_chunk(f, tree, c)) stack.back().children.push_back(std::move(c));
      continue;
    }
    if ((chunks += 1) > kMaxChunks) {
      fail(api::ErrorCode::decode, "project has an implausible number of elements — refusing to continue");
    }
    Frame f;
    f.name = tag->name;
    if (tag->bdata) f.bdata = hex_to_bytes(*tag->bdata);
    if (tag->selfClosing) {
      Chunk c;
      if (frame_to_chunk(f, tree, c) && !stack.empty()) stack.back().children.push_back(std::move(c));
      continue;
    }
    if (stack.size() >= kMaxDepth) {
      fail(api::ErrorCode::decode, "project is nested more deeply than any real project — refusing to continue");
    }
    stack.push_back(std::move(f));
  }
  if (!haveRoot) fail(api::ErrorCode::decode, "not an After Effects XML project: <AfterEffectsProject> never closed");
  return tree;
}

}  // namespace premation::doc::aep
