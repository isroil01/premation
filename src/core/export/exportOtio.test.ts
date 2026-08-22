/**
 * OTIO builder: the JSON must be schema-shaped (OTIO_SCHEMA markers, rational
 * times at the timeline rate) and gaps must place clips at their record
 * positions — a wrong gap silently shifts every cut downstream in the NLE.
 */

import { otioTimeline, type OtioTrackSpec } from './exportOtio';

const FPS = 24;

function track(clips: OtioTrackSpec['clips']): OtioTrackSpec {
  return { kind: 'Video', name: 'V1', clips };
}

type Obj = Record<string, any>;

describe('otioTimeline', () => {
  it('emits a Timeline.1 with rational times at the comp rate', () => {
    const doc = otioTimeline([track([{ name: 'shot', mediaName: 'a.mp4', sourceIn: 10, recordIn: 0, duration: 48 }])], FPS, 'T') as Obj;
    expect(doc.OTIO_SCHEMA).toBe('Timeline.1');
    const clip = doc.tracks.children[0].children[0];
    expect(clip.OTIO_SCHEMA).toBe('Clip.1');
    expect(clip.source_range.start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: FPS, value: 10 });
    expect(clip.source_range.duration.value).toBe(48);
    expect(clip.media_reference).toEqual({ OTIO_SCHEMA: 'ExternalReference.1', target_url: 'a.mp4' });
  });

  it('places a leading gap so the clip lands at its record frame', () => {
    const doc = otioTimeline([track([{ name: 's', mediaName: null, sourceIn: 0, recordIn: 30, duration: 20 }])], FPS, 'T') as Obj;
    const [gap, clip] = doc.tracks.children[0].children;
    expect(gap.OTIO_SCHEMA).toBe('Gap.1');
    expect(gap.source_range.duration.value).toBe(30);
    expect(clip.media_reference.OTIO_SCHEMA).toBe('MissingReference.1');
  });

  it('fills inter-clip gaps from bar geometry, sorted by record time', () => {
    const doc = otioTimeline([track([
      { name: 'b', mediaName: 'b.mp4', sourceIn: 0, recordIn: 50, duration: 25 },
      { name: 'a', mediaName: 'a.mp4', sourceIn: 5, recordIn: 0, duration: 40 },
    ])], FPS, 'T') as Obj;
    const kids = doc.tracks.children[0].children;
    // a (0..40), gap(10), b (50..75)
    expect(kids.map((k: Obj) => k.OTIO_SCHEMA)).toEqual(['Clip.1', 'Gap.1', 'Clip.1']);
    expect(kids[0].name).toBe('a');
    expect(kids[1].source_range.duration.value).toBe(10);
    expect(kids[2].name).toBe('b');
  });

  it('omits the gap for back-to-back cuts', () => {
    const doc = otioTimeline([track([
      { name: 'a', mediaName: 'a.mp4', sourceIn: 0, recordIn: 0, duration: 24 },
      { name: 'b', mediaName: 'b.mp4', sourceIn: 0, recordIn: 24, duration: 24 },
    ])], FPS, 'T') as Obj;
    expect(doc.tracks.children[0].children.map((k: Obj) => k.OTIO_SCHEMA)).toEqual(['Clip.1', 'Clip.1']);
  });
});
