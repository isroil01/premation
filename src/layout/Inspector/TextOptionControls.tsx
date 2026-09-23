/**
 * Character panel sections for the text options AE keeps outside the basic
 * character fields:
 *
 *   VariableAxesSection  one keyframeable slider per variation axis of the
 *                        layer's font (read from its `fvar`), AE 26.0
 *   TextPathOptions      Path Options — Reverse, Perpendicular, Force
 *                        Alignment, First / Last Margin, all keyframeable
 *   OpenTypeControls     standard / discretionary ligatures, contextual
 *                        alternates, stylistic sets 1–20
 *
 * Every keyframeable value uses one idiom (B3, `useTextParam`): the engine API
 * keys the property at the playhead when it is animated and writes the static
 * value otherwise; a scrub is one gesture — so every edit is one undo.
 */

import { useEffect, useState } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision } from '@stores/sceneStore';
import { readTextPathConfig, textPathPropPath, textPathParamValue, type TextPathParam } from '@core/text/textPath';
import { axisPropPath, axisLabel, readFontAxesProp } from '@core/text/fontAxes';
import { loadFamilyAxes, registeredAxisFallback, type FamilyAxes } from '@core/text/fontAxesLoader';
import type { FvarAxis } from '@core/text/variableFontProbe';
import { ValueField } from '@components/ValueField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { AnimToggle } from './AnimToggle';
import { fieldEdit, useTextParam } from '@layout/Text/textEdits';
import styles from './CharacterPanel.module.css';

function textComp(nodeId: string): { id: string; props: Record<string, unknown> } | null {
  const node = defaultSceneGraph.getNode(nodeId);
  const c = node?.components.find((x) => x.type === 'Text');
  return c ? { id: c.id, props: c.props as Record<string, unknown> } : null;
}

/** A keyframeable number in the Character panel's metric grid. */
export function KeyframeableNumberCell({
  nodeId, path, label, value, onStatic, unit, min, max, step, title,
}: {
  nodeId: string;
  path: string;
  label: string;
  value: number;
  /** A custom static writer, for a value stored somewhere other than its track. */
  onStatic?: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  title?: string;
}): JSX.Element {
  useSceneRevision((s) => s.rev);
  // Engine API (B3): keyed at the playhead when animated, else static; a scrub is one gesture.
  const p = useTextParam(nodeId, path, label, value, onStatic);
  const shown = p.display;
  return (
    <div className={`${styles.metricCell} ${styles.metricCellWide}`}>
      <AnimToggle nodeId={nodeId} tracks={[path]} label={label} animated={p.animated} onToggle={p.toggle} values={() => [shown]} />
      <span className={styles.metricLabel} title={title ?? label}>{label}</span>
      <div className={styles.metricValue}>
        <ValueField aria-label={label} value={shown} onChange={p.onChange} {...p.scrub} min={min} max={max} step={step} unit={unit} />
      </div>
    </div>
  );
}

/** A keyframeable ON/OFF — a 0/1 track read at a 0.5 threshold. */
function KeyframeableSwitch({
  nodeId, path, label, on, title,
}: { nodeId: string; path: string; label: string; on: boolean; title?: string }): JSX.Element {
  useSceneRevision((s) => s.rev);
  // Engine API (B3): the 0/1 track keyed at the playhead when animated, else the static flag.
  const p = useTextParam(nodeId, path, label, on ? 1 : 0);
  const shown = p.display >= 0.5;
  const set = (v: boolean): void => p.onChange(v ? 1 : 0);
  return (
    <div className={styles.metricCell}>
      <AnimToggle nodeId={nodeId} tracks={[path]} label={label} animated={p.animated} onToggle={p.toggle} values={() => [shown ? 1 : 0]} />
      <button
        type="button"
        className={styles.metricToggle}
        data-active={shown}
        aria-pressed={shown}
        title={title ?? label}
        onClick={() => set(!shown)}
      >
        {label}
      </button>
    </div>
  );
}

// ── Variable axes ────────────────────────────────────────────────────

