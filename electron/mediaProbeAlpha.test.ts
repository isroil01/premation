/**
 * Detecting whether footage carries an alpha channel.
 *
 * The shapes below are the fields REAL ffprobe emitted for real files, generated
 * with ffmpeg 8.1.1 and probed with `-show_streams`:
 *
 *   VP9 / WebM, alpha    pix_fmt yuv420p       tags.alpha_mode "1"
 *   ProRes 4444 / MOV    pix_fmt yuva444p12le  no tag
 *   PNG, alpha           pix_fmt rgba          no tag
 *   TGA, alpha           pix_fmt bgra          no tag
 *   H.264 / MP4, opaque  pix_fmt yuv420p       no tag
 *
 * The WebM row is the reason this takes two signals instead of one. Matroska
 * carries alpha as a separate stream and announces it with a container tag, so
 * its pixel format is indistinguishable from opaque video — a `pix_fmt`-only
 * test, which is the obvious implementation, reports one of the two formats
 * people actually deliver alpha in as having none.
 *
 * What this does NOT tell us is whether the colour was premultiplied. No field
 * in any of those files records it, which is why that stays a user setting.
 */

import { parseProbeJson, streamHasAlpha, type ProbeStream } from './mediaProbeParse';

const video = (extra: Partial<ProbeStream>): ProbeStream => ({
  codec_type: 'video', width: 64, height: 64, avg_frame_rate: '25/1', ...extra,
});

describe('alpha presence, from what ffprobe actually reports', () => {
  it('VP9/WebM alpha — detected by the container tag, NOT by pix_fmt', () => {
    const s = video({ codec_name: 'vp9', pix_fmt: 'yuv420p', tags: { alpha_mode: '1' } });
    expect(streamHasAlpha(s)).toBe(true);
    // The trap, stated: its pixel format alone says opaque.
    expect(streamHasAlpha(video({ codec_name: 'vp9', pix_fmt: 'yuv420p' }))).toBe(false);
  });

  it('ProRes 4444 — detected by pix_fmt', () => {
    expect(streamHasAlpha(video({ codec_name: 'prores', pix_fmt: 'yuva444p12le' }))).toBe(true);
  });

  it('PNG and TGA — packed alpha formats', () => {
    expect(streamHasAlpha(video({ codec_name: 'png', pix_fmt: 'rgba' }))).toBe(true);
    expect(streamHasAlpha(video({ codec_name: 'targa', pix_fmt: 'bgra' }))).toBe(true);
  });

  it('ordinary opaque video is negative', () => {
    expect(streamHasAlpha(video({ codec_name: 'h264', pix_fmt: 'yuv420p' }))).toBe(false);
  });

  it('an alpha_mode of "0" or empty is not alpha', () => {
    // Matroska writes the tag either way on some muxers; only a truthy value
    // means the track actually has an alpha plane.
    expect(streamHasAlpha(video({ pix_fmt: 'yuv420p', tags: { alpha_mode: '0' } }))).toBe(false);
    expect(streamHasAlpha(video({ pix_fmt: 'yuv420p', tags: { alpha_mode: '' } }))).toBe(false);
  });

  it('handles a missing stream, missing pix_fmt and missing tags', () => {
    expect(streamHasAlpha(undefined)).toBe(false);
    expect(streamHasAlpha(video({}))).toBe(false);
    expect(streamHasAlpha(video({ pix_fmt: undefined, tags: undefined }))).toBe(false);
  });

  it('does not mistake yuv444 for yuva444 — prefix matching must not be loose', () => {
    expect(streamHasAlpha(video({ pix_fmt: 'yuv444p10le' }))).toBe(false);
    expect(streamHasAlpha(video({ pix_fmt: 'yuva444p10le' }))).toBe(true);
  });
});

describe('hasAlpha reaches the parsed result', () => {
  it('is carried on the video facts', () => {
    const parsed = parseProbeJson({
      streams: [video({ codec_name: 'prores', pix_fmt: 'yuva444p12le', duration: '1.0' })],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0' },
    });
    expect(parsed.video?.hasAlpha).toBe(true);
  });

  it('is false for opaque footage rather than absent', () => {
    // A tri-state would make every consumer handle "unknown" separately; the
    // probe either ran and knows, or did not run and there is no video facts
    // object at all.
    const parsed = parseProbeJson({
      streams: [video({ codec_name: 'h264', pix_fmt: 'yuv420p', duration: '1.0' })],
      format: { format_name: 'mov,mp4', duration: '1.0' },
    });
    expect(parsed.video?.hasAlpha).toBe(false);
  });

  it('an audio-only file has no video facts to carry it', () => {
    const parsed = parseProbeJson({
      streams: [{ codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }],
      format: { format_name: 'mov,mp4', duration: '2.0' },
    });
    expect(parsed.video).toBeNull();
  });
});
