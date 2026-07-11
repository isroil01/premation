# @motion/scene — Scene Graph Engine

The framework-independent core of the motion editor. Every object in the editor
is a `SceneNode` inside a `Scene`. No React, no DOM, no rendering, no timeline —
pure data + systems. Every other engine (timeline, animation, rendering,
effects, physics, export, AI) reads from and writes to this graph.

## Architecture

```
Scene
 └─ root
     └─ Composition
         └─ Group
             └─ Object (Rectangle, Text, Image, Camera, Light, …)
```

- **Nodes** use **composition over inheritance**: a node is a bag of components.
  Every node owns a `TransformComponent`; the rest (Fill, Stroke, Text, Media,
  Camera, Light, …) are optional data components. New node/component types are
  **registered**, never subclassed.
- **Systems** are pure functions over the graph: traversal (DFS/BFS/visitor) and
  the transform system (dirty-aware world-matrix computation).
- **Events** are emitted for every structural/state change.
- **Serialization** is versioned and migration-ready.
- **Validation** prevents cycles, duplicate ids, and broken references.
- **Performance**: O(1) id index, iterative traversal (100k+ nodes, deep chains
  without stack overflow), dirty flags + lazy matrices.

## Public API

```ts
import {
  Scene, createCompositionNode, createRectangleNode, createTextNode,
  serializeScene, deserializeScene, dfs, bfs, visit, updateWorldTransforms,
} from '@motion/scene';

const scene = new Scene();

const comp = scene.add(createCompositionNode({ name: 'Main' }));
const box  = scene.add(createRectangleNode({ name: 'Box' }), comp);

box.transform.setPosition(120, 60);
box.transform.setRotation(30);
box.opacity = 0.5;

scene.updateTransforms();
box.transform.getWorldMatrix();      // a,b,c,d,e,f

scene.selection.set([box.id]);       // single / multi / named groups
scene.on('NodeUpdated', (e) => { /* … */ });

scene.query((n) => n.type === 'rectangle');
scene.flatten();                     // all nodes, layer order

const doc = scene.serialize();       // versioned JSON
const restored = deserializeScene(doc);
```

### Structural operations
`add` · `insert` · `remove` / `delete` · `move` · `duplicate` · `find` ·
`contains` · `query` · `getByType` · `getByName` · `first` · `walk` ·
`flatten` · `clone` · `updateTransforms` · `audit`

### Interop (for loose-`props` / id-graph consumers)
`GraphFacade(scene)` exposes the classic id-addressed API
(`getNode`/`getRoots`/`getChildren`/`traverse`/`addNode`/`addChild`/`removeNode`/`size`).
`readFlat` / `writeFlat` / `listFlat` project a node's typed components onto a
flat property namespace (`x`, `y`, `rotation`, `opacity`, `fill`, `content`…)
via a schema — the drop-in bridge for migrating an older loose-`props` app onto
this engine without rewriting every reader.

### Node factories
`createCompositionNode`, `createGroupNode`, `createNullNode`,
`createRectangleNode`, `createEllipseNode`, `createPolygonNode`,
`createPathNode`, `createTextNode`, `createImageNode`, `createVideoNode`,
`createAudioNode`, `createSVGNode`, `createCameraNode`, `createLightNode`,
`createComponentNode`, `createParticleNode`. Add your own with
`registerNodeType(type, defaultComponents)`.

## Scripts

```
npm run typecheck   # tsc --noEmit
npm run test        # jest
```

40 unit tests cover hierarchy, traversal, transforms, selection, events,
serialization (round-trip + migration), and performance (100k nodes, 50k-deep).
