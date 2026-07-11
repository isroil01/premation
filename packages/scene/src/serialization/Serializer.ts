/**
 * Serialization — versioned, JSON-safe, and migration-ready. A whole project
 * round-trips through {@link serializeScene} / {@link deserializeScene}. Every
 * document carries a format `version`; older versions are upgraded through the
 * registered migration steps before being loaded.
 */

import type { BlendMode, Metadata, NodeId } from '../types';
import type { SerializedComponent } from '../components/Component';
import { componentRegistry } from '../components/Component';
import { SceneNode } from '../nodes/SceneNode';
import { Scene } from '../core/Scene';

/** Bump when the on-disk shape changes; add a migration to match. */
export const SCENE_FORMAT_VERSION = 1;

export interface SerializedNode {
  id: string;
  type: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  createdAt: number;
  updatedAt: number;
  metadata: Metadata;
  custom: Record<string, unknown>;
  components: SerializedComponent[];
  children: SerializedNode[];
}

export interface SerializedScene {
  version: number;
  root: SerializedNode;
}

// ── Serialize ─────────────────────────────────────────────────────

export function serializeNode(node: SceneNode): SerializedNode {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    blendMode: node.blendMode,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    metadata: JSON.parse(JSON.stringify(node.metadata)) as Metadata,
    custom: JSON.parse(JSON.stringify(node.custom)) as Record<string, unknown>,
    components: node.componentList().map((c) => c.serialize()),
    children: node.children.map(serializeNode),
  };
}

export function serializeScene(scene: Scene): SerializedScene {
  return { version: SCENE_FORMAT_VERSION, root: serializeNode(scene.root) };
}

// ── Deserialize ───────────────────────────────────────────────────

export function deserializeNode(data: SerializedNode): SceneNode {
  const node = new SceneNode(data.type, {
    id: data.id as NodeId,
    name: data.name,
    visible: data.visible,
    locked: data.locked,
    opacity: data.opacity,
    blendMode: data.blendMode,
    metadata: data.metadata,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  });
  // Replace default components with the serialized set (transform included).
  for (const sc of data.components) {
    const component = componentRegistry.deserialize(sc);
    if (component) node.addComponent(component);
  }
  Object.assign(node.custom, data.custom ?? {});
  for (const childData of data.children ?? []) {
    node._insertChildInternal(deserializeNode(childData), node.children.length);
  }
  // Restore the authored timestamp (addComponent bumped it).
  node.updatedAt = data.updatedAt;
  return node;
}

export function deserializeScene(input: SerializedScene): Scene {
  const migrated = migrate(input);
  return new Scene(deserializeNode(migrated.root));
}

// ── Migration ─────────────────────────────────────────────────────

/** A migration upgrades a document from `version` to `version + 1`. */
export type Migration = (data: SerializedScene) => SerializedScene;

const migrations = new Map<number, Migration>();

/** Register a migration from `fromVersion` → `fromVersion + 1`. */
export function registerMigration(fromVersion: number, migration: Migration): void {
  migrations.set(fromVersion, migration);
}

/** Upgrade a document to the current format version. */
export function migrate(input: SerializedScene): SerializedScene {
  let data = input;
  let guard = 0;
  while (data.version < SCENE_FORMAT_VERSION) {
    const step = migrations.get(data.version);
    if (!step) {
      throw new Error(`No migration registered from scene format v${data.version}`);
    }
    data = step(data);
    if (++guard > 1000) throw new Error('Migration loop detected');
  }
  return data;
}
