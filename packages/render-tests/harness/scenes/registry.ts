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
import { blendModeScenes } from './blendModes';
import { effectScenes } from './effects';
import { compositedScenes } from './composited';
import { textScenes } from './text';
import { threeDScenes } from './threeD';
import { motionScenes } from './motion';
import { precompScenes } from './precomp';
import { generativeScenes } from './generative';
import { hiresScenes } from './hires';

export const SCENES: Scene[] = [
  // Anchors + fill probes.
  flatBackground,
  solidFill,
  linearGradientFill,
  // Feature families.
  ...shapeScenes,
  ...strokeScenes,
  ...blendModeScenes,
  ...effectScenes,
  ...compositedScenes,
  ...textScenes,
  ...threeDScenes,
  ...motionScenes,
  ...precompScenes,
  ...generativeScenes,
  ...hiresScenes,
];
