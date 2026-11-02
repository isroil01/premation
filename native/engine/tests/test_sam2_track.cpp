// SAM 2.1 video tracking (AE parity 3.1, src/jobs/sam2_track.hpp): the memory
// bank's layout against SAM 2's rules on a fake model, and — when the model
// is installed (PREMATION_SAM2_TEST_DIR = the folder of the five graphs +
// constants.json) — a real walk over a synthetic moving disc. Optional
// timing on real footage: PREMATION_SAM2_BENCH_RGB = "file.rgb|W|H|N|x|y"
// (raw rgb24 frames, a click in frame px) prints the per-frame milliseconds
// on the provider this machine picks (PREMATION_ORT_PROVIDER=cpu for the CPU).
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "sam2_track.hpp"
#include "sam_embed_cache.hpp"

namespace s2 = premation::jobs::sam2;

namespace {

std::string env(const char* name) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  const char* v = std::getenv(name);  // NOLINT(concurrency-mt-unsafe)
#pragma clang diagnostic pop
  return v == nullptr ? std::string() : std::string(v);
}

s2::Memory memory_filled(float v) {
  s2::Memory m;
  m.tokens.assign(s2::kTokens * s2::kMemDim, v);
  m.pos.assign(s2::kTokens * s2::kMemDim, 0.0F);
  return m;
}

s2::Constants constants_rows() {
  s2::Constants c;
  for (std::size_t r = 0; r < s2::kMaskMem; ++r)
    for (std::size_t k = 0; k < s2::kMemDim; ++k) c.tpos[r * s2::kMemDim + k] = static_cast<float>(r) * 100.0F;
  return c;
}

/// Counts calls and answers fixed shapes; remembers what the decoder was fed.
class FakeModels final : public s2::Models {
 public:
  int encodes = 0, attends = 0, decodes = 0, memories = 0;
  std::vector<std::int32_t> lastLabels;
  bool lastCondWasNoMem = false;

  [[nodiscard]] std::string provider() const override { return "fake"; }
  bool encode(std::span<const float> /*pixels*/, s2::Vision& out, std::string& /*error*/) override {
    ++encodes;
    out.feats0.assign(32 * 256 * 256, 0.0F);
    out.feats1.assign(64 * 128 * 128, 0.0F);
    out.feats2.assign(256 * s2::kTokens, 1.0F);
    out.feats2NoMem.assign(256 * s2::kTokens, 2.0F);
    out.pos.assign(256 * s2::kTokens, 0.0F);
    return true;
  }
  bool decode(const s2::Vision& /*v*/, std::span<const float> featsCond, std::span<const float> /*points*/,
              std::span<const std::int32_t> labels, s2::Decoded& out, std::string& /*error*/) override {
    ++decodes;
    lastLabels.assign(labels.begin(), labels.end());
    lastCondWasNoMem = !featsCond.empty() && featsCond[0] == 2.0F;
    out.highRes.assign(s2::kHighRes, -10.0F);
    for (int y = 400; y < 600; ++y)
      for (int x = 400; x < 600; ++x) out.highRes[static_cast<std::size_t>(y) * s2::kInput + static_cast<std::size_t>(x)] = 10.0F;
    out.pointer.assign(s2::kHidden, 0.5F);
    out.objectScore = 5;
    out.iou = 0.9F;
    return true;
  }
  bool encode_memory(std::span<const float> /*feats2*/, std::span<const float> /*highRes*/, float /*objectScore*/, bool /*binarize*/,
                     s2::Memory& out, std::string& /*error*/) override {
    ++memories;
    out = memory_filled(static_cast<float>(memories));
    return true;
  }
  bool attend(std::span<const float> features, std::span<const float> /*pos*/, std::span<const float> memory, std::span<const float> /*memoryPos*/,
              std::vector<float>& conditioned, std::string& /*error*/) override {
    ++attends;
    REQUIRE(features.size() == s2::kTokens * s2::kHidden);
    REQUIRE(memory.size() == s2::kMemoryTokens * s2::kMemDim);
    conditioned.assign(256 * s2::kTokens, 3.0F);
    return true;
  }
  bool pointer_pos(std::span<const float> diffs, std::vector<float>& out, std::string& /*error*/) override {
    out.assign(diffs.size() * s2::kMemDim, 0.25F);
    return true;
  }
};

}  // namespace

