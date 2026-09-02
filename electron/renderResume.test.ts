/**
 * The manifest is the whole feature.
 *
 * A render survives a restart because its staging directory describes itself:
 * `resume.json` says which job these frames belong to and how many there should
 * eventually be, and the frame files say how far it actually got. If either half
 * is wrong the failure is silent and expensive — a resume that starts one frame
 * late writes a video with a hole in it, and a manifest that fails to parse
 * throws away exactly the forty-minute render this exists to save.
 *
 * So this runs against a REAL temp directory rather than a mocked fs. The thing
 * being tested is what is true on disk after a process dies, and a mock cannot
 * be wrong about that in the ways disks are.
 */

import { mkdtemp, mkdir, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESUME_MANIFEST,
  inspectJob,
  jobDir,
  jobIdFromDirName,
  listResumableJobs,
  readManifest,
  scanStagedFrames,
  writeManifest,
  type RenderResumeManifest,
} from './renderResume';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'render-resume-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifest = (jobId: string, over: Partial<RenderResumeManifest> = {}): RenderResumeManifest => ({
  jobId,
  spec: { compositionName: 'Comp 1', outputPath: 'out.mp4', format: 'mp4' },
  format: 'mp4',
  totalFrames: 100,
  stagedFrames: 0,
  createdAt: 1_700_000_000_000,
  ...over,
});

/** Put `count` staged frames (0..count-1) in a job's dir. */
async function stage(dir: string, count: number, ext: 'jpg' | 'png' = 'jpg'): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    await writeFile(join(dir, `frame_${String(i).padStart(4, '0')}.${ext}`), 'x');
  }
}

describe('the manifest round-trips', () => {
  it('writes and reads back the job it describes', async () => {
    const dir = jobDir(root, 'job-a');
    await writeManifest(dir, manifest('job-a'));
    expect(await readManifest(dir)).toEqual(manifest('job-a'));
  });

  it('creates the directory it is asked to describe', async () => {
    // beginJob mkdirs first, but the manifest must not depend on that ordering —
    // a rewrite from `inspectJob` runs long after, against a dir it did not make.
    const dir = jobDir(root, 'job-fresh');
    await writeManifest(dir, manifest('job-fresh'));
    expect(await readManifest(dir)).not.toBeNull();
  });

  it('leaves no temp file behind', async () => {
    // The write is a write-then-rename, and a stray `resume.json.tmp` in the job
    // dir would be indistinguishable from a manifest half-written by a crash.
    const dir = jobDir(root, 'job-b');
    await writeManifest(dir, manifest('job-b'));
    const scan = await scanStagedFrames(dir); // just to prove the dir reads
    expect(scan.contiguous).toBe(0);
    await expect(readFile(join(dir, `${RESUME_MANIFEST}.tmp`), 'utf8')).rejects.toThrow();
  });

  it('reads a missing manifest as "not resumable" rather than throwing', async () => {
    expect(await readManifest(jobDir(root, 'nobody'))).toBeNull();
  });

  it('refuses a manifest that will not parse', async () => {
    const dir = jobDir(root, 'job-c');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RESUME_MANIFEST), '{"jobId": "job-c", "tot', 'utf8');
    expect(await readManifest(dir)).toBeNull();
  });

  it('refuses a manifest missing the fields a resume needs', async () => {
    const dir = jobDir(root, 'job-d');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RESUME_MANIFEST), JSON.stringify({ jobId: 'job-d' }), 'utf8');
    expect(await readManifest(dir)).toBeNull();
  });
});

describe('what is actually staged', () => {
  it('counts a complete run', async () => {
    const dir = jobDir(root, 'job-e');
    await stage(dir, 5);
    expect(await scanStagedFrames(dir)).toMatchObject({ contiguous: 5, ext: 'jpg' });
  });

  it('stops at the first GAP, not at the file count', async () => {
    // The trap this whole number exists for: ffmpeg's image2 demuxer stops at
    // the first missing index and exits 0, so resuming at "6 files present"
    // would leave frames 3 and 4 missing forever and ship a truncated video.
    const dir = jobDir(root, 'job-f');
    await stage(dir, 3);
    await writeFile(join(dir, 'frame_0005.jpg'), 'x');
    await writeFile(join(dir, 'frame_0006.jpg'), 'x');
    const scan = await scanStagedFrames(dir);
    expect(scan.contiguous).toBe(3);
    expect(scan.indices).toEqual([0, 1, 2, 5, 6]);
  });

  it('ignores the manifest and the audio sitting beside the frames', async () => {
    const dir = jobDir(root, 'job-g');
    await stage(dir, 2);
    await writeManifest(dir, manifest('job-g'));
    await writeFile(join(dir, 'audio.wav'), 'x');
    await writeFile(join(dir, 'chapters.ffmetadata'), 'x');
    expect((await scanStagedFrames(dir)).contiguous).toBe(2);
  });

  it('reports the alpha (PNG) staging a transparent export uses', async () => {
    const dir = jobDir(root, 'job-h');
    await stage(dir, 4, 'png');
    expect(await scanStagedFrames(dir)).toMatchObject({ contiguous: 4, ext: 'png' });
  });

  it('answers 0 for a directory that is not there', async () => {
    expect((await scanStagedFrames(jobDir(root, 'gone'))).contiguous).toBe(0);
  });
});

