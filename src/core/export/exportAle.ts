/**
 * Avid Log Exchange (ALE) — text interchange Avid Media Composer actually imports.
 *
 * Binary AAF remains out of scope (CFB + object model). ALE carries the same
 * cut list as EDL/OTIO in a format Avid's importer eats without adapters.
 */

import { documentMirror } from '@stores/documentMirror';
import { activeCompRootId } from '@core/scene/activeComp';
import { mirrorMediaClips } from '@core/mirror/mediaClips';
import { framesToTimecode } from './exportEdl';

export interface AleEvent {
  name: string;
  tracks: string;
  start: string;
  end: string;
  duration: string;
  tape: string;
  sourceFile: string;
}

/** Collect ALE rows from the active composition's footage clips (one track per layer). */
export function collectAleEvents(): { events: AleEvent[]; fps: number } {
  const { fps, clips } = mirrorMediaClips(documentMirror(), activeCompRootId());
  const events: AleEvent[] = [];
  const trackOf = new Map<string, string>();
  let v = 0;
  let a = 0;
  for (const c of clips) {
    let track = trackOf.get(c.nodeId);
    if (!track) {
      track = c.kind === 'audio' ? `A${++a}` : `V${++v}`;
      trackOf.set(c.nodeId, track);
    }
    events.push({
      name: c.name,
      tracks: track,
      start: framesToTimecode(c.start, fps),
      end: framesToTimecode(c.start + c.duration, fps),
      duration: framesToTimecode(c.duration, fps),
      tape: c.mediaName?.replace(/.[^.]+$/, '') || 'AX',
      sourceFile: c.mediaName ?? '',
    });
  }
  return { events, fps };
}

/** Pure ALE document builder. */
export function formatAle(events: readonly AleEvent[], fps: number): string {
  const heading = [
    'Heading',
    `FIELD_DELIM\tTABS`,
    `VIDEO_FORMAT\t${fps >= 29.97 && fps < 30 ? '1080' : '1080'}`,
    `FPS\t${fps}`,
    '',
    'Column',
    'Name\tTracks\tStart\tEnd\tDuration\tTape\tSource File',
    '',
    'Data',
  ];
  const rows = events.map(
    (e) =>
      `${e.name}\t${e.tracks}\t${e.start}\t${e.end}\t${e.duration}\t${e.tape}\t${e.sourceFile}`,
  );
  return [...heading, ...rows, ''].join('\n');
}

export function exportAleText(): string {
  const { events, fps } = collectAleEvents();
  return formatAle(events, fps);
}