TEST_CASE("SAM 2: tokens are SAM 2's flatten(2).permute(2,0,1)", "[sam2]") {
  std::vector<float> nchw(2 * s2::kTokens);
  for (std::size_t i = 0; i < nchw.size(); ++i) nchw[i] = static_cast<float>(i);
  std::vector<float> tok;
  s2::to_tokens(nchw, 2, tok);
  REQUIRE(tok.size() == nchw.size());
  CHECK(tok[0] == 0.0F);                                    // token 0, channel 0
  CHECK(tok[1] == static_cast<float>(s2::kTokens));         // token 0, channel 1
  CHECK(tok[2] == 1.0F);                                    // token 1, channel 0
}

TEST_CASE("SAM 2: constants.json must be the 7x64 table", "[sam2]") {
  std::string error;
  CHECK_FALSE(s2::parse_constants("{\"memory_temporal_positional_encoding\": [[1,2]]}", error).has_value());
  std::ostringstream j;
  j << "{\"num_maskmem\":7,\"image_mean\":[0.5,0.5,0.5],\"memory_temporal_positional_encoding\":[";
  for (int r = 0; r < 7; ++r) {
    j << (r ? "," : "") << '[';
    for (int k = 0; k < 64; ++k) j << (k ? "," : "") << r;
    j << ']';
  }
  j << "]}";
  const std::optional<s2::Constants> c = s2::parse_constants(j.str(), error);
  REQUIRE(c.has_value());
  CHECK(c->tpos[6 * 64 + 3] == 6.0F);
  CHECK(c->mean[0] == 0.5F);
}

TEST_CASE("SAM 2: the bank puts the conditioning frame first, recent memories newest first, then pads", "[sam2]") {
  const s2::Constants c = constants_rows();
  s2::MemoryBank bank(100);
  bank.add(0, memory_filled(10), std::vector<float>(s2::kHidden, 0.0F), true);
  bank.add(1, memory_filled(11), std::vector<float>(s2::kHidden, 1.0F), false);
  bank.add(2, memory_filled(12), std::vector<float>(s2::kHidden, 2.0F), false);
  bank.add(3, memory_filled(13), std::vector<float>(s2::kHidden, 3.0F), false);
  s2::Assembled a;
  REQUIRE(bank.assemble(4, c, a));
  CHECK(a.blockFrame == std::array<std::int64_t, 7>{0, 3, 2, 1, 1, 1, 1});
  CHECK(a.blockRow == std::array<int, 7>{6, 0, 1, 2, 2, 2, 2});
  const std::size_t block = s2::kTokens * s2::kMemDim;
  CHECK(a.memory[0] == 10.0F);
  CHECK(a.memory[block] == 13.0F);
  CHECK(a.memoryPos[0] == 600.0F);       // the conditioning row
  CHECK(a.memoryPos[block] == 0.0F);     // one frame back: row 0
  CHECK(a.memoryPos[2 * block] == 100.0F);
  // Pointers: the conditioning one, then 3, 2, 1, then repeats; offsets over min(100, 16) - 1.
  CHECK(a.pointerFrame[0] == 0);
  CHECK(a.pointerFrame[1] == 3);
  CHECK(a.pointerFrame[3] == 1);
  CHECK(a.pointerFrame[15] == 1);
  CHECK(a.pointerDiffs[0] == static_cast<float>(4.0 / 15.0));
  CHECK(a.pointerDiffs[1] == static_cast<float>(1.0 / 15.0));
  CHECK(a.memory[7 * block] == 0.0F);                  // pointer 0's first token
  CHECK(a.memory[7 * block + s2::kHidden] == 3.0F);    // pointer 1 = frame 3's
}

