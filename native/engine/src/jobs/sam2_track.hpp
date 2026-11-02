// SAM 2.1 video tracking with memory (AE parity Step 3.1) — the pure half.
//
// The model is the square-zero-labs/sam2.1-tiny-video-onnx export of
// facebook/sam2.1-hiera-tiny (Apache-2.0), five graphs (sam2_ort_ffi.cpp runs
// them through ONNX Runtime; this file never sees the runtime):
//
//   vision_encoder    pixel_values [1,3,1024,1024] → feats0 [1,32,256,256],
//                     feats1 [1,64,128,128], feats2 [1,256,64,64] (raw),
//                     feats2_no_mem (the first frame's), vision_pos_embed
//   mask_decoder      feats0, feats1, feats2_cond, input_points [1,1,N,2]
//                     (1024² input px), input_labels [1,1,N] i32 (1 fg, 0 bg,
//                     2/3 box corners, -1 padding) → high_res_mask
//                     [1,1,1024,1024] logits, iou, object_score_logits,
//                     object_pointer [1,1,256] (occlusion-gated in the graph)
//   memory_encoder    feats2, high_res_mask, object_score_logits [1,1],
//                     binarize → memory_tokens / memory_pos [4096,1,64]
//   memory_attention  current feats + pos [4096,1,256], memory / memory_pos
//                     [28736,1,64] (7 spatial blocks of 4096 + 64 pointer
//                     tokens) → conditioned_feats [1,256,64,64]
//   pointer_tpos      normalized_diffs [P] → pointer_pos [P,64]
//
// The tracker keeps SAM 2's memory bank: every prompted frame (the first
// click, every correction stroke) is a CONDITIONING frame; every other frame
// adds its memory to a ring of the last six. Each frame attends to up to
// three conditioning frames (closest first) and the most recent memories,
// with SAM 2's temporal position rows (conditioning = row 6, a memory k
// frames back = row k-1), plus up to 16 object pointers. The fixed-shape
// graph wants exactly 7 blocks and 16 pointers: missing ones repeat the last
// (as the export's reference loop does).
#pragma once

#include <array>
#include <cstdint>
#include <deque>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace premation::jobs::sam2 {

inline constexpr int kInput = 1024;
inline constexpr int kFeat = 64;
inline constexpr std::size_t kTokens = std::size_t{kFeat} * kFeat;  // 4096
inline constexpr std::size_t kHidden = 256;
inline constexpr std::size_t kMemDim = 64;
inline constexpr std::size_t kMaskMem = 7;        // spatial memory blocks the graph takes
inline constexpr std::size_t kMaxPointers = 16;   // object pointers the graph takes
inline constexpr std::size_t kPointerSplit = kHidden / kMemDim;  // 4 tokens per pointer
inline constexpr std::size_t kMemoryTokens = kMaskMem * kTokens + kMaxPointers * kPointerSplit;  // 28736
inline constexpr std::size_t kMaxCondInAttention = 3;
inline constexpr std::size_t kRecentMemories = kMaskMem - 1;  // 6
inline constexpr std::size_t kHighRes = std::size_t{kInput} * kInput;

/// The five graph files plus constants.json, in a model folder.
inline constexpr std::array<const char*, 6> kModelFiles{"vision_encoder.onnx", "mask_decoder.onnx", "memory_encoder.onnx",
                                                        "memory_attention.onnx", "pointer_tpos.onnx", "constants.json"};

/// constants.json: the temporal position table and the normalization.
struct Constants {
  std::array<float, kMaskMem * kMemDim> tpos{};
  std::array<float, 3> mean{0.485F, 0.456F, 0.406F};
  std::array<float, 3> stdev{0.229F, 0.224F, 0.225F};
};
/// Parse constants.json; nullopt (with `error`) when the shapes are not the 7×64 table this tracker assumes.
[[nodiscard]] std::optional<Constants> parse_constants(std::string_view json, std::string& error);

/// Straight RGBA8 → the encoder input: the frame squashed to 1024² (bilinear,
/// SAM 2 does not letterbox), /255, mean/std, NCHW. 3·1024² floats into `out`.
void preprocess(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height, const Constants& c,
                std::vector<float>& out);

/// [1,C,64,64] → [4096,1,C] (SAM 2's flatten(2).permute(2,0,1)).
void to_tokens(std::span<const float> nchw, std::size_t channels, std::vector<float>& out);

/// The 1024² logits → a width×height soft matte in [0,1] (bilinear in logit space, then the logistic).
void logits_to_alpha(std::span<const float> logits, std::uint32_t width, std::uint32_t height, std::vector<float>& out);

struct Vision {
  std::vector<float> feats0, feats1, feats2, feats2NoMem, pos;
};
struct Decoded {
  std::vector<float> highRes;  ///< [1024²] logits
  float iou = 0;
  float objectScore = 0;
  std::vector<float> pointer;  ///< [256]
};
struct Memory {
  std::vector<float> tokens;  ///< [4096·64]
  std::vector<float> pos;     ///< [4096·64]
};

/// The five graphs (sam2_ort_ffi.cpp; tests fake it). False with `error`.
class Models {
 public:
  Models() = default;
  virtual ~Models() = default;
  Models(const Models&) = delete;
  Models& operator=(const Models&) = delete;
  Models(Models&&) = delete;
  Models& operator=(Models&&) = delete;

