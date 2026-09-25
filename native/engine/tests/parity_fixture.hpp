// The cross-engine parity fixture (src/core/engine/__testHelpers__/parityFixture.ts):
// the TypeScript engine's recorded requests and responses, replayed into a
// fresh in-process C++ Session per session and compared BYTE FOR BYTE (seq and
// revision zeroed; refusals by error code only — messages are each engine's
// own), with every revision step. Shared by D1's evaluation parity
// (test_d1_eval_parity.cpp) and F2's undo parity (test_undo_parity.cpp); each
// test executable is one translation unit that includes this once.
#pragma once

#include <catch2/catch_test_macros.hpp>

#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <sstream>
#include <string>
#include <type_traits>
#include <variant>
#include <vector>

#include "session_harness.hpp"

namespace {

namespace api = premation::api;
namespace wire = premation::wire;
using premation::test::Harness;

#ifndef PREMATION_ENGINE_TEST_DATA
#define PREMATION_ENGINE_TEST_DATA "."
#endif

struct Record {
  std::uint8_t kind = 0;  // 0 session request, 1 probe, 2 a request the fixture adds (F2's history walk)
  std::uint32_t step = 0;
  std::string label;
  std::vector<std::uint8_t> request;
  /// The TypeScript's normalized response in full, or (hashed = true) only its length + hash64.
  std::vector<std::uint8_t> response;
  bool hashed = false;
  std::uint32_t length = 0;
  std::uint64_t hash = 0;
};

/// Two FNV-1a 32-bit lanes (d1EvalParity.test.ts `hash64`).
std::uint64_t hash64(const std::vector<std::uint8_t>& b) {
  std::uint32_t h1 = 0x811c9dc5U;
  std::uint32_t h2 = 0x811c9dc5U ^ 0x5bd1e995U;
  for (const std::uint8_t x : b) {
    h1 = (h1 ^ x) * 0x01000193U;
    h2 = (h2 ^ x) * 0x01000193U;
  }
  return (static_cast<std::uint64_t>(h1) << 32U) | h2;
}
struct SessionData {
  std::string name;
  std::vector<Record> records;
};
struct Fixture {
  std::vector<std::pair<std::string, std::string>> files;
  std::vector<SessionData> sessions;
  bool ok = false;
};

/// Load `file` from the test data directory, or the file named by the environment variable `overrideVar`.
Fixture load_fixture(const char* file, const char* overrideVar) {
  Fixture fx;
  const char* override = std::getenv(overrideVar);
  std::ifstream f(override != nullptr ? std::string(override) : std::string(PREMATION_ENGINE_TEST_DATA "/") + file, std::ios::binary);
  const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  std::size_t at = 0;
  const auto u32 = [&](std::uint32_t& out) {
    if (at + 4 > bytes.size()) return false;
    out = static_cast<std::uint32_t>(bytes[at]) | (static_cast<std::uint32_t>(bytes[at + 1]) << 8U) |
          (static_cast<std::uint32_t>(bytes[at + 2]) << 16U) | (static_cast<std::uint32_t>(bytes[at + 3]) << 24U);
    at += 4;
    return true;
  };
  const auto blob = [&](std::vector<std::uint8_t>& out) {
    std::uint32_t n = 0;
    if (!u32(n) || at + n > bytes.size()) return false;
    out.assign(bytes.begin() + static_cast<std::ptrdiff_t>(at), bytes.begin() + static_cast<std::ptrdiff_t>(at + n));
    at += n;
    return true;
  };
  const auto text = [&](std::string& out) {
    std::vector<std::uint8_t> b;
    if (!blob(b)) return false;
    out.assign(b.begin(), b.end());
    return true;
  };
  if (bytes.size() < 4 || std::string(bytes.begin(), bytes.begin() + 4) != "D1EV") return fx;
  at = 4;
  std::uint32_t version = 0;
  std::uint32_t nfiles = 0;
  if (!u32(version) || version != 2 || !u32(nfiles)) return fx;
  for (std::uint32_t i = 0; i < nfiles; ++i) {
    std::string p;
    std::string doc;
    if (!text(p) || !text(doc)) return fx;
    fx.files.emplace_back(std::move(p), std::move(doc));
  }
  std::uint32_t nsessions = 0;
  if (!u32(nsessions)) return fx;
  for (std::uint32_t s = 0; s < nsessions; ++s) {
    SessionData sd;
    std::uint32_t n = 0;
    if (!text(sd.name) || !u32(n)) return fx;
    for (std::uint32_t i = 0; i < n; ++i) {
      Record r;
      if (at + 1 > bytes.size()) return fx;
      r.kind = bytes[at++];
      if (!u32(r.step) || !text(r.label) || at + 1 > bytes.size()) return fx;
      if (bytes[at++] == 1) {
        // A getPropertyValues over record `base`'s properties at another time.
        std::uint32_t base = 0;
        std::uint32_t seq = 0;
        if (!u32(base) || !u32(seq) || base >= sd.records.size() || at + 9 > bytes.size()) return fx;
        std::uint64_t bits = 0;
        for (std::size_t k = 0; k < 8; ++k) bits |= static_cast<std::uint64_t>(bytes[at + k]) << (8U * k);
        at += 8;
        const bool evaluated = bytes[at++] != 0;
        api::EngineMessage m;
        wire::Reader rd(sd.records[base].request);
        if (api::decode(rd, m) != wire::Status::ok) return fx;
        auto* req = std::get_if<api::Request>(&m.v);
        auto* q = req != nullptr ? std::get_if<api::Query>(&req->body.v) : nullptr;
        auto* pv = q != nullptr ? std::get_if<api::GetPropertyValues>(&q->v) : nullptr;
        if (pv == nullptr) return fx;
        req->seq = seq;
        pv->time = static_cast<api::Time>(std::bit_cast<double>(bits));
        pv->evaluated = evaluated;
        wire::Writer w;
        api::encode(w, m);
        r.request.assign(w.bytes().begin(), w.bytes().end());
      } else if (!blob(r.request)) {
        return fx;
      }
      if (at + 1 > bytes.size()) return fx;
      r.hashed = bytes[at++] == 1;
      if (r.hashed) {
        std::uint32_t h1 = 0;
        std::uint32_t h2 = 0;
        if (!u32(r.length) || !u32(h1) || !u32(h2)) return fx;
        r.hash = (static_cast<std::uint64_t>(h1) << 32U) | h2;
      } else if (!blob(r.response)) {
        return fx;
      }
      sd.records.push_back(std::move(r));
    }
    fx.sessions.push_back(std::move(sd));
  }
  fx.ok = at == bytes.size();
  return fx;
}

std::string hex_of(std::string_view s) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  for (const char c : s) {
    const auto b = static_cast<unsigned char>(c);
    out.push_back(kHex[b >> 4U]);
    out.push_back(kHex[b & 15U]);
  }
  return out;
}

