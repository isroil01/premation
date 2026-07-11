import type { ID } from '../types';
import type { ReactNode } from 'react';

export type PropertyEditorRender = (params: {
  value: unknown;
  onChange: (v: unknown) => void;
  nodeId?: ID;
  componentId?: ID;
  propName?: string;
}) => ReactNode;

type Key = string; // `${componentType}::${propName}`

export class PropertyRegistry {
  private map = new Map<Key, PropertyEditorRender>();

  private key(componentType: string, propName: string): Key {
    return `${componentType}::${propName}`;
  }

  register(componentType: string, propName: string, render: PropertyEditorRender): void {
    this.map.set(this.key(componentType, propName), render);
  }

  unregister(componentType: string, propName: string): void {
    this.map.delete(this.key(componentType, propName));
  }

  /** Remove all registered editors. */
  clear(): void {
    this.map.clear();
  }

  get(componentType: string, propName: string): PropertyEditorRender | undefined {
    const exact = this.map.get(this.key(componentType, propName));
    if (exact) return exact;
    const compAny = this.map.get(this.key(componentType, '*'));
    if (compAny) return compAny;
    const anyProp = this.map.get(this.key('*', propName));
    if (anyProp) return anyProp;
    return this.map.get(this.key('*', '*'));
  }
}

export const propertyRegistry = new PropertyRegistry();

export default propertyRegistry;