TEST_CASE("SAM 2: the ring keeps six memories and a later conditioning frame joins the closest-first list", "[sam2]") {
  const s2::Constants c = constants_rows();
  s2::MemoryBank bank(8);
  bank.add(0, memory_filled(1), std::vector<float>(s2::kHidden, 0.0F), true);
  for (std::int64_t f = 1; f <= 9; ++f) bank.add(f, memory_filled(static_cast<float>(f)), std::vector<float>(s2::kHidden, 0.0F), f == 8);
  s2::Assembled a;
  REQUIRE(bank.assemble(10, c, a));
  // Conditioning 8 (closer) and 0, then recent 9, 7, 6, 5, 4.
  CHECK(a.blockFrame == std::array<std::int64_t, 7>{8, 0, 9, 7, 6, 5, 4});
  CHECK(a.blockRow == std::array<int, 7>{6, 6, 0, 2, 3, 4, 5});
  CHECK(a.pointerDiffs[0] == static_cast<float>(2.0 / 7.0));  // min(8, 16) - 1 = 7
}

TEST_CASE("SAM 2: the tracker seeds from feats2_no_mem, then tracks through memory with the padding point", "[sam2]") {
  FakeModels m;
  s2::Tracker t(m, constants_rows(), 4);
  std::vector<std::uint8_t> rgba(64 * 36 * 4, 100);
  std::string error;
  s2::FrameResult r;
  CHECK_FALSE(t.step(rgba, 64, 36, {}, r, error));  // the first frame needs a prompt
  const std::vector<s2::Prompt> click{{32, 18, 1}};
  REQUIRE(t.step(rgba, 64, 36, click, r, error));
  CHECK(m.lastCondWasNoMem);
  CHECK(m.attends == 0);
  CHECK(r.conditioning);
  REQUIRE(r.alpha.size() == std::size_t{64} * 36);
  CHECK(r.alpha[18 * 64 + 32] > 0.99F);  // the centre square of the fake mask
  CHECK(r.alpha[0] < 0.01F);
  REQUIRE(t.step(rgba, 64, 36, {}, r, error));
  CHECK(m.attends == 1);
  CHECK_FALSE(m.lastCondWasNoMem);
  CHECK(m.lastLabels == std::vector<std::int32_t>{-1});
  CHECK_FALSE(r.conditioning);
  // A correction: attends to memory AND decodes the stroke's points.
  const std::vector<s2::Prompt> fix{{10, 10, 0}};
  REQUIRE(t.step(rgba, 64, 36, fix, r, error));
  CHECK(m.attends == 2);
  CHECK(m.lastLabels == std::vector<std::int32_t>{0});
  CHECK(r.conditioning);
}

TEST_CASE("SAM 2: a second walk starts from the first one's origin without encoding it again", "[sam2]") {
  FakeModels m;
  s2::Tracker forward(m, constants_rows(), 4);
  std::vector<std::uint8_t> rgba(64 * 36 * 4, 100);
  std::string error;
  s2::FrameResult r;
  CHECK_FALSE(forward.origin().has_value());
  const std::vector<s2::Prompt> click{{32, 18, 1}};
  REQUIRE(forward.step(rgba, 64, 36, click, r, error));
  REQUIRE(forward.origin().has_value());
  CHECK(forward.origin()->alpha == r.alpha);
  CHECK(m.encodes == 1);
  s2::Tracker backward(m, constants_rows(), 4);
  REQUIRE(backward.start_from(*forward.origin()));
  CHECK(backward.steps() == 1);
  CHECK(m.encodes == 1);  // nothing encoded for the origin again
  CHECK_FALSE(backward.start_from(*forward.origin()));  // only a fresh tracker
  // Its next frame tracks through memory (the origin is a conditioning frame), no prompt needed.
  REQUIRE(backward.step(rgba, 64, 36, {}, r, error));
  CHECK(m.attends == 1);
  CHECK(m.lastLabels == std::vector<std::int32_t>{-1});
  CHECK_FALSE(r.conditioning);
}

