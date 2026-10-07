// AE parity 4.7: the 3D model importer's normalizer (model_convert.hpp). Every
// test converts a model and reads the result back with the renderer's own
// glTF reader (gltf_model.hpp), so "plain GLB the renderer takes" is what is
// checked, not the writer's own idea of it.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "gltf_model.hpp"
#include "json.hpp"
#include "meshoptimizer.h"
#include "model_convert.hpp"

namespace mio = premation::scene::modelio;
namespace gltf = premation::scene::gltf;
using premation::js::Json;
using Catch::Approx;

namespace {

std::vector<std::uint8_t> bytes_of(std::string_view s) { return {s.begin(), s.end()}; }

mio::SourceFile file(std::string path, std::string_view text) { return {std::move(path), bytes_of(text)}; }

gltf::Parsed parse_glb(const std::vector<std::uint8_t>& glb) {
  std::string err;
  auto p = gltf::parse(glb, err);
  INFO(err);
  REQUIRE(p.has_value());
  return std::move(*p);
}

/// The JSON chunk of a GLB.
Json glb_json(const std::vector<std::uint8_t>& glb) {
  REQUIRE(glb.size() > 20);
  std::uint32_t len = 0;
  std::memcpy(&len, glb.data() + 12, 4);
  auto j = premation::js::parse(std::string_view(reinterpret_cast<const char*>(glb.data() + 20), len));
  REQUIRE(j.has_value());
  return std::move(*j);
}

void put_u32(std::vector<std::uint8_t>& o, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) o.push_back(static_cast<std::uint8_t>((v >> (8U * static_cast<unsigned>(i))) & 0xFFU));
}

/// A GLB from a JSON document and a binary chunk (test fixtures).
std::vector<std::uint8_t> make_glb(const Json& doc, std::vector<std::uint8_t> bin) {
  std::string json = premation::js::stringify(doc);
  while (json.size() % 4 != 0) json.push_back(' ');
  while (bin.size() % 4 != 0) bin.push_back(0);
  std::vector<std::uint8_t> out;
  put_u32(out, 0x46546c67);
  put_u32(out, 2);
  put_u32(out, static_cast<std::uint32_t>(12 + 8 + json.size() + 8 + bin.size()));
  put_u32(out, static_cast<std::uint32_t>(json.size()));
  put_u32(out, 0x4e4f534a);
  out.insert(out.end(), json.begin(), json.end());
  put_u32(out, static_cast<std::uint32_t>(bin.size()));
  put_u32(out, 0x004e4942);
  out.insert(out.end(), bin.begin(), bin.end());
  return out;
}

constexpr std::string_view kCubeObj = R"(# a unit cube, two materials, vertex colours on the first four corners
mtllib cube.mtl
o Cube
v -1 -1  1 1 0 0
v  1 -1  1 0 1 0
v  1  1  1 0 0 1
v -1  1  1 1 1 1
v -1 -1 -1
v  1 -1 -1
v  1  1 -1
v -1  1 -1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
vn 0 0 -1
vn 1 0 0
vn -1 0 0
vn 0 1 0
vn 0 -1 0
usemtl Red
f 1/1/1 2/2/1 3/3/1 4/4/1
f 6/1/2 5/2/2 8/3/2 7/4/2
f 2/1/3 6/2/3 7/3/3 3/4/3
usemtl Glass
f 5/1/4 1/2/4 4/3/4 8/4/4
f 4/1/5 3/2/5 7/3/5 8/4/5
f 5/1/6 6/2/6 2/3/6 1/4/6
)";

constexpr std::string_view kCubeMtl = R"(newmtl Red
Kd 0.8 0.1 0.1
Ns 100
Pm 0.25
newmtl Glass
Kd 0.9 0.9 1.0
d 0.4
Ni 1.45
)";

}  // namespace

