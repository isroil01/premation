// collectFiles (core/collect_files.hpp) and the autoTrace COMMAND
// (Session::auto_trace_in_journal): the collector over FakePorts' in-memory
// files and over a temp directory (FilePorts), the Session's refusals and its
// untouched document; the command's validation, `unsupported` without job
// kinds, and — with a fake autoTrace kind — its result shape and single entry.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>

#include "core/bundle_io.hpp"
#include "core/collect_files.hpp"
#include "core/engine_ctx.hpp"
#include "core/fail.hpp"
#include "core/scene.hpp"
#include "jobs/job_apply_util.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
namespace fs = std::filesystem;
using js::Json;

namespace {

constexpr api::Time kSec = 705'600'000;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    path = fs::temp_directory_path() / ("premation-collect-" + std::to_string(rd()) + "-" +
                                        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directories(path);
  }
  TempDir(const TempDir&) = delete;
  TempDir& operator=(const TempDir&) = delete;
  TempDir(TempDir&&) = delete;
  TempDir& operator=(TempDir&&) = delete;
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
  [[nodiscard]] std::string str(const std::string& rel = {}) const {
    const std::u8string u = (rel.empty() ? path : path / rel).generic_u8string();
    return {u.begin(), u.end()};
  }
};

std::string slurp(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

void spit(const fs::path& p, const std::string& s) {
  fs::create_directories(p.parent_path());
  std::ofstream out(p, std::ios::binary | std::ios::trunc);
  out << s;
}

Json parse(const std::string& s) {
  auto j = js::parse(s);
  REQUIRE(j.has_value());
  return std::move(*j);
}

/// Two layers of footage items: `plate` (a used item with a path), `unused`
/// (an item no layer uses), `gone` (a used item whose file is missing), and a
/// remote `https:` src that travels as it is.
Json sample_doc(const std::string& platePath, const std::string& unusedPath) {
  return parse(std::string(R"({"version":"1.1.0","scene":{"version":"1.0.0","nodes":[)") +
               R"({"id":"comp_root","parent":null,"children":["n1","n2","n3"],"components":[]},)" +
               R"({"id":"n1","parent":"comp_root","children":[],"components":[{"id":"n1_v","type":"video","props":{"assetId":"plate","src":"blob:session/1"}}]},)" +
               R"({"id":"n2","parent":"comp_root","children":[],"components":[{"id":"n2_a","type":"audio","props":{"__assetId":"gone","__src":"blob:session/2"}}]},)" +
               R"({"id":"n3","parent":"comp_root","children":[],"components":[{"id":"n3_i","type":"image","props":{"src":"https://cdn.example/x.png"}}]}]},)" +
               R"("animation":{"tracks":{},"expressions":{}},"comps":{"comp_root":{"id":"comp_root","name":"C"}},)" +
               R"("projectItems":{"folders":[],"footage":{)" +
               R"("plate":{"name":"plate.mp4","type":"video","path":")" + platePath + R"("},)" +
               R"("unused":{"name":"extra.png","type":"image","path":")" + unusedPath + R"("},)" +
               R"("gone":{"name":"voice.wav","type":"audio","path":"/nowhere/voice.wav"}}}})");
}

const Json& props_of(const Json& doc, std::size_t node) {
  return doc.at("scene").at("nodes").arr().at(node).at("components").arr().at(0).at("props");
}

doc::CollectRequest request(Json docJson, const std::string& folder, bool onlyUsed) {
  doc::CollectRequest r;
  r.folder = folder;
  r.onlyUsed = onlyUsed;
  r.doc = std::move(docJson);
  r.unusedItems = {"unused"};
  return r;
}

}  // namespace

// ── the collector ─────────────────────────────────────────────────────────

TEST_CASE("collect: the target is <folder>/<folder name>.motion", "[collect]") {
  CHECK(doc::collect_target("/out/Delivery") == "/out/Delivery/Delivery.motion");
  CHECK(doc::collect_target("/out/Delivery/") == "/out/Delivery/Delivery.motion");
  CHECK(doc::collect_target("C:\\out\\Job") == "C:\\out\\Job\\Job.motion");
  CHECK(doc::collect_target("C:\\") == "C:\\Project.motion");
  CHECK(doc::collect_target("/") == "/Project.motion");
}

