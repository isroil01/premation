import {
  Scene,
  createCompositionNode,
  createRectangleNode,
  createTextNode,
  serializeScene,
  deserializeScene,
  registerMigration,
  SCENE_FORMAT_VERSION,
  DataComponent,
  type SerializedScene,
} from '../index';

function sampleScene(): Scene {
  const scene = new Scene();
  const comp = scene.add(createCompositionNode({ name: 'Main' }));
  const rect = scene.add(createRectangleNode({ name: 'Box' }), comp);
  rect.transform.setPosition(120, 60);
  rect.transform.setRotation(30);
  rect.opacity = 0.5;
  rect.blendMode = 'multiply';
  rect.metadata = { tag: 'hero' };
  rect.custom.note = 'important';
  const text = scene.add(createTextNode({ name: 'Title' }), comp);
  text.getComponent<DataComponent>('text')?.set('content', 'Hello');
  return scene;
}

describe('Serialization', () => {
  it('round-trips a scene losslessly', () => {
    const scene = sampleScene();
    const json = serializeScene(scene);
    expect(json.version).toBe(SCENE_FORMAT_VERSION);

    const restored = deserializeScene(json);
    expect(restored.size).toBe(scene.size);

    const original = scene.flatten();
    const copy = restored.flatten();
    expect(copy.map((n) => n.name)).toEqual(original.map((n) => n.name));

    const box = restored.getByName('Box')[0]!;
    expect(box.id).toBe(scene.getByName('Box')[0]!.id);
    expect(box.opacity).toBe(0.5);
    expect(box.blendMode).toBe('multiply');
    expect(box.metadata).toEqual({ tag: 'hero' });
    expect(box.custom.note).toBe('important');
    expect(box.transform.position).toEqual({ x: 120, y: 60 });
    expect(box.transform.rotation).toBe(30);
  });

  it('serializes to plain JSON-safe data (survives stringify)', () => {
    const scene = sampleScene();
    const json = serializeScene(scene);
    const roundTripped = JSON.parse(JSON.stringify(json)) as SerializedScene;
    const restored = deserializeScene(roundTripped);
    expect(restored.getByName('Title')[0]?.getComponent('text')).toBeTruthy();
  });

  it('preserves hierarchy and parent links', () => {
    const restored = deserializeScene(serializeScene(sampleScene()));
    const comp = restored.getByName('Main')[0]!;
    expect(comp.children.map((c) => c.name).sort()).toEqual(['Box', 'Title']);
    expect(restored.audit()).toEqual([]);
  });

  it('applies migrations for older versions', () => {
    // Register a migration from a hypothetical v0 → v1.
    registerMigration(0, (data) => ({ ...data, version: 1 }));
    const scene = sampleScene();
    const doc = serializeScene(scene);
    const legacy: SerializedScene = { ...doc, version: 0 };
    const restored = deserializeScene(legacy);
    expect(restored.size).toBe(scene.size);
  });
});