TEST_CASE("model import: OBJ + MTL become one GLB the renderer reads", "[model]") {
  const std::vector<mio::SourceFile> files = {file("models/cube.obj", kCubeObj), file("models/cube.mtl", kCubeMtl)};
  const mio::ConvertResult r = mio::convert_model(files);
  CHECK(r.warnings.empty());
  const gltf::Parsed p = parse_glb(r.glb);
  REQUIRE(p.meshes.size() == 1);
  REQUIRE(p.meshes[0].primitives.size() == 2);  // one per material
  // Three quads per material → six triangles each.
  CHECK(p.meshes[0].primitives[0].indices.size() == 18);
  CHECK(p.meshes[0].primitives[1].indices.size() == 18);
  // Welded per (position, uv, normal): 4 corners per face.
  CHECK(p.meshes[0].primitives[0].positions.size() == 3 * 12);
  REQUIRE(p.materials.size() == 2);
  CHECK(p.materials[0].baseColorFactor[0] == Approx(0.8));
  CHECK(p.materials[0].metallicFactor == Approx(0.25));
  CHECK(p.materials[0].roughnessFactor == Approx(std::sqrt(2.0 / 102.0)));
  CHECK(p.materials[1].baseColorFactor[3] == Approx(0.4));
  const Json j = glb_json(r.glb);
  CHECK(j.at("materials").arr()[1].at("alphaMode").str() == "BLEND");
  CHECK(j.at("materials").arr()[1].at("extensions").at("KHR_materials_ior").at("ior").num() == Approx(1.45));
  // OBJ's v-up texture space flipped to glTF's v-down: corner 1's vt (0 0) → (0 1).
  const auto& uvs = *p.meshes[0].primitives[0].uvs;
  CHECK(uvs[0] == Approx(0.0F));
  CHECK(uvs[1] == Approx(1.0F));
  // The vertex colours ride as COLOR_0.
  const Json& attrs = j.at("meshes").arr()[0].at("primitives").arr()[0].at("attributes");
  CHECK(attrs.at("COLOR_0").is_number());
}

TEST_CASE("model import: a missing MTL / texture is a warning, not a refusal", "[model]") {
  const std::vector<mio::SourceFile> files = {file("cube.obj", kCubeObj)};
  const mio::ConvertResult r = mio::convert_model(files);
  REQUIRE(!r.warnings.empty());
  CHECK(r.warnings[0].find("cube.mtl") != std::string::npos);
  CHECK(parse_glb(r.glb).meshes.size() == 1);
}

TEST_CASE("model import: meshopt-compressed and quantized glTF decode to plain floats", "[model]") {
  // A triangle pair: positions as normalized SHORTs (KHR_mesh_quantization),
  // the vertex and index streams meshopt-encoded (EXT_meshopt_compression).
  const std::vector<std::int16_t> pos = {0, 0, 0, 0, 0, 32767, 0, 0, 0, 0, 32767, 0, 32767, 32767, 0, 0};  // 4 × (x,y,z,pad)
  const std::vector<std::uint16_t> idx = {0, 1, 2, 2, 1, 3};
  std::vector<std::uint8_t> vtx(meshopt_encodeVertexBufferBound(4, 8));
  vtx.resize(meshopt_encodeVertexBuffer(vtx.data(), vtx.size(), pos.data(), 4, 8));
  std::vector<std::uint8_t> ibuf(meshopt_encodeIndexBufferBound(6, 4));
  ibuf.resize(meshopt_encodeIndexBuffer(ibuf.data(), ibuf.size(), idx.data(), 6));
  std::vector<std::uint8_t> bin = vtx;
  while (bin.size() % 4 != 0) bin.push_back(0);
  const std::size_t ioff = bin.size();
  bin.insert(bin.end(), ibuf.begin(), ibuf.end());
  const char* text = R"({
    "asset": {"version": "2.0"},
    "extensionsUsed": ["EXT_meshopt_compression", "KHR_mesh_quantization"],
    "extensionsRequired": ["EXT_meshopt_compression", "KHR_mesh_quantization"],
    "buffers": [{"byteLength": 0}, {"byteLength": 44, "extensions": {"EXT_meshopt_compression": {"fallback": true}}}],
    "bufferViews": [
      {"buffer": 1, "byteOffset": 0, "byteLength": 32, "byteStride": 8,
       "extensions": {"EXT_meshopt_compression": {"buffer": 0, "byteOffset": 0, "byteLength": VLEN, "byteStride": 8, "count": 4, "mode": "ATTRIBUTES"}}},
      {"buffer": 1, "byteOffset": 32, "byteLength": 12,
       "extensions": {"EXT_meshopt_compression": {"buffer": 0, "byteOffset": IOFF, "byteLength": ILEN, "byteStride": 2, "count": 6, "mode": "TRIANGLES"}}}
    ],
    "accessors": [
      {"bufferView": 0, "componentType": 5122, "normalized": true, "count": 4, "type": "VEC3", "min": [0,0,0], "max": [32767,32767,32767]},
      {"bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR"}
    ],
    "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
    "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0
  })";
  std::string json(text);
  const auto subst = [&](const std::string& k, std::size_t v) { json.replace(json.find(k), k.size(), std::to_string(v)); };
  subst("VLEN", vtx.size());
  subst("IOFF", ioff);
  subst("ILEN", ibuf.size());
  auto doc = premation::js::parse(json);
  REQUIRE(doc.has_value());
  // The compressed data lives in buffer 0 (the GLB chunk); buffer 1 is the absent fallback.
  const std::vector<mio::SourceFile> files = {{"q.glb", make_glb(*doc, bin)}};
  const mio::ConvertResult r = mio::convert_model(files);
  const Json out = glb_json(r.glb);
  CHECK_FALSE(out.has("extensionsRequired"));
  CHECK(out.at("accessors").arr()[0].at("componentType").num() == 5126);
  const gltf::Parsed p = parse_glb(r.glb);
  REQUIRE(p.meshes.size() == 1);
  const auto& pr = p.meshes[0].primitives[0];
  REQUIRE(pr.positions.size() == 12);
  CHECK(pr.positions[4] == Approx(1.0F));   // vertex 1: (0, 1, 0)
  CHECK(pr.positions[9] == Approx(1.0F));   // vertex 3: (1, 1, 0)
  CHECK(pr.positions[10] == Approx(1.0F));
  CHECK(pr.indices == std::vector<std::uint32_t>{0, 1, 2, 2, 1, 3});
  // POSITION min / max recomputed in float units.
  CHECK(out.at("accessors").arr()[0].at("max").arr()[0].num() == Approx(1.0));
}

