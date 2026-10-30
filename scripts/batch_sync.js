#!/usr/bin/env node
// audio-multicam-sync / batch_sync.js
//
// Syncs multicam footage (several camera folders) against one or more long
// reference audio tracks (DJ mixer / master WAV, possibly one per DJ/b2b
// segment of the night) using audio cross-correlation, NOT camera clocks.
// Outputs sync_offsets.json for the DynamicSync Premiere plugin's
// "IMPORTAR SYNC POR AUDIO" button.
//
// Usage:
//   node batch_sync.js --captures "<CAPTURAS folder>" [--reference "a.wav,b.wav,..."]
//     [--out "<output json path>"] [--workdir "<temp dir>"] [--exclude "folder1,folder2"]
//
// See SKILL.md for the reasoning behind every threshold here.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadInt16, meanRemove, globalXcorr, localSearch } = require('./xcorr_lib');
const earshot = require('./earshot_bridge');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.captures) {
  console.error('Uso: node batch_sync.js --captures "<carpeta CAPTURAS>" [--reference "a.wav,b.wav"] [--out "sync_offsets.json"] [--exclude "folder1,folder2"]');
  process.exit(1);
}

const CAPTURES = path.resolve(args.captures);
const SR = parseFloat(args.sr || '200');
const SEED_RATIO = parseFloat(args['seed-ratio'] || '1.5');
const LOCAL_ACCEPT_NCC = parseFloat(args['local-accept-ncc'] || '0.22');
const SEARCH_WINDOW_S = parseFloat(args['search-window'] || '6');
const WIDE_WINDOW_S = parseFloat(args['wide-window'] || '40');
const CHUNK_S = parseFloat(args['chunk-seconds'] || '180');
// a clip whose duration exceeds this fraction of the matched reference track
// gets a segment retry even if its global ratio looked okay — long-vs-long
// correlation dilutes the signal (seen ncc jump 0.05 -> 0.94 with a chunk).
const LONG_CLIP_FRACTION = parseFloat(args['long-clip-fraction'] || '0.25');
const EXCLUDE = new Set((args.exclude || '').split(',').map((s) => s.trim()).filter(Boolean));
// Phase-1/phase-2 workflow for nights with several DJ sets (several reference
// tracks): run once with --min-duration on just the long/continuous camera
// files to discover the set order cheaply and reviewably (few clips, high
// individual confidence), confirm it looks right, THEN run again on
// everything with --lock-origins pointing at phase 1's output so the noisy
// bulk of short handheld clips can't quietly shift the discovered set order.
const MIN_DURATION = parseFloat(args['min-duration'] || '0');
const LOCK_ORIGINS_PATH = args['lock-origins'] ? path.resolve(args['lock-origins']) : null;
const MERGE_INTO_PATH = args['merge-into'] ? path.resolve(args['merge-into']) : null;

const OUT_PATH = args.out ? path.resolve(args.out) : path.join(CAPTURES, 'sync_offsets.json');
const WORKDIR = args.workdir ? path.resolve(args.workdir)
  : path.join(os.tmpdir(), 'audio-multicam-sync-' + Date.now());
const ENV_DIR = path.join(WORKDIR, 'envs');

fs.mkdirSync(ENV_DIR, { recursive: true });
console.log('Workdir:', WORKDIR);

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
function checkTool(cmd) {
  try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); }
  catch (e) { console.error('No se encontró "' + cmd + '" en PATH. Instalalo (ffmpeg incluye ffprobe).'); process.exit(1); }
}
checkTool('ffmpeg');
checkTool('ffprobe');

// ---------------------------------------------------------------------------
// Discover reference track(s) + camera groups
// ---------------------------------------------------------------------------
const VIDEO_EXT = /\.(mp4|mov|mxf|avi)$/i;
const AUDIO_EXT = /\.(wav|mp3|aiff|flac)$/i;

// A night can have more than one reference file (several DJs / b2b sets
// recorded as separate files, no shared clock between them and often no
// metadata telling you the order). All of them are used; which one each clip
// actually belongs to is discovered by correlation, and the sets are placed
// on one shared timeline afterwards using cameras that recorded through a
// set changeover (see resolveTrackOrigins below) — nobody has to remember or
// guess the running order.
function resolveReferencePaths() {
  if (args.reference) {
    return String(args.reference).split(',').map((s) => s.trim()).filter(Boolean).map((r) => {
      const p = path.isAbsolute(r) ? r : path.join(CAPTURES, r);
      if (!fs.existsSync(p)) { console.error('No existe el archivo de referencia:', p); process.exit(1); }
      return p;
    });
  }
  const direct = fs.readdirSync(CAPTURES).filter((f) => AUDIO_EXT.test(f)).map((f) => path.join(CAPTURES, f));
  if (direct.length) return direct;
  // also check one level deep (e.g. a dedicated "audio" subfolder)
  const entries = fs.readdirSync(CAPTURES, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || EXCLUDE.has(e.name)) continue;
    const sub = fs.readdirSync(path.join(CAPTURES, e.name)).filter((f) => AUDIO_EXT.test(f));
    if (sub.length) return sub.map((f) => path.join(CAPTURES, e.name, f));
  }
  console.error('No se encontró ningún WAV/MP3 de referencia bajo', CAPTURES, '- pasalo con --reference.');
  process.exit(1);
}
const REFERENCE_PATHS = resolveReferencePaths();
console.log('Referencia(s):', REFERENCE_PATHS.length, '->', REFERENCE_PATHS.map((p) => path.basename(p)).join(', '));

