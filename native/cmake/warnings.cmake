# motion::options — the compile/link flags every MotionNative target links.
#
# The warning set is the one CLAUDE.md pins:
#   -Wall -Wextra -Wpedantic -Werror -Wshadow -Wconversion   (clang / gcc / emcc)
#   /W4 /WX + the same -W flags                               (clang-cl)
#
# Determinism (§2 of the plan): `-ffp-contract=off`. Clang's default
# (`-ffp-contract=on`) may fuse `a * b + c` into an FMA wherever the target has
# one — always on arm64 (Apple Silicon) — which changes the last bits of every
# bezier evaluation against a JavaScript engine's plain IEEE doubles. Off means
# the same bytes on x86-64, arm64 and wasm, which is the golden-gate contract.
# No -ffast-math anywhere, ever.

add_library(motion_options INTERFACE)
add_library(motion::options ALIAS motion_options)

if(MSVC)
  # clang-cl (and MSVC proper, if someone insists). CMake sets MSVC for clang-cl
  # because its front end is MSVC-style; the compiler id is still "Clang".
  target_compile_options(motion_options INTERFACE
    /W4 /WX
    /EHsc          # the C wrappers catch(...) — needs an exception model
    /permissive-   # standard-conforming lookup and two-phase templates
    /utf-8         # sources carry UTF-8 comments
  )
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    # clang-cl accepts GCC-style -W flags directly; other clang flags go
    # through /clang:. -Wpedantic is deliberately included (the CLAUDE.md set).
    target_compile_options(motion_options INTERFACE
      -Wshadow -Wconversion -Wpedantic
      /clang:-ffp-contract=off
    )
  else()
    target_compile_options(motion_options INTERFACE /fp:precise)
  endif()
else()
  target_compile_options(motion_options INTERFACE
    -Wall -Wextra -Wpedantic -Werror -Wshadow -Wconversion
    -ffp-contract=off
  )
endif()