std::vector<std::uint8_t> encode_normalized(api::Response r) {
  r.seq = 0;
  r.revision = 0;
  api::EngineMessage m;
  m.v = std::move(r);
  wire::Writer w;
  api::encode(w, m);
  return {w.bytes().begin(), w.bytes().end()};
}

bool decode_response(const std::vector<std::uint8_t>& bytes, api::Response& out) {
  api::EngineMessage m;
  wire::Reader rd(bytes);
  if (api::decode(rd, m) != wire::Status::ok) return false;
  const auto* r = std::get_if<api::Response>(&m.v);
  if (r == nullptr) return false;
  out = *r;
  return true;
}

/// The active alternative of a (possibly type-repeating) variant as T, or null.
template <class T, class V>
const T* as(const V& v) {
  return std::visit(
      [](const auto& x) -> const T* {
        if constexpr (std::is_same_v<std::decay_t<decltype(x)>, T>) {
          return &x;
        } else {
          return nullptr;
        }
      },
      v);
}

std::string num(double x) {
  char buf[40];
  std::snprintf(buf, sizeof buf, "%.17g", x);
  return buf;
}

std::string value_text(const api::Value& v) {
  return std::visit(
      [](const auto& x) -> std::string {
        using T = std::decay_t<decltype(x)>;
        if constexpr (std::is_same_v<T, double>) {
          return num(x);
        } else if constexpr (std::is_same_v<T, std::int64_t>) {
          return std::to_string(x);
        } else if constexpr (std::is_same_v<T, api::Vec2>) {
          return "[" + num(x.x) + "," + num(x.y) + "]";
        } else if constexpr (std::is_same_v<T, api::Vec3>) {
          return "[" + num(x.x) + "," + num(x.y) + "," + num(x.z) + "]";
        } else if constexpr (std::is_same_v<T, api::Vec4>) {
          return "[" + num(x.x) + "," + num(x.y) + "," + num(x.z) + "," + num(x.w) + "]";
        } else if constexpr (std::is_same_v<T, api::Color>) {
          return "rgba(" + num(x.r) + "," + num(x.g) + "," + num(x.b) + "," + num(x.a) + ")";
        } else if constexpr (std::is_same_v<T, std::string>) {
          return "'" + x.substr(0, 400) + "'";
        } else if constexpr (std::is_same_v<T, std::monostate>) {
          return "none";
        } else {
          return "<value>";
        }
      },
      v.v);
}

