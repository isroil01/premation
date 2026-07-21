/**
 * Rig — 2D skeletal deformation foundation (Phase 1: pure math).
 * Skeleton FK + bind pose, linear blend skinning, and IK solvers.
 */

export type { Mat2D } from './mat2d';
export { IDENTITY, fromTRS, multiply, apply, invert, angleOf } from './mat2d';

export type { Bone, Skeleton } from './skeleton';
export { computeWorldTransforms, computeBindInverses, boneTip, boneRoot } from './skeleton';

export type { VertexWeight, SkinVertex } from './skinning';
export { skinVertex, skinMesh, normalizeWeights } from './skinning';

export type { Vec2, TwoBoneSolution } from './ik';
export { solveTwoBone, solveFabrik, anglesFromJoints } from './ik';

export type { Mesh, Triangle, OutlinePoint } from './mesh';
export { flattenOutline, earClip, buildMesh, subdivide, polygonArea } from './mesh';

export type { BoneSegment } from './autoWeight';
export { distanceToSegment, boneSegments, autoWeightVertex, autoWeightMesh } from './autoWeight';
