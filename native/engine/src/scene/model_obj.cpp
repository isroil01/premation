// Wavefront .obj (+ .mtl) → SceneModel (model_convert.hpp, AE parity 4.7).
//
// One mesh per `o` object (or `g` group when the file has no objects), one
// primitive per material inside it; faces fan-triangulated; vertices welded
// per distinct (position, uv, normal) triple. The non-standard per-vertex
// colour (`v x y z r g b`) becomes COLOR_0. MTL: Kd / d / Tr / Ke / Ns / Ni,
// the PBR extension's Pr / Pm, map_Kd / map_Ke / map_Bump / norm.
#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <map>
#include <string>
#include <tuple>

#include "model_convert.hpp"

namespace premation::scene::modelio {
namespace {

std::string_view trim(std::string_view s) {
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front())) != 0) s.remove_prefix(1);
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back())) != 0) s.remove_suffix(1);
  return s;
}

std::vector<std::string_view> split_ws(std::string_view s) {
  std::vector<std::string_view> out;
  std::size_t i = 0;
  while (i < s.size()) {
    while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i])) != 0) ++i;
    const std::size_t st = i;
    while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i])) == 0) ++i;
    if (i > st) out.push_back(s.substr(st, i - st));
  }
  return out;
}

double to_d(std::string_view s, double fb = 0) {
  double v = fb;
  const auto* b = s.data();
  const auto* e = s.data() + s.size();
  if (!s.empty() && s.front() == '+') ++b;
  const auto r = std::from_chars(b, e, v);
  return r.ec == std::errc() ? v : fb;
}

long to_l(std::string_view s) {
  long v = 0;
  const auto r = std::from_chars(s.data(), s.data() + s.size(), v);
  return r.ec == std::errc() ? v : 0;
}

std::vector<std::string_view> lines_of(std::string_view text) {
  std::vector<std::string_view> out;
  std::size_t st = 0;
  for (std::size_t i = 0; i <= text.size(); ++i) {
    if (i == text.size() || text[i] == '\n') {
      std::string_view l = text.substr(st, i - st);
      if (!l.empty() && l.back() == '\r') l.remove_suffix(1);
      out.push_back(l);
      st = i + 1;
    }
  }
  return out;
}