  [[nodiscard]] virtual std::string provider() const = 0;
  virtual bool encode(std::span<const float> pixels, Vision& out, std::string& error) = 0;
  /// `points` = x, y pairs in 1024² input px; one label each.
  virtual bool decode(const Vision& v, std::span<const float> featsCond, std::span<const float> points,
                      std::span<const std::int32_t> labels, Decoded& out, std::string& error) = 0;
  virtual bool encode_memory(std::span<const float> feats2, std::span<const float> highRes, float objectScore, bool binarize,
                             Memory& out, std::string& error) = 0;
  /// `features` / `pos` as tokens [4096,1,256]; `memory` / `memoryPos` [28736,1,64].
  virtual bool attend(std::span<const float> features, std::span<const float> pos, std::span<const float> memory,
                      std::span<const float> memoryPos, std::vector<float>& conditioned, std::string& error) = 0;
  virtual bool pointer_pos(std::span<const float> normalizedDiffs, std::vector<float>& out, std::string& error) = 0;
};

/// A prompt in FRAME pixels: label 1 fg, 0 bg, 2 / 3 a box's corners.
struct Prompt {
  double x = 0;
  double y = 0;
  int label = 1;
};

/// What the bank hands memory attention for one frame (built by MemoryBank::assemble).
struct Assembled {
  std::vector<float> memory;       ///< [28736·64]
  std::vector<float> memoryPos;    ///< [28736·64] (pointer rows filled by the caller's pointer_pos)
  std::vector<float> pointerDiffs; ///< [16], normalized
  /// For tests: which stored frame each spatial block came from, and its temporal row.
  std::array<std::int64_t, kMaskMem> blockFrame{};
  std::array<int, kMaskMem> blockRow{};
  std::array<std::int64_t, kMaxPointers> pointerFrame{};
};

class MemoryBank {
 public:
  /// `frameCount` = the walk's length (SAM 2 normalizes pointer offsets by min(count, 16) - 1).
  explicit MemoryBank(std::size_t frameCount) : frameCount_(frameCount) {}

  [[nodiscard]] bool empty() const noexcept { return cond_.empty() && recent_.empty(); }
  void add(std::int64_t step, Memory mem, std::vector<float> pointer, bool conditioning);
  /// The memory for step `step` (> every stored step); false when the bank is empty.
  bool assemble(std::int64_t step, const Constants& c, Assembled& out) const;
  /// Write the pointer position rows (pointer_pos's [16,64]) into `out.memoryPos`.
  static void place_pointer_pos(std::span<const float> pointerPos, Assembled& out);

 private:
  struct Entry {
    std::int64_t step = 0;
    Memory mem;
    std::vector<float> pointer;
  };
  std::size_t frameCount_;
  std::vector<Entry> cond_;
  std::deque<Entry> recent_;     // newest at the back, at most kRecentMemories
  std::deque<Entry> pointers_;   // non-conditioning pointers, newest at the back, at most kMaxPointers - 1
};

/// One tracked frame's result.
struct FrameResult {
  std::vector<float> alpha;  ///< width×height soft matte
  float iou = 0;
  float objectScore = 0;
  bool conditioning = false;
  double encodeMs = 0, attendMs = 0, decodeMs = 0, memoryMs = 0;
};

/// What a walk's first (origin) frame left: its memory, pointer and matte. A
/// second walk from the same origin (the other direction) starts from it
/// instead of encoding and segmenting the origin frame again.
struct Origin {
  Memory mem;
  std::vector<float> pointer;
  std::vector<float> alpha;
  float iou = 0;
  float objectScore = 0;
};

/// The walk: frames in the order they are tracked, prompts where the user gave them.
class Tracker {
 public:
  Tracker(Models& models, Constants constants, std::size_t frameCount)
      : models_(models), constants_(std::move(constants)), bank_(frameCount) {}

  /// After the first step: the origin frame's memory and matte (nullopt before it).
  [[nodiscard]] const std::optional<Origin>& origin() const noexcept { return origin_; }
  /// Start this (fresh) tracker from another walk's origin: its memory is the first conditioning
  /// frame and the step count is 1, as if step() had run on that frame. False when not fresh.
  bool start_from(const Origin& o);

  /// Track the next frame of the walk (RGBA8 width×height). `prompts` non-empty
  /// makes it a conditioning frame (required on the first). `mask` (width×height,
  /// 0…1) makes the frame's matte the user's own — SAM 2's add_new_mask: it is the
  /// output and goes into memory as given (the prompts only find the object
  /// pointer). False with `error`.
  bool step(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height, std::span<const Prompt> prompts,
            FrameResult& out, std::string& error, std::span<const float> mask = {});
  [[nodiscard]] std::int64_t steps() const noexcept { return step_; }

 private:
  Models& models_;
  Constants constants_;
  MemoryBank bank_;
  std::int64_t step_ = 0;
  std::optional<Origin> origin_;
  // Reused buffers: a walk runs hundreds of frames.
  std::vector<float> pixels_, tokens_, posTokens_, conditioned_, pointerPos_;
  Vision vision_;
  Assembled assembled_;
};

/// The model folder holds every file kModelFiles names.
[[nodiscard]] bool installed(const std::string& dir);

/// Load the five graphs from `dir` (sam2_ort_ffi.cpp). Null with `error`.
[[nodiscard]] std::unique_ptr<Models> load(const std::string& dir, std::string& error);
/// Read and parse `<dir>/constants.json`.
[[nodiscard]] std::optional<Constants> load_constants(const std::string& dir, std::string& error);

}  // namespace premation::jobs::sam2
