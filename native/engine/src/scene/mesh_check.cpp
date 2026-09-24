// See mesh_check.hpp.
#include "mesh_check.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

#include "canvas.hpp"
#include "extrusion_mesh.hpp"
#include "frame_scene.hpp"
#include "json.hpp"
#include "primitive_mesh.hpp"

namespace premation::scene {
namespace {

namespace fs = std::filesystem;

struct Rebuilt {
  std::optional<api::RenderExtrudedMesh> mesh;
  std::string why;  // unsupported key / failure
};

std::optional<std::string> sopt(const Json& v) { return v.is_string() ? std::optional<std::string>(v.str()) : std::nullopt; }
std::optional<double> nopt(const Json& v) { return v.is_number() ? std::optional<double>(v.num()) : std::nullopt; }

/// Rebuild an extrusion mesh from `<outline key>|d…|b…|<profile>[|f][|nfb][|h…]`.
Rebuilt rebuild_extrusion(const std::string& key, const raster::CanvasOptions& canvas) {
  Rebuilt out;
  const std::size_t bpos = key.rfind("|b");
  const std::size_t dpos = bpos == std::string::npos ? std::string::npos : key.rfind("|d", bpos);
  if (dpos == std::string::npos) {
    out.why = "key has no |d…|b… suffix";
    return out;
  }
  const std::string outlineKey = key.substr(0, dpos);
  std::vector<std::string> tail;
  {
    std::string cur;
    for (const char c : key.substr(dpos + 1)) {
      if (c == '|') {
        tail.push_back(cur);
        cur.clear();
      } else {
        cur += c;
      }
    }
    tail.push_back(cur);
  }
  if (tail.size() < 3) {
    out.why = "short suffix";
    return out;
  }
  ExtrusionMeshRequest req;
  req.depth = std::stod(tail[0].substr(1));
  req.bevel = std::stod(tail[1].substr(1));
  req.bevelStyle = bevel_profile_of(tail[2]);
  for (std::size_t i = 3; i < tail.size(); ++i) {
    if (tail[i] == "f") req.frontCap = true;
    else if (tail[i] == "nfb") req.frontBevel = false;
    else if (tail[i].starts_with("h")) req.holeBevelScale = std::stod(tail[i].substr(1));
  }

  RLayer l;
  double W = 0;
  double H = 0;
  if (outlineKey.starts_with("rect:")) {
    // rect:WxH:rk
    const std::string body = outlineKey.substr(5);
    const std::size_t x = body.find('x');
    const std::size_t c = body.find(':');
    W = std::stod(body.substr(0, x));
    H = std::stod(body.substr(x + 1, c - x - 1));
    const std::string rk = body.substr(c + 1);
    if (rk.find(',') != std::string::npos) {
      std::array<double, 4> r{};
      std::size_t at = 0;
      for (double& v : r) {
        const std::size_t e = rk.find(',', at);
        v = std::stod(rk.substr(at, e - at));
        at = e == std::string::npos ? e : e + 1;
      }
      l.cornerRadii = r;
    } else {
      l.cornerRadius = std::stod(rk);
    }
    l.kind = LayerKind::shape;
  } else if (outlineKey.starts_with("ellipse:")) {
    const std::string body = outlineKey.substr(8);
    const std::size_t x = body.find('x');
    W = std::stod(body.substr(0, x));
    H = std::stod(body.substr(x + 1));
    l.kind = LayerKind::shape;
    l.primitive = "ellipse";
  } else if (outlineKey.starts_with("text:")) {
    const auto arr = js::parse(outlineKey.substr(5));
    if (!arr || !arr->is_array() || arr->arr().size() < 23) {
      out.why = "text key does not parse";
      return out;
    }
    const auto& a = arr->arr();
    l.kind = LayerKind::text;
    l.text = sopt(a[0]);
    l.fontSize = a[1].num();
    W = a[2].num();
    H = a[3].num();
    l.fontFamily = sopt(a[4]);
    l.fontWeight = sopt(a[5]);
    l.fontWidth = nopt(a[6]);
    l.fontSlant = nopt(a[7]);
    l.fontStyle = sopt(a[8]);
    l.align = sopt(a[9]);
    l.letterSpacing = nopt(a[10]);
    l.lineHeight = nopt(a[11]);
    l.paragraphSpacing = nopt(a[12]);
    l.textTransform = sopt(a[13]);
    l.fontVariant = sopt(a[14]);
    l.verticalAlign = sopt(a[15]);
    l.verticalScale = nopt(a[16]);
    l.horizontalScale = nopt(a[17]);
    l.baselineShift = nopt(a[18]);
    if (a[19].num() != 0) l.textStrokeWidth = a[19].num();
    if (!a[20].str().empty()) l.textExtras = js::parse(a[20].str()).value_or(Json());
    if (!a[21].str().empty()) l.runs = js::parse(a[21].str()).value_or(Json());
    if (!a[22].str().empty()) {
      out.why = "text on a path (key carries only its hash)";
      return out;
    }
    if (a.size() > 23) l.fontAxes = js::parse(a[23].str()).value_or(Json());
    if (outlineKey.find("|g") != std::string::npos && outlineKey.rfind(']') < outlineKey.rfind("|g")) {
      out.why = "animated glyphs (key carries only their hash)";
      return out;
    }
  } else {
    out.why = "outline kind not rebuildable from its key (" + outlineKey.substr(0, outlineKey.find(':')) + ")";
    return out;
  }
  l.width = W;
  l.height = H;
  const auto outline = extrusion_outline_for(l, W, H, &canvas);
  if (!outline) {
    out.why = "no outline";
    return out;
  }
  if (outline->key != outlineKey) {
    out.why = "outline key differs: " + outline->key;
    return out;
  }
  const auto m = extrusion_mesh_for(*outline, W, H, req);
  if (!m) {
    out.why = "no mesh";
    return out;
  }
  api::RenderExtrudedMesh am;
  mesh_to_api(m->key, *m->mesh, am);
  out.mesh = std::move(am);
  return out;
}

struct Totals {
  int exact = 0;
  int differ = 0;
  int skipped = 0;
};

void compare(const std::string& where, const api::RenderExtrudedMesh& ts, const Rebuilt& rb, Totals& t) {
  if (!rb.mesh) {
    ++t.skipped;
    std::printf("SKIP  %s  %s\n       %s\n", where.c_str(), ts.key.c_str(), rb.why.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
    return;
  }
  const api::RenderExtrudedMesh& me = *rb.mesh;
  std::string notes;
  if (me.key != ts.key) notes += " key(" + me.key + ")";
  if (me.index_format != ts.index_format) notes += " indexFormat";
  if (me.ranges.size() != ts.ranges.size()) {
    notes += " ranges " + std::to_string(me.ranges.size()) + " vs " + std::to_string(ts.ranges.size());
  } else {
    for (std::size_t i = 0; i < me.ranges.size(); ++i) {
      if (me.ranges[i].role != ts.ranges[i].role || me.ranges[i].first != ts.ranges[i].first || me.ranges[i].count != ts.ranges[i].count) {
        notes += " range[" + std::to_string(i) + "] " + std::string(api::to_string(me.ranges[i].role)) + ":" +
                 std::to_string(me.ranges[i].first) + "+" + std::to_string(me.ranges[i].count) + " vs " +
                 std::string(api::to_string(ts.ranges[i].role)) + ":" + std::to_string(ts.ranges[i].first) + "+" +
                 std::to_string(ts.ranges[i].count);
      }
    }
  }
  const std::size_t nv = me.vertices.size() / 4;
  const std::size_t tv = ts.vertices.size() / 4;
  double maxd = 0;
  std::size_t bitDiffs = 0;
  std::size_t firstDiff = SIZE_MAX;
  if (nv != tv) {
    notes += " vertices " + std::to_string(nv / 8) + " vs " + std::to_string(tv / 8);
  }
  for (std::size_t i = 0; i < std::min(nv, tv); ++i) {
    float a = 0;
    float b = 0;
    std::memcpy(&a, me.vertices.data() + (i * 4), 4);
    std::memcpy(&b, ts.vertices.data() + (i * 4), 4);
    if (std::memcmp(&a, &b, 4) != 0) {
      ++bitDiffs;
      if (firstDiff == SIZE_MAX) firstDiff = i;
      maxd = std::max(maxd, static_cast<double>(std::abs(a - b)));
    }
  }
  if (bitDiffs > 0) {
    notes += " floats≠ " + std::to_string(bitDiffs) + " (max|Δ| " + std::to_string(maxd) + ", first at vertex " +
             std::to_string(firstDiff / 8) + "." + std::to_string(firstDiff % 8) + ")";
  }
  if (me.indices != ts.indices) {
    std::size_t diffs = 0;
    const std::size_t n = std::min(me.indices.size(), ts.indices.size());
    for (std::size_t i = 0; i < n; ++i) diffs += me.indices[i] != ts.indices[i] ? 1 : 0;
    notes += " index bytes " + std::to_string(me.indices.size()) + " vs " + std::to_string(ts.indices.size()) + " (" +
             std::to_string(diffs) + " differ)";
  }
  if (notes.empty()) {
    ++t.exact;
    std::printf("EXACT %s  %s  (%zu vertices, %zu index bytes)\n", where.c_str(), ts.key.substr(0, 90).c_str(), tv / 8,  // NOLINT(cppcoreguidelines-pro-type-vararg)
                ts.indices.size());
  } else {
    ++t.differ;
    std::printf("DIFF  %s  %s\n      %s\n", where.c_str(), ts.key.substr(0, 90).c_str(), notes.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
  }
}

void walk(const std::vector<api::Renderable>& rs, const std::string& scene, const raster::CanvasOptions& canvas, Totals& t) {
  for (const api::Renderable& r : rs) {
    if (r.extruded_mesh) {
      const std::string& key = r.extruded_mesh->key;
      Rebuilt rb;
      if (key.starts_with("prim:")) {
        rb = {};
        if (auto m = primitive_mesh_for_key(key)) {
          api::RenderExtrudedMesh am;
          primitive_mesh_to_api(*m, am);
          rb.mesh = std::move(am);
        } else {
          rb.why = "primitive key not rebuilt";
        }
      } else if (key.starts_with("gltf-")) {
        rb.why = "glTF model (checked against the model file, not the key)";
      } else {
        rb = rebuild_extrusion(key, canvas);
      }
      compare(scene + " " + r.id, *r.extruded_mesh, rb, t);
    }
    walk(r.precomp_children, scene, canvas, t);
  }
}

}  // namespace

int mesh_check(const fs::path& scenes, const std::set<std::string>& only, const raster::CanvasOptions& canvas) {
  Totals t;
  std::vector<fs::path> dirs;
  for (const auto& de : fs::directory_iterator(scenes)) {
    if (!de.is_directory()) continue;
    if (!only.empty() && !only.contains(de.path().filename().string())) continue;
    dirs.push_back(de.path());
  }
  std::ranges::sort(dirs);
  for (const fs::path& dir : dirs) {
    for (const auto& fe : fs::directory_iterator(dir)) {
      if (fe.path().extension() != ".pfs") continue;
      std::ifstream f(fe.path(), std::ios::binary);
      const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
      api::RenderFrameFile file;
      std::string err;
      if (!rg::decode_frame_file(bytes, file, err)) {
        std::printf("ERROR %s: %s\n", fe.path().string().c_str(), err.c_str());  // NOLINT(cppcoreguidelines-pro-type-vararg)
        continue;
      }
      walk(file.scene.renderables, dir.filename().string() + "#" + fe.path().stem().string(), canvas, t);
    }
  }
  std::printf("mesh-check: %d exact, %d differ, %d skipped\n", t.exact, t.differ, t.skipped);  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return t.differ == 0 ? 0 : 1;
}

}  // namespace premation::scene
