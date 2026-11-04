// Sample (SDK 1.4, O): an OpenFX 1.4 image effect written against the OFX C API only — no
// Premation header. Premation hosts it out of process (premation-plugin-host, ofx_host.cpp), the
// way it would host a third-party OFX pack. Built as Invert.ofx.bundle.
//
//   Amount (Double 0..1)   how far toward the inverted colour
//   Invert Alpha (Boolean) invert the coverage too
//   Tint (RGB)             multiplies the result
//   Mode (Choice)          Colour | Luma (Luma inverts the luminance only)
#include <ofxCore.h>
#include <ofxImageEffect.h>
#include <ofxParam.h>
#include <ofxProperty.h>

#include <algorithm>
#include <cstring>

#if defined(_WIN32)
#define OFX_EXPORT extern "C" __declspec(dllexport)
#else
#define OFX_EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace {

const OfxHost* gHost = nullptr;                    // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
const OfxPropertySuiteV1* gProps = nullptr;        // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
const OfxImageEffectSuiteV1* gEffects = nullptr;   // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
const OfxParameterSuiteV1* gParams = nullptr;      // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

OfxStatus on_load() {
  if (gHost == nullptr) return kOfxStatErrMissingHostFeature;
  gProps = static_cast<const OfxPropertySuiteV1*>(gHost->fetchSuite(gHost->host, kOfxPropertySuite, 1));
  gEffects = static_cast<const OfxImageEffectSuiteV1*>(gHost->fetchSuite(gHost->host, kOfxImageEffectSuite, 1));
  gParams = static_cast<const OfxParameterSuiteV1*>(gHost->fetchSuite(gHost->host, kOfxParameterSuite, 1));
  return gProps != nullptr && gEffects != nullptr && gParams != nullptr ? kOfxStatOK : kOfxStatErrMissingHostFeature;
}

OfxStatus describe(OfxImageEffectHandle effect) {
  OfxPropertySetHandle props = nullptr;
  gEffects->getPropertySet(effect, &props);
  gProps->propSetString(props, kOfxPropLabel, 0, "OFX Invert");
  gProps->propSetString(props, kOfxImageEffectPluginPropGrouping, 0, "Premation Samples");
  gProps->propSetString(props, kOfxPropPluginDescription, 0, "An OpenFX sample hosted out of process.");
  gProps->propSetString(props, kOfxImageEffectPropSupportedContexts, 0, kOfxImageEffectContextFilter);
  gProps->propSetString(props, kOfxImageEffectPropSupportedPixelDepths, 0, kOfxBitDepthFloat);
  gProps->propSetInt(props, kOfxImageEffectPropSupportsTiles, 0, 0);
  return kOfxStatOK;
}

OfxStatus describe_in_context(OfxImageEffectHandle effect) {
  OfxPropertySetHandle clip = nullptr;
  gEffects->clipDefine(effect, kOfxImageEffectSimpleSourceClipName, &clip);
  gProps->propSetString(clip, kOfxImageEffectPropSupportedComponents, 0, kOfxImageComponentRGBA);
  gEffects->clipDefine(effect, kOfxImageEffectOutputClipName, &clip);
  gProps->propSetString(clip, kOfxImageEffectPropSupportedComponents, 0, kOfxImageComponentRGBA);

  OfxParamSetHandle params = nullptr;
  gEffects->getParamSet(effect, &params);
  OfxPropertySetHandle p = nullptr;
  gParams->paramDefine(params, kOfxParamTypeDouble, "amount", &p);
  gProps->propSetString(p, kOfxPropLabel, 0, "Amount");
  gProps->propSetDouble(p, kOfxParamPropDefault, 0, 1.0);
  gProps->propSetDouble(p, kOfxParamPropMin, 0, 0.0);
  gProps->propSetDouble(p, kOfxParamPropMax, 0, 1.0);
  gProps->propSetDouble(p, kOfxParamPropDisplayMin, 0, 0.0);
  gProps->propSetDouble(p, kOfxParamPropDisplayMax, 0, 1.0);
  gProps->propSetString(p, kOfxParamPropHint, 0, "How far toward the inverted colour.");

  gParams->paramDefine(params, kOfxParamTypeGroup, "advanced", &p);
  gProps->propSetString(p, kOfxPropLabel, 0, "Advanced");

  gParams->paramDefine(params, kOfxParamTypeBoolean, "invertAlpha", &p);
  gProps->propSetString(p, kOfxPropLabel, 0, "Invert Alpha");
  gProps->propSetInt(p, kOfxParamPropDefault, 0, 0);
  gProps->propSetString(p, kOfxParamPropParent, 0, "advanced");

  gParams->paramDefine(params, kOfxParamTypeRGB, "tint", &p);
  gProps->propSetString(p, kOfxPropLabel, 0, "Tint");
  const double white[3] = {1, 1, 1};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays): the C API
  gProps->propSetDoubleN(p, kOfxParamPropDefault, 3, white);
  gProps->propSetString(p, kOfxParamPropParent, 0, "advanced");

  gParams->paramDefine(params, kOfxParamTypeChoice, "mode", &p);
  gProps->propSetString(p, kOfxPropLabel, 0, "Mode");
  gProps->propSetString(p, kOfxParamPropChoiceOption, 0, "Colour");
  gProps->propSetString(p, kOfxParamPropChoiceOption, 1, "Luma");
  gProps->propSetInt(p, kOfxParamPropDefault, 0, 0);
  return kOfxStatOK;
}

