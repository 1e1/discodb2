# discodb2 · copilot

The **reverse-engineering Wizard companion** for the driver's phone (§7 of
[`docs/DESIGN.md`](../../docs/DESIGN.md)). Its default face is the **Wizard
glance** during a hunt and a sober **idle companion screen** between hunts — NOT
a telemetry dashboard. Decoded value tiles are a *post-discovery* affordance and
stay **dormant** until real **confirmed** signals exist; raw bit/byte watching
and all analysis live in the **cockpit**, never on the driver's phone. **iOS
Safari first**, Firefox Desktop second.

This is the LIGHT client: **no large buffering, no heavy compute**. It keeps
only the latest value per reading plus a tiny rolling window for the gauge, so
it stays well inside iOS Safari's per-tab memory budget. It speaks the discodb2
WebSocket protocol (binary batches + JSON control/status) directly — the core
protocol client is self-contained in [`src/protocol/`](src/protocol/).

The **Wizard glance** (Phase 3) reuses the canonical `frontend/shared/` modules
rather than re-implementing them: the cue beep schedule + presets
([`cue-player.ts`](../shared/cue-player.ts), [`cue-config.ts`](../shared/cue-config.ts)),
the tunables ([`wizard-config.ts`](../shared/wizard-config.ts)) and the FSM phase
vocabulary ([`wizard-fsm.ts`](../shared/wizard-fsm.ts) — types only; the copilot
never runs the reducer, the host does). These are imported with explicit `.ts`
specifiers (`tsconfig` sets `allowImportingTsExtensions`); Vite/esbuild resolve
them and bundle them into the same tiny output.

## Run

Requires Node 18+ (built with Node 24, Vite 5, Svelte 5).

```sh
cd frontend/copilot
npm install
npm run dev        # http://localhost:5174  (also bound on your LAN/AP IP)
```

Then open the printed **Network** URL on the phone (same WiFi / Pi AP).

```sh
npm run check      # svelte-check typecheck only (0 errors expected)
npm run build      # typecheck + production build → dist/  (~25 kB gz JS)
npm run preview    # serve the production build
```

### Pointing at the backend

By default the app connects to the **same host *and port* that served the
page** — so when the backend serves the built app (e.g. open
`http://discodb.local`) the WebSocket is just `ws://discodb.local/ws`, **no IP
or port to type**. The one exception is the **Vite dev/preview server** (ports
`5174`/`4174`), which is a separate process from the backend: there the app
keeps the same hostname but hops to the backend default **`:8765`** (§3.1).
Override the WS endpoint with a query param — useful when the dev server and the
backend are on different hosts/ports:

```
http://<phone-reachable-host>:5174/?ws=ws://192.168.4.1:8765/ws
```

On connect the client sends `{"type":"hello","client":"copilot"}` and then, for
zero-hardware bring-up, auto-issues `{"type":"start","source":"sim",...}` (§3.3,
`listen_only:true`) so the connection comes up LIVE. The built-in Project
([`src/lib/project.ts`]) is **empty** (`EMPTY_PROJECT`): the copilot ships with
**no confirmed signals**, so there is no placeholder "Speed/RPM/Temp" map
pretending the bus is decoded. Real confirmed signals arrive later via a future
seam (relayed from the cockpit Wizard / a shared project / a DBC); until then the
telemetry view is dormant and the default face is the idle companion screen.

## What it displays

- **Connection pill** — LIVE/REPLAY/reconnecting state, observed frames/sec, the
  backend `source` (from `/health` status pushes), and a Wake-Lock toggle.
- **Idle companion screen** — the default resting face when no Wizard session is
  running: the role ("Wizard companion") plus one plain-language status line
  ("Waiting for the Cockpit to start a hunt" / "Connecting…" / "Reconnecting…").
  It does not fake a dashboard of unknown signals.
- **Wizard glance** — the full-screen companion overlay during a hunt (see
  below): the audio cue, the per-trial verdict, the live hunt progress.
- **Value tiles + Canvas gauge** *(dormant; post-discovery)* — once **confirmed**
  signals exist, large high-contrast numbers (with a **relative** age and
  fresh/stale/dead dimming) and a 270° radial gauge + sparkline for one selected
  reading. Hidden entirely while no confirmed signals exist.
- **Add sheet (＋)** *(only when confirmed signals exist)* — pin a **confirmed,
  named Signal** (§3.5) as a value tile. Raw frame/byte/bit watching is a cockpit
  concern and is intentionally absent here.

All time is **relative only** — backend timestamps are monotonic µs with no
wall-clock meaning (§4.2), so no absolute clock is ever shown.

## Wizard glance (the driver is under load)

