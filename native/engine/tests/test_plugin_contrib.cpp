// P7 — plugins that are not effects (docs/PLUGIN_SDK.md "Commands",
// "Importers", "Output modules", "Panels"), through the real protocol where
// the editor uses them: the samples distribute (a command), ppmio (an
// importer), ppmseq (an output module) and statspanel (a panel + a command).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "api_json.hpp"
#include "audio/external_audio.hpp"
#include "contrib.hpp"
#include "host.hpp"
#include "manifest.hpp"
#include "media_input.hpp"
#include "native_contrib.hpp"
#include "native_effects.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
namespace pl = premation::plugins;
namespace fs = std::filesystem;

namespace {

constexpr const char* kDistribute = "com.premation.samples.distribute";
constexpr const char* kPpmio = "com.premation.samples.ppmio";
constexpr const char* kPpmseq = "com.premation.samples.ppmseq";
constexpr const char* kStats = "com.premation.samples.statspanel";

pl::HostOptions attached() {
  pl::HostOptions o;
  o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES)};
  o.threads = 2;
  o.attachToDocument = true;
  return o;
}

template <class T>
T query(Harness& h, api::Query q) {
  const auto r = h.ask(std::move(q));
  REQUIRE(is_ok(r));
  return result_as<T>(std::get<api::QueryResult>(r.outcome.v));
}

api::ItemId comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Contrib";
  c.settings.width = 320;
  c.settings.height = 180;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 705'600'000LL * 2;
  const auto rc = h.run(cmd(c));
  REQUIRE(is_ok(rc));
  return result_item(rc);
}

api::LayerId solid_at(Harness& h, const api::ItemId& c, double x, double y) {
  api::CreateLayer l;
  l.comp = c;
  l.kind = api::LayerKind::solid;
  const auto rl = h.run(cmd(l));
  REQUIRE(is_ok(rl));
  const api::LayerId id = result_layer(rl);
  api::SetProperty sp;
  sp.prop = {id, "transform/position"};
  sp.value = vec2(x, y);
  REQUIRE(is_ok(h.run(cmd(sp))));
  return id;
}

api::Vec2 position(Harness& h, const api::LayerId& layer) {
  api::GetPropertyValues q;
  q.props = {{layer, "transform/position"}};
  q.time = 0;
  const auto v = query<api::PropertyValues>(h, qry(q));
  REQUIRE(v.values.size() == 1);
  return std::get<api::Vec2>(v.values[0].value.v);
}

std::vector<api::PluginCommandInfo> commands(Harness& h) { return query<api::PluginCommandList>(h, qry(api::ListPluginCommands{})).commands; }

const api::PluginCommandInfo* find_command(const std::vector<api::PluginCommandInfo>& list, std::string_view plugin, std::string_view id) {
  const auto it = std::ranges::find_if(list, [&](const api::PluginCommandInfo& c) { return c.plugin == plugin && c.id == id; });
  return it == list.end() ? nullptr : &*it;
}

fs::path temp_dir(const std::string& name) {
  const fs::path d = fs::temp_directory_path() / ("premation-contrib-" + name);
  std::error_code ec;
  fs::remove_all(d, ec);
  fs::create_directories(d);
  return d;
}

/// A w × h P6 PPM whose pixel (x, y) is (x * 10, y * 10, 200).
void write_ppm(const fs::path& p, int w, int h) {
  std::ofstream f(p, std::ios::binary);
  f << "P6\n" << w << " " << h << "\n255\n";
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) f << static_cast<char>(x * 10) << static_cast<char>(y * 10) << static_cast<char>(200);
  }
}

/// A w × h little-endian PF (colour) PFM, every pixel (0.25, 2.0, 0.5): bottom-up rows.
void write_pfm(const fs::path& p, int w, int h) {
  std::ofstream f(p, std::ios::binary);
  f << "PF\n" << w << " " << h << "\n-1.0\n";
  const float px[3] = {0.25F, 2.0F, 0.5F};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
  for (int i = 0; i < w * h; ++i) f.write(reinterpret_cast<const char*>(px), sizeof px);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

/// A moving PPM (P6 images back to back, ppmio's moving footage): frame k is w x h of (k * 40, 0, 0),
/// at the rate a `# fps` comment names.
void write_moving_ppm(const fs::path& p, int w, int h, int frames, int fps) {
  std::ofstream f(p, std::ios::binary);
  for (int k = 0; k < frames; ++k) {
    f << "P6\n";
    if (k == 0) f << "# fps " << fps << "\n";
    f << w << " " << h << "\n255\n";
    for (int i = 0; i < w * h; ++i) f << static_cast<char>(k * 40) << static_cast<char>(0) << static_cast<char>(0);
  }
}

/// A .praw (ppmio's sound-only format): `PRAW <rate> <channels>` + interleaved float32 LE.
void write_praw(const fs::path& p, int rate, const std::vector<std::vector<float>>& planes) {
  std::ofstream f(p, std::ios::binary);
  f << "PRAW " << rate << " " << planes.size() << "\n";
  for (std::size_t i = 0; i < planes.front().size(); ++i) {
    for (const auto& ch : planes) f.write(reinterpret_cast<const char*>(&ch[i]), sizeof(float));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  }
}

std::string slurp(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}

std::string utf8(const fs::path& p) {
  const std::u8string u = p.u8string();
  return {u.begin(), u.end()};
}

}  // namespace