TEST_CASE("collect: FakePorts in memory — used files copied, srcs rewritten, missing reported", "[collect]") {
  doc::FakePorts ports;
  ports.add_file("/src/plate.mp4", "PLATE-BYTES");
  ports.add_file("/src/extra.png", "EXTRA-BYTES");
  const doc::CollectOutcome out = ports.collect_files(request(sample_doc("/src/plate.mp4", "/src/extra.png"), "/out/Job", false));
  CHECK(out.path == "/out/Job/Job.motion");
  CHECK(out.collected == 2);
  REQUIRE(out.missing.size() == 1);
  CHECK(out.missing.front().starts_with("voice.wav: "));
  CHECK(out.bytes > 0);

  const Json copy = ports.read_project(out.path);
  const std::string plate = doc::sha256_hex("PLATE-BYTES");
  const std::string extra = doc::sha256_hex("EXTRA-BYTES");
  // The item's path wins over its unreadable session src; the copy names the bundle blob.
  CHECK(props_of(copy, 1).at("src").str() == "motion-blob:" + plate);
  CHECK(props_of(copy, 2).at("__src").str() == "blob:session/2");  // missing: kept as it was
  CHECK(props_of(copy, 3).at("src").str() == "https://cdn.example/x.png");  // travels as it is
  const Json& footage = copy.at("projectItems").at("footage");
  CHECK_FALSE(footage.at("plate").has("path"));   // collected: nothing points outside
  CHECK_FALSE(footage.at("unused").has("path"));  // collected without onlyUsed
  CHECK(footage.at("gone").at("path").str() == "/nowhere/voice.wav");
  REQUIRE(ports.blob(out.path, plate) != nullptr);
  CHECK(*ports.blob(out.path, plate) == "PLATE-BYTES");
  REQUIRE(ports.blob(out.path, extra) != nullptr);

  const Json reg = ports.registry(out.path);
  REQUIRE(reg.at("assets").arr().size() == 2);
  CHECK(reg.at("assets").arr()[0].at("id").str() == "plate");
  CHECK(reg.at("assets").arr()[0].at("hash").str() == plate);
  CHECK(reg.at("assets").arr()[0].at("mime").str() == "video/mp4");
  CHECK(reg.at("assets").arr()[1].at("id").str() == "unused");
}

TEST_CASE("collect: onlyUsed drops the unused items from the copy and leaves their files", "[collect]") {
  doc::FakePorts ports;
  ports.add_file("/src/plate.mp4", "PLATE-BYTES");
  ports.add_file("/src/extra.png", "EXTRA-BYTES");
  const doc::CollectOutcome out = ports.collect_files(request(sample_doc("/src/plate.mp4", "/src/extra.png"), "/out/Job", true));
  CHECK(out.collected == 1);
  const Json copy = ports.read_project(out.path);
  CHECK_FALSE(copy.at("projectItems").at("footage").has("unused"));
  CHECK(copy.at("projectItems").at("footage").has("plate"));
  CHECK(ports.blob(out.path, doc::sha256_hex("EXTRA-BYTES")) == nullptr);
}

TEST_CASE("collect: refuses an empty folder, the open project and a folder inside its bundle", "[collect]") {
  doc::FakePorts ports;
  const Json d = sample_doc("/src/plate.mp4", "/src/extra.png");
  auto code_of = [&ports](doc::CollectRequest r) {
    try {
      (void)ports.collect_files(std::move(r));
    } catch (const doc::EngineFail& f) {
      return f.error.code;
    }
    return api::ErrorCode::internal;
  };
  CHECK(code_of(request(d, "  ", false)) == api::ErrorCode::invalid_argument);
  doc::CollectRequest same = request(d, "/p/Show", false);
  same.projectPath = "/p/Show/Show.motion";
  same.sourceBundle = "/p/Show/Show.motion";
  CHECK(code_of(same) == api::ErrorCode::invalid_argument);
  doc::CollectRequest inside = request(d, "/p/Show.motion/sub", false);
  inside.projectPath = "/p/Show.motion";
  inside.sourceBundle = "/p/Show.motion";
  CHECK(code_of(inside) == api::ErrorCode::invalid_argument);
  // A plain project file already at the target is not overwritten.
  (void)ports.write_project("/q/Out/Out.motion", Json::object());
  CHECK(code_of(request(d, "/q/Out", false)) == api::ErrorCode::io);
}

