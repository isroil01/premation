// Deterministic protocol stress (docs/NATIVE_CORE_PLAN.md §6: every protocol
// message type is fuzzed). Seeded random traffic — valid requests over the
// whole command set, corrupted and truncated messages, random frames, random
// stream chunking, clock jumps, bogus and real slot releases — into a Session.
// After every step: nothing crashed, every message the engine sent decodes,
// revisions never go backwards, and the document is structurally sound.
//
// PREMATION_STRESS_ITERATIONS overrides the step count (default 20,000; the
// sanitizer runs use more). The libFuzzer twin is fuzz_protocol.cpp.
//
// The replay-corpus cases replay every session the cross-engine test sent to
// this engine (tests/data/replay_corpus.bin: every edit command family, real
// ids and values): once clean — no internal error, the invariants after every
// request, and undo all the way back lands on the starting document exactly —
// and PREMATION_STRESS_ROUNDS times mutated (requests dropped, repeated,
// corrupted, undo/redo/jumps spliced in).

#include <catch2/catch_test_macros.hpp>

#include <cstdlib>
#include <memory>
#include <set>

#include "core/catalog_data.hpp"
#include "invariants.hpp"
#include "random_requests.hpp"
#include "replay_corpus.hpp"

using namespace premation;
using namespace premation::test;

namespace {

std::uint64_t iterations() {
  if (const char* env = std::getenv("PREMATION_STRESS_ITERATIONS")) {  // NOLINT(concurrency-mt-unsafe): test setup
    const auto n = std::strtoull(env, nullptr, 10);
    if (n > 0) return n;
  }
  return 20'000;
}

std::unique_ptr<Harness> fresh() {
  auto h = std::make_unique<Harness>(3);
  (void)h->hello();
  return h;
}

}  // namespace

