// Footage jobs follow a layer's Time Remap and Speed % (retime.ts
// retimedSourceSeconds) from keys copied at prepare. Stretch is unchanged.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "job_inputs.hpp"

using premation::jobs::FootageLayer;
using premation::jobs::flicks_of;

namespace {

FootageLayer layer() {
  FootageLayer f;
  f.compFps = 30;
  f.timing.stretch = 1;
  f.timing.start_time = 0;
  f.timing.in_point = 0;
  f.timing.out_point = flicks_of(4);
  return f;
}

void clip(FootageLayer& f, double offsetSec) {
  FootageLayer::RetimeClipMap c;
  c.startFrame = 0;
  c.endFrame = 120;
  c.offsetSec = offsetSec;
  c.inSec = 0;
  f.retimeClips = {c};
}

}  // namespace

TEST_CASE("stretch maps source and composition time", "[retime]") {
  FootageLayer f = layer();
  f.timing.stretch = 2;
  CHECK(f.source_seconds(4) == Catch::Approx(2));
  CHECK(f.comp_seconds(2) == Catch::Approx(4));
}

TEST_CASE("a held time remap is that source second plus the clip offset", "[retime]") {
  FootageLayer f = layer();
  f.retimeKind = FootageLayer::RetimeKind::frames;
  premation::doc::Key k;
  k.t = 0;
  k.value = 2;
  k.easing = premation::api::Easing::hold;
  f.retimeKeys = {k};
  clip(f, 0.25);
  CHECK(f.source_seconds(1) == Catch::Approx(2.25));
}

TEST_CASE("a constant 50 percent speed plays half the source", "[retime]") {
  FootageLayer f = layer();
  f.retimeKind = FootageLayer::RetimeKind::speed;
  premation::doc::Key k;
  k.t = 0;
  k.value = 50;
  k.easing = premation::api::Easing::hold;
  f.retimeKeys = {k};
  clip(f, 0);
  CHECK(f.source_seconds(2) == Catch::Approx(1));
  CHECK(f.comp_seconds(1) == Catch::Approx(2));
}

TEST_CASE("a linear speed ramp integrates the percent", "[retime]") {
  FootageLayer f = layer();
  f.retimeKind = FootageLayer::RetimeKind::speed;
  premation::doc::Key a;
  a.t = 0;
  a.value = 0;
  a.easing = premation::api::Easing::linear;
  premation::doc::Key b;
  b.t = 2;
  b.value = 200;
  b.easing = premation::api::Easing::linear;
  f.retimeKeys = {a, b};
  clip(f, 0);
  CHECK(f.source_seconds(1) == Catch::Approx(0.5));
  CHECK(f.source_seconds(2) == Catch::Approx(2));
}