TEST_CASE("P7 manifest: commands, importers, output modules, panels", "[plugins][contrib]") {
  std::string err;
  const auto m = pl::parse_manifest(R"({
    "manifestVersion": 1, "id": "com.example.tools", "sdk": {"major": 1, "minor": 2},
    "binary": {"windows": "t.dll", "macos": "libt.dylib", "linux": "libt.so"},
    "commands": [{"id": "align", "name": "Align", "menu": "Arrange"}],
    "importers": [{"id": "img", "extensions": [".PPM", "pfm", "ppm"]}],
    "outputModules": [{"id": "seq", "name": "Seq", "extension": "ppm",
      "options": [{"id": "depth", "type": "popup", "choices": ["8", "16"], "default": 7},
                  {"id": "q", "type": "number", "default": 3, "min": 1, "max": 9},
                  {"id": "on", "type": "checkbox", "default": true}]}],
    "panels": [{"id": "p", "name": "Panel", "page": "panels/p.html"}]
  })", "windows", err);
  REQUIRE(m);
  CHECK(m->effects.empty());
  REQUIRE(m->commands.size() == 1);
  CHECK(m->commands[0].menu == "Arrange");
  REQUIRE(m->importers.size() == 1);
  CHECK(m->importers[0].extensions == std::vector<std::string>{"ppm", "pfm"});
  REQUIRE(m->outputModules.size() == 1);
  CHECK(m->outputModules[0].options.at(0).def == 2);  // a popup default clamps to its choices
  CHECK(m->outputModules[0].options.at(2).def == 1);
  CHECK(m->panels.at(0).page == "panels/p.html");

  const auto bad = [&](const char* body) {
    std::string e;
    const std::string json = std::string(R"({"manifestVersion": 1, "id": "com.example.tools", "sdk": {"major": 1, "minor": 2},
      "binary": {"windows": "t.dll"}, )") + body + "}";
    return !pl::parse_manifest(json, "windows", e) && !e.empty();
  };
  CHECK(bad(R"("commands": [{"name": "no id"}])"));
  CHECK(bad(R"("commands": [{"id": "a"}, {"id": "a"}])"));
  CHECK(bad(R"("importers": [{"id": "i", "extensions": []}])"));
  CHECK(bad(R"("importers": [{"id": "i", "extensions": ["p/m"]}])"));
  CHECK(bad(R"("outputModules": [{"id": "o"}])"));
  CHECK(bad(R"("outputModules": [{"id": "o", "extension": "x", "options": [{"id": "a", "type": "slider"}]}])"));
  CHECK(bad(R"("panels": [{"id": "p", "page": "../escape.html"}])"));
  CHECK(bad(R"("effects": [])"));  // nothing at all
}

TEST_CASE("P7a the engine API as JSON", "[plugins][contrib]") {
  std::string err;
  const auto c = pl::command_from_json(
      R"({"type":"setProperty","prop":{"layer":"l1","path":"transform/position"},"value":{"kind":"vec2","value":{"x":3,"y":4}},"time":0})", err);
  REQUIRE(c);
  const auto* sp = std::get_if<api::SetProperty>(&c->v);
  REQUIRE(sp != nullptr);
  CHECK(sp->prop.layer == "l1");
  CHECK(std::get<api::Vec2>(sp->value.v) == api::Vec2{3, 4});
  CHECK(sp->time == 0);
  CHECK_FALSE(pl::command_from_json(R"({"type":"noSuchCommand"})", err));
  CHECK_FALSE(pl::command_from_json(R"({"type":"setProperty","prop":{"layer":7}})", err));
  CHECK(err.find("layer") != std::string::npos);
  CHECK_FALSE(pl::command_from_json("not json", err));
  const auto q = pl::query_from_json(R"({"type":"getComposition","comp":"comp_root"})", err);
  REQUIRE(q);
  CHECK(std::get<api::GetComposition>(q->v).comp == "comp_root");
  api::EngineError e;
  e.code = api::ErrorCode::not_found;
  e.message = "gone";
  CHECK(pl::to_json(e) == R"({"code":"notFound","message":"gone"})");
}

