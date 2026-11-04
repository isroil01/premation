// SDK 1.4 (A): the CLAP host (clap_host.hpp). The request / reply codecs are plain C++ (the engine
// uses them too); the host itself runs only inside premation-plugin-host.
#include "clap_host.hpp"

#include <cstring>

#if defined(PREMATION_HAVE_CLAP) && defined(PREMATION_CLAP_HOST_IMPL)
#include <clap/clap.h>

#include <algorithm>
#include <map>

#include "json.hpp"
#include "module.hpp"
#endif

namespace premation::plugins::clap {

// The codecs build into engine_plugins (the engine sends requests); the host part builds only
// into premation-plugin-host (PREMATION_CLAP_HOST_IMPL), so the two never define a symbol twice.
#if !defined(PREMATION_CLAP_HOST_IMPL)
namespace {

void put_u32(std::vector<std::uint8_t>& o, std::uint32_t v) {
  for (std::uint32_t i = 0; i < 4; ++i) o.push_back(static_cast<std::uint8_t>((v >> (8U * i)) & 0xFFU));
}
void put_f64(std::vector<std::uint8_t>& o, double v) {
  std::uint64_t b = 0;
  std::memcpy(&b, &v, 8);
  put_u32(o, static_cast<std::uint32_t>(b & 0xFFFFFFFFU));
  put_u32(o, static_cast<std::uint32_t>(b >> 32U));
}
void put_str(std::vector<std::uint8_t>& o, const std::string& s) {
  put_u32(o, static_cast<std::uint32_t>(s.size()));
  o.insert(o.end(), s.begin(), s.end());
}
void put_floats(std::vector<std::uint8_t>& o, const std::vector<float>& v) {
  put_u32(o, static_cast<std::uint32_t>(v.size()));
  const auto* b = reinterpret_cast<const std::uint8_t*>(v.data());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  o.insert(o.end(), b, b + (v.size() * 4));                         // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
}

struct In {
  std::span<const std::uint8_t> b;
  std::size_t at = 0;
  bool u32(std::uint32_t& v) {
    if (b.size() - at < 4) return false;
    v = 0;
    for (std::uint32_t i = 0; i < 4; ++i) v |= std::uint32_t{b[at + i]} << (8U * i);
    at += 4;
    return true;
  }
  bool f64(double& v) {
    std::uint32_t lo = 0;
    std::uint32_t hi = 0;
    if (!u32(lo) || !u32(hi)) return false;
    const std::uint64_t bits = (std::uint64_t{hi} << 32U) | lo;
    std::memcpy(&v, &bits, 8);
    return true;
  }
  bool str(std::string& s) {
    std::uint32_t n = 0;
    if (!u32(n) || b.size() - at < n) return false;
    s.assign(reinterpret_cast<const char*>(b.data() + at), n);  // NOLINT
    at += n;
    return true;
  }
  bool floats(std::vector<float>& v) {
    std::uint32_t n = 0;
    if (!u32(n) || (b.size() - at) / 4 < n) return false;
    v.resize(n);
    std::memcpy(v.data(), b.data() + at, std::size_t{n} * 4);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    at += std::size_t{n} * 4;
    return true;
  }
};

}  // namespace

std::vector<std::uint8_t> encode(const ProcessRequest& r) {
  std::vector<std::uint8_t> o;
  put_str(o, r.pluginId);
  put_str(o, r.instance);
  put_f64(o, r.sampleRate);
  put_u32(o, r.channels);
  put_u32(o, r.reset ? 1U : 0U);
  put_floats(o, r.interleaved);
  put_u32(o, static_cast<std::uint32_t>(r.params.size()));
  for (const auto& [id, v] : r.params) {
    put_u32(o, id);
    put_f64(o, v);
  }
  return o;
}

bool decode(std::span<const std::uint8_t> in, ProcessRequest& r) {
  In x{in};
  std::uint32_t reset = 0;
  std::uint32_t n = 0;
  if (!x.str(r.pluginId) || !x.str(r.instance) || !x.f64(r.sampleRate) || !x.u32(r.channels) || !x.u32(reset) || !x.floats(r.interleaved) ||
      !x.u32(n) || n > 4096) {
    return false;
  }
  r.reset = reset != 0;
  r.params.resize(n);
  for (auto& [id, v] : r.params) {
    if (!x.u32(id) || !x.f64(v)) return false;
  }
  return x.at == in.size() && r.channels >= 1 && r.channels <= 2;
}

std::vector<std::uint8_t> encode(const ProcessReply& r) {
  std::vector<std::uint8_t> o;
  put_u32(o, r.ok ? 1U : 0U);
  put_str(o, r.message);
  put_floats(o, r.interleaved);
  return o;
}

bool decode(std::span<const std::uint8_t> in, ProcessReply& r) {
  In x{in};
  std::uint32_t ok = 0;
  if (!x.u32(ok) || !x.str(r.message) || !x.floats(r.interleaved)) return false;
  r.ok = ok != 0;
  return x.at == in.size();
}
#endif

#if defined(PREMATION_HAVE_CLAP) && defined(PREMATION_CLAP_HOST_IMPL)

namespace {

namespace js = premation::js;

const void* CLAP_ABI host_get_extension(const clap_host_t* /*host*/, const char* /*id*/) { return nullptr; }
void CLAP_ABI host_request(const clap_host_t* /*host*/) {}

const clap_host_t kHost = {CLAP_VERSION_INIT, nullptr, "Premation", "Premation", "https://premation.app", "1.4",
                           host_get_extension,  host_request, host_request, host_request};

/// The block's parameter changes as CLAP input events.
struct Events {
  std::vector<clap_event_param_value_t> values;
  static uint32_t CLAP_ABI size(const clap_input_events_t* list) {
    return static_cast<uint32_t>(static_cast<const Events*>(list->ctx)->values.size());
  }
  static const clap_event_header_t* CLAP_ABI get(const clap_input_events_t* list, uint32_t i) {
    const auto& v = static_cast<const Events*>(list->ctx)->values;
    return i < v.size() ? &v[i].header : nullptr;
  }
};

bool CLAP_ABI out_push(const clap_output_events_t* /*list*/, const clap_event_header_t* /*event*/) { return true; }

struct Instance {
  const clap_plugin_t* plugin = nullptr;
  const clap_plugin_params_t* params = nullptr;
  double sampleRate = 0;
  std::int64_t steady = 0;
  ~Instance() {
    if (plugin == nullptr) return;
    plugin->stop_processing(plugin);
    plugin->deactivate(plugin);
    plugin->destroy(plugin);
  }
  Instance() = default;
  Instance(const Instance&) = delete;
  Instance& operator=(const Instance&) = delete;
  Instance(Instance&&) = delete;
  Instance& operator=(Instance&&) = delete;
};

}  // namespace

struct Host::Impl {
  std::unique_ptr<DynamicLibrary> lib;
  const clap_plugin_entry_t* entry = nullptr;
  const clap_plugin_factory_t* factory = nullptr;
  std::string error;
  std::string describe;
  std::map<std::string, std::unique_ptr<Instance>> instances;  // instance + plugin id + rate