When the cockpit (the Wizard **host**) starts an experiment it relays
`{"type":"wizard",...}` over the control channel; the backend fans it out
verbatim (it never computes — §3.3). The copilot is a **VIEWER**: a full-screen
overlay ([`components/WizardOverlay.svelte`](src/components/WizardOverlay.svelte))
takes over, driven entirely by the relayed host state. It is optimised for
**<1 s glance, eyes-mostly-on-road**:

- **Audio-led.** The cue **BEEPS** are the primary instruction (the screen only
  confirms). On each `cueing` phase the copilot plays the shared `during`/`after`
  preset locally via the Web-Audio player lifted from `shared/cue-player.ts`
  ([`lib/cuePlayer.ts`](src/lib/cuePlayer.ts)); a vibration burst reinforces it
  where supported. iOS requires a user gesture to start audio — the first tap
  anywhere unlocks it, and every verdict tap re-unlocks after a background.
- **Icon / colour / number-first, minimal words.** State reads as colour
  (green = go/success, amber = attention, red = fail), one huge glyph, one huge
  value (the `N good / target` progress, or the silence countdown), and a pulsing
  "act now" indicator while the cue plays.
- **A11y asymmetry (never inverted).** **✓ Success** is a big, full-width,
  default-focused target (Enter / Space / single-switch map to it); **✗ Fail** is
  a smaller, deliberate, separated control, never default. In the retry prompt,
  **SKIP** is the primary action and **ABANDON** the de-emphasised secondary one;
  the silence countdown toward the guard-rail is shown so a hands-free operator
  sees the budget.
- **Honest terminal copy from state.** `done` → "Done"; `abandoned` distinguishes
  the guard-rail auto-stop ("Auto-stopped") from an explicit "Stopped", preferring
  the host's `abandonReason` and falling back to deriving it from
  `silence === silenceGuard` (WIZARD.md).

The copilot **sends** two driver→host control messages, never analysis:
- the operator's verdict —
  `{"type":"trialFeedback","action":"success|fail|abandon|skip","at":<µs>}` — which
  the host feeds into its feedback FSM;
- an **exclusion mark** —
  `{"type":"huntMark","kind":"exclude","from":<µs>,"to":<µs>}` (§3.3). The band's
  **⊘ toggle** opens a window (first tap) and closes+emits the closed span (second
  tap); while open it turns violet and shows the elapsed time so the driver never
  forgets frames are being set aside. The driver just declares "this span is not
  evidence"; whether the host **drops** those frames or uses them as a **negative
  baseline** is a host-side strategy, not a wire field. Timestamps are
  backend-monotonic µs; an unclosed window (session ended, dismissed) is never sent.

It runs **no analysis** and keeps **no history**: exactly one latest relay object
(and at most one open exclusion edge) is held, overwritten in place.