TEST_CASE("P7a commands: list, run, one undo entry, the log, crash isolation", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  Harness h;
  (void)h.hello();

  // listPluginCommands and listPlugins carry them.
  auto list = commands(h);
  const auto* dist = find_command(list, kDistribute, "distribute");
  REQUIRE(dist != nullptr);
  CHECK(dist->name == "Distribute Layers");
  CHECK(dist->menu == "Arrange");
  CHECK(dist->enabled);
  const auto plugins = query<api::PluginList>(h, qry(api::ListPlugins{})).plugins;
  const auto pi = std::ranges::find_if(plugins, [](const api::PluginInfo& p) { return p.id == kDistribute; });
  REQUIRE(pi != plugins.end());
  CHECK(pi->status == api::PluginStatus::loaded);
  CHECK(pi->effects.empty());
  REQUIRE(pi->commands.size() == 1);

  const api::ItemId c = comp(h);
  const api::LayerId a = solid_at(h, c, 10, 50);
  const api::LayerId b = solid_at(h, c, 200, 60);
  const api::LayerId d = solid_at(h, c, 100, 70);
  const auto before = query<api::HistoryState>(h, qry(api::GetHistory{}));

  api::RunPluginCommand run;
  run.plugin = kDistribute;
  run.command = "distribute";
  run.comp = c;
  run.layers = {a, b, d};
  run.time = 0;
  const std::size_t sent = h.messages.size();
  const auto r = h.run(cmd(run));
  REQUIRE(is_ok(r));
  const auto res = result_as<api::PluginCommandResult>(r);
  CHECK(res.edits == 1);  // only the middle layer moves
  CHECK(res.message == "distributed 3 layers");
  CHECK(position(h, d) == api::Vec2{105, 70});  // halfway between 10 and 200, y kept
  CHECK(position(h, a) == api::Vec2{10, 50});
  // ONE history entry with the command's name.
  const auto after = query<api::HistoryState>(h, qry(api::GetHistory{}));
  REQUIRE(after.position == before.position + 1);
  CHECK(after.entries.at(after.position - 1).label == "Distribute Layers");
  // The command log holds the plugin's edits (a replay never runs the plugin).
  bool logged = false;
  for (std::size_t i = sent; i < h.messages.size(); ++i) {
    if (h.messages[i].kind() != api::EngineMessage::Kind::log_record) continue;
    const auto& rec = std::get<api::LogRecord>(h.messages[i].v);
    REQUIRE(rec.request.body.kind() == api::RequestBody::Kind::batch);
    const auto& batch = std::get<api::CommandBatch>(rec.request.body.v);
    CHECK(batch.label == "Distribute Layers");
    REQUIRE(batch.commands.size() == 1);
    CHECK(batch.commands[0].kind() == api::Command::Kind::set_property);
    CHECK(rec.job.value_or("").starts_with("plugin:"));
    logged = true;
  }
  CHECK(logged);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(position(h, d) == api::Vec2{100, 70});
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  CHECK(position(h, d) == api::Vec2{105, 70});
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));

  // The plugin's own error: nothing changes, an internal error with its message.
  run.layers = {a, b};
  const auto few = h.run(cmd(run));
  REQUIRE(is_error(few, api::ErrorCode::internal));
  CHECK(std::get<api::EngineError>(few.outcome.v).message.find("three or more") != std::string::npos);

  // A crash after a first edit: rolled back, the command disabled, the engine fine.
  const api::LayerId e = solid_at(h, c, 150, 80);
  run.layers = {a, b, d, e};
  run.args = R"({"fault":"access_violation"})";
  const auto histBefore = query<api::HistoryState>(h, qry(api::GetHistory{}));
  const auto crashed = h.run(cmd(run));
  REQUIRE(is_error(crashed, api::ErrorCode::internal));
  CHECK(std::get<api::EngineError>(crashed.outcome.v).message.find("crashed") != std::string::npos);
  CHECK(position(h, d) == api::Vec2{100, 70});  // the first edit rolled back
  CHECK(query<api::HistoryState>(h, qry(api::GetHistory{})).position == histBefore.position);
  list = commands(h);
  REQUIRE(find_command(list, kDistribute, "distribute") != nullptr);
  CHECK_FALSE(find_command(list, kDistribute, "distribute")->enabled);
  run.args.reset();
  CHECK(is_error(h.run(cmd(run)), api::ErrorCode::not_found));
  // Re-enabling the plugin re-arms it.
  api::SetPluginEnabled on;
  on.plugin = kDistribute;
  on.enabled = true;
  REQUIRE(is_ok(h.run(cmd(on))));
  CHECK(find_command(commands(h), kDistribute, "distribute")->enabled);
  CHECK(is_ok(h.run(cmd(run))));

  // A disabled plugin's command is listed off and does not run.
  api::SetPluginEnabled off;
  off.plugin = kDistribute;
  off.enabled = false;
  REQUIRE(is_ok(h.run(cmd(off))));
  CHECK_FALSE(find_command(commands(h), kDistribute, "distribute")->enabled);
  CHECK(is_error(h.run(cmd(run)), api::ErrorCode::not_found));
  REQUIRE(is_ok(h.run(cmd(on))));

  // Another plugin's command (statspanel's Number Layers) and unknown ones.
  api::RunPluginCommand number;
  number.plugin = kStats;
  number.command = "number";
  number.layers = {a, b};
  number.args = R"({"prefix":"Shot"})";
  REQUIRE(is_ok(h.run(cmd(number))));
  api::GetLayers gl;
  gl.layers = {a, b};
  const auto names = query<api::LayerDetails>(h, qry(gl));
  CHECK(names.layers.at(0).name == "Shot 1");
  CHECK(names.layers.at(1).name == "Shot 2");
  number.command = "nope";
  CHECK(is_error(h.run(cmd(number)), api::ErrorCode::not_found));
}

