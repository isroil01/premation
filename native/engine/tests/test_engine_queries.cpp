// The queries the document core answers through the engine's audio and render
// systems (queries.hpp QCtx hooks): getWaveform (MediaClock::peaks), hitTest
// (FrameBuilder::hit_test), getThumbnail (FrameBuilder::build_still + the
// render thread) and readPixels (the render thread) — the validation, the
// resolution of what to ask for, and how each hook answer becomes the
// response. The hooks' real halves (engine_frames.cpp, render_thread.cpp,
// scene/frame_hit.cpp) are exercised by the full engine; here they are fakes.
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "session_harness.hpp"

// engine_tests links no scene library: the frame a fake builder hands the
// (simulated) render thread is an opaque tag, never looked into.
namespace premation {
struct BuiltFrame {};
}  // namespace premation

namespace premation::test {
namespace {

constexpr api::Time kSec = 705'600'000;

class PeaksClock final : public MediaClock {
 public:
  void play(double, double, Loop, double, double) override {}
  void pause() override {}
  void seek(double, bool) override {}
  [[nodiscard]] std::optional<double> media_elapsed(std::chrono::steady_clock::time_point) const override {
    return std::nullopt;
  }
  void set_document(const doc::Document&, const doc::EditorView&, const doc::ExprEnv&, doc::ExprCache&,
                    std::string_view) override {}
  HookAnswer peaks(std::string_view src, double fromSec, double durationSec, std::uint32_t buckets,
                   api::WaveformPeaks& out) override {
    asked.push_back({std::string(src), fromSec, durationSec, buckets});
    if (answer == HookAnswer::ready) {
      out.channels = 2;
      out.buckets = buckets;
      out.peaks.assign(static_cast<std::size_t>(buckets) * 4, 0.5F);
      out.rms.assign(buckets, 0.25F);
    }
    return answer;
  }
  struct Ask {
    std::string src;
    double from, duration;
    std::uint32_t buckets;
  };
  std::vector<Ask> asked;
  HookAnswer answer = HookAnswer::ready;
};

class StillBuilder final : public FrameBuilder {
 public:
  std::shared_ptr<BuiltFrame> build(const doc::Document&, const doc::EditorView&, const doc::ExprEnv&, doc::ExprCache&,
                                    std::string_view, api::Time, const ViewportConfig&, bool,
                                    std::vector<api::LayerError>&) override {
    return nullptr;
  }
  std::shared_ptr<BuiltFrame> build_still(const doc::Document&, const doc::EditorView&, const doc::ExprEnv&,
                                          doc::ExprCache&, std::string_view comp, api::Time time, std::uint32_t width,
                                          std::uint32_t height, std::string_view isolate) override {
    stills.push_back({std::string(comp), std::string(isolate), time, width, height, {}});
    return std::make_shared<BuiltFrame>();
  }
  std::shared_ptr<BuiltFrame> build_footage_still(const doc::Document&, std::string_view src, bool video,
                                                  double sourceSec, double, double, std::uint32_t width,
                                                  std::uint32_t height) override {
    stills.push_back({"", "", 0, width, height, std::string(src)});
    footageVideo = video;
    footageSec = sourceSec;
    return std::make_shared<BuiltFrame>();
  }
  bool hit_test(const doc::Document&, const doc::EditorView&, const doc::ExprEnv&, doc::ExprCache&,
                std::string_view comp, api::Time, api::Vec2 point, std::vector<std::string>& out) override {
    hitComp = std::string(comp);
    hitPoint = point;
    out = hits;
    return true;
  }
  struct Still {
    std::string comp, isolate;
    api::Time time;
    std::uint32_t width, height;
    std::string src;
  };
  std::vector<Still> stills;
  bool footageVideo = false;
  double footageSec = 0;
  std::vector<std::string> hits;
  std::string hitComp;
  api::Vec2 hitPoint;
};

template <class T>
T answer_of(const api::Response& r) {
  REQUIRE(r.outcome.kind() == api::Outcome::Kind::query);
  // result_as visits: a result type shared by two queries (Thumbnail) is ill-formed for std::get.
  return result_as<T>(std::get<api::QueryResult>(r.outcome.v));
}

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Q";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_layer(Harness& h, const api::ItemId& comp, api::LayerKind kind, std::optional<api::ItemId> source = {}) {
  api::CreateLayer l;
  l.comp = comp;
  l.kind = kind;
  l.source = std::move(source);
  const auto r = h.run(cmd(l));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

api::ItemId import(Harness& h, std::string path) {
  api::ImportFiles imp;
  imp.files = {api::ImportFile{std::move(path), false, {}, {}, false}};
  const auto r = h.run(cmd(imp));
  REQUIRE(is_ok(r));
  return result_as<api::ItemList>(r).items.at(0);
}

api::Query waveform(std::optional<api::LayerId> layer, std::optional<api::ItemId> item, std::uint32_t buckets = 100,
                    api::TimeRange range = {kSec, 2 * kSec}) {
  api::GetWaveform q;
  q.layer = std::move(layer);
  q.item = std::move(item);
  q.range = range;
  q.buckets = buckets;
  return qry(q);
}

}  // namespace

TEST_CASE("queries: getWaveform resolves the source and asks the audio engine", "[session][queries][audio]") {
  Harness h;
  PeaksClock clock;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto clip = import(h, "C:/m/clip.mp4");
  const auto pic = import(h, "C:/m/pic.png");
  const auto solid = make_layer(h, comp, api::LayerKind::solid);

  CHECK(is_error(h.ask(waveform(std::nullopt, std::nullopt)), api::ErrorCode::invalid_argument));
  CHECK(is_error(h.ask(waveform(solid, clip)), api::ErrorCode::invalid_argument));
  CHECK(is_error(h.ask(waveform(std::nullopt, clip, 0)), api::ErrorCode::out_of_range));
  CHECK(is_error(h.ask(waveform(solid, std::nullopt)), api::ErrorCode::invalid_argument));  // no sound of its own
  CHECK(is_error(h.ask(waveform(std::nullopt, comp)), api::ErrorCode::invalid_argument));
  CHECK(is_error(h.ask(waveform(std::nullopt, std::string("item_none"))), api::ErrorCode::not_found));
  CHECK(is_error(h.ask(waveform(std::nullopt, clip, 10, {-1, kSec})), api::ErrorCode::out_of_range));
  // No audio engine attached: the query says so.
  CHECK(is_error(h.ask(waveform(std::nullopt, clip)), api::ErrorCode::unsupported));
  // A still has no sound: an empty answer, the engine is not asked.
  h.session.set_media_clock(&clock);
  {
    const auto w = answer_of<api::WaveformPeaks>(h.ask(waveform(std::nullopt, pic)));
    CHECK(w.channels == 0);
    CHECK(w.peaks.empty());
    CHECK(clock.asked.empty());
  }
  // A footage item: its src, the SOURCE window in seconds, the buckets.
  {
    const auto w = answer_of<api::WaveformPeaks>(h.ask(waveform(std::nullopt, clip, 100)));
    CHECK(w.channels == 2);
    CHECK(w.buckets == 100);
    CHECK(w.peaks.size() == 400);
    CHECK(w.rms.size() == 100);
    REQUIRE(clock.asked.size() == 1);
    CHECK(clock.asked[0].src == "blob:fake/" + clip);
    CHECK(clock.asked[0].from == 1.0);
    CHECK(clock.asked[0].duration == 2.0);
    CHECK(clock.asked[0].buckets == 100);
  }
  // A footage layer sounds from its asset.
  const auto video = make_layer(h, comp, api::LayerKind::video, clip);
  REQUIRE(is_ok(h.ask(waveform(video, std::nullopt))));
  REQUIRE(clock.asked.size() == 2);
  CHECK(clock.asked[1].src == "blob:fake/" + clip);
  // Still decoding: busy (ask again); a failed read: decode.
  clock.answer = HookAnswer::pending;
  CHECK(is_error(h.ask(waveform(std::nullopt, clip)), api::ErrorCode::busy));
  clock.answer = HookAnswer::failed;
  CHECK(is_error(h.ask(waveform(std::nullopt, clip)), api::ErrorCode::decode));
  h.session.set_media_clock(nullptr);
}

TEST_CASE("queries: hitTest maps the frame's draws to the comp's layers", "[session][queries][hit]") {
  Harness h;
  StillBuilder builder;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto a = make_layer(h, comp, api::LayerKind::solid);
  const auto b = make_layer(h, comp, api::LayerKind::solid);
  const auto c = make_layer(h, comp, api::LayerKind::solid);
  api::HitTest q;
  q.comp = comp;
  q.time = kSec;
  q.point = api::Vec2{100, 50};
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::unsupported));  // no frame builder

  h.session.set_frame_builder(&builder);
  // Extra draws of one layer are that layer; a cloner's copies are the
  // cloner; what no layer of the comp owns is dropped.
  builder.hits = {c + "::fb", c, "stranger", b + "~c2::child", a};
  q.mode = api::HitMode::all;
  auto r = answer_of<api::HitResult>(h.ask(qry(q)));
  CHECK(r.layers == std::vector<std::string>{c, b, a});
  CHECK(builder.hitComp == comp);
  CHECK(builder.hitPoint.x == 100);
  q.mode = api::HitMode::topmost;
  r = answer_of<api::HitResult>(h.ask(qry(q)));
  CHECK(r.layers == std::vector<std::string>{c});

  // Locked layers are skipped unless asked for.
  api::SetLayerSwitches lock;
  lock.layers = {c};
  lock.patch.locked = true;
  REQUIRE(is_ok(h.run(cmd(lock))));
  r = answer_of<api::HitResult>(h.ask(qry(q)));
  CHECK(r.layers == std::vector<std::string>{b});
  q.include_locked = true;
  r = answer_of<api::HitResult>(h.ask(qry(q)));
  CHECK(r.layers == std::vector<std::string>{c});

  q.comp = "comp_none";
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::not_found));
  h.session.set_frame_builder(nullptr);
}

