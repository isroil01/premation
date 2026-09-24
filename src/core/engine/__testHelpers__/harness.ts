/**
 * Test harness for the local engine: a booted-enough editor (CommandSystem,
 * unified history, the scene→timeline mirror and the 700 ms debounce recorder
 * the app wires) plus an engine with `verifyScopes` and `wire` on — every
 * command is checked against a whole-document diff and every payload goes
 * through the binary codec.
 */

import { unwrap, type Command, type CommandResult, type CommandResults, type CommandType, type EventBatch, type CommandOf, type QueryOf, type QueryType, type QueryResults } from '@motion/engine-api';
import { LocalEngine, type LocalEngineOptions } from '../LocalEngine';
import type { EnginePorts } from '../ports';
import { canonicalJson } from '../canonical';
import { CommandSystem, setCommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { setUnifiedHistory } from '@core/config/flags';
import { getEventBus } from '@core/events/EventBus';
import { getTimelineController } from '@core/timeline/TimelineController';
import { attachHistoryRecording, useHistoryStore } from '@stores/historyStore';
import { resetSnapshotSharing } from '@core/commands/snapshotSharing';
import type { ImportedAsset } from '@stores/assetStore';
import type { EditorDocument } from '@core/api/cloudDocument';

export interface Harness {
  engine: LocalEngine;
  batches: EventBatch[];
  files: Map<string, EditorDocument>;
  run<T extends CommandType>(cmd: CommandOf<T>): Promise<CommandResults[T]>;
  batch(label: string, cmds: Command[]): Promise<CommandResult[]>;
  query<T extends QueryType>(q: QueryOf<T>): Promise<QueryResults[T]>;
  doc(): string;
  dispose(): Promise<void>;
}

/** A fake media/project port: deterministic footage records, projects in memory. */
export function fakePorts(files: Map<string, EditorDocument>): EnginePorts {
  return {
    importFile: async (file, id): Promise<ImportedAsset> => {
      const name = file.path.replace(/^.*[\\/]/, '');
      const audio = /\.(wav|mp3|aac)$/i.test(name);
      const image = /\.(png|jpg|jpeg)$/i.test(name);
      return {
        id, name, type: audio ? 'audio' : image ? 'image' : 'video', src: `blob:fake/${id}`, size: 1000,
        metadata: { width: 640, height: 360, duration: image ? 0 : 4, fps: 30, hasAudioTrack: !image },
        path: file.path,
      };
    },
    importBytes: async (file, id): Promise<ImportedAsset> => {
      const audio = /\.(wav|mp3|aac)$/i.test(file.name) || file.mimeType.startsWith('audio/');
      const image = /\.(png|jpg|jpeg)$/i.test(file.name) || file.mimeType.startsWith('image/');
      return {
        id, name: file.name, type: audio ? 'audio' : image ? 'image' : 'video', src: `blob:fake/${id}`, size: file.data.byteLength,
        metadata: { width: 640, height: 360, duration: image ? 0 : 4, fps: 30, hasAudioTrack: !image },
        ...(file.originPath ? { path: file.originPath } : {}),
      };
    },
    probeFile: async (path) => ({ name: path.replace(/^.*[\\/]/, '') }),
    readProject: async (path) => {
      const d = files.get(path);
      if (!d) throw new Error('ENOENT');
      return structuredClone(d);
    },
    writeProject: async (path, doc) => {
      files.set(path, structuredClone(doc));
      // UTF-8 bytes, as the real port writes (and the C++ test port counts).
      return { bytes: new TextEncoder().encode(JSON.stringify(doc)).length };
    },
  };
}

let subs: Array<{ dispose(): void }> = [];

// jsdom has no object URLs; New Project revokes the session's asset URLs.
const U = URL as unknown as { revokeObjectURL?: (u: string) => void; createObjectURL?: (b: unknown) => string };
U.revokeObjectURL ??= () => {};
U.createObjectURL ??= () => 'blob:test';

export async function setupEngine(opts: LocalEngineOptions = {}): Promise<Harness> {
  for (const s of subs) s.dispose();
  setUnifiedHistory(true);
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  resetSnapshotSharing();
  subs = [
    getEventBus().on('SceneGraphChanged', () => getTimelineController().syncFromScene()),
    attachHistoryRecording(),
  ];
  const files = new Map<string, EditorDocument>();
  const engine = new LocalEngine({ verifyScopes: true, wire: true, ports: fakePorts(files), ...opts });
  const batches: EventBatch[] = [];
  engine.subscribe((b) => batches.push(b));
  const h: Harness = {
    engine,
    batches,
    files,
    run: async (cmd) => unwrap(await engine.execute(cmd)),
    batch: async (label, cmds) => unwrap(await engine.batch(label, cmds)),
    query: async (q) => unwrap(await engine.query(q)),
    doc: () => canonicalJson(),
    dispose: async () => {
      await engine.close();
      for (const s of subs) s.dispose();
      subs = [];
    },
  };
  await h.run({ type: 'newProject' });
  useHistoryStore.getState().reset();
  getCommandSystem().getHistory().clear();
  engine.startLog();
  return h;
}

export const S = 705_600_000;
/** Seconds → flicks. */
export const sec = (s: number): number => Math.round(s * S);

/** Paths where two canonical documents differ (for readable failures). */
export function docDiff(a: string, b: string): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (out.length > 12) return;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}/${k}`);
      return;
    }
    out.push(`${path}: ${JSON.stringify(x)?.slice(0, 160)} → ${JSON.stringify(y)?.slice(0, 160)}`);
  };
  walk(JSON.parse(a), JSON.parse(b), '');
  return out;
}
