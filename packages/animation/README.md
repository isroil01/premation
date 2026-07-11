# @motion/animation

The framework-independent **Animation Engine** for the AI-native motion editor.

It owns the *value-over-time* layer: keyframe property tracks, interpolation and
easing, and JavaScript-style expressions. Given a time it samples every track
(expressions overriding keyframed values) into a `SceneValueSnapshot` the
renderer merges over the scene graph's base values. It never mutates the scene
graph during playback — authoring keyframes are the truth; sampled values are
derived and disposable.

No React, no DOM, no app spine. The engine is decoupled from the host's event
bus via an injectable change listener:

```ts
import { defaultAnimation } from '@motion/animation';

// The host maps engine changes onto its own event system at boot.
defaultAnimation.setChangeListener((nodeId) => bus.emit('AnimationChanged', { nodeId }));
```

## Surface

- `AnimationEngine` / `defaultAnimation` — track + expression store, sampling,
  atomic track capture/restore (`getTrackKeyframes` / `setTrackKeyframes`), and
  a serializable `snapshot()` / `restore()` (`AnimSnapshot`).
- `sampleTrack`, `upsertKeyframe`, `ease`, `cubicBezierEase` — interpolation.
- `compileExpression`, `tokenizeExpression`, … — the expression subsystem.
- `makeKeyframeId` / `parseKeyframeId` — timeline ↔ engine keyframe references.

Typed, reversible *editing* commands live in the app layer
(`src/core/animation/animationCommands.ts`) because they depend on the app's
CommandSystem — the engine itself stays dependency-free.

## Test

```
npm run test --prefix packages/animation   # or: jest from the repo root
```
