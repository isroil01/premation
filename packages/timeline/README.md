# @motion/timeline

The framework-independent **Timeline Engine** — the data engine that manages all
temporal data in the editor: tracks, layers, clips, markers, the playhead, time
ranges, selection, and navigation.

It does **not** render, does **not** animate objects, and does **not** touch
React/DOM or timers. It stores, organizes, queries, and mutates time-based data,
emits typed events, and keeps its own undo/redo history. Architecturally
comparable to the After Effects timeline.

## Design

- **Canonical unit: frames.** Everything is stored in frames (a number, usually
  integer, fractional during smooth playback). The `time/` helpers convert to and
  from milliseconds, seconds, and SMPTE timecode for any frame rate (24, 25, 30,
  60, 120, 23.976, 29.97, …).
- **Timer-free playback.** `play()`/`pause()`/`stop()` are state; an external
  clock advances time via `tick(dtMs)` (loop-aware) or `nextFrame()`. This keeps
  the engine independent of any host loop.
- **Undoable by construction.** Every structural mutation routes through a local
  `History` (command + inverse), so undo/redo works out of the box. Disable it
  (`timeline.history.setEnabled(false)`) for bulk loads, or mirror commands into a
  global command system via events.
- **Built for scale.** O(1) id lookups (tracks/layers), O(log n) marker queries
  (sorted + binary search), tested with thousands of tracks/layers/markers.

## Object model

```
Timeline
├── frameRate, duration, playhead, selection, ranges (loop/preview/workArea), view
├── markers (timeline-scoped)
└── tracks[]                     ← ordered lanes
    ├── flags (locked/hidden/muted/solo), kind, groupId, markers
    └── layers[]                 ← ordered stack
        ├── clip (start/duration/sourceIn/sourceDuration) — trim/split geometry
        ├── sourceId → Scene Graph node, enabled/locked, metadata
        └── markers (layer-scoped, relative)
```

## Public API

```ts
import { Timeline, FPS_30 } from '@motion/timeline';

const t = Timeline.create({ name: 'Comp 1', duration: 300, frameRate: FPS_30 });

// Structure
const v1 = t.addTrack({ name: 'V1', kind: 'video' });
const layer = t.addLayer(v1.id, { name: 'Clip', clip: { start: 0, duration: 100 }, sourceId: 'node_1' });
t.splitLayer(layer.id, 40);
t.trimLayer(layer.id, 'end', 30);
t.moveLayer(layer.id, v1.id, 0);
t.duplicateTrack(v1.id);
t.groupTracks([v1.id], 'Group');

// Time
t.seek(75); t.seekTimecode('00:00:03:00'); t.nextFrame(); t.goToEnd();
t.setDuration(600); t.setFrameRate(24, { preserveTiming: true });

// Playback (drive from your frame loop)
t.play();
requestAnimationFrame(function loop(){ t.tick(16.7); if (t.isPlaying) requestAnimationFrame(loop); });

// Markers & ranges
t.addMarker({ frame: 60, name: 'beat', color: '#f0f' });
t.setRange('workArea', { start: 10, duration: 200 });

// Navigation (view state; the renderer reads it)
t.setViewportWidth(1200); t.fit(); t.zoomIn(); t.centerPlayhead();

// Query
t.activeLayersAt(50);         // honors hidden/mute/solo
t.layersInRange(0, 120);
t.contentEnd();

// Undo / serialize
t.history.undo(); t.history.redo();
const doc = t.serialize();
const restored = Timeline.deserialize(doc);

// React to changes
t.events.on('CurrentTimeChanged', ({ frame, seconds }) => …);
t.events.on('LayerAdded', ({ layer }) => …);
```

## Events

`TimelineCreated`, `TimelineDestroyed`, `TrackAdded/Removed/Moved/FlagsChanged/Updated`,
`LayerAdded/Removed/Moved/Trimmed/Split/Updated`, `PlayheadMoved`,
`CurrentTimeChanged`, `PlayStateChanged`, `DurationChanged`, `FrameRateChanged`,
`TimelineZoomChanged`, `TimelineScrollChanged`, `TimelineSelectionChanged`,
`MarkerAdded/Removed/Updated`, `RangeChanged`.

## Integration (ports)

The engine owns its data and never imports the app. It cooperates through typed
seams (`ports.ts`): `SourceResolver` (bound source lengths for trims),
`TimelineCommandSink` (mirror into a global undo stack), `TimeConsumer` (the
Animation Engine sampling `CurrentTimeChanged`), and a `TimelineEventForwarder`
to relay events onto an app event bus. Layers link to Scene Graph nodes by
`sourceId`.

## Tests

```
npm test   # from packages/timeline, or:
npx jest --config packages/timeline/jest.config.cjs
```

55 tests, headless (Node): time conversion & timecode round-trips, clip
trim/split, playhead/seeking, tracks, layers, markers, ranges, navigation,
timer-free playback + looping, history undo/redo, serialization round-trip +
migrations, events, and performance (5k layers, 5k markers).