describe('listing what a previous session left', () => {
  it('finds every described job, newest first', async () => {
    await writeManifest(jobDir(root, 'old'), manifest('old', { createdAt: 1000 }));
    await stage(jobDir(root, 'old'), 3);
    await writeManifest(jobDir(root, 'new'), manifest('new', { createdAt: 2000 }));
    await stage(jobDir(root, 'new'), 7);

    const listed = await listResumableJobs(root);
    expect(listed.map((j) => j.jobId)).toEqual(['new', 'old']);
    expect(listed[0]).toMatchObject({ stagedFrames: 7, totalFrames: 100, format: 'mp4' });
    expect(listed[1]).toMatchObject({ stagedFrames: 3 });
  });

  it('reports COUNTED frames, not what the manifest claims', async () => {
    // The manifest's copy is only as fresh as the last time anyone looked, and
    // this number is shown to the user as "resumes at frame N".
    await writeManifest(jobDir(root, 'stale'), manifest('stale', { stagedFrames: 999 }));
    await stage(jobDir(root, 'stale'), 4);
    expect((await listResumableJobs(root))[0]?.stagedFrames).toBe(4);
  });

  it('hands the spec back untouched, so the queue can rebuild its job', async () => {
    const spec = { compositionName: 'Hero', outputPath: 'hero.mov', format: 'mov', width: 3840 };
    await writeManifest(jobDir(root, 'spec'), manifest('spec', { spec, format: 'mov' }));
    await stage(jobDir(root, 'spec'), 1);
    expect((await listResumableJobs(root))[0]?.spec).toEqual(spec);
  });

  it('ignores directories that are not job dirs', async () => {
    await mkdir(join(root, 'Cache'), { recursive: true });
    await writeFile(join(root, 'notes.txt'), 'x');
    expect(await listResumableJobs(root)).toEqual([]);
  });

  it('ignores a job dir with no manifest — nothing knows what it was', async () => {
    await stage(jobDir(root, 'orphan'), 12);
    expect(await listResumableJobs(root)).toEqual([]);
  });

  it('prunes an undescribed dir once it is old, and never a described one', async () => {
    // A crash between mkdir and the manifest write leaves a directory nothing
    // will ever claim. The staging root is durable storage now, so somebody has
    // to collect those — but only those, and only after they are stale.
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await stage(jobDir(root, 'ancient-orphan'), 2);
    await utimes(jobDir(root, 'ancient-orphan'), ancient, ancient);
    await writeManifest(jobDir(root, 'ancient-described'), manifest('ancient-described'));
    await stage(jobDir(root, 'ancient-described'), 2);
    await utimes(jobDir(root, 'ancient-described'), ancient, ancient);

    const listed = await listResumableJobs(root);
    expect(listed.map((j) => j.jobId)).toEqual(['ancient-described']);
    expect(await scanStagedFrames(jobDir(root, 'ancient-orphan'))).toMatchObject({ contiguous: 0 });
    // The described one is untouched, however old it is: age is not consent.
    expect(await scanStagedFrames(jobDir(root, 'ancient-described'))).toMatchObject({ contiguous: 2 });
  });

  it('answers empty for a staging root that has never existed', async () => {
    expect(await listResumableJobs(join(root, 'never'))).toEqual([]);
  });
});

describe('adopting one back', () => {
  it('reports the first MISSING frame as where to resume', async () => {
    await writeManifest(jobDir(root, 'adopt'), manifest('adopt'));
    await stage(jobDir(root, 'adopt'), 42);
    const adopted = await inspectJob(root, 'adopt');
    expect(adopted).toMatchObject({
      jobId: 'adopt',
      format: 'mp4',
      totalFrames: 100,
      stagedFrames: 42,
      nextFrame: 42,
      frameExt: 'jpg',
    });
  });

  it('resumes at the gap when frames went missing after the listing', async () => {
    await writeManifest(jobDir(root, 'gappy'), manifest('gappy'));
    await stage(jobDir(root, 'gappy'), 10);
    await rm(join(jobDir(root, 'gappy'), 'frame_0004.jpg'));
    expect(await inspectJob(root, 'gappy')).toMatchObject({ nextFrame: 4, stagedFrames: 4 });
  });

  it('leaves the manifest saying something true about the dir', async () => {
    await writeManifest(jobDir(root, 'refresh'), manifest('refresh', { stagedFrames: 0 }));
    await stage(jobDir(root, 'refresh'), 9);
    await inspectJob(root, 'refresh');
    expect((await readManifest(jobDir(root, 'refresh')))?.stagedFrames).toBe(9);
  });

  it('refuses an id it cannot describe', async () => {
    await stage(jobDir(root, 'undescribed'), 5);
    expect(await inspectJob(root, 'undescribed')).toBeNull();
    expect(await inspectJob(root, 'never-existed')).toBeNull();
  });
});

describe('the directory naming both processes rely on', () => {
  it('round-trips a job id through its directory name', () => {
    const dir = jobDir(root, '1234-5678-9');
    const name = dir.slice(root.length + 1);
    expect(jobIdFromDirName(name)).toBe('1234-5678-9');
  });

  it('does not claim directories belonging to anything else', () => {
    expect(jobIdFromDirName('Cache')).toBeNull();
    expect(jobIdFromDirName('motion-render-')).toBeNull();
  });
});
