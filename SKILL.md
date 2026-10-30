---
name: audio-multicam-sync
description: Syncs multicam DJ-set / event footage (several camera folders, e.g. "MEMORIA 1..4") against one long reference audio track (the DJ mixer / master WAV) using audio cross-correlation, and produces sync_offsets.json for the DynamicSync Premiere UXP plugin (D:\.PLUGINS PREMIERE\PREMIERE PLUGINS\DynamicSync). Use this whenever the user wants to sync multicam footage from a club/party/event shoot, mentions syncing cameras to a DJ set or master audio, asks to find "el punto de sincronía" between clips, or wants to feed the DynamicSync plugin's "IMPORTAR SYNC POR AUDIO" button — even if they don't say "audio cross-correlation" explicitly. Do NOT reach for camera-clock/timecode/creation_date sync for this kind of footage: camera clocks across different devices are not synchronized (verified repeatedly) and this skill's whole point is avoiding that failure mode.
---

# Audio multicam sync

## Idioma

Todo lo que le digas al usuario tiene que estar **en español**: el resumen
por cámara, el aviso de clips `needs_review` / `out_of_reference_range`, las
preguntas, los errores y las explicaciones. Esto incluye los mensajes de
progreso y el cierre. Los nombres técnicos (`sync_offsets.json`, `status`,
`ok`, `needs_review`, flags como `--min-duration`, nombres de archivos y
botones del plugin) se dejan tal cual, sin traducir. El resto de este
documento está en inglés como referencia interna; no lo copies al usuario
en inglés.

## Why this exists

Multicam footage from parties/events (several cameras, one DJ/mixer audio feed
recorded separately) cannot be synced by camera clock or file `creation_time`:
cameras are not clock-synced to each other, and some (GoPro chaptered files
in particular) even tag every chapter of a session with the *same*
`creation_time`, making metadata actively misleading. The reliable signal is
the audio each camera's mic picked up from the room, cross-correlated against
a long reference track that covers the whole event (the DJ mixer/master WAV).

Counter-intuitively, loud "noisy" club audio is *good* for this — a
four-on-the-floor kick drum is a strong, sharp, repeating transient that
correlates far better than dialogue. The catch is exactly that repetition:
raw cross-correlation can lock onto the wrong beat (a false peak one bar
away from the true one). Guarding against that — not the correlation math
itself — is most of what this skill does.

## What to run

Everything is one script. Don't hand-roll ffmpeg/FFT one-offs — this exists
because that's exactly what earlier sessions did, several times, at real
token cost.

```bash
node "<skill-dir>/scripts/batch_sync.js" --captures "<CAPTURAS folder>" [--reference "audio.wav"] [--out "sync_offsets.json"]
```

- `--captures`: the folder containing one subfolder per camera (any names —
  commonly "MEMORIA 1", "MEMORIA 2", ...) plus the reference audio file. If
  there's only one audio file (`.wav`/`.mp3`/`.aiff`/`.flac`) directly in
  that folder it's auto-detected; otherwise pass `--reference`.
- If there are no camera subfolders (all clips directly in `--captures`),
  they're treated as one group.
- `--out` defaults to `sync_offsets.json` inside the captures folder — that's
  the path to hand to the DynamicSync plugin's "IMPORTAR SYNC POR AUDIO"
  button.
- Requires `ffmpeg`/`ffprobe` on PATH. No Python needed — the FFT
  cross-correlation is implemented in plain Node (see `scripts/xcorr_lib.js`);
  this environment doesn't have numpy/scipy available, and there was no
  reason to introduce a Python dependency just for an FFT.

Runtime is dominated by ffmpeg audio extraction, which is fast because it
only demuxes the audio stream (no video decode) — expect roughly realtime-or-
faster per clip regardless of the video file's size (a 47GB 4K file takes
about as long to extract audio from as a 500MB one). A full night (60-100
clips) typically finishes extraction in well under a minute; the correlation
pass itself is a few seconds.

The script prints a per-camera summary table (file, offset, status, method)
and writes the JSON. Report that summary to the user — don't just say "done."

## Reading the output

Every clip gets one of three `status` values:

- **`ok`** — trust it. Either a strong direct audio match, or a same-camera
  chained prediction that was independently re-verified with a local
  correlation search (see "How it avoids false matches" below).
- **`needs_review`** — a predicted offset exists (from a same-camera
  neighbor) but the local search never found a confirming correlation peak
  above threshold. Usually means: very short/quiet clip, or a genuine gap in
  that camera's recording near this clip. Still probably close, but flag it
  to the user rather than asserting confidence you don't have.
- **`out_of_reference_range`** — no usable prediction and no confirming
  match anywhere reachable. Commonly means the reference WAV doesn't cover
  this part of the night (it started recording later or stopped earlier than
  some camera). Report this plainly; don't force a number.

`offsetSeconds` can be **negative** — that means the camera started rolling
before the reference track began. That's expected and fine; the DynamicSync
plugin already handles it by adding a pre-roll (shifting the whole sequence
so the earliest clip lands at 0) before building the Premiere sequence. Don't
"fix" a negative offset yourself.

