/**
 * `HistoryOptions.onBeforeRun` — the host's chance to commit whatever it has
 * pending BEFORE an engine command mutates anything.
 *
 * The editor uses it to flush a debounced scene capture so that entry lands
 * ahead of the engine command's and, once snapshots carry clip geometry, does
 * not absorb the command's own change. That only works if the hook runs
 * strictly before `do()`, once per recordable entry, and never for commands
 * the history is not going to record.
 */

import { Timeline } from '../core/Timeline';
import { FPS_30 } from '../time';

function seeded(log: string[]) {
  const t = Timeline.create({
    name: 'Comp',
    duration: 600,
    frameRate: FPS_30,
    historyOptions: {
      onBeforeRun: (cmd) => log.push(`before:${cmd ? cmd.label : 'transaction'}`),
      onPush: (cmd) => log.push(`push:${cmd.label}`),
    },
  });
  const track = t.addTrack({ name: 'V1', kind: 'video' });
  const a = t.addLayer(track.id, { name: 'A', clip: { start: 0, duration: 60 } })!;
  log.length = 0;
  return { t, a: a.id };
}

describe('History.onBeforeRun', () => {
  test('runs before do() and before onPush, once per command', () => {
    const log: string[] = [];
    const { t, a } = seeded(log);
    // A command whose do() itself logs proves the ordering.
    t.history.run({
      label: 'Probe',
      do: () => { log.push('do'); },
      undo: () => { log.push('undo'); },
    });
    expect(log).toEqual(['before:Probe', 'do', 'push:Probe']);
    log.length = 0;
    t.setLayerStart(a, 30);
    expect(log[0]).toMatch(/^before:/);
    expect(log[log.length - 1]).toMatch(/^push:/);
    expect(log.filter((l) => l.startsWith('before:'))).toHaveLength(1);
  });

  test('a transaction fires it once, at open, not per collected command', () => {
    const log: string[] = [];
    const { t, a } = seeded(log);
    t.history.transaction('Drag', () => {
      t.setLayerStart(a, 30);
      t.setLayerStart(a, 60);
    });
    expect(log.filter((l) => l.startsWith('before:'))).toEqual(['before:transaction']);
    expect(log.filter((l) => l.startsWith('push:'))).toHaveLength(1);
    expect(log.indexOf('before:transaction')).toBe(0);
  });

  test('silent during undo/redo and while recording is disabled', () => {
    const log: string[] = [];
    const t = Timeline.create({
      name: 'Comp',
      duration: 600,
      frameRate: FPS_30,
      historyOptions: { onBeforeRun: (cmd) => log.push(`before:${cmd ? cmd.label : 'transaction'}`) },
    });
    const track = t.addTrack({ name: 'V1', kind: 'video' });
    const a = t.addLayer(track.id, { name: 'A', clip: { start: 0, duration: 60 } })!;
    log.length = 0;
    t.setLayerStart(a.id, 30);
    expect(log).toHaveLength(1);
    log.length = 0;
    t.history.undo();
    t.history.redo();
    expect(log).toEqual([]);
    t.history.setEnabled(false);
    t.setLayerStart(a.id, 90);
    expect(log).toEqual([]);
  });
});