std::string outcome_text(const api::Response& r) {
  switch (r.outcome.kind()) {
    case api::Outcome::Kind::error: {
      const auto& e = std::get<api::EngineError>(r.outcome.v);
      return "error " + std::to_string(static_cast<std::uint32_t>(e.code)) + " (" + e.message + ")";
    }
    case api::Outcome::Kind::command: return "command ok";
    case api::Outcome::Kind::query: return "query ok";
    case api::Outcome::Kind::batch: return "batch ok";
  }
  return "?";
}

/// Where two decoded responses of the same query differ, readably (best effort).
std::string explain(const api::Response& ts, const api::Response& cx) {
  std::ostringstream o;
  const auto* tc = as<api::CommandResult>(ts.outcome.v);
  const auto* cc = as<api::CommandResult>(cx.outcome.v);
  if (tc != nullptr && cc != nullptr) {
    const auto* th = as<api::HistoryStep>(tc->v);
    const auto* ch = as<api::HistoryStep>(cc->v);
    if (th != nullptr && ch != nullptr) {
      o << "\n      history ts '" << th->label << "'@" << th->position << " c++ '" << ch->label << "'@" << ch->position;
      return o.str();
    }
    const auto* tsv = as<api::SaveProjectResult>(tc->v);
    const auto* csv = as<api::SaveProjectResult>(cc->v);
    if (tsv != nullptr && csv != nullptr) {
      o << "\n      saved bytes ts " << tsv->bytes << " c++ " << csv->bytes;
      return o.str();
    }
  }
  const auto* tq = as<api::QueryResult>(ts.outcome.v);
  const auto* cq = as<api::QueryResult>(cx.outcome.v);
  if (tq != nullptr && cq != nullptr) {
    const auto keysets = [&o](const std::vector<api::KeyframeSet>& a, const std::vector<api::KeyframeSet>& b) {
      if (a.size() != b.size()) o << "\n      keyframe sets ts " << a.size() << " c++ " << b.size();
      int shownSets = 0;
      for (std::size_t i = 0; i < a.size() && i < b.size() && shownSets < 6; ++i) {
        if (a[i] == b[i]) continue;
        ++shownSets;
        o << "\n      keys " << a[i].prop.layer << " " << a[i].prop.path << ": ts";
        for (const auto& k : a[i].keyframes) o << " " << k.id << "@" << k.time;
        o << " | c++";
        for (const auto& k : b[i].keyframes) o << " " << k.id << "@" << k.time;
      }
    };
    const auto* td = as<api::DocumentSnapshot>(tq->v);
    const auto* cd = as<api::DocumentSnapshot>(cq->v);
    if (td != nullptr && cd != nullptr) {
      if (td->revision != cd->revision) o << "\n      revision ts " << td->revision << " c++ " << cd->revision;
      keysets(td->keyframes, cd->keyframes);
      if (td->layers != cd->layers) o << "\n      layers differ";
      if (td->property_trees != cd->property_trees) o << "\n      property trees differ";
      if (td->items != cd->items) o << "\n      items differ";
      if (td->comps != cd->comps) o << "\n      comps differ";
      return o.str();
    }
    const auto* tk = as<api::KeyframeSets>(tq->v);
    const auto* ck = as<api::KeyframeSets>(cq->v);
    if (tk != nullptr && ck != nullptr) {
      keysets(tk->sets, ck->sets);
      return o.str();
    }
    const auto* tv = as<api::PropertyValues>(tq->v);
    const auto* cv = as<api::PropertyValues>(cq->v);
    if (tv != nullptr && cv != nullptr) {
      int shown = 0;
      for (std::size_t i = 0; i < tv->values.size() && i < cv->values.size(); ++i) {
        if (tv->values[i] == cv->values[i]) continue;
        if (shown++ < 6) o << "\n      " << tv->values[i].prop.path << ": ts " << value_text(tv->values[i].value) << " c++ " << value_text(cv->values[i].value);
      }
      if (tv->values.size() != cv->values.size()) o << "\n      count ts " << tv->values.size() << " c++ " << cv->values.size();
      if (shown > 6) o << "\n      … " << shown << " values differ";
      return o.str();
    }
    const auto* ts_ = as<api::PropertySamples>(tq->v);
    const auto* cs = as<api::PropertySamples>(cq->v);
    if (ts_ != nullptr && cs != nullptr) {
      for (std::size_t i = 0; i < ts_->values.size() && i < cs->values.size(); ++i) {
        if (std::bit_cast<std::uint64_t>(ts_->values[i]) != std::bit_cast<std::uint64_t>(cs->values[i])) {
          o << "\n      value[" << i << "] ts " << num(ts_->values[i]) << " c++ " << num(cs->values[i]);
          break;
        }
      }
      for (std::size_t i = 0; i < ts_->speeds.size() && i < cs->speeds.size(); ++i) {
        if (std::bit_cast<std::uint64_t>(ts_->speeds[i]) != std::bit_cast<std::uint64_t>(cs->speeds[i])) {
          o << "\n      speed[" << i << "] ts " << num(ts_->speeds[i]) << " c++ " << num(cs->speeds[i]);
          break;
        }
      }
      return o.str();
    }
    const auto* tl = as<api::LayerTransformList>(tq->v);
    const auto* cl = as<api::LayerTransformList>(cq->v);
    if (tl != nullptr && cl != nullptr) {
      for (std::size_t i = 0; i < tl->transforms.size() && i < cl->transforms.size(); ++i) {
        if (tl->transforms[i] == cl->transforms[i]) continue;
        o << "\n      " << tl->transforms[i].layer << ": ts";
        for (const double x : tl->transforms[i].matrix) o << " " << num(x);
        o << "\n      " << cl->transforms[i].layer << ": c++";
        for (const double x : cl->transforms[i].matrix) o << " " << num(x);
        break;
      }
      return o.str();
    }
    const auto* tt = as<api::PropertyTree>(tq->v);
    const auto* ct = as<api::PropertyTree>(cq->v);
    if (tt != nullptr && ct != nullptr) {
      if (tt->nodes.size() != ct->nodes.size()) o << "\n      nodes ts " << tt->nodes.size() << " c++ " << ct->nodes.size();
      int shownNodes = 0;
      for (std::size_t i = 0; i < tt->nodes.size() && i < ct->nodes.size(); ++i) {
        if (tt->nodes[i] == ct->nodes[i]) continue;
        const auto& a = tt->nodes[i];
        const auto& b = ct->nodes[i];
        o << "\n      node " << a.path << (a.path != b.path ? " vs " + b.path : "");
        if (a.value != b.value) o << " value ts " << (a.value ? value_text(*a.value) : "-") << " c++ " << (b.value ? value_text(*b.value) : "-");
        if (a.default_value != b.default_value) o << " default differs";
        if (a.animated != b.animated || a.keyframe_count != b.keyframe_count) o << " animation differs";
        if (a.expression != b.expression || a.expression_error != b.expression_error) o << " expression ts '" << a.expression_error << "' c++ '" << b.expression_error << "'";
        if (a.children != b.children) o << " children differ";
        if (++shownNodes >= 6) break;
      }
      return o.str();
    }
  }
  return o.str();
}

