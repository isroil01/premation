# Vendored third-party code

Small, permissively licensed decoders compiled into `premation-engine` (the
model importer, `engine/src/scene/model_convert*.cpp`). Everything larger comes
from the vcpkg manifest (`native/vcpkg.json`). Each directory keeps its upstream
licence file; the files are unmodified copies.

| Directory | Upstream | Revision | Licence | Used for |
| --- | --- | --- | --- | --- |
| `meshoptimizer/` (`vertexcodec.cpp`, `indexcodec.cpp`, `vertexfilter.cpp`, `meshoptimizer.h`) | https://github.com/zeux/meshoptimizer | c313abae7de39cc928966e53b7cb405f04bde45e | MIT | glTF `EXT_meshopt_compression` / `KHR_meshopt_compression` buffer views |
| `ufbx/` (`ufbx.c`, `ufbx.h`) | https://github.com/ufbx/ufbx | 5955c5c0b042ac2dc6f32955ab206aaec0620cfc | MIT or public domain (Unlicense) | FBX import |

To update one: copy the same files from a newer upstream revision, update the
revision column, and rebuild `engine_model_tests`.