TEST_CASE("P7b importers: .ppm / .pfm footage through the plugin, failures isolated", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  const fs::path dir = temp_dir("import");
  write_ppm(dir / "grad.ppm", 4, 3);
  write_pfm(dir / "hdr.pfm", 2, 2);
  write_ppm(dir / "crash.ppm", 2, 2);

  CHECK(doc::NativeImporters::claims(utf8(dir / "grad.ppm")));
  CHECK(doc::NativeImporters::claims("X:/A.PFM"));
  CHECK_FALSE(doc::NativeImporters::claims("x.png"));

  // importFiles: the plugin's PROBE is the item's facts.
  Harness h;
  (void)h.hello();
  api::ImportFiles imp;
  imp.files.push_back(api::ImportFile{utf8(dir / "grad.ppm"), false, std::nullopt, std::nullopt, false, std::nullopt});
  const auto ri = h.run(cmd(imp));
  REQUIRE(is_ok(ri));
  api::GetItems gi;
  gi.items = result_as<api::ItemList>(ri).items;
  const auto items = query<api::ItemDetails>(h, qry(gi));
  REQUIRE(items.items.size() == 1);
  CHECK(items.items[0].width == 4);
  CHECK(items.items[0].height == 3);
  CHECK(items.items[0].codec == "PPM");

  // READ_FRAME: straight RGBA float, as the texture feed takes it.
  doc::NativeImage img;
  std::string err;
  REQUIRE(doc::NativeImporters::read_frame(utf8(dir / "grad.ppm"), 0, img, err));
  REQUIRE(img.width == 4);
  REQUIRE(img.height == 3);
  CHECK_FALSE(img.linear);
  const auto px = [&](std::uint32_t x, std::uint32_t y, int c) { return img.rgba.at((y * img.width + x) * 4 + static_cast<std::uint32_t>(c)); };
  CHECK(std::fabs(px(3, 2, 0) - 30.0F / 255) < 1e-6F);
  CHECK(std::fabs(px(3, 2, 1) - 20.0F / 255) < 1e-6F);
  CHECK(px(1, 1, 3) == 1.0F);
  REQUIRE(doc::NativeImporters::read_frame(utf8(dir / "hdr.pfm"), 0, img, err));
  CHECK(img.linear);
  CHECK(img.rgba.at(1) == 2.0F);  // over-range kept (scene-linear)

  // A file the plugin refuses: io with its message.
  write_ppm(dir / "broken.ppm", 2, 2);
  imp.files[0].path = utf8(dir / "broken.ppm");
  const auto rb = h.run(cmd(imp));
  REQUIRE(is_error(rb, api::ErrorCode::io));
  CHECK(std::get<api::EngineError>(rb.outcome.v).message.find("plugin failed to read") != std::string::npos);

  // A crash in READ_FRAME fails that read; the importer is then off for the session
  // (every read fails with why), the engine carries on.
  CHECK_FALSE(doc::NativeImporters::read_frame(utf8(dir / "crash.ppm"), 0, img, err));
  CHECK(err.find("crashed") != std::string::npos);
  CHECK_FALSE(doc::NativeImporters::read_frame(utf8(dir / "grad.ppm"), 0, img, err));
  // A child job's plugin set lists it disabled meanwhile (engine_process.cpp, child_job.hpp).
  CHECK(host.contrib().importers_off().contains(kPpmio));
  // setPluginEnabled(true) re-arms it.
  REQUIRE(host.set_enabled(kPpmio, true));
  host.contrib().reset(kPpmio);
  CHECK(host.contrib().importers_off().empty());
  CHECK(doc::NativeImporters::read_frame(utf8(dir / "grad.ppm"), 0, img, err));

  // A failure recorded by the texture feed is what layerErrors shows for the footage.
  doc::NativeImporters::set_failure("crash.ppm", "plugin failed to read 'crash.ppm': crashed");
  CHECK(doc::NativeImporters::failure("crash.ppm").has_value());
  doc::NativeImporters::clear_failure("crash.ppm");
}

