// Round trip of every engine API message type, and the codec's failure modes.
//
// fixtures.inc holds one canonical encoding per sample value of every struct
// and union in the schema, produced by the TypeScript generator's reflective
// encoder (and asserted byte-identical to the generated TS codec by
// packages/engine-api/src/roundtrip.test.ts). Here each must decode with the
// generated C++ codec and re-encode to the IDENTICAL bytes. Together the two
// tests prove the TS and C++ codecs agree on every message type.
//
// No test framework dependency: this project builds with no vcpkg packages.

#include <cstdint>
#include <cstdio>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"

namespace {

struct Fixture {
  std::string_view type;
  std::string_view label;
  std::vector<std::uint8_t> bytes;
};

#define PREMATION_FIXTURE(type, label, ...) Fixture{type, label, std::vector<std::uint8_t>{__VA_ARGS__}},

const std::vector<Fixture>& fixtures() {
  static const std::vector<Fixture> all = {
#include "fixtures.inc"
  };
  return all;
}

#undef PREMATION_FIXTURE

int g_failures = 0;
int g_checks = 0;

void check(bool ok, std::string_view what) {
  ++g_checks;
  if (!ok) {
    ++g_failures;
    std::fprintf(stderr, "FAIL: %.*s\n", static_cast<int>(what.size()), what.data());
  }
}

std::vector<std::uint8_t> from_hex(std::string_view hex) {
  std::vector<std::uint8_t> out;
  auto nib = [](char c) -> std::uint8_t {
    if (c >= '0' && c <= '9') return static_cast<std::uint8_t>(c - '0');
    return static_cast<std::uint8_t>(c - 'a' + 10);
  };
  for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
    out.push_back(static_cast<std::uint8_t>((nib(hex[i]) << 4U) | nib(hex[i + 1])));
  }
  return out;
}

using namespace premation;
using namespace premation::api;

template <class M>
wire::Status decode_bytes(std::span<const std::uint8_t> b, M& out) {
  wire::Reader r(b);
  return decode(r, out);
}

template <class M>
std::vector<std::uint8_t> encode_msg(const M& m) {
  wire::Writer w;
  encode(w, m);
  return w.take();
}

void test_every_fixture() {
  const auto& all = fixtures();
  check(all.size() > 1000, "fixture table is populated");
  std::size_t types_seen = 0;
  std::string_view last;
  for (const auto& f : all) {
    if (f.type != last) {
      ++types_seen;
      last = f.type;
    }
    std::vector<std::uint8_t> out;
    const wire::Status st = roundtrip_by_name(f.type, f.bytes, out);
    std::string what = std::string(f.label) + " decodes (" + std::string(wire::to_string(st)) + ")";
    check(st == wire::Status::ok, what);
    check(out == f.bytes, std::string(f.label) + " re-encodes to identical bytes");
  }
  check(types_seen == message_type_names().size(), "every message type has fixtures");
  std::printf("  %zu fixtures over %zu message types\n", all.size(), types_seen);
}

// The same value the TypeScript encoder turns into this hex (pinned in the doc, §9.4).
constexpr std::string_view kSetPropertyHex =
    "82193b0a1d0a076c617965722d3112127472616e73666f726d2f706f736974696f6e12142a12090000000000048e40110000000000e280401880e8f4a005";
constexpr std::string_view kRequestHex =
    "1a46080712400a3e82193b0a1d0a076c617965722d3112127472616e73666f726d2f706f736974696f6e12142a12090000000000048e40110000000000e280401880e8f4a0052000";

Command make_set_property() {
  SetProperty sp;
  sp.prop.layer = "layer-1";
  sp.prop.path = "transform/position";
  sp.value.v.emplace<4>(Vec2{960.5, 540.25});  // Value::Kind::vec2 is the 5th alternative
  sp.time = 705'600'000;                        // one second in flicks
  Command c;
  c.v = sp;  // unique alternative type → assignment picks it
  return c;
}

