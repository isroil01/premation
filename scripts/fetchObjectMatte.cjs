/**
 * Stage the bundled Object Matte assets into public/models/.
 *
 *   public/models/object-matte/  — SlimSAM encoder + decoder (Apache-2.0,
 *                                  ~14 MB, downloaded from Hugging Face)
 *
 * Vite copies public/ into dist/ verbatim and electron-builder ships them as
 * <resources>/models/object-matte, the folder Electron hands the engine as
 * PREMATION_SAM_DIR (engineHost.ts): the objectMatte job runs SAM there. Everything here is
 * idempotent: present-and-valid files are left alone, so only the first run
 * (or a version bump that changes MODELS below) touches the network. The
 * directory is gitignored — weights do not belong in history.
 *
 * Runs as the first step of `electron:build` (packaging always bundles the
 * model, and a broken download fails the build loudly rather than shipping a
 * silently classical-only app). Run it by hand — `npm run fetch:objectmatte` —
 * to get the neural path in `npm run dev`.
 */

const { mkdirSync, statSync, readFileSync, renameSync, writeFileSync, unlinkSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HF = 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx';

const MODELS = [
  { name: 'vision_encoder_quantized.onnx', url: `${HF}/vision_encoder_quantized.onnx`, minBytes: 5_000_000 },
  { name: 'prompt_encoder_mask_decoder_quantized.onnx', url: `${HF}/prompt_encoder_mask_decoder_quantized.onnx`, minBytes: 2_000_000 },
];
const MODEL_DIR = path.join(ROOT, 'public', 'models', 'object-matte');

/** ONNX is protobuf; field 1 (ir_version) tags the first byte 0x08. An error
 *  page is HTML and fails this immediately. */
function looksLikeOnnx(file) {
  const fd = readFileSync(file);
  return fd.length > 16 && fd[0] === 0x08;
}

function haveValid(dest, minBytes) {
  try {
    return statSync(dest).size >= minBytes && looksLikeOnnx(dest);
  } catch {
    return false;
  }
}

/**
 * Statuses worth trying again.
 *
 * 429 is the one that actually bites: Hugging Face rate-limits by IP, and a
 * CI runner shares its IP with everything else on that host, so a release can
 * fail on the download having changed nothing. 5xx and 408 are the same kind
 * of "not your fault, try again" answer.
 *
 * A 404 is NOT here on purpose \u2014 a model that has moved should fail loudly on
 * the first attempt rather than after a minute of pointless retrying.
 */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const ATTEMPTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One attempt, with the retry decision left to the caller.
 *
 * Deliberately NOT softened into "give up and carry on": this script exists so
 * that a broken download fails the build rather than shipping a silently
 * classical-only app (see the header). Retrying a 429 does not weaken that \u2014
 * it just stops a transient rate-limit from being reported as a broken one.
 */
async function fetchModel(url) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, { redirect: 'follow' });
    } catch (err) {
      // A dropped connection is as transient as a 503.
      lastErr = err;
      if (attempt === ATTEMPTS) break;
      const wait = backoff(attempt);
      console.log(`[object-matte] ${url} failed (${err.message}); retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer());

    lastErr = new Error(`${url} answered ${res.status}`);
    if (!RETRYABLE.has(res.status) || attempt === ATTEMPTS) break;
    // Honour Retry-After when the server bothers to say; it knows better than
    // our backoff curve does.
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : backoff(attempt);
    console.log(`[object-matte] ${url} answered ${res.status}; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${ATTEMPTS})`);
    await sleep(wait);
  }
  throw lastErr;
}

/** Exponential with jitter: 2s, 4s, 8s, 16s, capped. Jitter matters because
 *  the two models are fetched back to back and would otherwise retry in
 *  lockstep into the same rate limit. */
function backoff(attempt) {
  const base = Math.min(2000 * 2 ** (attempt - 1), 30_000);
  return base + Math.floor(Math.random() * 1000);
}

async function download(url, dest, minBytes) {
  const bytes = await fetchModel(url);
  if (bytes.length < minBytes) throw new Error(`${url} returned ${bytes.length} bytes — too small to be the model`);
  // Write-then-rename so an interrupted download never passes haveValid().
  const tmp = `${dest}.download`;
  writeFileSync(tmp, bytes);
  if (!looksLikeOnnx(tmp)) {
    unlinkSync(tmp);
    throw new Error(`${url} did not return an ONNX file`);
  }
  renameSync(tmp, dest);
  return bytes.length;
}

async function main() {
  mkdirSync(MODEL_DIR, { recursive: true });

  for (const m of MODELS) {
    const dest = path.join(MODEL_DIR, m.name);
    if (haveValid(dest, m.minBytes)) continue;
    console.log(`[object-matte] downloading ${m.name} …`);
    const size = await download(m.url, dest, m.minBytes);
    console.log(`[object-matte] ${m.name} (${(size / 1e6).toFixed(1)} MB)`);
  }
  console.log('[object-matte] bundled model assets ready');
}

main().catch((err) => {
  console.error(`[object-matte] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
