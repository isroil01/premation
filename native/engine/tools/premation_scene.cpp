// premation-scene — the D2w parity gate and bench: the C++ engine builds ITS OWN
// FrameScene from a scene's project document and renders it through the render
// graph, and both halves are compared with the TypeScript.
//
//   premation-scene --batch <scenes> --fonts <fonts.json> --out <dir> --report <json>
//                   [--only a,b] [--readback-table t.bin] [--profile chromium|portable]
//       every <scenes>/<scene>/project.json (written by the render-tests harness,
//       harness/sceneProject.ts) is opened in the engine document (docio
//       restore_document); each frame the harness rendered is built by the scene
//       builder (native/engine/src/scene), diffed STRUCTURALLY against the
//       FrameScene the TS exported beside it (<frame>.pfs), rendered, and written
//       as <out>/<scene>/<frame>.png for the pixel gate (render-tests
//       `native-scene`, scripts/nativeBackend.mjs).
//
//   premation-scene --bench <scenes> --fonts <fonts.json> [--only a,b] [--frames N]
//       frame-build (snapshot + scene), raster and render time per scene.
//   premation-scene --synthetic <layers> --fonts <fonts.json> [--frames N]
//       the same on a generated document of N animated layers (shapes, text,
//       paths) — the 2000-layer perf case.
//
// Status per frame: `ported` (every layer of the frame is inside the port — the
// pixel gate applies), `fallback` (the frame uses features the port reports as
// unported; rendered without them, reported by name, never gated), `error`.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <numeric>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "docexpr.hpp"
#include "docio.hpp"
#include "fonts.hpp"
#include "native_scene.hpp"
#include "png_write.hpp"
#include "scene_renderer.hpp"
#include "scene_textures.hpp"
#include "text_measure.hpp"

#if defined(PREMATION_HAVE_MEDIA)
#include "media_system.hpp"
#include "media_textures.hpp"
#endif

namespace fs = std::filesystem;
namespace api = premation::api;
namespace sc = premation::scene;
namespace rs = premation::raster;
namespace doc = premation::doc;
namespace js = premation::js;

