/**
 * Transport and viewport controls (ENGINE_API.md §6) for the local engine.
 *
 * Controls never touch the document or history. In B2 the TypeScript renderer
 * still draws the viewport and `usePlaybackClock` still pumps the active
 * composition, so the engine forwards what today's controller can do (seek,
 * play/pause, loop on the ACTIVE composition's timeline) and keeps the rest as
 * engine-facing state reported back through `transportChanged` / `playhead`.
 * Moving the clock itself into the engine is phase C (the UI's rAF loop leaves
 * then — §6 last paragraph).
 */

import type { Command, Event, TimeRange, LoopMode, TransportState } from '@motion/engine-api';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { usePluginStore } from '@stores/pluginStore';
import { fail } from './errors';
import { compFps, flicksToSeconds, framesToFlicks, flicksToFrames } from './time';
import { isCompItem, compItemIds } from './doc';

interface ViewportState {
  width: number;
  height: number;
  devicePixelRatio: number;
  zoom: number;
}

export class Transport {
  comp = '';
  time = 0;
  rate = 1;
  state: TransportState = 'stopped';
  loop: LoopMode = 'loop';
  range: TimeRange = { start: 0, duration: 0 };
  previewQuality: Record<string, unknown> = {};
  audioPreview = { muted: false, volume: 1, scrubAudio: true };
  cacheBudget = { ramMegabytes: 0, diskMegabytes: 0, diskPath: '' };
  interacting = false;
  readonly viewports = new Map<number, ViewportState>();
  readonly disabledPlugins = new Set<string>();
  private readonly emit: (events: Event[]) => void;

  constructor(emit: (events: Event[]) => void) {
    this.emit = emit;
  }

  private activeComp(): string {
    if (this.comp && isCompItem(this.comp)) return this.comp;
    const s = useProjectStore.getState();
    const tabComp = s.tabs[s.activeTabId ?? '']?.compositionId;
    return tabComp && isCompItem(tabComp) ? tabComp : compItemIds()[0] ?? '';
  }

  /** Whether the engine's comp is the one the editor's active tab shows (the only one today's pump drives). */
  private isEditorActive(comp: string): boolean {
    const s = useProjectStore.getState();
    return s.tabs[s.activeTabId ?? '']?.compositionId === comp;
  }

  private changed(): void {
    const comp = this.activeComp();
    const fps = comp ? compFps(comp) : 30;
    this.emit([
      { type: 'transportChanged', state: this.state, comp, time: this.time, rate: this.rate, loop: this.loop, range: this.range },
      { type: 'playhead', comp, time: this.time, frame: flicksToFrames(this.time, fps), droppedFrames: 0 },
    ]);
  }

  setPluginEnabled(plugin: string, enabled: boolean): Record<string, unknown> {
    const known = usePluginStore.getState().plugins.some((p) => p.manifest.id === plugin);
    if (!known) fail('notFound', `no installed plugin '${plugin}'`);
    if (enabled) this.disabledPlugins.delete(plugin);
    else this.disabledPlugins.add(plugin);
    return {};
  }

  handle(cmd: Command): Record<string, unknown> {
    switch (cmd.type) {
      case 'setActiveComposition':
        if (!isCompItem(cmd.comp)) fail('notFound', `no composition '${cmd.comp}'`, { item: cmd.comp });
        this.comp = cmd.comp;
        this.changed();
        return {};
      case 'play': {
        const comp = this.activeComp();
        if (!comp) fail('notFound', 'no composition to play');
        if (!(Math.abs(cmd.rate) > 0 && Math.abs(cmd.rate) <= 4)) fail('outOfRange', 'rate must be within ±4 and not 0');
        this.rate = cmd.rate;
        if (cmd.custom) this.range = { ...cmd.custom };
        if (cmd.from !== undefined) this.seekTo(comp, cmd.from);
        this.state = cmd.cacheFirst ? 'caching' : 'playing';
        if (this.isEditorActive(comp)) getTimelineController().play();
        this.changed();
        return {};
      }
      case 'pause': {
        const comp = this.activeComp();
        this.state = 'stopped';
        if (comp && this.isEditorActive(comp)) getTimelineController().pause();
        if (cmd.returnToStart && comp) this.seekTo(comp, this.range.duration > 0 ? this.range.start : 0);
        this.changed();
        return {};
      }
      case 'seek': {
        const comp = this.activeComp();
        if (!comp) fail('notFound', 'no composition to seek');
        if (!Number.isInteger(cmd.time)) fail('invalidArgument', 'time must be integer flicks');
        this.seekTo(comp, cmd.time);
        this.changed();
        return {};
      }
      case 'step': {
        const comp = this.activeComp();
        if (!comp) fail('notFound', 'no composition to step');
        const fps = compFps(comp);
        this.seekTo(comp, framesToFlicks(flicksToFrames(this.time, fps) + cmd.frames, fps));
        this.changed();
        return {};
      }
      case 'setLoop':
        this.loop = cmd.mode;
        if (this.activeComp() && this.isEditorActive(this.activeComp())) getTimelineController().setLooping(cmd.mode !== 'once');
        this.changed();
        return {};
      case 'setPreviewQuality':
        this.previewQuality = { resolution: cmd.resolution, fastPreview: cmd.fastPreview, draft3d: cmd.draft3d, motionBlur: cmd.motionBlur, adaptiveFloor: cmd.adaptiveFloor };
        return {};
      case 'setAudioPreview':
        if (!(cmd.volume >= 0)) fail('outOfRange', 'volume must be ≥ 0');
        this.audioPreview = { muted: cmd.muted, volume: cmd.volume, scrubAudio: cmd.scrubAudio };
        return {};
      case 'setViewport':
        if (!(cmd.width > 0 && cmd.height > 0)) fail('outOfRange', 'viewport size must be positive');
        this.viewports.set(cmd.viewport, { width: cmd.width, height: cmd.height, devicePixelRatio: cmd.devicePixelRatio, zoom: cmd.zoom });
        return {};
      case 'closeViewport':
        if (!this.viewports.delete(cmd.viewport)) fail('notFound', `no viewport ${cmd.viewport}`);
        return {};
      case 'setCacheBudget':
        this.cacheBudget = { ramMegabytes: cmd.ramMegabytes, diskMegabytes: cmd.diskMegabytes, diskPath: cmd.diskPath };
        return {};
      case 'purgeCache':
        return {};
      case 'setInteracting':
        this.interacting = cmd.interacting;
        return {};
      default:
        return fail('unsupported', `control '${cmd.type}' is not implemented`);
    }
  }

  private seekTo(comp: string, flicks: number): void {
    const fps = compFps(comp);
    // Frame-exact, like the editor's clock mirror.
    this.time = framesToFlicks(flicksToFrames(Math.max(0, flicks), fps), fps);
    if (this.isEditorActive(comp)) getTimelineController().seekSeconds(flicksToSeconds(this.time));
    const s = useProjectStore.getState();
    const tab = s.tabs[s.activeTabId ?? ''];
    if (tab && tab.compositionId === comp) s.actions.commitTime(tab.id, flicksToSeconds(this.time), flicksToFrames(this.time, fps));
  }
}
