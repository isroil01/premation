// SDK 1.4 (O): the OpenFX host (ofx_host.hpp). Runs only inside premation-plugin-host: a plugin
// that crashes or hangs ends that process, which the engine restarts (row X).
#include "ofx_host.hpp"

#include <ofxCore.h>
#include <ofxImageEffect.h>
#include <ofxMemory.h>
#include <ofxMessage.h>
#include <ofxMultiThread.h>
#include <ofxOld.h>           // the normalised 2D double types
#include <ofxOpenGLRender.h>  // kOfxImageEffectPropOpenGLRenderSupported
#include <ofxParam.h>
#include <ofxProperty.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

#include "json.hpp"
#include "module.hpp"
#include "world_convert.hpp"

namespace premation::plugins::ofx {

namespace fs = std::filesystem;
namespace js = premation::js;

std::string match_name(std::string_view identifier) { return "ofx:" + std::string(identifier); }

namespace {

// ── property sets ───────────────────────────────────────────────────────

struct Prop {
  char type = 0;  // 'p' pointer, 's' string, 'd' double, 'i' int
  std::vector<void*> p;
  std::vector<std::string> s;
  std::vector<double> d;
  std::vector<int> i;
};

struct PropSet {
  std::map<std::string, Prop, std::less<>> props;
  Prop& at(const char* name, char type) {
    Prop& p = props[name];
    p.type = type;
    return p;
  }
  void set_s(const char* name, std::vector<std::string> v) { at(name, 's').s = std::move(v); }
  void set_d(const char* name, std::vector<double> v) { at(name, 'd').d = std::move(v); }
  void set_i(const char* name, std::vector<int> v) { at(name, 'i').i = std::move(v); }
  void set_p(const char* name, void* v) { at(name, 'p').p = {v}; }
  [[nodiscard]] const Prop* find(std::string_view name) const {
    const auto it = props.find(name);
    return it == props.end() ? nullptr : &it->second;
  }
  [[nodiscard]] std::string str(std::string_view name, std::string def = {}) const {
    const Prop* p = find(name);
    return p != nullptr && !p->s.empty() ? p->s[0] : def;
  }
  [[nodiscard]] std::vector<std::string> strs(std::string_view name) const {
    const Prop* p = find(name);
    return p != nullptr ? p->s : std::vector<std::string>{};
  }
  [[nodiscard]] std::vector<double> nums(std::string_view name) const {
    const Prop* p = find(name);
    if (p == nullptr) return {};
    if (p->type == 'd') return p->d;
    std::vector<double> out(p->i.begin(), p->i.end());
    return out;
  }
  [[nodiscard]] double num(std::string_view name, double def) const {
    const std::vector<double> v = nums(name);
    return v.empty() ? def : v[0];
  }
};

PropSet* ps(OfxPropertySetHandle h) { return reinterpret_cast<PropSet*>(h); }  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast): opaque OFX handle
OfxPropertySetHandle handle(PropSet* p) { return reinterpret_cast<OfxPropertySetHandle>(p); }  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)

template <class T>
OfxStatus set_one(OfxPropertySetHandle h, const char* name, int index, char type, T value, std::vector<T> Prop::*field) {
  if (h == nullptr || name == nullptr || index < 0) return kOfxStatErrBadHandle;
  Prop& p = ps(h)->props[name];
  if (p.type != 0 && p.type != type) {
    p = Prop{};
  }
  p.type = type;
  auto& v = p.*field;
  if (static_cast<std::size_t>(index) >= v.size()) v.resize(static_cast<std::size_t>(index) + 1);
  v[static_cast<std::size_t>(index)] = value;
  return kOfxStatOK;
}

