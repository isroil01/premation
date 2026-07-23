/**
 * manifestDiff — the sync reconciliation core (RFC §10.4).
 *
 * A bundle's manifest maps each logical chunk name → content hash. Sync compares
 * three manifests:
 *   - base   : the last state both sides agreed on (common ancestor)
 *   - local  : what this device has now
 *   - remote : what the server has now
 *
 * Because chunks are content-addressed and independent (scene / animation /
 * timeline / meta), most divergence is a clean fast-forward — the two sides
 * touched different chunks. A true conflict is only when the SAME chunk changed
 * to DIFFERENT hashes on both sides since `base`. That granularity is what makes
 * "device A edits animation, device B edits scene" merge automatically.
 *
 * Pure functions over plain hash maps — no crypto, no transport, no I/O.
 */

export type ChunkMap = Record<string, string>;

/** A chunk to move. `hash` undefined means "delete this chunk". */
export interface ChunkChange {
  name: string;
  hash?: string;
}

export interface Reconciliation {
  /** Remote changes to apply locally (pull). */
  pull: ChunkChange[];
  /** Local changes to send to the server (push). */
  push: ChunkChange[];
  /** Chunk names that changed to different hashes on both sides. */
  conflicts: string[];
}

/**
 * One-way push diff (no base): upload every local chunk the remote lacks or has
 * at a different hash, and delete remote chunks that are gone locally. Used for
 * the first sync of a project, where the remote IS the base.
 */
export function diffForPush(local: ChunkMap, remote: ChunkMap): { put: ChunkChange[]; delete: string[] } {
  const put: ChunkChange[] = [];
  const del: string[] = [];
  for (const [name, hash] of Object.entries(local)) {
    if (remote[name] !== hash) put.push({ name, hash });
  }
  for (const name of Object.keys(remote)) {
    if (!(name in local)) del.push(name);
  }
  return { put, delete: del };
}

/**
 * Three-way reconciliation of local vs remote against a common `base`.
 * Classifies each chunk name and routes it to pull / push / conflict.
 */
export function reconcile(base: ChunkMap, local: ChunkMap, remote: ChunkMap): Reconciliation {
  const names = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const out: Reconciliation = { pull: [], push: [], conflicts: [] };

  for (const name of names) {
    const b = base[name];
    const l = local[name];
    const r = remote[name];

    if (l === r) continue; // already agree (both present-equal, or both absent)

    const localChanged = l !== b;
    const remoteChanged = r !== b;

    if (remoteChanged && !localChanged) {
      // only the server moved → pull it (r undefined ⇒ delete locally)
      out.pull.push({ name, hash: r });
    } else if (localChanged && !remoteChanged) {
      // only this device moved → push it (l undefined ⇒ delete remotely)
      out.push.push({ name, hash: l });
    } else {
      // both moved to different hashes → genuine conflict
      out.conflicts.push(name);
    }
  }
  return out;
}
