# Landing-page screenshots

Reproducible capture of the screenshots embedded in `web/index.html`, taken
from the **live** cockpit/copilot running against the bundled `--source sim`
bus. No hand-staging: each shot is a deep-link URL that boots the app into the
exact state to capture (see `frontend/cockpit/src/state/urlState.ts`).

## One-time setup

```bash
cd backend && pip install -r requirements.txt          # backend deps
(cd frontend/cockpit && npm i) && (cd frontend/copilot && npm i)
cd tools/screenshots && npm i                          # Playwright + Chromium
```

## Run

```bash
tools/screenshots/run.sh                      # all shots in shots.txt → web/img/*.png
tools/screenshots/run.sh path/to/other.txt    # a different manifest
```

`run.sh` starts the backend + both dev servers, waits, captures, and tears
everything down. To capture against servers you already have running, skip it:

```bash
cd tools/screenshots && node capture.mjs            # uses ./shots.txt (:5173 / :5174)
node capture.mjs ../../my-shots.txt                 # a different manifest
```

## The manifest (`shots.txt`)

One shot per line — **this is the only file to edit when redoing captures**:

```
<url>   <output.png>   [preset]   [settleMs]
```

- `<output.png>` — relative to the repo root, or absolute.
- `[preset]` — `wide` (1440×900 @2x, default) · `panel` (1200×800 @2x) ·
  `phone` (iPhone 13 @3x) · `<W>x<H>` (custom CSS px @2x, e.g. `1600x1000`).
- `[settleMs]` — how long to let the bus stream before shooting (default 5000).

`#` lines and blanks are ignored. URLs build on the deep-link scheme
(`?src=…&project=…#/…`); the `sim-demo` project
(`frontend/cockpit/src/dbc/sim-demo.ts`) decodes the simulated bus into named
signals with pinned signal ids so the deep links stay stable.

## Tuning

- **Which shots / where they save** — edit `shots.txt`.
- **Framing / size** — change the preset (or use `<W>x<H>`) in `shots.txt`.
- **Let data build up** — bump the per-line `settleMs` if sparklines look sparse.
- **Tighter crops** — `capture.mjs` shoots the full viewport; for a panel-only
  crop add `clip` or an `element.screenshot()` on a selector.
