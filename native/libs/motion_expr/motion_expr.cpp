// motion_expr — the C ABI (include/motion/motion_expr.h) over expr.hpp.
//
// Boundary discipline (plan §4): validate plain data, adapt the C callback
// table to the C++ Host, and let no exception out.

#include "motion/motion_expr.h"

#include <array>
#include <cstddef>
#include <exception>
#include <memory>
#include <new>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "expr.hpp"

struct motion_expr {
  motion::expr::Expression expr;
};

namespace {

namespace ex = motion::expr;

void set_error(motion_error* err, std::string_view msg) noexcept {
  if (err == nullptr) return;
  const std::span<char> buf(err->message);
  const std::size_t n = msg.size() < buf.size() - 1 ? msg.size() : buf.size() - 1;
  for (std::size_t i = 0; i < n; ++i) buf[i] = msg[i];
  buf[n] = '\0';
}

/// Copy UTF-8 into buf, truncated on a code point boundary, NUL-terminated.
void copy_utf8(std::string_view s, std::span<char> buf) noexcept {
  if (buf.empty()) return;
  std::size_t n = s.size() < buf.size() - 1 ? s.size() : buf.size() - 1;
  while (n > 0 && n < s.size() && (static_cast<unsigned char>(s[n]) & 0xC0U) == 0x80U) --n;
  for (std::size_t i = 0; i < n; ++i) buf[i] = s[i];
  buf[n] = '\0';
}

std::string_view view(const char* s, std::size_t len) { return s == nullptr ? std::string_view{} : std::string_view(s, len); }

/// The C callback table as an ex::Host.
class CHost final : public ex::Host {
 public:
  explicit CHost(const motion_expr_host* h) : h_(h) {}

  [[nodiscard]] bool has_ctrl() const override { return h_ != nullptr && h_->ctrl != nullptr; }
  double ctrl(std::u16string_view name) override {
    const std::string n = ex::utf16_to_utf8(name);
    double out = 0;
    return h_->ctrl(h_->user, n.data(), n.size(), &out) == MOTION_EXPR_HOST_OK ? out : 0;
  }

  [[nodiscard]] bool has_self_at() const override { return h_ != nullptr && h_->self_at != nullptr; }
  double self_at(double t) override {
    double out = 0;
    std::array<char, MOTION_EXPR_MESSAGE_CAP> msg{};
    if (h_->self_at(h_->user, t, &out, msg.data(), msg.size()) == MOTION_EXPR_HOST_ERROR) fail(msg);
    return out;
  }

  [[nodiscard]] bool has_layer_at() const override { return h_ != nullptr && h_->layer_at != nullptr; }
  std::optional<double> layer_at(std::u16string_view name, std::u16string_view prop, double t) override {
    const std::string n = ex::utf16_to_utf8(name);
    const std::string p = ex::utf16_to_utf8(prop);
    double out = 0;
    std::array<char, MOTION_EXPR_MESSAGE_CAP> msg{};
    const int32_t s = h_->layer_at(h_->user, n.data(), n.size(), p.data(), p.size(), t, &out, msg.data(), msg.size());
    if (s == MOTION_EXPR_HOST_ERROR) fail(msg);
    if (s == MOTION_EXPR_HOST_OK) return out;
    return std::nullopt;
  }

  [[nodiscard]] bool has_source_rect_at() const override { return h_ != nullptr && h_->source_rect_at != nullptr; }
  std::optional<ex::SourceRect> source_rect_at(double t, bool extents) override {
    std::array<double, 4> r{};
    if (h_->source_rect_at(h_->user, t, extents ? 1 : 0, r.data()) != MOTION_EXPR_HOST_OK) return std::nullopt;
    return ex::SourceRect{.top = r[0], .left = r[1], .width = r[2], .height = r[3]};
  }

  [[nodiscard]] bool has_space_at() const override { return h_ != nullptr && h_->space_at != nullptr; }
  bool space_exists(const std::u16string* name, double t) override {
    std::array<double, 3> probe{};
    return convert(name, t, MOTION_EXPR_TO_COMP, probe, probe) == MOTION_EXPR_HOST_OK;
  }
  std::array<double, 3> space_convert(const std::u16string* name, double t, ex::SpaceOp op,
                                      std::array<double, 3> p) override {
    std::array<double, 3> out{};
    int32_t cop = MOTION_EXPR_TO_COMP;
    switch (op) {
      case ex::SpaceOp::kToComp: cop = MOTION_EXPR_TO_COMP; break;
      case ex::SpaceOp::kFromComp: cop = MOTION_EXPR_FROM_COMP; break;
      case ex::SpaceOp::kToWorld: cop = MOTION_EXPR_TO_WORLD; break;
      case ex::SpaceOp::kFromWorld: cop = MOTION_EXPR_FROM_WORLD; break;
    }
    (void)convert(name, t, cop, p, out);
    return out;
  }

  [[nodiscard]] bool has_markers_at() const override { return h_ != nullptr && h_->markers_at != nullptr; }
  std::vector<ex::MarkerData> markers_at(ex::MarkerScope scope) override {
    std::vector<ex::MarkerData> out;
    const motion_expr_marker_sink sink{
        .opaque = &out,
        .add = [](void* o, double time, double duration, const char* name, size_t name_len, const char* comment,
                  size_t comment_len) {
          try {
            static_cast<std::vector<ex::MarkerData>*>(o)->push_back({.time = time,
                                                                     .duration = duration,
                                                                     .name = ex::utf8_to_utf16(view(name, name_len)),
                                                                     .comment = ex::utf8_to_utf16(view(comment, comment_len))});
          } catch (...) {  // NOLINT(bugprone-empty-catch) — cannot unwind through C; a lost marker beats a crash
          }
        }};
    h_->markers_at(h_->user, scope == ex::MarkerScope::kComp ? MOTION_EXPR_MARKERS_COMP : MOTION_EXPR_MARKERS_LAYER,
                   &sink);
    return out;
  }

