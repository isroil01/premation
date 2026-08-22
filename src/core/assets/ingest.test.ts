/**
 * Import ingest — the decision rules and the encode contracts. The transcode
 * itself is ffmpeg behind the IPC (integration territory); what must hold
 * here is WHO gets transcoded and to WHAT, because a wrong yes re-encodes
 * footage that played fine and a wrong no re-ships the black-frame import
 * this module exists to end.
 */

import { ingestCandidate, ingestEncodeArgs, needsIngest, isCameraRawStill, rawStillEncodeArgs } from './ingest';

describe('ingestCandidate — the cheap pre-filter', () => {
  it('passes ordinary browser formats untouched (no probe cost)', () => {
    for (const name of ['clip.mp4', 'clip.webm', 'clip.png', 'clip.mp3', 'clip.svg']) {
      expect(ingestCandidate(name)).toBe(false);
    }
  });

  it('flags unplayable containers and probe-worthy ones', () => {
    for (const name of ['tape.mxf', 'old.avi', 'cam.MTS', 'shot.mov', 'x.mkv', 'y.m2ts', 'still.dng', 'cam.CR2', 'reel.r3d']) {
      expect(ingestCandidate(name)).toBe(true);
    }
  });
});

describe('camera raw stills', () => {
  it('recognises DNG/CR2 and builds a one-frame PNG encode', () => {
    expect(isCameraRawStill('shot.dng')).toBe(true);
    expect(isCameraRawStill('clip.mp4')).toBe(false);
    const { args, outExt } = rawStillEncodeArgs();
    expect(outExt).toBe('png');
    expect(args).toContain('-frames:v');
    expect(args).toContain('1');
  });
});

describe('needsIngest — the decision', () => {
  it('unplayable containers ingest even when the probe failed', () => {
    expect(needsIngest('tape.mxf', undefined)).toBe(true);
    expect(needsIngest('old.avi', undefined)).toBe(true);
  });

  it('an H.264 .mov plays natively and must NOT pay a re-encode', () => {
    expect(needsIngest('shot.mov', 'h264')).toBe(false);
    expect(needsIngest('shot.mov', undefined)).toBe(false);
  });

  it('a ProRes/DNxHD .mov ingests', () => {
    expect(needsIngest('shot.mov', 'prores')).toBe(true);
    expect(needsIngest('shot.mov', 'ProRes 4444')).toBe(true);
    expect(needsIngest('export.mov', 'dnxhd')).toBe(true);
    expect(needsIngest('grab.mov', 'mjpeg')).toBe(true);
  });

  it('a VP9 .mkv plays and stays', () => {
    expect(needsIngest('rip.mkv', 'vp9')).toBe(false);
  });
});

describe('ingestEncodeArgs — the encode contracts', () => {
  it('opaque → H.264 MP4 with faststart and the IPC placeholders', () => {
    const { args, outExt, mime } = ingestEncodeArgs(false);
    expect(outExt).toBe('mp4');
    expect(mime).toBe('video/mp4');
    expect(args).toContain('__IN__');
    expect(args[args.length - 1]).toBe('__OUT__');
    expect(args).toContain('libx264');
    // +faststart: the mp4 demuxer's index read must be one seek, not a scan
    // to the tail — this is what makes an ingested file exact-decoder food.
    expect(args).toContain('+faststart');
    // yuv420p: the one pixel format every decoder in the chain accepts.
    expect(args).toContain('yuv420p');
  });

  it('alpha → VP9 WebM carrying the alpha plane', () => {
    const { args, outExt, mime } = ingestEncodeArgs(true);
    expect(outExt).toBe('webm');
    expect(mime).toBe('video/webm');
    expect(args).toContain('libvpx-vp9');
    expect(args).toContain('yuva420p');
  });
});
