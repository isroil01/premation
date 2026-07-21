import { detectImageSequence, sequenceFrameAt, sequenceSrcAt } from './imageSequence';

describe('detectImageSequence', () => {
  test('orders by trailing frame number, out-of-order input', () => {
    const d = detectImageSequence(['f_010.png', 'f_002.png', 'f_001.png']);
    expect(d?.frames).toEqual(['f_001.png', 'f_002.png', 'f_010.png']);
    expect(d?.base).toBe('f');
  });

  test('handles unpadded numbers correctly (9 before 10)', () => {
    const d = detectImageSequence(['shot9.jpg', 'shot10.jpg', 'shot1.jpg']);
    expect(d?.frames).toEqual(['shot1.jpg', 'shot9.jpg', 'shot10.jpg']);
  });

  test('null for a single file or unnumbered files', () => {
    expect(detectImageSequence(['only.png'])).toBeNull();
    expect(detectImageSequence(['a.png', 'b.png'])).toBeNull();
  });
});

describe('sequenceFrameAt', () => {
  const N = 5; // frames 0..4
  const FPS = 10;
  test('picks the frame for the source time', () => {
    expect(sequenceFrameAt(0, FPS, N)).toBe(0);
    expect(sequenceFrameAt(0.25, FPS, N)).toBe(2); // 0.25*10 = 2.5 → floor 2
    expect(sequenceFrameAt(0.4, FPS, N)).toBe(4);
  });
  test('holds the last frame past the end', () => {
    expect(sequenceFrameAt(100, FPS, N)).toBe(4);
  });
  test('clamps below zero', () => {
    expect(sequenceFrameAt(-5, FPS, N)).toBe(0);
  });

  test('loop wraps modulo the frame count instead of holding', () => {
    // 5 frames @ 10fps: t=0.5 → frame 5 → wraps to 0; t=0.7 → 7 → 2
    expect(sequenceFrameAt(0.5, FPS, N, true)).toBe(0);
    expect(sequenceFrameAt(0.7, FPS, N, true)).toBe(2);
    // without loop those hold the last frame
    expect(sequenceFrameAt(0.5, FPS, N, false)).toBe(4);
  });
});

describe('sequenceSrcAt', () => {
  const seq = { frames: ['a', 'b', 'c'], fps: 10 };
  test('resolves the URL for the time', () => {
    expect(sequenceSrcAt(seq, 0)).toBe('a');
    expect(sequenceSrcAt(seq, 0.1)).toBe('b');
    expect(sequenceSrcAt(seq, 5)).toBe('c'); // held
  });
});
