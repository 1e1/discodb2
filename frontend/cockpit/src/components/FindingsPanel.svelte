<script lang="ts">
  /**
   * FINDINGS — the project-wide knowledge base (DESIGN §3.5 findings), the third
   * Logbook sub-tab. Both authoring modes (Storyboard runs + Markhunt field runs)
   * promote candidates into `project.findings`; this is their single, always-
   * reachable home — no longer buried at the bottom of a run's results.
   *
   * Per finding: rename, see its locus + provenance, toggle hypothesis↔confirmed,
   * toggle exclude-from-hunts (feeds `excludedSlots` → known signals drop out of
   * future analyses), DELETE, and the finding→Signal BRIDGE: turn a confirmed
   * finding into a real decoded §3.5 Signal on its frame (so it shows up in the
   * Explore Signal column and the table), then jump to it.
   */
  import {
    project,
    mutateFinding,
    deleteFinding,
    addSignal,
    selected,
    uiMode,
  } from '../state/store';
  import { makeSignal, type LogbookFinding } from '../protocol/datamodel';

  $: findings = $project.findings ?? [];
  $: scenarios = $project.scenarios ?? [];
  $: fieldRuns = $project.fieldRuns ?? [];

  // ── filters ──────────────────────────────────────────────────────────────
  let filter = '';
  let statusFilter: 'all' | 'hypothesis' | 'confirmed' = 'all';
  $: shown = findings.filter(
    (f) =>
      (statusFilter === 'all' || f.status === statusFilter) &&
      f.name.toLowerCase().includes(filter.toLowerCase()),
  );
  $: confirmedCount = findings.filter((f) => f.status === 'confirmed').length;

  // Findings already bridged to a Signal this session (so the button shows ✓).
  let signalled = new Set<string>();

  const evVal = (e: Event) => (e.target as HTMLInputElement).value;
  const hexId = (id: number, ext: boolean) =>
    '0x' + id.toString(16).toUpperCase().padStart(ext ? 8 : 3, '0');
  const findLoc = (f: LogbookFinding) =>
    `${hexId(f.frameId, f.isExtended)} · B${f.byteIndex}${f.bit != null ? '.' + f.bit : ''}`;

  /** Provenance label: which run produced this finding, if resolvable. */
  function provenance(f: LogbookFinding): string {
    if (f.scenarioId) {
      const s = scenarios.find((x) => x.id === f.scenarioId);
      if (s) return `storyboard · ${s.objective}`;
      const r = fieldRuns.find((x) => x.id === f.scenarioId);
      if (r) return `field run · ${r.objective}`;
    }
    return f.foundAt ? new Date(f.foundAt).toLocaleDateString() : '';
  }

  const toggleStatus = (f: LogbookFinding) =>
    mutateFinding(f.id, (x) => (x.status = x.status === 'confirmed' ? 'hypothesis' : 'confirmed'));
  const toggleExclude = (f: LogbookFinding) =>
    mutateFinding(f.id, (x) => (x.excludeFromHunt = !x.excludeFromHunt));

  /**
   * Bridge: materialize the finding as a real §3.5 Signal on its frame. A bit
   * finding → a 1-bit signal; a byte/field finding → an 8-bit byte (the finding
   * model carries no width/endianness, so a byte is the faithful default). Jumps
   * to the frame in Explore so the new signal is visible immediately.
   */
  function toSignal(f: LogbookFinding) {
    const isBit = f.bit != null;
    const name =
      (f.name || 'finding').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') ||
      'finding';
    const sig = makeSignal(f.frameId, f.isExtended, {
      name,
      bitStart: isBit ? f.byteIndex * 8 + (f.bit as number) : f.byteIndex * 8,
      bitLength: isBit ? 1 : 8,
      byteOrder: 'little',
    });
    addSignal(f.frameId, f.isExtended, sig);
    selected.set({ id: f.frameId, isExtended: f.isExtended });
    signalled = new Set([...signalled, f.id]);
    uiMode.set('explore'); // jump to where the new signal is visible
  }
</script>

<div class="findings">
  <header class="bar">
    <span class="cap">the cross-session knowledge base — signals promoted from runs</span>
    <span class="spacer"></span>
    <span class="dim small">{confirmedCount}/{findings.length} confirmed</span>
  </header>

  <div class="tools">
    <input class="filter" placeholder="filter by name…" bind:value={filter} spellcheck="false" />
    <select bind:value={statusFilter}>
      <option value="all">all</option>
      <option value="hypothesis">hypotheses</option>
      <option value="confirmed">confirmed</option>
    </select>
  </div>

  <div class="list">
    {#each shown as f (f.id)}
      <div class="find">
        <input class="fname" value={f.name} on:change={(e) => mutateFinding(f.id, (x) => (x.name = evVal(e)))} spellcheck="false" />
        <span class="loc">{findLoc(f)}</span>
        {#if f.kind}<span class="badge t">{f.kind}</span>{/if}
        <button class="badge {f.status === 'confirmed' ? 'ok' : ''}" title="toggle hypothesis ↔ confirmed" on:click={() => toggleStatus(f)}>{f.status}</button>
        <button class="badge {f.excludeFromHunt ? 'ok' : ''}" title="exclude from future hunts/analyses" on:click={() => toggleExclude(f)}>{f.excludeFromHunt ? 'excluded' : 'in hunts'}</button>
        <span class="prov dim" title="provenance">{provenance(f)}</span>
        <span class="spacer"></span>
        <button class="tosig" class:done={signalled.has(f.id)} title="Turn this finding into a decoded signal on its frame" on:click={() => toSignal(f)}>{signalled.has(f.id) ? '✓ signal' : '→ signal'}</button>
        <button class="del" title="delete finding" on:click={() => deleteFinding(f.id)}>×</button>
      </div>
    {/each}
    {#if findings.length === 0}
      <div class="empty">No findings yet — promote a candidate from a Storyboard or Field run with ＋ finding.</div>
    {:else if shown.length === 0}
      <div class="empty">No finding matches the filter.</div>
    {/if}
  </div>
</div>

<style>
  .findings { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 30px; background: var(--bg-elev); border-bottom: 1px solid var(--border); }
  .bar .cap { font-size: 11px; color: var(--text-dim); }
  .spacer { flex: 1; }
  .small { font-size: 11px; }
  .dim { color: var(--text-dim); }

  .tools { display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .tools .filter { flex: 1; max-width: 320px; }

  .list { flex: 1; min-height: 0; overflow: auto; padding: 6px 12px; }
  .find { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid #161b22; }
  .find .fname { flex: 0 1 240px; min-width: 120px; background: transparent; border: none; border-bottom: 1px solid transparent; color: var(--text); font: inherit; font-size: 13px; }
  .find .fname:hover { border-bottom-color: var(--border); }
  .find .fname:focus { outline: none; border-bottom-color: var(--accent); }
  .find .loc { font-family: var(--mono); font-size: 11px; color: var(--accent); flex: none; }
  .find .prov { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
  .tosig { background: var(--bg-elev2); border: 1px solid var(--accent-dim); color: var(--accent); flex: none; }
  .tosig.done { color: var(--ok); }
  .del { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; flex: none; }
  .del:hover { color: var(--err); }
  .empty { padding: 18px 8px; color: var(--text-dim); text-align: center; }
</style>
