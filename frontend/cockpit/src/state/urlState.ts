/**
 * Deep-linking: mirror the navigation state into the URL hash, and apply an
 * incoming hash on load. The hash is human-readable so it can be pasted into
 * docs / forum posts to point at exactly what you mean:
 *
 *   #/cluster
 *   #/hunt
 *   #/logbook/field
 *   #/explore                       (the frame table)
 *   #/explore/f280                  (frame 0x280 selected)
 *   #/explore/f280/m0               (… its message, mux value 0)
 *   #/explore/f280/m0/s<signalId>   (… a signal of that message)
 *   #/explore/f1A5A0F01x            (an EXTENDED 29-bit id — trailing 'x')
 *
 * Navigating updates the hash (history.replaceState — no new entries per click).
 * Arriving on a deep link sets `flashKey` to the deepest targeted component so
 * its row highlights then fades (see the .flash-target CSS).
 */
import { get } from 'svelte/store';
import {
  uiMode,
  logbookSub,
  selected,
  selectedMux,
  selectedSignalId,
  flashKey,
  wsUrl,
  connect,
  connectionState,
  getClient,
  loadProject,
} from './store';
import { frameKey } from '../protocol/datamodel';
import type { Project } from '../protocol/datamodel';
import type { CanSource } from '../protocol/types';
import { simDemoProject } from '../dbc/sim-demo';
import { obd2StarterProject } from '../dbc/obd2-starter';
import { vwPqProject } from '../dbc/vw-pq-demo';

/** Built-in projects loadable from the URL via `?project=<key>`. */
const BUILTIN_PROJECTS: Record<string, () => Project> = {
  'sim-demo': simDemoProject,
  'vw-pq': vwPqProject,
  obd2: obd2StarterProject,
};

// Guard: while we APPLY a parsed hash to the stores, suppress writing it back
// (the store updates would otherwise fight the parse).
let applying = false;

function buildHash(): string {
  const mode = get(uiMode);
  if (mode === 'logbook') return `#/logbook/${get(logbookSub)}`;
  if (mode !== 'explore') return `#/${mode}`;

  let h = '#/explore';
  const sel = get(selected);
  if (sel) {
    h += `/f${sel.id.toString(16).toUpperCase()}${sel.isExtended ? 'x' : ''}`;
    const mux = get(selectedMux);
    if (mux !== null) h += `/m${mux}`;
    const sig = get(selectedSignalId);
    if (sig) h += `/s${sig}`;
  }
  return h;
}

function writeHash(): void {
  if (applying) return;
  const h = buildHash();
  if (location.hash !== h) {
    history.replaceState(history.state, '', h);
  }
}

/** Apply the current location.hash to the stores. Returns the flash key, if any. */
export function applyHash(): void {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return;
  const parts = raw.split('/').filter(Boolean);
  const mode = parts[0];
  applying = true;
  try {
    if (mode === 'hunt' || mode === 'cluster') {
      uiMode.set(mode);
    } else if (mode === 'logbook') {
      uiMode.set('logbook');
      const sub = parts[1];
      if (sub === 'storyboard' || sub === 'field' || sub === 'findings') logbookSub.set(sub);
    } else if (mode === 'explore') {
      uiMode.set('explore');
      let flash: string | null = null;

      const fp = parts.find((p) => /^f[0-9A-Fa-f]+x?$/.test(p));
      if (fp) {
        const isExtended = fp.endsWith('x');
        const id = parseInt(fp.slice(1), 16); // parseInt stops at the trailing 'x'
        if (!Number.isNaN(id)) {
          // Setting `selected` resets mux+sig (store wiring); set them AFTER, in order.
          selected.set({ id, isExtended });
          const fkey = frameKey(id, isExtended);
          flash = `frame:${fkey}`;

          const mp = parts.find((p) => /^m-?\d+$/.test(p));
          if (mp) {
            const mux = parseInt(mp.slice(1), 10);
            if (!Number.isNaN(mux)) {
              selectedMux.set(mux);
              flash = `msg:${fkey}:${mux}`;
            }
          }
          const sp = parts.find((p) => p.length > 1 && p[0] === 's');
          if (sp) {
            const sigId = sp.slice(1);
            // Set it regardless; if the frame has no such signal the list simply
            // shows nothing selected (harmless), so we avoid id-prefix guesses.
            selectedSignalId.set(sigId);
            flash = `sig:${sigId}`;
          }
        }
      }
      flashKey.set(flash);
    }
  } finally {
    applying = false;
  }
}

const VALID_SOURCES = new Set<string>(['sim', 'replay', 'socketcan', 'gs_usb', 'slcan']);

/**
 * Reproducible doc links: SEARCH params (not the hash) pick the data source to
 * auto-start at boot, so a link opens the cockpit already populated:
 *
 *   ?src=sim
 *   ?src=replay&file=recordings/vw_pq_circuit.canlog
 *   ?src=replay&file=…&ws=ws://discodb.local:8765/ws#/explore/f280
 *
 * An optional `?project=<key>` loads a built-in project first, so the link opens
 * with signals already decoded (e.g. `?src=sim&project=sim-demo#/cluster`):
 *
 *   ?project=sim-demo               (decodes the bundled --source sim bus)
 *   ?project=obd2                   (the OBD2 Service 01 starter)
 *
 * Goes through the REAL pipeline (the chosen backend source) — no special "mock"
 * machinery, so it costs the backend only what that source costs, and the frontend
 * nothing in normal operation: absent `src`/`project`, this is a single early-return guard.
 */
function bootFromSearch(): void {
  const sp = new URLSearchParams(location.search);

  // Load a built-in project before connecting, so the first frames decode.
  const projectKey = sp.get('project');
  if (projectKey && BUILTIN_PROJECTS[projectKey]) {
    loadProject(BUILTIN_PROJECTS[projectKey]());
  }

  const src = sp.get('src');
  if (!src || !VALID_SOURCES.has(src)) return;
  const file = sp.get('file') ?? undefined;
  const ws = sp.get('ws');
  if (ws) wsUrl.set(ws);
  connect(get(wsUrl));
  // Send ONE start as soon as the socket opens, then unsubscribe.
  let done = false;
  const unsub = connectionState.subscribe((s) => {
    if (s === 'open' && !done) {
      done = true;
      getClient().start({
        source: src as CanSource,
        bitrate: 500000,
        listenOnly: true,
        file: src === 'replay' ? file : undefined,
      });
      setTimeout(() => unsub(), 0);
    }
  });
}

let started = false;

/**
 * Wire two-way sync. Call ONCE on app mount. Applies the initial hash, then
 * subscribes the navigation stores so each change rewrites the hash. Also clears
 * a flash after it has faded (~3 s) and re-applies the hash on manual back/forward.
 */
export function initUrlSync(): void {
  if (started) return;
  started = true;

  bootFromSearch();
  applyHash();

  // Clear the initial flash once its animation is done.
  if (get(flashKey)) {
    setTimeout(() => flashKey.set(null), 3200);
  }

  // Mirror navigation → hash.
  uiMode.subscribe(writeHash);
  logbookSub.subscribe(writeHash);
  selected.subscribe(writeHash);
  selectedMux.subscribe(writeHash);
  selectedSignalId.subscribe(writeHash);

  // Honor manual hash edits / browser back-forward.
  window.addEventListener('hashchange', () => {
    applyHash();
    if (get(flashKey)) setTimeout(() => flashKey.set(null), 3200);
  });
}
