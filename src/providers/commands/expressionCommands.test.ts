/**
 * Add / Enable-Disable / Remove Expression as registry commands over the
 * engine: the targets are the focused row or the selected property rows, each
 * action is one history entry, and Add asks the row's editor to open.
 */

import type { Command as EngineCommand } from '@motion/engine-api';
import { chordFromEvent } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { onExpressionEditorRequest, setFocusedExpressionRow } from '@core/animation/expressionEditorRequests';
import { trackExpressionFacts } from '@core/mirror/memberExpressions';
import { documentMirror } from '@stores/documentMirror';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { buildExpressionCommands } from './expressionCommands';

let h: Harness & { engine: LocalEngine };
let ID: string;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const cmd = (id: string) => buildExpressionCommands().find((c) => String(c.id) === id)!;
const run = async (id: string): Promise<void> => {
  void cmd(id).execute({} as never);
  await settle();
};
const facts = (prop: string) => trackExpressionFacts(documentMirror(), ID, prop);

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as EngineCommand) as { layer: string }).layer;
  usePropertySelectionStore.getState().clear();
  setFocusedExpressionRow(null);
  await settle();
  documentMirror().tree(ID);
  await settle();
});
afterEach(async () => {
  setFocusedExpressionRow(null);
  await h.dispose();
});

it('Alt+Shift+= is bound on `=` and resolves from e.code Equal', () => {
  expect(cmd('anim.addExpression').shortcut).toEqual({ key: '=', alt: true, shift: true });
  for (const key of ['+', '±', '=']) {
    const ev = { key, code: 'Equal', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false } as KeyboardEvent;
    expect(chordFromEvent(ev)).toMatchObject({ key: '=', alt: true, shift: true });
  }
});

it('adds on the focused row (else the selected rows), toggles and removes: one entry each', async () => {
  expect(cmd('anim.addExpression').enabled?.()).toBe(false);
  usePropertySelectionStore.getState().select({ nodeId: ID, prop: 'rotation' });
  setFocusedExpressionRow({ nodeId: ID, prop: 'opacity' });
  const heard: string[] = [];
  const off = onExpressionEditorRequest((r) => heard.push(r.prop));

  await run('anim.addExpression');
  expect(facts('opacity')).toMatchObject({ source: 'value', enabled: true });
  expect(facts('rotation')).toBeNull();
  expect(historyLabels().at(-1)).toBe('Add Expression');
  expect(heard).toEqual(['opacity']);
  off();

  expect(cmd('anim.toggleExpression').enabled?.()).toBe(true);
  await run('anim.toggleExpression');
  expect(facts('opacity')).toMatchObject({ source: 'value', enabled: false });
  expect(historyLabels().at(-1)).toBe('Disable Expression');
  await run('anim.toggleExpression');
  expect(facts('opacity')?.enabled).toBe(true);

  await run('anim.removeExpression');
  expect(facts('opacity')).toBeNull();
  expect(historyLabels().at(-1)).toBe('Remove Expression');
  expect(cmd('anim.removeExpression').enabled?.()).toBe(false);
});
