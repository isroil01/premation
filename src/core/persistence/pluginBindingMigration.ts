/**
 * The load-time repair of plugin bindings that reference their parent by
 * NAME (src/core/plugins/bindingMigration.ts has the why): a DOCUMENT
 * MIGRATION, run by the loader (src/core/api/cloudDocument.ts) after the
 * scene and the animation are restored — part of opening the file, like the
 * version migrations, not an edit: no undo entry, no engine command. Moved
 * here from the plugin host in B5 (docs/ENGINE_API.md §15.6).
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { usePluginStore } from '@stores/pluginStore';
import { rewriteNameRefsToIds } from '@core/plugins/bindingMigration';

export interface BindingMigrationReport {
  /** Expressions rewritten to the id form. */
  migrated: Array<{ nodeId: string; prop: string; from: string; to: string }>;
  /** References naming a layer that does not exist. Left alone, reported. */
  unresolved: Array<{ nodeId: string; prop: string; name: string }>;
}

/** Layer name → id, first match wins, exactly as the app's resolver does. */
function buildNameIndex(): Map<string, string> {
  const byName = new Map<string, string>();
  defaultSceneGraph.traverse((n) => {
    if (n.name && !byName.has(n.name)) byName.set(n.name, n.id);
  });
  return byName;
}

/**
 * Rewrite every plugin-authored name reference to `#<id>`.
 *
 * Idempotent: a reference already in the id form does not match `NAME_REF`'s
 * intent and is left alone, so running this on every load costs one regex pass
 * and changes nothing after the first time.
 */
export function migratePluginBindings(): BindingMigrationReport {
  const report: BindingMigrationReport = { migrated: [], unresolved: [] };
  const byName = buildNameIndex();

  for (const plugin of usePluginStore.getState().plugins) {
    const pluginId = plugin.manifest.id;
    for (const { nodeId, prop } of defaultAnimation.expressionsAuthoredBy(pluginId)) {
      const src = defaultAnimation.getExpressionSrc(nodeId, prop);
      if (!src) continue;

      const { src: next, changed } = rewriteNameRefsToIds(
        src,
        (ref) => byName.get(ref) ?? null,
        (ref) => report.unresolved.push({ nodeId, prop, name: ref }),
      );

      if (!changed) continue;
      // Re-written with the SAME provenance, so a migrated binding is still
      // attributable to the plugin that wrote it.
      defaultAnimation.setExpression(nodeId, prop, next, pluginId);
      report.migrated.push({ nodeId, prop, from: src, to: next });
    }
  }

  if (report.unresolved.length > 0) {
    console.warn(
      `[plugins] ${report.unresolved.length} plugin binding(s) reference a layer that no longer exists. `
      + 'They were left unchanged rather than dropped: '
      + report.unresolved.map((u) => `${u.nodeId}.${u.prop} → "${u.name}"`).join(', '),
    );
  }
  return report;
}
