/**
 * Data components — the styling/content/behavior data a node can carry
 * (Fill, Stroke, Shadow, Blur, Mask, Text, Media, Camera, Light, Particle,
 * Gradient, Physics, Animation…). They hold only JSON-safe data; behavior lives
 * in the systems that read them. A single {@link DataComponent} class handles
 * them all, and any new type can be registered with one line — the engine is
 * open for extension without new classes.
 */

import type { Component, SerializedComponent } from './Component';
import { componentRegistry, deepCloneData } from './Component';

export class DataComponent implements Component {
  constructor(
    public readonly type: string,
    public data: Record<string, unknown>,
  ) {}

  get<T>(key: string, fallback: T): T {
    const v = this.data[key];
    return v === undefined ? fallback : (v as T);
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
  }

  clone(): DataComponent {
    return new DataComponent(this.type, deepCloneData(this.data));
  }

  serialize(): SerializedComponent {
    return { type: this.type, data: deepCloneData(this.data) };
  }
}

/** Built-in data-component types and their default data. */
export const DATA_COMPONENT_DEFAULTS: Record<string, Record<string, unknown>> = {
  fill: { color: '#ffffff', opacity: 1 },
  stroke: { color: '#000000', width: 1, opacity: 1, align: 'center' },
  shadow: { color: 'rgba(0,0,0,0.5)', x: 0, y: 4, blur: 8, spread: 0 },
  blur: { radius: 0 },
  mask: { mode: 'alpha', inverted: false, feather: 0 },
  gradient: { kind: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] },
  visibility: { hidden: false, culled: false },
  text: { content: '', fontFamily: 'Inter', fontSize: 48, fontWeight: 400, lineHeight: 1.2, letterSpacing: 0, align: 'left', color: '#ffffff' },
  media: { src: '', mime: '', naturalWidth: 0, naturalHeight: 0 },
  camera: { zoom: 1, depthOfField: false, focusDistance: 1000, aperture: 5.6 },
  light: { kind: 'point', color: '#ffffff', intensity: 1, radius: 500 },
  particle: { emitter: 'point', rate: 60, lifetime: 2, gravity: 0, spread: 30 },
  physics: { bodyType: 'dynamic', mass: 1, restitution: 0.2, friction: 0.5 },
  animation: { tracks: [] as unknown[] },
  effects: { list: [] as unknown[] },
};

/** Create a built-in data component, merged over its registered defaults. */
export function createComponent(type: string, data: Record<string, unknown> = {}): DataComponent {
  return new DataComponent(type, { ...(DATA_COMPONENT_DEFAULTS[type] ?? {}), ...data });
}

// Register every built-in data component with the deserializer registry.
for (const type of Object.keys(DATA_COMPONENT_DEFAULTS)) {
  componentRegistry.register(type, (data) =>
    new DataComponent(type, { ...DATA_COMPONENT_DEFAULTS[type], ...data }),
  );
}

/**
 * Create (and lazily register) a fully custom component type. Enables plugins /
 * future features to store their own component data on any node.
 */
export function customComponent(type: string, data: Record<string, unknown> = {}): DataComponent {
  if (!componentRegistry.has(type)) {
    componentRegistry.register(type, (d) => new DataComponent(type, d));
  }
  return new DataComponent(type, data);
}

// Named convenience creators for the common components.
export const Fill = (d?: Record<string, unknown>): DataComponent => createComponent('fill', d);
export const Stroke = (d?: Record<string, unknown>): DataComponent => createComponent('stroke', d);
export const Shadow = (d?: Record<string, unknown>): DataComponent => createComponent('shadow', d);
export const Blur = (d?: Record<string, unknown>): DataComponent => createComponent('blur', d);
export const Mask = (d?: Record<string, unknown>): DataComponent => createComponent('mask', d);
export const Gradient = (d?: Record<string, unknown>): DataComponent => createComponent('gradient', d);
export const Text = (d?: Record<string, unknown>): DataComponent => createComponent('text', d);
export const Media = (d?: Record<string, unknown>): DataComponent => createComponent('media', d);
export const Camera = (d?: Record<string, unknown>): DataComponent => createComponent('camera', d);
export const Light = (d?: Record<string, unknown>): DataComponent => createComponent('light', d);
export const Particle = (d?: Record<string, unknown>): DataComponent => createComponent('particle', d);
export const Physics = (d?: Record<string, unknown>): DataComponent => createComponent('physics', d);
