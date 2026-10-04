/**
 * A layer's json field (`layer/cloner`, `layer/physics`…) through the engine:
 * written as the Inspector writes it, read back from the document mirror.
 */

import type { Command } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { settleEdits } from '@core/engine/__testHelpers__/appEngine';

export async function setJsonField(layer: string, path: string, value: unknown): Promise<void> {
  await engine().execute({ type: 'setProperty', prop: { layer, path }, value: { kind: 'json', value: JSON.stringify(value ?? null) } } as Command);
  await settleEdits();
  await documentMirror().loadTree(layer);
}

/** The field's record, undefined when absent or null. */
export function jsonField<T>(layer: string, path: string): T | undefined {
  const v = documentMirror().property(layer, path)?.value as { kind?: string; value?: string } | undefined;
  if (!v || v.kind !== 'json' || typeof v.value !== 'string') return undefined;
  const parsed = JSON.parse(v.value) as T | null;
  return parsed ?? undefined;
}