TEST_CASE("SAM 2: the installed model follows a moving disc", "[sam2][ort]") {
  const std::string dir = env("PREMATION_SAM2_TEST_DIR");
  if (dir.empty() || !s2::installed(dir)) SKIP("no SAM 2 model (set PREMATION_SAM2_TEST_DIR to the sam2.1-tiny-video-onnx folder)");
  std::string error;
  const std::optional<s2::Constants> c = s2::load_constants(dir, error);
  REQUIRE(c.has_value());
  auto models = s2::load(dir, error);
  INFO(error);
  REQUIRE(models != nullptr);
  WARN("SAM 2 provider: " << models->provider());
  constexpr std::uint32_t W = 320, H = 240;
  constexpr int frames = 6;
  s2::Tracker t(*models, *c, frames);
  for (int f = 0; f < frames; ++f) {
    const double cx = 90 + f * 25.0, cy = 120, rad = 45;
    std::vector<std::uint8_t> rgba(std::size_t{W} * H * 4);
    std::size_t truth = 0;
    std::vector<bool> inside(std::size_t{W} * H);
    for (std::uint32_t y = 0; y < H; ++y)
      for (std::uint32_t x = 0; x < W; ++x) {
        const std::size_t i = std::size_t{y} * W + x;
        const bool in = std::hypot(x - cx, y - cy) < rad;
        inside[i] = in;
        truth += in ? 1 : 0;
        // A textured blue-grey ground, an orange disc.
        const auto n = static_cast<std::uint8_t>(((x * 7 + y * 13) % 31) * 2);
        rgba[i * 4 + 0] = in ? 235 : static_cast<std::uint8_t>(40 + n);
        rgba[i * 4 + 1] = in ? 140 : static_cast<std::uint8_t>(60 + n);
        rgba[i * 4 + 2] = in ? 30 : static_cast<std::uint8_t>(90 + n);
        rgba[i * 4 + 3] = 255;
      }
    std::vector<s2::Prompt> prompts;
    if (f == 0) prompts.push_back({cx, cy, 1});
    s2::FrameResult r;
    REQUIRE(t.step(rgba, W, H, prompts, r, error));
    std::size_t inter = 0, uni = 0;
    for (std::size_t i = 0; i < inside.size(); ++i) {
      const bool m = r.alpha[i] >= 0.5F;
      inter += (m && inside[i]) ? 1 : 0;
      uni += (m || inside[i]) ? 1 : 0;
    }
    const double iou = uni > 0 ? static_cast<double>(inter) / static_cast<double>(uni) : 0;
    INFO("frame " << f << " IoU " << iou << " truth " << truth);
    CHECK(iou > 0.8);
  }
}