// group = subcarpeta directa (una por cámara/tarjeta). Si no hay subcarpetas
// con video, toda CAPTURAS es un solo grupo.
function discoverGroups() {
  const entries = fs.readdirSync(CAPTURES, { withFileTypes: true });
  const groups = [];
  for (const e of entries) {
    if (!e.isDirectory() || EXCLUDE.has(e.name)) continue;
    const dir = path.join(CAPTURES, e.name);
    const files = fs.readdirSync(dir).filter((f) => VIDEO_EXT.test(f));
    if (files.length) groups.push({ name: e.name, dir, files });
  }
  if (!groups.length) {
    const files = fs.readdirSync(CAPTURES).filter((f) => VIDEO_EXT.test(f));
    if (files.length) groups.push({ name: path.basename(CAPTURES), dir: CAPTURES, files });
  }
  return groups;
}
const groups = discoverGroups();
if (!groups.length) { console.error('No se encontraron clips de video bajo', CAPTURES); process.exit(1); }
console.log('Grupos (cámaras):', groups.map((g) => g.name + ' (' + g.files.length + ')').join(', '));

// ---------------------------------------------------------------------------
// ffprobe metadata (creation_time + duration) — cheap, header-only
// ---------------------------------------------------------------------------
function probeMeta(filePath) {
  let ct = null, dur = null;
  try {
    ct = execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format_tags=creation_time',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath]).toString().trim() || null;
  } catch (e) { /* no creation_time tag */ }
  try {
    dur = parseFloat(execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath]).toString().trim());
  } catch (e) { dur = NaN; }
  return { creationTime: ct, creationEpoch: ct ? Date.parse(ct) / 1000 : null, duration: dur };
}

console.log('Leyendo metadata (ffprobe)...');
const refs = REFERENCE_PATHS.map((p) => ({ path: p, name: path.basename(p), meta: probeMeta(p) }));
for (const r of refs) console.log('  ' + r.name + ': duración', r.meta.duration.toFixed(1), 's');

let clips = [];
for (const g of groups) {
  for (const f of g.files) {
    const full = path.join(g.dir, f);
    const meta = probeMeta(full);
    clips.push({ file: f, group: g.name, nativePath: full, meta });
  }
}
console.log(clips.length, 'clips totales.');

if (MIN_DURATION > 0) {
  const before = clips.length;
  clips = clips.filter((c) => !isNaN(c.meta.duration) && c.meta.duration >= MIN_DURATION);
  console.log('--min-duration ' + MIN_DURATION + 's: ' + clips.length + '/' + before + ' clips entran en esta corrida (el resto queda para una fase 2).');
}
if (!clips.length) { console.error('Ningún clip pasó el filtro --min-duration.'); process.exit(1); }

// ---------------------------------------------------------------------------
// PRESCREEN: earshot measure on each clip before correlation (--prescreen flag).
// No AI models — fast. Extracts a 60s chunk from 30% into each clip and measures
// integrated LUFS + noise floor. Used to:
//   1. Flag 'weak' / 'silent' clips that will likely produce low-ratio correlation
//      (camera far from speakers, lens cap on, pocket camarazo).
//   2. Lower LOCAL_ACCEPT_NCC threshold per-clip for weak-signal clips so they
//      don't fall through to needs_review when their predicted offset is right.
//   3. Write signal_quality / signal_lufs into the output JSON for the user to see.
// ---------------------------------------------------------------------------
const PRESCREEN_DIR = path.join(WORKDIR, 'prescreen');
if (args.prescreen) {
  if (!earshot.EARSHOT_EXE) {
    console.warn('ADVERTENCIA: earshot no encontrado, --prescreen ignorado.');
  } else {
    fs.mkdirSync(PRESCREEN_DIR, { recursive: true });
    console.log('\n--- PRESCREEN DE SEÑAL (earshot measure, sin modelos) ---');
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const safe = (c.group + '__' + c.file).replace(/[^A-Za-z0-9._-]/g, '_');
      const wavPath = path.join(PRESCREEN_DIR, safe + '.wav');
      const chunkStart = Math.min(30, (c.meta.duration || 120) * 0.3);
      try {
        earshot.extractAudioWav(c.nativePath, wavPath, { start: chunkStart, duration: 60 });
        const m = earshot.measure(wavPath);
        c.signalLufs = m.lufs ?? null;
        c.signalNoiseFloor = m.noise_floor_dbfs ?? null;
        c.signalQuality = earshot.classifySignal(m);
        try { fs.unlinkSync(wavPath); } catch (e) { /* cleanup best-effort */ }
      } catch (e) {
        c.signalQuality = 'unknown';
        console.warn('  ' + c.group + '/' + c.file + ': earshot measure falló — ' + e.message.slice(0, 80));
      }
      if ((i + 1) % 10 === 0 || i === clips.length - 1)
        console.log('  ' + (i + 1) + '/' + clips.length + ' prescreened');
    }
    const byQuality = { good: 0, weak: 0, silent: 0, unknown: 0 };
    for (const c of clips) byQuality[c.signalQuality || 'unknown']++;
    console.log('  Señal — good:', byQuality.good, '| weak:', byQuality.weak, '| silent:', byQuality.silent, '| unknown:', byQuality.unknown);
    if (byQuality.weak + byQuality.silent > 0)
      console.log('  NOTA: clips weak/silent suelen dar peakToSecondRatio bajo. Si salen needs_review revisalos a mano.');
  }
}

