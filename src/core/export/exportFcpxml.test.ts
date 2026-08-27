import { buildFcpxml, fcpFrameDuration, type FcpxmlClip } from './exportFcpxml';

describe('exportFcpxml', () => {
  it('emits FCPXML 1.9 with asset-clips at frame rates', () => {
    const clips: FcpxmlClip[] = [
      { name: 'A', mediaName: 'camA.mov', sourceIn: 10, recordIn: 0, duration: 30, kind: 'video' },
      { name: 'B', mediaName: 'camB.mov', sourceIn: 0, recordIn: 30, duration: 15, kind: 'video' },
    ];
    const xml = buildFcpxml(clips, 30, 'Test');
    expect(xml).toContain('fcpxml version="1.9"');
    expect(xml).toContain('asset-clip');
    expect(xml).toContain('offset="0/30s"');
    expect(xml).toContain('offset="30/30s"');
    expect(xml).toContain('start="10/30s"');
    expect(xml).toContain('camA.mov');
  });

  it('declares a real <format> resource the sequence references', () => {
    const clips: FcpxmlClip[] = [
      { name: 'A', mediaName: 'camA.mov', sourceIn: 0, recordIn: 0, duration: 30, kind: 'video' },
    ];
    const xml = buildFcpxml(clips, 30, 'Test', { width: 1920, height: 1080 });
    expect(xml).toContain('<format id="r1"');
    expect(xml).toContain('frameDuration="1/30s"');
    expect(xml).toContain('width="1920" height="1080"');
    expect(xml).toContain('<sequence format="r1"');
    // Assets start at r2 — r1 is the format, not the first piece of media.
    expect(xml).toContain('<asset id="r2" name="camA.mov"');
  });

  it('uses 1001-based rationals for NTSC rates', () => {
    expect(fcpFrameDuration(23.976)).toEqual({ num: 1001, den: 24000 });
    expect(fcpFrameDuration(29.97)).toEqual({ num: 1001, den: 30000 });
    expect(fcpFrameDuration(59.94)).toEqual({ num: 1001, den: 60000 });
    expect(fcpFrameDuration(24)).toEqual({ num: 1, den: 24 });

    const clips: FcpxmlClip[] = [
      { name: 'A', mediaName: 'a.mov', sourceIn: 0, recordIn: 30, duration: 60, kind: 'video' },
    ];
    const xml = buildFcpxml(clips, 29.97, 'T');
    expect(xml).toContain('frameDuration="1001/30000s"');
    // Every time is an exact multiple of the frame duration: frame 30 = 30030/30000s.
    expect(xml).toContain('offset="30030/30000s"');
    expect(xml).toContain('duration="60060/30000s"');
  });

  it('flags asset streams by kind instead of claiming video+audio for everything', () => {
    const clips: FcpxmlClip[] = [
      { name: 'V', mediaName: 'v.mov', sourceIn: 0, recordIn: 0, duration: 10, kind: 'video' },
      { name: 'A', mediaName: 'a.wav', sourceIn: 0, recordIn: 10, duration: 10, kind: 'audio' },
      { name: 'I', mediaName: 'i.png', sourceIn: 0, recordIn: 20, duration: 10, kind: 'image' },
    ];
    const xml = buildFcpxml(clips, 30, 'T');
    expect(xml).toContain('name="v.mov" hasVideo="1" hasAudio="1"');
    expect(xml).toMatch(/name="a\.wav" hasAudio="1"/);
    expect(xml).not.toMatch(/name="a\.wav"[^/]*hasVideo/);
    expect(xml).toMatch(/name="i\.png" hasVideo="1"/);
    expect(xml).not.toMatch(/name="i\.png"[^/]*hasAudio/);
  });

  it('escapes XML special characters in names', () => {
    const xml = buildFcpxml(
      [{ name: 'A&B <cut>', mediaName: 'x.mov', sourceIn: 0, recordIn: 0, duration: 1, kind: 'video' }],
      24,
      'T',
    );
    expect(xml).toContain('A&amp;B &lt;cut&gt;');
  });
});
