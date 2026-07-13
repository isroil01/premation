/**
 * TransformComponent — every node owns exactly one. Holds the local transform
 * parts (position, rotation, scale, skew, anchor, size) and lazily computes the
 * local matrix. The world matrix is filled in by the TransformSystem, which
 * walks the hierarchy; dirty flags keep recomputation minimal.
 */

import type { Component, SerializedComponent } from './Component';
import { componentRegistry, deepCloneData } from './Component';
import type { Matrix2D, Matrix4, Vec2, Size } from '../types';
import { compose, identity } from '../utils/matrix';
import { compose as compose3D, fromMatrix2D, identity as identity4 } from '../utils/matrix4';

const DEG2RAD = Math.PI / 180;

export interface TransformData {
  position: Vec2;
  /** Degrees. Rotation about the view axis (z) — the 2D rotation. */
  rotation: number;
  scale: Vec2;
  /** Degrees (x, y). */
  skew: Vec2;
  anchor: Vec2;
  size: Size;

  // ── Optional 3D extension (default values keep the node purely 2D) ──
  /** Depth along the view axis. 0 = on the comp plane. */
  positionZ?: number;
  /** Degrees, rotation about the x axis (tilt). */
  rotationX?: number;
  /** Degrees, rotation about the y axis (pan). */
  rotationY?: number;
  /** Depth scale. 1 = none. */
  scaleZ?: number;
  /** Depth anchor. */
  anchorZ?: number;
}

function defaults(): TransformData {
  return {
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    skew: { x: 0, y: 0 },
    anchor: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    positionZ: 0,
    rotationX: 0,
    rotationY: 0,
    scaleZ: 1,
    anchorZ: 0,
  };
}

export class TransformComponent implements Component {
  readonly type = 'transform';

  readonly position: Vec2;
  rotation: number;
  readonly scale: Vec2;
  readonly skew: Vec2;
  readonly anchor: Vec2;
  readonly size: Size;

  // ── 3D extension (default = 2D) ──
  positionZ: number;
  rotationX: number;
  rotationY: number;
  scaleZ: number;
  anchorZ: number;

  private readonly _local: Matrix2D = identity();
  private readonly _world: Matrix2D = identity();
  private readonly _local4: Matrix4 = identity4();
  private _local4Dirty = true;
  private _localDirty = true;
  /** Set by the TransformSystem when an ancestor's world matrix changes. */
  worldDirty = true;
  /** Wired by the Scene to emit TransformChanged (null = detached). */
  onChange: (() => void) | null = null;

  constructor(data: Partial<TransformData> = {}) {
    const d = { ...defaults(), ...data };
    this.position = { ...d.position };
    this.rotation = d.rotation;
    this.scale = { ...d.scale };
    this.skew = { ...d.skew };
    this.anchor = { ...d.anchor };
    this.size = { ...d.size };
    this.positionZ = d.positionZ ?? 0;
    this.rotationX = d.rotationX ?? 0;
    this.rotationY = d.rotationY ?? 0;
    this.scaleZ = d.scaleZ ?? 1;
    this.anchorZ = d.anchorZ ?? 0;
  }

  // ── Mutators (mark dirty so matrices recompute) ─────────────────
  setPosition(x: number, y: number): void { this.position.x = x; this.position.y = y; this.markDirty(); }
  setRotation(deg: number): void { this.rotation = deg; this.markDirty(); }
  setScale(x: number, y: number): void { this.scale.x = x; this.scale.y = y; this.markDirty(); }
  setSkew(x: number, y: number): void { this.skew.x = x; this.skew.y = y; this.markDirty(); }
  setAnchor(x: number, y: number): void { this.anchor.x = x; this.anchor.y = y; this.markDirty(); }
  setSize(width: number, height: number): void { this.size.width = width; this.size.height = height; this.markDirty(); }
  setPositionZ(z: number): void { this.positionZ = z; this.markDirty(); }
  setRotationX(deg: number): void { this.rotationX = deg; this.markDirty(); }
  setRotationY(deg: number): void { this.rotationY = deg; this.markDirty(); }
  setScaleZ(z: number): void { this.scaleZ = z; this.markDirty(); }
  setAnchorZ(z: number): void { this.anchorZ = z; this.markDirty(); }

