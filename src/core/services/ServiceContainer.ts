/**
 * Service container — a small dependency-injection surface for the app.
 *
 * Engines (Scene Graph, Animation, Rendering, Timeline, AI) register their
 * services here. The UI layer queries them through `services.get(name)`.
 * Services never import the UI layer.
 */

export interface ServiceContainer {
  register<T>(name: string, service: T): void;
  unregister(name: string): void;
  get<T = unknown>(name: string): T | undefined;
  has(name: string): boolean;
  names(): ReadonlyArray<string>;
}

export function createServiceContainer(): ServiceContainer {
  const map = new Map<string, unknown>();
  return {
    register<T>(name: string, service: T): void {
      map.set(name, service);
    },
    unregister(name: string): void {
      map.delete(name);
    },
    get<T = unknown>(name: string): T | undefined {
      return map.get(name) as T | undefined;
    },
    has(name: string): boolean {
      return map.has(name);
    },
    names(): ReadonlyArray<string> {
      return Array.from(map.keys());
    },
  };
}
