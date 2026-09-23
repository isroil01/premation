#include "automation.hpp"

#include <algorithm>

namespace premation::audio {

FxParams::FxParams(const EffectSpec& fx, std::span<const ParamDef> defs) {
  for (const auto& d : defs) {
    keys_.emplace_back(d.key);
    statics_.push_back(d.defaultValue);
    curves_.push_back(nullptr);
  }
  auto find_or_add = [this](const std::string& key) -> std::size_t {
    for (std::size_t i = 0; i < keys_.size(); ++i) {
      if (keys_[i] == key) return i;
    }
    keys_.push_back(key);
    statics_.push_back(0);
    curves_.push_back(nullptr);
    return keys_.size() - 1;
  };
  for (const auto& [k, v] : fx.params) {
    if (std::isfinite(v)) statics_[find_or_add(k)] = v;
  }
  for (const auto& [k, c] : fx.curves) {
    const std::size_t i = find_or_add(k);
    if (c.animated()) curves_[i] = &c;
  }
}

std::size_t FxParams::idx(std::string_view key) const noexcept {
  for (std::size_t i = 0; i < keys_.size(); ++i) {
    if (keys_[i] == key) return i;
  }
  return keys_.size();  // unknown: callers only ask for keys they defined
}

Bound::Bound(const FxParams* params, std::initializer_list<std::size_t> keys, Derive derive)
    : params_(params), derive_(std::move(derive)) {
  for (const std::size_t k : keys) {
    if (nKeys_ < keys_.size()) keys_[nKeys_++] = k;
  }
  std::array<double, kMaxFxParams> vals{};
  for (std::size_t i = 0; i < params_->size() && i < kMaxFxParams; ++i) vals[i] = params_->statik(i);
  for (std::size_t i = 0; i < nKeys_; ++i) {
    if (keys_[i] < params_->size() && params_->animated(keys_[i])) animated_ = true;
  }
  constant_ = static_cast<float>(derive_(vals.data()));
}

Bound::Bound(const ParamCurve* curve, std::function<double(double)> map) : curve_(curve), map_(std::move(map)) {
  animated_ = curve_->animated();
  constant_ = static_cast<float>(map_(curve_->static_value()));
}

float Bound::grid_value(std::int64_t g, const QuantumClock& q) noexcept {
  if (cacheG_[0] == g) return cacheV_[0];
  if (cacheG_[1] == g) return cacheV_[1];
  const double t = static_cast<double>(g) * static_cast<double>(q.controlPeriod) / q.sampleRate;
  float v = 0;
  if (curve_ != nullptr) {
    v = static_cast<float>(map_(curve_->at(t)));
  } else {
    std::array<double, kMaxFxParams> vals{};
    const std::size_t n = std::min(params_->size(), kMaxFxParams);
    for (std::size_t i = 0; i < n; ++i) vals[i] = params_->statik(i);
    for (std::size_t i = 0; i < nKeys_; ++i) {
      const std::size_t k = keys_[i];
      if (k < n && params_->animated(k)) vals[k] = params_->at(k, t);
    }
    v = static_cast<float>(derive_(vals.data()));
  }
  // Keep the newer entry; evict the older (grid indices only move forward
  // within a run, and a seek resets through a fresh lookup anyway).
  const std::size_t slot = cacheG_[0] < cacheG_[1] ? 0 : 1;
  cacheG_[slot] = g;
  cacheV_[slot] = v;
  return v;
}

bool Bound::fill(const QuantumClock& q, float* out, std::size_t n) noexcept {
  if (!animated_) {
    out[0] = constant_;
    return true;
  }
  const std::int64_t p = q.controlPeriod;
  const auto pd = static_cast<double>(p);
  bool constant = true;
  for (std::size_t i = 0; i < n; ++i) {
    const std::int64_t frame = q.frame0 + static_cast<std::int64_t>(i);
    const std::int64_t g = frame >= 0 ? frame / p : -((-frame + p - 1) / p);
    const std::int64_t off = frame - g * p;
    const float v0 = grid_value(g, q);
    float v = v0;
    if (off != 0) {
      const float v1 = grid_value(g + 1, q);
      v = static_cast<float>(static_cast<double>(v0) +
                             (static_cast<double>(v1) - static_cast<double>(v0)) * (static_cast<double>(off) / pd));
    }
    out[i] = v;
    if (v != out[0]) constant = false;
  }
  return constant;
}

float Bound::at_start(const QuantumClock& q) noexcept {
  float v = 0;
  fill(q, &v, 1);
  return v;
}

}  // namespace premation::audio