/// saveProject: the path is compared; the byte COUNT is each engine's own
/// serializer's (the C++ JSON writer emits ~300 more bytes per document — a
/// document-format difference, not an evaluation one; tracked in the plan).
bool same_save(const api::Response& a, const api::Response& b) {
  const auto* ca = as<api::CommandResult>(a.outcome.v);
  const auto* cb = as<api::CommandResult>(b.outcome.v);
  const auto* sa = ca != nullptr ? as<api::SaveProjectResult>(ca->v) : nullptr;
  const auto* sb = cb != nullptr ? as<api::SaveProjectResult>(cb->v) : nullptr;
  return sa != nullptr && sb != nullptr && sa->path == sb->path;
}

/// Where two encodings first part, with the printable bytes around it.
std::string byte_diff(const std::vector<std::uint8_t>& a, const std::vector<std::uint8_t>& b) {
  std::size_t i = 0;
  while (i < a.size() && i < b.size() && a[i] == b[i]) ++i;
  const auto window = [i](const std::vector<std::uint8_t>& v) {
    std::string out;
    const std::size_t from = i > 60 ? i - 60 : 0;
    for (std::size_t k = from; k < v.size() && k < i + 80; ++k) out.push_back(v[k] >= 32 && v[k] < 127 ? static_cast<char>(v[k]) : '.');
    return out;
  };
  return "\n      at byte " + std::to_string(i) + " (sizes " + std::to_string(a.size()) + " / " + std::to_string(b.size()) + ")\n      ts  " +
         window(a) + "\n      c++ " + window(b);
}