std::string lower(std::string_view s) {
  std::string o(s);
  std::ranges::transform(o, o.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return o;
}

std::string mime_of(const std::vector<std::uint8_t>& b) {
  if (b.size() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
  if (b.size() >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F') return "image/webp";
  return "image/png";
}

/// The file name of an MTL map statement, past its `-option value…` arguments.
std::string map_file(std::string_view rest) {
  const auto toks = split_ws(rest);
  // Options with their argument counts (MTL spec).
  static const std::map<std::string, int, std::less<>> kArgs = {{"-blendu", 1}, {"-blendv", 1}, {"-bm", 1}, {"-boost", 1},
                                                                 {"-cc", 1},     {"-clamp", 1},  {"-imfchan", 1}, {"-mm", 2},
                                                                 {"-o", 3},      {"-s", 3},      {"-t", 3},       {"-texres", 1}};
  std::size_t i = 0;
  while (i < toks.size() && toks[i].starts_with("-")) {
    const auto it = kArgs.find(toks[i]);
    const int n = it == kArgs.end() ? 1 : it->second;
    ++i;
    // -o / -s / -t take 1 to 3 numbers.
    for (int k = 0; k < n && i < toks.size() && (k == 0 || std::isdigit(static_cast<unsigned char>(toks[i].front())) != 0 || toks[i].front() == '-' ||
                                                 toks[i].front() == '.');
         ++k) {
      ++i;
    }
  }
  std::string f;
  for (; i < toks.size(); ++i) f += (f.empty() ? "" : " ") + std::string(toks[i]);
  return f;
}

struct Builder {
  SceneModel scene;
  std::map<std::string, int, std::less<>> materialIndex;
  std::map<std::string, int, std::less<>> textureIndex;

  int texture(const FileSet& files, const std::string& file) {
    if (file.empty()) return -1;
    if (const auto it = textureIndex.find(file); it != textureIndex.end()) return it->second;
    const SourceFile* f = files.find(file);
    if (f == nullptr) {
      scene.warnings.push_back("texture “" + file + "” was not in the selection");
      textureIndex.emplace(file, -1);
      return -1;
    }
    TextureDef t;
    t.bytes = f->bytes;
    t.mimeType = mime_of(t.bytes);
    scene.textures.push_back(std::move(t));
    const int i = static_cast<int>(scene.textures.size()) - 1;
    textureIndex.emplace(file, i);
    return i;
  }

  void load_mtl(const FileSet& files, std::string_view text) {
    MaterialDef* cur = nullptr;
    bool roughnessSet = false;
    for (const std::string_view raw : lines_of(text)) {
      const std::string_view line = trim(raw);
      if (line.empty() || line.front() == '#') continue;
      const auto sp = line.find_first_of(" \t");
      const std::string key = lower(line.substr(0, sp));
      const std::string_view rest = sp == std::string_view::npos ? std::string_view() : trim(line.substr(sp));
      const auto v = split_ws(rest);
      if (key == "newmtl") {
        MaterialDef m;
        m.name = std::string(rest);
        scene.materials.push_back(std::move(m));
        cur = &scene.materials.back();
        materialIndex[cur->name] = static_cast<int>(scene.materials.size()) - 1;
        roughnessSet = false;
        continue;
      }
      if (cur == nullptr) continue;
      if (key == "kd" && v.size() >= 3) {
        cur->baseColor[0] = to_d(v[0], 1);
        cur->baseColor[1] = to_d(v[1], 1);
        cur->baseColor[2] = to_d(v[2], 1);
      } else if (key == "d" && !v.empty()) {
        cur->baseColor[3] = std::clamp(to_d(v.back(), 1), 0.0, 1.0);
      } else if (key == "tr" && !v.empty()) {
        cur->baseColor[3] = std::clamp(1 - to_d(v[0], 0), 0.0, 1.0);
      } else if (key == "ke" && v.size() >= 3) {
        cur->emissive = {to_d(v[0]), to_d(v[1]), to_d(v[2])};
      } else if (key == "ns" && !v.empty() && !roughnessSet) {
        cur->roughness = std::sqrt(2.0 / (std::max(0.0, to_d(v[0], 32)) + 2.0));
      } else if (key == "pr" && !v.empty()) {
        cur->roughness = std::clamp(to_d(v[0], 0.5), 0.0, 1.0);
        roughnessSet = true;
      } else if (key == "pm" && !v.empty()) {
        cur->metallic = std::clamp(to_d(v[0], 0), 0.0, 1.0);
      } else if (key == "ni" && !v.empty()) {
        cur->ior = std::clamp(to_d(v[0], 1.5), 1.0, 4.0);
      } else if (key == "map_kd") {
        cur->baseColorTexture = texture(files, map_file(rest));
      } else if (key == "map_ke") {
        cur->emissiveTexture = texture(files, map_file(rest));
      } else if (key == "map_bump" || key == "bump" || key == "norm") {
        cur->normalTexture = texture(files, map_file(rest));
      }
    }
    for (MaterialDef& m : scene.materials) {
      if (m.baseColor[3] < 0.999) m.alphaMode = "BLEND";
      // A texture replaces the diffuse colour in OBJ viewers; glTF multiplies — keep white under a map.
      if (m.baseColorTexture >= 0 && m.baseColor[0] == m.baseColor[1] && m.baseColor[1] == m.baseColor[2] && m.baseColor[0] < 0.9) {
        m.baseColor[0] = m.baseColor[1] = m.baseColor[2] = 1;
      }
    }
  }
};

}  // namespace

SceneModel load_obj(const FileSet& files) {
  const std::vector<std::uint8_t>& bytes = files.model().bytes;
  const std::string_view text(reinterpret_cast<const char*>(bytes.data()), bytes.size());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  Builder b;
  std::vector<float> pos;
  std::vector<float> col;  // rgb per position, when the file carries vertex colours
  std::vector<float> uv;
  std::vector<float> nrm;
  bool anyColor = false;

  struct Face {
    std::vector<std::array<long, 3>> corners;  // v, vt, vn (0-based, -1 = none)
  };
  struct Group {
    std::string name;
    std::map<int, std::vector<Face>> byMaterial;  // material → faces, in file order of first use
    std::vector<int> materialOrder;
  };
  std::vector<Group> groups;
  groups.push_back({"Object", {}, {}});
  bool sawObject = false;
  int currentMaterial = -1;
  const auto group_for = [&](const std::string& name) {
    if (groups.size() == 1 && groups.front().byMaterial.empty()) {
      groups.front().name = name;
    } else {
      groups.push_back({name, {}, {}});
    }
  };

  for (const std::string_view raw : lines_of(text)) {
    const std::string_view line = trim(raw);
    if (line.empty() || line.front() == '#') continue;
    const auto sp = line.find_first_of(" \t");
    const std::string_view key = line.substr(0, sp);
    const std::string_view rest = sp == std::string_view::npos ? std::string_view() : trim(line.substr(sp));
    const auto v = split_ws(rest);
    if (key == "v" && v.size() >= 3) {
      for (int k = 0; k < 3; ++k) pos.push_back(static_cast<float>(to_d(v[static_cast<std::size_t>(k)])));
      if (v.size() >= 6) {
        anyColor = true;
        for (int k = 3; k < 6; ++k) col.push_back(static_cast<float>(to_d(v[static_cast<std::size_t>(k)], 1)));
      } else {
        col.insert(col.end(), {1.0F, 1.0F, 1.0F});
      }
    } else if (key == "vt" && !v.empty()) {
      uv.push_back(static_cast<float>(to_d(v[0])));
      uv.push_back(static_cast<float>(1.0 - (v.size() > 1 ? to_d(v[1]) : 0)));  // OBJ v up → glTF v down
    } else if (key == "vn" && v.size() >= 3) {
      for (int k = 0; k < 3; ++k) nrm.push_back(static_cast<float>(to_d(v[static_cast<std::size_t>(k)])));
    } else if (key == "o") {
      sawObject = true;
      group_for(std::string(rest));
    } else if (key == "g" && !sawObject && !rest.empty()) {
      group_for(std::string(rest));
    } else if (key == "usemtl") {
      const auto it = b.materialIndex.find(rest);
      if (it != b.materialIndex.end()) {
        currentMaterial = it->second;
      } else {
        MaterialDef m;
        m.name = std::string(rest);
        b.scene.materials.push_back(std::move(m));
        currentMaterial = static_cast<int>(b.scene.materials.size()) - 1;
        b.materialIndex[std::string(rest)] = currentMaterial;
      }
    } else if (key == "mtllib") {
      for (const std::string_view f : split_ws(rest)) {
        if (const SourceFile* mtl = files.find(f)) {
          // Materials declared by usemtl before the library loaded keep their indices.
          const std::size_t before = b.scene.materials.size();
          b.load_mtl(files, std::string_view(reinterpret_cast<const char*>(mtl->bytes.data()), mtl->bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
          (void)before;
        } else {
          b.scene.warnings.push_back("material library “" + std::string(f) + "” was not in the selection");
        }
      }
    } else if (key == "f" && v.size() >= 3) {
      Face face;
      const auto vn = static_cast<long>(pos.size() / 3);
      const auto tn = static_cast<long>(uv.size() / 2);
      const auto nn = static_cast<long>(nrm.size() / 3);
      for (const std::string_view c : v) {
        std::array<long, 3> idx{-1, -1, -1};
        std::size_t start = 0;
        for (int k = 0; k < 3; ++k) {
          const auto slash = c.find('/', start);
          const std::string_view part = c.substr(start, slash == std::string_view::npos ? std::string_view::npos : slash - start);
          if (!part.empty()) {
            const long i = to_l(part);
            const long count = k == 0 ? vn : k == 1 ? tn : nn;
            idx.at(static_cast<std::size_t>(k)) = i < 0 ? count + i : i - 1;  // negative = relative to the end
          }
          if (slash == std::string_view::npos) break;
          start = slash + 1;
        }
        if (idx[0] < 0 || idx[0] >= vn) continue;
        if (idx[1] >= tn) idx[1] = -1;
        if (idx[2] >= nn) idx[2] = -1;
        face.corners.push_back(idx);
      }
      if (face.corners.size() < 3) continue;
      Group& g = groups.back();
      if (!g.byMaterial.contains(currentMaterial)) g.materialOrder.push_back(currentMaterial);
      g.byMaterial[currentMaterial].push_back(std::move(face));
    }
  }

  for (const Group& g : groups) {
    if (g.byMaterial.empty()) continue;
    MeshDef mesh;
    mesh.name = g.name;
    for (const int mat : g.materialOrder) {
      const std::vector<Face>& faces = g.byMaterial.at(mat);
      PrimitiveDef p;
      p.material = mat;
      std::map<std::array<long, 3>, std::uint32_t> weld;
      bool hasUv = true;
      bool hasNormal = true;
      for (const Face& f : faces) {
        for (const auto& c : f.corners) {
          hasUv = hasUv && c[1] >= 0;
          hasNormal = hasNormal && c[2] >= 0;
        }
      }
      const auto vertex = [&](const std::array<long, 3>& c) {
        const auto it = weld.find(c);
        if (it != weld.end()) return it->second;
        const auto idx = static_cast<std::uint32_t>(p.positions.size() / 3);
        const auto pi = static_cast<std::size_t>(c[0]);
        p.positions.insert(p.positions.end(), {pos[pi * 3], pos[pi * 3 + 1], pos[pi * 3 + 2]});
        if (anyColor) p.colors.insert(p.colors.end(), {col[pi * 3], col[pi * 3 + 1], col[pi * 3 + 2], 1.0F});
        if (hasUv) {
          const auto ti = static_cast<std::size_t>(c[1]);
          p.uvs.insert(p.uvs.end(), {uv[ti * 2], uv[ti * 2 + 1]});
        }
        if (hasNormal) {
          const auto ni = static_cast<std::size_t>(c[2]);
          p.normals.insert(p.normals.end(), {nrm[ni * 3], nrm[ni * 3 + 1], nrm[ni * 3 + 2]});
        }
        weld.emplace(c, idx);
        return idx;
      };
      for (const Face& f : faces) {
        const std::uint32_t a = vertex(f.corners[0]);
        for (std::size_t k = 1; k + 1 < f.corners.size(); ++k) {
          p.indices.push_back(a);
          p.indices.push_back(vertex(f.corners[k]));
          p.indices.push_back(vertex(f.corners[k + 1]));
        }
      }
      mesh.primitives.push_back(std::move(p));
    }
    b.scene.meshes.push_back(std::move(mesh));
    NodeDef node;
    node.name = g.name;
    node.mesh = static_cast<int>(b.scene.meshes.size()) - 1;
    b.scene.nodes.push_back(std::move(node));
    b.scene.roots.push_back(static_cast<int>(b.scene.nodes.size()) - 1);
  }
  return std::move(b.scene);
}

}  // namespace premation::scene::modelio
