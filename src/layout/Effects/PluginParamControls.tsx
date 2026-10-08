/**
 * Controls for native plugin params of SDK 1.1 (plan P6) on the effect card:
 * STRING (a multi-line field), GRADIENT (stops) and FILE (a project item, or a
 * file picked and imported as a `data` item). CURVE uses the Curves effect's
 * editor (EffectStack). Each commit is one engine edit (one undo entry); the
 * params are static, so there is no stopwatch.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { engine } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import {
  addStop,
  fileTypeList,
  fileTypeMatches,
  gradientCss,
  gradientStops,
  gradientValue,
  importForFileParam,
  stopHex,
  withHex,
  type GradientStop,
} from '@core/nativePlugins/pluginParams';
import { useMirrorStructRevision } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import panel from './EffectsPanel.module.css';
import row from '@layout/Inspector/TextAnimatorControls.module.css';

/** A multi-line string; written on blur (or Ctrl/Cmd+Enter), not per keystroke. */
export function PluginTextField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <textarea
      aria-label={label}
      value={draft}
      rows={Math.min(6, Math.max(1, draft.split('\n').length))}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
        if (e.key === 'Escape') setDraft(value);
      }}
      style={{ flex: 1, minWidth: 0, resize: 'vertical', font: 'inherit' }}
    />
  );
}

/** Gradient stops: a preview bar, then each stop's position, colour and opacity. */
export function PluginGradientField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (v: readonly (readonly number[])[]) => void;
}): JSX.Element {
  const stops = gradientStops(value);
  const write = (next: GradientStop[]): void => onChange(gradientValue(next));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
      <div aria-hidden style={{ height: 12, borderRadius: 2, background: gradientCss(stops), border: '1px solid var(--color-border)' }} />
      {stops.map((s, i) => (
        <div key={i} className={row.paramRow} style={{ gap: 4 }}>
          <input
            type="number"
            aria-label={`${label} stop ${i + 1} position`}
            min={0}
            max={100}
            step={1}
            value={Math.round(s.position * 100)}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              if (Number.isFinite(v)) write(stops.map((x, k) => (k === i ? { ...x, position: Math.min(1, Math.max(0, v / 100)) } : x)));
            }}
            style={{ width: 52 }}
          />
          <input
            type="color"
            aria-label={`${label} stop ${i + 1} colour`}
            value={stopHex(s)}
            onChange={(e) => write(stops.map((x, k) => (k === i ? withHex(x, e.currentTarget.value) : x)))}
          />
          <input
            type="number"
            aria-label={`${label} stop ${i + 1} opacity`}
            min={0}
            max={100}
            step={1}
            value={Math.round(s.a * 100)}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              if (Number.isFinite(v)) write(stops.map((x, k) => (k === i ? { ...x, a: Math.min(1, Math.max(0, v / 100)) } : x)));
            }}
            style={{ width: 52 }}
          />
          <Button size="sm" variant="ghost" disabled={stops.length <= 1} onClick={() => write(stops.filter((_, k) => k !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" variant="secondary" disabled={stops.length >= 256} onClick={() => write(addStop(stops))}>
          Add Stop
        </Button>
      </div>
    </div>
  );
}

/**
 * A project item of the declared types, or a file picked from disk (imported
 * as a `data` item, then chosen — one gesture, one undo entry).
 */
export function PluginFileField({
  label,
  value,
  fileTypes,
  onChange,
}: {
  label: string;
  value: string;
  fileTypes: string | undefined;
  onChange: (itemId: string) => void;
}): JSX.Element {
  useMirrorStructRevision(true); // the item list
  const [error, setError] = useState<string | null>(null);
  const items = [...documentMirror().items.values()].filter((i) => i.kind === 'footage' && fileTypeMatches(i.name, fileTypes));
  const current = items.find((i) => i.id === value) ?? documentMirror().items.get(value);
  const stale = value !== '' && !items.some((i) => i.id === value);
  const pick = typeof window !== 'undefined' ? window.motionEditor?.shell?.pickFiles : undefined;
  const types = fileTypeList(fileTypes);

  const choose = async (): Promise<void> => {
    setError(null);
    const paths = await pick?.();
    const path = paths?.[0];
    if (!path) return;
    if (!fileTypeMatches(path, fileTypes)) {
      setError(`${label} takes ${types.map((t) => `.${t}`).join(', ')} files.`);
      return;
    }
    const client = engine();
    const opened = await client.beginGesture(`Set ${label}`);
    if (!opened.ok) return reportEngineError(`Set ${label}`, opened.error);
    const imported = await client.execute(importForFileParam(path));
    const item = imported.ok ? (imported.value as { items?: string[] }).items?.[0] : undefined;
    if (!imported.ok) reportEngineError(`Set ${label}`, imported.error);
    if (item) onChange(item);
    await client.endGesture(opened.value.gesture, !!item);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
      <div className={row.paramRow} style={{ gap: 4 }}>
        <select value={value} onChange={(e) => onChange(e.currentTarget.value)} aria-label={label} className={panel.paramSelect}>
          <option value="">None</option>
          {stale ? <option value={value}>{current ? `${current.name} (missing)` : 'Missing file'}</option> : null}
          {items.map((i) => (
            <option key={i.id} value={i.id}>{i.missing ? `${i.name} (missing)` : i.name}</option>
          ))}
        </select>
        {pick ? (
          <Button size="sm" variant="secondary" onClick={() => void choose()}>
            Choose…
          </Button>
        ) : null}
      </div>
      {current && 'missing' in current && current.missing ? (
        <span className={panel.hint} role="alert">The file is missing — relink it in the Project panel.</span>
      ) : null}
      {error ? <span className={panel.hint} role="alert">{error}</span> : null}
    </div>
  );
}
