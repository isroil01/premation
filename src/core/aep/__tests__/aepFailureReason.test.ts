import { aepFailureReason } from '../aepImportReport';

describe('aepFailureReason', () => {
  it('sorts the engine and page messages into codes that name the kind of file, never the file', () => {
    expect(aepFailureReason('not an After Effects project: expected "RIFX", found "PK??"')).toBe('aep_not_rifx');
    expect(aepFailureReason('not an After Effects project: expected "RIFX", found "RIFF" (this looks like a RIFF media file, not a project)')).toBe('aep_riff_media');
    expect(aepFailureReason('not an After Effects project: unexpected form type "WAVE"')).toBe('aep_not_rifx');
    expect(aepFailureReason('file is too short to be an After Effects project')).toBe('aep_too_short');
    expect(aepFailureReason('not an After Effects XML project: no <AfterEffectsProject> element')).toBe('aep_xml');
    expect(aepFailureReason('That After Effects project has no compositions in it. Only its footage list could be read, so there is nothing to open.')).toBe('aep_no_comps');
    expect(aepFailureReason('project has an implausible number of chunks — refusing to continue')).toBe('aep_corrupt');
    expect(aepFailureReason("could not read '/Users/ada/secret.aep'")).toBe('aep_io');
    expect(aepFailureReason('opening an After Effects project needs the desktop app')).toBe('aep_needs_desktop');
    expect(aepFailureReason('this engine does not convert After Effects projects')).toBe('aep_engine_unsupported');
    expect(aepFailureReason('importProject: the renderer is busy; ask again')).toBe('aep_engine_busy');
    expect(aepFailureReason('something nobody has seen yet')).toBe('aep_unreadable');
  });
});
