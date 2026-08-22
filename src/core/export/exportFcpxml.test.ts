import { buildFcpxml, type FcpxmlClip } from './exportFcpxml';

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

  it('escapes XML special characters in names', () => {
    const xml = buildFcpxml(
      [{ name: 'A&B <cut>', mediaName: 'x.mov', sourceIn: 0, recordIn: 0, duration: 1, kind: 'video' }],
      24,
      'T',
    );
    expect(xml).toContain('A&amp;B &lt;cut&gt;');
  });
});