template <class T>
OfxStatus get_one(OfxPropertySetHandle h, const char* name, int index, std::vector<T> Prop::*field, T* out) {
  if (h == nullptr || name == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  const auto it = ps(h)->props.find(name);
  if (it == ps(h)->props.end()) return kOfxStatErrUnknown;
  const auto& v = it->second.*field;
  if (index < 0 || static_cast<std::size_t>(index) >= v.size()) return kOfxStatErrBadIndex;
  *out = v[static_cast<std::size_t>(index)];
  return kOfxStatOK;
}

OfxStatus prop_set_pointer(OfxPropertySetHandle h, const char* n, int i, void* v) { return set_one<void*>(h, n, i, 'p', v, &Prop::p); }
OfxStatus prop_set_string(OfxPropertySetHandle h, const char* n, int i, const char* v) {
  return set_one<std::string>(h, n, i, 's', v != nullptr ? std::string(v) : std::string(), &Prop::s);
}
OfxStatus prop_set_double(OfxPropertySetHandle h, const char* n, int i, double v) { return set_one<double>(h, n, i, 'd', v, &Prop::d); }
OfxStatus prop_set_int(OfxPropertySetHandle h, const char* n, int i, int v) { return set_one<int>(h, n, i, 'i', v, &Prop::i); }
OfxStatus prop_set_pointer_n(OfxPropertySetHandle h, const char* n, int count, void* const* v) {
  for (int i = 0; i < count; ++i) {
    if (OfxStatus s = prop_set_pointer(h, n, i, v[i]); s != kOfxStatOK) return s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return kOfxStatOK;
}
OfxStatus prop_set_string_n(OfxPropertySetHandle h, const char* n, int count, const char* const* v) {
  for (int i = 0; i < count; ++i) {
    if (OfxStatus s = prop_set_string(h, n, i, v[i]); s != kOfxStatOK) return s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return kOfxStatOK;
}
OfxStatus prop_set_double_n(OfxPropertySetHandle h, const char* n, int count, const double* v) {
  for (int i = 0; i < count; ++i) {
    if (OfxStatus s = prop_set_double(h, n, i, v[i]); s != kOfxStatOK) return s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return kOfxStatOK;
}
OfxStatus prop_set_int_n(OfxPropertySetHandle h, const char* n, int count, const int* v) {
  for (int i = 0; i < count; ++i) {
    if (OfxStatus s = prop_set_int(h, n, i, v[i]); s != kOfxStatOK) return s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return kOfxStatOK;
}
OfxStatus prop_get_pointer(OfxPropertySetHandle h, const char* n, int i, void** v) { return get_one<void*>(h, n, i, &Prop::p, v); }
OfxStatus prop_get_string(OfxPropertySetHandle h, const char* n, int i, char** v) {
  if (h == nullptr || n == nullptr || v == nullptr) return kOfxStatErrBadHandle;
  const auto it = ps(h)->props.find(n);
  if (it == ps(h)->props.end()) return kOfxStatErrUnknown;
  auto& s = it->second.s;
  if (i < 0 || static_cast<std::size_t>(i) >= s.size()) return kOfxStatErrBadIndex;
  *v = s[static_cast<std::size_t>(i)].data();  // stays valid until the property is set again
  return kOfxStatOK;
}
OfxStatus prop_get_double(OfxPropertySetHandle h, const char* n, int i, double* v) {
  const auto it = h != nullptr && n != nullptr ? ps(h)->props.find(n) : decltype(ps(h)->props.end()){};
  if (h != nullptr && n != nullptr && it != ps(h)->props.end() && it->second.type == 'i') {  // ints read as doubles
    int x = 0;
    const OfxStatus st = get_one<int>(h, n, i, &Prop::i, &x);
    if (st == kOfxStatOK && v != nullptr) *v = x;
    return st;
  }
  return get_one<double>(h, n, i, &Prop::d, v);
}
OfxStatus prop_get_int(OfxPropertySetHandle h, const char* n, int i, int* v) { return get_one<int>(h, n, i, &Prop::i, v); }
OfxStatus prop_get_pointer_n(OfxPropertySetHandle h, const char* n, int count, void** v) {
  for (int i = 0; i < count; ++i) {
    if (OfxStatus s = prop_get_pointer(h, n, i, &v[i]); s != kOfxStatOK) return s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return kOfxStatOK;
}
OfxStatus prop_get_string_n(OfxPropertySetHandle h, const char* n, int count, char** v) {
  for (int i = 0; i < count; ++i) {
    if (OfxStatus s = prop_get_string(h, n, i, &v[i]); s != kOfxStatOK) return s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return kOfxStatOK;
}
OfxStatus prop_get_double_n(OfxPropertySetHandle h, const char* n, int count, double* v) {
  for (int i = 0; i < count; ++i) {
    if (OfxStatus s = prop_get_double(h, n, i, &v[i]); s != kOfxStatOK) return s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return kOfxStatOK;
}
OfxStatus prop_get_int_n(OfxPropertySetHandle h, const char* n, int count, int* v) {
  for (int i = 0; i < count; ++i) {
    if (OfxStatus s = prop_get_int(h, n, i, &v[i]); s != kOfxStatOK) return s;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
  return kOfxStatOK;
}
OfxStatus prop_reset(OfxPropertySetHandle h, const char* n) {
  if (h == nullptr || n == nullptr) return kOfxStatErrBadHandle;
  return ps(h)->props.erase(n) > 0 ? kOfxStatOK : kOfxStatErrUnknown;
}
OfxStatus prop_get_dimension(OfxPropertySetHandle h, const char* n, int* count) {
  if (h == nullptr || n == nullptr || count == nullptr) return kOfxStatErrBadHandle;
  const Prop* p = ps(h)->find(n);
  if (p == nullptr) return kOfxStatErrUnknown;
  const std::size_t c = p->type == 'p' ? p->p.size() : p->type == 's' ? p->s.size() : p->type == 'd' ? p->d.size() : p->i.size();
  *count = static_cast<int>(c);
  return kOfxStatOK;
}

const OfxPropertySuiteV1 kPropertySuite = {prop_set_pointer,   prop_set_string,   prop_set_double,   prop_set_int,     prop_set_pointer_n,
                                           prop_set_string_n,  prop_set_double_n, prop_set_int_n,    prop_get_pointer, prop_get_string,
                                           prop_get_double,    prop_get_int,      prop_get_pointer_n, prop_get_string_n, prop_get_double_n,
                                           prop_get_int_n,     prop_reset,        prop_get_dimension};

// ── effects, params, clips, images ──────────────────────────────────────

struct Param {
  std::string name;
  std::string type;
  PropSet props;
  std::array<double, 4> value{};  // the frame's value
  std::string text;
};

struct ParamSet {
  std::deque<Param> params;  // stable addresses: handles are pointers
  PropSet props;
  Param* find(std::string_view name) {
    for (Param& p : params) {
      if (p.name == name) return &p;
    }
    return nullptr;
  }
};

struct Image {
  PropSet props;
  std::vector<std::uint8_t> bytes;
};

struct Clip {
  std::string name;
  PropSet props;
  Image* image = nullptr;  // the frame's (render only)
};

struct Effect {
  PropSet props;
  ParamSet params;
  std::deque<Clip> clips;
  Clip* clip(std::string_view name) {
    for (Clip& c : clips) {
      if (c.name == name) return &c;
    }
    return nullptr;
  }
};

Effect* fx(OfxImageEffectHandle h) { return reinterpret_cast<Effect*>(h); }          // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
OfxImageEffectHandle handle(Effect* e) { return reinterpret_cast<OfxImageEffectHandle>(e); }  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
Param* prm(OfxParamHandle h) { return reinterpret_cast<Param*>(h); }                 // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
ParamSet* pset(OfxParamSetHandle h) { return reinterpret_cast<ParamSet*>(h); }       // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
Clip* clp(OfxImageClipHandle h) { return reinterpret_cast<Clip*>(h); }               // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)

OfxStatus get_property_set(OfxImageEffectHandle e, OfxPropertySetHandle* out) {
  if (e == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  *out = handle(&fx(e)->props);
  return kOfxStatOK;
}

OfxStatus get_param_set(OfxImageEffectHandle e, OfxParamSetHandle* out) {
  if (e == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  *out = reinterpret_cast<OfxParamSetHandle>(&fx(e)->params);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return kOfxStatOK;
}

void default_clip_props(Clip& c) {
  c.props.set_s(kOfxPropType, {kOfxTypeClip});
  c.props.set_s(kOfxPropName, {c.name});
  c.props.set_s(kOfxImageEffectPropSupportedComponents, {kOfxImageComponentRGBA});
  c.props.set_i(kOfxImageClipPropOptional, {0});
  c.props.set_i(kOfxImageClipPropIsMask, {0});
}

OfxStatus clip_define(OfxImageEffectHandle e, const char* name, OfxPropertySetHandle* out) {
  if (e == nullptr || name == nullptr) return kOfxStatErrBadHandle;
  Clip* c = fx(e)->clip(name);
  if (c == nullptr) {
    fx(e)->clips.push_back(Clip{name, {}, nullptr});
    c = &fx(e)->clips.back();
    default_clip_props(*c);
  }
  if (out != nullptr) *out = handle(&c->props);
  return kOfxStatOK;
}

OfxStatus clip_get_handle(OfxImageEffectHandle e, const char* name, OfxImageClipHandle* clip, OfxPropertySetHandle* props) {
  if (e == nullptr || name == nullptr) return kOfxStatErrBadHandle;
  Clip* c = fx(e)->clip(name);
  if (c == nullptr) return kOfxStatErrBadHandle;
  if (clip != nullptr) *clip = reinterpret_cast<OfxImageClipHandle>(c);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  if (props != nullptr) *props = handle(&c->props);
  return kOfxStatOK;
}

OfxStatus clip_get_property_set(OfxImageClipHandle clip, OfxPropertySetHandle* out) {
  if (clip == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  *out = handle(&clp(clip)->props);
  return kOfxStatOK;
}

OfxStatus clip_get_image(OfxImageClipHandle clip, OfxTime /*time*/, const OfxRectD* /*region*/, OfxPropertySetHandle* out) {
  if (clip == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  Clip* c = clp(clip);
  if (c->image == nullptr) return kOfxStatFailed;  // not connected / no frame
  *out = handle(&c->image->props);
  return kOfxStatOK;
}

OfxStatus clip_release_image(OfxPropertySetHandle /*image*/) { return kOfxStatOK; }

OfxStatus clip_get_rod(OfxImageClipHandle clip, OfxTime /*time*/, OfxRectD* out) {
  if (clip == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  const std::vector<double> b = clp(clip)->props.nums("premation.bounds");
  if (b.size() != 4) return kOfxStatFailed;
  *out = OfxRectD{b[0], b[1], b[2], b[3]};
  return kOfxStatOK;
}

int effect_abort(OfxImageEffectHandle /*e*/) { return 0; }

// Memory handed to plugins: kept here by address (no raw new / delete).
std::mutex gMemMutex;                                          // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
std::map<const void*, std::vector<std::byte>> gMemory;         // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

void* mem_alloc(std::size_t n) {
  const std::scoped_lock lock(gMemMutex);
  std::vector<std::byte> block(std::max<std::size_t>(n, 1));
  void* p = block.data();
  gMemory.emplace(p, std::move(block));
  return p;
}
bool mem_free(const void* p) {
  const std::scoped_lock lock(gMemMutex);
  return gMemory.erase(p) > 0;
}

OfxStatus image_memory_alloc(OfxImageEffectHandle /*e*/, size_t n, OfxImageMemoryHandle* out) {
  if (out == nullptr) return kOfxStatErrBadHandle;
  *out = reinterpret_cast<OfxImageMemoryHandle>(mem_alloc(n));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  return kOfxStatOK;
}
OfxStatus image_memory_free(OfxImageMemoryHandle h) { return mem_free(h) ? kOfxStatOK : kOfxStatErrBadHandle; }
OfxStatus image_memory_lock(OfxImageMemoryHandle h, void** out) {
  if (h == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  *out = h;
  return kOfxStatOK;
}
OfxStatus image_memory_unlock(OfxImageMemoryHandle /*h*/) { return kOfxStatOK; }

const OfxImageEffectSuiteV1 kImageEffectSuite = {get_property_set,  get_param_set,     clip_define,        clip_get_handle,
                                                 clip_get_property_set, clip_get_image, clip_release_image, clip_get_rod,
                                                 effect_abort,      image_memory_alloc, image_memory_free, image_memory_lock,
                                                 image_memory_unlock};

std::size_t param_dims(const std::string& type) {
  if (type == kOfxParamTypeRGBA) return 4;
  if (type == kOfxParamTypeRGB || type == kOfxParamTypeDouble3D || type == kOfxParamTypeInteger3D) return 3;
  if (type == kOfxParamTypeDouble2D || type == kOfxParamTypeInteger2D) return 2;
  return 1;
}

bool is_int_type(const std::string& t) {
  return t == kOfxParamTypeInteger || t == kOfxParamTypeBoolean || t == kOfxParamTypeChoice || t == kOfxParamTypeInteger2D ||
         t == kOfxParamTypeInteger3D;
}

OfxStatus param_define(OfxParamSetHandle set, const char* type, const char* name, OfxPropertySetHandle* out) {
  if (set == nullptr || type == nullptr || name == nullptr) return kOfxStatErrBadHandle;
  ParamSet* s = pset(set);
  if (s->find(name) != nullptr) return kOfxStatErrExists;
  s->params.push_back(Param{name, type, {}, {}, {}});
  Param& p = s->params.back();
  p.props.set_s(kOfxPropType, {kOfxTypeParameter});
  p.props.set_s(kOfxParamPropType, {type});
  p.props.set_s(kOfxPropName, {name});
  p.props.set_s(kOfxPropLabel, {name});
  p.props.set_i(kOfxParamPropAnimates, {1});
  p.props.set_i(kOfxParamPropSecret, {0});
  p.props.set_s(kOfxParamPropParent, {""});
  if (out != nullptr) *out = handle(&p.props);
  return kOfxStatOK;
}

OfxStatus param_get_handle(OfxParamSetHandle set, const char* name, OfxParamHandle* out, OfxPropertySetHandle* props) {
  if (set == nullptr || name == nullptr) return kOfxStatErrBadHandle;
  Param* p = pset(set)->find(name);
  if (p == nullptr) return kOfxStatErrUnknown;
  if (out != nullptr) *out = reinterpret_cast<OfxParamHandle>(p);  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  if (props != nullptr) *props = handle(&p->props);
  return kOfxStatOK;
}

OfxStatus param_set_get_property_set(OfxParamSetHandle set, OfxPropertySetHandle* out) {
  if (set == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  *out = handle(&pset(set)->props);
  return kOfxStatOK;
}

OfxStatus param_get_property_set(OfxParamHandle p, OfxPropertySetHandle* out) {
  if (p == nullptr || out == nullptr) return kOfxStatErrBadHandle;
  *out = handle(&prm(p)->props);
  return kOfxStatOK;
}

OfxStatus read_value(Param* p, va_list ap) {
  const std::size_t n = param_dims(p->type);
  if (p->type == kOfxParamTypeString) {
    char** out = va_arg(ap, char**);
    if (out != nullptr) *out = p->text.data();
    return kOfxStatOK;
  }
  if (is_int_type(p->type)) {
    for (std::size_t k = 0; k < n; ++k) {
      int* out = va_arg(ap, int*);
      if (out != nullptr) *out = static_cast<int>(std::lround(p->value.at(k)));
    }
    return kOfxStatOK;
  }
  if (p->type == kOfxParamTypeGroup || p->type == kOfxParamTypePage || p->type == kOfxParamTypePushButton) return kOfxStatErrUnsupported;
  for (std::size_t k = 0; k < n; ++k) {
    double* out = va_arg(ap, double*);
    if (out != nullptr) *out = p->value.at(k);
  }
  return kOfxStatOK;
}

OfxStatus param_get_value(OfxParamHandle h, ...) {
  if (h == nullptr) return kOfxStatErrBadHandle;
  va_list ap;
  va_start(ap, h);
  const OfxStatus s = read_value(prm(h), ap);
  va_end(ap);
  return s;
}

// Params are evaluated at the frame by the engine; another time reads the same value (no temporal
// access out of process yet).
OfxStatus param_get_value_at_time(OfxParamHandle h, OfxTime time, ...) {
  if (h == nullptr) return kOfxStatErrBadHandle;
  va_list ap;
  va_start(ap, time);
  const OfxStatus s = read_value(prm(h), ap);
  va_end(ap);
  return s;
}

OfxStatus param_get_derivative(OfxParamHandle h, OfxTime time, ...) {
  if (h == nullptr) return kOfxStatErrBadHandle;
  va_list ap;
  va_start(ap, time);
  const std::size_t n = param_dims(prm(h)->type);
  for (std::size_t k = 0; k < n; ++k) {
    double* out = va_arg(ap, double*);
    if (out != nullptr) *out = 0;
  }
  va_end(ap);
  return kOfxStatOK;
}

OfxStatus param_get_integral(OfxParamHandle h, OfxTime t1, OfxTime t2, ...) {
  if (h == nullptr) return kOfxStatErrBadHandle;
  va_list ap;
  va_start(ap, t2);
  const std::size_t n = param_dims(prm(h)->type);
  for (std::size_t k = 0; k < n; ++k) {
    double* out = va_arg(ap, double*);
    if (out != nullptr) *out = prm(h)->value.at(k) * (t2 - t1);
  }
  va_end(ap);
  return kOfxStatOK;
}

// The document owns the values: a plugin that sets one (an instance-changed handler) is ignored.
OfxStatus param_set_value(OfxParamHandle h, ...) { return h == nullptr ? kOfxStatErrBadHandle : kOfxStatOK; }
OfxStatus param_set_value_at_time(OfxParamHandle h, OfxTime /*time*/, ...) { return h == nullptr ? kOfxStatErrBadHandle : kOfxStatOK; }
OfxStatus param_get_num_keys(OfxParamHandle h, unsigned int* n) {
  if (h == nullptr || n == nullptr) return kOfxStatErrBadHandle;
  *n = 0;
  return kOfxStatOK;
}
OfxStatus param_get_key_time(OfxParamHandle /*h*/, unsigned int /*nth*/, OfxTime* /*time*/) { return kOfxStatErrBadIndex; }
OfxStatus param_get_key_index(OfxParamHandle /*h*/, OfxTime /*time*/, int /*direction*/, int* index) {
  if (index != nullptr) *index = -1;
  return kOfxStatFailed;
}
OfxStatus param_delete_key(OfxParamHandle /*h*/, OfxTime /*time*/) { return kOfxStatErrBadIndex; }
OfxStatus param_delete_all_keys(OfxParamHandle /*h*/) { return kOfxStatOK; }
OfxStatus param_copy(OfxParamHandle /*to*/, OfxParamHandle /*from*/, OfxTime /*offset*/, const OfxRangeD* /*range*/) { return kOfxStatOK; }
OfxStatus param_edit_begin(OfxParamSetHandle /*set*/, const char* /*name*/) { return kOfxStatOK; }
OfxStatus param_edit_end(OfxParamSetHandle /*set*/) { return kOfxStatOK; }

const OfxParameterSuiteV1 kParameterSuite = {param_define,         param_get_handle,    param_set_get_property_set, param_get_property_set,
                                             param_get_value,      param_get_value_at_time, param_get_derivative,  param_get_integral,
                                             param_set_value,      param_set_value_at_time, param_get_num_keys,    param_get_key_time,
                                             param_get_key_index,  param_delete_key,    param_delete_all_keys,      param_copy,
                                             param_edit_begin,     param_edit_end};

OfxStatus memory_alloc(void* /*handle*/, size_t n, void** out) {
  if (out == nullptr) return kOfxStatErrBadHandle;
  *out = mem_alloc(n);
  return kOfxStatOK;
}
OfxStatus memory_free(void* p) { return mem_free(p) ? kOfxStatOK : kOfxStatErrBadHandle; }
const OfxMemorySuiteV1 kMemorySuite = {memory_alloc, memory_free};

thread_local unsigned int tThreadIndex = 0;   // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
thread_local bool tSpawned = false;           // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

OfxStatus multi_thread(OfxThreadFunctionV1 func, unsigned int n, void* arg) {
  if (func == nullptr) return kOfxStatErrBadHandle;
  n = std::max(1U, n);
  std::vector<std::thread> threads;
  threads.reserve(n);
  for (unsigned int i = 0; i < n; ++i) {
    threads.emplace_back([=] {
      tThreadIndex = i;
      tSpawned = true;
      func(i, n, arg);
    });
  }
  for (std::thread& t : threads) t.join();
  return kOfxStatOK;
}
OfxStatus multi_thread_num_cpus(unsigned int* n) {
  if (n == nullptr) return kOfxStatErrBadHandle;
  *n = std::max(1U, std::thread::hardware_concurrency());
  return kOfxStatOK;
}
OfxStatus multi_thread_index(unsigned int* i) {
  if (i == nullptr) return kOfxStatErrBadHandle;
  *i = tThreadIndex;
  return kOfxStatOK;
}
int multi_thread_is_spawned() { return tSpawned ? 1 : 0; }

std::mutex gMutexesMutex;                                                     // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
std::map<const void*, std::unique_ptr<std::recursive_mutex>> gMutexes;        // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

std::recursive_mutex* mutex_of(OfxMutexHandle h) {
  const std::scoped_lock lock(gMutexesMutex);
  const auto it = gMutexes.find(h);
  return it == gMutexes.end() ? nullptr : it->second.get();
}
OfxStatus mutex_create(OfxMutexHandle* out, int lockCount) {
  if (out == nullptr) return kOfxStatErrBadHandle;
  auto m = std::make_unique<std::recursive_mutex>();
  for (int i = 0; i < lockCount; ++i) m->lock();
  *out = reinterpret_cast<OfxMutexHandle>(m.get());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  const std::scoped_lock lock(gMutexesMutex);
  gMutexes.emplace(m.get(), std::move(m));
  return kOfxStatOK;
}
OfxStatus mutex_destroy(const OfxMutexHandle h) {
  const std::scoped_lock lock(gMutexesMutex);
  return gMutexes.erase(h) > 0 ? kOfxStatOK : kOfxStatErrBadHandle;
}
OfxStatus mutex_lock(const OfxMutexHandle h) {
  std::recursive_mutex* m = mutex_of(h);
  if (m == nullptr) return kOfxStatErrBadHandle;
  m->lock();
  return kOfxStatOK;
}
OfxStatus mutex_unlock(const OfxMutexHandle h) {
  std::recursive_mutex* m = mutex_of(h);
  if (m == nullptr) return kOfxStatErrBadHandle;
  m->unlock();
  return kOfxStatOK;
}
OfxStatus mutex_try_lock(const OfxMutexHandle h) {
  std::recursive_mutex* m = mutex_of(h);
  if (m == nullptr) return kOfxStatErrBadHandle;
  return m->try_lock() ? kOfxStatOK : kOfxStatFailed;
}
const OfxMultiThreadSuiteV1 kMultiThreadSuite = {multi_thread, multi_thread_num_cpus, multi_thread_index, multi_thread_is_spawned,
                                                 mutex_create, mutex_destroy,         mutex_lock,         mutex_unlock,
                                                 mutex_try_lock};

OfxStatus message(void* /*handle*/, const char* type, const char* /*id*/, const char* format, ...) {
  if (format == nullptr) return kOfxStatOK;
  std::array<char, 1024> buf{};
  va_list ap;
  va_start(ap, format);
  std::vsnprintf(buf.data(), buf.size(), format, ap);
  va_end(ap);
  std::fprintf(stderr, "ofx %s: %s\n", type != nullptr ? type : "message", buf.data());
  // A question cannot be answered out of process: the default answer.
  return type != nullptr && std::strcmp(type, kOfxMessageQuestion) == 0 ? kOfxStatReplyNo : kOfxStatOK;
}
OfxStatus set_persistent_message(void* h, const char* type, const char* id, const char* format, ...) {
  (void)h;
  (void)id;
  if (format == nullptr) return kOfxStatOK;
  std::array<char, 1024> buf{};
  va_list ap;
  va_start(ap, format);
  std::vsnprintf(buf.data(), buf.size(), format, ap);
  va_end(ap);
  std::fprintf(stderr, "ofx persistent %s: %s\n", type != nullptr ? type : "message", buf.data());
  return kOfxStatOK;
}
OfxStatus clear_persistent_message(void* /*handle*/) { return kOfxStatOK; }
const OfxMessageSuiteV1 kMessageSuiteV1 = {message};
const OfxMessageSuiteV2 kMessageSuiteV2 = {message, set_persistent_message, clear_persistent_message};

// ── the host ────────────────────────────────────────────────────────────

PropSet& host_props() {
  static PropSet h = [] {
    PropSet p;
    p.set_s(kOfxPropType, {kOfxTypeImageEffectHost});
    p.set_s(kOfxPropName, {"com.premation.editor"});
    p.set_s(kOfxPropLabel, {"Premation"});
    p.set_i(kOfxPropAPIVersion, {1, 4});
    p.set_i(kOfxPropVersion, {1, 4, 0});
    p.set_s(kOfxPropVersionLabel, {"1.4"});
    p.set_i(kOfxImageEffectHostPropIsBackground, {1});
    p.set_i(kOfxImageEffectPropSupportsOverlays, {0});
    p.set_i(kOfxImageEffectPropSupportsMultiResolution, {0});
    p.set_i(kOfxImageEffectPropSupportsTiles, {0});
    p.set_i(kOfxImageEffectPropTemporalClipAccess, {0});
    p.set_s(kOfxImageEffectPropSupportedComponents, {kOfxImageComponentRGBA});
    p.set_s(kOfxImageEffectPropSupportedContexts, {kOfxImageEffectContextFilter, kOfxImageEffectContextGeneral, kOfxImageEffectContextGenerator});
    p.set_s(kOfxImageEffectPropSupportedPixelDepths, {kOfxBitDepthFloat, kOfxBitDepthByte});
    p.set_i(kOfxImageEffectPropSupportsMultipleClipDepths, {0});
    p.set_i(kOfxImageEffectPropSupportsMultipleClipPARs, {0});
    p.set_i(kOfxImageEffectPropSetableFrameRate, {0});
    p.set_i(kOfxImageEffectPropSetableFielding, {0});
    p.set_i(kOfxParamHostPropSupportsCustomInteract, {0});
    p.set_i(kOfxParamHostPropSupportsStringAnimation, {0});
    p.set_i(kOfxParamHostPropSupportsChoiceAnimation, {0});
    p.set_i(kOfxParamHostPropSupportsBooleanAnimation, {0});
    p.set_i(kOfxParamHostPropSupportsCustomAnimation, {0});
    p.set_i(kOfxParamHostPropMaxParameters, {-1});
    p.set_i(kOfxParamHostPropMaxPages, {0});
    p.set_i(kOfxParamHostPropPageRowColumnCount, {0, 0});
    p.set_s(kOfxImageEffectPropOpenGLRenderSupported, {"false"});
    p.set_i(kOfxImageEffectInstancePropSequentialRender, {0});
    return p;
  }();
  return h;
}

const void* fetch_suite(OfxPropertySetHandle /*host*/, const char* name, int version) {
  if (name == nullptr) return nullptr;
  const std::string_view n(name);
  if (n == kOfxPropertySuite && version == 1) return &kPropertySuite;
  if (n == kOfxImageEffectSuite && version == 1) return &kImageEffectSuite;
  if (n == kOfxParameterSuite && version == 1) return &kParameterSuite;
  if (n == kOfxMemorySuite && version == 1) return &kMemorySuite;
  if (n == kOfxMultiThreadSuite && version == 1) return &kMultiThreadSuite;
  if (n == kOfxMessageSuite && version == 1) return &kMessageSuiteV1;
  if (n == kOfxMessageSuite && version == 2) return &kMessageSuiteV2;
  return nullptr;
}

OfxHost& ofx_host() {
  static OfxHost h{handle(&host_props()), &fetch_suite};
  return h;
}

/// How a Premation param maps back onto the OFX param it shows.
struct Mapping {
  std::string ofxName;
  std::string type;
  bool normalised2d = false;  // Double2D in 0..1 rather than canonical px
};

struct Plugin {
  OfxPlugin* plugin = nullptr;
  Effect descriptor;
  std::string context;
  EffectSpec spec;
  std::vector<Mapping> mappings;  // parallel to spec.params
  bool floatDepth = true;
};

std::vector<double> clamp_range(std::vector<double> v, double lo, double hi) {
  for (double& x : v) x = std::clamp(std::isfinite(x) ? x : 0.0, lo, hi);
  return v;
}

/// The descriptor's params as Premation params (ids from 1, in definition order).
void map_params(Plugin& pl) {
  std::map<std::string, std::string> groupLabel;
  for (const Param& p : pl.descriptor.params.params) {
    if (p.type == kOfxParamTypeGroup) groupLabel[p.name] = p.props.str(kOfxPropLabel, p.name);
  }
  std::uint32_t id = 0;
  for (const Param& p : pl.descriptor.params.params) {
    ParamSpec s;
    Mapping m{p.name, p.type, false};
    const std::vector<double> def = p.props.nums(kOfxParamPropDefault);
    const double lo = std::max(-1e9, p.props.num(kOfxParamPropMin, -1e9));
    const double hi = std::min(1e9, p.props.num(kOfxParamPropMax, 1e9));
    const double dlo = std::max(lo, p.props.num(kOfxParamPropDisplayMin, lo > -1e9 ? lo : 0.0));
    const double dhi = std::min(hi, p.props.num(kOfxParamPropDisplayMax, hi < 1e9 ? hi : 100.0));
    const std::string doubleType = p.props.str(kOfxParamPropDoubleType);
    if (p.type == kOfxParamTypeDouble) {
      s.type = doubleType == kOfxParamDoubleTypeAngle ? PR_PARAM_ANGLE : PR_PARAM_FLOAT_SLIDER;
      s.def[0] = def.empty() ? 0.0 : def[0];
      s.precision = static_cast<std::int32_t>(p.props.num(kOfxParamPropDigits, 2));
    } else if (p.type == kOfxParamTypeInteger) {
      s.type = PR_PARAM_SLIDER;
      s.def[0] = def.empty() ? 0.0 : def[0];
    } else if (p.type == kOfxParamTypeBoolean) {
      s.type = PR_PARAM_CHECKBOX;
      s.def[0] = def.empty() ? 0.0 : (def[0] != 0 ? 1.0 : 0.0);
    } else if (p.type == kOfxParamTypeChoice) {
      s.type = PR_PARAM_POPUP;
      s.choices = p.props.strs(kOfxParamPropChoiceOption);
      if (s.choices.empty()) continue;
      s.def[0] = (def.empty() ? 0.0 : def[0]) + 1;  // Premation popups are 1-based
    } else if (p.type == kOfxParamTypeRGBA || p.type == kOfxParamTypeRGB) {
      s.type = PR_PARAM_COLOR;
      const std::vector<double> c = clamp_range(def, 0, 1);
      for (std::size_t k = 0; k < 4; ++k) s.def.at(k) = k < c.size() ? c[k] : 1.0;
    } else if (p.type == kOfxParamTypeDouble2D) {
      s.type = PR_PARAM_POINT;
      m.normalised2d = doubleType == kOfxParamDoubleTypeNormalisedXY || doubleType == kOfxParamDoubleTypeNormalisedXYAbsolute;
      // The default is placed at the layer's centre (Premation's POINT default is an offset from it).
      s.def = {0, 0, 0, 0};
    } else {
      continue;  // groups, pages, strings, buttons, custom, parametric, 3D: defined, not shown
    }
    s.id = ++id;
    s.key = "p" + std::to_string(s.id);
    s.name = p.props.str(kOfxPropLabel, p.name);
    s.description = p.props.str(kOfxParamPropHint);
    s.validMin = lo;
    s.validMax = hi;
    s.sliderMin = dlo;
    s.sliderMax = dhi;
    if (p.props.num(kOfxParamPropSecret, 0) != 0) s.flags |= PR_PARAM_FLAG_HIDDEN;
    if (p.props.num(kOfxParamPropAnimates, 1) == 0) s.flags |= PR_PARAM_FLAG_CANNOT_ANIMATE;
    // Its group path, outermost first.
    std::vector<std::string> chain;
    for (std::string parent = p.props.str(kOfxParamPropParent); !parent.empty() && chain.size() < 8;) {
      chain.insert(chain.begin(), groupLabel.contains(parent) ? groupLabel[parent] : parent);
      const Param* g = pl.descriptor.params.find(parent);
      parent = g != nullptr ? g->props.str(kOfxParamPropParent) : std::string();
    }
    for (std::size_t k = 0; k < chain.size(); ++k) s.group += (k > 0 ? " / " : "") + chain[k];
    pl.spec.params.push_back(std::move(s));
    pl.mappings.push_back(m);
  }
}

}  // namespace

struct Host::Impl {
  std::unique_ptr<DynamicLibrary> lib;
  std::deque<Plugin> plugins;
  std::string error;
  std::map<std::string, std::unique_ptr<Effect>, std::less<>> instances;  // RenderInputs::instance + match name

  static OfxStatus call(OfxPlugin* p, const char* action, const void* handle, PropSet* in, PropSet* out) {
    return p->mainEntry(action, handle, in != nullptr ? ofx::handle(in) : nullptr, out != nullptr ? ofx::handle(out) : nullptr);
  }

  Plugin* plugin_of(std::string_view matchName) {
    for (Plugin& p : plugins) {
      if (p.spec.matchName == matchName) return &p;
    }
    return nullptr;
  }

  Effect* instance(Plugin& pl, const std::string& key, std::string& why) {
    if (const auto it = instances.find(key); it != instances.end()) return it->second.get();
    auto e = std::make_unique<Effect>();
    e->props = pl.descriptor.props;
    e->props.set_s(kOfxPropType, {kOfxTypeImageEffectInstance});
    e->props.set_s(kOfxImageEffectPropContext, {pl.context});
    e->props.set_i(kOfxPropIsInteractive, {0});
    e->props.set_d(kOfxImageEffectPropRenderScale, {1, 1});
    e->props.set_d(kOfxImageEffectPropProjectSize, {0, 0});
    e->props.set_d(kOfxImageEffectPropProjectOffset, {0, 0});
    e->props.set_d(kOfxImageEffectPropProjectExtent, {0, 0});
    e->props.set_d(kOfxImageEffectPropProjectPixelAspectRatio, {1});
    e->props.set_d(kOfxImageEffectInstancePropEffectDuration, {1e9});
    e->props.set_d(kOfxImageEffectPropFrameRate, {30});
    e->params = pl.descriptor.params;
    for (Param& p : e->params.params) {
      p.props.set_s(kOfxPropType, {kOfxTypeParameterInstance});
      const std::vector<double> def = p.props.nums(kOfxParamPropDefault);
      for (std::size_t k = 0; k < def.size() && k < 4; ++k) p.value.at(k) = def[k];
      p.text = p.props.str(kOfxParamPropDefault);
    }
    e->clips = pl.descriptor.clips;
    for (Clip& c : e->clips) {
      c.props.set_s(kOfxPropType, {kOfxTypeClip});
      c.props.set_s(kOfxImageEffectPropComponents, {kOfxImageComponentRGBA});
      c.props.set_s(kOfxImageClipPropUnmappedComponents, {kOfxImageComponentRGBA});
      c.props.set_s(kOfxImageEffectPropPixelDepth, {pl.floatDepth ? kOfxBitDepthFloat : kOfxBitDepthByte});
      c.props.set_s(kOfxImageClipPropUnmappedPixelDepth, {pl.floatDepth ? kOfxBitDepthFloat : kOfxBitDepthByte});
      c.props.set_s(kOfxImageEffectPropPreMultiplication, {kOfxImagePreMultiplied});
      c.props.set_d(kOfxImagePropPixelAspectRatio, {1});
      c.props.set_s(kOfxImageClipPropFieldOrder, {kOfxImageFieldNone});
      c.props.set_i(kOfxImageClipPropConnected, {1});
      c.props.set_i(kOfxImageClipPropContinuousSamples, {0});
      c.props.set_d(kOfxImageEffectPropFrameRange, {0, 1e9});
      c.props.set_d(kOfxImageEffectPropUnmappedFrameRange, {0, 1e9});
      c.props.set_d(kOfxImageEffectPropFrameRate, {30});
      c.props.set_d(kOfxImageEffectPropUnmappedFrameRate, {30});
    }
    const OfxStatus st = call(pl.plugin, kOfxActionCreateInstance, ofx::handle(e.get()), nullptr, nullptr);
    if (st != kOfxStatOK && st != kOfxStatReplyDefault) {
      why = "the plugin refused to create an instance (status " + std::to_string(st) + ")";
      return nullptr;
    }
    Effect* raw = e.get();
    instances.emplace(key, std::move(e));
    return raw;
  }
};

Host::Host() : impl_(std::make_unique<Impl>()) {}

Host::~Host() {
  for (auto& [key, e] : impl_->instances) {
    for (Plugin& p : impl_->plugins) {
      if (key.ends_with("|" + p.spec.matchName)) (void)Impl::call(p.plugin, kOfxActionDestroyInstance, handle(e.get()), nullptr, nullptr);
    }
  }
  for (Plugin& p : impl_->plugins) (void)Impl::call(p.plugin, kOfxActionUnload, nullptr, nullptr, nullptr);
  if (impl_->lib) impl_->lib->pin();  // its threads may outlive the unload
}

bool Host::load(const fs::path& bundle, std::string& error) {
  Impl& m = *impl_;
  // <name>.ofx.bundle/Contents/Win64/<name>.ofx (macOS: MacOS, Linux: Linux-x86-64).
  const std::u8string f = bundle.filename().u8string();
  const std::string name(f.begin(), f.end());
  const std::string stem = name.ends_with(".ofx.bundle") ? name.substr(0, name.size() - 11) : name;
#if defined(_WIN32)
  const char* arch = "Win64";
#elif defined(__APPLE__)
  const char* arch = "MacOS";
#else
  const char* arch = "Linux-x86-64";
#endif
  const fs::path binary = bundle / "Contents" / arch / fs::path(std::u8string(stem.begin(), stem.end()) + u8".ofx");
  m.lib = DynamicLibrary::open(binary, error);
  if (!m.lib) return false;
  using SetHostFn = OfxStatus (*)(const OfxHost*);
  using CountFn = int (*)();
  using GetFn = OfxPlugin* (*)(int);
  if (auto setHost = reinterpret_cast<SetHostFn>(m.lib->symbol("OfxSetHost")); setHost != nullptr) (void)setHost(&ofx_host());  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto count = reinterpret_cast<CountFn>(m.lib->symbol("OfxGetNumberOfPlugins"));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  const auto get = reinterpret_cast<GetFn>(m.lib->symbol("OfxGetPlugin"));               // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
  if (count == nullptr || get == nullptr) {
    error = "the binary exports no OfxGetNumberOfPlugins / OfxGetPlugin";
    return false;
  }
  std::vector<std::string> skipped;
  for (int i = 0; i < count(); ++i) {
    OfxPlugin* op = get(i);
    if (op == nullptr || op->pluginApi == nullptr || std::strcmp(op->pluginApi, kOfxImageEffectPluginApi) != 0 || op->apiVersion != 1) continue;
    m.plugins.push_back(Plugin{});
    Plugin& pl = m.plugins.back();
    pl.plugin = op;
    op->setHost(&ofx_host());
    pl.descriptor.props.set_s(kOfxPropType, {kOfxTypeImageEffect});
    pl.descriptor.props.set_s(kOfxPropLabel, {op->pluginIdentifier});
    const auto fail = [&](const std::string& why) {
      skipped.push_back(std::string(op->pluginIdentifier) + ": " + why);
      m.plugins.pop_back();
    };
    OfxStatus st = Impl::call(op, kOfxActionLoad, nullptr, nullptr, nullptr);
    if (st != kOfxStatOK && st != kOfxStatReplyDefault) {
      fail("load failed");
      continue;
    }
    st = Impl::call(op, kOfxActionDescribe, handle(&pl.descriptor), nullptr, nullptr);
    if (st != kOfxStatOK && st != kOfxStatReplyDefault) {
      fail("describe failed");
      continue;
    }
    const std::vector<std::string> contexts = pl.descriptor.props.strs(kOfxImageEffectPropSupportedContexts);
    for (const char* want : {kOfxImageEffectContextFilter, kOfxImageEffectContextGeneral, kOfxImageEffectContextGenerator}) {
      if (pl.context.empty() && std::ranges::find(contexts, want) != contexts.end()) pl.context = want;
    }
    if (pl.context.empty()) {
      fail("no Filter, General or Generator context");
      continue;
    }
    const std::vector<std::string> depths = pl.descriptor.props.strs(kOfxImageEffectPropSupportedPixelDepths);
    pl.floatDepth = depths.empty() || std::ranges::find(depths, kOfxBitDepthFloat) != depths.end();
    if (!pl.floatDepth && std::ranges::find(depths, kOfxBitDepthByte) == depths.end()) {
      fail("neither float nor 8-bit images");
      continue;
    }
    PropSet in;
    in.set_s(kOfxImageEffectPropContext, {pl.context});
    st = Impl::call(op, kOfxImageEffectActionDescribeInContext, handle(&pl.descriptor), &in, nullptr);
    if (st != kOfxStatOK && st != kOfxStatReplyDefault) {
      fail("describe in context failed");
      continue;
    }
    pl.spec.matchName = match_name(op->pluginIdentifier);
    pl.spec.name = pl.descriptor.props.str(kOfxPropLabel, op->pluginIdentifier);
    pl.spec.category = pl.descriptor.props.str(kOfxImageEffectPluginPropGrouping, "OpenFX");
    // PR_VERSION's packing (major 8 bits, minor 8, patch 16): what the host reads back as "major.minor.0" (O3).
    pl.spec.version = (static_cast<std::uint32_t>(op->pluginVersionMajor & 0xFFU) << 24U) | (static_cast<std::uint32_t>(op->pluginVersionMinor & 0xFFU) << 16U);
    pl.spec.about = pl.descriptor.props.str(kOfxPropPluginDescription);
    pl.spec.outFlags = PR_OUT_FLAG_SMART_RENDER | PR_OUT_FLAG_FLOAT_COLOR_AWARE | PR_OUT_FLAG_DEEP_COLOR_AWARE;
    if (pl.context == kOfxImageEffectContextGenerator) pl.spec.outFlags |= PR_OUT_FLAG_GENERATOR;
    map_params(pl);
  }
  if (m.plugins.empty()) {
    error = skipped.empty() ? "the bundle has no OpenFX image effect" : "no hostable effect (" + skipped.front() + ")";
    return false;
  }
  return true;
}

std::string Host::describe_json() const {
  if (impl_->plugins.empty()) {
    return "{\"error\":" + js::stringify(js::Json::string(impl_->error.empty() ? "nothing loaded" : impl_->error)) + "}";
  }
  std::vector<const EffectSpec*> specs;
  for (const Plugin& p : impl_->plugins) specs.push_back(&p.spec);
  return oop::specs_to_json(specs);
}

namespace {

/// A tightly packed top-down texel image as an OFX image (bottom-up rows through a negative row
/// stride), float or 8-bit RGBA premultiplied.
void to_ofx_image(const TexelImage& src, bool asFloat, Image& out, int uid) {
  const std::uint32_t w = src.width;
  const std::uint32_t h = src.height;
  const std::size_t px = std::size_t{w} * h;
  const std::size_t bpp = asFloat ? 16 : 4;
  out.bytes.assign(px * bpp, std::uint8_t{0});
  for (std::size_t i = 0; i < px; ++i) {
    std::array<float, 4> c{};
    for (std::size_t k = 0; k < 4; ++k) {
      const std::size_t o = i * 4 + k;
      if (src.format == TexelFormat::rgba8) c.at(k) = static_cast<float>(src.bytes[o]) / 255.0F;
      else if (src.format == TexelFormat::rgba16f) {
        std::uint16_t hv = 0;
        std::memcpy(&hv, &src.bytes[o * 2], 2);
        c.at(k) = half_to_float(hv);
      } else {
        std::memcpy(&c.at(k), &src.bytes[o * 4], 4);
      }
    }
    if (asFloat) {
      std::memcpy(&out.bytes[i * 16], c.data(), 16);
    } else {
      for (std::size_t k = 0; k < 4; ++k) out.bytes[i * 4 + k] = static_cast<std::uint8_t>(std::lround(std::clamp(c.at(k), 0.0F, 1.0F) * 255.0F));
    }
  }
  const auto stride = static_cast<int>(w * bpp);
  // OFX rows go up from y = 0 at the bottom: the last stored row is y = 0.
  std::uint8_t* bottom = out.bytes.data() + (h > 0 ? std::size_t{h - 1} * static_cast<std::size_t>(stride) : 0);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  out.props.set_s(kOfxPropType, {kOfxTypeImage});
  out.props.set_p(kOfxImagePropData, bottom);
  out.props.set_i(kOfxImagePropBounds, {0, 0, static_cast<int>(w), static_cast<int>(h)});
  out.props.set_i(kOfxImagePropRegionOfDefinition, {0, 0, static_cast<int>(w), static_cast<int>(h)});
  out.props.set_i(kOfxImagePropRowBytes, {-stride});
  out.props.set_s(kOfxImageEffectPropComponents, {kOfxImageComponentRGBA});
  out.props.set_s(kOfxImageEffectPropPixelDepth, {asFloat ? kOfxBitDepthFloat : kOfxBitDepthByte});
  out.props.set_s(kOfxImageEffectPropPreMultiplication, {kOfxImagePreMultiplied});
  out.props.set_d(kOfxImagePropPixelAspectRatio, {1});
  out.props.set_d(kOfxImageEffectPropRenderScale, {1, 1});
  out.props.set_s(kOfxImagePropField, {kOfxImageFieldNone});
  out.props.set_s(kOfxImagePropUniqueIdentifier, {std::to_string(uid)});
}

/// The OFX output image back into `format` (top-down, packed).
void from_ofx_image(const Image& img, bool asFloat, std::uint32_t w, std::uint32_t h, TexelFormat format, TexelImage& out) {
  out.format = format;
  out.width = w;
  out.height = h;
  const std::size_t px = std::size_t{w} * h;
  out.bytes.assign(px * texel_bytes(format), std::uint8_t{0});
  for (std::size_t i = 0; i < px; ++i) {
    std::array<float, 4> c{};
    if (asFloat) std::memcpy(c.data(), &img.bytes[i * 16], 16);
    else {
      for (std::size_t k = 0; k < 4; ++k) c.at(k) = static_cast<float>(img.bytes[i * 4 + k]) / 255.0F;
    }
    for (std::size_t k = 0; k < 4; ++k) {
      const std::size_t o = i * 4 + k;
      if (format == TexelFormat::rgba8) out.bytes[o] = static_cast<std::uint8_t>(std::lround(std::clamp(c.at(k), 0.0F, 1.0F) * 255.0F));
      else if (format == TexelFormat::rgba16f) {
        const std::uint16_t hv = float_to_half(c.at(k));
        std::memcpy(&out.bytes[o * 2], &hv, 2);
      } else {
        std::memcpy(&out.bytes[o * 4], &c.at(k), 4);
      }
    }
  }
}

}  // namespace

oop::RenderReply Host::render(const oop::RenderRequest& req) {
  oop::RenderReply reply;
  Impl& m = *impl_;
  Plugin* pl = m.plugin_of(req.in.matchName);
  if (pl == nullptr) {
    reply.message = "this plugin host has no effect '" + req.in.matchName + "'";
    return reply;
  }
  std::string why;
  Effect* e = m.instance(*pl, req.in.instance + "|" + pl->spec.matchName, why);
  if (e == nullptr) {
    reply.message = why;
    return reply;
  }
  const std::uint32_t w = req.input.width;
  const std::uint32_t h = req.input.height;
  // Params at this frame, from the document.
  for (std::size_t i = 0; i < pl->mappings.size() && i < req.in.values.size(); ++i) {
    Param* p = e->params.find(pl->mappings[i].ofxName);
    if (p == nullptr) continue;
    const std::array<double, 4>& v = req.in.values[i].v;
    if (p->type == kOfxParamTypeChoice) {
      p->value[0] = v[0] - 1;
    } else if (p->type == kOfxParamTypeDouble2D) {
      // Premation: layer px from the top-left; OFX: canonical px from the bottom-left (or 0..1).
      const double x = v[0];
      const double y = static_cast<double>(h) - v[1];
      p->value[0] = pl->mappings[i].normalised2d && w > 0 ? x / w : x;
      p->value[1] = pl->mappings[i].normalised2d && h > 0 ? y / h : y;
    } else {
      p->value = v;
    }
  }
  const double frame = req.in.timeStep > 0 ? static_cast<double>(req.in.layerTime) / static_cast<double>(req.in.timeStep) : 0.0;
  Image source;
  Image output;
  to_ofx_image(req.input, pl->floatDepth, source, 1);
  TexelImage blank = req.input;
  std::ranges::fill(blank.bytes, std::uint8_t{0});
  to_ofx_image(blank, pl->floatDepth, output, 2);
  for (Clip& c : e->clips) {
    c.props.set_d("premation.bounds", {0, 0, static_cast<double>(w), static_cast<double>(h)});
    c.props.set_d(kOfxImageEffectPropFrameRate, {req.in.fps});
    c.image = c.name == kOfxImageEffectOutputClipName ? &output : &source;
  }
  e->props.set_d(kOfxImageEffectPropProjectSize, {static_cast<double>(w), static_cast<double>(h)});
  e->props.set_d(kOfxImageEffectPropProjectExtent, {static_cast<double>(w), static_cast<double>(h)});
  e->props.set_d(kOfxImageEffectPropFrameRate, {req.in.fps});
  PropSet seq;
  seq.set_d(kOfxImageEffectPropFrameRange, {frame, frame});
  seq.set_d(kOfxImageEffectPropFrameStep, {1});
  seq.set_i(kOfxPropIsInteractive, {0});
  seq.set_d(kOfxImageEffectPropRenderScale, {1, 1});
  seq.set_i(kOfxImageEffectPropSequentialRenderStatus, {0});
  seq.set_i(kOfxImageEffectPropInteractiveRenderStatus, {0});
  (void)Impl::call(pl->plugin, kOfxImageEffectActionBeginSequenceRender, handle(e), &seq, nullptr);
  PropSet args;
  args.set_d(kOfxPropTime, {frame});
  args.set_s(kOfxImageEffectPropFieldToRender, {kOfxImageFieldNone});
  args.set_i(kOfxImageEffectPropRenderWindow, {0, 0, static_cast<int>(w), static_cast<int>(h)});
  args.set_d(kOfxImageEffectPropRenderScale, {1, 1});
  args.set_i(kOfxImageEffectPropSequentialRenderStatus, {0});
  args.set_i(kOfxImageEffectPropInteractiveRenderStatus, {0});
  const OfxStatus st = Impl::call(pl->plugin, kOfxImageEffectActionRender, handle(e), &args, nullptr);
  (void)Impl::call(pl->plugin, kOfxImageEffectActionEndSequenceRender, handle(e), &seq, nullptr);
  for (Clip& c : e->clips) c.image = nullptr;
  if (st != kOfxStatOK) {
    reply.message = pl->spec.name + " failed to render (OFX status " + std::to_string(st) + ")";
    return reply;
  }
  from_ofx_image(output, pl->floatDepth, w, h, req.input.format, reply.output);
  reply.ok = true;
  return reply;
}

}  // namespace premation::plugins::ofx