All UI strings are **English** (the project's official language). The
driver-facing strings are centralised in [`lib/strings.ts`](src/lib/strings.ts) — a frozen
string set (English values today; ready to re-key for a future i18n).

### Field reconciliation with the cockpit host

The relay parser ([`protocol/wizard.ts`](src/protocol/wizard.ts)) is tolerant by
design (the backend never validated the payload). It accepts the cockpit host's
actual field names (`target`, `label`, `abandonReason`) **and** forward-compatible
aliases (`repetitions`, `maneuver`, `candidates`, `cueSeq`); unknown phases/modes
and bad numbers fall back to safe defaults so a malformed control frame can never
wedge the viewer.

## PWA (installable + shell cache)

A small hand-rolled service worker ([`public/sw.js`](public/sw.js), registered by
[`lib/pwa.ts`](src/lib/pwa.ts)) caches the app shell so the copilot launches
instantly and survives a flaky in-car link: **network-first** for navigations
(falls back to the cached shell offline), **cache-first** for the content-hashed
JS/CSS (immutable). The WebSocket data path and `/ws` · `/health` are bypassed
entirely — the SW never sits on the live stream. A new build installs as a
**waiting** worker and surfaces a one-tap "New version · refresh" banner (hidden
during a Wizard session); we never hot-swap code mid-glance.
Registration is a progressive enhancement: it no-ops in dev and on plain-HTTP LAN
IPs (service workers need a secure context), so the app is unchanged where it
can't run. A [`manifest.webmanifest`](public/manifest.webmanifest) + icons make it
add-to-home-screen installable (portrait, standalone, dark theme).

## iOS Safari handling

- **Screen Wake Lock** (`navigator.wakeLock`, iOS 16.4+): requested on load and
  via the pill toggle. iOS **releases the lock whenever the page is hidden**
  (screen off / app switch / call), so it is **re-acquired on
  `visibilitychange`** when you return. If unsupported (older iOS, or Firefox
  without the flag), the toggle shows "no wake" — disable **Auto-Lock** in
  iOS Settings ▸ Display & Brightness as a fallback.
- **Reconnect across backgrounding**: iOS **suspends the WebSocket when the tab
  or screen sleeps, often without firing `onclose`**. The client handles this on
  several fronts:
  - capped exponential backoff (0.5→8 s) **+ jitter** on any close/error, with
    backoff reset on a successful open;
  - on `visibilitychange→visible`, `pageshow` (bfcache restore) and `online`, it
    **force-reconnects** if the socket is not demonstrably `OPEN` or has been
    silent past the stall timeout;
  - a **1 Hz stall watchdog** (only while visible) force-reconnects a socket
    that claims to be open but has received nothing for ~6 s — the classic
    silent-dead-socket symptom. The watchdog is idle while backgrounded so it
    never thrashes reconnects or drains battery.
- **Bounded memory** (why this stays alive when iOS reaps memory-hungry tabs):
  - binary batches are parsed with a **single reused scratch record + payload
    buffer** — no per-frame allocation, no `CanRecord[]` array;
  - **no history is stored** — each record is resolved into the active readings
    and dropped; only the latest value per reading is retained;
  - the gauge's only history is **one fixed 120-sample `Float64Array`** ring;
  - the DOM updates at **display rate via a single `requestAnimationFrame`
    loop** (which pauses when backgrounded), not once per CAN frame — thousands
    of frames/sec still cost ~60 repaints/sec max.
- **Touch / layout**: portrait, one-handed; ≥56 px touch targets; high-contrast
  dark theme (OLED-friendly, low night glare); `viewport-fit=cover` + safe-area
  insets for the notch/home indicator; pull-to-refresh and double-tap-zoom
  disabled so a glance never reloads mid-drive; `devicePixelRatio` capped at 2×
  for the Canvas to bound backing-store memory.

## Layout

```
src/
  main.ts                 mount
  App.svelte              layout: pill · gauge · tiles · bit-grids · add-sheet · Wizard overlay
  app.css                 high-contrast dark theme, safe-area, touch sizing
  protocol/               core protocol client (self-contained)
    types.ts              §3.5 data model + §3.2/§3.3/§3.4 message types (+ trialFeedback)
    parse.ts              §3.2 binary batch parser (reused scratch buffers)
    decode.ts             §3.5 signal bit-extraction (little/big, factor/offset)
    client.ts             WebSocket client: reconnect, iOS resume, /health probe, wizard relay in / trialFeedback out
    wizard.ts             §3.3 wizard-relay types + tolerant parser (reconciles cockpit field names)
  lib/
    store.svelte.ts       bounded-memory store (latest values + gauge ring + rAF + latest wizard relay)
    watches.ts            watch model: signal-only (raw frame/byte watching is a cockpit concern)
    project.ts            EMPTY_PROJECT — no confirmed signals; telemetry stays dormant
    ring.ts               fixed-capacity Float64Array ring buffer
    wakeLock.ts           Screen Wake Lock controller (re-acquire on visible)
    relTime.ts            relative-age formatting (no wall clock)
    cuePlayer.ts          Web-Audio cue player (lifts shared/cue-player.ts; iOS unlock + vibrate fallback)
    strings.ts            frozen driver-facing UI string set (English; ready for i18n)
    pwa.ts                service-worker registration + "new version → refresh"
  components/
    ConnectionPill.svelte ValueTile.svelte  Gauge.svelte
    WatchPicker.svelte    WizardOverlay.svelte  (the full-screen glance UI)
public/
  sw.js                   shell-cache service worker (network-first nav, cache-first assets)
  manifest.webmanifest    installable PWA manifest      icon.svg / icon-192.png / icon-512.png
```

Reused from [`frontend/shared/`](../shared): `cue-player.ts`, `cue-config.ts`,
`wizard-config.ts`, `wizard-fsm.ts` (phase types only — the copilot never runs
the reducer).

## Scope / contract notes

- Implements the DESIGN.md contract directly. CAN-FD is out of scope (§3.2:
  classic CAN ≤8 only; FD is a future v2).
- The §3.4 status/health push has **no `type` discriminator** in the contract,
  so the client treats any non-`files`/`error` text frame carrying a `bus` field
  as a Health status. If a `type` is later added, narrow the discriminator in
  `client.ts::handleText`.
- `record_start` / `record_stop` / `list_files` controls and the `files` push
  are typed and wired in the client API but not surfaced in this light UI
  (recording is a cockpit concern).
