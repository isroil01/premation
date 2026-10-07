/**
 * The parts of an effect card only native plugin effects have (AE parity 2.9):
 *
 *   - the plugin's own parameter UI state (UPDATE_PARAMS_UI through the
 *     engine's `getEffectUi`): a param it hides is not drawn, one it renames
 *     shows its new name, one it disables is greyed out;
 *   - its buttons (PR_PARAM_BUTTON), each `invokeEffectAction` — one undo entry;
 *   - a card for an effect whose plugin is missing, instead of no card at all.
 *
 * The UI state is asked again when the time or the effect's values change; a
 * failed query leaves every param as declared (the plugin may be disabled).
 */

import { useEffect, useState } from 'react';
import type { EffectParamUi } from '@motion/engine-api';
import { secondsToFlicks } from '@motion/engine-api';
import { Button } from '@components/Button';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { paths, ref } from '@core/engine/propRefs';
import type { Effect } from '@core/inspector/effectCatalog';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import { pluginOfType } from '@core/project/missingPluginContent';
import panel from './EffectsPanel.module.css';
import row from '@layout/Inspector/TextAnimatorControls.module.css';

/** key → the plugin's UI state for that param; null until the engine answers (or when it cannot). */
export function usePluginEffectUi(nodeId: string, effect: Effect, time: number): Map<string, EffectParamUi> | null {
  const [ui, setUi] = useState<Map<string, EffectParamUi> | null>(null);
  const valuesKey = JSON.stringify(effect.params ?? {});
  useEffect(() => {
    let alive = true;
    void engine()
      .query({ type: 'getEffectUi', layer: nodeId, effect: paths.effectGroup(effect.id), time: secondsToFlicks(time) })
      .then((res) => {
        if (!alive) return;
        setUi(res.ok ? new Map(res.value.params.map((p) => [p.key, p])) : null);
      })
      .catch(() => { if (alive) setUi(null); });
    return () => { alive = false; };
  }, [nodeId, effect.id, time, valuesKey]);
  return ui;
}

/** The plugin's buttons, under its params. */
export function PluginEffectActions({ nodeId, effect, def }: { nodeId: string; effect: Effect; def: PluginEffectDef }): JSX.Element | null {
  const [error, setError] = useState<string | null>(null);
  if (def.actions.length === 0) return null;
  return (
    <div className={row.paramRow} style={{ flexWrap: 'wrap', gap: 6, paddingLeft: 22 }}>
      {def.actions.map((a) => (
        <Button
          key={a.key}
          size="sm"
          variant="secondary"
          onClick={() => {
            setError(null);
            void edit(`${def.label}: ${a.label}`, {
              type: 'invokeEffectAction',
              group: ref(nodeId, paths.effectGroup(effect.id)),
              action: a.key,
            }).then((r) => { if (!r.ok) setError(r.error.message); });
          }}
        >
          {a.label}
        </Button>
      ))}
      {error ? <span className={panel.hint} role="alert">{error}</span> : null}
    </div>
  );
}

/** An effect whose definition is unknown: its plugin is missing (or failed to load). */
export function MissingPluginCard({ effect, name }: { effect: Effect; name?: string }): JSX.Element {
  return (
    <div className={panel.effectCardItem}>
      <div className={panel.effectCardHead}>
        <span className={panel.fxMark} aria-hidden>fx</span>
        <span className={panel.itemLabelOff}>{name ?? effect.type}</span>
      </div>
      <div className={panel.hint} style={{ padding: '4px 8px 8px' }}>
        Missing plugin {pluginOfType(effect.type)}. The effect is kept and passes the layer through until the plugin is
        installed (Dashboard ▸ Plugins).
      </div>
    </div>
  );
}