## How it avoids false matches (read before changing thresholds)

This is the part that took real trial and error in the session this skill
was extracted from — the mechanics below aren't arbitrary.

1. **Ratio over raw correlation.** `peakToSecondRatio` (best correlation
   peak vs. the next-best peak found more than 2s away) is the signal that
   actually tells you whether a match is real, not the normalized
   correlation coefficient (`ncc`). `ncc` mostly reflects mic distance/SNR —
   a clip recorded far from the speakers can have low `ncc` on a *correct*
   match. `peakToSecondRatio` tells you whether the match is *distinctive*,
   which is what matters when the audio is periodic. A clip with `ncc=0.60`
   but `ratio=1.2` was independently confirmed correct in testing; several
   clips with `ratio≈1.0-1.2` clustered at the *same* wrong timestamp
   regardless of their real sequence position turned out to be false
   beat-locks. `SEED_RATIO` (default 1.5) is the line between "trust this
   directly" and "needs reconciliation."

2. **Short segments beat whole-clip correlation for long clips.** If a
   camera ran continuously for most/all of the event, correlating the whole
   multi-hour clip against the whole multi-hour reference dilutes the
   signal — observed `ncc` jump from ~0.05 (near-noise) to ~0.94 by instead
   extracting a 3-minute chunk from partway into the clip and correlating
   just that. The script does this automatically for any clip whose
   duration exceeds ~25% of the reference's, or whose global match came back
   weak.

3. **Reconciliation is prediction + mandatory verification, never
   prediction alone.** For a clip that doesn't clear the seed threshold, the
   script predicts a candidate offset two ways — (a) `creation_time` delta
   to the nearest same-camera seed clip (valid *only* within one camera's
   own clock, never across cameras — that's the whole reason this skill
   exists instead of trusting metadata), and (b) duration-chaining from an
   already-resolved neighboring clip, for cameras/formats that auto-split a
   continuous recording into multiple files (GoPro-style chaptering). Even
   file-size auto-split "continuous" recordings can have real gaps —
   two files that looked like clean chapter boundaries turned out to have
   9s and 39s real gaps between them when checked directly. So every
   candidate prediction gets a **local windowed correlation search** (±6s,
   falling back to ±40s) around it before being accepted; nothing is
   accepted on arithmetic alone. This is also why GoPro's identical
   `creation_time` across chapters isn't fatal: the duration-chain candidate
   and the verification search route around it.

4. **Don't force an offset where the reference doesn't reach.** If local
   search comes back empty in the valid range near every candidate, that's
   reported as `out_of_reference_range`, not silently defaulted to 0 or to
   the nearest guess.

If you're tempted to loosen `SEED_RATIO` or `LOCAL_ACCEPT_NCC` because a
particular night's music is unusually clean or unusually noisy, that's
reasonable — pass `--seed-ratio` / `--local-accept-ncc` rather than editing
the script, and sanity-check a couple of `ok` results manually (do the
independent-clip cross-check from point 3: two clips from the same camera at
different points in the night should chain to internally consistent offsets)
before trusting a loosened threshold across the whole set.

## Nights with several DJ sets (multiple reference tracks)

If `--captures` has more than one reference audio file (several DJs / b2b
segments, each recorded as its own file with no shared clock and usually no
metadata saying what order they played in), the script treats every clip
against every reference track and keeps whichever track it actually matches
— it does not need to be told the running order. It then figures out the
order and the gaps between sets itself, using cameras that happened to be
rolling through a set changeover: if one camera's clips go from matching
track A to matching track B, the delta between those clips' own creation
time and their measured local offsets tells you exactly how B's timeline
relates to A's. This is printed as "ORDEN DE REFERENCIAS DESCUBIERTO" and
saved as `originSeconds` per track in the output JSON.

**With many clips (100s) and many tracks, go in two phases — don't run
everything at once.** The set order is derived from whichever clips happen
to bridge changeovers, and if that computation mixes in hundreds of short,
noisy handheld clips, a bad chain among the short clips can quietly perturb
the whole night's discovered order — which then silently drags every other
clip's global offset with it. This is a real failure mode, not a
hypothetical: it's exactly what happened the first time this was tried on a
five-DJ-set night with 150+ short clips per camera mixed in from the start.

1. **Phase 1 — long clips only**, to establish the set order cheaply and
   reviewably:
   ```bash
   node batch_sync.js --captures "<folder>" --min-duration 300 --out "sync_offsets_phase1.json"
   ```
   `--min-duration` (seconds) keeps only clips at or above that length —
   fixed cameras and GoPro-style chaptered files are usually long, individual
   handheld cuts usually aren't. Pick a threshold that leaves you with a
   small, high-individual-confidence set per camera (tens of clips, not
   hundreds). Look at the printed "ORDEN DE REFERENCIAS DESCUBIERTO" and the
   per-camera table; sanity-check the gaps between sets against what the
   user remembers about the night (a 5-10 minute changeover is normal, an
   hour+ gap is worth asking about) before moving on.