TEST_CASE("P7c output modules: a .ppm sequence, options, failures", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  const fs::path dir = temp_dir("export");
  const std::string format = std::string("plugin:") + kPpmseq + "/ppmseq";

  // Options: declared defaults under the user's values, clamped.
  CHECK(host.contrib().output_options(format, R"({"digits": 40})") == R"({"depth":1,"digits":9,"fault":1})");

  std::string err;
  auto job = host.contrib().output_job(format, err);
  REQUIRE(job);
  pl::OutputParams p;
  p.path = utf8(dir / "shot.ppm");
  p.width = 2;
  p.height = 1;
  p.frameCount = 3;
  p.optionsJson = host.contrib().output_options(format, R"({"digits": 3})");
  REQUIRE(job->begin(p, err));
  const std::vector<float> frame = {1, 0, 0, 1, 0, 0.5F, 1, 1};
  for (int i = 0; i < 3; ++i) REQUIRE(job->write_frame(i, 0, frame.data(), err));
  REQUIRE(job->finish(false, err));
  const std::string ppm = slurp(dir / "shot_002.ppm");
  CHECK(ppm == std::string("P6\n2 1\n255\n") + std::string("\xff\x00\x00\x00\x80\xff", 6));

  // A crash on frame 2 fails the job with why; nothing else is affected.
  job = host.contrib().output_job(format, err);
  REQUIRE(job);
  p.optionsJson = host.contrib().output_options(format, R"({"fault": 2})");
  REQUIRE(job->begin(p, err));
  REQUIRE(job->write_frame(0, 0, frame.data(), err));
  REQUIRE(job->write_frame(1, 0, frame.data(), err));
  CHECK_FALSE(job->write_frame(2, 0, frame.data(), err));
  CHECK(err.find("crashed") != std::string::npos);
  job.reset();
  // An unknown module and a disabled plugin.
  CHECK_FALSE(host.contrib().output_job("plugin:com.example.nope/x", err));
  REQUIRE(host.set_enabled(kPpmseq, false));
  CHECK_FALSE(host.contrib().output_job(format, err));
  REQUIRE(host.set_enabled(kPpmseq, true));
  CHECK(host.contrib().output_job(format, err));

  // The export's frame bytes → the module's floats.
  std::vector<float> f;
  pl::export_frame_to_float(std::vector<std::uint8_t>{255, 0, 51, 255}, 8, f);
  CHECK(f == std::vector<float>{1, 0, 0.2F, 1});
}

TEST_CASE("P7d panels are listed from the manifest", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  const auto infos = host.plugin_infos();
  const auto it = std::ranges::find_if(infos, [](const api::PluginInfo& p) { return p.id == kStats; });
  REQUIRE(it != infos.end());
  REQUIRE(it->panels.size() == 1);
  CHECK(it->panels[0].id == "stats");
  CHECK(it->panels[0].page == "stats.html");
  CHECK(it->commands.size() == 1);
  const auto io = std::ranges::find_if(infos, [](const api::PluginInfo& p) { return p.id == kPpmio; });
  REQUIRE(io != infos.end());
  REQUIRE(io->importers.size() == 2);
  CHECK(io->importers[0].extensions == std::vector<std::string>{"ppm", "pfm"});
  CHECK(io->importers[1].extensions == std::vector<std::string>{"praw"});
  const auto seq = std::ranges::find_if(infos, [](const api::PluginInfo& p) { return p.id == kPpmseq; });
  REQUIRE(seq != infos.end());
  REQUIRE(seq->output_modules.size() == 1);
  CHECK(seq->output_modules[0].options.size() == 3);
}

