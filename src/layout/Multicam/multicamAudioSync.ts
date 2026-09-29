/**
 * Sync Multicam by Audio over the document mirror (B4 round 8): every angle
 * of the active composition (`mirrorMulticamAngles`: `LayerInfo.multicamAngle`,
 * the source item's `mediaUrl`) is decoded into an alignment envelope, each
 * angle's lag against angle 1 is found by normalised cross-correlation
 * (core/composition/multicamSync.ts, pure), and the bars' new starts come
 * back as moves for `moveBars` (one engine entry). The earliest aligned bar
 * is kept at or after 0 so every relative offset survives.
 */

import { flicksToSeconds } from '@motion/engine-api';
import { audioEngine } from '@core/audio/AudioEngine';
import { bestLagSeconds, ENVELOPE_HZ, mixToMonoChannels, rmsEnvelope } from '@core/composition/multicamSync';
import { mirrorMulticamAngles } from '@core/mirror/multicam';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';

/** Below this correlation the match is not trusted (the angle stays put). */
const SYNC_MIN_SCORE = 0.3;
/** The largest offset searched, seconds. */
const SYNC_MAX_LAG_SECONDS = 120;

export interface MulticamSyncReport {
  shifted: number;
  angles: Array<{ angle: number; name: string; offsetSec: number; score: number; note?: string }>;
  note: string;
}

async function envelopeOf(id: string, src: string | null): Promise<Float32Array | null> {
  if (!src) return null;
  const loaded = await audioEngine.load(id, src);
  if (!loaded) return null;
  const channels: Float32Array[] = [];
  for (let c = 0; c < loaded.buffer.numberOfChannels; c++) channels.push(loaded.buffer.getChannelData(c));
  return rmsEnvelope(mixToMonoChannels(channels, loaded.buffer.length), loaded.buffer.sampleRate, ENVELOPE_HZ);
}

/** The bar moves (clip id → new start, comp seconds) and a report; nothing is written. */
export async function planMulticamAudioSync(): Promise<{ moves: Array<{ clipId: string; start: number }>; report: MulticamSyncReport }> {
  const m = documentMirror();
  const comp = activeCompIdNow();
  const angles = comp ? mirrorMulticamAngles(m, comp) : [];
  if (angles.length < 2) return { moves: [], report: { shifted: 0, angles: [], note: 'Need at least two multicam angles.' } };
  const fps = (() => {
    const r = comp ? m.comp(comp)?.settings.frameRate : undefined;
    return r && r.den > 0 ? r.num / r.den : 30;
  })();
  // The decoder caches by asset: key on the source item, as the viewer plays it.
  const envs = await Promise.all(angles.map((a) => envelopeOf(m.layer(a.id)?.source ?? a.id, a.src)));
  const startOf = (id: string): number | null => {
    const l = m.layer(id);
    return l ? flicksToSeconds(l.timing.inPoint) : null;
  };
  const refEnv = envs[0];
  const refStart = startOf(angles[0]!.id);
  if (!refEnv || refStart === null) {
    return { moves: [], report: { shifted: 0, angles: [], note: 'Angle 1 has no decodable audio — nothing to align against.' } };
  }
  const report: MulticamSyncReport['angles'] = [{ angle: angles[0]!.angle, name: angles[0]!.name, offsetSec: 0, score: 1 }];
  const targets = new Map<string, number>([[angles[0]!.id, refStart]]);
  for (let i = 1; i < angles.length; i++) {
    const a = angles[i]!;
    const env = envs[i];
    const entry: MulticamSyncReport['angles'][number] = { angle: a.angle, name: a.name, offsetSec: 0, score: 0 };
    report.push(entry);
    if (!env || startOf(a.id) === null) {
      entry.note = env ? 'no clip bar' : 'no decodable audio';
      continue;
    }
    const { lagSec, score } = bestLagSeconds(refEnv, env, ENVELOPE_HZ, SYNC_MAX_LAG_SECONDS);
    entry.score = score;
    if (score < SYNC_MIN_SCORE) {
      entry.note = 'no confident audio match';
      continue;
    }
    entry.offsetSec = -lagSec;
    targets.set(a.id, refStart - lagSec);
  }
  const minStart = Math.min(...targets.values());
  const moves: Array<{ clipId: string; start: number }> = [];
  for (const a of angles) {
    const want = targets.get(a.id);
    const now = startOf(a.id);
    if (want === undefined || now === null) continue;
    const next = want - Math.min(0, minStart);
    if (Math.abs(next - now) < 0.5 / fps) continue;
    moves.push({ clipId: `clip:${a.id}`, start: next });
  }
  const shifted = moves.length;
  const misses = report.filter((r) => r.note).length;
  const note = shifted === 0
    ? misses > 0 ? 'No angles moved — audio failed to match. Align manually via a clap/slate frame.' : 'Angles already in sync.'
    : `Synced ${shifted} angle${shifted === 1 ? '' : 's'} by audio${misses ? ` (${misses} not matched)` : ''}.`;
  return { moves, report: { shifted, angles: report, note } };
}