2. **Phase 2 — everything, with the order locked**:
   ```bash
   node batch_sync.js --captures "<folder>" --lock-origins "sync_offsets_phase1.json" --merge-into "sync_offsets_phase1.json" --out "sync_offsets.json"
   ```
   `--lock-origins` skips recomputing track order/gaps entirely and reuses
   phase 1's `originSeconds` per track — so no amount of short-clip noise can
   move the skeleton you already confirmed. `--merge-into` folds phase 2's
   results into phase 1's file instead of overwriting it (phase-1 clips you
   already trust are kept, matched by **memoria + filename**, never filename
   alone; phase 2 just adds the rest). A reference track phase 1 excluded
   entirely, or one phase 1 couldn't bridge, has no locked origin to use —
   its clips fall back to `needs_review` with a note explaining why, rather
   than a guessed number.

For a single-reference-track night this doesn't apply — there's no order to
get wrong, so one pass with no `--min-duration` is fine.

**Bridge estimates from different cameras can disagree — never trust just
one.** A camera whose footage itself straddles the changeover (its audio
briefly resembles both sets) can pass the correlation check without being a
clean match to either side, giving a wrong bridge estimate with a perfectly
reasonable-looking confidence score. This isn't hypothetical — on a real
five-set night, one GoPro's bridges were off by 40-120 minutes on 3 of 4
transitions, while two other cameras agreed with each other to within half a
second every time. The script guards against this itself: when more than one
camera bridges the same pair of tracks, it takes the median and drops
whichever bridge disagrees by more than 5s (printed as `AVISO: ... descartado
por no coincidir`); when exactly two disagree with no way to take a median,
it breaks the tie using which camera's *other* bridges elsewhere in the night
turned out trustworthy (printed as `AVISO: ... Elegido por historial de la
cámara`); if it still can't decide, it leaves that pair unresolved rather
than average two numbers that can't both be right. Read these AVISO lines —
they tell you which specific camera/clip pair to sanity-check by eye if the
discovered gaps still look wrong (a real back-to-back DJ changeover is
usually 5-30 seconds, not tens of minutes).

## Two different cameras can share a filename — don't match on filename alone

Confirmed on real material: two Sony cards from similarly-configured cameras
produced 88 exactly-identical filenames (`C5736.MP4` etc.) across two
different "MEMORIA" folders that are genuinely two different physical
cameras. Anything that keys clips by filename alone — merging two runs of
this script, or the DynamicSync plugin matching an imported Premiere project
item back to a JSON entry — will silently conflate the two cameras' clips if
it does this. `batch_sync.js`'s own `--merge-into` already keys by
`memoria::file`; the DynamicSync plugin's project-item lookup matches by the
clip's full imported path first, only falling back to filename when that
fails and only if the filename resolves to exactly one project item. If you
extend either script, key on `(memoria, file)` or on the full path — never
on `file` alone.

## Cutting out camarazos / dead footage (optional, after sync)

"Camarazo": the operator forgets to stop recording and the camera ends up
pointed at the floor, ceiling, or their pocket for a while before the next
real shot. `scripts/detect_blackouts.js` finds the sustained black/near-black
stretches this produces (also catches genuine blackouts) and records which
parts of each clip are worth keeping, so the DynamicSync plugin can insert
only the good ranges and skip the bad one entirely — never inserted, not
inserted-then-deleted.

```bash
node detect_blackouts.js --sync-offsets "<sync_offsets.json>"
```

Run it after `batch_sync.js` (it edits the same JSON in place by default,
adding a `segments` array to any clip that needs one — clips with no black
patch are left untouched, no `segments` field). Then use the DynamicSync
plugin exactly as before: "IMPORTAR SYNC POR AUDIO" → "CREAR SECUENCIA
(AUDIO)" already reads `segments` when present and inserts one trimmed piece
per kept range instead of the whole clip, using `ClipProjectItem`'s
`createSetInOutPointsAction` before each insert — there's no razor/split
action in the Premiere UXP API to script against, so trim-then-insert is the
actual cutting mechanism, not an ffmpeg operation. ffmpeg's job here is
detection only (`blackdetect`, decoded at a reduced 5fps to stay affordable
on hours of 4K); it never touches the source files.

**Scope, honestly**: this only catches *dark* camarazos/blackouts. A camera
pointed at a well-lit floor or ceiling looks like ordinary footage to a
black-frame detector and won't be caught — there's no cheap, reliable general
"this shouldn't be here" signal for that without a trained visual classifier
or a human. Don't oversell this to the user as catching every camarazo.

Runtime is much heavier than the sync step: `blackdetect` requires decoding
video (audio-only demux for sync was nearly free; this isn't), even at a
reduced sample rate. Expect low tens-of-seconds per clip rather than
sub-second — budget accordingly for large batches (100+ clips) and run it in
the background.

## After generating sync_offsets.json

Tell the user where it landed, and that it's ready for the DynamicSync
plugin: open the panel in Premiere → "IMPORTAR SYNC POR AUDIO (JSON)" → pick
the file → "CREAR SECUENCIA (AUDIO)". If there are `needs_review` or
`out_of_reference_range` clips, mention them specifically (which camera,
roughly how many) rather than burying it in the full table.
