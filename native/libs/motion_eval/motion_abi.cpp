// motion_abi — version + status names (include/motion/motion_abi.h).
//
// Lives in motion_eval because it is the bottom of the library dependency
// order (§3 of the plan): every other library links motion_eval, so every
// binary that contains any of them can answer `motion_abi_version()`.

#include "motion/motion_abi.h"

#include <cstdint>

extern "C" {

uint32_t motion_abi_version() { return MOTION_ABI_VERSION_PACKED; }

const char* motion_status_name(motion_status status) {
  switch (status) {
    case MOTION_OK:
      return "OK";
    case MOTION_INVALID_ARG:
      return "INVALID_ARG";
    case MOTION_OUT_OF_RANGE:
      return "OUT_OF_RANGE";
    case MOTION_INTERNAL:
      return "INTERNAL";
  }
  return "UNKNOWN";
}

}  // extern "C"
