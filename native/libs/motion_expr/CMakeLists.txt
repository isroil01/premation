# motion_expr — the property-expression language (packages/animation/src/
# exprLang.ts + expressions.ts + sourceText.ts), with its C ABI in
# include/motion/motion_expr.h. Depends on motion_jsmath (V8-exact Math and
# number formatting) and motion_eval (the ABI version/status symbols).

add_library(motion_expr STATIC
  expr.cpp
  interp.cpp
  keys.cpp
  ops.cpp
  parser.cpp
  sourcetext.cpp
  stdlib.cpp
  motion_expr.cpp
)
add_library(motion::expr ALIAS motion_expr)
target_include_directories(motion_expr
  PUBLIC  ${PROJECT_SOURCE_DIR}/include ${CMAKE_CURRENT_SOURCE_DIR}
)
target_compile_features(motion_expr PUBLIC cxx_std_20)
target_link_libraries(motion_expr PUBLIC motion::jsmath motion::eval PRIVATE motion::options)
