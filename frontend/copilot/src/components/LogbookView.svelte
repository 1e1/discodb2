<script lang="ts">
  /**
   * LOGBOOK viewer (DESIGN §3.3) — the copilot MIRRORS the cockpit's run read-only.
   * It never runs the engine: it renders the relayed state and may command
   * start/stop/next. When no run is live it shows the scenario PICKER (pick + start);
   * while running it shows the storyboard column with the current phase as a
   * progress-bar fill (animated LOCALLY from the phase duration), the next phase
   * pre-lit on the last 3 s, and auto-scroll keeping the current step 2nd from top.
   */
  import type { LbPhaseType, LogbookRelay } from "../protocol/logbook";

  interface Props {
    lb: LogbookRelay;
    onstart: (id: string) => void;
    onstop: () => void;
    onnext: () => void;
  }
  let { lb, onstart, onstop, onnext }: Props = $props();

  const PC: Record<LbPhaseType, string> = {
    baseline: "#4fa3ff",
    noise: "#e8c14a",
    stimulus: "#ff6b6b",
    observe: "#b58cff",
    recover: "#4cd07d",
    wait: "#5a6573",
  };

  let running = $derived(lb.status === "running" || lb.status === "leadin");

  // Local progress animation: a 100 ms tick + a per-transition anchor (reset when
  // the host bumps `seq`). The host owns completion; this only fills the bar smoothly.
  let nowMs = $state(0);
  let phaseStartMs = $state(0);
  $effect(() => {
    void lb.seq; // re-anchor on each relayed transition
    phaseStartMs = performance.now();
    nowMs = performance.now();
  });
  $effect(() => {
    const id = setInterval(() => (nowMs = performance.now()), 100);
    return () => clearInterval(id);
  });

  let cur = $derived(lb.phases[lb.phaseIndex] ?? null);
  let fill = $derived.by(() => {
    if (!cur || lb.status === "leadin") return 0;
    if (cur.onInput) return 0; // "on input" = a waiting moment, not a progress bar
    if (lb.awaitingInput) return 1;
    if (cur.durationS <= 0) return 0;
    return Math.min(1, Math.max(0, (nowMs - phaseStartMs) / 1000 / cur.durationS));
  });
  // "on input" steps show the pulsing ◉, never a countdown.
  let onInput = $derived(!!cur && (cur.onInput || lb.awaitingInput));
  let remaining = $derived(cur && !onInput ? Math.ceil(cur.durationS * (1 - fill)) : 0);
  let preWarn = $derived(!onInput && lb.status === "running" && remaining <= 3 && remaining > 0);

  // Auto-scroll: keep the current step 2nd from the top (previous step visible above).
  let listEl: HTMLElement | undefined = $state();
  let rowEls: HTMLElement[] = $state([]);
  $effect(() => {
    void lb.phaseIndex;
    const el = rowEls[lb.phaseIndex];
    const prev = rowEls[lb.phaseIndex - 1];
    if (el && listEl) listEl.scrollTo({ top: (prev ?? el).offsetTop - 8, behavior: "smooth" });
  });

  function startEntry(id: string) {
    onstart(id);
  }
</script>

