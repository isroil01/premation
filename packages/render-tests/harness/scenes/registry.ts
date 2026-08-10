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
import { threeDScenes } from './threeD';
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
  ...threeDScenes,
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
