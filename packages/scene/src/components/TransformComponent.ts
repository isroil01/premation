/**
 * TransformComponent — every node owns exactly one. Holds the local transform
 * parts (position, rotation, scale, skew, anchor, size) and lazily computes the
 * local matrix. The world matrix is filled in by the TransformSystem, which
 * walks the hierarchy; dirty flags keep recomputation minimal.
 */

import type { Component, SerializedComponent } from './Component';
import { componentRegistry, deepCloneData } from './Component';
import type { Matrix2D, Vec2, Size } from '../types';
import { compose, identity } from '../utils/matrix';

const DEG2RAD = Math.PI / 180;

export interface TransformData {
  position: Vec2;
  /** Degrees. */
  rotation: number;
  scale: Vec2;
  /** Degrees (x, y). */
  skew: Vec2;
  anchor: Vec2;
  size: Size;
}

function defaults(): TransformData {
  return {
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    skew: { x: 0, y: 0 },
    anchor: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
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

  private readonly _local: Matrix2D = identity();
  private readonly _world: Matrix2D = identity();
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
  }

  // ── Mutators (mark dirty so matrices recompute) ─────────────────
  setPosition(x: number, y: number): void { this.position.x = x; this.position.y = y; this.markDirty(); }
  setRotation(deg: number): void { this.rotation = deg; this.markDirty(); }
  setScale(x: number, y: number): void { this.scale.x = x; this.scale.y = y; this.markDirty(); }
  setSkew(x: number, y: number): void { this.skew.x = x; this.skew.y = y; this.markDirty(); }
  setAnchor(x: number, y: number): void { this.anchor.x = x; this.anchor.y = y; this.markDirty(); }
  setSize(width: number, height: number): void { this.size.width = width; this.size.height = height; this.markDirty(); }

  /** Mark the local (and therefore world) matrix stale. */
  markDirty(): void {
    this._localDirty = true;
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
    });
  }

  serialize(): SerializedComponent {
    return {
      type: this.type,
      data: {
        position: { ...this.position },
        rotation: this.rotation,
        scale: { ...this.scale },
        skew: { ...this.skew },
        anchor: { ...this.anchor },
        size: { ...this.size },
      },
    };
  }
}

componentRegistry.register('transform', (data) =>
  new TransformComponent(deepCloneData(data) as Partial<TransformData>),
);
