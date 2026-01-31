/**
 * PWA service-worker registration + UPDATE FLOW (P3 / DESIGN §6).
 *
 * vite-plugin-pwa with registerType:'prompt' precaches the app shell (so the
 * cockpit loads offline once visited) but does NOT silently swap to a new build:
 * a long in-car session must never be reloaded out from under the operator, and
 * we must NEVER serve a stale shell. So when a new build is waiting we show a
 * small, non-blocking banner; the operator chooses when to apply it.
 *
 *   onNeedRefresh  → a new version is precached & waiting → offer "Refresh now".
 *                    updateSW(true) activates the waiting worker and reloads, so
 *                    the very next paint is the fresh shell (never stale).
 *   onOfflineReady → the shell is cached; the app now works offline.
 *
 * The heavy parsing/analysis stays in the Web Worker (src/worker) untouched —
 * the SW only governs the static shell, not the hot data path.
 *
 * The `virtual:pwa-register` import is provided by vite-plugin-pwa at build time
 * (typed via vite-plugin-pwa/client in vite-env.d.ts).
 */
import { registerSW } from 'virtual:pwa-register';

/** Wire up the SW and the update banner. Safe no-op where SW is unsupported. */
export function initPwa(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    onNeedRefresh() {
      showBanner(
        'A new version is available.',
        'Refresh',
        () => void updateSW(true), // activate waiting SW + reload → fresh shell
      );
    },
    onOfflineReady() {
      showBanner('Ready to work offline.', 'Dismiss', removeBanner, 4000);
    },
    onRegisterError(err) {
      // Non-fatal: the app still runs from the network without the SW.
      console.warn('[pwa] SW registration failed', err);
    },
  });
}

// ── minimal, dependency-free update banner ────────────────────────────────────

let bannerEl: HTMLElement | null = null;
let autoTimer: ReturnType<typeof setTimeout> | null = null;

function removeBanner(): void {
  if (autoTimer !== null) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
  bannerEl?.remove();
  bannerEl = null;
}

function showBanner(
  message: string,
  actionLabel: string,
  onAction: () => void,
  autoDismissMs?: number,
): void {
  removeBanner();

  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:16px',
    'transform:translateX(-50%)',
    'z-index:9999',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'padding:8px 12px',
    'background:#1f242d',
    'color:#d7dde5',
    'border:1px solid #4fa3ff',
    'border-radius:8px',
    'box-shadow:0 8px 28px rgba(0,0,0,0.5)',
    'font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
  ].join(';');

  const text = document.createElement('span');
  text.textContent = message;

  const btn = document.createElement('button');
  btn.textContent = actionLabel;
  btn.style.cssText = [
    'background:#2a557f',
    'color:#d7dde5',
    'border:1px solid #4fa3ff',
    'border-radius:5px',
    'padding:4px 12px',
    'font:12px inherit',
    'cursor:pointer',
  ].join(';');
  btn.addEventListener('click', () => {
    onAction();
    removeBanner();
  });

  el.append(text, btn);
  document.body.appendChild(el);
  bannerEl = el;

  if (autoDismissMs) {
    autoTimer = setTimeout(removeBanner, autoDismissMs);
  }
}