struct Report {
  std::size_t records = 0;
  std::size_t requests = 0;
  std::size_t probes = 0;
  std::size_t walk = 0;
  std::size_t outcomeDiffs = 0;  // ok vs error, or a different error code
  std::size_t valueDiffs = 0;    // both ok, bytes differ
  std::size_t stepDiffs = 0;     // revision moved by a different amount
  std::size_t probeDiffs = 0;    // probes (of the above) that differ
  std::map<std::string, std::size_t> byLabel;
  std::vector<std::string> lines;
  [[nodiscard]] std::size_t mismatches() const { return outcomeDiffs + valueDiffs + stepDiffs; }
};

Report replay(const SessionData& s, const std::string& portsDir) {
  Report rep;
  Harness h(3, portsDir);
  (void)h.hello();
  REQUIRE(premation::test::is_ok(h.run(premation::test::cmd(api::NewProject{}))));
  REQUIRE(premation::test::is_ok(h.run(premation::test::cmd(api::ClearHistory{}))));
  std::uint64_t revision = h.session.revision();
  for (const Record& r : s.records) {
    rep.records += 1;
    (r.kind == 1 ? rep.probes : r.kind == 2 ? rep.walk : rep.requests) += 1;
    api::EngineMessage msg;
    wire::Reader rd(r.request);
    REQUIRE(api::decode(rd, msg) == wire::Status::ok);
    auto* req = std::get_if<api::Request>(&msg.v);
    REQUIRE(req != nullptr);
    const api::Seq seq = req->seq;
    const std::size_t before = h.messages.size();
    h.feed(msg);
    const api::Response* got = nullptr;
    for (std::size_t i = before; i < h.messages.size(); ++i) {
      if (const auto* x = std::get_if<api::Response>(&h.messages[i].v); x != nullptr && x->seq == seq) got = x;
    }
    REQUIRE(got != nullptr);
    const std::uint64_t step = got->revision - revision;
    revision = got->revision;
    const std::string where = "#" + std::to_string(rep.records - 1) + (r.kind == 1 ? " probe " : r.kind == 2 ? " walk " : " ") + r.label;
    bool differs = false;
    const bool cxErr = got->outcome.kind() == api::Outcome::Kind::error;
    const std::vector<std::uint8_t> mine = encode_normalized(*got);
    if (r.hashed) {
      // Only large successful answers are hashed (errors are small).
      if (cxErr) {
        rep.outcomeDiffs += 1;
        differs = true;
        rep.lines.push_back(where + ": ts ok | c++ " + outcome_text(*got));
      } else if (mine.size() != r.length || hash64(mine) != r.hash) {
        rep.valueDiffs += 1;
        differs = true;
        rep.lines.push_back(where + ": values differ (hashed; a full fixture explains)");
      }
    } else {
      api::Response expected;
      REQUIRE(decode_response(r.response, expected));
      const bool tsErr = expected.outcome.kind() == api::Outcome::Kind::error;
      if (tsErr || cxErr) {
        if (tsErr != cxErr || std::get<api::EngineError>(expected.outcome.v).code != std::get<api::EngineError>(got->outcome.v).code) {
          rep.outcomeDiffs += 1;
          differs = true;
          rep.lines.push_back(where + ": ts " + outcome_text(expected) + " | c++ " + outcome_text(*got));
        }
      } else if (r.label == "saveProject" ? !same_save(expected, *got) : mine != r.response) {
        rep.valueDiffs += 1;
        differs = true;
        std::string why = explain(expected, *got);
        if (why.empty()) why = byte_diff(r.response, mine);
        rep.lines.push_back(where + ": values differ" + why);
        if (const char* dump = std::getenv("PARITY_DUMP"); dump != nullptr) {
          // Both encoded responses, for a readable diff (decode with @motion/engine-api).
          const std::string base = std::string(dump) + "/" + std::to_string(rep.records - 1);
          std::ofstream(base + ".ts.bin", std::ios::binary).write(reinterpret_cast<const char*>(r.response.data()), static_cast<std::streamsize>(r.response.size()));
          std::ofstream(base + ".cx.bin", std::ios::binary).write(reinterpret_cast<const char*>(mine.data()), static_cast<std::streamsize>(mine.size()));
        }
      }
    }
    if (step != r.step) {
      rep.stepDiffs += 1;
      differs = true;
      rep.lines.push_back(where + ": revision +" + std::to_string(r.step) + " (ts) vs +" + std::to_string(step) + " (c++)");
    }
    if (differs) {
      rep.byLabel[r.label] += 1;
      if (r.kind == 1) rep.probeDiffs += 1;
    }
  }
  return rep;
}

