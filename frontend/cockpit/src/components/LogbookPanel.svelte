<script lang="ts">
  /**
   * LOGBOOK ("carnet de chasse") workspace — the 3rd top-level mode. PHASE 4a:
   * the AUTHORING half — a scenario LIBRARY (left) + the storyboard EDITOR
   * (middle), both bound to `project.scenarios` via the store CRUD. The fixed
   * experiment skeleton (baseline → noise → wait → loop → recover) is enforced by
   * the data model: the four outer steps only expose their DURATION; only the
   * LOOP's steps can be added / removed / reordered, any type.
   *
   * A phase-timeline preview reads `scenarioPhases`. The RUN engine (real timers +
   * audio + window stamping → analyzeRun via the swappable seam), the Results and
   * the Findings are PHASE 4b — a placeholder marks where they plug in.
   *
   * Text edits commit on `change` (blur) so the store update never steals the
   * caret mid-typing.
   */
  import { onDestroy, onMount } from 'svelte';
  import {
    project,
    selectedScenarioId,
    newScenario,
    deleteScenario,
    mutateScenario,
    reorderScenario,
    addFinding,
    onLogbookCmd,
    sendLogbook,
  } from '../state/store';
  import { scenarioPhases, newId, type LogbookPhase, type LogbookScenario } from '../protocol/datamodel';
  import { createRunController } from '../logbook/runController';
  import { fetchLogbookDetail, type AnalyzedCandidate, type LogbookDetail } from '../logbook/analysis';
  import { knownSignalsAt } from '../logbook/synonyms';

  const PC: Record<LogbookPhase, string> = {
    baseline: '#4fa3ff',
    noise: '#e8c14a',
    stimulus: '#ff6b6b',
    observe: '#b58cff',
    recover: '#4cd07d',
    wait: '#5a6573',
  };
  const ADD_TYPES: LogbookPhase[] = ['stimulus', 'observe', 'noise', 'wait', 'baseline', 'recover'];
  /** Locked outer steps (typed keys → `sel[key]` needs no cast in the template). */
  const OUTER = ['baseline', 'noise', 'wait'] as const;

  $: scenarios = $project.scenarios ?? [];
  $: sel = scenarios.find((s) => s.id === $selectedScenarioId) ?? null;

  // ── library ──────────────────────────────────────────────────────────────
  let filter = '';
  let sort: 'manual' | 'name' | 'done' = 'manual';
  $: shown = (() => {
    let xs = scenarios.map((s, i) => ({ s, i })).filter((x) => x.s.objective.toLowerCase().includes(filter.toLowerCase()));
    if (sort === 'name') xs = [...xs].sort((a, b) => a.s.objective.localeCompare(b.s.objective));
    else if (sort === 'done') xs = [...xs].sort((a, b) => Number(a.s.done) - Number(b.s.done));
    return xs;
  })();

  let dragId: string | null = null;
  function onDrop(targetId: string) {
    if (dragId && dragId !== targetId) {
      const to = scenarios.findIndex((s) => s.id === targetId);
      reorderScenario(dragId, to);
    }
    dragId = null;
    if (sort !== 'manual') sort = 'manual';
  }

  // ── editor edits (commit on change) ────────────────────────────────────────
  const D: Record<LogbookPhase, [string, number]> = {
    baseline: ['Baseline', 15],
    noise: ['Noise', 20],
    stimulus: ['Action', 3],
    observe: ['After-effect', 5],
    recover: ['Recover', 8],
    wait: ['Wait', 5],
  };
  function addStep(type: LogbookPhase) {
    if (!sel) return;
    const [name, durationS] = D[type];
    mutateScenario(sel.id, (s) => s.loop.steps.push({ type, name, durationS, advance: type === 'stimulus' ? 'input' : 'timer' }));
    addOpen = false;
  }
  function delStep(i: number) {
    if (!sel) return;
    mutateScenario(sel.id, (s) => {
      if (s.loop.steps.length > 1) s.loop.steps.splice(i, 1);
    });
  }
  function toggleAdvance(i: number) {
    if (!sel) return;
    mutateScenario(sel.id, (s) => {
      const st = s.loop.steps[i];
      st.advance = st.advance === 'input' ? 'timer' : 'input';
    });
  }
  function moveStep(from: number, to: number) {
    if (!sel || from === to) return;
    mutateScenario(sel.id, (s) => {
      const [m] = s.loop.steps.splice(from, 1);
      s.loop.steps.splice(to, 0, m);
    });
  }
  let stepDrag: number | null = null;
  let addOpen = false;

  const num = (e: Event) => Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1));
  const str = (e: Event) => (e.target as HTMLInputElement).value;

  // ── RUN (4b): controller wires the pure engine to timers + audio + the seam ──
  const run = createRunController();
  const runState = run.state;
  const runResult = run.result;
  const analyzing = run.analyzing;
  let muted = false;
  function toggleMute() { muted = !muted; run.audio.setMuted(muted); }
  onDestroy(() => {
    run.dispose();
    sendLogbook({ status: 'off' }); // tell viewers the Logbook session ended
  });

  // ── §3.3 relay: broadcast the run state to copilots; accept their commands ──
  // The cockpit is the HOST: it owns the run and fans a SNAPSHOT to viewers on each
  // meaningful change (status / phase / lead-in / awaiting / selection / library) —
  // NOT every elapsed tick (viewers animate the current phase locally from its
  // duration). A monotonic `seq` lets the viewer cue on each transition.
  function buildRelay(rs: typeof $runState, seq: number) {
    return {
      status: rs.status,
      seq,
      leadIn: rs.leadIn,
      phaseIndex: rs.phaseIndex,
      awaitingInput: rs.awaitingInput,
      rep: rs.rep,
      remainingS: Math.round(rs.remainingS),
      nextLabel: rs.nextLabel,
      scenarioId: sel?.id ?? null,
      objective: sel?.objective ?? '',
      phases: runPhases.map((p) => ({ type: p.type, name: p.name, durationS: p.durationS, rep: p.rep, onInput: p.advance === 'input' })),
      library: scenarios.map((s) => ({ id: s.id, objective: s.objective, phases: scenarioPhases(s).length, done: s.done })),
    };
  }
  let lastSig = '';
  let seq = 0;
  $: {
    const rs = $runState;
    const sig = [rs.status, rs.phaseIndex, rs.awaitingInput, rs.leadIn, sel?.id ?? '', runPhases.length, scenarios.length, scenarios.map((s) => s.objective).join(',')].join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      seq += 1;
      sendLogbook(buildRelay(rs, seq));
    }
  }

  // Spacebar = the "choose when" trigger (mockup parity): start an armed/finished
  // run, or advance an awaiting "on input" phase. Ignored while typing in a field.
  function onKey(e: KeyboardEvent) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const st = $runState;
    if (st.status === 'running' && st.awaitingInput) { e.preventDefault(); run.next(); }
    else if (sel && (st.status === 'armed' || st.status === 'idle' || st.status === 'done' || st.status === 'stopped')) {
      e.preventDefault();
      run.start();
    }
  }

  onMount(() => {
    const offCmd = onLogbookCmd((m) => {
      if (m.command === 'start') {
        const scn = m.scenarioId ? scenarios.find((s) => s.id === m.scenarioId) : sel;
        if (scn) { selectedScenarioId.set(scn.id); run.arm(scn); run.start(); }
      } else if (m.command === 'stop') run.stop();
      else if (m.command === 'next') run.next();
    });
    window.addEventListener('keydown', onKey);
    return () => {
      offCmd();
      window.removeEventListener('keydown', onKey);
    };
  });

  // Arm the controller whenever the selected scenario's CONTENT changes (we key on
  // the object identity — `mutateScenario` swaps in a fresh object on every edit —
  // so an edited duration / loop is picked up; START then runs what you SEE, not a
  // stale pre-edit copy). Never mid-run (the guard) so a live run is never reset.
  let armedScn: LogbookScenario | null = null;
  $: if (sel && sel !== armedScn && $runState.status !== 'running' && $runState.status !== 'leadin') {
    armedScn = sel;
    run.arm(sel);
  }

  // "on input" steps carry NO duration: they render as a fixed-width pulsing ◉
  // marker (INPUT_W px), excluded from the duration total + the playhead math.
  const INPUT_W = 30; // px — keep in sync with `.inputband` flex-basis
  const pdur = (p: { advance: 'timer' | 'input'; durationS: number }): number => (p.advance === 'input' ? 0 : p.durationS);

  $: runPhases = sel ? scenarioPhases(sel) : [];
  $: totalNom = runPhases.reduce((a, p) => a + pdur(p), 0) || 1; // sum of TIMER durations
  $: nInput = runPhases.filter((p) => p.advance === 'input').length;

  // The track is a flex row: timer bands GROW by their duration; input bands are a
  // fixed INPUT_W px. The playhead thus lives in a mixed px/% space — position it
  // with calc() so it stays aligned with the rendered bands (no overflow shrink).
  function playheadLeft(st: typeof $runState, phs: typeof runPhases, total: number, nIn: number): string {
    if (st.phaseIndex < 0) return st.status === 'done' ? '100%' : '0px';
    let timerAcc = 0;
    let inputBefore = 0;
    for (let i = 0; i < st.phaseIndex && i < phs.length; i++) {
      if (phs[i].advance === 'input') inputBefore += 1;
      else timerAcc += phs[i].durationS;
    }
    const cur = phs[st.phaseIndex];
    if (cur && cur.advance !== 'input') timerAcc += Math.min(st.elapsedS, cur.durationS);
    const frac = Math.min(1, timerAcc / total);
    return `calc(${inputBefore * INPUT_W}px + (100% - ${nIn * INPUT_W}px) * ${frac})`;
  }
  $: phLeft = playheadLeft($runState, runPhases, totalNom, nInput);
  // True while the run sits on an "on input" step — the playhead is hidden then.
  $: onInputActive = $runState.status === 'running' && $runState.phase?.advance === 'input';

  // ── results → findings ───────────────────────────────────────────────────
  const hexId = (id: number, ext: boolean) => '0x' + id.toString(16).toUpperCase().padStart(ext ? 8 : 3, '0');
  const loc = (c: { frameId: number; isExtended: boolean; byteIndex: number; bit?: number }) =>
    `${hexId(c.frameId, c.isExtended)} · B${c.byteIndex}${c.bit != null ? '.' + c.bit : ''}`;

  $: findings = $project.findings ?? [];

  // ── synonyms (positional DBC lookup) + replay (worker trace overlay) ────────
  /** Project signals already covering a candidate's slot (the "known signal" hint). */
  const posSyn = (c: AnalyzedCandidate): string[] =>
    knownSignalsAt($project, c.frameId, c.byteIndex, c.bit, c.bitLength);

  // The actual run windows (real µs) are the replay timeline — they carry the
  // stimulus onsets the trace must visibly line up with.
  $: runWindows = $runState.windows;
  $: runSpan = (() => {
    if (!runWindows.length) return null;
    let s = Infinity;
    let e = -Infinity;
    for (const w of runWindows) { if (w.startTUs < s) s = w.startTUs; if (w.endTUs > e) e = w.endTUs; }
    return { s, e, span: Math.max(1, e - s) };
  })();

  let selKey: string | null = null;
  let detail: LogbookDetail | null = null;
  let loadingDetail = false;

  async function selectCand(c: AnalyzedCandidate) {
    if (selKey === c.key) { selKey = null; detail = null; return; } // toggle off
    selKey = c.key;
    detail = null;
    if (!runSpan) return;
    // Synonym targets = the run's OTHER candidates + the known findings.
    const others = ($runResult?.candidates ?? [])
      .filter((o) => o.key !== c.key)
      .map((o) => ({ frameId: o.frameId, byteIndex: o.byteIndex, bit: o.bit, name: loc(o) }));
    for (const f of findings) others.push({ frameId: f.frameId, byteIndex: f.byteIndex, bit: f.bit, name: f.name });
    loadingDetail = true;
    const d = await fetchLogbookDetail(
      { frameId: c.frameId, byteIndex: c.byteIndex, bit: c.bit },
      others,
      { startTUs: runSpan.s, endTUs: runSpan.e },
    );
    loadingDetail = false;
    if (selKey === c.key) detail = d; // ignore a stale response if the selection changed
  }

  /** Step-line points (SVG viewBox 0..100) for the selected candidate's trace. */
  function tracePoints(d: LogbookDetail, start: number, span: number): string {
    const { tUs, values } = d.trace;
    if (!tUs.length) return '';
    const range = d.max - d.min || 1;
    const x = (t: number) => (((t - start) / span) * 100).toFixed(2);
    const y = (v: number) => (95 - ((v - d.min) / range) * 90).toFixed(2);
    let pts = `${x(tUs[0])},${y(values[0])}`;
    for (let i = 1; i < tUs.length; i++) pts += ` ${x(tUs[i])},${y(values[i - 1])} ${x(tUs[i])},${y(values[i])}`;
    pts += ` 100,${y(values[values.length - 1])}`; // hold to the end of the run
    return pts;
  }

  function promote(c: AnalyzedCandidate) {
    const beh = selKey === c.key && detail ? detail.synonyms.map((s) => s.name).filter((n): n is string => !!n) : [];
    const synonyms = [...new Set([...posSyn(c), ...beh])];
    addFinding({
      id: newId('find'),
      name: sel ? sel.objective : 'signal',
      frameId: c.frameId,
      isExtended: c.isExtended,
      byteIndex: c.byteIndex,
      bit: c.bit,
      kind: c.responseType,
      status: 'hypothesis',
      excludeFromHunt: false,
      scenarioId: sel?.id,
      foundAt: new Date().toISOString(),
      synonyms,
    });
  }
