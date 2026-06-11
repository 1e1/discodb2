<script lang="ts">
  /**
   * MARKHUNT ("free-run / highlighter") workspace — the bottom-up sibling of the
   * Logbook storyboard (docs/markhunt-spec.md). Three phases in one view:
   *   1. PREPARE — name/color a few neutral LABELS (left → editor).
   *   2. RUN & PAINT — a warmup, then the labels become big toggle buttons; tap to
   *      start a span, tap to end it (one open at a time, non-overlapping, on the
   *      live backend-µs clock). Reuses the worker-owned ring (no separate record).
   *   3. ANNOTATE & ANALYZE — on the timeline, assign each span a TYPE and draw
   *      "≈" links, then analyze via the shared `analyzeFieldRun` (worker seam).
   *
   * Span windows are stamped on `$maxTUs` (the newest backend timestamp), exactly
   * like the Hunt captures, so they line up with the frames the worker holds.
   */
  import {
    maxTUs,
    project,
    selectedFieldRunId,
    newFieldRun,
    deleteFieldRun,
    mutateFieldRun,
    reorderFieldRun,
    addFinding,
    huntScan,
    excludedSlots,
  } from '../state/store';
  import {
    fieldRunToInput,
    newId,
    type MarkLabel,
    type SpanType,
  } from '../protocol/datamodel';
  import type { FieldRunResult, FieldRunCandidate } from '@shared/analysis/field-run.ts';
  import {
    ensureAudioReady,
    playStartBeep,
    playStopBeep,
    playBeep,
  } from '../hunt/cuePlayer';
  import { onDestroy } from 'svelte';

  // Commit-on-change helpers (Svelte template expressions don't take `as` casts).
  const evVal = (e: Event) => (e.target as HTMLInputElement).value;
  const evSel = (e: Event) => (e.target as HTMLSelectElement).value;

  // ── library (mirrors the Logbook Scenarios library: filter + sort + drag) ────
  $: runs = $project.fieldRuns ?? [];
  $: sel = runs.find((r) => r.id === $selectedFieldRunId) ?? null;
  let filter = '';
  let sort: 'manual' | 'name' | 'done' = 'manual';
  $: shown = (() => {
    let xs = runs.map((r, i) => ({ r, i })).filter((x) => x.r.objective.toLowerCase().includes(filter.toLowerCase()));
    if (sort === 'name') xs = [...xs].sort((a, b) => a.r.objective.localeCompare(b.r.objective));
    else if (sort === 'done') xs = [...xs].sort((a, b) => Number(a.r.done) - Number(b.r.done));
    return xs;
  })();
  let dragId: string | null = null;
  function onDrop(targetId: string) {
    if (dragId && dragId !== targetId) {
      reorderFieldRun(dragId, runs.findIndex((r) => r.id === targetId));
      if (sort !== 'manual') sort = 'manual';
    }
    dragId = null;
  }

  // ── label palette for "add label" ────────────────────────────────────────────
  const SWATCHES = ['#4fa3ff', '#ff6b6b', '#e8c14a', '#b58cff', '#4cd07d', '#5a6573'];
  function addLabel() {
    if (!sel) return;
    const color = SWATCHES[sel.labels.length % SWATCHES.length];
    mutateFieldRun(sel.id, (r) => r.labels.push({ id: newId('lbl'), name: `Label ${r.labels.length + 1}`, color }));
  }
  function delLabel(id: string) {
    if (!sel) return;
    mutateFieldRun(sel.id, (r) => {
      r.labels = r.labels.filter((l) => l.id !== id);
      // Orphaned spans (their label removed) are dropped too — keep the model consistent.
      r.spans = r.spans.filter((s) => s.labelId !== id);
    });
  }
  const labelOf = (id: string): MarkLabel | undefined => sel?.labels.find((l) => l.id === id);

  // ── RUN state machine: idle → warmup → recording → done ──────────────────────
  type RunStatus = 'idle' | 'warmup' | 'recording' | 'done';
  let status: RunStatus = 'idle';
  let runStartTUs = 0;
  let runEndTUs = 0;
  // The span currently being painted (open highlighter), or null.
  let openSpan: { labelId: string; startTUs: number } | null = null;

  let warmupSeconds = 3;
  let warmupCount = 0;
  let warmupTimer: ReturnType<typeof setInterval> | null = null;
  $: warming = warmupCount > 0;

  function clearWarmup() {
    if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = null; }
    warmupCount = 0;
  }
  function canRun(): boolean {
    return $maxTUs > 0 && !!sel && sel.labels.length > 0;
  }

  function startRun() {
    if (!canRun() || warming || status === 'recording') return;
    void ensureAudioReady();
    // Fresh run: clear prior spans so re-painting starts clean.
    mutateFieldRun(sel!.id, (r) => (r.spans = []));
    openSpan = null;
    const secs = Math.max(0, Math.floor(warmupSeconds));
    if (secs === 0) { beginRecording(); return; }
    status = 'warmup';
    warmupCount = secs;
    playBeep(660, 90, 'square');
    warmupTimer = setInterval(() => {
      warmupCount -= 1;
      if (warmupCount >= 1) playBeep(660, 90, 'square');
      else { clearWarmup(); beginRecording(); }
    }, 1000);
  }
  function beginRecording() {
    runStartTUs = $maxTUs;
    runEndTUs = $maxTUs;
    status = 'recording';
    playStartBeep();
  }

  /** Close the open span into a stored MarkSpan (guards a 0-length span). */
  function closeOpenSpan(now: number) {
    if (!openSpan || !sel) return;
    const start = openSpan.startTUs;
    const end = Math.max(now, start + 1);
    const labelId = openSpan.labelId;
    mutateFieldRun(sel.id, (r) => r.spans.push({ id: newId('span'), labelId, startTUs: start, endTUs: end }));
    openSpan = null;
    playStopBeep();
  }

  /**
   * Tap a label while recording: a re-tap of the OPEN label toggles its span off;
   * tapping a DIFFERENT label hands off (closes the current, opens the new) —
   * one span open at a time, never overlapping (Markhunt spec §5).
   */
  function onLabelTap(labelId: string) {
    if (status !== 'recording') return;
    const reTapSame = openSpan?.labelId === labelId;
    if (reTapSame) {
      closeOpenSpan($maxTUs); // toggle this span OFF
      return;
    }
    if (openSpan) closeOpenSpan($maxTUs); // hand off from the current span
    openSpan = { labelId, startTUs: $maxTUs };
    playStartBeep();
  }

  function stopRun() {
    if (status !== 'recording') return;
    if (openSpan) {
      const start = openSpan.startTUs;
      const labelId = openSpan.labelId;
      const end = Math.max($maxTUs, start + 1);
      mutateFieldRun(sel!.id, (r) => r.spans.push({ id: newId('span'), labelId, startTUs: start, endTUs: end }));
      openSpan = null;
    }
    runEndTUs = $maxTUs;
    status = 'done';
    playStopBeep();
  }

  // Keep the timeline's right edge advancing while recording (a cheap clock tick).
  $: if (status === 'recording') runEndTUs = $maxTUs;

  // ── annotation (Phase 3) ─────────────────────────────────────────────────────
  const SPAN_TYPES: { value: SpanType; label: string }[] = [
    { value: 'stable', label: 'stable (control)' },
    { value: 'rampUp', label: 'ramp ↑' },
    { value: 'rampDown', label: 'ramp ↓' },
    { value: 'level', label: 'held level' },
    { value: 'event', label: 'event (pulse)' },
    { value: 'ignore', label: 'ignore' },
  ];
  let selSpanId: string | null = null;
  let linkMode = false; // when on, clicking a span links it to the selected span
  $: selSpan = sel?.spans.find((s) => s.id === selSpanId) ?? null;

  // Auto-expand the FIRST span's parameter zone whenever the current selection
  // isn't valid (a fresh run, a new span appearing, the selected span deleted, or
  // switching runs). This makes the annotation UI discoverable without the
  // non-obvious "click a band first" step. Band clicks re-point it (never deselect),
  // so this never fights the operator.
  $: if (sel && sel.spans.length > 0 && !sel.spans.some((s) => s.id === selSpanId)) {
    selSpanId = sel.spans[0].id;
  }

  function pickSpan(id: string) {
    if (linkMode && selSpanId && id !== selSpanId) {
      toggleLink(selSpanId, id);
      return;
    }
    selSpanId = id; // always select (no toggle-off → the parameter zone stays open)
  }
  function setSpanType(id: string, type: SpanType) {
    if (!sel) return;
    mutateFieldRun(sel.id, (r) => {
      const s = r.spans.find((x) => x.id === id);
      if (s) s.type = type;
    });
  }
  /** From the <select> change event (the cast lives here, not in the template). */
  function setSpanTypeEv(id: string, e: Event) {
    setSpanType(id, evSel(e) as SpanType);
  }
  function toggleLink(aId: string, bId: string) {
    if (!sel) return;
    mutateFieldRun(sel.id, (r) => {
      const a = r.spans.find((x) => x.id === aId);
      if (!a) return;
      const list = new Set(a.equivalentTo ?? []);
      if (list.has(bId)) list.delete(bId);
      else list.add(bId);
      a.equivalentTo = [...list];
    });
  }
  function delSpan(id: string) {
    if (!sel) return;
    mutateFieldRun(sel.id, (r) => {
      r.spans = r.spans.filter((s) => s.id !== id);
      for (const s of r.spans) if (s.equivalentTo) s.equivalentTo = s.equivalentTo.filter((t) => t !== id);
    });
    if (selSpanId === id) selSpanId = null;
  }

  // ── analysis (Phase 4) ───────────────────────────────────────────────────────
  let result: FieldRunResult | null = null;
  let isExtMap: Record<number, boolean> = {};
  let analyzing = false;
  let promoted = new Set<string>();

  async function analyze() {
    if (!sel || sel.spans.length === 0) return;
    // Run bounds: the painted span extent (fallback to the recorded run bounds).
    let start = Infinity;
    let end = -Infinity;
    for (const s of sel.spans) { if (s.startTUs < start) start = s.startTUs; if (s.endTUs > end) end = s.endTUs; }
    if (!Number.isFinite(start)) { start = runStartTUs; end = runEndTUs; }
    analyzing = true;
    const r = await huntScan({
      kind: 'fieldRun',
      input: fieldRunToInput(sel),
      startTUs: start,
      endTUs: end,
      excluded: excludedSlots($project),
    });
    analyzing = false;
    if (r.kind !== 'fieldRun') return;
    result = r.result;
    isExtMap = r.isExtended;
    promoted = new Set();
  }

  function promote(c: FieldRunCandidate) {
    if (!sel) return;
    addFinding({
      id: newId('find'),
      name: sel.objective || 'signal',
      frameId: c.id,
      isExtended: isExtMap[c.id] ?? c.id > 0x7ff,
      byteIndex: c.byteIndex,
      bit: c.bit,
      status: 'hypothesis',
      excludeFromHunt: false,
      foundAt: new Date().toISOString(),
    });
    promoted = new Set([...promoted, c.key]);
  }

  onDestroy(clearWarmup);

  // ── render helpers ───────────────────────────────────────────────────────────
  const hexId = (id: number) => '0x' + id.toString(16).toUpperCase();
  function locus(c: FieldRunCandidate): string {
    if (c.bit !== undefined) return `byte${c.byteIndex} bit${c.bit}`;
    return `byte${c.byteIndex}${c.width === 16 ? `..${c.byteIndex + 1} ${c.byteOrder === 'little' ? 'LE' : 'BE'}` : ''}`;
  }
  // Timeline extent (start..end of the run span). While RECORDING it tracks the
  // live clock (`runEndTUs`, kept = $maxTUs below) so the whole timeline grows
  // continuously — not only when a span is closed.
  $: span0 = (() => {
    if (!sel || sel.spans.length === 0) return { s: runStartTUs, e: Math.max(runEndTUs, runStartTUs + 1) };
    let s = Infinity, e = -Infinity;
    for (const sp of sel.spans) { if (sp.startTUs < s) s = sp.startTUs; if (sp.endTUs > e) e = sp.endTUs; }
    if (status === 'recording') e = Math.max(e, runEndTUs); // grow with the live clock
    return { s, e: Math.max(e, s + 1) };
  })();

  // Band geometry, computed REACTIVELY: a Svelte template can't see that an inline
  // `pct()` call depends on `span0`/$maxTUs, so positions would freeze between
  // span closes. Referencing span0 (and $maxTUs for the open band) here makes the
  // timeline redraw on every clock tick (draw-as-you-go).
  $: bands = (() => {
    const { s, e } = span0;
    const range = e - s;
    return sel
      ? sel.spans.map((sp) => {
          const lab = labelOf(sp.labelId);
          return {
            id: sp.id,
            left: (100 * (sp.startTUs - s)) / range,
            width: Math.max(0.5, (100 * (sp.endTUs - sp.startTUs)) / range),
            color: lab?.color ?? '#888',
            name: lab?.name ?? '?',
            type: sp.type,
          };
        })
      : [];
  })();
  $: openBand = (() => {
    if (!openSpan) return null;
    const { s, e } = span0;
    const range = e - s;
    const now = $maxTUs;
    const lab = labelOf(openSpan.labelId);
    return {
      left: (100 * (openSpan.startTUs - s)) / range,
      width: Math.max(0.5, (100 * (now - openSpan.startTUs)) / range),
      color: lab?.color ?? '#888',
    };
  })();