  Instance* instance(const ProcessRequest& r, std::string& why) {
    const std::string key = r.instance + "|" + r.pluginId + "|" + std::to_string(r.sampleRate);
    if (auto it = instances.find(key); it != instances.end()) return it->second.get();
    auto inst = std::make_unique<Instance>();
    inst->plugin = factory->create_plugin(factory, &kHost, r.pluginId.c_str());
    if (inst->plugin == nullptr || !inst->plugin->init(inst->plugin)) {
      if (inst->plugin != nullptr) inst->plugin->destroy(inst->plugin);
      inst->plugin = nullptr;
      why = "the plugin '" + r.pluginId + "' did not start";
      return nullptr;
    }
    if (!inst->plugin->activate(inst->plugin, r.sampleRate, 1, 8192)) {
      inst->plugin->destroy(inst->plugin);
      inst->plugin = nullptr;
      why = "the plugin '" + r.pluginId + "' did not activate at " + std::to_string(r.sampleRate) + " Hz";
      return nullptr;
    }
    (void)inst->plugin->start_processing(inst->plugin);
    inst->params = static_cast<const clap_plugin_params_t*>(inst->plugin->get_extension(inst->plugin, CLAP_EXT_PARAMS));
    inst->sampleRate = r.sampleRate;
    Instance* raw = inst.get();
    instances.emplace(key, std::move(inst));
    return raw;
  }
};

Host::Host() : impl_(std::make_unique<Impl>()) {}

Host::~Host() {
  impl_->instances.clear();
  if (impl_->entry != nullptr) impl_->entry->deinit();
  if (impl_->lib) impl_->lib->pin();
}

bool Host::load(const std::filesystem::path& file, std::string& error) {
  Impl& m = *impl_;
  m.lib = DynamicLibrary::open(file, error);
  if (!m.lib) return false;
  m.entry = static_cast<const clap_plugin_entry_t*>(m.lib->symbol("clap_entry"));
  if (m.entry == nullptr || !clap_version_is_compatible(m.entry->clap_version)) {
    error = "no compatible clap_entry";
    m.entry = nullptr;
    return false;
  }
  const std::u8string u8 = file.u8string();
  if (!m.entry->init(std::string(u8.begin(), u8.end()).c_str())) {
    error = "clap_entry.init failed";
    m.entry = nullptr;
    return false;
  }
  m.factory = static_cast<const clap_plugin_factory_t*>(m.entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
  if (m.factory == nullptr || m.factory->get_plugin_count(m.factory) == 0) {
    error = "the file has no CLAP plugin";
    return false;
  }
  js::Json::Array list;
  for (std::uint32_t i = 0; i < m.factory->get_plugin_count(m.factory); ++i) {
    const clap_plugin_descriptor_t* d = m.factory->get_plugin_descriptor(m.factory, i);
    if (d == nullptr || d->id == nullptr) continue;
    js::Json o = js::Json::object();
    o.set("id", js::Json::string(d->id));
    o.set("name", js::Json::string(d->name != nullptr ? d->name : d->id));
    o.set("vendor", js::Json::string(d->vendor != nullptr ? d->vendor : ""));
    js::Json::Array features;
    for (const char* const* f = d->features; f != nullptr && *f != nullptr; ++f) features.push_back(js::Json::string(*f));  // NOLINT
    o.set("features", js::Json::array(std::move(features)));
    // Params come from an instance (the extension lives on the plugin).
    ProcessRequest probe;
    probe.pluginId = d->id;
    probe.instance = "#describe";
    std::string why;
    js::Json::Array params;
    if (Instance* inst = m.instance(probe, why); inst != nullptr && inst->params != nullptr) {
      for (std::uint32_t k = 0; k < inst->params->count(inst->plugin); ++k) {
        clap_param_info_t info{};
        if (!inst->params->get_info(inst->plugin, k, &info)) continue;
        if ((info.flags & CLAP_PARAM_IS_HIDDEN) != 0) continue;
        js::Json p = js::Json::object();
        p.set("id", js::Json::number(info.id));
        p.set("name", js::Json::string(info.name));
        p.set("min", js::Json::number(info.min_value));
        p.set("max", js::Json::number(info.max_value));
        p.set("default", js::Json::number(info.default_value));
        p.set("stepped", js::Json::boolean((info.flags & CLAP_PARAM_IS_STEPPED) != 0));
        params.push_back(std::move(p));
      }
    }
    o.set("params", js::Json::array(std::move(params)));
    list.push_back(std::move(o));
  }
  js::Json out = js::Json::object();
  out.set("audio", js::Json::array(std::move(list)));
  m.describe = js::stringify(out);
  return true;
}

std::string Host::describe_json() const { return impl_->describe; }

ProcessReply Host::process(const ProcessRequest& req) {
  ProcessReply reply;
  std::string why;
  Instance* inst = impl_->instance(req, why);
  if (inst == nullptr) {
    reply.message = why;
    return reply;
  }
  if (req.reset) inst->plugin->reset(inst->plugin);
  const std::uint32_t ch = req.channels;
  const auto frames = static_cast<std::uint32_t>(req.interleaved.size() / ch);
  // De-interleave into the plugin's in place buffers (in and out ports are separate).
  std::vector<std::vector<float>> in(ch, std::vector<float>(frames));
  std::vector<std::vector<float>> out(ch, std::vector<float>(frames));
  for (std::uint32_t f = 0; f < frames; ++f) {
    for (std::uint32_t c = 0; c < ch; ++c) in[c][f] = req.interleaved[(std::size_t{f} * ch) + c];
  }
  std::vector<float*> inPtr;
  std::vector<float*> outPtr;
  for (std::uint32_t c = 0; c < ch; ++c) {
    inPtr.push_back(in[c].data());
    outPtr.push_back(out[c].data());
  }
  clap_audio_buffer_t inBuf{inPtr.data(), nullptr, ch, 0, 0};
  clap_audio_buffer_t outBuf{outPtr.data(), nullptr, ch, 0, 0};
  Events events;
  for (const auto& [id, value] : req.params) {
    clap_event_param_value_t e{};
    e.header.size = sizeof(e);
    e.header.time = 0;
    e.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
    e.header.type = CLAP_EVENT_PARAM_VALUE;
    e.param_id = id;
    e.note_id = -1;
    e.port_index = -1;
    e.channel = -1;
    e.key = -1;
    e.value = value;
    events.values.push_back(e);
  }
  const clap_input_events_t inEvents{&events, &Events::size, &Events::get};
  const clap_output_events_t outEvents{nullptr, &out_push};
  clap_process_t proc{};
  proc.steady_time = inst->steady;
  proc.frames_count = frames;
  proc.transport = nullptr;
  proc.audio_inputs = &inBuf;
  proc.audio_outputs = &outBuf;
  proc.audio_inputs_count = 1;
  proc.audio_outputs_count = 1;
  proc.in_events = &inEvents;
  proc.out_events = &outEvents;
  const clap_process_status st = inst->plugin->process(inst->plugin, &proc);
  inst->steady += frames;
  if (st == CLAP_PROCESS_ERROR) {
    reply.message = "the plugin failed to process";
    return reply;
  }
  reply.interleaved.resize(req.interleaved.size());
  for (std::uint32_t f = 0; f < frames; ++f) {
    for (std::uint32_t c = 0; c < ch; ++c) reply.interleaved[(std::size_t{f} * ch) + c] = out[c][f];
  }
  reply.ok = true;
  return reply;
}

#endif

}  // namespace premation::plugins::clap
