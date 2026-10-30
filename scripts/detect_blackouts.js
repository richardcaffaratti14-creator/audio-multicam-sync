#!/usr/bin/env node
// audio-multicam-sync / detect_blackouts.js
//
// Finds sustained black/near-black stretches in each clip's video (the
// classic "camarazo" — operator forgets to stop recording, camera ends up
// pointed at the floor/ceiling/their pocket — and genuine blackouts) and
// records which parts of each clip are worth keeping. It does NOT cut
// anything itself: it writes a `segments` array per clip into the sync
// JSON, and the DynamicSync plugin's "CREAR SECUENCIA (AUDIO)" reads that to
// insert only the good ranges, skipping the black ones entirely.
//
// Scope, on purpose: this only catches DARK camarazos/blackouts (camera
// pointed at something dark/covered). A camarazo pointed at something well
// lit (a bright floor, a lit ceiling) looks like normal footage to this
// detector and won't be caught — there's no reliable general "this shouldn't
// be here" signal for that without human judgment or a trained classifier.
//
// Usage:
//   node detect_blackouts.js --sync-offsets "<sync_offsets.json>" [--out "<path>"]
//     [--min-black 1.0] [--pic-th 0.98] [--pix-th 0.10] [--sample-fps 5]
//     [--pad 0.15] [--min-segment 1.5]

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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
if (!args['sync-offsets']) {
  console.error('Uso: node detect_blackouts.js --sync-offsets "<sync_offsets.json>" [--out "<path>"] [--min-black 1.0] [--pad 0.15] [--min-segment 1.5]');
  process.exit(1);
}

const SYNC_PATH = path.resolve(args['sync-offsets']);
const OUT_PATH = args.out ? path.resolve(args.out) : SYNC_PATH;
const MIN_BLACK_S = parseFloat(args['min-black'] || '1.0'); // ignore blips shorter than this
const PIC_TH = parseFloat(args['pic-th'] || '0.98');        // fraction of pixels that must be "black"
const PIX_TH = parseFloat(args['pix-th'] || '0.10');        // per-pixel luma threshold (0-1) counted as black
const SAMPLE_FPS = parseFloat(args['sample-fps'] || '5');   // decode at reduced fps — plenty for multi-second patches
const PAD_S = parseFloat(args.pad || '0.15');               // safety trim around each detected black edge
const MIN_SEGMENT_S = parseFloat(args['min-segment'] || '1.5'); // drop leftover slivers shorter than this

try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
catch (e) { console.error('No se encontró "ffmpeg" en PATH.'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(SYNC_PATH, 'utf8'));
if (!Array.isArray(data.clips)) { console.error('JSON inválido: falta "clips".'); process.exit(1); }

function probeDuration(filePath) {
  try {
    return parseFloat(execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath]).toString().trim());
  } catch (e) { return NaN; }
}

// Runs blackdetect and returns raw [{start,end}] black ranges in the
// clip's own timeline (seconds). Decodes at SAMPLE_FPS to keep this
// affordable on hours of 4K footage — we only care about patches lasting
// several seconds, so a handful of frames per second is plenty.
function findBlackRanges(filePath) {
  const filter = `fps=${SAMPLE_FPS},blackdetect=d=${MIN_BLACK_S}:pic_th=${PIC_TH}:pix_th=${PIX_TH}`;
  const res = spawnSync('ffmpeg', ['-nostdin', '-hwaccel', 'auto', '-i', filePath, '-vf', filter, '-an', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stderr = res.stderr || '';
  const ranges = [];
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) ranges.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
  return ranges;
}

// black ranges -> the "keep" segments in between, with padding and a floor
// on how short a leftover sliver is worth keeping as its own timeline piece.
function computeSegments(duration, blackRanges) {
  const padded = blackRanges.map((r) => ({
    start: Math.max(0, r.start - PAD_S),
    end: Math.min(duration, r.end + PAD_S),
  })).sort((a, b) => a.start - b.start);

  // merge overlapping padded ranges (padding can make adjacent blacks touch)
  const merged = [];
  for (const r of padded) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  const segments = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start - cursor >= MIN_SEGMENT_S) segments.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (duration - cursor >= MIN_SEGMENT_S) segments.push({ start: cursor, end: duration });
  return segments;
}

console.log(data.clips.length, 'clips en', SYNC_PATH);
let processed = 0, withCuts = 0, totalBlackSeconds = 0, skippedNoPath = 0;

for (const c of data.clips) {
  if (!c.nativePath || !fs.existsSync(c.nativePath)) { skippedNoPath++; continue; }
  const duration = probeDuration(c.nativePath);
  if (!duration || isNaN(duration)) { console.log('  ' + c.file + ': no se pudo leer duración, se omite'); continue; }

  const blackRanges = findBlackRanges(c.nativePath);
  // no black found -> always keep the whole clip, even if it's shorter than
  // MIN_SEGMENT_S itself. That floor exists to drop unusable leftover
  // slivers next to a cut, not to discard a legitimately short clip that
  // has nothing wrong with it.
  const segments = blackRanges.length ? computeSegments(duration, blackRanges) : [{ start: 0, end: duration }];
  const blackSeconds = blackRanges.reduce((s, r) => s + (r.end - r.start), 0);
  totalBlackSeconds += blackSeconds;
  processed++;

  const isFullClip = segments.length === 1 && segments[0].start < 0.01 && segments[0].end > duration - 0.01;
  if (!isFullClip) {
    withCuts++;
    c.segments = segments;
    c.blackRanges = blackRanges;
    console.log('  ' + c.file + ': ' + blackRanges.length + ' tramo(s) negro(s), ' + blackSeconds.toFixed(1) + 's descartados, quedan ' + segments.length + ' corte(s)');
  } else {
    delete c.segments;
    delete c.blackRanges;
  }
}

fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
console.log('\n=== RESUMEN ===');
console.log('clips analizados:', processed, '| con cortes:', withCuts, '| sin nativePath/legibles:', skippedNoPath);
console.log('total de negro descartado:', totalBlackSeconds.toFixed(1) + 's');
console.log('JSON escrito en:', OUT_PATH);