TEST_CASE("P7b moving plugin footage reaches the analysis jobs (open_frames)", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  const fs::path dir = temp_dir("jobs");
  write_moving_ppm(dir / "move.ppm", 8, 4, 5, 10);

  // importFiles: moving footage, 5 frames at 10 fps.
  Harness h;
  (void)h.hello();
  api::ImportFiles imp;
  imp.files.push_back(api::ImportFile{utf8(dir / "move.ppm"), false, std::nullopt, std::nullopt, false, std::nullopt});
  const auto ri = h.run(cmd(imp));
  REQUIRE(is_ok(ri));
  api::GetItems gi;
  gi.items = result_as<api::ItemList>(ri).items;
  const auto items = query<api::ItemDetails>(h, qry(gi));
  REQUIRE(items.items.size() == 1);
  CHECK(items.items[0].media_type == api::MediaType::video);
  CHECK(items.items[0].width == 8);

  // What every analysis job (tracker, stabilizer, scene detection, ...) reads: frames through the importer.
  std::string err;
  auto src = jobs::open_plugin_frames(utf8(dir / "move.ppm"), 0, err);
  REQUIRE(src);
  CHECK(err.empty());
  CHECK(src->fps() == 10);
  CHECK(src->frame_count() == 5);
  CHECK(src->source_width() == 8);
  jobs::RgbaImage img;
  for (std::int64_t k = 0; k < 5; ++k) {
    REQUIRE(src->read(k, img, err));
    REQUIRE(img.width == 8);
    CHECK(img.rgba.at(0) == k * 40);
    CHECK(img.rgba.at(3) == 255);
  }
  // Scaled to the job's analysis size.
  auto small = jobs::open_plugin_frames(utf8(dir / "move.ppm"), 4, err);
  REQUIRE(small);
  CHECK(small->width() == 4);
  CHECK(small->height() == 2);
  REQUIRE(small->read(3, img, err));
  CHECK(img.rgba.at(0) == 120);
  // Not a plugin's file: no source, no error (the decoders take it).
  CHECK_FALSE(jobs::open_plugin_frames("clip.mp4", 0, err));
  CHECK(err.empty());
  // A file the plugin refuses fails with its message.
  write_ppm(dir / "broken.ppm", 2, 2);
  CHECK_FALSE(jobs::open_plugin_frames(utf8(dir / "broken.ppm"), 0, err));
  CHECK(err.find("plugin failed to read") != std::string::npos);
}

TEST_CASE("P7b a job on footage of a plugin that does not run fails with why (disabled, revoked)", "[plugins][contrib]") {
  const fs::path dir = temp_dir("jobs-off");
  write_moving_ppm(dir / "move.ppm", 8, 4, 3, 10);
  const std::string file = utf8(dir / "move.ppm");
  std::string err;
  {
    // Disabled at start (a child job's host lists every plugin its engine does not run this way).
    pl::HostOptions o = attached();
    o.disabled = {kPpmio};
    pl::PluginHost host(std::move(o));
    host.scan();
    CHECK_FALSE(doc::NativeImporters::claims(file));
    CHECK_FALSE(jobs::open_plugin_frames(file, 0, err));
    CHECK(err == "plugin failed to read '" + file + "': plugin 'com.premation.samples.ppmio' is disabled");
    // Turned on: read through the importer again; off at run time: refused again.
    REQUIRE(host.set_enabled(kPpmio, true));
    err.clear();
    CHECK(jobs::open_plugin_frames(file, 0, err));
    CHECK(err.empty());
    CHECK(host.contrib().importers_off().empty());
    REQUIRE(host.set_enabled(kPpmio, false));
    CHECK_FALSE(jobs::open_plugin_frames(file, 0, err));
    CHECK(err.find("is disabled") != std::string::npos);
    // A file no plugin lists: no refusal (the decoders take it).
    CHECK(doc::NativeImporters::refusal("clip.mp4").empty());
  }
  {
    pl::HostOptions o = attached();
    o.revoked = {{kPpmio, "test revocation"}};
    pl::PluginHost host(std::move(o));
    host.scan();
    err.clear();
    CHECK_FALSE(jobs::open_plugin_frames(file, 0, err));
    CHECK(err == "plugin failed to read '" + file + "': plugin 'com.premation.samples.ppmio' is revoked (revoked: test revocation)");
  }
  // No host at all: nothing claims or refuses.
  CHECK(doc::NativeImporters::refusal(file).empty());
}