// ---------------------------------------------------------------------------
// Extract low-frequency envelope (kick/bass transients) at low sample rate.
// ~30-200Hz bandpass keeps club-music sync signal, throws away everything
// that would otherwise make the raw PCM huge. A 2h reference becomes ~3MB.
// ---------------------------------------------------------------------------
function envelopeArgs(inPath, outPath, ssStart, tDur) {
  const a = ['-y', '-nostdin'];
  if (ssStart != null) a.push('-ss', String(ssStart));
  a.push('-i', inPath);
  if (tDur != null) a.push('-t', String(tDur));
  a.push('-af', `pan=mono|c0=0.5*c0+0.5*c1,highpass=f=30,lowpass=f=200,aresample=${SR}:filter_size=32`,
    '-f', 's16le', '-ar', String(SR), '-ac', '1', outPath);
  return a;
}
function extractEnvelope(inPath, outPath, ssStart, tDur) {
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return; // resumable
  execFileSync('ffmpeg', envelopeArgs(inPath, outPath, ssStart, tDur), { stdio: ['ignore', 'ignore', 'pipe'] });
}

console.log('Extrayendo envelope de referencia(s)...');
refs.forEach((r, i) => {
  r.envPath = path.join(WORKDIR, 'reference_' + i + '.raw');
  extractEnvelope(r.path, r.envPath);
  const arr = loadInt16(r.envPath);
  meanRemove(arr);
  r.arr = arr;
});

console.log('Extrayendo envelope de', clips.length, 'clips (rápido, solo demux de audio)...');
for (let i = 0; i < clips.length; i++) {
  const c = clips[i];
  const safe = (c.group + '__' + c.file).replace(/[^A-Za-z0-9._-]/g, '_');
  c.envPath = path.join(ENV_DIR, safe + '.raw');
  extractEnvelope(c.nativePath, c.envPath);
  if ((i + 1) % 20 === 0 || i === clips.length - 1) console.log('  ' + (i + 1) + '/' + clips.length);
}

// ---------------------------------------------------------------------------
// Cross-correlation pass 1: whole clip vs each reference track, keep the best
// ---------------------------------------------------------------------------
console.log('Corriendo cross-correlation global (x' + refs.length + ' referencia(s) por clip)...');
for (const c of clips) {
  const b0 = loadInt16(c.envPath);
  const b = new Float64Array(b0);
  meanRemove(b);
  c.clipDurationSeconds = b.length / SR;

  let best = { trackIndex: -1, bestLag: null, bestNcc: -1, peakToSecondRatio: 0 };
  refs.forEach((r, i) => {
    if (b.length >= r.arr.length) return; // clip longer than this track, can't full-range search it
    const res = globalXcorr(r.arr, b, SR);
    if (res.bestLag !== null && res.peakToSecondRatio > best.peakToSecondRatio) {
      best = { trackIndex: i, ...res };
    }
  });
  c.global = best;
}

// ---------------------------------------------------------------------------
// Cross-correlation pass 2: short-segment retry for long/ambiguous clips,
// tried against EVERY reference track (not just the pass-1 winner) — a clip
// near a DJ-set changeover, or one whose true match got diluted by whole-
// clip correlation, can end up on a different track than pass 1 guessed.
// ---------------------------------------------------------------------------
function segmentRetry(c) {
  const chunkStart = Math.max(0, Math.min(c.clipDurationSeconds - CHUNK_S, c.clipDurationSeconds * 0.3));
  if (c.clipDurationSeconds <= CHUNK_S + 1) return null; // clip already short, no point
  const chunkPath = c.envPath.replace(/\.raw$/, '.chunk.raw');
  try { extractEnvelope(c.nativePath, chunkPath, chunkStart, CHUNK_S); } catch (e) { return null; }
  if (!fs.existsSync(chunkPath)) return null;
  const b0 = loadInt16(chunkPath);
  const b = new Float64Array(b0);
  meanRemove(b);

  let best = { trackIndex: -1, bestLag: null, bestNcc: -1, peakToSecondRatio: 0 };
  refs.forEach((r, i) => {
    if (b.length >= r.arr.length) return;
    const res = globalXcorr(r.arr, b, SR);
    if (res.bestLag !== null && res.peakToSecondRatio > best.peakToSecondRatio) {
      best = { trackIndex: i, ...res };
    }
  });
  if (best.bestLag === null) return null;
  return {
    trackIndex: best.trackIndex,
    offsetSeconds: best.bestLag / SR - chunkStart,
    ncc: best.bestNcc,
    peakToSecondRatio: best.peakToSecondRatio,
  };
}