TEST_CASE("queries: getThumbnail sizes, builds and draws a still", "[session][queries][thumbnail]") {
  Harness h;
  StillBuilder builder;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto clip = import(h, "C:/m/clip.mp4");
  const auto sound = import(h, "C:/m/voice.wav");
  const auto layer = make_layer(h, comp, api::LayerKind::solid);
  api::GetThumbnail q;
  q.item = comp;
  q.time = kSec;
  q.max_size = 256;
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::unsupported));  // no scene builder

  h.session.set_frame_builder(&builder);
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::unsupported));  // no renderer (--no-gpu)
  REQUIRE(builder.stills.size() == 1);
  CHECK(builder.stills[0].width == 256);  // 1920 × 1080 → 256 × 144
  CHECK(builder.stills[0].height == 144);
  CHECK(builder.stills[0].time == kSec);
  CHECK(builder.stills[0].isolate.empty());

  h.sink.onStill = [](std::uint32_t w, std::uint32_t hgt) {
    StillImage img;
    img.answer = HookAnswer::ready;
    img.width = w;
    img.height = hgt;
    img.format = "png";
    img.data = {0x89, 'P', 'N', 'G'};
    return img;
  };
  const auto t = answer_of<api::Thumbnail>(h.ask(qry(q)));
  CHECK(t.width == 256);
  CHECK(t.height == 144);
  CHECK(t.format == "png");
  CHECK(t.data.size() == 4);

  // A layer: its comp, only it drawing.
  api::GetThumbnail ql;
  ql.layer = layer;
  ql.time = 2 * kSec;
  REQUIRE(is_ok(h.ask(qry(ql))));
  CHECK(builder.stills.back().comp == comp);
  CHECK(builder.stills.back().isolate == layer);
  CHECK(builder.stills.back().width == 256);  // maxSize 0 = 256

  // Footage: its media at SOURCE time, never enlarged (640 × 360 at 1024).
  api::GetThumbnail qf;
  qf.item = clip;
  qf.time = 3 * kSec;
  qf.max_size = 1024;
  REQUIRE(is_ok(h.ask(qry(qf))));
  CHECK(builder.stills.back().src == "blob:fake/" + clip);
  CHECK(builder.stills.back().width == 640);
  CHECK(builder.stills.back().height == 360);
  CHECK(builder.footageVideo);
  CHECK(builder.footageSec == 3.0);

  api::GetThumbnail bad;
  CHECK(is_error(h.ask(qry(bad)), api::ErrorCode::invalid_argument));
  bad.item = sound;
  CHECK(is_error(h.ask(qry(bad)), api::ErrorCode::invalid_argument));  // no picture
  bad.item = "item_none";
  CHECK(is_error(h.ask(qry(bad)), api::ErrorCode::not_found));
  bad.item = comp;
  bad.max_size = 5000;
  CHECK(is_error(h.ask(qry(bad)), api::ErrorCode::out_of_range));

  // The render thread's answers.
  h.sink.onStill = [](std::uint32_t, std::uint32_t) {
    StillImage img;
    img.answer = HookAnswer::failed;
    img.error = "device lost";
    return img;
  };
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::internal));
  h.sink.onStill = nullptr;
  h.session.set_frame_builder(nullptr);
}

