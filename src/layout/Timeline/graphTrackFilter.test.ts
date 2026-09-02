import {
  filterGraphTracks,
  graphSelectedTrackKeys,
  matchesGraphFilter,
  normalizeGraphQuery,
  selectGraphTracksForMode,
  visibleGraphTracks,
  type GraphTrackDescriptor,
} from './graphTrackFilter';

const track = (
  nodeId: string,
  prop: string,
  label: string,
  layerName: string,
): GraphTrackDescriptor => ({ nodeId, prop, label, layerName });

// Two layers: one called "Logo" with three tracks, one called "Opacity Rig"
// whose NAME contains a word that is also a property name elsewhere — the case
// that separates "the layer matched" from "a property matched".
const TRACKS: GraphTrackDescriptor[] = [
  track('n1', 'x', 'Position', 'Logo'),
  track('n1', 'y', 'Position', 'Logo'),
  track('n1', 'opacity', 'Opacity', 'Logo'),
  track('n2', 'rotation', 'Rotation', 'Opacity Rig'),
  track('n2', 'scale', 'Scale', 'Opacity Rig'),
];

describe('normalizeGraphQuery', () => {
  it('trims, lower-cases, and treats blank as no filter', () => {
    expect(normalizeGraphQuery('  Opacity ')).toBe('opacity');
    expect(normalizeGraphQuery('   ')).toBe('');
    expect(normalizeGraphQuery(undefined)).toBe('');
    expect(normalizeGraphQuery(null)).toBe('');
  });
});

describe('matchesGraphFilter', () => {
  const t = track('n1', 'effect.glow.radius', 'Glow Radius', 'Logo');

  it('matches the engine prop path', () => {
    expect(matchesGraphFilter(t, 'glow.rad')).toBe(true);
  });

  it('matches the display label, case-insensitively', () => {
    expect(matchesGraphFilter(t, 'radius')).toBe(true);
  });

  it('does not match on the layer name (that is a per-layer rule)', () => {
    expect(matchesGraphFilter(t, 'logo')).toBe(false);
  });

  it('passes everything when the query is empty', () => {
    expect(matchesGraphFilter(t, '')).toBe(true);
  });
});

describe('filterGraphTracks', () => {
  it('returns every track when there is no query', () => {
    expect(filterGraphTracks(TRACKS, '')).toHaveLength(5);
    expect(filterGraphTracks(TRACKS, undefined)).toHaveLength(5);
  });

  it('keeps only the matching properties of a layer that has some', () => {
    // "opacity" hits n1.opacity by label AND both n2 tracks via the layer name
    // "Opacity Rig" — but n1 has a property hit, so n1 contributes ONLY that one.
    const out = filterGraphTracks(TRACKS, 'opacity');
    expect(out.map((t) => `${t.nodeId}:${t.prop}`)).toEqual([
      'n1:opacity',
      'n2:rotation',
      'n2:scale',
    ]);
  });

  it('keeps every property of a layer whose NAME matches and whose props do not', () => {
    const out = filterGraphTracks(TRACKS, 'rig');
    expect(out.map((t) => t.nodeId)).toEqual(['n2', 'n2']);
  });

  it('drops a layer that matches neither by name nor by property', () => {
    expect(filterGraphTracks(TRACKS, 'zzz')).toEqual([]);
  });

  it('matches several properties of one layer through a shared label', () => {
    const out = filterGraphTracks(TRACKS, 'position');
    expect(out.map((t) => t.prop)).toEqual(['x', 'y']);
  });

  it('preserves input order, not grouping order', () => {
    const interleaved = [TRACKS[3]!, TRACKS[0]!, TRACKS[4]!, TRACKS[1]!];
    // 'o' hits Rotation and both Position rows, not Scale.
    const out = filterGraphTracks(interleaved, 'o');
    expect(out).toEqual([TRACKS[3]!, TRACKS[0]!, TRACKS[1]!]);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(filterGraphTracks(TRACKS, '  ROTA ').map((t) => t.prop)).toEqual(['rotation']);
  });
});

describe('graphSelectedTrackKeys', () => {
  it('expands the Position pseudo-row into its engine tracks', () => {
    const keys = graphSelectedTrackKeys([{ nodeId: 'n1', prop: 'Position' }]);
    expect(keys.has('n1::x')).toBe(true);
    expect(keys.has('n1::y')).toBe(true);
    expect(keys.has('n1::z')).toBe(true);
    expect(keys.has('n1::Position')).toBe(false);
  });

  it('passes ordinary props through untouched', () => {
    const keys = graphSelectedTrackKeys([{ nodeId: 'n1', prop: 'opacity' }]);
    expect([...keys]).toEqual(['n1::opacity']);
  });

  it('keys are node-scoped — the same prop on another layer is a different key', () => {
    const keys = graphSelectedTrackKeys([{ nodeId: 'n2', prop: 'opacity' }]);
    expect(keys.has('n1::opacity')).toBe(false);
  });
});

describe('selectGraphTracksForMode', () => {
  it('animated mode ignores the selection entirely', () => {
    const out = selectGraphTracksForMode(TRACKS, 'animated', new Set(['n1::opacity']));
    expect(out).toHaveLength(5);
  });

  it('selected mode plots only the selected rows', () => {
    const keys = graphSelectedTrackKeys([
      { nodeId: 'n1', prop: 'Position' },
      { nodeId: 'n2', prop: 'scale' },
    ]);
    const out = selectGraphTracksForMode(TRACKS, 'selected', keys);
    expect(out.map((t) => `${t.nodeId}:${t.prop}`)).toEqual(['n1:x', 'n1:y', 'n2:scale']);
  });

  it('falls back to every track when nothing is selected', () => {
    expect(selectGraphTracksForMode(TRACKS, 'selected', new Set())).toHaveLength(5);
  });

  it('falls back when the selection names nothing that is plotted', () => {
    // A static (never-keyed) row is selectable in the timeline but has no curve.
    const keys = graphSelectedTrackKeys([{ nodeId: 'n1', prop: '__static:anchor' }]);
    expect(selectGraphTracksForMode(TRACKS, 'selected', keys)).toHaveLength(5);
  });

  it('returns a copy, never the input array', () => {
    const out = selectGraphTracksForMode(TRACKS, 'animated', new Set());
    expect(out).not.toBe(TRACKS);
  });
});

describe('visibleGraphTracks', () => {
  const selectedKeys = graphSelectedTrackKeys([{ nodeId: 'n1', prop: 'Position' }]);

  it('applies the filter first, then the mode inside what survived', () => {
    const out = visibleGraphTracks({
      tracks: TRACKS,
      query: 'logo', // whole layer n1
      mode: 'selected',
      selectedKeys,
    });
    expect(out.map((t) => t.prop)).toEqual(['x', 'y']);
  });

  it('falls back within the filtered set, not the whole set', () => {
    // The filter leaves only n2; nothing on n2 is selected, so the fallback is
    // n2's tracks — NOT the selected Position tracks that the filter excluded.
    const out = visibleGraphTracks({
      tracks: TRACKS,
      query: 'rig',
      mode: 'selected',
      selectedKeys,
    });
    expect(out.map((t) => t.nodeId)).toEqual(['n2', 'n2']);
  });

  it('an unmatched filter yields nothing, whatever the mode', () => {
    for (const mode of ['animated', 'selected'] as const) {
      expect(visibleGraphTracks({ tracks: TRACKS, query: 'zzz', mode, selectedKeys })).toEqual([]);
    }
  });
});
