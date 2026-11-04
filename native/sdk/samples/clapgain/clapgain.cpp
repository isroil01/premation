// Sample (SDK 1.4, A): a CLAP audio effect written against the CLAP headers only — no Premation
// header. Premation hosts it out of process (premation-plugin-host, clap_host.cpp), the way it
// would host a third-party CLAP plugin. Built as ClapGain.clap.
//
//   Gain (dB, id 1)   -60 .. +24
//   Pan  (id 2)       -1 (left) .. +1 (right), equal power
#include <clap/clap.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>

namespace {

constexpr clap_id kGain = 1;
constexpr clap_id kPan = 2;

struct Gain {
  clap_plugin_t plugin{};
  double gainDb = 0;
  double pan = 0;
};

Gain* self(const clap_plugin_t* p) { return static_cast<Gain*>(p->plugin_data); }

void apply(Gain* g, const clap_input_events_t* in) {
  const uint32_t n = in->size(in);
  for (uint32_t i = 0; i < n; ++i) {
    const clap_event_header_t* h = in->get(in, i);
    if (h->space_id != CLAP_CORE_EVENT_SPACE_ID || h->type != CLAP_EVENT_PARAM_VALUE) continue;
    const auto* e = reinterpret_cast<const clap_event_param_value_t*>(h);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
    if (e->param_id == kGain) g->gainDb = std::clamp(e->value, -60.0, 24.0);
    if (e->param_id == kPan) g->pan = std::clamp(e->value, -1.0, 1.0);
  }
}

// ── params extension ────────────────────────────────────────────────────

uint32_t CLAP_ABI params_count(const clap_plugin_t* /*p*/) { return 2; }
bool CLAP_ABI params_info(const clap_plugin_t* /*p*/, uint32_t index, clap_param_info_t* info) {
  if (index > 1) return false;
  *info = clap_param_info_t{};
  info->id = index == 0 ? kGain : kPan;
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  std::snprintf(info->name, sizeof info->name, "%s", index == 0 ? "Gain" : "Pan");
  info->min_value = index == 0 ? -60.0 : -1.0;
  info->max_value = index == 0 ? 24.0 : 1.0;
  info->default_value = 0.0;
  return true;
}
bool CLAP_ABI params_value(const clap_plugin_t* p, clap_id id, double* out) {
  if (id == kGain) *out = self(p)->gainDb;
  else if (id == kPan) *out = self(p)->pan;
  else return false;
  return true;
}
bool CLAP_ABI params_to_text(const clap_plugin_t* /*p*/, clap_id id, double v, char* out, uint32_t size) {
  std::snprintf(out, size, id == kGain ? "%.1f dB" : "%.2f", v);
  return true;
}
bool CLAP_ABI params_from_text(const clap_plugin_t* /*p*/, clap_id /*id*/, const char* text, double* out) {
  *out = std::atof(text);
  return true;
}
void CLAP_ABI params_flush(const clap_plugin_t* p, const clap_input_events_t* in, const clap_output_events_t* /*out*/) { apply(self(p), in); }

const clap_plugin_params_t kParams = {params_count, params_info, params_value, params_to_text, params_from_text, params_flush};

// ── the plugin ──────────────────────────────────────────────────────────

bool CLAP_ABI init(const clap_plugin_t* /*p*/) { return true; }
void CLAP_ABI destroy(const clap_plugin_t* p) { std::unique_ptr<Gain> owned(self(p)); }
bool CLAP_ABI activate(const clap_plugin_t* /*p*/, double /*rate*/, uint32_t /*min*/, uint32_t /*max*/) { return true; }
void CLAP_ABI deactivate(const clap_plugin_t* /*p*/) {}
bool CLAP_ABI start(const clap_plugin_t* /*p*/) { return true; }
void CLAP_ABI stop(const clap_plugin_t* /*p*/) {}
void CLAP_ABI reset(const clap_plugin_t* /*p*/) {}

clap_process_status CLAP_ABI process(const clap_plugin_t* p, const clap_process_t* proc) {
  Gain* g = self(p);
  apply(g, proc->in_events);
  if (proc->audio_inputs_count < 1 || proc->audio_outputs_count < 1) return CLAP_PROCESS_ERROR;
  const clap_audio_buffer_t& in = proc->audio_inputs[0];   // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const clap_audio_buffer_t& out = proc->audio_outputs[0];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const double k = std::pow(10.0, g->gainDb / 20.0);
  const double angle = (g->pan + 1) * 0.25 * 3.141592653589793;  // equal power: 0..π/2
  const double panGain[2] = {std::cos(angle) * std::sqrt(2.0), std::sin(angle) * std::sqrt(2.0)};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
  for (uint32_t c = 0; c < out.channel_count; ++c) {
    const float* src = in.data32[std::min(c, in.channel_count - 1)];  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    float* dst = out.data32[c];                                         // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const double pk = out.channel_count == 2 ? panGain[c] : 1.0;        // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    for (uint32_t f = 0; f < proc->frames_count; ++f) dst[f] = static_cast<float>(src[f] * k * pk);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return CLAP_PROCESS_CONTINUE;
}

const void* CLAP_ABI extension(const clap_plugin_t* /*p*/, const char* id) {
  return std::strcmp(id, CLAP_EXT_PARAMS) == 0 ? &kParams : nullptr;
}
void CLAP_ABI on_main_thread(const clap_plugin_t* /*p*/) {}

const char* const kFeatures[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, nullptr};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
const clap_plugin_descriptor_t kDescriptor = {CLAP_VERSION_INIT, "com.premation.samples.clapgain", "Clap Gain", "Premation", "", "", "",
                                              "1.0.0", "Gain and pan (a CLAP sample hosted out of process).", kFeatures};

const clap_plugin_t* CLAP_ABI create(const clap_plugin_factory_t* /*f*/, const clap_host_t* /*host*/, const char* id) {
  if (std::strcmp(id, kDescriptor.id) != 0) return nullptr;
  auto g = std::make_unique<Gain>();
  g->plugin = clap_plugin_t{&kDescriptor, g.get(), init, destroy, activate, deactivate, start, stop, reset, process, extension, on_main_thread};
  return &g.release()->plugin;  // owned by the host until destroy()
}
uint32_t CLAP_ABI count(const clap_plugin_factory_t* /*f*/) { return 1; }
const clap_plugin_descriptor_t* CLAP_ABI descriptor(const clap_plugin_factory_t* /*f*/, uint32_t i) { return i == 0 ? &kDescriptor : nullptr; }
const clap_plugin_factory_t kFactory = {count, descriptor, create};

bool CLAP_ABI entry_init(const char* /*path*/) { return true; }
void CLAP_ABI entry_deinit() {}
const void* CLAP_ABI entry_factory(const char* id) { return std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &kFactory : nullptr; }

}  // namespace

#if defined(_WIN32)
extern "C" __declspec(dllexport) const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entry_init, entry_deinit, entry_factory};
#else
extern "C" __attribute__((visibility("default"))) const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entry_init, entry_deinit, entry_factory};
#endif
