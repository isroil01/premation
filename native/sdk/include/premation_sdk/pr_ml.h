/*
 * Premation native plugin SDK — the ML suite (SDK 1.4, M): run an ONNX model
 * through the host.
 *
 * The host runs models on the engine's own ONNX Runtime build: DirectML on
 * Windows, Core ML on macOS, the CPU elsewhere (or when the GPU provider
 * cannot place the model). Every instance of every plugin shares one runtime
 * environment, and a model file opens once per process: sessions are cached by
 * the file's content hash.
 *
 * Models ship IN the bundle, under `models/` (covered by the bundle's
 * signature). The host never downloads one: ml_load takes a path relative to
 * the bundle, `models/<name>.onnx`, and refuses anything else.
 *
 * The callbacks are appended to PrHostSuite (pr_host.h). Check
 *     host->struct_size >= offsetof(PrHostSuite, ml_provider) + sizeof(void*)
 * before calling them; an older host has none, so keep a CPU path.
 *
 *   ml_load(host, "models/style.onnx", &model)   GLOBAL_SETUP, SEQUENCE_SETUP and the render
 *                                                 selectors; the same file is the same model id.
 *   ml_run(host, model, inputs, n, outputs, m)    the render selectors (RENDER, SMART_RENDER,
 *                                                 SMART_RENDER_GPU, SIM_STEP). Inputs are the
 *                                                 plugin's float tensors; the host fills each
 *                                                 output's data / count / shape with host-owned
 *                                                 memory valid until the selector returns.
 *   ml_provider(host, model, buf, cap)            "dml", "coreml", "cuda" or "cpu".
 *
 * A run is part of the selector: crash-guarded and under the watchdog like the
 * rest of the render. A run that fails returns PR_ERR_INTERNAL (with the
 * runtime's message in the plugin's log): draw the CPU path or pass through.
 */
#ifndef PREMATION_SDK_PR_ML_H
#define PREMATION_SDK_PR_ML_H

#include "pr_types.h"

#ifdef __cplusplus
extern "C" {
#endif

#define PR_TENSOR_MAX_RANK 8

/** One float32 tensor. Inputs: the plugin's array. Outputs: filled by the host. */
typedef struct PrTensor {
  uint32_t struct_size;
  /** The model's input / output name; NULL = by position. */
  const char* name;
  float* data;
  /** Elements (the product of the shape). */
  uint64_t count;
  int64_t shape[PR_TENSOR_MAX_RANK];
  uint32_t rank;
} PrTensor;

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_ML_H */
