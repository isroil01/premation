/**
 * Named catalog of shader sources. Built-ins are pre-registered; custom shaders
 * (future user/plugin effects) register the same way. Open for extension.
 */

import { BUILTIN_SHADERS, type ShaderSource } from './builtin';

export class ShaderRegistry {
  private readonly sources = new Map<string, ShaderSource>();

  constructor(includeBuiltins = true) {
    if (includeBuiltins) for (const s of BUILTIN_SHADERS) this.register(s);
  }

  register(source: ShaderSource): void {
    this.sources.set(source.name, source);
  }

  get(name: string): ShaderSource | undefined {
    return this.sources.get(name);
  }

  require(name: string): ShaderSource {
    const s = this.sources.get(name);
    if (!s) throw new Error(`Shader "${name}" is not registered`);
    return s;
  }

  has(name: string): boolean {
    return this.sources.has(name);
  }

  names(): string[] {
    return [...this.sources.keys()];
  }
}
