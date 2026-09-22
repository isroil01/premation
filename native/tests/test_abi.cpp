// motion_abi.h — version + status names.

#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "motion/motion_abi.h"
#include "motion/motion_eval.h"  // motion_keyframe + MOTION_KEYFRAME_PACKED_DOUBLES

TEST_CASE("motion_abi_version packs MAJOR.MINOR", "[abi]") {
  const std::uint32_t v = motion_abi_version();
  CHECK((v >> 16u) == static_cast<std::uint32_t>(MOTION_ABI_VERSION_MAJOR));
  CHECK((v & 0xFFFFu) == static_cast<std::uint32_t>(MOTION_ABI_VERSION_MINOR));
  CHECK(v == MOTION_ABI_VERSION_PACKED);
}

TEST_CASE("motion_status_name is total", "[abi]") {
  CHECK(std::strcmp(motion_status_name(MOTION_OK), "OK") == 0);
  CHECK(std::strcmp(motion_status_name(MOTION_INVALID_ARG), "INVALID_ARG") == 0);
  CHECK(std::strcmp(motion_status_name(MOTION_OUT_OF_RANGE), "OUT_OF_RANGE") == 0);
  CHECK(std::strcmp(motion_status_name(MOTION_INTERNAL), "INTERNAL") == 0);
  // No out-of-range probe: forging a motion_status outside its enumerators is
  // exactly what UBSan's -fsanitize=enum rejects, and the suite runs under it.
}

TEST_CASE("motion_keyframe is a plain 72-byte record with no padding", "[abi]") {
  // The packed Float64Array layout and the struct layout are both ABI. If this
  // changes, MOTION_ABI_VERSION_MAJOR changes with it.
  // (An earlier version claimed 64 bytes; the fields sum to 8+8+4+4+6*8 = 72.
  // The first CI compile caught it.)
  STATIC_CHECK(sizeof(motion_keyframe) == 72);
  STATIC_CHECK(alignof(motion_keyframe) == 8);
  STATIC_CHECK(offsetof(motion_keyframe, t) == 0);
  STATIC_CHECK(offsetof(motion_keyframe, value) == 8);
  STATIC_CHECK(offsetof(motion_keyframe, easing) == 16);
  STATIC_CHECK(offsetof(motion_keyframe, flags) == 20);
  STATIC_CHECK(offsetof(motion_keyframe, c0) == 24);
  STATIC_CHECK(offsetof(motion_keyframe, c3) == 48);
  STATIC_CHECK(offsetof(motion_keyframe, si) == 56);
  STATIC_CHECK(offsetof(motion_keyframe, so) == 64);
  STATIC_CHECK(MOTION_KEYFRAME_PACKED_DOUBLES == 10);
  STATIC_CHECK(sizeof(motion_error) == MOTION_ERROR_MESSAGE_CAP);
}