TEST_CASE("collect: on disk — a bundle that opens, footage from the source bundle and outside files", "[collect]") {
  TempDir tmp;
  spit(tmp.path / "media" / "plate.mp4", "PLATE-BYTES");
  // The source project is a bundle whose footage is `motion-blob:` (the extra item points into it).
  const std::string blobBytes = "BUNDLE-BLOB";
  const std::string blobHash = doc::sha256_hex(blobBytes);
  const fs::path source = tmp.path / "Show.motion";
  spit(source / "blobs" / blobHash.substr(0, 2) / blobHash, blobBytes);
  Json d = sample_doc(tmp.str("media/plate.mp4"), "motion-blob:" + blobHash);
  doc::CollectRequest req = request(std::move(d), tmp.str("Delivery"), false);
  req.sourceBundle = tmp.str("Show.motion");
  req.projectPath = tmp.str("Show.motion");

  doc::FilePorts ports;
  const doc::CollectOutcome out = ports.collect_files(std::move(req));
  CHECK(out.path == tmp.str("Delivery") + "/Delivery.motion");
  CHECK(out.collected == 2);
  CHECK(out.missing.size() == 1);
  const fs::path bundle = tmp.path / "Delivery" / "Delivery.motion";
  REQUIRE(doc::is_bundle_dir(bundle));
  const std::string plate = doc::sha256_hex("PLATE-BYTES");
  CHECK(slurp(bundle / "blobs" / plate.substr(0, 2) / plate) == "PLATE-BYTES");
  CHECK(slurp(bundle / "blobs" / blobHash.substr(0, 2) / blobHash) == blobBytes);
  const Json reg = parse(slurp(bundle / "assets" / "registry.json"));
  CHECK(reg.at("assets").arr().size() == 2);
  // It reads back as a project; the source bundle got nothing written.
  const Json back = ports.read_project(out.path);
  CHECK(props_of(back, 1).at("src").str() == "motion-blob:" + plate);
  CHECK_FALSE(fs::exists(source / "manifest.json"));
  CHECK(out.bytes >= std::string("PLATE-BYTES").size() + blobBytes.size());

  // Again into the same folder: the existing bundle is updated, not refused.
  doc::CollectRequest again = request(sample_doc(tmp.str("media/plate.mp4"), "/none.png"), tmp.str("Delivery"), false);
  CHECK_NOTHROW((void)ports.collect_files(std::move(again)));
  // A plain file in the way is refused.
  spit(tmp.path / "Blocked" / "Blocked.motion", "not a bundle");
  CHECK_THROWS_AS((void)ports.collect_files(request(sample_doc("/a", "/b"), tmp.str("Blocked"), false)), doc::EngineFail);
}

// ── collectFiles through the Session ────────────────────────────────────────

namespace {

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Test";
  c.settings.width = 640;
  c.settings.height = 360;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

std::size_t history_len(Harness& h) {
  const auto r = h.ask(qry(api::GetHistory{}));
  return std::get<api::HistoryState>(std::get<api::QueryResult>(r.outcome.v).v).entries.size();
}

template <class E>
std::size_t count_events(Harness& h, std::size_t mark) {
  std::size_t n = 0;
  for (const auto& b : h.batches_since(mark)) {
    for (const auto& e : b.events) n += std::holds_alternative<E>(e.v) ? 1 : 0;
  }
  return n;
}

}  // namespace

TEST_CASE("collectFiles: the session collects a copy and the document is unchanged", "[collect][session]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  api::ImportFiles imp;
  imp.files = {api::ImportFile{"C:/m/clip.mp4", false, {}, {}, false}, api::ImportFile{"C:/m/spare.png", false, {}, {}, false}};
  const auto items = result_as<api::ItemList>(h.run(cmd(imp))).items;
  REQUIRE(items.size() == 2);
  api::CreateLayer c;
  c.comp = comp;
  c.kind = api::LayerKind::video;
  c.source = items.at(0);
  REQUIRE(is_ok(h.run(cmd(c))));

  const std::size_t entries = history_len(h);
  const std::size_t mark = h.messages.size();
  const auto r = h.run(cmd(api::CollectFiles{"C:/out/Pack", true}));
  REQUIRE(is_ok(r));
  const auto res = result_as<api::SaveProjectResult>(r);
  CHECK(res.path == "C:/out/Pack/Pack.motion");
  CHECK(res.bytes > 0);
  CHECK_FALSE(res.missing.has_value());
  // Not a save: no history, no projectSaved, no dirty change.
  CHECK(history_len(h) == entries);
  CHECK(count_events<api::ProjectSavedEvent>(h, mark) == 0);
  CHECK(count_events<api::DirtyChangedEvent>(h, mark) == 0);
  // The collected copy opens (FakePorts keeps it like a written project).
  CHECK(is_ok(h.run(cmd(api::OpenProject{"C:/out/Pack/Pack.motion"}))));

  CHECK(is_error(h.run(cmd(api::CollectFiles{"", false})), api::ErrorCode::invalid_argument));
}

