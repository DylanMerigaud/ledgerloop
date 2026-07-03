# Regenerating `docs/demo.gif`

The README GIF is a short slideshow of the operations pane's key states. It is built
from **static screenshots stitched with crossfades**, not a screen recording, because a
live run depends on model latency and drifts; screenshots are deterministic and let each
scene get an even, deliberate dwell. Runs are replayed from the seeded audit log, so no
model call is needed and the graph, banners, and gate render instantly.

## Prerequisites

- The dev server env (`.env` with `ANTHROPIC_API_KEY` + `DATABASE_URL`) so the app boots
  and the seeded recent runs exist (the replays come from `agent_runs`).
- `ffmpeg` (`brew install ffmpeg`). Playwright is already a dev dep.

## Steps

1. **Start the app and warm it up** (so the first navigation isn't a cold compile):

   ```bash
   pnpm dev -p 4079        # in one shell, with .env loaded
   curl -s localhost:4079/ -o /dev/null   # warm the route
   ```

2. **Capture one screenshot per scene** with Playwright (viewport 1280x800,
   `deviceScaleFactor: 2` for a crisp @2x image). Open the pipeline tab, select a clean
   invoice for the PDF, then open a `posted` / `awaiting` / `blocked` run from Recent runs
   (filter each row by its outcome text), waiting for the run pane's graph node + the
   outcome banner before shooting:

   - `1_pdf.png`       , a queued invoice's PDF/extraction
   - `2_awaiting.png`  , an exception paused at the gate (Approve / Reject + AI spark)
   - `3_posted.png`    , a reconciled bill (lit graph)
   - `4_blocked.png`   , a duplicate blocked (greyed workflow + red banner)

3. **Stitch into a crossfaded slideshow**, ~3s per frame, 0.5s fade:

   ```bash
   ffmpeg -y \
    -loop 1 -t 3.0 -i 1_pdf.png -loop 1 -t 3.0 -i 2_awaiting.png \
    -loop 1 -t 3.0 -i 3_posted.png -loop 1 -t 3.2 -i 4_blocked.png \
    -filter_complex "\
     [0:v]fps=25,scale=1000:-2:flags=lanczos,setsar=1[v0];\
     [1:v]fps=25,scale=1000:-2:flags=lanczos,setsar=1[v1];\
     [2:v]fps=25,scale=1000:-2:flags=lanczos,setsar=1[v2];\
     [3:v]fps=25,scale=1000:-2:flags=lanczos,setsar=1[v3];\
     [v0][v1]xfade=transition=fade:duration=0.5:offset=2.5[a];\
     [a][v2]xfade=transition=fade:duration=0.5:offset=5.0[b];\
     [b][v3]xfade=transition=fade:duration=0.5:offset=7.5[v]" \
    -map "[v]" -pix_fmt yuv420p slides.mp4
   ```

4. **Convert to a palette-optimised GIF** (~1MB at 12fps / 1000px wide):

   ```bash
   ffmpeg -y -i slides.mp4 -vf "fps=12,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" pal.png
   ffmpeg -y -i slides.mp4 -i pal.png \
     -lavfi "fps=12,scale=1000:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=sierra2_4a" \
     docs/demo.gif
   ```

Keep the GIF under ~1.5MB (GitHub renders it inline; larger is slow to load). If a scene
changes, re-shoot just that frame and rerun steps 3-4. Update the README alt text if the
scenes change.
