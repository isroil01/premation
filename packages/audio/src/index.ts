/**
 * @motion/audio — beat and onset detection.
 *
 * Pure: no DOM, no `AudioContext`, no Web Audio. It takes PCM and returns
 * numbers, which is what lets it be tested against synthesised signals whose
 * correct answer is known exactly rather than eyeballed against a waveform.
 *
 * Decoding is the HOST's job. The browser has `decodeAudioData` and Node does
 * not; putting that behind this boundary would drag a platform dependency into a
 * package whose whole value is not having one.
 */
export {
  analyseAudio,
  onsetEnvelope,
  pickOnsets,
  estimateTempo,
  estimatePhase,
  downmix,
  fftInPlace,
  snapToBeat,
  type AudioAnalysis,
  type AnalyseOptions,
} from './analyse';
