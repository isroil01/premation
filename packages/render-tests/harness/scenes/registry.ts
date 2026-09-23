/**
 * Scene registry. Anchors + feature families, composed into one ordered list.
 * Kept explicit (not glob) so the set is reviewable and deterministic in order.
 */

import type { Scene } from '../sceneKit';
import flatBackground from './flatBackground';
import solidFill from './solidFill';
import linearGradientFill from './linearGradientFill';
import { shapeScenes } from './shapes';
import { strokeScenes } from './strokes';
import { strokeProfileScenes } from './strokeProfile';
import { strokeOptionScenes } from './strokeOptions';
import { blendModeScenes, matteModeScenes, alphaAddSeamScene } from './blendModes';
import { effectScenes } from './effects';
import { compositedScenes } from './composited';
import { interiorStyleScenes } from './interiorStyles';
import { textScenes } from './text';
import { textScaleVanishScenes, textScaleBisectScenes } from './textScaleVanish';
import { threeDScenes } from './threeD';
import { ssaoScenes } from './ssao';
import { motionScenes } from './motion';
import { precompScenes } from './precomp';
import { generativeScenes } from './generative';
import { hiresScenes } from './hires';
import { svgScenes } from './svg';
import { glassScenes } from './glass';
import { rigScenes } from './rig';
import { alphaInterpScenes } from './alphaInterp';
import { keyframeFamilyScenes } from './keyframeFamilies';
import { pluginEffectScenes } from './pluginEffects';
import { pluginKernelScenes } from './pluginKernels';
import { generatorLayerScenes } from './generatorLayers';
import { extrusionScenes } from './extrusion';
import { primitiveScenes } from './primitives';
import { modelMapScenes } from './modelMaps';
import { videoScenes } from './video';
import { nativeParityScenes } from './nativeParity';

export const SCENES: Scene[] = [
  // Anchors + fill probes.
  flatBackground,
  solidFill,
  linearGradientFill,
  // Feature families.
  ...shapeScenes,
  ...strokeScenes,
  ...strokeProfileScenes,
  // AE Stroke options (Composite, paint blend, units, dash pairs, gradient
  // points) — all new features, so first blesses, not re-blesses.
  ...strokeOptionScenes,
  ...blendModeScenes,
  // Registered as of the F10/F12 fix. Both families produce partial alpha in
  // the final composite, which is precisely what used to accumulate.
  ...matteModeScenes,
  alphaAddSeamScene,
  ...effectScenes,
  ...compositedScenes,
  ...interiorStyleScenes,
  ...textScenes,
  ...textScaleVanishScenes,
  ...textScaleBisectScenes,
  ...threeDScenes,
  // Ambient occlusion. Its own family rather than a member of the 3D one
  // because its subject is a COMPOSITION setting: the pair differs by a
  // field on the comp record, not by anything in the scene graph.
  ...ssaoScenes,
  // Extrusion. Separate from the 3D family because the subject is a real
  // multi-face SOLID rather than a plane in space, and the question these ask
  // — which of the synthesized faces an effect reached — has no meaning for a
  // single-quad 3D layer.
  ...extrusionScenes,
  ...modelMapScenes,
  // Parametric primitives. Beside extrusion because both are real solids, and
  // separate from it because their geometry is GENERATED rather than swept —
  // a sphere or a torus has no 2D outline the extrusion path could start from.
  ...primitiveScenes,
  // Footage. The only scene family whose pixels come out of a decoder, and
  // therefore the only golden coverage the video decode → upload path has.
  ...videoScenes,
  ...motionScenes,
  ...precompScenes,
  ...rigScenes,
  ...generativeScenes,
  ...hiresScenes,
  ...svgScenes,
  ...glassScenes,
  ...alphaInterpScenes,
  ...keyframeFamilyScenes,
  // Plugin effects. The only scenes that render a shader the host did not
  // write, and the only place the plugin path is exercised end to end.
  ...pluginEffectScenes,
  // Round C2's render-time capabilities: a GLSL+WGSL kernel reading the host
  // block, a CPU kernel on the raster path, two layer inputs, and an effect
  // that draws outside its own box. UNBLESSED — each carries a control
  // rendered in the same run, because a golden blessed while a feature was
  // inert records "the effect changes nothing" as the reference.
  ...pluginKernelScenes,
  // Plugin layer kinds: a generator's instanced draw, and a `shader` kind drawn
  // by the effect it names. Beside the plugin effects for the same reason those
  // exist — they are the only scenes that render content the host did not
  // write, and unit tests cannot tell "drew nothing" from "drew correctly".
  ...generatorLayerScenes,
  // D2/D3 native parity: 32 bpc, viewport overlays, the viewer LUT. No
  // references (fidelityOnly) — the gate is C++ vs TS WebGPU on the same FrameScene.
  ...nativeParityScenes,
];