TEST_CASE("stress: random and corrupted traffic never crashes or corrupts the document", "[stress]") {
  RandomTraffic rt(0xC2C2C2C2ULL);
  auto h = fresh();
  api::Revision lastRev = 0;
  std::uint64_t sessions = 1;
  std::uint64_t errors = 0;
  std::uint64_t frames = 0;
  const std::uint64_t n = iterations();
  for (std::uint64_t i = 0; i < n; ++i) {
    const auto dice = rt.u(100);
    if (dice < 60) {
      wire::Writer w;
      api::encode(w, rt.message(++h->seq));
      std::vector<std::uint8_t> bytes(w.bytes().begin(), w.bytes().end());
      if (rt.coin(0.25)) rt.mutate(bytes);
      h->session.on_frame(bytes, h->now);
    } else if (dice < 68) {
      std::vector<std::uint8_t> junk(rt.u(64));
      for (auto& b : junk) b = static_cast<std::uint8_t>(rt.u(256));
      h->session.on_frame(junk, h->now);
    } else if (dice < 78) {
      // Stream level: several framed messages, arbitrary chunking.
      std::vector<std::uint8_t> stream;
      const auto count = rt.u(4) + 1;
      for (std::uint64_t k = 0; k < count; ++k) {
        wire::Writer w;
        api::encode(w, rt.message(++h->seq));
        framing::append_frame(stream, w.bytes());
      }
      if (rt.coin(0.1)) rt.mutate(stream);
      framing::Decoder d(1U << 20U);
      std::size_t at = 0;
      while (at < stream.size()) {
        const std::size_t take = std::min<std::size_t>(stream.size() - at, rt.u(40) + 1);
        d.feed(std::span<const std::uint8_t>(stream.data() + at, take));
        at += take;
        std::span<const std::uint8_t> payload;
        while (d.next(payload)) h->session.on_frame(payload, h->now);
      }
    } else if (dice < 88) {
      h->advance(std::chrono::microseconds(rt.u(200'000)));
      if (rt.coin(0.7)) h->release_all();
    } else if (dice < 95) {
      std::vector<std::uint8_t> junk(rt.u(40));
      for (auto& b : junk) b = static_cast<std::uint8_t>(rt.u(256));
      frames::Message m;
      (void)frames::decode(junk, m);
      h->sink.release(static_cast<std::uint32_t>(rt.u(5)), static_cast<std::uint32_t>(rt.u(5)));
    } else {
      h->session.on_ping(rt.u(1000), 0);
    }

    REQUIRE(h->decodeFailures == 0);
    std::string why;
    if (!document_consistent(h->session.document(), why)) FAIL(why);
    REQUIRE(h->session.revision() >= lastRev);
    lastRev = h->session.revision();
    for (const auto& m : h->messages) {
      if (m.kind() == api::EngineMessage::Kind::response &&
          std::get<api::Response>(m.v).outcome.kind() == api::Outcome::Kind::error) {
        ++errors;
      }
    }
    frames += h->frames_ready().size();
    h->messages.clear();
    h->frameMsgs.clear();
    h->wireLog.clear();
    if (h->session.finished()) {  // a corrupted message decoded as Goodbye, or a protocol error
      h = fresh();
      lastRev = 0;
      ++sessions;
    }
  }
  INFO("sessions " << sessions << ", error responses " << errors << ", frames " << frames);
  REQUIRE(sessions >= 1);
  REQUIRE(errors > 0);  // the traffic really does reach the error paths
  REQUIRE(frames > 0);  // … and the render path
}

namespace {

std::uint64_t rounds() {
  if (const char* env = std::getenv("PREMATION_STRESS_ROUNDS")) {  // NOLINT(concurrency-mt-unsafe): test setup
    const auto n = std::strtoull(env, nullptr, 10);
    if (n > 0) return n;
  }
  return 2;
}

bool has_internal_error(const Harness& h) {
  for (const auto& m : h.messages) {
    if (m.kind() == api::EngineMessage::Kind::response) {
      const auto& r = std::get<api::Response>(m.v);
      if (r.outcome.kind() == api::Outcome::Kind::error && std::get<api::EngineError>(r.outcome.v).code == api::ErrorCode::internal) return true;
    }
  }
  return false;
}

/// Whether the session resets or trims history (then "undo to the start" does not apply).
bool touches_history_or_project(const ReplaySession& s) {
  static const std::set<std::string> kHistory = {"clearHistory", "setHistoryLimit"};
  for (const auto& bytes : s) {
    api::EngineMessage m;
    wire::Reader r(bytes);
    if (api::decode(r, m) != wire::Status::ok || m.kind() != api::EngineMessage::Kind::request) continue;
    const auto& body = std::get<api::Request>(m.v).body;
    if (const auto* c = std::get_if<api::Command>(&body.v)) {
      const auto id = static_cast<std::uint32_t>(c->kind());
      const auto& reg = doc::registry();
      if (reg.commandKinds.at(id) == "io" || kHistory.contains(reg.commandNames.at(id))) return true;
    }
  }
  return false;
}

}  // namespace

TEST_CASE("stress: the replay corpus replays cleanly and undoes back to the start", "[stress][replay]") {
  const auto corpus = load_replay_corpus();
  REQUIRE(corpus.size() >= 40);
  std::size_t requests = 0;
  std::size_t undoChecked = 0;
  for (std::size_t si = 0; si < corpus.size(); ++si) {
    INFO("session " << si);
    auto h = fresh();
    const DocState start = state_of(h->session.document());
    for (std::size_t i = 0; i < corpus[si].size(); ++i) {
      INFO("request " << i);
      h->session.on_frame(corpus[si][i], h->now);
      h->session.tick(h->now);
      REQUIRE(h->decodeFailures == 0);
      REQUIRE_FALSE(has_internal_error(*h));
      std::string why;
      if (!document_consistent(h->session.document(), why)) FAIL(why);
      h->messages.clear();
      ++requests;
    }
    if (touches_history_or_project(corpus[si])) continue;
    // Close a gesture the session left open, then undo everything.
    (void)h->run(cmd(api::EndGesture{0, true}));
    {
      // A session with more edits than the history holds cannot undo to its start.
      const auto r = h->ask(qry(api::GetHistory{}));
      const auto& hist = std::get<api::HistoryState>(std::get<api::QueryResult>(r.outcome.v).v);
      if (hist.entries.size() >= hist.limit) continue;
    }
    for (int guard = 0; guard < 2000; ++guard) {
      if (!is_ok(h->run(cmd(api::Undo{})))) break;
    }
    const DocState endState = state_of(h->session.document());
    if (!(endState == start)) {
      const auto diff = first_difference(endState, start);
      std::string detail;
      if (diff.rfind("node ", 0) == 0) {
        const std::string id = diff.substr(5, diff.find(' ', 5) - 5);
        const auto& a = endState.nodes.at(id);
        const auto& b = start.nodes.at(id);
        detail = "name " + a.name + "/" + b.name + " children " + std::to_string(a.children.size()) + "/" + std::to_string(b.children.size()) + " comps " + std::to_string(a.components.size()) + "/" + std::to_string(b.components.size());
        for (std::size_t k = 0; k < std::min(a.components.size(), b.components.size()); ++k) {
          if (!(a.components[k] == b.components[k])) detail += " | " + a.components[k].type + ": " + js::stringify(a.components[k].props) + " vs " + js::stringify(b.components[k].props);
        }
      }
      FAIL(diff << " " << detail);
    }
    ++undoChecked;
  }
  INFO("requests " << requests << ", sessions undone to the start " << undoChecked);
  REQUIRE(requests > 5000);
  REQUIRE(undoChecked >= 30);
}

TEST_CASE("stress: mutated replays never crash, corrupt or fail internally", "[stress][replay]") {
  const auto corpus = load_replay_corpus();
  REQUIRE_FALSE(corpus.empty());
  RandomTraffic rt(0xD1B0D1B0ULL);
  std::uint64_t steps = 0;
  for (std::uint64_t round = 0; round < rounds(); ++round) {
    for (const auto& session : corpus) {
      auto h = fresh();
      api::Revision lastRev = 0;
      for (const auto& original : session) {
        const auto dice = rt.u(100);
        std::vector<std::vector<std::uint8_t>> send;
        if (dice < 84) {
          send.push_back(original);
        } else if (dice < 89) {
          // dropped
        } else if (dice < 92) {
          send.push_back(original);
          send.push_back(original);
        } else if (dice < 96) {
          wire::Writer w;
          api::Command c;
          switch (rt.u(3)) {
            case 0: c.v = api::Undo{}; break;
            case 1: c.v = api::Redo{}; break;
            default: c.v = api::JumpToHistory{static_cast<std::uint32_t>(rt.u(20))}; break;
          }
          api::Request req;
          req.seq = ++h->seq;
          req.body.v = std::move(c);
          api::EngineMessage m;
          m.v = std::move(req);
          api::encode(w, m);
          send.emplace_back(w.bytes().begin(), w.bytes().end());
          send.push_back(original);
        } else {
          auto bytes = original;
          rt.mutate(bytes);
          send.push_back(std::move(bytes));
        }
        for (const auto& bytes : send) {
          h->session.on_frame(bytes, h->now);
          h->session.tick(h->now);
          ++steps;
          REQUIRE(h->decodeFailures == 0);
          REQUIRE_FALSE(has_internal_error(*h));
          std::string why;
          if (!document_consistent(h->session.document(), why)) FAIL(why);
          REQUIRE(h->session.revision() >= lastRev);
          lastRev = h->session.revision();
          h->messages.clear();
          h->frameMsgs.clear();
          h->wireLog.clear();
          if (h->session.finished()) break;
        }
        if (h->session.finished()) break;
      }
    }
  }
  INFO("steps " << steps);
  REQUIRE(steps > 0);
}
