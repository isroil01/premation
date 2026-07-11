Core Roadmap — next work items

1. Finalize TypeScript interfaces (done: `src/core/types.ts`).
2. Implement minimal `SceneGraph` manager: add/remove nodes, parent/child, traversal, and transform propagation.
3. Implement `TimelineEngine` scaffold: play/pause/scrub and eval helpers.
4. Create `AssetService` for registering/loading assets.
5. Wire an `EventBus` singleton in `src/core/events` to decouple components and engines.
6. Add unit tests for `SceneGraph`, `TimelineEngine`, and `AssetService`.

I will implement step 2 (`SceneGraph` manager) next unless you want a different priority.
