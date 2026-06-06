<script lang="ts">
  import ConnectionBar from './components/ConnectionBar.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import ProjectBar from './components/ProjectBar.svelte';
  import ViewTabs from './components/ViewTabs.svelte';
  import FilterBar from './components/FilterBar.svelte';
  import ViewAssign from './components/ViewAssign.svelte';
  import FrameTable from './components/FrameTable.svelte';
  import MessageList from './components/MessageList.svelte';
  import Inspector from './components/Inspector.svelte';
  import ComputeEditor from './components/ComputeEditor.svelte';
  import HuntPanel from './components/HuntPanel.svelte';
  import LogbookPanel from './components/LogbookPanel.svelte';
  import ClusterPanel from './components/ClusterPanel.svelte';
  import { uiMode } from './state/store';

  // TWO TOP-LEVEL MODES, by SCOPE (point 4): 'explore' (frame table + the
  // per-frame / per-tab right pane) vs 'hunt' (the GLOBAL detection Wizard,
  // full-width). The switch lives in the ProjectBar (so it costs no dedicated
  // bar); App just reacts to the shared `uiMode` store.
  //
  // Right-pane tabs are PURELY frame/view-scoped (Hunt is its own global mode).
  type Tab = 'inspector' | 'custom' | 'tab';
  let tab: Tab = 'inspector';

  // ── master/detail vertical split (frame list ↑ / message list ↓) ────────────
  // The left pane is a vertically split, resizable stack: the MASTER frame list
  // on top and the DETAIL message list (messages of the selected frame) below. A
  // draggable divider sets the master's share of the height (`masterPct`, %).
  // Double-clicking the divider toggles a simple accordion (maximize one pane).
  let masterPct = 55; // default ~55% master / 45% detail
  let prevPct = 55; // remembered split for the accordion toggle
  let dragging = false;
  let splitEl: HTMLDivElement;

  function startDrag(e: PointerEvent) {
    dragging = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onDrag(e: PointerEvent) {
    if (!dragging || !splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    const pct = ((e.clientY - rect.top) / rect.height) * 100;
    masterPct = Math.min(90, Math.max(10, pct));
  }
  function endDrag(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }
  // Accordion: double-click maximizes the master (or restores the prior split if
  // already maximized). Deliberately simple — one toggle, not a full accordion.
  function toggleAccordion() {
    if (masterPct >= 88) {
      masterPct = prevPct;
    } else {
      prevPct = masterPct;
      masterPct = 90;
    }
  }
</script>

<div class="layout">
  <ConnectionBar />
  <StatusBar />
  <ProjectBar />

  {#if $uiMode === 'explore'}
    <div class="main">
      <div class="left">
        <!-- The "frame list" lives in TABS: a per-tab filter + frame table,
             plus a selected-frame → tabs assignment bar. -->
        <ViewTabs />
        <FilterBar />
        <ViewAssign />
        <!-- Master/detail vertical split: frame list (master) over message
             list (detail). Drag the divider to resize; double-click to maximize. -->
        <div class="split" bind:this={splitEl}>
          <div class="master" style="height: {masterPct}%">
            <FrameTable />
          </div>
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="divider"
            class:dragging
            role="separator"
            aria-orientation="horizontal"
            title="drag to resize · double-click to maximize the frame list"
            on:pointerdown={startDrag}
            on:pointermove={onDrag}
            on:pointerup={endDrag}
            on:dblclick={toggleAccordion}
          ></div>
          <div class="detail" style="height: {100 - masterPct}%">
            <MessageList />
          </div>
        </div>
      </div>
      <div class="right">
        <div class="tabs">
          <button class:active={tab === 'inspector'} on:click={() => (tab = 'inspector')}>
            Inspector
          </button>
          <button class:active={tab === 'custom'} on:click={() => (tab = 'custom')} title="per-frame formula → Custom column">
            Custom
          </button>
          <button class:active={tab === 'tab'} on:click={() => (tab = 'tab')} title="per-tab formula → Tab column">
            Tab
          </button>
        </div>
        <div class="tabbody">
          {#if tab === 'inspector'}
            <Inspector />
          {:else if tab === 'custom'}
            <ComputeEditor mode="custom" />
          {:else}
            <ComputeEditor mode="tab" />
          {/if}
        </div>
      </div>
    </div>
  {:else if $uiMode === 'hunt'}
    <!-- HUNT is global: full-width workspace (point 4 / option A). -->
    <div class="huntmain">
      <HuntPanel />
    </div>
  {:else if $uiMode === 'logbook'}
    <!-- LOGBOOK is global: full-width scripted-experiment workspace. -->
    <div class="huntmain">
      <LogbookPanel />
    </div>
  {:else}
    <!-- CLUSTER is global: full-width decoded-signals dashboard. -->
    <div class="huntmain">
      <ClusterPanel />
    </div>
  {/if}
</div>

<style>
  .layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .left {
    flex: 1;
    min-width: 0;
    border-right: 1px solid var(--border);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  /* Master/detail vertical split fills the remaining height under the
     tab/filter/assign bars. Master + detail each scroll internally (their root
     wrappers are height:100%); the divider sits between them. */
  .split {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .master {
    min-height: 0;
    overflow: hidden;
  }
  .detail {
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid var(--border);
  }
  .divider {
    height: 6px;
    flex: none;
    cursor: row-resize;
    background: var(--bg-elev2);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .divider:hover,
  .divider.dragging {
    background: var(--accent-dim);
  }
  .right {
    width: 440px;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .tabs button {
    border: none;
    border-radius: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    padding: 7px 14px;
  }
  .tabs button.active {
    border-bottom-color: var(--accent);
    color: var(--accent);
  }
  .tabbody {
    flex: 1;
    min-height: 0;
  }
  /* HUNT global workspace: fills the area under the bars; HuntPanel scrolls
     internally (its root is height:100%). */
  .huntmain {
    flex: 1;
    min-height: 0;
  }
</style>