  /**
   * True when any 3D field departs from its 2D default. Pure-2D nodes stay on
   * the affine fast path; only these render through the camera projection.
   */
  get is3D(): boolean {
    return (
      this.positionZ !== 0 ||
      this.rotationX !== 0 ||
      this.rotationY !== 0 ||
      this.scaleZ !== 1 ||
      this.anchorZ !== 0
    );
  }

  /** Mark the local (and therefore world) matrix stale. */
  markDirty(): void {
    this._localDirty = true;
    this._local4Dirty = true;
    this.worldDirty = true;
    this.onChange?.();
  }

  /** The cached local matrix, recomputed only when dirty. */
  getLocalMatrix(): Readonly<Matrix2D> {
    if (this._localDirty) {
      compose(
        {
          position: this.position,
          rotation: this.rotation * DEG2RAD,
          scale: this.scale,
          skew: { x: this.skew.x * DEG2RAD, y: this.skew.y * DEG2RAD },
          anchor: this.anchor,
        },
        this._local,
      );
      this._localDirty = false;
    }
    return this._local;
  }

  /**
   * The cached local **4x4** matrix. For a pure-2D node this is just the affine
   * local lifted into 4x4 (so 2D and 3D consumers stay perfectly consistent);
   * for a 3D node it is composed from the full 3D parts. Recomputed only when
   * dirty.
   */
  getLocalMatrix4(): Readonly<Matrix4> {
    if (this._local4Dirty) {
      if (this.is3D) {
        compose3D(
          {
            position: { x: this.position.x, y: this.position.y, z: this.positionZ },
            rotation: { x: this.rotationX * DEG2RAD, y: this.rotationY * DEG2RAD, z: this.rotation * DEG2RAD },
            scale: { x: this.scale.x, y: this.scale.y, z: this.scaleZ },
            anchor: { x: this.anchor.x, y: this.anchor.y, z: this.anchorZ },
          },
          this._local4,
        );
      } else {
        fromMatrix2D(this.getLocalMatrix(), this._local4);
      }
      this._local4Dirty = false;
    }
    return this._local4;
  }

  /** Mutable handle to the world-matrix cache (written by TransformSystem). */
  worldMatrixRef(): Matrix2D {
    return this._world;
  }

  getWorldMatrix(): Readonly<Matrix2D> {
    return this._world;
  }

  clone(): TransformComponent {
    return new TransformComponent({
      position: { ...this.position },
      rotation: this.rotation,
      scale: { ...this.scale },
      skew: { ...this.skew },
      anchor: { ...this.anchor },
      size: { ...this.size },
      positionZ: this.positionZ,
      rotationX: this.rotationX,
      rotationY: this.rotationY,
      scaleZ: this.scaleZ,
      anchorZ: this.anchorZ,
    });
  }

  serialize(): SerializedComponent {
    const data: Record<string, unknown> = {
      position: { ...this.position },
      rotation: this.rotation,
      scale: { ...this.scale },
      skew: { ...this.skew },
      anchor: { ...this.anchor },
      size: { ...this.size },
    };
    // Only persist the 3D block for 3D nodes — keeps 2D output byte-stable.
    if (this.is3D) {
      data.positionZ = this.positionZ;
      data.rotationX = this.rotationX;
      data.rotationY = this.rotationY;
      data.scaleZ = this.scaleZ;
      data.anchorZ = this.anchorZ;
    }
    return { type: this.type, data };
  }
}

componentRegistry.register('transform', (data) =>
  new TransformComponent(deepCloneData(data) as Partial<TransformData>),
);