TEST_CASE("queries: readPixels clamps the region to the viewport's slot", "[session][queries][pixels]") {
  Harness h(64);
  (void)h.hello();
  const auto comp = make_comp(h);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));

  api::ReadPixels q;
  q.viewport = 1;
  q.region = api::Rect{10.5, 20.25, 0, 0};
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::unsupported));  // no renderer

  std::vector<PixelRegion> asked;
  h.sink.onReadPixels = [&asked](std::uint32_t, PixelRegion r) {
    asked.push_back(r);
    WorkingPixels px;
    px.answer = HookAnswer::ready;
    px.width = r.width;
    px.height = r.height;
    px.rgba.assign(std::size_t{r.width} * r.height * 4, 0.5F);
    return px;
  };
  // An empty region is the pixel under its corner.
  auto s = answer_of<api::PixelSamples>(h.ask(qry(q)));
  CHECK(s.width == 1);
  CHECK(s.height == 1);
  CHECK(s.rgba.size() == 4);
  REQUIRE(asked.size() == 1);
  CHECK(asked[0].x == 10);
  CHECK(asked[0].y == 20);
  // Clamped to the slot.
  q.region = api::Rect{630, 350, 40, 40};
  s = answer_of<api::PixelSamples>(h.ask(qry(q)));
  CHECK(s.width == 10);
  CHECK(s.height == 10);
  q.region = api::Rect{700, 10, 4, 4};
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::out_of_range));
  q.region = api::Rect{0, 0, 300, 300};
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::out_of_range));  // over 256² pixels
  q.region = api::Rect{0, 0, -1, 4};
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::invalid_argument));
  q.viewport = 2;
  q.region = api::Rect{0, 0, 1, 1};
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::not_found));

  h.sink.onReadPixels = [](std::uint32_t, PixelRegion) {
    WorkingPixels px;
    px.answer = HookAnswer::pending;
    return px;
  };
  q.viewport = 1;
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::busy));  // nothing shown yet
  h.sink.onReadPixels = nullptr;
}

}  // namespace premation::test