namespace {

bool read_file(const fs::path& p, std::vector<std::uint8_t>& out) {
  std::ifstream in(p, std::ios::binary);
  if (!in) return false;
  in.seekg(0, std::ios::end);
  const auto n = static_cast<std::size_t>(in.tellg());
  in.seekg(0);
  out.resize(n);
  in.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return static_cast<bool>(in);
}

bool write_file(const fs::path& p, std::span<const std::uint8_t> bytes) {
  std::error_code ec;
  fs::create_directories(p.parent_path(), ec);
  std::ofstream out(p, std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return static_cast<bool>(out);
}

std::string esc(std::string_view s) {
  std::string o;
  for (const char c : s) {
    if (c == '"' || c == '\\') {
      o += '\\';
      o += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      o += ' ';
    } else {
      o += c;
    }
  }
  return o;
}

std::string fmt(double v) {
  std::array<char, 32> b{};
  std::snprintf(b.data(), b.size(), "%.6g", v);  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return b.data();
}

/// premation-render's harness_readback (the webgpu PNG path, measured table when given).
void harness_readback(std::vector<std::uint8_t>& rgba, std::span<const std::uint8_t> table) {
  const auto div_round = [](unsigned num, unsigned den) { return (num + den / 2U) / den; };
  const bool measured = table.size() == 256U * 256U;
  for (std::size_t i = 0; i + 3 < rgba.size(); i += 4) {
    const unsigned a = rgba[i + 3];
    if (a == 255) continue;
    for (std::size_t c = 0; c < 3; ++c) {
      if (a == 0) {
        rgba[i + c] = 0;
        continue;
      }
      const unsigned p = rgba[i + c];
      if (measured) {
        rgba[i + c] = table[std::size_t{a} * 256U + std::min(p, a)];
        continue;
      }
      const unsigned s = std::min(255U, div_round(p * 255U, a));
      const unsigned q = div_round(s * a, 255U);
      const unsigned r = div_round(q * a, 255U);
      rgba[i + c] = static_cast<std::uint8_t>(std::min(255U, div_round(r * 255U, a)));
    }
  }
}

// ── structural diff: C++ FrameScene vs the TS-exported one ────────────────────

struct Diff {
  std::size_t tsRenderables = 0;
  std::size_t nativeRenderables = 0;
  std::size_t matched = 0;
  double maxMatrix = 0;   // max |Δ| over model matrices (float32 values)
  double maxScalar = 0;   // opacity, colour, sdf, effect params
  std::vector<std::string> mismatches;
  void note(std::string m) {
    if (mismatches.size() < 12) mismatches.push_back(std::move(m));
  }
};

/// Tolerances the gate states: matrices 1e-3 px·(unit) relative, scalars 1e-4.
constexpr double kMatTol = 1e-3;
constexpr double kScalarTol = 1e-4;

void diff_vec(const std::vector<double>& a, const std::vector<double>& b, double tol, double& worst, Diff& d,
              const std::string& what) {
  if (a.size() != b.size()) {
    d.note(what + ": length " + std::to_string(a.size()) + " vs " + std::to_string(b.size()));
    return;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    const double m = std::abs(a[i] - b[i]) / std::max(1.0, std::abs(b[i]));
    worst = std::max(worst, m);
    if (m > tol) {
      d.note(what + "[" + std::to_string(i) + "] " + fmt(a[i]) + " vs " + fmt(b[i]));
      return;
    }
  }
}

void diff_scalar(double a, double b, Diff& d, const std::string& what) {
  const double m = std::abs(a - b) / std::max(1.0, std::abs(b));
  d.maxScalar = std::max(d.maxScalar, m);
  if (m > kScalarTol) d.note(what + " " + fmt(a) + " vs " + fmt(b));
}

void diff_effects(const std::vector<api::RenderEffect>& a, const std::vector<api::RenderEffect>& b, Diff& d,
                  const std::string& at) {
  if (a.size() != b.size()) {
    std::string ta;
    std::string tb;
    for (const auto& e : a) ta += e.type + ",";
    for (const auto& e : b) tb += e.type + ",";
    d.note(at + " effects [" + ta + "] vs [" + tb + "]");
    return;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (a[i].type != b[i].type) {
      d.note(at + " effect " + a[i].type + " vs " + b[i].type);
      continue;
    }
    for (const auto& pb : b[i].params) {
      const auto it = std::ranges::find_if(a[i].params, [&](const api::RenderEffectParam& p) { return p.name == pb.name; });
      if (it == a[i].params.end()) {
        d.note(at + " " + b[i].type + "." + pb.name + " missing");
        continue;
      }
      if (pb.kind == api::RenderParamKind::text) {
        if (it->text != pb.text) d.note(at + " " + b[i].type + "." + pb.name + " '" + it->text + "' vs '" + pb.text + "'");
      } else if (pb.kind == api::RenderParamKind::numbers || pb.kind == api::RenderParamKind::color) {
        diff_vec(it->numbers, pb.numbers, kScalarTol, d.maxScalar, d, at + " " + b[i].type + "." + pb.name);
      } else {
        diff_scalar(it->number, pb.number, d, at + " " + b[i].type + "." + pb.name);
      }
    }
    for (const auto& pa : a[i].params) {
      if (std::ranges::none_of(b[i].params, [&](const api::RenderEffectParam& p) { return p.name == pa.name; })) {
        d.note(at + " " + a[i].type + "." + pa.name + " extra");
      }
    }
  }
}

void diff_renderables(const std::vector<api::Renderable>& a, const std::vector<api::Renderable>& b, Diff& d);

void diff_one(const api::Renderable& a, const api::Renderable& b, Diff& d) {
  const std::string at = b.id;
  ++d.matched;
  if (a.kind != b.kind) d.note(at + " kind " + std::string(api::to_string(a.kind)) + " vs " + std::string(api::to_string(b.kind)));
  diff_vec(a.model_matrix, b.model_matrix, kMatTol, d.maxMatrix, d, at + " model");
  diff_scalar(a.opacity, b.opacity, d, at + " opacity");
  if (a.blend != b.blend) d.note(at + " blend");
  if (a.advanced_blend.value_or(0) != b.advanced_blend.value_or(0)) d.note(at + " advancedBlend " + fmt(a.advanced_blend.value_or(0)) + " vs " + fmt(b.advanced_blend.value_or(0)));
  if (a.preserve_transparency != b.preserve_transparency) d.note(at + " preserveTransparency");
  if (a.sampling != b.sampling) d.note(at + " sampling");
  if (a.color.has_value() != b.color.has_value()) d.note(at + " color presence");
  else if (a.color) {
    diff_vec({a.color->r, a.color->g, a.color->b, a.color->a}, {b.color->r, b.color->g, b.color->b, b.color->a}, kScalarTol, d.maxScalar, d, at + " color");
  }
  if (a.sdf.has_value() != b.sdf.has_value()) d.note(at + " sdf presence");
  else if (a.sdf) {
    if (a.sdf->shape != b.sdf->shape) d.note(at + " sdf shape");
    diff_vec({a.sdf->radius_px, a.sdf->width, a.sdf->height}, {b.sdf->radius_px, b.sdf->width, b.sdf->height}, kScalarTol, d.maxScalar, d, at + " sdf");
  }
  if (a.color_matrix.has_value() != b.color_matrix.has_value()) d.note(at + " colorMatrix presence");
  else if (a.color_matrix) {
    diff_vec(a.color_matrix->m, b.color_matrix->m, kScalarTol, d.maxScalar, d, at + " colorMatrix.m");
    diff_vec(a.color_matrix->offset, b.color_matrix->offset, kScalarTol, d.maxScalar, d, at + " colorMatrix.offset");
  }
  if (a.texture_key != b.texture_key) d.note(at + " textureKey " + a.texture_key.value_or("-") + " vs " + b.texture_key.value_or("-"));
  if (a.mask_texture_key != b.mask_texture_key) d.note(at + " maskTextureKey");
  if (a.lut_texture_key != b.lut_texture_key) d.note(at + " lutTextureKey");
  if (a.matte.has_value() != b.matte.has_value()) d.note(at + " matte presence");
  else if (a.matte && !(a.matte->mode == b.matte->mode && a.matte->inverted == b.matte->inverted && a.matte->source_id == b.matte->source_id)) {
    d.note(at + " matte");
  }
  if (a.matte_source != b.matte_source) d.note(at + " matteSource");
  if (a.adjustment.has_value() != b.adjustment.has_value()) d.note(at + " adjustment presence");
  if (a.motion_samples.size() != b.motion_samples.size()) {
    d.note(at + " motionSamples " + std::to_string(a.motion_samples.size()) + " vs " + std::to_string(b.motion_samples.size()));
  } else {
    for (std::size_t i = 0; i < a.motion_samples.size(); ++i) {
      diff_vec(a.motion_samples[i].model_matrix, b.motion_samples[i].model_matrix, kMatTol, d.maxMatrix, d, at + " motion[" + std::to_string(i) + "]");
      diff_scalar(a.motion_samples[i].opacity, b.motion_samples[i].opacity, d, at + " motion opacity");
    }
  }
  diff_effects(a.effects, b.effects, d, at);
  if (a.precomp.has_value() != b.precomp.has_value()) d.note(at + " precomp presence");
  diff_renderables(a.precomp_children, b.precomp_children, d);
}

void diff_renderables(const std::vector<api::Renderable>& a, const std::vector<api::Renderable>& b, Diff& d) {
  d.tsRenderables += b.size();
  d.nativeRenderables += a.size();
  const std::size_t n = std::min(a.size(), b.size());
  for (std::size_t i = 0; i < n; ++i) {
    if (a[i].id != b[i].id) {
      d.note("renderable[" + std::to_string(i) + "] id " + a[i].id + " vs " + b[i].id);
      continue;
    }
    diff_one(a[i], b[i], d);
  }
  if (a.size() != b.size()) d.note("renderable count " + std::to_string(a.size()) + " vs " + std::to_string(b.size()));
}

/// A native raster against the TS blob of the same key: max channel Δ and % of pixels > 16/255.
struct TexDiff {
  std::string key;
  std::string note;
  int maxDelta = 0;
  double over16 = 0;
};

// ── scenes ─────────────────────────────────────────────────────────────────

struct Fonts {
  std::unique_ptr<rs::FontSet> set;
  rs::CanvasOptions canvas;
};

bool load_fonts(const std::string& manifest, const std::string& profile, Fonts& f) {
  rs::FontOptions fo = profile == "portable" ? rs::FontOptions{} : rs::FontOptions::chromium_windows();
  f.set = std::make_unique<rs::FontSet>(fo);
  if (!manifest.empty()) {
    std::string err;
    if (!f.set->load_manifest(manifest, err)) {
      std::fprintf(stderr, "fonts: %s\n", err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
      return false;
    }
  }
  for (const char* g : {"Inter", "system-ui", "sans-serif"}) (void)f.set->add_system_family(g);
  f.canvas.fonts = f.set.get();
  f.canvas.lcdGeometry = profile != "portable";
  return true;
}

struct Project {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  std::unique_ptr<doc::DocExprEnv> env;
  std::string comp;
  js::Json harness;
};

bool open_project(const fs::path& file, Project& p, std::string& err) {
  std::vector<std::uint8_t> bytes;
  if (!read_file(file, bytes)) {
    err = "cannot read " + file.string();
    return false;
  }
  const auto json = js::parse(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  if (!json) {
    err = "project.json does not parse";
    return false;
  }
  // The harness's footage records (sceneProject.ts `harness.assets`) are the session's assets.
  std::vector<js::Json> assets;
  if (json->at("harness").at("assets").is_array()) assets = json->at("harness").at("assets").arr();
  try {
    (void)doc::restore_document(p.d, p.view, *json, assets);
  } catch (const std::exception& e) {
    err = std::string("restore_document: ") + e.what();
    return false;
  }
  p.harness = json->at("harness");
  p.comp = p.view.tabComp;
  if (p.d.comp(p.comp) == nullptr && !p.d.comps().empty()) p.comp = p.d.comps().keys().front();
  p.env = std::make_unique<doc::DocExprEnv>(p.d, p.view, p.cache);
  return true;
}

struct Options {
  fs::path batch;
  fs::path out;
  fs::path report;
  std::string fonts;
  std::string profile = "chromium";
  std::set<std::string> only;
  std::vector<std::uint8_t> table;
  int frames = 30;
  int synthetic = 0;
  bool bench = false;
};

struct Engine {
  std::unique_ptr<premation::rg::SceneRenderer> renderer;
  std::unique_ptr<sc::SceneTextures> textures;
#if defined(PREMATION_HAVE_MEDIA)
  std::unique_ptr<premation::media::MediaSystem> media;
  std::unique_ptr<premation::media::MediaTextures> mediaTex;
#endif
};

bool make_engine(const Fonts& fonts, Engine& e, std::string& err) {
  premation::rg::RendererOptions ro;
  ro.highPerformance = true;
  e.renderer = premation::rg::SceneRenderer::create(ro, err);
  if (!e.renderer) return false;
  sc::SceneTextures::Options to;
  to.canvas = fonts.canvas;
  e.textures = std::make_unique<sc::SceneTextures>(to);
  e.textures->set_device(&e.renderer->device());
#if defined(PREMATION_HAVE_MEDIA)
  premation::media::MediaConfig mc;
  mc.hw = premation::media::HwPolicy::softwareOnly;
  e.media = std::make_unique<premation::media::MediaSystem>(mc);
  e.mediaTex = std::make_unique<premation::media::MediaTextures>(*e.media, e.renderer->device().device(),
                                                                 premation::media::MediaTextures::Mode::exact);
  e.textures->set_media(e.media.get(), e.mediaTex.get());
#endif
  e.renderer->set_external_textures(e.textures.get());
  return true;
}

struct Timing {
  double snapshot = 0, scene = 0, raster = 0, encode = 0, gpu = 0;
};

int batch(const Options& o) {
  Fonts fonts;
  if (!load_fonts(o.fonts, o.profile, fonts)) return 2;
  Engine eng;
  std::string err;
  if (!make_engine(fonts, eng, err)) {
    std::fprintf(stderr, "premation-scene: %s\n", err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 1;
  }
  std::vector<fs::path> dirs;
  for (const auto& de : fs::directory_iterator(o.batch)) {
    if (!de.is_directory()) continue;
    if (!o.only.empty() && !o.only.contains(de.path().filename().string())) continue;
    if (fs::exists(de.path() / "project.json")) dirs.push_back(de.path());
  }
  std::ranges::sort(dirs);
  std::ostringstream rep;
  rep << "{\"adapter\":\"" << esc(eng.renderer->adapter()) << "\",\"backend\":\"" << eng.renderer->backend() << "\",\"frames\":[";
  bool first = true;
  std::size_t nPorted = 0, nFallback = 0, nError = 0, nStructOk = 0;
  Timing sum;
  std::size_t timed = 0;
  for (const fs::path& dir : dirs) {
    const std::string sceneId = dir.filename().string();
    Project proj;
    std::string perr;
    const bool opened = open_project(dir / "project.json", proj, perr);
    eng.textures->set_media_base(dir);
    auto measurer = sc::make_canvas_measurer(fonts.canvas);
    std::vector<std::int64_t> frames;
    double fps = 30, w = 0, h = 0;
    bool mbOn = false;
    if (opened) {
      for (const js::Json& f : proj.harness.at("frames").arr()) frames.push_back(static_cast<std::int64_t>(f.num()));
      fps = proj.harness.at("fps").num();
      w = proj.harness.at("size").at("w").num();
      h = proj.harness.at("size").at("h").num();
      mbOn = proj.harness.at("motionBlurOn").is_bool() && proj.harness.at("motionBlurOn").b();
    }
    if (!opened) frames.push_back(0);
    for (const std::int64_t frame : frames) {
      std::ostringstream fr;
      fr << "{\"scene\":\"" << esc(sceneId) << "\",\"frame\":" << frame;
      if (!opened) {
        ++nError;
        fr << ",\"status\":\"error\",\"error\":\"" << esc(perr) << "\"}";
        rep << (first ? "" : ",") << fr.str();
        first = false;
        continue;
      }
      sc::BuildContext ctx{proj.d, proj.view, *proj.env, proj.cache, measurer.get()};
      const doc::Json* rec = proj.d.comp(proj.comp);
      const double cw = rec != nullptr && rec->at("width").is_number() ? rec->at("width").num() : w;
      const double ch = rec != nullptr && rec->at("height").is_number() ? rec->at("height").num() : h;
      const sc::ViewSpec view = sc::export_view(w, h, cw, ch);
      sc::NativeFrame nf;
      std::string buildErr;
      try {
        nf = sc::build_native_frame(ctx, proj.comp, static_cast<double>(frame) / fps, view, mbOn, sceneId, frame);
      } catch (const std::exception& e) {
        buildErr = e.what();
      }
      if (!buildErr.empty()) {
        ++nError;
        fr << ",\"status\":\"error\",\"error\":\"" << esc(buildErr) << "\"}";
        rep << (first ? "" : ",") << fr.str();
        first = false;
        continue;
      }
      // Textures.
      sc::PrepareStats ps;
      eng.textures->prepare(nf.textures, nf.file.textures, ps);
      // Reasons this frame falls back.
      std::set<std::string> reasons;
      for (const auto& e : nf.errors) reasons.insert((e.stage == "snapshot" ? "snapshot error: " : "") + e.message);
      for (const auto& [k, u] : ps.unsupported) reasons.insert("raster: " + u);
      // Structural diff against the TS FrameScene.
      Diff d;
      bool haveTs = false;
      std::vector<TexDiff> texDiffs;
      {
        std::vector<std::uint8_t> bytes;
        api::RenderFrameFile ts;
        std::string derr;
        if (read_file(dir / (std::to_string(frame) + ".pfs"), bytes) && premation::rg::decode_frame_file(bytes, ts, derr)) {
          haveTs = true;
          diff_renderables(nf.file.scene.renderables, ts.scene.renderables, d);
          if (ts.scene.has_effects != nf.file.scene.has_effects) d.note("hasEffects");
          // Texture content: each native raster vs the TS blob under the same key.
          for (const auto& ref : nf.file.textures) {
            if (!ref.hash.starts_with("rs:") && !ref.hash.starts_with("img:")) continue;
            const auto tref = std::ranges::find_if(ts.textures, [&](const api::RenderTextureRef& r) { return r.key == ref.key; });
            if (tref == ts.textures.end()) continue;
            const auto blob = std::ranges::find_if(ts.blobs, [&](const api::RenderBlob& b) { return b.hash == tref->hash; });
            const sc::RasterEntry* mine = eng.textures->raster(ref.hash);
            if (blob == ts.blobs.end() || mine == nullptr) continue;
            TexDiff td;
            td.key = ref.key;
            if (blob->width != mine->width || blob->height != mine->height) {
              td.note = std::to_string(mine->width) + "x" + std::to_string(mine->height) + " vs " + std::to_string(blob->width) + "x" +
                        std::to_string(blob->height);
              td.maxDelta = 255;
              td.over16 = 1;
            } else {
              std::size_t over = 0;
              for (std::size_t i = 0; i < mine->rgba.size(); i += 4) {
                int m = 0;
                for (std::size_t c = 0; c < 4; ++c) m = std::max(m, std::abs(static_cast<int>(mine->rgba[i + c]) - static_cast<int>(blob->pixels[i + c])));
                td.maxDelta = std::max(td.maxDelta, m);
                if (m > 16) ++over;
              }
              td.over16 = mine->rgba.empty() ? 0 : static_cast<double>(over) / static_cast<double>(mine->rgba.size() / 4);
            }
            texDiffs.push_back(std::move(td));
          }
          // The VIEWER's state (guides / grid overlays, the viewer LUT) is the
          // page's, not the document's (docs/VIEWPORT_ROUTE.md): the harness
          // scene sets it on its view, so it comes from the TS frame's view.
          nf.file.view.overlays_active = ts.view.overlays_active;
          nf.file.view.overlays = ts.view.overlays;
          nf.file.view.viewer_lut_active = ts.view.viewer_lut_active;
          nf.file.view.viewer_lut = ts.view.viewer_lut;
          if (ts.view.viewer_lut_active) {
            for (const auto& r : ts.textures) {
              if (r.key != "viewer-lut") continue;
              nf.file.textures.push_back(r);
              for (const auto& b : ts.blobs) {
                if (b.hash == r.hash) nf.file.blobs.push_back(b);
              }
            }
          }
        }
      }
      const bool structOk = haveTs && d.mismatches.empty();
      if (structOk) ++nStructOk;
      // Render.
      premation::rg::Frame out;
      premation::rg::FrameStats stats;
      std::string rerr;
      const bool ok = eng.renderer->render(nf.file, &out, stats, rerr);
      const std::string status = !ok ? "error" : reasons.empty() ? "ported" : "fallback";
      if (status == "ported") ++nPorted;
      else if (status == "fallback") ++nFallback;
      else ++nError;
      if (ok) {
        harness_readback(out.rgba, o.table);
        (void)write_file(o.out / sceneId / (std::to_string(frame) + ".png"), premation::tools::encode_png(out.width, out.height, out.rgba));
        sum.snapshot += nf.snapshotMs;
        sum.scene += nf.sceneMs;
        sum.raster += ps.rasterMs;
        sum.encode += stats.encodeMs;
        sum.gpu += stats.gpuMs;
        ++timed;
      }
      // gateNative's vocabulary (scripts/nativeBackend.mjs): a fallback frame is
      // `not-ported` with its reasons (rendered, counted, never gated).
      const char* gateStatus = status == "ported" ? "rendered" : status == "fallback" ? "not-ported" : "error";
      fr << ",\"status\":\"" << gateStatus << "\",\"port\":\"" << status << "\"";
      if (!ok) fr << ",\"error\":\"" << esc(rerr) << "\"";
      fr << ",\"reasons\":[";
      bool f2 = true;
      for (const auto& r : reasons) {
        fr << (f2 ? "" : ",") << "\"" << esc(r) << "\"";
        f2 = false;
      }
      fr << "],\"struct\":{\"compared\":" << (haveTs ? "true" : "false") << ",\"ok\":" << (structOk ? "true" : "false")
         << ",\"ts\":" << d.tsRenderables << ",\"native\":" << d.nativeRenderables << ",\"matched\":" << d.matched
         << ",\"maxMatrix\":" << fmt(d.maxMatrix) << ",\"maxScalar\":" << fmt(d.maxScalar) << ",\"mismatches\":[";
      f2 = true;
      for (const auto& m : d.mismatches) {
        fr << (f2 ? "" : ",") << "\"" << esc(m) << "\"";
        f2 = false;
      }
      fr << "]},\"textures\":[";
      f2 = true;
      for (const auto& t : texDiffs) {
        fr << (f2 ? "" : ",") << "{\"key\":\"" << esc(t.key) << "\",\"maxDelta\":" << t.maxDelta << ",\"over16\":" << fmt(t.over16);
        if (!t.note.empty()) fr << ",\"note\":\"" << esc(t.note) << "\"";
        fr << "}";
        f2 = false;
      }
      fr << "],\"timing\":{\"snapshotMs\":" << fmt(nf.snapshotMs) << ",\"sceneMs\":" << fmt(nf.sceneMs) << ",\"rasterMs\":" << fmt(ps.rasterMs)
         << ",\"encodeMs\":" << fmt(stats.encodeMs) << ",\"gpuMs\":" << fmt(stats.gpuMs) << "}";
      if (!stats.gpuError.empty()) fr << ",\"gpuError\":\"" << esc(stats.gpuError) << "\"";
      fr << "}";
      rep << (first ? "" : ",") << fr.str();
      first = false;
    }
  }
  const double n = std::max<double>(1, static_cast<double>(timed));
  rep << "],\"timing\":{\"frames\":" << timed << ",\"meanSnapshotMs\":" << fmt(sum.snapshot / n) << ",\"meanSceneMs\":" << fmt(sum.scene / n)
      << ",\"meanRasterMs\":" << fmt(sum.raster / n) << ",\"meanEncodeMs\":" << fmt(sum.encode / n) << ",\"meanGpuMs\":" << fmt(sum.gpu / n) << "}}";
  const std::string s = rep.str();
  (void)write_file(o.report, std::span(reinterpret_cast<const std::uint8_t*>(s.data()), s.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  std::printf("premation-scene: %zu ported, %zu fallback, %zu error; %zu frame(s) structurally equal to the TS FrameScene\n",  // NOLINT(cppcoreguidelines-pro-type-vararg)
              nPorted, nFallback, nError, nStructOk);
  return 0;
}

// ── bench ──────────────────────────────────────────────────────────────────

/// A generated document: `layers` animated layers — rects, ellipses, paths and text,
/// every one moving (x/rotation keyframes), in a 1920×1080 comp.
js::Json synthetic_document(int layers) {
  using js::Json;
  Json nodes = Json::array();
  Json root = Json::object();
  root.set("id", Json::string("comp_root"));
  root.set("name", Json::string("Composition 1"));
  root.set("parent", Json::null());
  Json kids = Json::array();
  Json tracks = Json::object();
  for (int i = 0; i < layers; ++i) {
    const std::string id = "L" + std::to_string(i);
    kids.arr_mut().push_back(Json::string(id));
    Json n = Json::object();
    n.set("id", Json::string(id));
    n.set("name", Json::string(id));
    n.set("parent", Json::string("comp_root"));
    n.set("children", Json::array());
    n.set("visible", Json::boolean(true));
    n.set("locked", Json::boolean(false));
    const int kind = i % 4;
    Json t = Json::object();
    t.set("__kind", Json::string(kind == 3 ? "text" : "shape"));
    t.set("x", Json::number(40 + (i * 37) % 1840));
    t.set("y", Json::number(40 + (i * 53) % 1000));
    t.set("rotation", Json::number(0));
    t.set("width", Json::number(60 + i % 40));
    t.set("height", Json::number(40 + i % 30));
    t.set("shapeType", Json::string(kind == 1 ? "ellipse" : "rect"));
    Json comps = Json::array();
    Json tc = Json::object();
    tc.set("id", Json::string(id + "_t"));
    tc.set("type", Json::string("Transform"));
    tc.set("props", std::move(t));
    comps.arr_mut().push_back(std::move(tc));
    Json style = Json::object();
    style.set("opacity", Json::number(100));
    style.set("fill", Json::string(i % 3 == 0 ? "#3a7bd5" : i % 3 == 1 ? "#e0518a" : "#33c1a6"));
    Json sc0 = Json::object();
    sc0.set("id", Json::string(id + "_s"));
    sc0.set("type", Json::string("Style"));
    sc0.set("props", std::move(style));
    comps.arr_mut().push_back(std::move(sc0));
    if (kind == 2) {
      Json g = Json::object();
      Json pts = Json::array();
      for (const auto& [x, y] : std::vector<std::pair<double, double>>{{0, -20}, {25, 18}, {-25, 18}}) {
        Json p = Json::object();
        for (const char* k : {"x", "inX", "outX"}) p.set(k, Json::number(x));
        for (const char* k : {"y", "inY", "outY"}) p.set(k, Json::number(y));
        pts.arr_mut().push_back(std::move(p));
      }
      g.set("points", std::move(pts));
      Json gc = Json::object();
      gc.set("id", Json::string(id + "_g"));
      gc.set("type", Json::string("Geometry"));
      gc.set("props", std::move(g));
      comps.arr_mut().push_back(std::move(gc));
    }
    if (kind == 3) {
      Json tx = Json::object();
      tx.set("content", Json::string("Layer " + std::to_string(i)));
      tx.set("fontSize", Json::number(24));
      tx.set("fontFamily", Json::string("Arial"));
      tx.set("fill", Json::string("#f4f4f8"));
      Json xc = Json::object();
      xc.set("id", Json::string(id + "_c"));
      xc.set("type", Json::string("Text"));
      xc.set("props", std::move(tx));
      comps.arr_mut().push_back(std::move(xc));
    }
    n.set("components", std::move(comps));
    nodes.arr_mut().push_back(std::move(n));
    // x and rotation keyframes over 2 s.
    Json byProp = Json::object();
    for (const auto& [prop, a, b] : std::vector<std::tuple<const char*, double, double>>{{"x", 40.0 + (i * 37) % 1840, 1880.0 - (i * 37) % 1840}, {"rotation", 0.0, 360.0}}) {
      Json track = Json::object();
      track.set("nodeId", Json::string(id));
      track.set("prop", Json::string(prop));
      Json keys = Json::array();
      for (const auto& [tt, v] : std::vector<std::pair<double, double>>{{0, a}, {2, b}}) {
        Json k = Json::object();
        k.set("t", Json::number(tt));
        k.set("value", Json::number(v));
        keys.arr_mut().push_back(std::move(k));
      }
      track.set("keyframes", std::move(keys));
      byProp.set(prop, std::move(track));
    }
    tracks.set(id, std::move(byProp));
  }
  root.set("children", std::move(kids));
  root.set("visible", Json::boolean(true));
  root.set("locked", Json::boolean(false));
  Json rc = Json::object();
  rc.set("id", Json::string("comp_root_meta"));
  rc.set("type", Json::string("group"));
  Json rp = Json::object();
  rp.set("__kind", Json::string("group"));
  rc.set("props", std::move(rp));
  Json rcs = Json::array();
  rcs.arr_mut().push_back(std::move(rc));
  root.set("components", std::move(rcs));
  nodes.arr_mut().insert(nodes.arr_mut().begin(), std::move(root));
  Json docJ = Json::object();
  docJ.set("version", Json::string("1.1.0"));
  Json scene = Json::object();
  scene.set("version", Json::string("1.0.0"));
  scene.set("nodes", std::move(nodes));
  docJ.set("scene", std::move(scene));
  Json anim = Json::object();
  anim.set("tracks", std::move(tracks));
  anim.set("expressions", Json::object());
  docJ.set("animation", std::move(anim));
  Json comp = Json::object();
  comp.set("id", Json::string("comp_root"));
  comp.set("width", Json::number(1920));
  comp.set("height", Json::number(1080));
  comp.set("fps", Json::number(30));
  comp.set("durationSeconds", Json::number(10));
  comp.set("background", Json::string("#101014"));
  Json comps = Json::object();
  comps.set("comp_root", std::move(comp));
  docJ.set("comps", std::move(comps));
  return docJ;
}

int bench(const Options& o) {
  Fonts fonts;
  if (!load_fonts(o.fonts, o.profile, fonts)) return 2;
  Engine eng;
  std::string err;
  if (!make_engine(fonts, eng, err)) {
    std::fprintf(stderr, "premation-scene: %s\n", err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 1;
  }
  struct Case {
    std::string name;
    std::unique_ptr<Project> p;
    double w, h, fps;
  };
  std::vector<Case> cases;
  if (o.synthetic > 0) {
    auto p = std::make_unique<Project>();
    (void)doc::restore_document(p->d, p->view, synthetic_document(o.synthetic), {});
    p->comp = "comp_root";
    p->env = std::make_unique<doc::DocExprEnv>(p->d, p->view, p->cache);
    cases.push_back({"synthetic-" + std::to_string(o.synthetic), std::move(p), 1920, 1080, 30});
  } else {
    for (const auto& de : fs::directory_iterator(o.batch)) {
      if (!de.is_directory() || !fs::exists(de.path() / "project.json")) continue;
      const std::string id = de.path().filename().string();
      if (!o.only.empty() && !o.only.contains(id)) continue;
      auto p = std::make_unique<Project>();
      std::string perr;
      if (!open_project(de.path() / "project.json", *p, perr)) continue;
      const double w = p->harness.at("size").at("w").num();
      const double h = p->harness.at("size").at("h").num();
      const double fps = p->harness.at("fps").num();
      cases.push_back({id, std::move(p), w, h, fps});
    }
  }
  auto measurer = sc::make_canvas_measurer(fonts.canvas);
  std::printf("{\"adapter\":\"%s\",\"cases\":[", esc(eng.renderer->adapter()).c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
  bool first = true;
  for (Case& c : cases) {
    sc::BuildContext ctx{c.p->d, c.p->view, *c.p->env, c.p->cache, measurer.get()};
    const doc::Json* rec = c.p->d.comp(c.p->comp);
    const sc::ViewSpec view = sc::export_view(c.w, c.h, rec->at("width").num(), rec->at("height").num());
    std::vector<double> build, raster, encode, gpu, total;
    std::size_t layers = 0;
    std::uint64_t misses = 0;
    for (int k = 0; k < o.frames + 3; ++k) {
      const double t = static_cast<double>(k % 60) / c.fps;
      const auto t0 = std::chrono::steady_clock::now();
      sc::NativeFrame nf = sc::build_native_frame(ctx, c.p->comp, t, view, false);
      const auto t1 = std::chrono::steady_clock::now();
      sc::PrepareStats ps;
      eng.textures->prepare(nf.textures, nf.file.textures, ps);
      const auto t2 = std::chrono::steady_clock::now();
      premation::rg::FrameStats stats;
      std::string rerr;
      (void)eng.renderer->render(nf.file, nullptr, stats, rerr);
      const auto t3 = std::chrono::steady_clock::now();
      layers = nf.file.scene.renderables.size();
      if (k < 3) continue;  // warm-up: fonts, pipelines, first rasters
      build.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
      raster.push_back(std::chrono::duration<double, std::milli>(t2 - t1).count());
      misses += ps.rasterMisses;
      encode.push_back(stats.encodeMs);
      gpu.push_back(stats.gpuMs);
      total.push_back(std::chrono::duration<double, std::milli>(t3 - t0).count());
    }
    const auto mean = [](const std::vector<double>& v) { return v.empty() ? 0.0 : std::accumulate(v.begin(), v.end(), 0.0) / static_cast<double>(v.size()); };
    const auto p50 = [](std::vector<double> v) {
      if (v.empty()) return 0.0;
      std::ranges::sort(v);
      return v[v.size() / 2];
    };
    std::printf("%s{\"case\":\"%s\",\"renderables\":%zu,\"frames\":%zu,\"buildMs\":%s,\"buildP50Ms\":%s,\"rasterMs\":%s,\"renderEncodeMs\":%s,\"renderGpuMs\":%s,\"totalMs\":%s,\"totalP50Ms\":%s,\"rasterMissesPerFrame\":%s}\n",  // NOLINT(cppcoreguidelines-pro-type-vararg)
                first ? "" : ",", esc(c.name).c_str(), layers, total.size(), fmt(mean(build)).c_str(), fmt(p50(build)).c_str(),
                fmt(mean(raster)).c_str(), fmt(mean(encode)).c_str(), fmt(mean(gpu)).c_str(), fmt(mean(total)).c_str(), fmt(p50(total)).c_str(),
                fmt(total.empty() ? 0.0 : static_cast<double>(misses) / static_cast<double>(total.size())).c_str());
    first = false;
  }
  std::printf("]}\n");  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return 0;
}

int run(int argc, char** argv) {
  Options o;
  std::map<std::string, std::string, std::less<>> opt;
  const std::span<char*> args(argv, static_cast<std::size_t>(argc));
  for (std::size_t i = 1; i < args.size(); ++i) {
    const std::string_view k = args[i];
    if (k.starts_with("--")) opt[std::string(k.substr(2))] = i + 1 < args.size() ? std::string(args[i + 1]) : std::string();
  }
  if (opt.contains("fonts")) o.fonts = opt["fonts"];
  if (opt.contains("profile")) o.profile = opt["profile"];
  if (opt.contains("frames")) o.frames = std::stoi(opt["frames"]);
  if (opt.contains("only")) {
    std::stringstream ss(opt["only"]);
    std::string s;
    while (std::getline(ss, s, ',')) {
      if (!s.empty()) o.only.insert(s);
    }
  }
  if (opt.contains("readback-table")) {
    if (!read_file(opt["readback-table"], o.table) || o.table.size() != 65536) o.table.clear();
  }
  if (opt.contains("synthetic")) {
    o.synthetic = std::stoi(opt["synthetic"]);
    return bench(o);
  }
  if (opt.contains("bench")) {
    o.batch = opt["bench"];
    return bench(o);
  }
  if (opt.contains("batch")) {
    o.batch = opt["batch"];
    o.out = opt.contains("out") ? fs::path(opt["out"]) : fs::path("native-scene-out");
    o.report = opt.contains("report") ? fs::path(opt["report"]) : o.out / "report.json";
    return batch(o);
  }
  std::fprintf(stderr, "usage: premation-scene --batch DIR --fonts F --out DIR --report JSON | --bench DIR | --synthetic N\n");  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return 64;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    return run(argc, argv);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "premation-scene: %s\n", e.what());  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return 1;
  }
}
