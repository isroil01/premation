import { formatAle, type AleEvent } from './exportAle';
import { framesToTimecode } from './exportEdl';

describe('exportAle', () => {
  it('emits Heading / Column / Data sections', () => {
    const events: AleEvent[] = [
      {
        name: 'Shot',
        tracks: 'V1',
        start: framesToTimecode(0, 24),
        end: framesToTimecode(24, 24),
        duration: framesToTimecode(24, 24),
        tape: 'CAM',
        sourceFile: 'cam.mov',
      },
    ];
    const text = formatAle(events, 24);
    expect(text).toContain('Heading');
    expect(text).toContain('Column');
    expect(text).toContain('Data');
    expect(text).toContain('Shot\tV1\t');
    expect(text).toContain('cam.mov');
  });
});