TEST_CASE("SAM 2: per-frame time on footage", "[sam2][ort][bench]") {
  const std::string dir = env("PREMATION_SAM2_TEST_DIR");
  const std::string spec = env("PREMATION_SAM2_BENCH_RGB");
  if (dir.empty() || spec.empty() || !s2::installed(dir)) SKIP("set PREMATION_SAM2_TEST_DIR and PREMATION_SAM2_BENCH_RGB=file|W|H|N|x|y");
  std::vector<std::string> parts;
  std::stringstream ss(spec);
  for (std::string p; std::getline(ss, p, '|');) parts.push_back(p);
  REQUIRE(parts.size() == 6);
  const auto W = static_cast<std::uint32_t>(std::stoul(parts[1]));
  const auto H = static_cast<std::uint32_t>(std::stoul(parts[2]));
  const int N = std::stoi(parts[3]);
  const double cx = std::stod(parts[4]), cy = std::stod(parts[5]);
  std::string error;
  const std::optional<s2::Constants> c = s2::load_constants(dir, error);
  REQUIRE(c.has_value());
  const auto t0 = std::chrono::steady_clock::now();
  auto models = s2::load(dir, error);
  REQUIRE(models != nullptr);
  const double loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::ifstream in(parts[0], std::ios::binary);
  REQUIRE(in);
  s2::Tracker t(*models, *c, static_cast<std::size_t>(N));
  std::vector<std::uint8_t> rgb(std::size_t{W} * H * 3), rgba(std::size_t{W} * H * 4, 255);
  double sum[5] = {0, 0, 0, 0, 0};
  int counted = 0;
  double area0 = 0, areaLast = 0;
  for (int f = 0; f < N; ++f) {
    in.read(reinterpret_cast<char*>(rgb.data()), static_cast<std::streamsize>(rgb.size()));
    REQUIRE(in);
    for (std::size_t i = 0; i < std::size_t{W} * H; ++i)
      for (std::size_t k = 0; k < 3; ++k) rgba[i * 4 + k] = rgb[i * 3 + k];
    std::vector<s2::Prompt> prompts;
    if (f == 0) prompts.push_back({cx, cy, 1});
    s2::FrameResult r;
    const auto a = std::chrono::steady_clock::now();
    REQUIRE(t.step(rgba, W, H, prompts, r, error));
    const double total = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - a).count();
    double area = 0;
    for (const float v : r.alpha) area += v >= 0.5F ? 1 : 0;
    area /= static_cast<double>(r.alpha.size());
    if (f == 0) area0 = area;
    areaLast = area;
    if (f >= 2) {  // the first two warm the provider up
      sum[0] += r.encodeMs;
      sum[1] += r.attendMs;
      sum[2] += r.decodeMs;
      sum[3] += r.memoryMs;
      sum[4] += total;
      ++counted;
    }
  }
  REQUIRE(counted > 0);
  WARN("SAM 2 bench (" << models->provider() << ", " << W << "x" << H << ", " << N << " frames, load " << loadMs << " ms): per frame encode "
                       << sum[0] / counted << " attend " << sum[1] / counted << " decode " << sum[2] / counted << " memory "
                       << sum[3] / counted << " total " << sum[4] / counted << " ms; matte area " << area0 << " -> " << areaLast);
  CHECK(areaLast > 0.25 * area0);
}

TEST_CASE("Object Matte: the embedding cache hits on the same frame and keeps the newest entries", "[sam][cache]") {
  namespace sam = premation::jobs::sam;
  namespace fs = std::filesystem;
  const fs::path dir = fs::temp_directory_path() / "premation-sam-cache-test";
  std::error_code ec;
  fs::remove_all(dir, ec);
  fs::create_directories(dir);
  const fs::path footage = dir / "clip.bin";
  const fs::path model = dir / "enc.onnx";
  { std::ofstream(footage, std::ios::binary) << "clip"; }
  { std::ofstream(model, std::ios::binary) << "model"; }
  const std::string k0 = sam::embedding_key(footage.string(), 0, model.string());
  const std::string k1 = sam::embedding_key(footage.string(), 1, model.string());
  REQUIRE_FALSE(k0.empty());
  CHECK(k0 != k1);
  CHECK(sam::embedding_key((dir / "missing").string(), 0, model.string()).empty());
  sam::CachedEmbedding e;
  e.width = 1920;
  e.height = 1080;
  e.image = {std::vector<float>{1, 2, 3, 4}, {1, 4}};
  e.positional = {std::vector<float>{5, 6}, {2}};
  CHECK_FALSE(sam::read_embedding(dir.string(), k0).has_value());
  REQUIRE(sam::write_embedding(dir.string(), k0, e, 2));
  const std::optional<sam::CachedEmbedding> got = sam::read_embedding(dir.string(), k0);
  REQUIRE(got.has_value());
  CHECK(got->width == 1920);
  CHECK(got->image.data == std::vector<float>{1, 2, 3, 4});
  CHECK(got->positional.shape == std::vector<std::int64_t>{2});
  CHECK_FALSE(sam::read_embedding(dir.string(), k1).has_value());
  // Bounded: a third entry with keep = 2 drops the oldest.
  REQUIRE(sam::write_embedding(dir.string(), k1, e, 2));
  REQUIRE(sam::write_embedding(dir.string(), sam::embedding_key(footage.string(), 2, model.string()), e, 2));
  std::size_t n = 0;
  for (const fs::directory_entry& d : fs::directory_iterator(dir)) n += d.path().extension() == ".emb" ? 1 : 0;
  CHECK(n == 2);
  fs::remove_all(dir, ec);
}
