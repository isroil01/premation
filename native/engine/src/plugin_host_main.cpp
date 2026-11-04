// premation-plugin-host — SDK 1.4 (X): one native plugin bundle run out of process.
//
//   premation-plugin-host --bundle <dir>
//
// premation-engine starts one per out-of-process plugin and talks to it over stdin / stdout
// (plugins/oop_wire.hpp). Inside, the plugin runs in an ordinary PluginHost — the same crash
// guard, watchdog and worker pool as in the engine — so its author sees the same SDK. When the
// plugin takes this process down (abort, heap corruption, a hang the engine kills), the engine
// restarts the child; the engine itself never ends because of it.
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <span>
#include <string>
#include <thread>
#include <vector>

#include "cpu_render.hpp"
#include "host.hpp"
#include "json.hpp"
#include "oop_wire.hpp"
#include "plugin_host_io_ffi.hpp"
#if defined(PREMATION_HAVE_OFX)
#include "ofx_host.hpp"  // SDK 1.4 (O): a .ofx.bundle is hosted as OpenFX
#endif
#include "clap_host.hpp"  // SDK 1.4 (A): a .clap file is hosted as CLAP audio plugins

namespace pl = premation::plugins;

namespace {

bool send(std::span<const std::uint8_t> payload) {
  std::vector<std::uint8_t> frame;
  pl::oop::put_frame(frame, pl::oop::Kind::reply, payload);
  return pl::oop::io::write_all(frame);
}

std::span<const std::uint8_t> bytes_of(const std::string& s) {
  return {reinterpret_cast<const std::uint8_t*>(s.data()), s.size()};  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

std::string describe(pl::PluginHost& host) {
  std::vector<const pl::EffectSpec*> specs;
  for (const pl::PluginRecord& p : host.plugins()) {
    if (p.status != pl::PluginStatus::loaded) {
      const std::string why = p.error.empty() ? std::string(pl::to_string(p.status)) : p.error;
      return "{\"error\":" + premation::js::stringify(premation::js::Json::string(why)) + "}";
    }
    for (const std::string& e : p.effects) {
      if (const pl::EffectSpec* s = host.effect(e)) specs.push_back(s);
    }
  }
  return pl::oop::specs_to_json(specs);
}

pl::oop::RenderReply render(pl::PluginHost& host, std::span<const std::uint8_t> payload) {
  pl::oop::RenderReply reply;
  pl::oop::RenderRequest req;
  if (!pl::oop::decode(payload, req)) {
    reply.message = "a malformed render request";
    return reply;
  }
  const pl::EffectSpec* spec = host.effect(req.in.matchName);
  if (spec == nullptr) {
    reply.message = "this plugin host has no effect '" + req.in.matchName + "'";
    return reply;
  }
  req.in.values.resize(spec->params.size());
  // Out of process the input is the layer at the frame's time; other checkouts are empty.
  const pl::CheckoutImageFn checkout = [&](const pl::CheckoutRequest& c) -> const pl::TexelImage* {
    return c.paramIndex == 0 && c.time == req.in.layerTime ? &req.input : nullptr;
  };
  const pl::CallResult cr = pl::run_native_cpu(host, req.in, req.input, checkout, reply.output);
  reply.ok = cr.ok;
  reply.fault = static_cast<bool>(cr.fault);
  reply.message = cr.message;
  return reply;
}

/// SDK 1.4 (A): the loop for a .clap file (describe / audio_process through clap::Host).
int serve_clap(const std::string& file) {
#if defined(PREMATION_HAVE_CLAP)
  pl::clap::Host clap;
  std::string error;
  const bool loaded = clap.load(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(file.data()), file.size())), error);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  std::vector<std::uint8_t> header(8);
  std::vector<std::uint8_t> payload;
  for (;;) {
    if (!pl::oop::io::read_exact(header)) return 0;
    pl::oop::Kind kind{};
    std::uint32_t length = 0;
    if (!pl::oop::read_header(header, kind, length)) return 3;
    payload.resize(length);
    if (length > 0 && !pl::oop::io::read_exact(payload)) return 0;
    switch (kind) {
      case pl::oop::Kind::describe: {
        const std::string json = loaded ? clap.describe_json() : "{\"error\":" + premation::js::stringify(premation::js::Json::string(error)) + "}";
        if (!send(bytes_of(json))) return 0;
        break;
      }
      case pl::oop::Kind::audio_process: {
        pl::clap::ProcessRequest req;
        pl::clap::ProcessReply reply;
        if (!pl::clap::decode(payload, req)) reply.message = "a malformed audio request";
        else reply = clap.process(req);
        if (!send(pl::clap::encode(reply))) return 0;
        break;
      }
      case pl::oop::Kind::quit: return 0;
      default: return 3;
    }
  }
#else
  (void)file;
  std::fputs("premation-plugin-host: built without CLAP\n", stderr);
  return 4;
#endif
}