TEST_CASE("model import: a .gltf with sidecar .bin and texture is packed", "[model]") {
  // One triangle; the .bin and the .png beside the .gltf in a sub-folder.
  std::vector<float> pos = {0, 0, 0, 1, 0, 0, 0, 1, 0};
  std::vector<std::uint8_t> bin(pos.size() * 4);
  std::memcpy(bin.data(), pos.data(), bin.size());
  const std::string png = std::string("\x89PNG\r\n\x1a\n", 8) + "not really a png";
  const std::string text = R"({"asset":{"version":"2.0"},
    "buffers":[{"uri":"data/tri.bin","byteLength":36}],
    "bufferViews":[{"buffer":0,"byteLength":36}],
    "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}],
    "images":[{"uri":"data/albedo%20map.png"}],
    "textures":[{"source":0}],
    "materials":[{"pbrMetallicRoughness":{"baseColorTexture":{"index":0}}}],
    "meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],
    "nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}]})";
  const std::vector<mio::SourceFile> files = {file("scene/tri.gltf", text), {"scene/data/tri.bin", bin},
                                              file("scene/data/albedo map.png", png)};
  const mio::ConvertResult r = mio::convert_model(files);
  const gltf::Parsed p = parse_glb(r.glb);
  REQUIRE(p.images.size() == 1);
  CHECK(p.images[0].mimeType == "image/png");
  CHECK(p.images[0].bytes.size() == png.size());
  CHECK(p.meshes[0].primitives[0].positions == pos);
}

TEST_CASE("model import: a .gltf missing its .bin names the file", "[model]") {
  const std::string text = R"({"asset":{"version":"2.0"},"buffers":[{"uri":"tri.bin","byteLength":36}],
    "bufferViews":[{"buffer":0,"byteLength":36}],"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"}],
    "meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}]})";
  const std::vector<mio::SourceFile> files = {file("tri.gltf", text)};
  try {
    (void)mio::convert_model(files);
    FAIL("expected a refusal");
  } catch (const mio::ConvertError& e) {
    CHECK(std::string(e.what()).find("tri.bin") != std::string::npos);
  }
}

TEST_CASE("model import: Draco without the codec is refused with the fix", "[model]") {
  if (mio::draco_available()) SKIP("this build carries the Draco decoder");
  const std::string text = R"({"asset":{"version":"2.0"},"extensionsRequired":["KHR_draco_mesh_compression"],
    "buffers":[{"uri":"data:application/octet-stream;base64,AAAA","byteLength":3}],
    "bufferViews":[{"buffer":0,"byteLength":3}],
    "accessors":[{"componentType":5126,"count":3,"type":"VEC3"}],
    "meshes":[{"primitives":[{"attributes":{"POSITION":0},
      "extensions":{"KHR_draco_mesh_compression":{"bufferView":0,"attributes":{"POSITION":0}}}}]}]})";
  const std::vector<mio::SourceFile> files = {file("d.gltf", text)};
  try {
    (void)mio::convert_model(files);
    FAIL("expected a refusal");
  } catch (const mio::ConvertError& e) {
    CHECK(std::string(e.what()).find("Draco") != std::string::npos);
  }
}

