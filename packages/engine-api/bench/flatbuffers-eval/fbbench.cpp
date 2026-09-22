// FlatBuffers twin of benchDocument.ts, used for the wire-format decision (docs/ENGINE_API.md §9.3).
// Not built by anything in the repo: flatc --cpp --gen-object-api bench.fbs, then compile with the
// vcpkg flatbuffers headers (clang-cl /O2 /std:c++20). Kept so the measurement can be reproduced.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>
#include "cpp/bench_generated.h"
using namespace fbbench;
constexpr int64_t kF = 705600000, kFpf = 23520000;
std::string layer_id(uint32_t i) { char h[32]; std::snprintf(h, sizeof h, "%x", i); std::string s(h); return "layer-" + std::string(30 - s.size(), '0') + s; }
ValueUnion vec3(double x, double y, double z) { ValueUnion u; VVec3T v; v.v = std::make_unique<Vec3>(x, y, z); u.Set(std::move(v)); return u; }
struct PS { const char* p; const char* n; const char* m; int t; uint32_t d; };
const PS kProps[12] = {{"transform/anchorPoint","Anchor Point","ADBE Anchor Point",6,3},{"transform/position","Position","ADBE Position",6,3},{"transform/scale","Scale","ADBE Scale",6,3},{"transform/orientation","Orientation","ADBE Orientation",6,3},{"transform/xRotation","X Rotation","ADBE Rotate X",3,1},{"transform/yRotation","Y Rotation","ADBE Rotate Y",3,1},{"transform/rotation","Z Rotation","ADBE Rotate Z",3,1},{"transform/opacity","Opacity","ADBE Opacity",3,1},{"material/castsShadows","Casts Shadows","ADBE Casts Shadows",9,1},{"material/acceptsLights","Accepts Lights","ADBE Accept Lights",1,1},{"audio/levels","Audio Levels","ADBE Audio Levels",5,2},{"timeRemap","Time Remap","ADBE Time Remapping",3,1}};
std::unique_ptr<DocumentSnapshotT> make_doc(uint32_t n, bool full) {
  auto d = std::make_unique<DocumentSnapshotT>();
  d->revision = 1; d->project_path = "C:/projects/bench.motion";
  d->settings = std::make_unique<ProjectSettingsT>(); d->settings->working_space = 1; d->settings->audio_sample_rate = 48000;
  auto c = std::make_unique<CompInfoT>(); c->id = "comp-main"; c->settings = std::make_unique<CompSettingsT>();
  auto& cs = *c->settings; cs.name = "Main"; cs.width = 1920; cs.height = 1080; cs.pixel_aspect = 1; cs.fps_num = 30; cs.fps_den = 1; cs.duration = 60*kF; cs.background_a = 1; cs.work_duration = 60*kF; cs.shutter_angle = 180; cs.shutter_phase = -90; cs.samples = 16; cs.adaptive = 128; cs.light_angle = 120; cs.light_altitude = 45;
  for (uint32_t i = 0; i < n; ++i) {
    auto l = std::make_unique<LayerInfoT>();
    l->id = layer_id(i); l->comp = "comp-main"; l->kind = uint8_t(i % 3); l->name = "Layer " + std::to_string(i + 1);
    if (i % 4 == 3) l->parent = layer_id(i - 1);
    if (i % 3 == 2) l->source = "item-image";
    l->switches = std::make_unique<LayerSwitchesT>(); l->switches->visible = true; l->switches->effects_enabled = true; l->switches->motion_blur = i % 5 == 0; l->switches->three_d = i % 7 == 0; l->switches->label = i % 16;
    int64_t in = int64_t(i) * kFpf; l->timing = std::make_unique<LayerTiming>(in, in + 10*kF, in, 1.0, false, 0);
    l->matte = std::make_unique<TrackMatteT>(); l->has_video = true;
    d->layers.push_back(std::move(l)); c->layers.push_back(layer_id(i));
    if (full) {
      auto t = std::make_unique<PropertyTreeT>(); t->layer = layer_id(i);
      for (auto& p : kProps) {
        auto pi = std::make_unique<PropertyInfoT>(); pi->path = p.p; pi->name = p.n; pi->match_name = p.m; pi->vtype = uint8_t(p.t); pi->animatable = true;
        bool pos = std::string(p.p) == "transform/position"; pi->animated = pos; pi->dimensions = p.d; pi->enabled = true;
        if (p.t == 6) pi->value = vec3(i, i*2.0, 0);
        else if (p.t == 5) { VVec2T v; v.v = std::make_unique<Vec2>(0, 0); pi->value.Set(std::move(v)); }
        else if (p.t == 3) { VScalarT v; v.v = 100; pi->value.Set(std::move(v)); }
        else if (p.t == 9) { VChoiceT v; v.v = "off"; pi->value.Set(std::move(v)); pi->choices = {"off","on","only"}; }
        else { VBoolT v; v.v = true; pi->value.Set(std::move(v)); }
        pi->keyframe_count = pos ? 2 : 0; t->nodes.push_back(std::move(pi));
      }
      d->property_trees.push_back(std::move(t));
      auto ks = std::make_unique<KeyframeSetT>(); ks->prop = std::make_unique<PropRefT>(); ks->prop->layer = layer_id(i); ks->prop->path = "transform/position";
      for (int j = 0; j < 2; ++j) { auto k = std::make_unique<KeyframeT>(); k->id = layer_id(i) + "/k" + std::to_string(j); k->time = j*kF; k->value = vec3(i + j*100.0, i, 0); k->easing = 2; k->bezier = std::make_unique<CubicBezier>(0.33, 0, 0.67, 1); ks->keyframes.push_back(std::move(k)); }
      d->keyframes.push_back(std::move(ks));
    }
  }
  d->comps.push_back(std::move(c));
  return d;
}
template <class F> double med(F&& f, int it) { for (int i = 0; i < std::max(3, it/10); ++i) f(); std::vector<double> b; for (int k = 0; k < 7; ++k) { auto t0 = std::chrono::steady_clock::now(); for (int i = 0; i < it; ++i) f(); b.push_back(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count() / it); } std::sort(b.begin(), b.end()); return b[3]; }
void run(const char* name, uint32_t n, bool full, int it) {
  auto d = make_doc(n, full);
  flatbuffers::FlatBufferBuilder fbb; fbb.Finish(DocumentSnapshot::Pack(fbb, d.get()));
  std::vector<uint8_t> bytes(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
  double enc = med([&] { flatbuffers::FlatBufferBuilder b; b.Finish(DocumentSnapshot::Pack(b, d.get())); return b.GetSize(); }, it);
  double ver = med([&] { flatbuffers::Verifier v(bytes.data(), bytes.size()); return v.VerifyBuffer<DocumentSnapshot>(nullptr); }, it);
  double unp = med([&] { auto r = flatbuffers::GetRoot<DocumentSnapshot>(bytes.data())->UnPack(); auto s = r->layers.size(); delete r; return s; }, it);
  double lazy = med([&] { auto r = flatbuffers::GetRoot<DocumentSnapshot>(bytes.data()); size_t a = 0; for (auto l : *r->layers()) a += l->name()->size(); return a; }, it);
  std::printf("  %-34s %9zu B  encode %9.2f us  verify %9.2f us  unpack %9.2f us  lazy-walk %8.2f us\n", name, bytes.size(), enc, ver, unp, lazy);
}
void run_cmd(int it) {
  CommandMsgT m; SetPropertyT sp; sp.prop = std::make_unique<PropRefT>(); sp.prop->layer = layer_id(42); sp.prop->path = "transform/position"; sp.value = vec3(960.5, 540.25, 0); sp.time = 2*kF; m.cmd.Set(std::move(sp));
  flatbuffers::FlatBufferBuilder fbb; fbb.Finish(CommandMsg::Pack(fbb, &m));
  std::vector<uint8_t> bytes(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
  double enc = med([&] { flatbuffers::FlatBufferBuilder b; b.Finish(CommandMsg::Pack(b, &m)); return b.GetSize(); }, it);
  double ver = med([&] { flatbuffers::Verifier v(bytes.data(), bytes.size()); return v.VerifyBuffer<CommandMsg>(nullptr); }, it);
  double unp = med([&] { auto r = flatbuffers::GetRoot<CommandMsg>(bytes.data())->UnPack(); bool ok = r != nullptr; delete r; return ok; }, it);
  std::printf("  %-34s %9zu B  encode %9.2f us  verify %9.2f us  unpack %9.2f us\n", "setProperty (one drag write)", bytes.size(), enc, ver, unp);
}
int main() { std::printf("FlatBuffers 25.12.19 (C++ object API)\n"); run_cmd(200000); run("getDocument 2000 layers, headers", 2000, false, 50); run("getDocument 2000 layers, full", 2000, true, 10); }