/// SDK 1.4 (O): the loop for an OpenFX bundle (describe / render through ofx::Host).
int serve_ofx(const std::string& bundle) {
#if defined(PREMATION_HAVE_OFX)
  pl::ofx::Host ofx;
  std::string error;
  const bool loaded = ofx.load(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(bundle.data()), bundle.size())), error);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  if (!loaded) std::fprintf(stderr, "premation-plugin-host: %s\n", error.c_str());
  std::vector<std::uint8_t> header(8);
  std::vector<std::uint8_t> payload;
  for (;;) {
    if (!pl::oop::io::read_exact(header)) return 0;
    pl::oop::Kind kind{};
    std::uint32_t length = 0;
    if (!pl::oop::read_header(header, kind, length)) return 3;
    payload.resize(length);
    if (length > 0 && !pl::oop::io::read_exact(payload)) return 0;
    switch (kind) {
      case pl::oop::Kind::describe: {
        const std::string json = loaded ? ofx.describe_json()
                                        : "{\"error\":" + premation::js::stringify(premation::js::Json::string(error)) + "}";
        if (!send(bytes_of(json))) return 0;
        break;
      }
      case pl::oop::Kind::render: {
        pl::oop::RenderRequest req;
        pl::oop::RenderReply reply;
        if (!pl::oop::decode(payload, req)) reply.message = "a malformed render request";
        else reply = ofx.render(req);
        if (!send(pl::oop::encode(reply))) return 0;
        break;
      }
      case pl::oop::Kind::quit: return 0;
      default: return 3;
    }
  }
#else
  (void)bundle;
  std::fputs("premation-plugin-host: built without OpenFX\n", stderr);
  return 4;
#endif
}

}  // namespace

int main(int argc, char** argv) {
  std::string bundle;
  const std::vector<std::string> args(argv + 1, argv + argc);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  for (std::size_t i = 0; i + 1 < args.size(); ++i) {
    if (args[i] == "--bundle") bundle = args[i + 1];
  }
  if (bundle.empty()) {
    std::fputs("premation-plugin-host: --bundle <dir> is required\n", stderr);
    return 2;
  }
  pl::oop::io::binary_stdio();
  if (bundle.ends_with(".clap")) return serve_clap(bundle);
  if (bundle.ends_with(".ofx.bundle") || bundle.ends_with(".ofx.bundle/") || bundle.ends_with(".ofx.bundle\\")) return serve_ofx(bundle);
  pl::HostOptions o;
  o.searchPaths = {std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(bundle.data()), bundle.size()))};  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  o.threads = static_cast<int>(std::max(1U, std::thread::hardware_concurrency()));
  o.attachToDocument = false;
  o.onHang = [](const std::string&, std::string_view) { std::fputs("premation-plugin-host: the plugin hung\n", stderr); };
  pl::PluginHost host(std::move(o));
  host.scan();

  std::vector<std::uint8_t> header(8);
  std::vector<std::uint8_t> payload;
  for (;;) {
    if (!pl::oop::io::read_exact(header)) return 0;  // the engine closed the pipe
    pl::oop::Kind kind{};
    std::uint32_t length = 0;
    if (!pl::oop::read_header(header, kind, length)) return 3;
    payload.resize(length);
    if (length > 0 && !pl::oop::io::read_exact(payload)) return 0;
    switch (kind) {
      case pl::oop::Kind::describe:
        if (!send(bytes_of(describe(host)))) return 0;
        break;
      case pl::oop::Kind::render:
        if (!send(pl::oop::encode(render(host, payload)))) return 0;
        break;
      case pl::oop::Kind::quit: return 0;
      default: return 3;
    }
  }
}