TEST_CASE("model import: FBX through ufbx", "[model]") {
  const std::filesystem::path p = std::filesystem::path(PREMATION_ENGINE_TEST_DATA) / "models" / "blender_272_cube_7400_binary.fbx";
  std::ifstream in(p, std::ios::binary);
  REQUIRE(in.good());
  const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  const std::vector<mio::SourceFile> files = {{"cube.fbx", bytes}};
  const mio::ConvertResult r = mio::convert_model(files);
  const gltf::Parsed parsed = parse_glb(r.glb);
  REQUIRE(!parsed.meshes.empty());
  std::size_t tris = 0;
  for (const auto& m : parsed.meshes) {
    for (const auto& pr : m.primitives) tris += pr.indices.size() / 3;
  }
  CHECK(tris == 12);  // Blender's default cube
  // Y up, metres: the cube spans about ±1 m.
  float maxY = -1e9F;
  for (const auto& m : parsed.meshes) {
    for (const auto& pr : m.primitives) {
      for (std::size_t i = 1; i < pr.positions.size(); i += 3) maxY = std::max(maxY, pr.positions[i]);
    }
  }
  CHECK(maxY == Approx(1.0F).margin(0.05F));
}

namespace {
constexpr std::string_view kUsda = R"(#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "Root" (
    kind = "component"
)
{
    double3 xformOp:translate = (2, 0, 0)
    float3 xformOp:rotateXYZ = (0, 0, 90)
    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]

    def Mesh "Quad"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (
            interpolation = "faceVarying"
        )
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
            interpolation = "vertex"
        )
        rel material:binding = </Root/Looks/Paint>
    }

    def Scope "Looks"
    {
        def Material "Paint"
        {
            token outputs:surface.connect = </Root/Looks/Paint/Surface.outputs:surface>
            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0.2, 0.4, 0.6)
                float inputs:metallic = 1
                float inputs:roughness = 0.3
                token outputs:surface
            }
        }
    }
}
)";
}  // namespace

TEST_CASE("model import: ASCII USD with xformOps, a mesh and a UsdPreviewSurface", "[model]") {
  const std::vector<mio::SourceFile> files = {file("quad.usda", kUsda)};
  const mio::ConvertResult r = mio::convert_model(files);
  const gltf::Parsed p = parse_glb(r.glb);
  REQUIRE(p.meshes.size() == 1);
  CHECK(p.meshes[0].primitives[0].indices.size() == 6);
  REQUIRE(p.materials.size() == 1);
  CHECK(p.materials[0].baseColorFactor[2] == Approx(0.6));
  CHECK(p.materials[0].metallicFactor == Approx(1.0));
  CHECK(p.materials[0].roughnessFactor == Approx(0.3));
  const Json j = glb_json(r.glb);
  // The stage wrapper turns Z up into Y up (−90° about X).
  const Json& stage = j.at("nodes").arr().back();
  CHECK(stage.at("name").str() == "Stage");
  CHECK(stage.at("rotation").arr()[0].num() == Approx(-std::sqrt(0.5)));
  // Root: translate (2,0,0), then 90° about Z.
  const Json& root = j.at("nodes").arr()[0];
  CHECK(root.at("translation").arr()[0].num() == Approx(2.0));
  CHECK(root.at("rotation").arr()[2].num() == Approx(std::sqrt(0.5)));
}

TEST_CASE("model import: a .usdz (store-only zip) with an ASCII layer", "[model]") {
  // zip: one stored entry, quad.usda.
  const std::string name = "quad.usda";
  std::vector<std::uint8_t> z;
  put_u32(z, 0x04034b50U);
  for (int i = 0; i < 2; ++i) z.push_back(0);  // version
  for (int i = 0; i < 2; ++i) z.push_back(0);  // flags
  for (int i = 0; i < 2; ++i) z.push_back(0);  // method: store
  for (int i = 0; i < 4; ++i) z.push_back(0);  // time, date
  put_u32(z, 0);                               // crc (not checked)
  put_u32(z, static_cast<std::uint32_t>(kUsda.size()));
  put_u32(z, static_cast<std::uint32_t>(kUsda.size()));
  z.push_back(static_cast<std::uint8_t>(name.size()));
  z.push_back(0);
  z.push_back(0);
  z.push_back(0);
  z.insert(z.end(), name.begin(), name.end());
  z.insert(z.end(), kUsda.begin(), kUsda.end());
  const std::vector<mio::SourceFile> files = {{"Quad.usdz", z}};
  const mio::ConvertResult r = mio::convert_model(files);
  CHECK(parse_glb(r.glb).meshes.size() == 1);
}