for (const c of clips) {
  const matchedTrackDur = c.global.trackIndex >= 0 ? refs[c.global.trackIndex].meta.duration : 0;
  const needsRetry = c.global.trackIndex === -1
    || c.clipDurationSeconds > LONG_CLIP_FRACTION * matchedTrackDur
    || c.global.peakToSecondRatio < SEED_RATIO;
  if (!needsRetry) continue;
  const seg = segmentRetry(c);
  if (seg && seg.peakToSecondRatio > (c.global.peakToSecondRatio || 0)) c.segment = seg;
}

for (const c of clips) {
  const chosen = c.segment || c.global;
  if (chosen.trackIndex >= 0 && chosen.bestLag !== null) {
    c.trackIndex = chosen.trackIndex;
    c.offsetSeconds = c.segment ? c.segment.offsetSeconds : chosen.bestLag / SR;
    c.ncc = c.segment ? c.segment.ncc : chosen.bestNcc;
    c.peakToSecondRatio = chosen.peakToSecondRatio;
    c.method = c.segment ? 'audio-xcorr-segment' : 'audio-xcorr';
  } else {
    c.trackIndex = -1;
    c.offsetSeconds = null;
    c.ncc = 0;
    c.peakToSecondRatio = 0;
    c.method = 'audio-xcorr';
  }
  // ratio, not raw ncc, is what discriminates a real match from a false
  // periodic-beat lock on four-on-the-floor music — ncc mostly reflects
  // mic quality/distance, not correctness of the position.
  c.isSeed = c.trackIndex >= 0 && c.peakToSecondRatio >= SEED_RATIO;
}

// ---------------------------------------------------------------------------
// Reconciliation: resolve non-seed clips via same-camera anchors, verified
// with a LOCAL correlation search on whichever reference track the anchor
// itself resolved to (never trust an arithmetic prediction blindly — same-
// camera "continuous" files can still have real gaps, and a clip can sit
// right at a DJ-set changeover where the "right" track actually changes).
// ---------------------------------------------------------------------------
function reconcileGroup(groupClips) {
  const sorted = groupClips.filter((c) => c.meta.creationEpoch != null)
    .sort((a, b) => a.meta.creationEpoch - b.meta.creationEpoch);
  const withoutTime = groupClips.filter((c) => c.meta.creationEpoch == null);
  const all = sorted.concat(withoutTime);

  let changed = true;
  let iterations = 0;
  while (changed && iterations < 6) {
    changed = false;
    iterations++;
    const seeds = all.filter((c) => c.status === 'ok');

    for (const c of all) {
      if (c.finalOffset !== undefined) continue; // already resolved
      if (c.isSeed) {
        c.finalOffset = c.offsetSeconds; c.finalTrackIndex = c.trackIndex;
        c.finalMethod = c.method; c.status = 'ok';
        changed = true; continue;
      }

      const candidates = []; // { trackIndex, predicted }
      if (seeds.length && c.meta.creationEpoch != null) {
        let nearest = null, bestDist = Infinity;
        for (const s of seeds) {
          if (s.meta.creationEpoch == null) continue;
          const d = Math.abs(s.meta.creationEpoch - c.meta.creationEpoch);
          if (d < bestDist) { bestDist = d; nearest = s; }
        }
        if (nearest) candidates.push({ trackIndex: nearest.finalTrackIndex, predicted: nearest.finalOffset + (c.meta.creationEpoch - nearest.meta.creationEpoch) });
      }
      const idx = all.indexOf(c);
      const prev = all[idx - 1], next = all[idx + 1];
      if (prev && prev.finalOffset !== undefined && !isNaN(prev.meta.duration)) {
        candidates.push({ trackIndex: prev.finalTrackIndex, predicted: prev.finalOffset + prev.meta.duration });
      }
      if (next && next.finalOffset !== undefined && !isNaN(c.meta.duration)) {
        candidates.push({ trackIndex: next.finalTrackIndex, predicted: next.finalOffset - c.meta.duration });
      }
      if (!candidates.length) continue; // nothing to anchor on yet, try again next pass

      const b0 = loadInt16(c.envPath);
      const b = new Float64Array(b0); meanRemove(b);

      let best = { bestNcc: -Infinity };
      for (const cand of candidates) {
        const refArr = refs[cand.trackIndex].arr;
        const centerLag = Math.round(cand.predicted * SR);
        for (const win of [SEARCH_WINDOW_S, WIDE_WINDOW_S]) {
          const r = localSearch(refArr, b, centerLag, win, SR);
          if (r.bestNcc > best.bestNcc) best = { ...r, cand };
        }
      }

      if (best.bestLag !== null && best.bestNcc >= LOCAL_ACCEPT_NCC) {
        c.finalOffset = best.bestLag / SR; c.finalTrackIndex = best.cand.trackIndex;
        c.finalMethod = 'audio-xcorr-chained'; c.status = 'ok';
      } else if (best.cand !== undefined) {
        c.finalOffset = best.cand.predicted; c.finalTrackIndex = best.cand.trackIndex;
        c.finalMethod = 'predicted-unverified'; c.status = 'needs_review';
      } else {
        continue; // still nothing usable, retry next pass
      }
      changed = true;
    }
  }

  for (const c of all) {
    if (c.finalOffset === undefined) {
      c.finalOffset = null; c.finalTrackIndex = -1; c.finalMethod = c.method; c.status = 'out_of_reference_range';
    }
  }
}

