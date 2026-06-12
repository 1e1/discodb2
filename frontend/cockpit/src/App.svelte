<script lang="ts">
  import ConnectionBar from './components/ConnectionBar.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import ProjectBar from './components/ProjectBar.svelte';
  import ViewTabs from './components/ViewTabs.svelte';
  import FilterBar from './components/FilterBar.svelte';
  import ViewAssign from './components/ViewAssign.svelte';
  import FrameTable from './components/FrameTable.svelte';
  import MessageList from './components/MessageList.svelte';
  import SignalList from './components/SignalList.svelte';
  import Inspector from './components/Inspector.svelte';
  import ComputeEditor from './components/ComputeEditor.svelte';
  import HuntPanel from './components/HuntPanel.svelte';
  import LogbookPanel from './components/LogbookPanel.svelte';
  import MarkhuntPanel from './components/MarkhuntPanel.svelte';
  import FindingsPanel from './components/FindingsPanel.svelte';
  import ClusterPanel from './components/ClusterPanel.svelte';
  import SubTabs from './components/SubTabs.svelte';
  import { onMount } from 'svelte';
  import { uiMode, logbookSub } from './state/store';
  import { initUrlSync } from './state/urlState';

  // Deep-linking: the URL hash mirrors the active view/sub-view/selection and
  // applies an incoming link on load (with a fade-in flash). See state/urlState.
  onMount(initUrlSync);

  // The Logbook tab hosts the RE authoring kinds + the shared knowledge base
  // (docs/markhunt-spec.md §2): 'storyboard' (the scripted scenario), 'field'
  // (the Markhunt highlighter), and 'findings' (the cross-session knowledge base
  // both modes promote into).
  type LogbookSub = 'storyboard' | 'field' | 'findings';
  const LOGBOOK_SUBS: { id: LogbookSub; label: string }[] = [
    { id: 'storyboard', label: 'Storyboard' },
    { id: 'field', label: 'Field run' },
    { id: 'findings', label: 'Findings' },
  ];
  const selectLogbookSub = (id: string) => logbookSub.set(id as LogbookSub);

  // TOP-LEVEL MODES (point 4), switched in the ProjectBar: 'explore' (the
  // 3-column Frame ▸ Message ▸ Signal workspace) vs the global full-width modes
  // 'hunt' / 'logbook' / 'cluster'. App just reacts to the shared `uiMode` store.
  //
  // Explore is THREE columns, each a list (top) over its own inspector (bottom):
  //   Frame  list + frame inspector  (+ Tab formula, the view-scoped column)
  //   Message list + message inspector (+ Custom formula, the per-message column)
  //   Signal list + signal inspector (the decoded-value editor)
  // The hierarchy Frame ▸ Message ▸ Signal is now spatial, left → right.
</script>

<div class="layout">
  <ConnectionBar />
  <StatusBar />
  <ProjectBar />

  {#if $uiMode === 'explore'}
    <!-- The frame-list context (view tabs, filter, selected → tab assignment)
         sits above the columns; it scopes the Frame column. -->
    <ViewTabs />
    <FilterBar />
    <ViewAssign />
    <!-- THREE columns: Frame ▸ Message ▸ Signal. Each is a list (top) docked
         over its own inspector (bottom). -->
    <div class="cols3">
      <section class="col">
        <header class="colhead"><span class="lvl">Frames</span><span class="cap">by arbitration ID</span></header>
        <div class="collist"><FrameTable /></div>
        <div class="colinsp">
          <Inspector scope="frame" />
          <ComputeEditor mode="tab" />
        </div>
      </section>

      <section class="col">
        <header class="colhead"><span class="lvl">Messages</span><span class="cap">a frame, or a mux branch</span></header>
        <div class="collist"><MessageList /></div>
        <div class="colinsp">
          <Inspector scope="message" />
          <ComputeEditor mode="custom" />
        </div>
      </section>

      <section class="col">
        <header class="colhead"><span class="lvl">Signals</span><span class="cap">a decoded value</span></header>
        <div class="collist"><SignalList /></div>
        <div class="colinsp"><Inspector scope="signal" /></div>
      </section>
    </div>
  {:else if $uiMode === 'hunt'}
    <!-- HUNT is global: full-width workspace (point 4 / option A). -->
    <div class="huntmain">
      <HuntPanel />
    </div>
  {:else if $uiMode === 'logbook'}
    <!-- LOGBOOK is global: full-width run-authoring workspace, two kinds —
         the scripted Storyboard and the Markhunt Field run (highlighter). -->
    <div class="huntmain logbookmain">
      <SubTabs tabs={LOGBOOK_SUBS} active={$logbookSub} onSelect={selectLogbookSub} />
      {#if $logbookSub === 'storyboard'}
        <LogbookPanel />
      {:else if $logbookSub === 'field'}
        <MarkhuntPanel />
      {:else}
        <FindingsPanel />
      {/if}
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
  /* ── 3-column Explore (Frame ▸ Message ▸ Signal) ─────────────────────────── */
  .cols3 {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .col {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
  }
  .col:last-child {
    border-right: none;
  }
  /* fixed-height single-line header so the three lists line up exactly */
  .colhead {
    flex: none;
    height: 30px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 10px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
  }
  .colhead .lvl {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--accent);
  }
  .colhead .cap {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* list on top (scrolls), inspector docked at the bottom (scrolls) */
  .collist {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .colinsp {
    flex: 0 0 40%;
    min-height: 0;
    overflow: auto;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
  }
  /* HUNT global workspace: fills the area under the bars; HuntPanel scrolls
     internally (its root is height:100%). */
  .huntmain {
    flex: 1;
    min-height: 0;
  }
  /* The Logbook tab stacks its shared SubTabs bar above the active workspace. */
  .logbookmain {
    display: flex;
    flex-direction: column;
  }
  .logbookmain :global(.logbook),
  .logbookmain :global(.markhunt),
  .logbookmain :global(.findings) {
    flex: 1;
    min-height: 0;
  }
</style>