export function VariableAxesSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const comp = textComp(nodeId);
  const family = typeof comp?.props.fontFamily === 'string' ? comp.props.fontFamily : 'Inter';
  const [info, setInfo] = useState<FamilyAxes | null>(null);
  const [showNominal, setShowNominal] = useState(false);

  useEffect(() => {
    let live = true;
    setInfo(null);
    void loadFamilyAxes(family).then((r) => { if (live) setInfo(r); });
    return () => { live = false; };
  }, [family]);

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !comp) return null;
  const stored = readFontAxesProp(node);
  const hasStored = typeof comp.props.fontWidth === 'number' || typeof comp.props.fontSlant === 'number' || Object.keys(stored).length > 0;

  // A font file that was read and declares no axes is a static font: no section.
  if (info?.fromFont && info.axes.length === 0 && !hasStored) return null;
  const nominal = !info?.fromFont;
  let axes: FvarAxis[] = info?.fromFont ? info.axes : showNominal || hasStored ? registeredAxisFallback().axes : [];
  // Axes the layer already sets stay editable even if the font list omits them.
  for (const tag of Object.keys(stored)) {
    if (!axes.some((a) => a.tag === tag)) axes = [...axes, { tag, min: -1000, default: 0, max: 1000, hidden: false }];
  }

  const staticValue = (a: FvarAxis): number => {
    if (a.tag === 'wght') return Number(comp.props.fontWeight ?? a.default) || a.default;
    if (a.tag === 'wdth') return typeof comp.props.fontWidth === 'number' ? comp.props.fontWidth : a.default;
    if (a.tag === 'slnt') return typeof comp.props.fontSlant === 'number' ? comp.props.fontSlant : a.default;
    return stored[a.tag] ?? a.default;
  };
  // Every axis — wght / wdth / slnt included — is ONE engine property,
  // `text/axes/<tag>` (G1): static value and keys through the same path.

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionHeader}>Variable Axes</div>
      {nominal && axes.length === 0 ? (
        <div className={styles.controlRow}>
          <button
            type="button"
            className={styles.metricToggle}
            title="This font's file could not be read (no Local Font Access, or a web font), so its axes are unknown. Show the registered axes with nominal ranges."
            onClick={() => setShowNominal(true)}
          >
            Show registered axes
          </button>
        </div>
      ) : (
        <div className={styles.metricGrid}>
          {axes.map((a) => (
            <KeyframeableNumberCell
              key={a.tag}
              nodeId={nodeId}
              path={axisPropPath(a.tag)}
              label={axisLabel(a.tag)}
              title={`${a.tag} ${a.min}–${a.max}${nominal ? ' (nominal range — the font file was not read)' : ''}. Canvas draws axes through an installed-font alias; web fonts keep their defaults.`}
              value={staticValue(a)}
              min={a.min}
              max={a.max}
              step={a.max - a.min <= 2 ? 0.01 : 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Path Options ─────────────────────────────────────────────────────

const SWITCHES: ReadonlyArray<{ param: TextPathParam; label: string; title: string }> = [
  { param: 'reversed', label: 'Reverse Path', title: 'Walk the path backwards' },
  { param: 'perpendicular', label: 'Perpendicular', title: 'Perpendicular To Path — turn each character to the path heading' },
  { param: 'forceAlignment', label: 'Force Alignment', title: 'Spread the characters from First Margin to Last Margin' },
];

export function TextPathOptions({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const cfg = node ? readTextPathConfig(node) : null;
  if (!cfg) return null;
  return (
    <div className={styles.metricGrid} role="group" aria-label="Path Options">
      {SWITCHES.map((s) => (
        <KeyframeableSwitch
          key={s.param}
          nodeId={nodeId}
          path={textPathPropPath(s.param)}
          label={s.label}
          title={s.title}
          on={textPathParamValue(cfg, s.param) >= 0.5}
        />
      ))}
      <KeyframeableNumberCell
        nodeId={nodeId}
        path={textPathPropPath('firstMargin')}
        label="First Margin"
        unit="px"
        value={cfg.firstMargin}
      />
      <KeyframeableNumberCell
        nodeId={nodeId}
        path={textPathPropPath('lastMargin')}
        label="Last Margin"
        unit="px"
        value={cfg.lastMargin ?? 0}
      />
    </div>
  );
}

// ── OpenType ─────────────────────────────────────────────────────────

export function OpenTypeControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const comp = textComp(nodeId);
  if (!comp) return null;
  const p = comp.props;
  const ligatures = p.ligatures !== false;
  const dlig = p.discretionaryLigatures === true;
  const calt = p.contextualAlternates !== false;
  const sets = Array.isArray(p.stylisticSets) ? (p.stylisticSets as number[]) : [];
  // OpenType switches and the stylistic-set list are text fields (G1); undefined = the default.
  const write = (label: string, key: string, value: unknown): void => {
    void fieldEdit(label, nodeId, `text/${key}`, value);
  };
  const NOTE = 'Applied through an installed-font alias (canvas has no font-feature API); a web font keeps its defaults.';
  const setItems: DropdownItem[] = Array.from({ length: 20 }, (_, i) => i + 1).map((n) => ({
    type: 'checkbox',
    id: `ss${n}`,
    label: `Stylistic Set ${n}`,
    checked: sets.includes(n),
    onChange: (on: boolean) =>
      write(`Stylistic Set ${n}`, 'stylisticSets', on ? [...new Set([...sets, n])].sort((a, b) => a - b) : sets.filter((s) => s !== n)),
  }));
  return (
    <div className={styles.controlGroup} role="group" aria-label="OpenType Features">
      <button type="button" className={styles.metricToggle} data-active={ligatures} aria-pressed={ligatures}
        title={`Standard Ligatures. ${NOTE}`} onClick={() => write('Standard Ligatures', 'ligatures', ligatures ? false : undefined)}>
        fi
      </button>
      <button type="button" className={styles.metricToggle} data-active={dlig} aria-pressed={dlig}
        title={`Discretionary Ligatures. ${NOTE}`} onClick={() => write('Discretionary Ligatures', 'discretionaryLigatures', dlig ? undefined : true)}>
        st
      </button>
      <button type="button" className={styles.metricToggle} data-active={calt} aria-pressed={calt}
        title={`Contextual Alternates. ${NOTE}`} onClick={() => write('Contextual Alternates', 'contextualAlternates', calt ? false : undefined)}>
        Alt
      </button>
      <Dropdown
        placement="bottom-end"
        trigger={
          <button type="button" className={styles.metricToggle} data-active={sets.length > 0} title={`Stylistic Sets. ${NOTE}`}>
            <span>{sets.length > 0 ? `ss ×${sets.length}` : 'ss'}</span>
            <Icon name="chevron-down" size="sm" />
          </button>
        }
        items={setItems}
      />
    </div>
  );
}