TEST_CASE("model import: a binary USD crate is refused with the alternatives", "[model]") {
  const std::vector<mio::SourceFile> files = {file("x.usd", "PXR-USDC\x00\x00\x00\x00")};
  try {
    (void)mio::convert_model(files);
    FAIL("expected a refusal");
  } catch (const mio::ConvertError& e) {
    CHECK(std::string(e.what()).find(".usda") != std::string::npos);
  }
}

TEST_CASE("model import: unknown formats and empty models are refused", "[model]") {
  {
    const std::vector<mio::SourceFile> files = {file("x.stl", "solid x")};
    CHECK_THROWS_AS(mio::convert_model(files), mio::ConvertError);
  }
  {
    const std::vector<mio::SourceFile> files = {file("empty.obj", "o nothing\n")};
    CHECK_THROWS_AS(mio::convert_model(files), mio::ConvertError);
  }
  CHECK(mio::is_model_extension(".FBX"));
  CHECK_FALSE(mio::is_model_extension(".png"));
}

TEST_CASE("model import: the job's file work writes a free-named GLB, temp + rename", "[model]") {
  namespace fs = std::filesystem;
  const fs::path dir = fs::temp_directory_path() / "premation-model-import-test";
  fs::remove_all(dir);
  fs::create_directories(dir);
  const auto write = [&](const char* name, const std::string& text) {
    std::ofstream(dir / name, std::ios::binary) << text;
    return (dir / name).string();
  };
  const std::string obj = write("box.obj", "mtllib box.mtl\no Quad\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nusemtl Red\nf 1 2 3 4\n");
  const std::string mtl = write("box.mtl", "newmtl Red\nKd 1 0 0\n");
  const fs::path out = dir / "Models";
  int progressCalls = 0;
  const auto progress = [&](double /*f*/, const std::string& /*m*/) { ++progressCalls; };
  const auto never = [] { return false; };
  const std::vector<std::string> both = {obj, mtl};

  const auto first = mio::import_model_files(both, out, "", progress, never);
  REQUIRE(first.has_value());
  CHECK(first->glb == out / "box.glb");
  CHECK(first->name == "box");
  CHECK(first->warnings.empty());
  CHECK(progressCalls > 0);
  CHECK_FALSE(fs::exists(out / "box.glb.partial"));
  {
    std::ifstream in(first->glb, std::ios::binary);
    std::string magic(4, '\0');
    in.read(magic.data(), 4);
    CHECK(magic == "glTF");
  }
  // Never over an earlier import; reserved characters in a given name become '_'.
  const auto second = mio::import_model_files(both, out, "", progress, never);
  REQUIRE(second.has_value());
  CHECK(second->glb == out / "box 2.glb");
  const auto named = mio::import_model_files(both, out, "a/b:c", progress, never);
  REQUIRE(named.has_value());
  CHECK(named->glb == out / "a_b_c.glb");

  // A missing MTL is a warning; cancelling writes nothing; a non-model is refused; an absent file is an IO error.
  const std::vector<std::string> alone = {obj};
  const auto warned = mio::import_model_files(alone, dir / "W", "", progress, never);
  REQUIRE(warned.has_value());
  REQUIRE_FALSE(warned->warnings.empty());
  CHECK(warned->warnings[0].find("box.mtl") != std::string::npos);
  CHECK_FALSE(mio::import_model_files(alone, dir / "C", "", progress, [] { return true; }).has_value());
  CHECK_FALSE(fs::exists(dir / "C"));
  const std::vector<std::string> txt = {write("notes.txt", "hello")};
  CHECK_THROWS_AS(mio::import_model_files(txt, out, "", progress, never), mio::ConvertError);
  const std::vector<std::string> gone = {(dir / "gone.obj").string()};
  CHECK_THROWS_AS(mio::import_model_files(gone, out, "", progress, never), mio::ModelIoError);
  fs::remove_all(dir);
}