</script>

<div class="markhunt">
  <!-- LIBRARY (same chrome as the Logbook Scenarios list; the sub-tab already
       names this column, so its header is a description, not a redundant title) -->
  <aside class="library">
    <div class="head"><span class="cap">free-run highlighter recordings</span></div>
    <div class="tools">
      <input class="filter" placeholder="filter…" bind:value={filter} spellcheck="false" />
      <select bind:value={sort}><option value="manual">manual</option><option value="name">name</option><option value="done">status</option></select>
      <button class="icon" title="new field run" on:click={() => newFieldRun()}>＋</button>
    </div>
    <div class="list">
      {#each shown as { r } (r.id)}
        <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
        <div
          class="scn"
          class:on={r.id === $selectedFieldRunId}
          draggable="true"
          on:click={() => selectedFieldRunId.set(r.id)}
          on:dragstart={() => (dragId = r.id)}
          on:dragover|preventDefault
          on:drop|preventDefault={() => onDrop(r.id)}
        >
          <input type="checkbox" class="check" checked={r.done} on:click|stopPropagation on:change={() => mutateFieldRun(r.id, (x) => (x.done = !x.done))} />
          <div class="meta">
            <div class="obj">{r.objective}</div>
            <div class="sub">{r.labels.length} labels · {r.spans.length} spans{r.done ? ' · ✓ fulfilled' : ''}</div>
          </div>
          <button class="del" title="delete" on:click|stopPropagation={() => deleteFieldRun(r.id)}>×</button>
        </div>
      {/each}
      {#if runs.length === 0}
        <div class="empty">No field runs — press ＋ to start one.</div>
      {/if}
    </div>
  </aside>

  <!-- WORKSPACE -->
  <section class="work">
    {#if !sel}
      <div class="empty big">Select a field run, or press ＋ New. Then prepare labels, run &amp; paint, annotate, analyze.</div>
    {:else}
      <div class="objbar">
        <input class="obj" value={sel.objective} on:change={(e) => mutateFieldRun(sel.id, (r) => (r.objective = evVal(e)))} />
        <label class="done"><input type="checkbox" checked={sel.done} on:change={() => mutateFieldRun(sel.id, (r) => (r.done = !r.done))} /> done</label>
      </div>

      <!-- PHASE 1/2 — labels + run controls -->
      <div class="block">
        <div class="rhead">Labels &amp; run</div>
        <div class="labels">
          {#each sel.labels as l (l.id)}
            <div class="labelrow">
              <input class="swatch" type="color" value={l.color} on:input={(e) => mutateFieldRun(sel.id, (r) => { const x = r.labels.find((y) => y.id === l.id); if (x) x.color = evVal(e); })} />
              <input class="lname" value={l.name} on:change={(e) => mutateFieldRun(sel.id, (r) => { const x = r.labels.find((y) => y.id === l.id); if (x) x.name = evVal(e); })} />
              <button class="del" title="remove label" on:click={() => delLabel(l.id)} disabled={status === 'recording'}>×</button>
            </div>
          {/each}
          <button class="addlbl" on:click={addLabel} disabled={status === 'recording'}>＋ label</button>
        </div>

        <div class="controls run">
          {#if status === 'idle' || status === 'done'}
            <button class="primary" on:click={startRun} disabled={!canRun() || warming}>▶ {status === 'done' ? 'Re-run' : 'Start run'}</button>
            <label title="lead-in countdown before the run starts (Logbook-style); 0 = immediate">warmup<input class="num" type="number" min="0" step="1" bind:value={warmupSeconds} />s</label>
            {#if warming}<span class="capturing">● warmup… {warmupCount}</span>{/if}
            {#if !canRun() && !warming}<span class="dim small">connect + buffer traffic, add a label, then run</span>{/if}
          {:else if status === 'warmup'}
            <span class="capturing">● warmup… {warmupCount}</span>
          {:else}
            <button class="stop" on:click={stopRun}>■ Stop run</button>
            <span class="capturing">● recording — tap a label to paint</span>
          {/if}
        </div>

        {#if status === 'recording'}
          <div class="painter">
            {#each sel.labels as l (l.id)}
              <button class="bigbtn" class:active={openSpan?.labelId === l.id} style="--c:{l.color}" on:click={() => onLabelTap(l.id)}>
                {l.name}{#if openSpan?.labelId === l.id} ●{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- PHASE 3 — timeline + annotation -->
      {#if sel.spans.length > 0 || status === 'recording'}
        <div class="block">
          <div class="rhead">Timeline — {sel.spans.length} span(s){linkMode ? ' · ≈ link mode: click a span to link' : ''}</div>
          <div class="track">
            {#each bands as b (b.id)}
              <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
              <div
                class="band"
                class:sel={selSpanId === b.id}
                style="left:{b.left}%;width:{b.width}%;background:{b.color}"
                title="{b.name} · {b.type ?? 'untyped'}"
                on:click={() => pickSpan(b.id)}
              ></div>
            {/each}
            {#if openBand}
              <div class="band open" style="left:{openBand.left}%;width:{openBand.width}%;background:{openBand.color}"></div>
            {/if}
          </div>

          {#if selSpan}
            {@const lab = labelOf(selSpan.labelId)}
            <div class="annot">
              <span class="chip" style="background:{lab?.color ?? '#888'}">{lab?.name ?? '?'}</span>
              <label>type
                <select value={selSpan.type ?? ''} on:change={(e) => setSpanTypeEv(selSpan.id, e)}>
                  <option value="" disabled>— pick —</option>
                  {#each SPAN_TYPES as t}<option value={t.value}>{t.label}</option>{/each}
                </select>
              </label>
              <button class:primary={linkMode} on:click={() => (linkMode = !linkMode)} title="link this span to another (≈ same value)">≈ link</button>
              {#each selSpan.equivalentTo ?? [] as tId}
                {@const t = sel.spans.find((x) => x.id === tId)}
                <span class="badge syn" title="asserted to hold the same value">≈ {labelOf(t?.labelId ?? '')?.name ?? '?'}<button class="x" on:click={() => toggleLink(selSpan.id, tId)}>×</button></span>
              {/each}
              <span class="spacer"></span>
              <button class="del" title="delete span" on:click={() => delSpan(selSpan.id)}>× delete</button>
            </div>
          {/if}

          <div class="controls">
            <button class="primary" on:click={analyze} disabled={analyzing || sel.spans.length === 0}>{analyzing ? 'Analyzing…' : '⌕ Analyze'}</button>
            {#if result}<span class="dim small">{result.framesAnalyzed} frames · {result.questionsRun.join(', ') || 'no questions'}</span>{/if}
          </div>
        </div>
      {/if}

      <!-- PHASE 4 — results -->
      {#if result}
        <div class="block">
          <div class="rhead">Candidates ({result.candidates.length})</div>
          {#if result.note}<div class="note small">{result.note}</div>{/if}
          {#each result.candidates as c (c.key)}
            <div class="cand">
              <span class="loc">{hexId(c.id)} · {locus(c)}</span>
              <div class="bar"><div class="fill" style="width:{Math.min(100, c.score * 100).toFixed(0)}%"></div></div>
              <span class="badge {c.passesControl ? 'ok' : 'bad'}">{c.passesControl ? 'control✓' : 'confounded'}</span>
              {#each c.sources as s}<span class="badge t">{s}</span>{/each}
              <span class="rat dim" title={c.rationale}>{c.rationale}</span>
              <button class="promote" class:done={promoted.has(c.key)} on:click={() => promote(c)}>{promoted.has(c.key) ? '✓ added' : '＋ finding'}</button>
            </div>
          {/each}
          {#if result.candidates.length === 0}
            <div class="empty small">No candidate — try assigning span types (ramp/level/event) or an ≈ link, then re-analyze.</div>
          {/if}
          <div class="note small">Promoted candidates land in the <strong>Findings</strong> tab (the shared knowledge base).</div>
        </div>
      {/if}
    {/if}
  </section>
</div>

<style>
  .markhunt { display: flex; height: 100%; min-height: 0; font-size: 13px; }
  /* Library header: a fixed-height bar like the Explore .colhead — a dim caption
     describing the items (the sub-tab already supplies the noun), not a title. */
  .head { display: flex; align-items: center; height: 30px; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--bg-elev2); }
  .head .cap { font-size: 11px; color: var(--text-dim); }
  .small { font-size: 11px; }

  .library { width: 230px; flex: none; border-right: 1px solid var(--border); background: var(--bg-elev); display: flex; flex-direction: column; min-height: 0; }
  .tools { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border); }
  .tools .filter { flex: 1; min-width: 0; }
  .icon { flex: none; }
  .list { overflow: auto; flex: 1; }
  .scn { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #161b22; cursor: grab; }
  .scn:hover { background: var(--bg-elev2); }
  .scn.on { background: var(--accent-dim); }
  .scn .obj { font-weight: 600; font-size: 12px; }
  .scn .sub { font-size: 10px; color: var(--text-dim); }
  .scn .del { visibility: hidden; }
  .scn:hover .del { visibility: visible; }
  .check { width: 15px; height: 15px; cursor: pointer; }
  .del { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 13px; }
  .del:hover { color: var(--text); }
  .empty { padding: 14px; color: var(--text-dim); font-size: 12px; text-align: center; }
  .empty.big { margin: auto; max-width: 360px; }

  .work { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; overflow: auto; padding-bottom: 16px; }
  .objbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .objbar .obj { flex: 1; background: transparent; border: none; border-bottom: 1px dashed var(--border); color: var(--text); font-size: 15px; font-weight: 600; padding: 2px 0; }
  .objbar .obj:focus { outline: none; border-bottom-color: var(--accent); }
  .done { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); }

  .block { margin: 10px 14px; }
  .rhead { font-size: 11px; letter-spacing: .04em; color: var(--text-dim); text-transform: uppercase; padding: 6px 0; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
  .note { color: var(--text-dim); margin: 4px 0; }

  .labels { display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px; }
  .labelrow { display: flex; align-items: center; gap: 8px; }
  .swatch { width: 28px; height: 24px; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: none; cursor: pointer; }
  .lname { flex: 0 0 200px; }
  .addlbl { align-self: flex-start; font-size: 12px; color: var(--accent); background: none; border: 1px dashed var(--accent-dim); }

  .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
  .controls label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); }
  .num { width: 50px; }
  .capturing { color: var(--warn); font-weight: 600; animation: cap 1s steps(2, start) infinite; }
  @keyframes cap { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

  .painter { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
  .bigbtn {
    flex: 1 1 140px; min-height: 64px; font-size: 16px; font-weight: 700;
    border: 2px solid var(--c); color: var(--text); background: color-mix(in srgb, var(--c) 14%, transparent);
    border-radius: var(--radius-lg); cursor: pointer;
  }
  .bigbtn:hover:not(:disabled) { background: color-mix(in srgb, var(--c) 26%, transparent); }
  .bigbtn.active { background: var(--c); color: #0c0e12; box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 40%, transparent); }

  .track { position: relative; height: 44px; border-radius: var(--radius-md); overflow: hidden; background: #0c0e12; margin-bottom: 8px; }
  .band { position: absolute; top: 0; bottom: 0; cursor: pointer; opacity: 0.8; }
  .band:hover { opacity: 1; }
  .band.sel { outline: 2px solid #fff; outline-offset: -2px; z-index: 2; }
  .band.open { opacity: 0.55; animation: cap 1s steps(2, start) infinite; pointer-events: none; }

  .annot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-elev); margin-bottom: 8px; }
  .annot label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); }
  .chip { font-size: 10px; font-weight: 800; color: #0c0e12; padding: 2px 7px; border-radius: var(--radius-sm); }
  .badge .x { background: none; border: none; color: inherit; cursor: pointer; padding: 0 0 0 4px; font-size: 11px; }
  .spacer { flex: 1; }

  .cand { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: 4px; background: var(--bg-elev); }
  .cand .loc { font-family: var(--mono); font-size: 11px; color: var(--accent); flex: none; min-width: 130px; }
  .bar { width: 80px; height: 8px; background: var(--bg); border-radius: var(--radius-sm); overflow: hidden; flex: none; }
  .fill { height: 100%; background: var(--accent); }
  .cand .rat { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .promote { background: var(--bg-elev2); border: 1px solid var(--accent-dim); color: var(--accent); flex: none; }
  .promote.done { color: var(--ok); }
</style>
