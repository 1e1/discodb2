<script lang="ts">
  /**
   * Project import/export controls: §3.5 Project as JSON, DBC import/export
   * (dbc/dbc.ts), the built-in OBD2 starter, and a frame-table CSV snapshot. All
   * export is via Blob download (DESIGN §6 — no File System Access API).
   */
  import { project, loadProject, frameRows, lastError, uiMode } from '../state/store';
  import { exportProjectJson, exportProjectDbc, exportCsv } from '../export/download';
  import { importDbc } from '../dbc/dbc';
  import { obd2StarterProject } from '../dbc/obd2-starter';
  import type { Project } from '../protocol/datamodel';

  let fileInput: HTMLInputElement;
  let dbcInput: HTMLInputElement;

  async function onJsonPicked(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const p = JSON.parse(text) as Project;
      if (!p || !Array.isArray(p.frames)) throw new Error('not a Project json');
      loadProject(p);
    } catch (err) {
      lastError.set(`project import failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      fileInput.value = '';
    }
  }

  async function onDbcPicked(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { project: p, warnings } = importDbc(text, file.name.replace(/\.dbc$/i, ''));
      loadProject(p);
      if (warnings.length) lastError.set(`DBC import: ${warnings[0]}`);
    } catch (err) {
      lastError.set(`DBC import failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      dbcInput.value = '';
    }
  }

  function exportTableCsv() {
    const header = ['id_hex', 'name', 'dlc', 'data_hex', 'rate_fps', 'count'];
    const rows = $frameRows.map((r) => {
      const idHex = '0x' + r.id.toString(16).toUpperCase().padStart(r.isExtended ? 8 : 3, '0');
      const dataHex = Array.from(r.data, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      return [idHex, '', r.dlc, dataHex, r.rate.toFixed(1), r.count];
    });
    exportCsv('cockpit-frames', header, rows);
  }
</script>

<div class="pbar">
  <!-- Top-level workspace switch (point 4 / option A): lives here so it costs no
       dedicated bar. Explore = selected-frame / active-tab tools; Hunt = global. -->
  <div class="modeseg" title="Explore = selected frame / active tab · Hunt = global detection · Logbook = scripted stimulus-response experiments · Cluster = decoded-signals dashboard">
    <button class:on={$uiMode === 'explore'} on:click={() => uiMode.set('explore')}>Explore</button>
    <button class:on={$uiMode === 'hunt'} on:click={() => uiMode.set('hunt')}>Hunt</button>
    <button class:on={$uiMode === 'logbook'} on:click={() => uiMode.set('logbook')}>Logbook</button>
    <button class:on={$uiMode === 'cluster'} on:click={() => uiMode.set('cluster')}>Cluster</button>
  </div>
  <span class="sep"></span>
  <span class="label">PROJECT</span>
  <input class="pname" bind:value={$project.name} />
  <span class="dim small">{$project.frames.length} frames · {$project.frames.reduce((n, f) => n + f.signals.length, 0)} signals</span>

  <div class="spacer"></div>

  <div class="btngroup">
    <button on:click={() => exportProjectJson($project)}>Export JSON</button>
    <button on:click={() => fileInput.click()}>Import JSON</button>
  </div>
  <div class="btngroup">
    <button on:click={() => exportProjectDbc($project)}>Export DBC</button>
    <button on:click={() => dbcInput.click()}>Import DBC</button>
  </div>
  <button on:click={() => loadProject(obd2StarterProject())} title="Load the built-in OBD2 Service 01 starter (common standard PIDs)">OBD2 starter</button>
  <span class="sep"></span>
  <button on:click={exportTableCsv}>Export table CSV</button>

  <input bind:this={fileInput} type="file" accept=".json,application/json" on:change={onJsonPicked} hidden />
  <input bind:this={dbcInput} type="file" accept=".dbc,text/plain" on:change={onDbcPicked} hidden />
</div>

<style>
  .pbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: var(--bg-elev2);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .label {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }
  .pname {
    width: 130px;
  }
  .small {
    font-size: 11px;
  }
  .sep {
    width: 1px;
    height: 16px;
    background: var(--border);
  }
  /* Segmented Explore/Hunt switch (lives at the far left of the project bar). */
  .modeseg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .modeseg button {
    border: none;
    border-radius: 0;
    background: transparent;
    padding: 3px 12px;
    font-weight: 600;
  }
  .modeseg button.on {
    background: var(--accent-dim);
    color: var(--accent);
  }
  /* Joined export/import pairs (JSON, DBC) — one visual group each. */
  .btngroup {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .btngroup button {
    border: none;
    border-radius: 0;
  }
  .btngroup button + button {
    border-left: 1px solid var(--border);
  }
</style>