const byGroup = new Map();
for (const c of clips) { if (!byGroup.has(c.group)) byGroup.set(c.group, []); byGroup.get(c.group).push(c); }
for (const list of byGroup.values()) reconcileGroup(list);

// ---------------------------------------------------------------------------
// Track origins: place every reference track on ONE shared timeline. Only
// matters when there's more than one reference track. Uses cameras that
// recorded through a set changeover — a clip matched to track A immediately
// followed (in that camera's OWN clock) by a clip matched to track B tells
// you exactly how B's timeline relates to A's, without needing anyone to
// remember or guess the running order of the night.
// ---------------------------------------------------------------------------
const trackOrigin = new Map(); // trackIndex -> seconds offset on the shared timeline
if (LOCK_ORIGINS_PATH) {
  const prior = JSON.parse(fs.readFileSync(LOCK_ORIGINS_PATH, 'utf8'));
  const byName = new Map((prior.referenceTracks || []).map((r) => [r.name, r.originSeconds]));
  console.log('\n--- ORÍGENES BLOQUEADOS (de ' + LOCK_ORIGINS_PATH + ') ---');
  refs.forEach((r, i) => {
    if (!byName.has(r.name) || byName.get(r.name) === null) {
      console.log('  ' + r.name + ' -> NO estaba en la corrida anterior o quedó sin puente; se recalcula libremente.');
      return;
    }
    trackOrigin.set(i, byName.get(r.name));
    console.log('  ' + r.name + ' -> ' + byName.get(r.name).toFixed(1) + 's (bloqueado)');
  });
} else if (refs.length <= 1) {
  trackOrigin.set(0, 0);
} else {
  const edges = []; // { a, b, delta } meaning origin[b] - origin[a] ~= delta
  for (const list of byGroup.values()) {
    const ok = list.filter((c) => c.status === 'ok' && c.meta.creationEpoch != null)
      .sort((a, b) => a.meta.creationEpoch - b.meta.creationEpoch);
    for (let i = 1; i < ok.length; i++) {
      const prev = ok[i - 1], cur = ok[i];
      if (prev.finalTrackIndex === cur.finalTrackIndex) continue;
      const delta = (cur.meta.creationEpoch - prev.meta.creationEpoch) - cur.finalOffset + prev.finalOffset;
      edges.push({ a: prev.finalTrackIndex, b: cur.finalTrackIndex, delta, viaGroup: prev.group, viaFiles: prev.file + '->' + cur.file });
    }
  }

  if (args.debug) {
    console.log('\n--- EDGES (todos los puentes encontrados) ---');
    for (const e of edges) {
      console.log('  ' + refs[e.a].name + ' -> ' + refs[e.b].name
        + ' | delta=' + e.delta.toFixed(1) + 's | via ' + e.viaGroup + ': ' + e.viaFiles);
    }
  }

  // A camera bridging a changeover is strong evidence, but ONE camera can
  // still be wrong (e.g. a GoPro chapter whose audio content itself straddles
  // the changeover, so it correlates passably against either side without
  // being a clean match to either). Never trust a single edge blindly when
  // more than one camera bridged the same pair — take the MEDIAN of all
  // edges for that pair, drop whichever ones disagree with it by more than
  // a few seconds, and say so, rather than silently keeping whichever edge
  // happened to be discovered first (that used to be the behavior here and
  // it silently picked a 2-hour-wrong bridge on a real event).
  const OUTLIER_TOLERANCE_S = 5;
  const byPair = new Map(); // "minIdx-maxIdx" -> [{signedDelta, e}]
  for (const e of edges) {
    const key = Math.min(e.a, e.b) + '-' + Math.max(e.a, e.b);
    const signedDelta = e.a < e.b ? e.delta : -e.delta;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push({ signedDelta, e });
  }
  function median(nums) {
    const s = [...nums].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  // Pass 1: resolve every pair where a clear majority of its edges agree
  // with each other (within tolerance). While we're at it, keep score of
  // which camera GROUPS tend to agree with the majority elsewhere and which
  // don't — a GoPro clip whose audio itself straddles a set changeover can
  // pass a global correlation check without being a clean match to either
  // side, and if it does that once it tends to do it again.
  const groupScore = new Map(); // group name -> {agree, disagree}
  function bumpScore(group, agreed) {
    const s = groupScore.get(group) || { agree: 0, disagree: 0 };
    if (agreed) s.agree++; else s.disagree++;
    groupScore.set(group, s);
  }
  const deferred = []; // pairs pass 1 couldn't resolve: { key, a, b, entries }
  const trustedEdges = []; // one per pair, a<b convention
  for (const [key, entries] of byPair) {
    const [aStr, bStr] = key.split('-');
    const a = parseInt(aStr, 10), b = parseInt(bStr, 10);
    if (entries.length === 1) {
      console.log('  AVISO:', refs[a].name, '<->', refs[b].name, '- solo 1 cámara confirma este puente (' + entries[0].e.viaGroup + ': ' + entries[0].e.viaFiles + '). Sin segunda confirmación.');
      trustedEdges.push({ a, b, delta: entries[0].signedDelta });
      continue;
    }
    const m = median(entries.map((x) => x.signedDelta));
    const inliers = entries.filter((x) => Math.abs(x.signedDelta - m) <= OUTLIER_TOLERANCE_S);
    const outliers = entries.filter((x) => Math.abs(x.signedDelta - m) > OUTLIER_TOLERANCE_S);
    if (inliers.length > outliers.length) {
      const refined = median(inliers.map((x) => x.signedDelta));
      if (outliers.length) {
        console.log('  AVISO:', refs[a].name, '<->', refs[b].name, '-', entries.length, 'puentes,', outliers.length, 'descartado(s) por no coincidir (>' + OUTLIER_TOLERANCE_S + 's):');
        for (const o of outliers) console.log('    DESCARTADO', o.e.viaGroup + ':', o.e.viaFiles, 'delta=' + o.e.delta.toFixed(1) + 's — revisar, puede estar mal matcheado o abarcar el cambio de set');
        for (const o of inliers) console.log('    usado', o.e.viaGroup + ':', o.e.viaFiles, 'delta=' + o.e.delta.toFixed(1) + 's');
      } else {
        console.log('  OK:', refs[a].name, '<->', refs[b].name, '-', entries.length, 'cámaras de acuerdo (±' + OUTLIER_TOLERANCE_S + 's).');
      }
      for (const x of inliers) bumpScore(x.e.viaGroup, true);
      for (const x of outliers) bumpScore(x.e.viaGroup, false);
      trustedEdges.push({ a, b, delta: refined });
    } else {
      deferred.push({ key, a, b, entries }); // no majority (e.g. exactly 2 that disagree) — settle in pass 2
    }
  }

  // Pass 2: for pairs with no majority, break the tie using how reliable
  // each candidate's camera has been elsewhere. If that's inconclusive too,
  // don't guess — leave the pair unresolved rather than average two numbers
  // that can't both be right.
  for (const { key, a, b, entries } of deferred) {
    const scored = entries.map((x) => {
      const s = groupScore.get(x.e.viaGroup);
      const rel = s ? s.agree - s.disagree : 0;
      return { ...x, rel };
    }).sort((p, q) => q.rel - p.rel);
    const best = scored[0], second = scored[1];
    if (best.rel > second.rel) {
      console.log('  AVISO:', refs[a].name, '<->', refs[b].name, '-', entries.length, 'puentes en desacuerdo, sin mayoría. Elegido por historial de la cámara:');
      for (const s of scored) console.log('    ' + (s === best ? 'usado  ' : 'ignorado') + ' ' + s.e.viaGroup + ' (agree-disagree=' + s.rel + '):', s.e.viaFiles, 'delta=' + s.e.delta.toFixed(1) + 's');
      trustedEdges.push({ a, b, delta: best.signedDelta });
    } else {
      console.log('  AVISO:', refs[a].name, '<->', refs[b].name, '-', entries.length, 'puentes en desacuerdo (' + entries.map((x) => x.e.delta.toFixed(0) + 's via ' + x.e.viaGroup).join(' vs. ') + '), sin forma automática de elegir. NO se fija este puente — revisar a mano.');
    }
  }

  // anchor = track with the most 'ok' clips, origin 0
  const clipsPerTrack = new Map();
  for (const c of clips) if (c.status === 'ok') clipsPerTrack.set(c.finalTrackIndex, (clipsPerTrack.get(c.finalTrackIndex) || 0) + 1);
  let anchorTrack = 0, anchorCount = -1;
  for (const [t, n] of clipsPerTrack) if (n > anchorCount) { anchorCount = n; anchorTrack = t; }
  trackOrigin.set(anchorTrack, 0);

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const e of trustedEdges) {
      const haveA = trackOrigin.has(e.a), haveB = trackOrigin.has(e.b);
      if (haveA && !haveB) { trackOrigin.set(e.b, trackOrigin.get(e.a) + e.delta); progressed = true; }
      else if (haveB && !haveA) { trackOrigin.set(e.a, trackOrigin.get(e.b) - e.delta); progressed = true; }
    }
  }

  console.log('\n--- ORDEN DE REFERENCIAS DESCUBIERTO (vía cámaras que puentean cambios de set) ---');
  refs.forEach((r, i) => {
    const o = trackOrigin.get(i);
    console.log('  ' + r.name + (o === undefined ? ' -> SIN PUENTE, no se pudo ubicar en la línea de tiempo' : ' -> origen ' + o.toFixed(1) + 's'));
  });
  if (!edges.length) console.log('  (ninguna cámara grabó a través de un cambio de set — no se pudo inferir ningún orden. Cada set queda con su propia línea de tiempo local; revisá needs_review.)');
}