 private:
  int32_t convert(const std::u16string* name, double t, int32_t op, const std::array<double, 3>& in,
                  std::array<double, 3>& out) {
    std::string n;
    if (name != nullptr) n = ex::utf16_to_utf8(*name);
    return h_->space_at(h_->user, name != nullptr ? n.data() : nullptr, n.size(), t, op, in.data(), out.data());
  }
  [[noreturn]] static void fail(const std::array<char, MOTION_EXPR_MESSAGE_CAP>& msg) {
    std::size_t n = 0;
    while (n < msg.size() && msg.at(n) != '\0') ++n;
    throw ex::HostError{ex::utf8_to_utf16(std::string_view(msg.data(), n))};
  }
  const motion_expr_host* h_;
};

void write_result(const ex::Result& r, motion_expr_result* out) {
  out->size = 0;
  out->message[0] = '\0';
  if (r.error) {
    out->kind = MOTION_EXPR_RESULT_ERROR;
    copy_utf8(ex::utf16_to_utf8(*r.error), out->message);
    return;
  }
  switch (r.kind) {
    case ex::Result::Kind::kNull:
      out->kind = MOTION_EXPR_RESULT_NULL;
      return;
    case ex::Result::Kind::kNumber:
      out->kind = MOTION_EXPR_RESULT_NUMBER;
      out->size = 1;
      out->value[0] = r.number;
      return;
    case ex::Result::Kind::kVector:
      out->kind = MOTION_EXPR_RESULT_VECTOR;
      out->size = static_cast<uint32_t>(r.size);
      for (std::size_t i = 0; i < r.size; ++i) std::span<double>(out->value)[i] = r.vec.at(i);
      return;
  }
}

}  // namespace

extern "C" {

motion_status motion_expr_compile(const char* src, size_t len, motion_expr** out, motion_error* err) {
  if (out == nullptr || (src == nullptr && len > 0)) {
    set_error(err, "motion_expr_compile: NULL argument");
    return MOTION_INVALID_ARG;
  }
  *out = nullptr;
  try {
    auto handle = std::make_unique<motion_expr>(
        motion_expr{ex::Expression::compile(ex::utf8_to_utf16(view(src, len)))});
    *out = handle.release();  // ownership passes to the caller; motion_expr_free takes it back
    return MOTION_OK;
  } catch (const std::bad_alloc&) {
    set_error(err, "motion_expr_compile: out of memory");
  } catch (...) {
    set_error(err, "internal: unexpected exception in motion_expr_compile");
  }
  return MOTION_INTERNAL;
}

int32_t motion_expr_compile_error(const motion_expr* expr, char* buf, size_t cap) {
  if (expr == nullptr || !expr->expr.compile_error()) return 0;
  try {
    if (buf != nullptr && cap > 0) copy_utf8(ex::utf16_to_utf8(*expr->expr.compile_error()), std::span<char>(buf, cap));
  } catch (...) {
    if (buf != nullptr && cap > 0) std::span<char>(buf, cap)[0] = '\0';
  }
  return 1;
}

void motion_expr_free(motion_expr* expr) {
  const std::unique_ptr<motion_expr> owned(expr);  // takes back what motion_expr_compile released
}

motion_status motion_expr_eval(const motion_expr* expr, const motion_expr_context* c, motion_expr_result* out,
                               motion_error* err) {
  if (expr == nullptr || c == nullptr || out == nullptr || (c->key_times == nullptr && c->key_count > 0)) {
    set_error(err, "motion_expr_eval: NULL argument");
    return MOTION_INVALID_ARG;
  }
  try {
    CHost host(c->host);
    ex::Context ctx;
    ctx.time = c->time;
    ctx.value = c->value;
    if ((c->flags & MOTION_EXPR_HAS_AUDIO) != 0U) ctx.audio = c->audio;
    if ((c->flags & MOTION_EXPR_HAS_SELF_SPAN) != 0U) ctx.self_span = ex::KeySpan{.start = c->span_start, .end = c->span_end};
    if ((c->flags & MOTION_EXPR_HAS_COMP) != 0U) {
      ctx.comp = ex::CompInfo{.width = c->comp_width,
                              .height = c->comp_height,
                              .duration = c->comp_duration,
                              .fps = c->comp_fps,
                              .num_layers = c->comp_num_layers};
    }
    if ((c->flags & MOTION_EXPR_HAS_LAYER_INFO) != 0U) {
      ctx.layer_info = ex::LayerInfo{.name = ex::utf8_to_utf16(view(c->layer_name, c->layer_name_len)),
                                     .width = c->layer_width,
                                     .height = c->layer_height};
    }
    if ((c->flags & MOTION_EXPR_HAS_PROP_SEED) != 0U) ctx.prop_seed = c->prop_seed;
    if (c->key_count > 0) ctx.key_times = std::span<const double>(c->key_times, c->key_count);
    ctx.host = &host;
    write_result(expr->expr.run(ctx), out);
    return MOTION_OK;
  } catch (const std::bad_alloc&) {
    set_error(err, "motion_expr_eval: out of memory");
  } catch (...) {
    set_error(err, "internal: unexpected exception in motion_expr_eval");
  }
  out->kind = MOTION_EXPR_RESULT_ERROR;
  out->size = 0;
  copy_utf8("internal error", out->message);
  return MOTION_INTERNAL;
}

double motion_expr_string_seed(const char* s, size_t len) {
  try {
    return ex::string_seed(ex::utf8_to_utf16(view(s, len)));
  } catch (...) {
    return 0;
  }
}

}  // extern "C"
