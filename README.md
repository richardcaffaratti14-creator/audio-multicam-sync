# audio-multicam-sync

Sync multicam DJ-set / event footage against a reference audio track using FFT cross-correlation. Produces `sync_offsets.json` for the [DynamicSync](https://github.com/richardcaffaratti14/DynamicSync) Premiere UXP plugin.

## Why not camera clocks?

Camera clocks across different devices aren't synchronized. GoPro chapter files make it worse: every chapter in a session gets the *same* `creation_time`, making metadata actively misleading. The reliable signal is the audio each camera's mic picked up, cross-correlated against the DJ mixer/master WAV.

Club audio is actually *good* for this — a four-on-the-floor kick drum is a sharp repeating transient that correlates better than dialogue. The catch is that repetition: raw cross-correlation can lock onto the wrong beat. Guarding against false beat-locks is most of what this tool does.

## Requirements

- Node.js
- `ffmpeg` and `ffprobe` on PATH
- No Python, no numpy — FFT is implemented in plain Node (`scripts/xcorr_lib.js`)

## Usage

### Single DJ set

```bash
node scripts/batch_sync.js \
  --captures "<folder with camera subfolders + reference audio>" \
  [--reference "master.wav"] \
  [--out "sync_offsets.json"]
```

Folder layout:
```
CAPTURAS/
  MEMORIA 1/        ← camera subfolder (any name)
    C0001.MP4
    C0002.MP4
  MEMORIA 2/
    C0001.MP4       ← same filename, different camera — handled correctly
  master.wav        ← auto-detected if it's the only audio file
```

### Multiple DJ sets (b2b nights, festivals)

Run in two phases to avoid short-clip noise corrupting the discovered set order:

```bash
# Phase 1: long clips only — establish set order
node scripts/batch_sync.js \
  --captures "<folder>" \
  --min-duration 300 \
  --out sync_offsets_phase1.json

# Review the printed "ORDEN DE REFERENCIAS DESCUBIERTO" — sanity-check gaps

# Phase 2: everything, with order locked
node scripts/batch_sync.js \
  --captures "<folder>" \
  --lock-origins sync_offsets_phase1.json \
  --merge-into sync_offsets_phase1.json \
  --out sync_offsets.json
```

### Optional: detect camarazos / blackouts

After sync, find sustained dark stretches (camera pointed at floor/pocket):

```bash
node scripts/detect_blackouts.js --sync-offsets sync_offsets.json
```

Edits the JSON in place, adding a `segments` array to clips that need trimming. The DynamicSync plugin reads `segments` automatically.

## Output

Every clip gets a `status`:

| Status | Meaning |
|--------|---------|
| `ok` | Strong match or verified chain prediction — trust it |
| `needs_review` | Predicted offset exists but local verification failed — probably close, flag it |
| `out_of_reference_range` | Reference WAV doesn't cover this clip's time range |

`offsetSeconds` can be negative (camera started before the reference). That's normal — DynamicSync handles it with a pre-roll.

## Key flags

| Flag | Default | Description |
|------|---------|-------------|
| `--captures` | required | Folder with camera subfolders |
| `--reference` | auto | Reference audio file path |
| `--out` | `<captures>/sync_offsets.json` | Output JSON path |
| `--min-duration` | — | Skip clips shorter than N seconds |
| `--lock-origins` | — | Reuse set order from a phase-1 JSON |
| `--merge-into` | — | Fold results into an existing JSON |
| `--seed-ratio` | 1.5 | Min peak-to-second-peak ratio to trust a match directly |
| `--local-accept-ncc` | 0.4 | Min NCC to accept a local verification search |

## How false beat-locks are avoided

1. **Peak ratio, not raw NCC.** `peakToSecondRatio` (best peak vs next-best peak >2s away) is the real signal. A correct match with low NCC (camera far from speakers) can have a high ratio. False beat-locks cluster at ratio ≈1.0–1.2 regardless of position.

2. **Short segments for long clips.** Correlating hours against hours dilutes signal. For clips >25% of the reference duration, the script extracts a 3-minute chunk. Observed NCC improvement: 0.05 → 0.94.

3. **Prediction + mandatory verification.** Clips below the seed threshold get a candidate offset from (a) same-camera `creation_time` delta, or (b) duration-chaining from a neighbor (GoPro-style chaptering). Every candidate must pass a local windowed search (±6s, ±40s fallback) before being accepted. Nothing accepted on arithmetic alone.

4. **No forced offsets.** Empty local search → `out_of_reference_range`, not a silent default.

## Validated results

67/71 clips correctly synced on a real 5-DJ-set event night. The 4 remaining were `needs_review` due to very short duration or genuine gaps in the reference coverage.

## File structure

```
scripts/
  batch_sync.js       — main script: extraction, correlation, chaining, JSON output
  xcorr_lib.js        — FFT cross-correlation (pure Node, no dependencies)
  detect_blackouts.js — optional blackout/camarazo detection via ffmpeg blackdetect
SKILL.md              — Claude Code skill definition (internal prompt)
```

## Related

- [DynamicSync](https://github.com/richardcaffaratti14-creator/DynamicSync) — the Premiere UXP plugin that consumes `sync_offsets.json` and builds the multicam sequence
