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

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_SCENE_H */
