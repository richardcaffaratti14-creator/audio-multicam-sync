// earshot_bridge.js — calls the earshot CLI from Node.js scripts.
// earshot is a Python CLI tool; this module finds it, calls it, and parses its JSON output.
// All commands accept --json; we always pass it so the output is machine-readable.
//
// earshot ab JSON output: { cosine_ab, summary, features, differences, ... }
// earshot measure JSON output: { lufs, noise_floor_dbfs, peak_dbfs, digital_silence_frac, duration, ... }
// earshot describe JSON output: { top_tags:[{term,z,verdict}], audioset:[{label,p}], summary, ... }

const { spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Prefer env var override, then the known install location, then PATH.
const KNOWN = 'C:/Users/PC2/tools/earshot/.venv/Scripts/earshot.exe';

function findEarshot() {
  const candidates = [process.env.EARSHOT_PATH, KNOWN, 'earshot'].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ['--help'], { stdio: 'ignore' }); return c; } catch (e) { /* try next */ }
  }
  return null;
}

const EARSHOT_EXE = findEarshot();

// Internal: run earshot subcommand with --json, return parsed object.
// Throws on exec error or non-JSON output; earshot errors come back as thrown strings.
function runEarshot(subArgs) {
  if (!EARSHOT_EXE) throw new Error('earshot no encontrado. Instalar en ' + KNOWN + ' o configurar EARSHOT_PATH.');
  const result = spawnSync(EARSHOT_EXE, [...subArgs, '--json'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const out = (result.stdout || '').trim();
  if (!out) throw new Error('earshot sin output. stderr: ' + (result.stderr || '').slice(0, 300));
  try { return JSON.parse(out); }
  catch (e) { throw new Error('earshot output no es JSON: ' + out.slice(0, 200)); }
}

// Extract a mono WAV at 22050 Hz from a video file, suitable for earshot.
// start/duration in seconds. Earshot expects audio files, NOT the 200 Hz envelope that batch_sync uses.
function extractAudioWav(videoPath, outPath, { start = 0, duration = null } = {}) {
  const args = ['-y', '-nostdin'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', videoPath, '-vn', '-ac', '1', '-ar', '22050');
  if (duration != null) args.push('-t', String(duration));
  args.push('-f', 'wav', outPath);
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

// measure: objective measurements only, no models (fast).
// Returns { lufs, noise_floor_dbfs, peak_dbfs, digital_silence_frac, duration, ... }
function measure(wavPath) {
  return runEarshot(['measure', wavPath]);
}

// classifySignal: from a measure() result, returns 'good' | 'weak' | 'silent' | 'unknown'.
// Used to flag clips that will likely produce weak cross-correlation (far from speakers, covered mic).
// Thresholds from empirical observation: below -50 LUFS is essentially silence for a club setting.
function classifySignal(m) {
  const lufs = m.lufs ?? null;
  if (lufs === null) return 'unknown';
  if (lufs < -50) return 'silent';
  if (lufs < -38) return 'weak';
  return 'good';
}

// describe: CLAP tags + AudioSet labels, uses models (~20-60s first call, fast after).
// start/end in seconds (optional, earshot --start/--end trims the file before embedding).
// Returns { top_tags:[{term,category,z,cosine,verdict}], audioset:[{label,p}], summary, ... }
function describe(wavPath, { start, end } = {}) {
  const args = ['describe', wavPath];
  if (start != null) args.push('--start', String(start));
  if (end != null) args.push('--end', String(end));
  return runEarshot(args);
}

// ab: CLAP cosine similarity between two audio files. No --refs needed.
// Returns { cosine_ab: float (0-1), summary, features, differences, ... }
// cosine_ab >= 0.75 = similar, >= 0.9 = nearly the same sound.
function ab(wavPathA, wavPathB, { aStart, aEnd, bStart, bEnd } = {}) {
  const args = ['ab', wavPathA, wavPathB];
  if (aStart != null) args.push('--a-start', String(aStart));
  if (aEnd != null) args.push('--a-end', String(aEnd));
  if (bStart != null) args.push('--b-start', String(bStart));
  if (bEnd != null) args.push('--b-end', String(bEnd));
  return runEarshot(args);
}

// Tags that indicate a camera is physically covered or pointing at fabric/floor/pocket.
// z threshold for top_tags: 2.0 (weak match but consistent with coverage).
// AudioSet p threshold: 0.3 (clear signal from the AST tagger).
const MUFFLED_TERMS = new Set([
  'rustling', 'rustle', 'fabric', 'cloth', 'clothing', 'textile',
  'wind', 'wind noise', 'handling noise', 'muffled', 'rubbing', 'crumpling',
  'friction', 'bag', 'pocket',
]);
const MUFFLED_AUDIOSET = new Set(['Rustling', 'Cloth, fabric', 'Wind', 'Wind noise']);

function isMuffledWindow(describeResult) {
  for (const t of (describeResult.top_tags || [])) {
    if (t.z >= 2.0 && MUFFLED_TERMS.has((t.term || '').toLowerCase())) return true;
  }
  for (const a of (describeResult.audioset || [])) {
    if (a.p >= 0.3 && MUFFLED_AUDIOSET.has(a.label)) return true;
  }
  return false;
}

module.exports = { findEarshot, EARSHOT_EXE, extractAudioWav, measure, classifySignal, describe, ab, isMuffledWindow };