/// Replay every session of `fx`, print the report under `title`, return the number of differences.
/// `scratch` names the temp directory the corpus's project files are seeded into.
std::size_t run_parity(const char* title, const Fixture& fx, const char* scratch, const char* verboseVar) {
  REQUIRE(fx.ok);
  REQUIRE(!fx.sessions.empty());
  premation::log::set_min_level(premation::log::Level::error);

  // The corpus's project files, where the C++ test ports read them.
  const std::filesystem::path dir = std::filesystem::temp_directory_path() / scratch;
  const auto seedFiles = [&] {
    std::filesystem::remove_all(dir);
    std::filesystem::create_directories(dir);
    for (const auto& [p, doc] : fx.files) {
      std::ofstream(dir / (hex_of(p) + ".json"), std::ios::binary) << doc;
    }
  };

  const bool verbose = std::getenv(verboseVar) != nullptr;
  std::size_t total = 0;
  std::size_t totalRecords = 0;
  std::size_t totalProbes = 0;
  std::size_t totalWalk = 0;
  std::size_t totalProbeDiffs = 0;
  std::size_t cleanSessions = 0;
  std::map<std::string, std::size_t> byLabel;
  std::string table;
  for (const SessionData& s : fx.sessions) {
    // Each session starts from its own copy of the project files.
    seedFiles();
    const Report r = replay(s, dir.string());
    total += r.mismatches();
    totalRecords += r.records;
    totalProbes += r.probes;
    totalWalk += r.walk;
    totalProbeDiffs += r.probeDiffs;
    if (r.mismatches() == 0) cleanSessions += 1;
    for (const auto& [k, n] : r.byLabel) byLabel[k] += n;
    char row[512];
    std::snprintf(row, sizeof row, "  %-60.60s records %4zu probes %4zu walk %3zu | outcome %3zu value %4zu step %3zu (probes %4zu)\n", s.name.c_str(),
                  r.records, r.probes, r.walk, r.outcomeDiffs, r.valueDiffs, r.stepDiffs, r.probeDiffs);
    table += row;
    const std::size_t show = verbose ? r.lines.size() : std::min<std::size_t>(r.lines.size(), 3);
    for (std::size_t i = 0; i < show; ++i) table += "      " + r.lines[i] + "\n";
  }
  std::string labels;
  for (const auto& [k, n] : byLabel) labels += "  " + k + ": " + std::to_string(n) + "\n";
  std::printf("[%s] %zu sessions (%zu identical), %zu records (%zu probes, %zu walk steps); differing: %zu (probes %zu)\n%s by request type:\n%s",
              title, fx.sessions.size(), cleanSessions, totalRecords, totalProbes, totalWalk, total, totalProbeDiffs, table.c_str(), labels.c_str());
  std::filesystem::remove_all(dir);
  return total;
}

}  // namespace