// ── the autoTrace command ───────────────────────────────────────────────────

namespace {

/// Writes two masks (an outer ring and a hole) on the traced layer, as the job's result does.
class TwoMasks final : public jobs::JobResult {
 public:
  TwoMasks(std::string layer, bool nothing) : layer_(std::move(layer)), nothing_(nothing) {}
  [[nodiscard]] std::string summary_json() const override { return R"({"pathsAdded":2})"; }
  [[nodiscard]] std::string label() const override { return "Auto-trace"; }
  [[nodiscard]] bool has_edits() const override { return !nothing_; }
  void apply(jobs::JobApply& a) const override {
    for (int i = 0; i < 2; ++i) {
      api::AddMask m;
      m.layer = layer_;
      m.path.closed = true;
      m.path.vertices = {0, 0, 10, 0, 10, 10};
      m.path.in_tangents.assign(6, 0.0);
      m.path.out_tangents.assign(6, 0.0);
      m.mode = i == 0 ? api::MaskMode::add : api::MaskMode::subtract;
      (void)a.run(jobs::command(std::move(m)));
    }
  }

 private:
  std::string layer_;
  bool nothing_;
};

struct FakeTraceKinds final : jobs::JobKinds {
  std::optional<api::AutoTraceJob> seen;
  bool traceNothing = false;
  jobs::PreparedJob prepare(const api::JobSpec& spec, const jobs::JobDocContext& ctx) override {
    const auto* s = std::get_if<api::AutoTraceJob>(&spec.v);
    if (s == nullptr) doc::fail(api::ErrorCode::unsupported, "fake: autoTrace only");
    if (ctx.doc.node(s->layer) == nullptr) doc::fail(api::ErrorCode::not_found, "no layer");
    seen = *s;
    const std::string layer = s->layer;
    const bool nothing = traceNothing;
    return jobs::PreparedJob{"autoTrace", [layer, nothing](jobs::JobControl&) -> std::unique_ptr<jobs::JobResult> {
                               return std::make_unique<TwoMasks>(layer, nothing);
                             }};
  }
};

api::AutoTrace trace_cmd(const api::LayerId& layer) {
  api::AutoTrace t;
  t.layer = layer;
  t.range = api::TimeRange{0, kSec / 30};
  t.channel = "alpha";
  t.threshold = 0.5;
  t.tolerance = 1.5;
  return t;
}

api::LayerId make_solid(Harness& h, const api::ItemId& comp) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = api::LayerKind::solid;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

}  // namespace

TEST_CASE("autoTrace: arguments are validated before anything runs", "[autotrace]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_solid(h, comp);
  auto with = [&](auto&& edit) {
    api::AutoTrace t = trace_cmd(layer);
    edit(t);
    return h.run(cmd(t));
  };
  CHECK(is_error(with([](api::AutoTrace& t) { t.layer = "nope"; }), api::ErrorCode::not_found));
  CHECK(is_error(with([](api::AutoTrace& t) { t.channel = "hue"; }), api::ErrorCode::invalid_argument));
  CHECK(is_error(with([](api::AutoTrace& t) { t.threshold = 1.5; }), api::ErrorCode::out_of_range));
  CHECK(is_error(with([](api::AutoTrace& t) { t.threshold = -0.1; }), api::ErrorCode::out_of_range));
  CHECK(is_error(with([](api::AutoTrace& t) { t.tolerance = -1; }), api::ErrorCode::out_of_range));
  CHECK(is_error(with([](api::AutoTrace& t) { t.range.duration = 0; }), api::ErrorCode::invalid_argument));
  // Valid arguments, no job kinds (a headless / no-decode build): unsupported, nothing written.
  const std::size_t entries = history_len(h);
  CHECK(is_error(h.run(cmd(trace_cmd(layer))), api::ErrorCode::unsupported));
  CHECK(history_len(h) == entries);
}