struct ImageView {
  OfxPropertySetHandle props = nullptr;
  char* data = nullptr;
  int x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  int rowBytes = 0;
  float* pixel(int x, int y) const {
    if (x < x1 || x >= x2 || y < y1 || y >= y2 || data == nullptr) return nullptr;
    return reinterpret_cast<float*>(data + static_cast<std::ptrdiff_t>(y - y1) * rowBytes + static_cast<std::ptrdiff_t>(x - x1) * 16);  // NOLINT
  }
};

bool fetch(OfxImageEffectHandle effect, const char* clipName, OfxTime time, ImageView& v, OfxImageClipHandle& clip) {
  if (gEffects->clipGetHandle(effect, clipName, &clip, nullptr) != kOfxStatOK) return false;
  if (gEffects->clipGetImage(clip, time, nullptr, &v.props) != kOfxStatOK) return false;
  void* data = nullptr;
  gProps->propGetPointer(v.props, kOfxImagePropData, 0, &data);
  v.data = static_cast<char*>(data);
  int b[4] = {0, 0, 0, 0};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
  gProps->propGetIntN(v.props, kOfxImagePropBounds, 4, b);
  v.x1 = b[0];
  v.y1 = b[1];
  v.x2 = b[2];
  v.y2 = b[3];
  gProps->propGetInt(v.props, kOfxImagePropRowBytes, 0, &v.rowBytes);
  return true;
}

OfxStatus render(OfxImageEffectHandle effect, OfxPropertySetHandle in) {
  OfxTime time = 0;
  gProps->propGetDouble(in, kOfxPropTime, 0, &time);
  int window[4] = {0, 0, 0, 0};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
  gProps->propGetIntN(in, kOfxImageEffectPropRenderWindow, 4, window);
  OfxParamSetHandle params = nullptr;
  gEffects->getParamSet(effect, &params);
  OfxParamHandle h = nullptr;
  double amount = 1;
  int invertAlpha = 0;
  double tint[3] = {1, 1, 1};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
  int mode = 0;
  if (gParams->paramGetHandle(params, "amount", &h, nullptr) == kOfxStatOK) gParams->paramGetValueAtTime(h, time, &amount);
  if (gParams->paramGetHandle(params, "invertAlpha", &h, nullptr) == kOfxStatOK) gParams->paramGetValueAtTime(h, time, &invertAlpha);
  if (gParams->paramGetHandle(params, "tint", &h, nullptr) == kOfxStatOK) gParams->paramGetValueAtTime(h, time, &tint[0], &tint[1], &tint[2]);
  if (gParams->paramGetHandle(params, "mode", &h, nullptr) == kOfxStatOK) gParams->paramGetValueAtTime(h, time, &mode);

  ImageView src;
  ImageView dst;
  OfxImageClipHandle srcClip = nullptr;
  OfxImageClipHandle dstClip = nullptr;
  if (!fetch(effect, kOfxImageEffectOutputClipName, time, dst, dstClip)) return kOfxStatFailed;
  const bool haveSrc = fetch(effect, kOfxImageEffectSimpleSourceClipName, time, src, srcClip);
  const auto a = static_cast<float>(std::clamp(amount, 0.0, 1.0));
  for (int y = window[1]; y < window[3]; ++y) {
    for (int x = window[0]; x < window[2]; ++x) {
      float* o = dst.pixel(x, y);
      if (o == nullptr) continue;
      const float* s = haveSrc ? src.pixel(x, y) : nullptr;
      float c[4] = {0, 0, 0, 0};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
      if (s != nullptr) std::memcpy(c, s, sizeof c);
      const float alpha = c[3];
      const float k = alpha > 0 ? 1.0F / alpha : 0.0F;
      float rgb[3] = {c[0] * k, c[1] * k, c[2] * k};  // NOLINT(cppcoreguidelines-avoid-c-arrays, modernize-avoid-c-arrays)
      if (mode == 1) {
        const float luma = (0.2126F * rgb[0]) + (0.7152F * rgb[1]) + (0.0722F * rgb[2]);
        const float d = (1.0F - luma) - luma;
        for (float& v : rgb) v += d * a;
      } else {
        for (float& v : rgb) v += ((1.0F - v) - v) * a;
      }
      const float outA = invertAlpha != 0 ? alpha + ((1.0F - alpha) - alpha) * a : alpha;
      for (int i = 0; i < 3; ++i) o[i] = std::max(0.0F, rgb[i] * static_cast<float>(tint[i])) * outA;  // NOLINT
      o[3] = outA;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
  }
  if (haveSrc) gEffects->clipReleaseImage(src.props);
  gEffects->clipReleaseImage(dst.props);
  return kOfxStatOK;
}

OfxStatus main_entry(const char* action, const void* handle, OfxPropertySetHandle in, OfxPropertySetHandle /*out*/) {
  auto* effect = static_cast<OfxImageEffectHandle>(const_cast<void*>(handle));  // NOLINT(cppcoreguidelines-pro-type-const-cast)
  if (std::strcmp(action, kOfxActionLoad) == 0) return on_load();
  if (std::strcmp(action, kOfxActionDescribe) == 0) return describe(effect);
  if (std::strcmp(action, kOfxImageEffectActionDescribeInContext) == 0) return describe_in_context(effect);
  if (std::strcmp(action, kOfxImageEffectActionRender) == 0) return render(effect, in);
  return kOfxStatReplyDefault;
}

void set_host(OfxHost* host) { gHost = host; }

OfxPlugin gPlugin = {kOfxImageEffectPluginApi, 1, "com.premation.samples.ofxinvert", 1, 0, set_host, main_entry};  // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

}  // namespace

OFX_EXPORT int OfxGetNumberOfPlugins(void) { return 1; }
OFX_EXPORT OfxPlugin* OfxGetPlugin(int nth) { return nth == 0 ? &gPlugin : nullptr; }
