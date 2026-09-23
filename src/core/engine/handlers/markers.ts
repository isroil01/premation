/**
 * Markers (ENGINE_API.md §4.8). Composition markers live on the comp's
 * timeline, layer markers on the layer's (first) bar, in LAYER time — the
 * frame is relative to the bar's start, so markers travel with the layer.
 * Marker ids are engine-minted; the `tl:<comp>` part is the inverse.
 */

import { Marker, type MarkerData, type Layer as Bar, type Timeline } from '@motion/timeline';
import type { MarkerOwner, MarkerPatch } from '@motion/engine-api';
import { getTimelineController } from '@core/timeline/TimelineController';
import { fail } from '../errors';
import { requireComp, requireLayer, compOfLayer, compItemIds } from '../doc';
import { newScope, scopeTimeline, type Scope } from '../state';
import { compFps, flicksToFrames, checkTime } from '../time';
import { labelColorOf, barsOf } from '../model';
import type { HandlerTable } from '../handler';
import { ensureTimeline, plural } from './common';

interface Found {
  comp: string;
  timeline: Timeline;
  marker: Marker;
  bar: Bar | null;
}

function owner(o: MarkerOwner): { comp: string; bar: Bar | null } {
  requireComp(o.comp);
  ensureTimeline(o.comp);
  if (!o.layer) return { comp: o.comp, bar: null };
  requireLayer(o.layer);
  if (compOfLayer(o.layer) !== o.comp) fail('invalidArgument', 'the layer is not in that composition', { layer: o.layer });
  const bar = barsOf(o.layer, o.comp)[0];
  if (!bar) fail('invalidArgument', `layer '${o.layer}' has no bar to hold markers`, { layer: o.layer });
  return { comp: o.comp, bar };
}

function findMarker(id: string): Found {
  const c = getTimelineController();
  for (const comp of compItemIds()) {
    const reg = c.peekTimeline(comp);
    if (!reg) continue;
    const m = reg.timeline.markers.get(id);
    if (m) return { comp, timeline: reg.timeline, marker: m, bar: null };
    for (const bar of reg.timeline.getTrack(reg.trackId)?.layers ?? []) {
      const lm = bar.markers.get(id);
      if (lm) return { comp, timeline: reg.timeline, marker: lm, bar };
    }
  }
  return fail('notFound', `no marker '${id}'`);
}

function scopeFor(comps: Iterable<string>): Scope {
  const s = newScope();
  for (const c of comps) scopeTimeline(s, c);
  return s;
}

export const markerHandlers: HandlerTable = {
  addMarkers: (cmd, ctx) => {
    if (cmd.markers.length === 0) fail('invalidArgument', 'no markers given');
    const plans = cmd.markers.map((m) => {
      checkTime(m.time);
      checkTime(m.duration, 'duration');
      if (m.duration < 0) fail('outOfRange', 'a marker duration cannot be negative');
      if (m.label > 0 && !labelColorOf(m.label)) fail('outOfRange', `label ${m.label} does not exist`);
      const o = owner(m.owner);
      return { m, o, id: ctx.mintMarkerId() };
    });
    return {
      scope: scopeFor(plans.map((p) => p.o.comp)),
      label: `Add ${plural(plans.length, 'Marker')}`,
      apply: () => {
        for (const { m, o, id } of plans) {
          const fps = compFps(o.comp);
          const reg = getTimelineController().peekTimeline(o.comp)!;
          const data: Partial<MarkerData> & { frame: number } = {
            id,
            frame: flicksToFrames(m.time, fps),
            duration: flicksToFrames(m.duration, fps),
            name: m.name,
            comment: m.comment,
            color: labelColorOf(m.label) ?? null,
            scope: o.bar ? 'layer' : 'timeline',
            ownerId: o.bar ? o.bar.id : null,
          };
          reg.timeline.history.silently(() => {
            const marker = new Marker(data);
            if (o.bar) o.bar.markers.add(marker);
            else reg.timeline.markers.add(marker);
          });
        }
        return { ids: plans.map((p) => p.id) };
      },
    };
  },

  updateMarkers: (cmd) => {
    if (cmd.patches.length === 0) fail('invalidArgument', 'no patches given');
    const plans = cmd.patches.map((p: MarkerPatch) => {
      const f = findMarker(p.id);
      if (p.time !== undefined) checkTime(p.time);
      if (p.duration !== undefined) { checkTime(p.duration, 'duration'); if (p.duration < 0) fail('outOfRange', 'a marker duration cannot be negative'); }
      if (p.label !== undefined && p.label > 0 && !labelColorOf(p.label)) fail('outOfRange', `label ${p.label} does not exist`);
      return { f, p };
    });
    return {
      scope: scopeFor(plans.map((x) => x.f.comp)),
      label: 'Edit Marker',
      apply: () => {
        for (const { f, p } of plans) {
          const fps = compFps(f.comp);
          const m = f.marker;
          if (p.time !== undefined) m.frame = flicksToFrames(p.time, fps);
          if (p.duration !== undefined) m.duration = flicksToFrames(p.duration, fps);
          if (p.name !== undefined) m.name = p.name;
          if (p.comment !== undefined) m.comment = p.comment;
          if (p.label !== undefined) m.color = labelColorOf(p.label) ?? null;
          if (p.chapter !== undefined) m.chapter = p.chapter;
          if (p.url !== undefined) m.url = p.url;
          if (p.cuePoint !== undefined) m.cuePoint = p.cuePoint;
          if (p.protectedRegion !== undefined) m.protectedRegion = p.protectedRegion;
          (f.bar ? f.bar.markers : f.timeline.markers).reindex();
        }
        return {};
      },
    };
  },

  deleteMarkers: (cmd) => {
    if (cmd.ids.length === 0) fail('invalidArgument', 'no markers given');
    const found = cmd.ids.map(findMarker);
    return {
      scope: scopeFor(found.map((f) => f.comp)),
      label: `Delete ${plural(found.length, 'Marker')}`,
      apply: () => {
        for (const f of found) (f.bar ? f.bar.markers : f.timeline.markers).remove(f.marker.id);
        return {};
      },
    };
  },

  moveMarkers: (cmd) => {
    checkTime(cmd.delta, 'delta');
    const found = cmd.ids.map(findMarker);
    return {
      scope: scopeFor(found.map((f) => f.comp)),
      label: `Move ${plural(found.length, 'Marker')}`,
      apply: () => {
        for (const f of found) {
          const d = flicksToFrames(cmd.delta, compFps(f.comp));
          f.marker.frame = f.marker.frame + d;
          (f.bar ? f.bar.markers : f.timeline.markers).reindex();
        }
        return {};
      },
    };
  },
};
