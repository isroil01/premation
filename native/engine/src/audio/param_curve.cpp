#include "param_curve.hpp"

#include <cmath>
#include <span>
#include <utility>

#include "eval.hpp"

namespace premation::audio {

ParamCurve ParamCurve::constant(double v) noexcept {
  ParamCurve c;
  c.kind_ = Kind::constant;
  c.value_ = v;
  return c;
}

ParamCurve ParamCurve::keyframes(std::vector<motion_keyframe> keys, double fallback) {
  const motion::eval::StructSource src{std::span<const motion_keyframe>(keys)};
  if (keys.empty() || !motion::eval::validate_track(src).empty()) return constant(fallback);
  ParamCurve c;
  c.kind_ = Kind::keyframes;
  c.value_ = fallback;
  c.keys_ = std::move(keys);
  return c;
}

ParamCurve ParamCurve::table(std::vector<double> values, double startSec, double rate) {
  if (values.empty() || !(rate > 0)) return constant(0);
  if (values.size() == 1) return constant(values.front());
  ParamCurve c;
  c.kind_ = Kind::table;
  c.value_ = values.front();
  c.table_ = std::move(values);
  c.tableStart_ = startSec;
  c.tableRate_ = rate;
  return c;
}

double ParamCurve::at(double compSec) const noexcept {
  switch (kind_) {
    case Kind::constant:
      return value_;
    case Kind::keyframes: {
      if (std::isnan(compSec)) return value_;
      const double v = motion::eval::sample(motion::eval::StructSource{std::span<const motion_keyframe>(keys_)}, compSec);
      return std::isfinite(v) ? v : value_;
    }
    case Kind::table: {
      const double x = (compSec - tableStart_) * tableRate_;
      if (!(x > 0)) return table_.front();
      const auto last = static_cast<double>(table_.size() - 1);
      if (x >= last) return table_.back();
      const double i = std::floor(x);
      const auto k = static_cast<std::size_t>(i);
      const double f = x - i;
      return table_[k] + (table_[k + 1] - table_[k]) * f;
    }
  }
  return value_;
}

}  // namespace premation::audio
