import { framesToTimecode, formatEdl, type EdlEvent } from './exportEdl';

describe('exportEdl', () => {
  it('formats non-drop timecode', () => {
    expect(framesToTimecode(0, 30)).toBe('00:00:00:00');
    expect(framesToTimecode(30, 30)).toBe('00:00:01:00');
    expect(framesToTimecode(90, 30)).toBe('00:00:03:00');
    expect(framesToTimecode(1799, 24)).toBe('00:01:14:23');
  });

  it('serializes CMX-style events', () => {
    const events: EdlEvent[] = [
      {
        event: 1,
        reel: 'SHOT01',
        track: 'V',
        transition: 'C',
        sourceIn: '00:00:00:00',
        sourceOut: '00:00:05:00',
        recordIn: '00:00:00:00',
        recordOut: '00:00:05:00',
        comment: '* FROM CLIP NAME: A',
      },
    ];
    const text = formatEdl('MOTION', events);
    expect(text).toContain('TITLE: MOTION');
    expect(text).toContain('FCM: NON-DROP FRAME');
    expect(text).toMatch(/001\s+SHOT01\s+V\s+C/);
    expect(text).toContain('00:00:00:00 00:00:05:00 00:00:00:00 00:00:05:00');
    expect(text).toContain('* FROM CLIP NAME: A');
  });
});