</script>

<div class="logbook">
  <!-- LIBRARY -->
  <aside class="library">
    <div class="head"><span class="cap">scripted stimulus–response experiments</span></div>
    <div class="tools">
      <input class="filter" placeholder="filter…" bind:value={filter} />
      <select bind:value={sort}><option value="manual">manual</option><option value="name">name</option><option value="done">status</option></select>
      <button class="icon" title="new scenario" on:click={() => newScenario()}>＋</button>
    </div>
    <div class="list">
      {#each shown as { s } (s.id)}
        <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
        <div
          class="scn"
          class:on={s.id === $selectedScenarioId}
          draggable="true"
          on:click={() => selectedScenarioId.set(s.id)}
          on:dragstart={() => (dragId = s.id)}
          on:dragover|preventDefault
          on:drop|preventDefault={() => onDrop(s.id)}
        >
          <input
            type="checkbox"
            class="check"
            checked={s.done}
            on:click|stopPropagation
            on:change={() => mutateScenario(s.id, (x) => (x.done = !x.done))}
          />
          <div class="meta">
            <div class="obj">{s.objective}</div>
            <div class="sub">{scenarioPhases(s).length} phases{s.done ? ' · ✓ fulfilled' : ''}</div>
          </div>
          <button class="del" title="delete" on:click|stopPropagation={() => deleteScenario(s.id)}>×</button>
        </div>
      {/each}
      {#if shown.length === 0}
        <div class="empty">No scenarios — press ＋ to create one.</div>
      {/if}
    </div>
  </aside>

  <!-- EDITOR -->
  <section class="editor">
    {#if !sel}
      <div class="empty big">Select a scenario, or press ＋ to create one.</div>
    {:else}
      <div class="objbar">
        <div class="lbl">OBJECTIVE</div>
        <div class="objrow">
          <input class="obj" value={sel.objective} on:change={(e) => mutateScenario(sel.id, (s) => (s.objective = str(e)))} />
          <label class="done"><input type="checkbox" class="check" checked={sel.done} on:change={() => mutateScenario(sel.id, (s) => (s.done = !s.done))} /> done</label>
        </div>
      </div>

      <div class="steps">
        <!-- locked outer steps (duration editable only) -->
        {#each OUTER as key (key)}
          <div class="step locked">
            <span class="bar" style="background:{PC[sel[key].type]}"></span>
            <span class="ptype" style="background:{PC[sel[key].type]}">{sel[key].type}</span>
            <span class="nm">{sel[key].name}</span>
            <span class="dur"><input type="number" min="1" value={sel[key].durationS} on:change={(e) => mutateScenario(sel.id, (s) => (s[key].durationS = num(e)))} /> s</span>
            <span class="lock" title="fixed experiment step">🔒</span>
          </div>
        {/each}

        <!-- editable loop -->
        <div class="loop">
          <div class="loophead">
            ⟳ Loop ×<input type="number" min="1" value={sel.loop.count} on:change={(e) => mutateScenario(sel.id, (s) => (s.loop.count = num(e)))} /> — add / drag-reorder any step
          </div>
          {#each sel.loop.steps as st, i (i)}
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              class="step"
              on:dragover|preventDefault
              on:drop|preventDefault={() => { if (stepDrag !== null) moveStep(stepDrag, i); stepDrag = null; }}
            >
              <span class="grip" draggable="true" title="drag to reorder" on:dragstart={() => (stepDrag = i)}>⠿</span>
              <span class="bar" style="background:{PC[st.type]}"></span>
              <span class="ptype" style="background:{PC[st.type]}">{st.type}</span>
              {#if st.type === 'stimulus'}
                <input class="nm edit" value={st.name} on:change={(e) => mutateScenario(sel.id, (s) => (s.loop.steps[i].name = str(e)))} />
              {:else}
                <span class="nm">{st.name}</span>
              {/if}
              {#if st.advance === 'input'}
                <button class="advance input" title="advances on operator input — click for a timer" on:click={() => toggleAdvance(i)}><span class="pulse">◉</span> on input</button>
              {:else}
                <span class="dur"><input type="number" min="1" value={st.durationS} on:change={(e) => mutateScenario(sel.id, (s) => (s.loop.steps[i].durationS = num(e)))} /> s</span>
                <button class="advance" title="timer — click for ‘on input’" on:click={() => toggleAdvance(i)}>⏱</button>
              {/if}
              <button class="del" title="remove" on:click={() => delStep(i)}>×</button>
            </div>
          {/each}
          <div class="addwrap">
            <button class="addstep" on:click={() => (addOpen = !addOpen)}>＋ add step to loop</button>
            {#if addOpen}
              {#each ADD_TYPES as t}
                <button class="addchip" style="background:{PC[t]}" on:click={() => addStep(t)}>{t}</button>
              {/each}
            {/if}
          </div>
        </div>

        <!-- locked recover -->
        <div class="step locked">
          <span class="bar" style="background:{PC.recover}"></span>
          <span class="ptype" style="background:{PC.recover}">recover</span>
          <span class="nm">{sel.recover.name}</span>
          <span class="dur"><input type="number" min="1" value={sel.recover.durationS} on:change={(e) => mutateScenario(sel.id, (s) => (s.recover.durationS = num(e)))} /> s</span>
          <span class="lock" title="fixed experiment step">🔒</span>
        </div>
      </div>
    {/if}
  </section>

  <!-- RUN / RESULTS / FINDINGS (4b) -->
  <section class="preview">
    <div class="head">
      <span class="title">Run</span>
      {#if sel}
        <span class="dim small ell">{sel.objective}</span>
        <span class="spacer"></span>
        <button class="mute" title="mute audio cues" on:click={toggleMute}>{muted ? '🔇' : '🔊'}</button>
        {#if $runState.status === 'running' || $runState.status === 'leadin'}
          <button class="rbtn stop" on:click={() => run.stop()}>■ Stop</button>
          {#if $runState.awaitingInput}<button class="rbtn primary" on:click={() => run.next()}>Next ▶</button>{/if}
        {:else if $runState.status === 'done'}
          <!-- Restart sits where Stop was; re-runs from the top (3·2·1 → CONNECT). -->
          <button class="rbtn primary" on:click={() => run.start()}>↻ Restart</button>
        {:else}
          <button class="rbtn primary" on:click={() => run.start()}>▶ Start</button>
        {/if}
      {/if}
    </div>

    {#if !sel}
      <div class="empty big">Select a scenario to run it.</div>
    {:else}
      <div class="runbody">
        <!-- HUD -->
        {#if $runState.status === 'leadin'}
          <div class="hud lead"><div class="leadnum">{$runState.leadIn}</div><div class="leadtxt">Get set…</div></div>
        {:else if $runState.status === 'running' && $runState.phase}
          {@const p = $runState.phase}
          <div class="hud" style="border-left:5px solid {PC[p.type]};background:{PC[p.type]}1f">
            <div class="hudtop">
              <span class="ptype" style="background:{PC[p.type]}">{p.type}{p.rep ? ' #' + p.rep : ''}</span>
              <span class="pname">{p.name}</span>
              <span class="spacer"></span>
              {#if $runState.awaitingInput}
                <span class="big-cue"><span class="cppulse">◉</span> done — press <b>Next</b></span>
              {:else if p.advance === 'input'}
                <span class="big-cue"><span class="cppulse">◉</span> act now — {p.name}</span>
              {:else}
                <span class="count">{Math.ceil($runState.remainingS)}s</span>
              {/if}
            </div>
            <div class="hudnext">next: {$runState.nextLabel}</div>
          </div>
        {:else if $runState.status === 'done'}
          <div class="hud ok">✓ Run complete — {$runState.windows.length} windows captured</div>
        {:else if $runState.status === 'stopped'}
          <div class="hud bad">■ Stopped — partial run ({$runState.windows.length} windows)</div>
        {:else}
          <div class="hud armed">Armed — press <b>Start</b> when ready (a 3·2·1 lead-in gives you time to get set).</div>
        {/if}

        <!-- timeline + playhead. An "on input" step carries no duration, so the
             playhead (a linear position) is meaningless there: hide it and instead
             light up the active ◉ marker with a pulsing halo. -->
        <div class="track">
          {#each runPhases as p, i}
            {#if p.advance === 'input'}
              <div class="band inputband" class:active={$runState.status === 'running' && i === $runState.phaseIndex} style="background:{PC[p.type]};--halo:{PC[p.type]}" title="{p.type}{p.rep ? ' #' + p.rep : ''} · on input — awaits confirmation (no duration)"><span class="pulse">◉</span></div>
            {:else}
              <div class="band" style="flex:{p.durationS} 1 0;background:{PC[p.type]}" title="{p.type}{p.rep ? ' #' + p.rep : ''} · {p.durationS}s">{p.durationS >= 5 ? p.type : ''}</div>
            {/if}
          {/each}
          {#if ($runState.status === 'running' || $runState.status === 'done') && !onInputActive}
            <div class="playhead" style="left:{phLeft}"></div>
          {/if}
        </div>

        <!-- RESULTS -->
        {#if $analyzing}
          <div class="note">Analyzing the captured run…</div>
        {/if}
        {#if $runResult}
          <div class="block">
            <div class="rhead">Results — {$runResult.candidates.length} candidate(s) · {$runResult.framesAnalyzed} frames · {$runResult.mode}</div>
            {#if $runResult.note}<div class="note small">{$runResult.note}</div>{/if}
            {#each $runResult.candidates as c (c.key)}
              <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
              <div class="cand" class:sel={selKey === c.key} title="click to replay this candidate's trace" on:click={() => selectCand(c)}>
                <span class="loc">{loc(c)}</span>
                <span class="rat" title={c.rationale}>{c.rationale}</span>
                {#if $runResult.hardened}
                  <span class="badge {c.passesControl ? 'ok' : 'bad'}">{c.passesControl ? 'control✓' : 'confounded'}</span>
                  {#if c.responseType}<span class="badge t">{c.responseType}</span>{/if}
                  <span class="badge {c.significant ? 'ok' : 'bad'}">{c.significant ? 'sig' : 'chance?'}</span>
                {:else}
                  <span class="badge pend" title="negative control + significance need the worker analyzer">control —</span>
                {/if}
                {#each posSyn(c) as kn}<span class="badge syn" title="already a known signal at this slot (DBC)">≈ {kn}</span>{/each}
                <span class="score">{c.score.toFixed(2)}</span>
                <button class="promote" title="promote to a finding" on:click|stopPropagation={() => promote(c)}>＋</button>
              </div>
              {#if selKey === c.key}
                <div class="replay">
                  {#if loadingDetail}
                    <div class="note small">Loading replay…</div>
                  {:else if detail && runSpan}
                    {@const rs = runSpan}
                    <div class="rep-head">
                      <span>Replay — value across the run</span>
                      {#each detail.synonyms as s}
                        <span class="badge syn" title="behaves like this signal (Pearson r={s.correlation.toFixed(2)})">≈ {s.name ?? hexId(s.frameId, s.frameId > 0x7ff) + ' B' + s.byteIndex} ({s.correlation.toFixed(2)})</span>
                      {/each}
                    </div>
                    <div class="rep-track">
                      {#each runWindows as w}
                        <div class="rep-band" style="left:{(100 * (w.startTUs - rs.s)) / rs.span}%;width:{(100 * (w.endTUs - w.startTUs)) / rs.span}%;background:{PC[w.role]}" title="{w.role}{w.rep ? ' #' + w.rep : ''}"></div>
                      {/each}
                      <svg class="rep-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                        <polyline points={tracePoints(detail, rs.s, rs.span)} fill="none" stroke="#fff" stroke-width="1.5" vector-effect="non-scaling-stroke" />
                      </svg>
                    </div>
                    <div class="note small">{detail.trace.values.length} change-points · range {detail.min}–{detail.max} · the line should step in phase with the red stimulus bands.</div>
                  {:else}
                    <div class="note small">No trace — run a scenario on a live bus first.</div>
                  {/if}
                </div>
              {/if}
            {/each}
            {#if $runResult.candidates.length === 0}
              <div class="empty small">No candidate cleared the stimulus — the signal may not be on this bus (LIN / direct-wire / UDS-only).</div>
            {/if}
          </div>
        {/if}

        <!-- FINDINGS live in the dedicated Findings sub-tab now (the shared
             knowledge base); promoting a candidate sends it there. -->
        {#if findings.length > 0}
          <div class="note small">{findings.length} finding(s) — manage them in the <strong>Findings</strong> tab.</div>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .logbook { display: flex; height: 100%; min-height: 0; font-size: 13px; }
  .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg-elev2); }
  .head .title { font-weight: 600; }
  .head .cap { font-size: 11px; color: var(--text-dim); }
  .dim { color: var(--text-dim); } .small { font-size: 11px; }

  .library { width: 230px; flex: none; border-right: 1px solid var(--border); background: var(--bg-elev); display: flex; flex-direction: column; min-height: 0; }
  .tools { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border); }
  .tools .filter { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 4px 8px; color: var(--text); }
  .tools select { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text); }
  .icon { background: var(--bg-elev2); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-md); padding: 3px 9px; cursor: pointer; }
  .list { overflow: auto; flex: 1; }
  .scn { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #161b22; cursor: grab; }
  .scn:hover { background: var(--bg-elev2); }
  .scn.on { background: var(--accent-dim); }
  .scn .obj { font-weight: 600; font-size: 12px; }
  .scn .sub { font-size: 10px; color: var(--text-dim); }
  .scn .del { visibility: hidden; background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; }
  .scn:hover .del { visibility: visible; }
  .check { width: 15px; height: 15px; cursor: pointer; }
  .empty { padding: 14px; color: var(--text-dim); font-size: 12px; text-align: center; }
  .empty.big { margin: auto; }

  .editor { width: 360px; flex: none; border-right: 1px solid var(--border); background: var(--bg-elev); display: flex; flex-direction: column; min-height: 0; overflow: auto; }
  .objbar { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .objbar .lbl { font-size: 10px; letter-spacing: .12em; color: var(--text-dim); }
  .objrow { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
  .objrow .obj { flex: 1; background: transparent; border: none; border-bottom: 1px dashed var(--border); color: var(--text); font-size: 15px; font-weight: 600; padding: 2px 0; }
  .objrow .obj:focus { outline: none; border-bottom-color: var(--accent); }
  .done { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); }
  .steps { padding: 8px 6px; }
  .step { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-md); }
  .step:hover { background: var(--bg-elev2); }
  .step .bar { width: 4px; align-self: stretch; min-height: 26px; border-radius: var(--radius-sm); flex: none; }
  .ptype { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; font-weight: 800; color: #0f1115; padding: 1px 5px; border-radius: var(--radius-sm); }
  .nm { flex: 1; min-width: 0; color: var(--text); }
  .nm.edit { background: transparent; border: none; border-bottom: 1px solid transparent; font: inherit; }
  .nm.edit:hover { border-bottom-color: var(--border); } .nm.edit:focus { outline: none; border-bottom-color: var(--accent); }
  .dur input, .loophead input { width: 42px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text); text-align: right; padding: 2px 4px; }
  .loophead input { text-align: center; }
  .advance { font-size: 10px; border: 1px solid var(--border); background: var(--bg-elev2); border-radius: var(--radius-md); padding: 2px 6px; cursor: pointer; color: var(--text-dim); }
  .advance.input { color: var(--warn); border-color: var(--warn); }
  .grip { cursor: grab; color: var(--text-dim); user-select: none; }
  .lock { font-size: 10px; opacity: .6; }
  .del { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 12px; }
  .del:hover { color: var(--text); }
  .loop { margin: 4px; border: 1px dashed var(--border); border-radius: var(--radius-lg); padding: 2px; }
  .loophead { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: 11px; color: var(--text-dim); }
  .addwrap { padding: 6px 8px; display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
  .addstep { font-size: 12px; color: var(--accent); background: none; border: 1px dashed var(--accent-dim); border-radius: var(--radius-md); padding: 4px 10px; cursor: pointer; }
  .addchip { font-size: 10px; text-transform: uppercase; font-weight: 800; color: #0f1115; border: none; border-radius: var(--radius-md); padding: 3px 8px; cursor: pointer; }

  .preview { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .preview .head .ell { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
  .mute { background: none; border: none; cursor: pointer; font-size: 15px; }
  .rbtn { border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); border-radius: var(--radius-md); padding: 4px 12px; cursor: pointer; font-weight: 600; }
  .rbtn.primary { background: var(--accent); border-color: var(--accent); color: #0c0e12; }
  .rbtn.stop { color: var(--warn); border-color: var(--warn); }

  .runbody { flex: 1; min-height: 0; overflow: auto; padding-bottom: 12px; }
  .hud { margin: 12px 14px; padding: 12px 14px; border-radius: var(--radius-lg); background: var(--bg-elev2); min-height: 52px; display: flex; flex-direction: column; gap: 6px; justify-content: center; }
  .hud.armed { color: var(--text-dim); font-size: 12px; }
  .hud.ok { color: #4cd07d; font-weight: 600; } .hud.bad { color: var(--warn); font-weight: 600; }
  .hud.lead { align-items: center; }
  .leadnum { font-size: 42px; font-weight: 800; line-height: 1; }
  .leadtxt { font-size: 12px; color: var(--text-dim); }
  .hudtop { display: flex; align-items: center; gap: 8px; }
  .pname { font-weight: 600; }
  .count { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .big-cue { color: var(--warn); font-weight: 700; }
  .hudnext { font-size: 11px; color: var(--text-dim); }

  .track { position: relative; display: flex; height: 40px; margin: 0 14px 10px; border-radius: var(--radius-md); overflow: hidden; background: #0c0e12; }
  .band { display: flex; align-items: center; justify-content: center; font-size: 10px; color: #0c0e12; font-weight: 700; overflow: hidden; white-space: nowrap; }
  /* "on input" step = a fixed-width pulsing ◉, NOT a duration-proportional bar.
     Keeps the phase color (set inline); the ◉ is dark like the other band labels. */
  .inputband { flex: 0 0 30px; position: relative; }
  .inputband .pulse { color: #0c0e12; }
  /* Active "on input" step (playhead hidden): light it up with a pulsing white ring
     + inner glow + brightness, and enlarge the ◉. An INNER glow so the track's
     rounded overflow:hidden never clips it; no width change so the timeline never
     reflows. The halo tint follows the phase color (--halo). */
  .inputband.active { z-index: 2; animation: bandactive 1.15s ease-in-out infinite; }
  .inputband.active .pulse { font-size: 16px; }
  @keyframes bandactive {
    0%, 100% { box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.55), inset 0 0 6px var(--halo, #fff); filter: brightness(1); }
    50%      { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.95), inset 0 0 14px var(--halo, #fff); filter: brightness(1.28); }
  }
  .pulse, .cppulse { color: var(--warn); animation: pulse 1.1s ease-in-out infinite; display: inline-block; }
  .cppulse { font-size: 18px; }
  @keyframes pulse { 0%, 100% { opacity: .4; transform: scale(.82); } 50% { opacity: 1; transform: scale(1.18); } }
  .playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; box-shadow: 0 0 5px #fff; transform: translateX(-1px); }

  .note { margin: 4px 14px; color: var(--text-dim); font-size: 12px; }
  .block { margin: 8px 14px; }
  .rhead { font-size: 11px; letter-spacing: .04em; color: var(--text-dim); text-transform: uppercase; padding: 6px 0; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
  .cand { display: flex; align-items: center; gap: 7px; padding: 5px 4px; border-bottom: 1px solid #161b22; cursor: pointer; }
  .cand:hover { background: var(--bg-elev2); }
  .cand.sel { background: var(--bg-elev2); outline: 1px solid var(--accent-dim); }
  .replay { margin: 4px 4px 10px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: #0c0e12; }
  .rep-head { font-size: 11px; color: var(--text-dim); margin-bottom: 6px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .rep-track { position: relative; height: 70px; border-radius: var(--radius-md); overflow: hidden; background: #07090c; }
  .rep-band { position: absolute; top: 0; bottom: 0; opacity: 0.5; }
  .rep-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .cand .loc { font-family: var(--mono, monospace); font-size: 11px; color: var(--accent); flex: none; }
  .cand .rat { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: 11px; }
  .score { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--text); flex: none; min-width: 32px; text-align: right; }
  .promote { background: var(--bg-elev2); border: 1px solid var(--accent-dim); color: var(--accent); border-radius: var(--radius-md); padding: 2px 7px; cursor: pointer; flex: none; }
</style>