TEST_CASE("P7b plugin footage with sound: READ_AUDIO through the audio decoders' reader", "[plugins][contrib]") {
  pl::PluginHost host(attached());
  host.scan();
  const fs::path dir = temp_dir("sound");
  std::vector<std::vector<float>> planes(2, std::vector<float>(12000));
  for (std::size_t i = 0; i < planes[0].size(); ++i) {
    planes[0][i] = static_cast<float>(i % 100) / 100.0F;
    planes[1][i] = -planes[0][i];
  }
  write_praw(dir / "tone.praw", 24000, planes);
  const std::string path = utf8(dir / "tone.praw");

  // importFiles: an audio item.
  Harness h;
  (void)h.hello();
  api::ImportFiles imp;
  imp.files.push_back(api::ImportFile{path, false, std::nullopt, std::nullopt, false, std::nullopt});
  const auto ri = h.run(cmd(imp));
  REQUIRE(is_ok(ri));
  api::GetItems gi;
  gi.items = result_as<api::ItemList>(ri).items;
  const auto items = query<api::ItemDetails>(h, qry(gi));
  REQUIRE(items.items.size() == 1);
  CHECK(items.items[0].media_type == api::MediaType::audio);
  CHECK(items.items[0].codec == "PRAW float32");

  // The host installed the audio decoders' reader (audio/external_audio.hpp).
  CHECK(audio::ExternalAudio::claims(path));
  CHECK(audio::ExternalAudio::claims(utf8(dir / "x.ppm")));
  CHECK_FALSE(audio::ExternalAudio::claims("song.wav"));
  audio::ExternalAudioFormat fmt;
  std::string err;
  REQUIRE(audio::ExternalAudio::probe(path, fmt, err));
  CHECK(fmt.channels == 2);
  CHECK(fmt.sampleRate == 24000);
  CHECK(fmt.frames == 12000);
  std::vector<float> got;
  REQUIRE(audio::ExternalAudio::read(path, 11990, 64, got, err));
  REQUIRE(got.size() == 20);  // 10 frames left x 2 channels
  CHECK(got[0] == planes[0][11990]);
  CHECK(got[1] == planes[1][11990]);
  // A picture-only file of the plugin is claimed but silent.
  write_ppm(dir / "still.ppm", 2, 2);
  REQUIRE(audio::ExternalAudio::probe(utf8(dir / "still.ppm"), fmt, err));
  CHECK(fmt.channels == 0);
  // The sound-only file has no picture for the texture feed.
  doc::NativeImage img;
  CHECK_FALSE(doc::NativeImporters::read_frame(path, 0, img, err));

  // The host gone: nothing is claimed any more.
  host.contrib().shutdown();
  CHECK_FALSE(audio::ExternalAudio::claims(path));
}

TEST_CASE("SDK 1.4 U: a viewer tool runs its command with the stroke; the whole drag is ONE undo entry", "[plugins][contrib][tools]") {
  pl::PluginHost host(attached());
  host.scan();
  Harness h;
  (void)h.hello();
  const auto plugins = query<api::PluginList>(h, qry(api::ListPlugins{})).plugins;
  const auto pi = std::ranges::find_if(plugins, [](const api::PluginInfo& p) { return p.id == "com.premation.samples.scatter"; });
  REQUIRE(pi != plugins.end());
  REQUIRE(pi->tools.size() == 1);
  CHECK(pi->tools[0].id == "com.premation.samples.scatter:scatter");
  CHECK(pi->tools[0].command == "scatter");
  CHECK(pi->tools[0].shortcut == "Shift+S");

  const api::ItemId c = comp(h);
  const auto layers_in = [&]() { return query<api::CompositionDetails>(h, qry(api::GetComposition{c})).layers.size(); };
  const std::size_t before = layers_in();
  const auto hist0 = query<api::HistoryState>(h, qry(api::GetHistory{}));
  // A 200 px stroke at 48 px spacing: 5 stamps (0, 48, 96, 144, 192), what PluginToolOverlay sends.
  api::RunPluginCommand run;
  run.plugin = "com.premation.samples.scatter";
  run.command = "scatter";
  run.comp = c;
  run.time = 0;
  run.args = R"({"tool":"scatter","stroke":[[10,90],[110,90],[210,90]],"shift":false,"alt":false,"ctrl":false})";
  const auto r = h.run(cmd(run));
  REQUIRE(is_ok(r));
  CHECK(result_as<api::PluginCommandResult>(r).message == "scattered 5 layers");
  CHECK(layers_in() == before + 5);
  const auto hist1 = query<api::HistoryState>(h, qry(api::GetHistory{}));
  REQUIRE(hist1.position == hist0.position + 1);
  CHECK(hist1.entries.at(hist1.position - 1).label == "Scatter Brush");
  // Shift halves the spacing; the same stroke is the same layers (no clock, no RNG).
  run.args = R"({"tool":"scatter","stroke":[[10,90],[110,90],[210,90]],"shift":true})";
  REQUIRE(is_ok(h.run(cmd(run))));
  CHECK(layers_in() == before + 5 + 9);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(layers_in() == before);
  // A press with no stroke changes nothing.
  run.args = R"({"tool":"scatter","stroke":[]})";
  CHECK_FALSE(is_ok(h.run(cmd(run))));
}

