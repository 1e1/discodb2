// PWA registration + "new version → refresh" wiring (P2).
//
// Registers the static service worker (public/sw.js) and watches for a NEW
// build to install. When a fresh worker reaches the `waiting` state, we notify
// the app so it can show a one-tap "refresh" affordance — we never hot-swap the
// running code under the driver mid-glance.
//
// GRACEFUL DEGRADATION: service workers need a secure context (HTTPS or
// localhost). The in-car AP often serves plain HTTP on a LAN IP, where SW
// registration is simply unavailable — we detect that and no-op silently, so the
// app behaves exactly as before (the shell cache is a progressive enhancement,
// never a dependency). Likewise skipped in dev (import.meta.env.DEV).

export interface PwaHooks {
  /** Called when a new version is installed and waiting to take over. */
  onUpdateReady?: () => void;
}

let waitingWorker: ServiceWorker | null = null;
let reloading = false;

/** True where a service worker can actually register and run. */
function canUseServiceWorker(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    // Secure context (HTTPS) or localhost. Plain-HTTP LAN IPs return false.
    (typeof isSecureContext === "undefined" || isSecureContext)
  );
}

export function registerPwa(hooks: PwaHooks = {}): void {
  // Dev server owns the module graph; a SW would only get in the way.
  if (import.meta.env.DEV) return;
  if (!canUseServiceWorker()) return;

  // When the controller changes (after we tell the waiting worker to activate),
  // reload ONCE to pick up the new shell.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        // Already waiting (e.g. a prior tab installed it)?
        if (reg.waiting && navigator.serviceWorker.controller) {
          waitingWorker = reg.waiting;
          hooks.onUpdateReady?.();
        }
        // A new worker started installing → watch for it to finish.
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              // Controller present + a freshly installed worker waiting ⇒ update.
              waitingWorker = reg.waiting ?? installing;
              hooks.onUpdateReady?.();
            }
          });
        });
      })
      .catch(() => {
        /* registration failed (offline first load, etc.) — ignore */
      });
  });
}

/**
 * Apply a pending update: ask the waiting worker to take over. The
 * `controllerchange` listener above reloads the page once it does.
 */
export function applyPwaUpdate(): void {
  if (waitingWorker) {
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  } else {
    // No tracked waiting worker (edge cases) — a plain reload still recovers.
    location.reload();
  }
}
