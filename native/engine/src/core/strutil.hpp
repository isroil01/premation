// Small string helpers for the document core: the JavaScript string idioms the
// TypeScript engine's rules are written in (split, startsWith, the prop-path
// regexes) without std::regex.
#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace premation::doc {

[[nodiscard]] inline bool starts_with(std::string_view s, std::string_view p) noexcept { return s.starts_with(p); }
[[nodiscard]] inline bool ends_with(std::string_view s, std::string_view p) noexcept { return s.ends_with(p); }

/// `s.split(sep)` (JavaScript: an empty string splits into [""]).
[[nodiscard]] inline std::vector<std::string> split(std::string_view s, char sep) {
  std::vector<std::string> out;
  std::size_t start = 0;
  for (std::size_t i = 0; i <= s.size(); ++i) {
    if (i == s.size() || s[i] == sep) {
      out.emplace_back(s.substr(start, i - start));
      start = i + 1;
    }
  }
  return out;
}

[[nodiscard]] inline std::string join(const std::vector<std::string>& parts, std::string_view sep) {
  std::string out;
  for (std::size_t i = 0; i < parts.size(); ++i) {
    if (i > 0) out += sep;
    out += parts[i];
  }
  return out;
}

[[nodiscard]] inline bool is_ascii_digit(char c) noexcept { return c >= '0' && c <= '9'; }
[[nodiscard]] inline bool is_ascii_alpha(char c) noexcept { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
[[nodiscard]] inline bool is_ascii_alnum(char c) noexcept { return is_ascii_digit(c) || is_ascii_alpha(c); }

/// `/^[A-Za-z0-9]{4}$/`.
[[nodiscard]] inline bool is_axis_tag(std::string_view s) noexcept {
  if (s.size() != 4) return false;
  for (const char c : s) {
    if (!is_ascii_alnum(c)) return false;
  }
  return true;
}

/// `/^\d+$/` → the number (nullopt otherwise; values past 2^31 rejected).
[[nodiscard]] inline std::optional<int> parse_index(std::string_view s) noexcept {
  if (s.empty() || s.size() > 9) return std::nullopt;
  int v = 0;
  for (const char c : s) {
    if (!is_ascii_digit(c)) return std::nullopt;
    v = v * 10 + (c - '0');
  }
  return v;
}

/// `/^([^.]+)\.(.+)$/` after a fixed prefix: `prefix<id>.<rest>` (id without dots, rest non-empty).
struct IdRest {
  std::string id;
  std::string rest;
};
[[nodiscard]] inline std::optional<IdRest> parse_prefixed_id_rest(std::string_view s, std::string_view prefix) {
  if (!s.starts_with(prefix)) return std::nullopt;
  const std::string_view tail = s.substr(prefix.size());
  const std::size_t dot = tail.find('.');
  if (dot == std::string_view::npos || dot == 0 || dot + 1 >= tail.size()) return std::nullopt;
  return IdRest{std::string(tail.substr(0, dot)), std::string(tail.substr(dot + 1))};
}

/// Title case as propertyMeta's `titleCase`: `[._]` → space, camel humps split,
/// whitespace collapsed, trimmed, first letter of every word upper-cased.
[[nodiscard]] inline std::string title_case(std::string_view s) {
  std::string a;
  for (const char c : s) a.push_back(c == '.' || c == '_' ? ' ' : c);
  std::string b;
  for (std::size_t i = 0; i < a.size(); ++i) {
    b.push_back(a[i]);
    const char c = a[i];
    const bool lowerOrDigit = (c >= 'a' && c <= 'z') || is_ascii_digit(c);
    if (lowerOrDigit && i + 1 < a.size() && a[i + 1] >= 'A' && a[i + 1] <= 'Z') b.push_back(' ');
  }
  // collapse whitespace runs (JS \s+ over ASCII here), trim
  std::string c;
  bool space = false;
  for (const char ch : b) {
    const bool ws = ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\f' || ch == '\v';
    if (ws) {
      space = true;
      continue;
    }
    if (space && !c.empty()) c.push_back(' ');
    space = false;
    c.push_back(ch);
  }
  // \b\w → upper: a word char preceded by a non-word char (or start).
  auto word = [](char ch) { return is_ascii_alnum(ch) || ch == '_'; };
  for (std::size_t i = 0; i < c.size(); ++i) {
    if (word(c[i]) && (i == 0 || !word(c[i - 1])) && c[i] >= 'a' && c[i] <= 'z') {
      c[i] = static_cast<char>(c[i] - 'a' + 'A');
    }
  }
  return c;
}

}  // namespace premation::doc
