<script lang="ts">
  /**
   * Project import/export controls: §3.5 Project as JSON, DBC import/export
   * (stub writer/parser in dbc/dbc.ts), and a frame-table CSV snapshot. All
   * export is via Blob download (DESIGN §6 — no File System Access API).
   */
  import { project, loadProject, frameRows, lastError } from '../state/store';
  import { exportProjectJson, exportProjectDbc, exportCsv } from '../export/download';
  import { importDbc } from '../dbc/dbc';
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
  <span class="label">PROJECT</span>
  <input class="pname" bind:value={$project.name} />
  <span class="dim small">{$project.frames.length} frames · {$project.frames.reduce((n, f) => n + f.signals.length, 0)} signals</span>

  <div class="spacer"></div>

  <button on:click={() => exportProjectJson($project)}>Export JSON</button>
  <button on:click={() => fileInput.click()}>Import JSON</button>
  <span class="sep"></span>
  <button on:click={() => exportProjectDbc($project)} title="stub DBC writer">Export DBC</button>
  <button on:click={() => dbcInput.click()} title="stub DBC parser (@montra-connect/dbc-parser for full coverage)">Import DBC</button>
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
</style>
