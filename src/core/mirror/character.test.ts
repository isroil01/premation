import { boneLabel, characterBones, isCharacter } from './character';

describe('character helpers', () => {
  it('lists bones parents first, each at its depth, named or by id', () => {
    const bones = characterBones({
      bones: [
        { id: 'shin', name: 'Shin L', parentId: 'thigh' },
        { id: 'torso', name: 'Torso', parentId: null },
        { id: 'thigh', parentId: 'torso' },
        { id: 'head', name: 'Head', parentId: 'torso' },
      ],
    });
    expect(bones).toEqual([
      { id: 'torso', label: 'Torso', depth: 0 },
      { id: 'thigh', label: 'thigh', depth: 1 },
      { id: 'shin', label: 'Shin L', depth: 2 },
      { id: 'head', label: 'Head', depth: 1 },
    ]);
  });

  it('keeps a bone on a parent cycle (listed last) and treats a missing parent as the root', () => {
    const bones = characterBones({
      bones: [
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
        { id: 'c', parentId: 'gone' },
      ],
    });
    expect(bones.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('names a bone, falling back to its id', () => {
    const skel = { bones: [{ id: 'b1', name: 'Upper Arm' }, { id: 'b2' }] };
    expect(boneLabel(skel, 'b1')).toBe('Upper Arm');
    expect(boneLabel(skel, 'b2')).toBe('b2');
    expect(boneLabel(undefined, 'b3')).toBe('b3');
  });

  it('knows a character by the engine flag only', () => {
    expect(isCharacter({ character: true })).toBe(true);
    expect(isCharacter({})).toBe(false);
    expect(isCharacter(null)).toBe(false);
  });
});