<div class="lb">
  {#if running}
    <!-- HUD -->
    {#if lb.status === "leadin"}
      <div class="hud lead"><div class="leadnum">{lb.leadIn}</div><div class="leadtxt">Get set…</div></div>
    {:else if cur}
      <div class="hud" style="border-left:6px solid {PC[cur.type]};background:{PC[cur.type]}26">
        <div class="ptype" style="background:{PC[cur.type]}">{cur.type}{cur.rep ? " #" + cur.rep : ""}</div>
        <div class="pname">{cur.name}</div>
        {#if onInput}
          <div class="await"><span class="cppulse">◉</span> {lb.awaitingInput ? "do it now" : cur.name}</div>
        {:else}
          <div class="count">{remaining}s</div>
        {/if}
      </div>
    {/if}

    <!-- storyboard column (current = progress fill; auto-scrolls) -->
    <div class="story" bind:this={listEl}>
      {#each lb.phases as p, i (i)}
        <div
          class="row"
          class:current={i === lb.phaseIndex}
          class:past={i < lb.phaseIndex}
          class:prewarn={preWarn && i === lb.phaseIndex + 1}
          bind:this={rowEls[i]}
        >
          {#if i === lb.phaseIndex}
            {#if p.onInput}
              <!-- "on input" = waiting: pulse the WHOLE step background (same zone
                   the timer fill uses), so the active step itself breathes. -->
              <div class="fillbar pulsefill" style="background:{PC[p.type]}33"></div>
            {:else}
              <div class="fillbar" style="width:{fill * 100}%;background:{PC[p.type]}33"></div>
            {/if}
          {/if}
          <span class="dot" class:pulse={p.onInput} style="background:{PC[p.type]}"></span>
          <span class="rname">{p.name}</span>
          <span class="rtype">{p.type}{p.rep ? " #" + p.rep : ""}</span>
        </div>
      {/each}
    </div>

    <!-- controls -->
    <div class="ctrls">
      <button class="stop" onclick={() => onstop()}>■ Stop</button>
      {#if lb.awaitingInput}
        <button class="next" onclick={() => onnext()}>Next ▶</button>
      {/if}
    </div>
  {:else}
    <!-- PICKER (idle / armed / done / stopped) -->
    <div class="pickhead">
      <h2>Logbook</h2>
      <p class="sub">
        {#if lb.status === "done"}✓ last run complete · pick a scenario to run
        {:else if lb.status === "stopped"}■ last run stopped · pick a scenario to run
        {:else}Pick a scenario — the cockpit (driver) executes it.{/if}
      </p>
    </div>
    <div class="picklist">
      {#each lb.library as s (s.id)}
        <button class="pick" class:armed={s.id === lb.scenarioId} onclick={() => startEntry(s.id)}>
          <span class="po">{s.objective}</span>
          <span class="pmeta">{s.phases} phases{s.done ? " · ✓" : ""}{s.id === lb.scenarioId ? " · armed" : ""}</span>
          <span class="pgo">▶</span>
        </button>
      {/each}
      {#if lb.library.length === 0}
        <p class="empty">No scenarios on the cockpit yet.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .lb {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    background: var(--bg, #0c0e12);
    padding: calc(12px + env(safe-area-inset-top)) 14px calc(14px + env(safe-area-inset-bottom));
    gap: 12px;
  }
  .hud {
    border-radius: 16px;
    padding: 16px 18px;
    background: var(--panel, #161b22);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hud.lead { align-items: center; }
  .leadnum { font-size: 64px; font-weight: 900; line-height: 1; }
  .leadtxt { color: var(--muted, #8b93a1); }
  .ptype {
    align-self: flex-start;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #0c0e12;
    padding: 2px 8px;
    border-radius: 5px;
  }
  .pname { font-size: 1.5rem; font-weight: 800; }
  .count { font-size: 2.4rem; font-weight: 900; font-variant-numeric: tabular-nums; }
  .await { font-size: 1.4rem; font-weight: 800; color: var(--warn, #e8c14a); }

  .story {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 12px;
    border-radius: 12px;
    background: var(--panel, #161b22);
    overflow: hidden;
    opacity: 0.55;
  }
  .row.current { opacity: 1; outline: 1px solid rgba(255, 255, 255, 0.12); }
  .row.past { opacity: 0.3; }
  .row.prewarn { opacity: 0.85; outline: 1px dashed rgba(255, 255, 255, 0.25); }
  .fillbar { position: absolute; inset: 0 auto 0 0; transition: width 0.1s linear; }
  /* active "on input" step: the full-width fill breathes (the step waits for you). */
  .pulsefill { width: 100%; animation: fillpulse 1.2s ease-in-out infinite; }
  @keyframes fillpulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
  .dot { width: 12px; height: 12px; border-radius: 50%; flex: none; position: relative; }
  /* "on input" = a waiting moment: the dot pulses (mirrors the cockpit ◉ marker). */
  .dot.pulse, .cppulse { animation: pulse 1.1s ease-in-out infinite; }
  .cppulse { display: inline-block; }
  @keyframes pulse { 0%, 100% { opacity: 0.4; transform: scale(0.82); } 50% { opacity: 1; transform: scale(1.18); } }
  .rname { flex: 1; min-width: 0; font-weight: 700; position: relative; }
  .rtype { font-size: 12px; color: var(--muted, #8b93a1); text-transform: uppercase; position: relative; }

  .ctrls { display: flex; gap: 12px; }
  .ctrls button { flex: 1; min-height: 64px; border: none; border-radius: 16px; font-size: 1.2rem; font-weight: 800; }
  .stop { background: var(--bad, #b00020); color: #fff; }
  .next { background: var(--accent, #4fa3ff); color: #06121f; }

  .pickhead h2 { margin: 0; font-size: 1.6rem; }
  .pickhead .sub { margin: 4px 0 0; color: var(--muted, #8b93a1); }
  .picklist { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .pick {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    align-items: center;
    gap: 2px 12px;
    text-align: left;
    padding: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    background: var(--panel, #161b22);
    color: var(--fg, #fff);
  }
  .pick.armed { border-color: var(--accent, #4fa3ff); }
  .pick .po { grid-column: 1; grid-row: 1; font-size: 1.15rem; font-weight: 800; }
  .pick .pmeta { grid-column: 1; grid-row: 2; font-size: 12px; color: var(--muted, #8b93a1); }
  .pick .pgo { grid-column: 2; grid-row: 1 / span 2; font-size: 1.6rem; color: var(--accent, #4fa3ff); }
  .empty { color: var(--muted, #8b93a1); text-align: center; padding: 24px; }
</style>
