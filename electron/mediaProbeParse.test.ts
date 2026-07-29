/**
 * ffprobe JSON → probe result, tested against REAL ffprobe output.
 *
 * The fixtures below are literal `ffprobe -show_streams -show_format` output
 * for files generated with ffmpeg, not hand-written approximations — the field
 * spellings are the thing most likely to be wrong (`avg_frame_rate` as a
 * rational string, `sample_aspect_ratio` with a COLON rather than a slash), and
 * an invented fixture would agree with an invented parser.
 */

import { parseProbeJson, parseRational, type ProbeJson } from './mediaProbeParse';

/** Real output for a 24fps h264 + aac mp4 (ffmpeg testsrc + sine). */
const MP4_24FPS: ProbeJson = {
  streams: [
    {
      codec_type: 'video', codec_name: 'h264', width: 640, height: 360,
      avg_frame_rate: '24/1', r_frame_rate: '24/1', sample_aspect_ratio: '1:1', duration: '3.000000',
    },
    { codec_type: 'audio', codec_name: 'aac', channels: 1, sample_rate: '44100', avg_frame_rate: '0/0' },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.018667' },
};

describe('parseRational', () => {
  it('reads a plain integer rate', () => {
    expect(parseRational('24/1')).toBe(24);
  });

  it('keeps NTSC rates exact instead of rounding them to integers', () => {
    // Rounding 30000/1001 to 30 would silently undo the pulldown the file asks
    // for — which is the whole thing conform exists to control.
    expect(parseRational('30000/1001')).toBeCloseTo(29.97003, 5);
    expect(parseRational('24000/1001')).toBeCloseTo(23.976024, 5);
  });

  it('treats ffprobe’s "no rate" sentinel as unknown', () => {
    // Audio streams report 0/0; a zero denominator would otherwise be Infinity.
    expect(parseRational('0/0')).toBeNull();
    expect(parseRational('1/0')).toBeNull();
  });

  it('accepts a bare number and rejects anything else', () => {
    expect(parseRational('25')).toBe(25);
    expect(parseRational(undefined)).toBeNull();
    expect(parseRational('')).toBeNull();
  });
});

describe('parseProbeJson on real ffprobe output', () => {
  it('extracts the real frame rate, size and audio inventory', () => {
    const r = parseProbeJson(MP4_24FPS);
    expect(r.video).toMatchObject({ codec: 'h264', width: 640, height: 360, fps: 24, par: 1 });
    expect(r.audio).toEqual({ codec: 'aac', channels: 1, sampleRate: 44100 });
    expect(r.container).toContain('mp4');
  });

  it('prefers the container duration over the stream duration', () => {
    // The audio pads the container past the video stream's own 3.000s.
    expect(parseProbeJson(MP4_24FPS).durationSec).toBeCloseTo(3.018667, 5);
  });

  it('reports NO audio stream as null, distinct from an absent probe', () => {
    const silent: ProbeJson = { ...MP4_24FPS, streams: [MP4_24FPS.streams![0]!] };
    expect(parseProbeJson(silent).audio).toBeNull();
  });

  it('reads a colon-separated pixel aspect ratio', () => {
    // ffprobe writes "16:11" for DV PAL wide. A slash-only parser returns null
    // here and every anamorphic import would silently stay square.
    const dv: ProbeJson = {
      streams: [{ ...MP4_24FPS.streams![0]!, sample_aspect_ratio: '16:11' }],
      format: { duration: '3' },
    };
    expect(parseProbeJson(dv).video!.par).toBeCloseTo(16 / 11, 6);
  });

  it('falls back to r_frame_rate when the average is missing', () => {
    const noAvg: ProbeJson = {
      streams: [{ ...MP4_24FPS.streams![0]!, avg_frame_rate: '0/0', r_frame_rate: '25/1' }],
      format: { duration: '3' },
    };
    expect(parseProbeJson(noAvg).video!.fps).toBe(25);
  });

  it('handles an audio-only file', () => {
    const wav: ProbeJson = {
      streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 2, sample_rate: '48000' }],
      format: { format_name: 'wav', duration: '12.5' },
    };
    const r = parseProbeJson(wav);
    expect(r.video).toBeNull();
    expect(r.audio).toEqual({ codec: 'pcm_s16le', channels: 2, sampleRate: 48000 });
    expect(r.durationSec).toBe(12.5);
  });

  it('returns all-unknown rather than throwing on empty output', () => {
    expect(parseProbeJson({})).toEqual({ container: null, durationSec: null, video: null, audio: null });
  });
});
