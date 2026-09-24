// A Session wired to a capturing Outbox and a SimulatedSink, driven with a
// synthetic clock. Every message goes through the real codec in both
// directions (requests are encoded and fed to on_frame; everything the
// session sends is encoded, kept as bytes, and decoded again).
#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

#include "core/log.hpp"
#include "core/session.hpp"
#include "core/simulated_sink.hpp"
#include "core/values.hpp"
#include "premation/protocol/framing.hpp"

namespace premation::test {

namespace api = premation::api;

template <class T>
api::Command cmd(T x) {
  api::Command c;
  c.v = std::move(x);
  return c;
}

template <class T>
api::Query qry(T x) {
  api::Query q;
  q.v = std::move(x);
  return q;
}

inline api::Value vec2(double x, double y) { return doc::v_vec2(x, y); }
inline api::Value scalar(double x) { return doc::v_scalar(x); }

class Harness final : public Outbox {
 public:
  using Clock = Session::Clock;

  explicit Harness(std::uint32_t slots = 3, std::string portsDir = {})
      : sink([this](const frames::Message& m) { frameMsgs.push_back(m); }, slots),
        session(*this, sink, SessionOptions{.testPorts = true, .testPortsDir = std::move(portsDir)}) {
    log::set_min_level(log::Level::error);  // corrupted traffic logs a warning per message
  }

  void send(const api::EngineMessage& m) override {
    wire::Writer w;
    api::encode(w, m);
    const auto bytes = w.bytes();
    wireLog.insert(wireLog.end(), bytes.begin(), bytes.end());
    api::EngineMessage back;
    wire::Reader r(bytes);
    if (api::decode(r, back) != wire::Status::ok) decodeFailures++;
    messages.push_back(std::move(back));
  }
  void send_frames(const frames::Message& m) override { frameMsgs.push_back(m); }
  [[nodiscard]] std::size_t backlog_bytes() const override { return backlog; }

  void feed(const api::EngineMessage& m) {
    wire::Writer w;
    api::encode(w, m);
    session.on_frame(w.bytes(), now);
    session.tick(now);
  }

  api::Welcome hello(std::uint32_t major = api::kProtocolMajor) {
    api::EngineMessage m;
    m.v = api::Hello{major, api::kProtocolMinor, "test", "1", {}};
    feed(m);
    for (const auto& msg : messages) {
      if (msg.kind() == api::EngineMessage::Kind::welcome) return std::get<api::Welcome>(msg.v);
    }
    return {};
  }

  api::Response submit(api::RequestBody body, std::optional<api::Revision> base = std::nullopt) {
    api::Request req;
    req.seq = ++seq;
    req.body = std::move(body);
    req.base_revision = base;
    api::EngineMessage m;
    m.v = std::move(req);
    const std::size_t before = messages.size();
    feed(m);
    for (std::size_t i = before; i < messages.size(); ++i) {
      if (messages[i].kind() == api::EngineMessage::Kind::response) {
        const auto& r = std::get<api::Response>(messages[i].v);
        if (r.seq == seq) return r;
      }
    }
    return {};
  }
  api::Response run(api::Command c, std::optional<api::Revision> base = std::nullopt) {
    api::RequestBody b;
    b.v = std::move(c);
    return submit(std::move(b), base);
  }
  api::Response ask(api::Query q) {
    api::RequestBody b;
    b.v = std::move(q);
    return submit(std::move(b));
  }
  api::Response batch(std::string label, std::vector<api::Command> commands) {
    api::RequestBody b;
    b.v = api::CommandBatch{std::move(label), std::move(commands)};
    return submit(std::move(b));
  }

  /// Events of every EventBatch sent since message index `from`.
  [[nodiscard]] std::vector<api::Event> events_since(std::size_t from) const {
    std::vector<api::Event> out;
    for (std::size_t i = from; i < messages.size(); ++i) {
      if (messages[i].kind() != api::EngineMessage::Kind::events) continue;
      for (const auto& e : std::get<api::EventBatch>(messages[i].v).events) out.push_back(e);
    }
    return out;
  }
  [[nodiscard]] std::vector<api::EventBatch> batches_since(std::size_t from) const {
    std::vector<api::EventBatch> out;
    for (std::size_t i = from; i < messages.size(); ++i) {
      if (messages[i].kind() == api::EngineMessage::Kind::events) out.push_back(std::get<api::EventBatch>(messages[i].v));
    }
    return out;
  }

  void advance(std::chrono::microseconds dt) {
    now += dt;
    session.tick(now);
  }

  /// Release every slot of the current generation the sink announced.
  void release_all() {
    for (const auto& m : frameMsgs) {
      if (const auto* f = std::get_if<api::FrameReady>(&m.v)) sink.release(f->generation, f->slot);
    }
  }
  [[nodiscard]] std::vector<api::FrameReady> frames_ready() const {
    std::vector<api::FrameReady> out;
    for (const auto& m : frameMsgs) {
      if (const auto* f = std::get_if<api::FrameReady>(&m.v)) out.push_back(*f);
    }
    return out;
  }

  std::vector<api::EngineMessage> messages;
  std::vector<std::uint8_t> wireLog;
  std::vector<frames::Message> frameMsgs;
  int decodeFailures = 0;
  std::size_t backlog = 0;
  api::Seq seq = 0;
  Clock::time_point now = Clock::time_point{} + std::chrono::hours(1);
  SimulatedSink sink;
  Session session;
};

/// A command result's payload. CommandResult is built by index (its union
/// repeats payload types), so read it by visiting for the first T.
template <class T>
T result_as(const api::Response& r) {
  const auto& cr = std::get<api::CommandResult>(r.outcome.v);
  return std::visit(
      [](const auto& x) -> T {
        if constexpr (std::is_same_v<std::decay_t<decltype(x)>, T>) {
          return x;
        } else {
          return T{};
        }
      },
      cr.v);
}

inline api::ItemId result_item(const api::Response& r) { return result_as<api::ItemRef>(r).item; }
inline api::LayerId result_layer(const api::Response& r) { return result_as<api::LayerRef>(r).layer; }

inline bool is_error(const api::Response& r, api::ErrorCode code) {
  return r.outcome.kind() == api::Outcome::Kind::error && std::get<api::EngineError>(r.outcome.v).code == code;
}
inline bool is_ok(const api::Response& r) { return r.outcome.kind() != api::Outcome::Kind::error; }

}  // namespace premation::test