void test_hand_built_matches_typescript() {
  const Command c = make_set_property();
  check(c.kind() == Command::Kind::set_property, "Command::kind() reports setProperty");
  check(encode_msg(c) == from_hex(kSetPropertyHex), "C++-built setProperty encodes to the TypeScript bytes");

  Request req;
  req.seq = 7;
  req.origin = Origin::ui;
  req.body.v.emplace<0>(c);
  EngineMessage msg;
  msg.v.emplace<2>(req);
  check(encode_msg(msg) == from_hex(kRequestHex), "C++-built request envelope encodes to the TypeScript bytes");

  EngineMessage back;
  check(decode_bytes(from_hex(kRequestHex), back) == wire::Status::ok, "request envelope decodes");
  check(back == msg, "decoded envelope equals the original");
  const auto& decoded = std::get<SetProperty>(std::get<Command>(std::get<Request>(back.v).body.v).v);
  check(decoded.value.kind() == Value::Kind::vec2, "value kind survives");
  check(std::get<Vec2>(decoded.value.v).x == 960.5, "value survives exactly");
  check(decoded.time.has_value() && *decoded.time == 705'600'000, "optional time survives");
}

void test_unknown_fields_are_skipped() {
  auto bytes = encode_msg(make_set_property());
  // Append to the inner SetProperty? Simpler: a standalone SetProperty + unknown fields 99..102.
  SetProperty sp = std::get<SetProperty>(make_set_property().v);
  wire::Writer w;
  encode(w, sp);
  w.varint(99U * 8U + 0U);
  w.varint(123456789U);
  w.varint(100U * 8U + 2U);
  w.str("future");
  w.varint(101U * 8U + 1U);
  w.f64(1.5);
  w.varint(102U * 8U + 5U);
  w.f32(2.5F);
  SetProperty back;
  check(decode_bytes(w.bytes(), back) == wire::Status::ok, "unknown fields decode ok");
  check(back == sp, "unknown fields are skipped, known ones kept");
  (void)bytes;
}

void test_failures_change_nothing_and_report() {
  const auto good = from_hex(kRequestHex);
  for (std::size_t n = 0; n < good.size(); ++n) {
    EngineMessage m;
    const auto st = decode_bytes(std::span<const std::uint8_t>(good.data(), n), m);
    if (st == wire::Status::ok) {
      check(false, "truncated input at " + std::to_string(n) + " must not decode");
    }
  }
  check(true, "every truncation rejected");

  // Unknown command id → unknown_variant (a newer client).
  {
    wire::Writer w;
    w.varint(60000U * 8U + 2U);
    w.varint(0U);
    Command c;
    check(decode_bytes(w.bytes(), c) == wire::Status::unknown_variant, "unknown command → unknown_variant");
  }
  // Two variants in one union.
  {
    wire::Writer w;
    w.varint(4U * 8U + 1U);  // Value.scalar
    w.f64(1.0);
    w.varint(4U * 8U + 1U);
    w.f64(2.0);
    Value v;
    check(decode_bytes(w.bytes(), v) == wire::Status::multiple_variants, "two variants → multiple_variants");
  }
  // Missing required field: PropRef with only `layer`.
  {
    wire::Writer w;
    w.varint(1U * 8U + 2U);
    w.str("layer-1");
    PropRef p;
    check(decode_bytes(w.bytes(), p) == wire::Status::missing_field, "missing path → missing_field");
  }
  // Unknown enum number.
  {
    wire::Writer w;
    w.varint(2U * 8U + 0U);  // SetBlendMode.mode
    w.varint(999U);
    SetBlendMode sb;
    check(decode_bytes(w.bytes(), sb) == wire::Status::bad_enum, "enum 999 → bad_enum");
  }
  // bool > 1.
  {
    wire::Writer w;
    w.varint(2U * 8U + 0U);  // Value.bool
    w.varint(7U);
    Value v;
    check(decode_bytes(w.bytes(), v) != wire::Status::ok, "bool 7 rejected");
  }
}

void test_large_bodies() {
  // Length prefixes wider than one byte, nested.
  SetProperty sp;
  sp.prop.layer = "L";
  sp.prop.path = "text/sourceText";
  sp.value.v.emplace<8>(std::string(20000, 'x'));  // Value::Kind::string
  const auto bytes = encode_msg(sp);
  SetProperty back;
  check(decode_bytes(bytes, back) == wire::Status::ok && back == sp, "20 KB string round-trips");

  F64List list;
  for (int i = 0; i < 5000; ++i) list.values.push_back(i * 0.5);
  Value v;
  v.v.emplace<15>(list);  // Value::Kind::scalars
  Value vb;
  check(decode_bytes(encode_msg(v), vb) == wire::Status::ok && vb == v, "5000-element packed list round-trips");
}

}  // namespace

int main() {
  std::printf("protocol v%u.%u\n", kProtocolMajor, kProtocolMinor);
  test_every_fixture();
  test_hand_built_matches_typescript();
  test_unknown_fields_are_skipped();
  test_failures_change_nothing_and_report();
  test_large_bodies();
  std::printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
