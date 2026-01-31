// Screen Wake Lock (§7) — keep the phone awake hands-free while glancing.
//
// iOS Safari 16.4+ supports navigator.wakeLock. The lock is RELEASED by the OS
// whenever the page is hidden (screen off, tab switch, call), so it must be
// re-acquired on visibilitychange. We expose a tiny controller that:
//   • requests the lock,
//   • re-requests on return-to-visible,
//   • reports support + current held state via a callback.
//
// If unsupported (older iOS / Firefox without the flag), we degrade silently;
// the README documents the fallback (Auto-Lock off, or a Low Power Mode note).

type WakeLockSentinelLike = {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", cb: () => void): void;
};
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
};

export class WakeLockController {
  private sentinel: WakeLockSentinelLike | null = null;
  private want = false;
  private boundVisibility: () => void;
  readonly supported: boolean;

  /** @param onChange notified with (held) whenever the held state changes. */
  constructor(private onChange?: (held: boolean) => void) {
    this.supported =
      typeof navigator !== "undefined" &&
      "wakeLock" in navigator &&
      typeof (navigator as WakeLockNavigator).wakeLock?.request === "function";
    this.boundVisibility = () => this.onVisibility();
    document.addEventListener("visibilitychange", this.boundVisibility);
  }

  get held(): boolean {
    return !!this.sentinel && !this.sentinel.released;
  }

  /** Ask to keep the screen awake (idempotent). */
  async enable(): Promise<void> {
    this.want = true;
    await this.acquire();
  }

  /** Stop keeping the screen awake. */
  async disable(): Promise<void> {
    this.want = false;
    if (this.sentinel && !this.sentinel.released) {
      try {
        await this.sentinel.release();
      } catch {
        /* ignore */
      }
    }
    this.sentinel = null;
    this.onChange?.(false);
  }

  destroy(): void {
    document.removeEventListener("visibilitychange", this.boundVisibility);
    void this.disable();
  }

  private async acquire(): Promise<void> {
    if (!this.supported || !this.want) return;
    if (this.held) return;
    try {
      const nav = navigator as WakeLockNavigator;
      const s = await nav.wakeLock!.request("screen");
      this.sentinel = s;
      s.addEventListener("release", () => {
        // OS released it (page hidden / power). Reflect state; re-acquire on
        // return-to-visible handles the rest.
        this.onChange?.(false);
      });
      this.onChange?.(true);
    } catch {
      // Request can reject if not visible / not user-activated; try again on
      // the next visibility change.
      this.onChange?.(false);
    }
  }

  private onVisibility(): void {
    if (document.visibilityState === "visible" && this.want && !this.held) {
      void this.acquire();
    }
  }
}
