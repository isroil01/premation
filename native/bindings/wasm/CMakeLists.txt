# Emscripten glue: motion_wasm.mjs + motion_wasm.wasm (the `wasm` preset).
#
# Output is an ES6 module factory (`createMotionWasm()`) that runs in the
# browser, a worker and Node — the worker engine is the intended host, the
# Node environment is for the smoke test.

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "bindings/wasm needs the Emscripten toolchain: cmake --preset wasm (EMSDK must be set)")
endif()

add_executable(motion_wasm motion_wasm.cpp)
target_link_libraries(motion_wasm PRIVATE motion::eval motion::options)
set_target_properties(motion_wasm PROPERTIES OUTPUT_NAME "motion_wasm" SUFFIX ".mjs")

target_link_options(motion_wasm PRIVATE
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createMotionWasm
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sFILESYSTEM=0
  -sEXPORTED_FUNCTIONS=_malloc,_free      # the EMSCRIPTEN_KEEPALIVE symbols are added to this set
  -sEXPORTED_RUNTIME_METHODS=HEAPF64,UTF8ToString
  # The C wrappers catch(...). Emscripten disables catching by default (the
  # landing pads become no-ops); turn it back on so a thrown internal error
  # surfaces as MOTION_INTERNAL rather than a trap.
  -sDISABLE_EXCEPTION_CATCHING=0
)