TEST_CASE("SDK 1.4 U: a manifest tool must name one of its commands", "[plugins][contrib][tools]") {
  const std::string_view platform = "windows";
  std::string error;
  const std::string base = R"({"manifestVersion":1,"id":"com.x.t","name":"T","version":"1.0.0","vendor":"X","sdk":{"major":1,"minor":4},)"
                           R"("binary":{"windows":"t.dll"},"commands":[{"id":"go","name":"Go"}],)";
  CHECK(pl::parse_manifest(base + R"("tools":[{"id":"brush","name":"Brush","command":"go"}]})", platform, error).has_value());
  CHECK_FALSE(pl::parse_manifest(base + R"("tools":[{"id":"brush","name":"Brush","command":"nope"}]})", platform, error).has_value());
  CHECK(error.find("nope") != std::string::npos);
}

TEST_CASE("SDK 1.4 U1: a viewer tool's events draw its overlay and status; nothing is edited", "[plugins][contrib][tools]") {
  pl::PluginHost host(attached());
  host.scan();
  Harness h;
  (void)h.hello();
  const api::ItemId c = comp(h);
  const auto hist0 = query<api::HistoryState>(h, qry(api::GetHistory{}));
  api::PluginToolEvent ev;
  ev.plugin = "com.premation.samples.scatter";
  ev.command = "scatter";
  ev.comp = c;
  // A hover: the brush ring at the pointer, radius half the spacing (48 px).
  ev.args = R"({"tool":"scatter","event":"move","pointer":[100,90]})";
  auto fb = query<api::PluginToolFeedback>(h, qry(ev));
  REQUIRE(fb.items.size() == 1);
  CHECK(fb.items[0].kind == PR_TOOL_DRAW_CIRCLE);
  REQUIRE(fb.items[0].xy.size() == 3);
  CHECK(fb.items[0].xy[0] == 100);
  CHECK(fb.items[0].xy[2] == 24);
  CHECK(fb.message.rfind("Spacing 48 px", 0) == 0);
  // A drag in progress: the ring plus the stamps a release would make (5 over 200 px).
  ev.args = R"({"tool":"scatter","event":"move","pointer":[210,90],"stroke":[[10,90],[110,90],[210,90]]})";
  fb = query<api::PluginToolFeedback>(h, qry(ev));
  REQUIRE(fb.items.size() == 1 + 5);
  CHECK(fb.items[1].kind == PR_TOOL_DRAW_DOT);
  CHECK(fb.items[1].width == 6);
  REQUIRE(fb.items[1].rgba.size() == 4);
  CHECK(fb.items[1].rgba[0] == 1);
  // The wheel and [ ] change the spacing, kept in the plugin between events.
  ev.args = R"({"tool":"scatter","event":"wheel","deltaY":-100,"pointer":[100,90]})";
  fb = query<api::PluginToolFeedback>(h, qry(ev));
  CHECK(fb.message.rfind("Spacing 53 px", 0) == 0);
  ev.args = R"({"tool":"scatter","event":"wheel","deltaY":100,"pointer":[100,90]})";
  fb = query<api::PluginToolFeedback>(h, qry(ev));
  CHECK(fb.message.rfind("Spacing 48 px", 0) == 0);
  // No event is an edit.
  CHECK(query<api::HistoryState>(h, qry(api::GetHistory{})).position == hist0.position);
  // A command that is not there.
  ev.command = "nope";
  CHECK(is_error(h.ask(qry(ev)), api::ErrorCode::not_found));
}