TEST_CASE("autoTrace: the job's masks, one undo entry, their groups answered", "[autotrace]") {
  Harness h;
  FakeTraceKinds kinds;
  h.session.set_job_kinds(&kinds);
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_solid(h, comp);
  const std::size_t entries = history_len(h);

  api::AutoTrace one = trace_cmd(layer);
  one.channel = "luma";
  const auto r = h.run(cmd(one));
  REQUIRE(is_ok(r));
  const auto groups = result_as<api::GroupList>(r).groups;
  REQUIRE(groups.size() == 2);
  CHECK(groups[0].starts_with("masks/"));
  CHECK(groups[0] != groups[1]);
  CHECK(history_len(h) == entries + 1);
  REQUIRE(kinds.seen.has_value());
  CHECK(kinds.seen->every_frame);  // the range decides: one frame traces unkeyed
  CHECK(kinds.seen->channel == "luma");
  CHECK(kinds.seen->threshold == 0.5);
  CHECK(kinds.seen->tolerance == std::optional<double>(1.5));
  const auto undo = h.run(cmd(api::Undo{}));
  REQUIRE(is_ok(undo));
  CHECK(result_as<api::HistoryStep>(undo).label == "Auto-trace");

  // Nothing traced: no masks, no entry.
  kinds.traceNothing = true;
  const std::size_t before = history_len(h);
  const auto none = h.run(cmd(trace_cmd(layer)));
  REQUIRE(is_ok(none));
  CHECK(result_as<api::GroupList>(none).groups.empty());
  CHECK(history_len(h) == before);
}

// ── footage import on disk (FilePorts): session bytes become files ──────────

TEST_CASE("FilePorts imports files by path and bytes as content-addressed cache files", "[collect][import]") {
  TempDir tmp;
  spit(tmp.path / "media" / "plate.mp4", "MP4-BYTES");
  doc::FilePorts ports;
  ports.set_footage_dir(tmp.str("cache"));
  int probes = 0;
  ports.set_probe([&probes](const std::string&) {
    ++probes;
    Json md = Json::object();
    md.set("width", Json::number(64));
    return md;
  });
  REQUIRE(ports.has_import());

  api::ImportFile f;
  f.path = tmp.str("media/plate.mp4");
  const Json byPath = ports.import_file(f, "item_1");
  CHECK(byPath.at("src").str() == f.path);
  CHECK(byPath.at("path").str() == f.path);
  CHECK(byPath.at("type").str() == "video");
  CHECK(byPath.at("size").num() == 9);
  CHECK(byPath.at("metadata").at("width").num() == 64);

  // A session blob's bytes: written once under their hash, never a blob: src.
  api::ImportBytesFile b;
  b.name = "Sky.PNG";
  const std::string png = "PNG-BYTES";
  b.data.assign(png.begin(), png.end());
  const Json byBytes = ports.import_bytes(b, "item_2");
  const std::string cached = tmp.str("cache/" + doc::sha256_hex(png) + ".png");
  CHECK(byBytes.at("src").str() == cached);
  CHECK(byBytes.at("path").str() == cached);
  CHECK(byBytes.at("type").str() == "image");
  CHECK(slurp(fs::path(std::u8string(cached.begin(), cached.end()))) == png);
  b.origin_path = tmp.str("media/Sky.PNG");
  const Json again = ports.import_bytes(b, "item_3");
  CHECK(again.at("src").str() == cached);
  CHECK(again.at("path").str() == *b.origin_path);
  CHECK(probes == 3);

  // Not a file, or a session URL: refused, nothing recorded.
  f.path = tmp.str("media/missing.mp4");
  CHECK_THROWS_AS(ports.import_file(f, "item_4"), doc::EngineFail);
  f.path = "blob:file:///abc";
  CHECK_THROWS_AS(ports.import_file(f, "item_5"), doc::EngineFail);
}

TEST_CASE("an asset's media is its file when src is a session URL", "[collect][import]") {
  Json a = Json::object();
  a.set("src", Json::string("blob:file:///1234"));
  CHECK(doc::asset_media_src(a) == "blob:file:///1234");  // nothing better known
  a.set("path", Json::string("C:/cache/abc.mp4"));
  CHECK(doc::asset_media_src(a) == "C:/cache/abc.mp4");
  a.set("src", Json::string("https://cdn.example/a.mp4"));
  CHECK(doc::asset_media_src(a) == "C:/cache/abc.mp4");
  a.set("src", Json::string("D:/footage/a.mp4"));
  CHECK(doc::asset_media_src(a) == "D:/footage/a.mp4");  // a readable src wins
  a.set("src", Json::string(""));
  CHECK(doc::asset_media_src(a) == "C:/cache/abc.mp4");
}