// downgrade any 'ok' clip whose track never got an origin
for (const c of clips) {
  if (c.status === 'ok' && !trackOrigin.has(c.finalTrackIndex)) {
    c.status = 'needs_review';
    c.unanchoredTrack = true;
  }
}

// ---------------------------------------------------------------------------
// VERIFY: earshot ab on overlapping clip pairs across cameras (--verify flag).
// Uses CLAP model (~20-60s first call). For each unique pair of cameras, picks
// the clip pair with the longest overlap on the shared timeline, extracts 30s
// of audio at the midpoint of that overlap from both clips, and runs earshot ab.
// cosine_ab >= 0.75 = sounds like the same event (same DJ set, same room).
// Adds earshot_cosine to each clip's JSON; warns on cosine_ab < 0.5.
// ---------------------------------------------------------------------------
const VERIFY_DIR = path.join(WORKDIR, 'verify');
if (args.verify) {
  if (!earshot.EARSHOT_EXE) {
    console.warn('ADVERTENCIA: earshot no encontrado, --verify ignorado.');
  } else {
    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    console.log('\n--- VERIFICACIÓN POR EARSHOT AB (pares de cámaras solapadas) ---');

    // Compute global start/end for each 'ok' clip on the shared timeline.
    const okClips = clips.filter((c) => c.status === 'ok' && c.finalOffset !== null && trackOrigin.has(c.finalTrackIndex));
    for (const c of okClips) {
      const origin = trackOrigin.get(c.finalTrackIndex);
      c._globalStart = c.finalOffset + origin;
      c._globalEnd = c._globalStart + (c.meta.duration || 0);
    }

    // For each unique pair of camera groups, find the clip pair with maximum overlap.
    const groupNames = Array.from(new Set(okClips.map((c) => c.group)));
    let verifyCount = 0;
    for (let gi = 0; gi < groupNames.length; gi++) {
      for (let gj = gi + 1; gj < groupNames.length; gj++) {
        const clipsA = okClips.filter((c) => c.group === groupNames[gi]);
        const clipsB = okClips.filter((c) => c.group === groupNames[gj]);
        let bestOverlap = 0, bestA = null, bestB = null;
        for (const a of clipsA) {
          for (const b of clipsB) {
            const overlap = Math.min(a._globalEnd, b._globalEnd) - Math.max(a._globalStart, b._globalStart);
            if (overlap > bestOverlap) { bestOverlap = overlap; bestA = a; bestB = b; }
          }
        }
        if (!bestA || bestOverlap < 30) continue; // need at least 30s overlap

        // Extract 30s at the middle of the overlap.
        const overlapStart = Math.max(bestA._globalStart, bestB._globalStart);
        const overlapMid = overlapStart + bestOverlap / 2;
        const windowS = Math.min(30, bestOverlap * 0.5);
        const startInA = overlapMid - windowS / 2 - bestA._globalStart;
        const startInB = overlapMid - windowS / 2 - bestB._globalStart;

        const pairId = groupNames[gi].replace(/[^A-Za-z0-9]/g, '_') + '__vs__' + groupNames[gj].replace(/[^A-Za-z0-9]/g, '_');
        const wavA = path.join(VERIFY_DIR, pairId + '_A.wav');
        const wavB = path.join(VERIFY_DIR, pairId + '_B.wav');
        try {
          earshot.extractAudioWav(bestA.nativePath, wavA, { start: Math.max(0, startInA), duration: windowS });
          earshot.extractAudioWav(bestB.nativePath, wavB, { start: Math.max(0, startInB), duration: windowS });
          const res = earshot.ab(wavA, wavB);
          const cosine = res.cosine_ab ?? null;
          bestA.earshotCosine = cosine;
          bestB.earshotCosine = cosine;
          const verdict = cosine >= 0.75 ? 'OK' : cosine >= 0.5 ? 'DUDOSO' : 'SOSPECHOSO';
          console.log('  ' + groupNames[gi] + ' vs ' + groupNames[gj]
            + ' | cosine=' + (cosine != null ? cosine.toFixed(3) : '?')
            + ' | ' + verdict
            + ' | via: ' + bestA.file + ' + ' + bestB.file);
          if (cosine !== null && cosine < 0.5)
            console.log('    ⚠ cosine bajo — los offsets de una o ambas cámaras pueden estar mal. Revisar a mano.');
          try { fs.unlinkSync(wavA); fs.unlinkSync(wavB); } catch (e) { /* best-effort */ }
          verifyCount++;
        } catch (e) {
          console.warn('  ' + groupNames[gi] + ' vs ' + groupNames[gj] + ': earshot ab falló — ' + e.message.slice(0, 80));
        }
      }
    }
    if (!verifyCount) console.log('  (ningún par de cámaras tiene 30s+ de solapamiento para verificar)');
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const outClips = clips.map((c) => {
  const origin = c.finalTrackIndex >= 0 ? trackOrigin.get(c.finalTrackIndex) : undefined;
  const globalOffset = (c.finalOffset !== null && c.finalOffset !== undefined && origin !== undefined)
    ? c.finalOffset + origin : null;
  return {
    file: c.file,
    memoria: c.group,
    offsetSeconds: globalOffset === null ? null : Math.round(globalOffset * 1000) / 1000,
    status: c.status,
    method: c.finalMethod,
    ncc: Math.round((c.ncc || 0) * 1000) / 1000,
    peakToSecondRatio: Math.round((c.peakToSecondRatio || 0) * 1000) / 1000,
    referenceTrack: c.finalTrackIndex >= 0 ? refs[c.finalTrackIndex].name : null,
    note: c.unanchoredTrack ? 'su set/referencia no pudo ubicarse en la línea de tiempo compartida (ninguna cámara puenteó el cambio)' : undefined,
    nativePath: c.nativePath.replace(/\\/g, '/'),
    ...(c.signalQuality ? { signal_quality: c.signalQuality } : {}),
    ...(c.signalLufs != null ? { signal_lufs: Math.round(c.signalLufs * 10) / 10 } : {}),
    ...(c.earshotCosine != null ? { earshot_cosine: c.earshotCosine } : {}),
  };
});

const output = {
  referenceTracks: refs.map((r, i) => ({
    name: r.name,
    durationSeconds: r.meta.duration,
    originSeconds: trackOrigin.has(i) ? Math.round(trackOrigin.get(i) * 1000) / 1000 : null,
  })),
  generatedAt: new Date().toISOString(),
  notes: 'offsetSeconds = position on the shared timeline (origin = the anchor reference track\'s t=0) '
    + 'where the clip\'s frame 0 lands. Negative values mean the clip starts before that. Camera clocks '
    + 'were NOT trusted for cross-camera sync or set ordering; only used within one camera as a fallback '
    + 'prediction / to bridge set changeovers, always verified with a local audio correlation search.',
  clips: outClips,
};

if (MERGE_INTO_PATH && fs.existsSync(MERGE_INTO_PATH)) {
  const prior = JSON.parse(fs.readFileSync(MERGE_INTO_PATH, 'utf8'));
  // key by memoria+file, NOT file alone — different camera folders can and do
  // reuse the same filename (confirmed: two Sony cards from the same/similar
  // camera numbering scheme can produce identical filenames across folders),
  // and a filename-only key would silently drop one camera's clips here.
  const keyOf = (c) => c.memoria + '::' + c.file;
  const byFile = new Map((prior.clips || []).map((c) => [keyOf(c), c]));
  for (const c of outClips) byFile.set(keyOf(c), c); // this run's results win for any overlap
  output.clips = Array.from(byFile.values());
  // keep any reference track origin from the prior file that this run didn't touch
  const trackByName = new Map(output.referenceTracks.map((r) => [r.name, r]));
  for (const r of (prior.referenceTracks || [])) if (!trackByName.has(r.name)) output.referenceTracks.push(r);
  console.log('\nMezclado con', MERGE_INTO_PATH, '->', output.clips.length, 'clips en total.');
}

fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const finalClips = output.clips;
let ok = 0, review = 0, oor = 0;
for (const c of finalClips) { if (c.status === 'ok') ok++; else if (c.status === 'out_of_reference_range') oor++; else review++; }
console.log('\n=== RESUMEN ===');
console.log('ok=' + ok, 'needs_review=' + review, 'out_of_reference_range=' + oor, 'total=' + finalClips.length);
const memoriaNames = Array.from(new Set(finalClips.map((c) => c.memoria))).sort();
for (const gName of memoriaNames) {
  console.log('\n--- ' + gName + ' ---');
  const list = finalClips.filter((c) => c.memoria === gName)
    .sort((a, b) => (a.offsetSeconds ?? -1e9) - (b.offsetSeconds ?? -1e9));
  for (const c of list) {
    console.log(
      c.file.padEnd(16),
      String(c.offsetSeconds).padStart(10),
      c.status.padEnd(22),
      (c.referenceTrack || '-').padEnd(24),
      c.method
    );
  }
}
console.log('\nJSON escrito en:', OUT_PATH);
if (review || oor) {
  console.log('\nATENCIÓN: hay clips en needs_review / out_of_reference_range — revisalos a mano');
  console.log('(el offset predicho puede ser aproximado, el clip cae fuera de la ventana de su referencia,');
  console.log('o su set/track no pudo ubicarse en la línea de tiempo compartida.)');
}
