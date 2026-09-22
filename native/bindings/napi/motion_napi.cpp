// N-API addon over include/motion (node-addon-api, exceptions disabled).
//
//   abiVersion(): number
//   sampleScalar(packed: Float64Array, t: number): number
//   sampleScalarBatch(packed: Float64Array, times: Float64Array): Float64Array
//
// `packed` is MOTION_KEYFRAME_PACKED_DOUBLES doubles per keyframe (see
// motion_eval.h and packages/native-bridge/src/packed.ts). A non-OK status
// becomes a thrown JavaScript Error whose message is "<STATUS>: <reason>".

#include <napi.h>

#include <cstddef>
#include <cstdint>
#include <string>

#include "motion/motion_abi.h"
#include "motion/motion_eval.h"

namespace {

bool is_float64_array(const Napi::Value& v) {
  return v.IsTypedArray() && v.As<Napi::TypedArray>().TypedArrayType() == napi_float64_array;
}

void throw_status(const Napi::Env& env, motion_status st, const motion_error& err) {
  std::string msg = motion_status_name(st);
  msg += ": ";
  msg += err.message;
  Napi::Error::New(env, msg).ThrowAsJavaScriptException();
}

Napi::Value AbiVersion(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), static_cast<double>(motion_abi_version()));
}

Napi::Value SampleScalar(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 2 || !is_float64_array(info[0]) || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "sampleScalar(packed: Float64Array, t: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const Napi::Float64Array packed = info[0].As<Napi::Float64Array>();
  const std::size_t len = packed.ElementLength();
  if (len == 0 || len % MOTION_KEYFRAME_PACKED_DOUBLES != 0) {
    Napi::RangeError::New(env, "packed length must be a positive multiple of 10")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double t = info[1].As<Napi::Number>().DoubleValue();
  double out = 0.0;
  motion_error err{};
  const motion_status st = motion_eval_sample_scalar_packed(
      packed.Data(), len / MOTION_KEYFRAME_PACKED_DOUBLES, t, &out, &err);
  if (st != MOTION_OK) {
    throw_status(env, st, err);
    return env.Undefined();
  }
  return Napi::Number::New(env, out);
}

Napi::Value SampleScalarBatch(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 2 || !is_float64_array(info[0]) || !is_float64_array(info[1])) {
    Napi::TypeError::New(env, "sampleScalarBatch(packed: Float64Array, times: Float64Array)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const Napi::Float64Array packed = info[0].As<Napi::Float64Array>();
  const Napi::Float64Array times = info[1].As<Napi::Float64Array>();
  const std::size_t len = packed.ElementLength();
  if (len == 0 || len % MOTION_KEYFRAME_PACKED_DOUBLES != 0) {
    Napi::RangeError::New(env, "packed length must be a positive multiple of 10")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::size_t n = times.ElementLength();
  Napi::Float64Array result = Napi::Float64Array::New(env, n);
  motion_error err{};
  const motion_status st = motion_eval_sample_scalar_packed_batch(
      packed.Data(), len / MOTION_KEYFRAME_PACKED_DOUBLES, times.Data(), n, result.Data(), &err);
  if (st != MOTION_OK) {
    throw_status(env, st, err);
    return env.Undefined();
  }
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("abiVersion", Napi::Function::New(env, AbiVersion, "abiVersion"));
  exports.Set("sampleScalar", Napi::Function::New(env, SampleScalar, "sampleScalar"));
  exports.Set("sampleScalarBatch", Napi::Function::New(env, SampleScalarBatch, "sampleScalarBatch"));
  exports.Set("packedDoubles", Napi::Number::New(env, MOTION_KEYFRAME_PACKED_DOUBLES));
  return exports;
}

}  // namespace

NODE_API_MODULE(motion_napi, Init)
