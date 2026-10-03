/**
 * The process-wide AnimationEngine instance — the TypeScript engine's live
 * animation (the page replica's, mirroring defaultSceneGraph). In its own
 * module so importing the class (a scratch engine) does not pull it in.
 */

import { AnimationEngine } from './AnimationEngine';

/** Process-wide default instance (mirrors defaultSceneGraph). */
export const defaultAnimation = new AnimationEngine();

export default defaultAnimation;
