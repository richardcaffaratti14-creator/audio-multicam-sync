// Shared FFT-based cross-correlation primitives for audio-multicam-sync.
// Pure Node.js, no dependencies (no numpy/scipy available in this environment).

const fs = require('fs');

function loadInt16(path) {
  const buf = fs.readFileSync(path);
  const n = buf.length / 2;
  const arr = new Float64Array(n);
  for (let i = 0; i < n; i++) arr[i] = buf.readInt16LE(i * 2);
  return arr;
}

function meanRemove(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) m += arr[i];
  m /= arr.length;
  for (let i = 0; i < arr.length; i++) arr[i] -= m;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// iterative radix-2 FFT, in-place, re/im as Float64Array of length N (power of 2)
function fft(re, im, invert) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (invert ? -1 : 1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * curWr - im[i + j + len / 2] * curWi;
        const vi = re[i + j + len / 2] * curWi + im[i + j + len / 2] * curWr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const nwr = curWr * wr - curWi * wi;
        const nwi = curWr * wi + curWi * wr;
        curWr = nwr; curWi = nwi;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// Full-range search: find the best lag (0..lenA-lenB) aligning clip b inside reference a.
// Returns { bestLag, bestNcc, peakToSecondRatio } in SAMPLES (divide by SR for seconds).
function globalXcorr(a, b, sr) {
  const lenA = a.length, lenB = b.length;
  if (lenB >= lenA) return { bestLag: null, bestNcc: -1, peakToSecondRatio: 0 };
  const N = nextPow2(lenA + lenB - 1);

  const are = new Float64Array(N), aim = new Float64Array(N);
  are.set(a);
  const bRevre = new Float64Array(N), bRevim = new Float64Array(N);
  for (let i = 0; i < lenB; i++) bRevre[i] = b[lenB - 1 - i];

  fft(are, aim, false);
  fft(bRevre, bRevim, false);
  const cre = new Float64Array(N), cim = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    cre[i] = are[i] * bRevre[i] - aim[i] * bRevim[i];
    cim[i] = are[i] * bRevim[i] + aim[i] * bRevre[i];
  }
  fft(cre, cim, true);

  const maxLag = lenA - lenB;
  let bestLag = 0, bestVal = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    const v = cre[lag + (lenB - 1)];
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }

  let dot = 0, ea = 0, eb = 0;
  for (let k = 0; k < lenB; k++) {
    const av = a[bestLag + k];
    dot += av * b[k]; ea += av * av; eb += b[k] * b[k];
  }
  const ncc = dot / Math.sqrt(ea * eb);

  let secondVal = -Infinity;
  const excl = Math.round(2 * sr);
  for (let lag = 0; lag <= maxLag; lag++) {
    if (Math.abs(lag - bestLag) < excl) continue;
    const v = cre[lag + (lenB - 1)];
    if (v > secondVal) secondVal = v;
  }
  const ratio = secondVal > 0 ? bestVal / secondVal : Infinity;

  return { bestLag, bestNcc: ncc, peakToSecondRatio: ratio };
}

// Constrained brute-force search in a window around centerLag (samples). Slower per-sample
// but the window is small, so it's cheap. Used to verify/refine a metadata-predicted offset
// without re-opening the door to false periodic-beat matches from a full-range search.
function localSearch(a, b, centerLag, windowSeconds, sr) {
  const lenA = a.length, lenB = b.length;
  const win = Math.round(windowSeconds * sr);
  const lo = Math.max(0, centerLag - win);
  const hi = Math.min(lenA - lenB, centerLag + win);
  if (lo > hi) return { bestLag: null, bestNcc: -1, outOfRange: true };
  let bestLag = null, bestNcc = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    let dot = 0, ea = 0, eb = 0;
    for (let k = 0; k < lenB; k++) {
      const av = a[lag + k];
      dot += av * b[k]; ea += av * av; eb += b[k] * b[k];
    }
    const ncc = dot / Math.sqrt(ea * eb);
    if (ncc > bestNcc) { bestNcc = ncc; bestLag = lag; }
  }
  return { bestLag, bestNcc, outOfRange: false };
}

module.exports = { loadInt16, meanRemove, nextPow2, fft, globalXcorr, localSearch };
