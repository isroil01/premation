/**
 * Beat-driven timing, as commands: mark the beats, or animate on them.
 *
 * The analysis has been in the tree since the AI caster shipped and was
 * reachable only by prompting. These are the two things a person actually does
 * with a beat grid — see it, and time to it.
 *
 * "Animate In on Beats" is the one that matters. It is the choreography
 * command with the music supplying the rhythm instead of a nominal stagger,
 * which is how short-form motion is cut: not "every 0.1 seconds" but "on the
 * beat". The two features were built a day apart and compose without either
 * knowing about the other, because both speak in composition seconds.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useUIStore } from '@stores/uiStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getTimelineController } from '@core/timeline/TimelineController';
import { bumpScene } from '@stores/sceneStore';
import { animateLayers } from '@core/animation/choreography';
import { hash32 } from '@core/animation/entranceArchetypes';
import { currentFeel } from '@core/animation/choreographyCommands';
import { analyseLayerBeats, beatsForLayers, everyNthBeat, findAudioLayer, LOW_CONFIDENCE } from './beatGrid';

/** How many markers one press may add — a 5-minute track at 174 BPM is 870. */
const MAX_MARKERS = 512;

function notify(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: level === 'error' ? 7000 : 5000 });
}

function playhead(): number {
  const project = useProjectStore.getState();
  return (project.activeTabId ? project.tabs[project.activeTabId]?.time : 0) ?? 0;
}

/** The selection, minus anything that has since been deleted. */
function targets(): string[] {
  return useSelectionStore.getState().ids.filter((id) => defaultSceneGraph.getNode(id) !== undefined);
}

/** A grid, or a sentence explaining why there isn't one. */
async function grid(): Promise<Awaited<ReturnType<typeof analyseLayerBeats>>> {
  const found = await analyseLayerBeats(targets()[0]);
  if (!found) {
    notify(
      findAudioLayer()
        ? 'Could not find a pulse in that audio — it may be speech, ambience, or unreadable.'
        : 'No audio layer in this composition to take a beat from.',
      'warning',
    );
    return null;
  }
  return found;
}

/** How reliable the tempo is, in words, appended to whatever we just did. */
function confidenceNote(tempoConfidence: number): string {
  return tempoConfidence < LOW_CONFIDENCE
    ? ' The tempo is a weak guess — check the first few land on the beat.'
    : '';
}

async function markBeats(every: number): Promise<void> {
  const found = await grid();
  if (!found) return;

  const beats = everyNthBeat(found.beatsCompSec, every);
  const controller = getTimelineController();
  const fps = controller.timeline.getFrameRate().fps;
  const placed = beats.slice(0, MAX_MARKERS);

  let n = 0;
  for (const sec of placed) {
    controller.timeline.addMarker({
      frame: Math.round(sec * fps),
      name: `Beat ${++n}`,
      color: '#7c8cff',
      scope: 'timeline',
    });
  }
  bumpScene();

  const dropped = beats.length - placed.length;
  notify(
    `${n} beat marker${n === 1 ? '' : 's'} at ${Math.round(found.bpm)} BPM`
    + (every > 1 ? ` (every ${every}${every === 2 ? 'nd' : 'th'} beat)` : '')
    + '.'
    // Never truncate silently: "512 markers" on a five-minute track looks
    // complete unless it says otherwise.
    + (dropped > 0 ? ` ${dropped} more were past the ${MAX_MARKERS}-marker limit.` : '')
    + confidenceNote(found.tempoConfidence),
    'success',
  );
}

async function animateOnBeats(phase: 'in' | 'out', every: number): Promise<void> {
  const nodeIds = targets();
  if (nodeIds.length === 0) {
    notify('Select the layers to animate first.', 'warning');
    return;
  }
  const found = await grid();
  if (!found) return;

  const startTimes = beatsForLayers(everyNthBeat(found.beatsCompSec, every), playhead(), nodeIds.length);
  const result = animateLayers({
    nodeIds,
    // The first beat is the anchor, so a selection started mid-bar still lands
    // on the music rather than on the playhead.
    atCompTime: startTimes[0] ?? playhead(),
    phase,
    startTimes,
    // The same project-wide feel the non-beat commands use — the music sets
    // the RHYTHM, the feel still decides how each entrance moves.
    feel: currentFeel(),
    fps: useCompositionStore.getState().fps || 30,
    seed: hash32(phase, ...nodeIds) || 1,
  });
  if (result.layers === 0) return;

  notify(
    `Animated ${result.layers} layer${result.layers === 1 ? '' : 's'} ${phase} on the beat `
    + `at ${Math.round(found.bpm)} BPM (${result.keyframes} keyframes).`
    + confidenceNote(found.tempoConfidence),
    'success',
  );
}

/** Every beat command, for `buildStaticCommands`. */
export function buildBeatCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('audio.markBeats'),
      label: 'Markers on Beats',
      description: 'Analyse the audio layer and mark every beat on the timeline.',
      icon: 'audio',
      enabled: () => findAudioLayer() !== undefined,
      execute: () => { void markBeats(1); },
    },
    {
      id: asCommandId('audio.markBeats.half'),
      label: 'Markers on Beats (Half Time)',
      description: 'Mark every second beat — the phrasing most cuts actually use.',
      icon: 'audio',
      enabled: () => findAudioLayer() !== undefined,
      execute: () => { void markBeats(2); },
    },
    {
      id: asCommandId('animation.animateInOnBeats'),
      label: 'Animate In on Beats',
      description:
        'Stagger the selected layers in, one per beat of the audio layer, instead of on a fixed interval.',
      icon: 'sparkles',
      enabled: () => targets().length > 0 && findAudioLayer() !== undefined,
      execute: () => { void animateOnBeats('in', 1); },
    },
    {
      id: asCommandId('animation.animateInOnBeats.half'),
      label: 'Animate In on Beats (Half Time)',
      description: 'One layer every second beat — room to breathe at fast tempos.',
      icon: 'sparkles',
      enabled: () => targets().length > 0 && findAudioLayer() !== undefined,
      execute: () => { void animateOnBeats('in', 2); },
    },
    {
      id: asCommandId('animation.animateOutOnBeats'),
      label: 'Animate Out on Beats',
      description: 'Stagger the selected layers out, one per beat.',
      icon: 'sparkles',
      enabled: () => targets().length > 0 && findAudioLayer() !== undefined,
      execute: () => { void animateOnBeats('out', 1); },
    },
  ];
}
