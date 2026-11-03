/*
 * Premation native plugin SDK 1.1 — the composition's camera, lights and layer
 * transforms (docs/PLUGIN_SDK.md "The comp camera and lights").
 *
 * Read through PrHostSuite.get_comp_camera / get_comp_lights /
 * get_layer_transform during the render selectors. An effect that reads them
 * declares it in GLOBAL_SETUP (PR_OUT_FLAG_USES_CAMERA / _USES_LIGHTS /
 * _USES_LAYER_TRANSFORMS): the engine then evaluates them at the frame time,
 * and moving the camera (or a light, or a referenced layer) re-renders the
 * effect. The frame stays a pure function of the document.
 *
 * Space: the composition's 3D world in pixels, After Effects' convention —
 * +x right, +y DOWN, +z AWAY from the viewer; the comp's top-left at z = 0 is
 * the origin. Matrices are 4×4, column-major (m[col * 4 + row]).
 */
#ifndef PREMATION_SDK_PR_SCENE_H
#define PREMATION_SDK_PR_SCENE_H

#include "pr_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PrCamera {
  uint32_t struct_size; /* the caller sets sizeof(PrCamera); the host fills what fits */
  /* 0: the comp has no active camera layer; the fields describe the comp's
   * default view (After Effects' default 50 mm camera centred on the comp). */
  int32_t has_camera;
  int32_t orthographic; /* 1 = no perspective (an orthographic view) */
  int32_t dof_enabled;
  double world[16];      /* camera → world */
  double view[16];       /* world → camera (the inverse of `world`) */
  double projection[16]; /* camera → comp px: (P·v).xy / (P·v).w are comp pixels; z / w is depth 0..1 */
  double position[3];    /* the eye, world px */
  double zoom;           /* After Effects' Zoom: distance (px) at which 1 world px = 1 comp px */
  double fov_y;          /* vertical field of view, radians */
  double film_width;     /* the comp, px */
  double film_height;
  double focus_distance; /* px */
  double aperture;       /* px */
} PrCamera;

typedef enum PrLightType {
  PR_LIGHT_PARALLEL = 0,
  PR_LIGHT_SPOT = 1,
  PR_LIGHT_POINT = 2,
  PR_LIGHT_AMBIENT = 3
} PrLightType;

typedef struct PrLight {
  uint32_t struct_size;
  int32_t type;          /* PrLightType */
  double color[3];       /* linear 0..1 */
  double intensity;      /* 1 = 100% */
  double position[3];    /* world px (parallel: where it is aimed from) */
  double direction[3];   /* unit, the way the light travels (parallel, spot); 0 for point / ambient */
  double cone_angle;     /* spot: full cone, radians */
  double cone_feather;   /* spot: radians */
  int32_t falloff;       /* 0 none, 1 smooth, 2 inverse square clamped (After Effects' Falloff) */
  double falloff_distance;
  int32_t casts_shadows;
  double shadow_darkness;  /* 0..1 */
  double shadow_diffusion; /* px */
} PrLight;

/** The most lights get_comp_lights reports (the engine's light slots). */
#define PR_MAX_LIGHTS 32

/* ── SDK 1.2: other times (PrHostSuite.checkout_time) ──────────────────────
 * In SMART_PRE_RENDER an effect that declared PR_OUT_FLAG_SAMPLES_TIME asks
 * for what it will read at other times (trails, its own motion blur, a
 * simulation's history). The engine evaluates exactly those — the params,
 * the camera, the lights, the LAYER params' transforms; never a whole frame —
 * and they travel with the frame, so preview and export render the same
 * pixels. In the render selectors checkout_param / get_comp_camera /
 * get_comp_lights / get_layer_transform then answer for those times (a time
 * not asked for: PR_ERR_NOT_FOUND). Times are LAYER times. */
#define PR_SAMPLE_PARAMS (1u << 0)
#define PR_SAMPLE_CAMERA (1u << 1)
#define PR_SAMPLE_LIGHTS (1u << 2)
#define PR_SAMPLE_LAYER_TRANSFORMS (1u << 3)
#define PR_SAMPLE_ALL (PR_SAMPLE_PARAMS | PR_SAMPLE_CAMERA | PR_SAMPLE_LIGHTS | PR_SAMPLE_LAYER_TRANSFORMS)
/** SDK 1.2: the scene depth at that time (PrHostSuite.checkout_scene_depth_gpu_at / _at): the comp's
 *  3D layers and camera evaluated at it. Needs PR_OUT_FLAG_USES_SCENE_DEPTH; not in PR_SAMPLE_ALL
 *  (each time is a depth pass of its own: ask only for what you occlude with). */
#define PR_SAMPLE_SCENE_DEPTH (1u << 4)
/** The most distinct times one instance may check out per frame. */
#define PR_MAX_TIME_SAMPLES 1024

/* ── SDK 1.4 (D): geometry a plugin adds to the comp's 3D scene ────────────
 * In PR_CMD_SCENE_CONTRIBUTE (PR_OUT_FLAG_SCENE_CONTRIBUTE, on a 3D layer) the effect calls
 * scene_add_mesh / scene_add_light. Everything is in the LAYER's pixels — (0, 0) its top-left,
 * y down, z away from the camera — and the host places it with the layer's 3D transform. The host
 * draws the meshes in its 3D pass like any 3D layer: depth-tested against the comp's other 3D
 * layers, lit by its lights, casting and receiving shadows, with the camera's depth of field. */
typedef struct PrSceneMaterial {
  uint32_t struct_size;
  double base_color[4]; /* straight RGBA 0..1 (document sRGB) */
  double metallic;      /* 0..1 */
  double roughness;     /* 0..1 */
  int32_t casts_shadows;
  int32_t accepts_shadows;
} PrSceneMaterial;

typedef struct PrSceneMesh {
  uint32_t struct_size;
  const float* positions;  /* xyz per vertex, layer px */
  const float* normals;    /* xyz per vertex; NULL = flat, from the triangles */
  const float* uvs;        /* uv per vertex; NULL = 0 */
  uint32_t vertex_count;   /* ≤ PR_MAX_SCENE_VERTICES */
  const uint32_t* indices; /* triangles (3 per), each < vertex_count */
  uint32_t index_count;
  double transform[16];    /* mesh → layer px, column-major (identity = already in layer px) */
  PrSceneMaterial material;
} PrSceneMesh;

#define PR_MAX_SCENE_MESHES 64
#define PR_MAX_SCENE_VERTICES (1u << 20)

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_SCENE_H */
