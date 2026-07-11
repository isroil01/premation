/**
 * Component contract + registry. Nodes are composed of components
 * (composition over inheritance): behavior and data live in small, reusable
 * components rather than a deep class hierarchy. New component types can be
 * registered at runtime, so the engine is open for extension.
 */

export interface SerializedComponent {
  type: string;
  data: Record<string, unknown>;
}

export interface Component {
  /** Unique component type key (e.g. "transform", "fill"). */
  readonly type: string;
  /** Deep copy — used by node cloning/duplication. */
  clone(): Component;
  /** Plain, JSON-safe representation. */
  serialize(): SerializedComponent;
}

/** Deep-clone plain JSON data (components hold only serializable data). */
export function deepCloneData<T>(data: T): T {
  const sc = (globalThis as { structuredClone?: <V>(v: V) => V }).structuredClone;
  if (sc) return sc(data);
  return JSON.parse(JSON.stringify(data)) as T;
}

type Deserializer = (data: Record<string, unknown>) => Component;

/** Registry of component deserializers, keyed by component type. */
export class ComponentRegistry {
  private readonly map = new Map<string, Deserializer>();

  register(type: string, deserialize: Deserializer): void {
    this.map.set(type, deserialize);
  }

  has(type: string): boolean {
    return this.map.has(type);
  }

  deserialize(serialized: SerializedComponent): Component | null {
    const d = this.map.get(serialized.type);
    return d ? d(serialized.data) : null;
  }
}

/** The default, engine-wide component registry. */
export const componentRegistry = new ComponentRegistry();
