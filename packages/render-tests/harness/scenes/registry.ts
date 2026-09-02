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
import { extrusionScenes } from './extrusion';
import { primitiveScenes } from './primitives';
import { modelMapScenes } from './modelMaps';
import { videoScenes } from './video';

export const SCENES: Scene[] = [
  // Anchors + fill probes.
  flatBackground,
  solidFill,
  linearGradientFill,
  // Feature families.
  ...shapeScenes,
  ...strokeScenes,
  ...strokeProfileScenes,
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
];
