<script lang="ts">
  import ConnectionBar from './components/ConnectionBar.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import ProjectBar from './components/ProjectBar.svelte';
  import ViewTabs from './components/ViewTabs.svelte';
  import FilterBar from './components/FilterBar.svelte';
  import ViewAssign from './components/ViewAssign.svelte';
  import FrameTable from './components/FrameTable.svelte';
  import Inspector from './components/Inspector.svelte';
  import ComputeEditor from './components/ComputeEditor.svelte';
  import HuntPanel from './components/HuntPanel.svelte';

  type Tab = 'inspector' | 'custom' | 'tab' | 'hunt';
  let tab: Tab = 'inspector';
</script>

<div class="layout">
  <ConnectionBar />
  <StatusBar />
  <ProjectBar />

  <div class="main">
    <div class="left">
      <!-- The "frame list" lives in TABS: a per-tab filter + frame table,
           plus a selected-frame → tabs assignment bar. -->
      <ViewTabs />
      <FilterBar />
      <ViewAssign />
      <div class="tablearea">
        <FrameTable />
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
        <button class:active={tab === 'hunt'} on:click={() => (tab = 'hunt')}>Hunt</button>
      </div>
      <div class="tabbody">
        {#if tab === 'inspector'}
          <Inspector />
        {:else if tab === 'custom'}
          <ComputeEditor mode="custom" />
        {:else if tab === 'tab'}
          <ComputeEditor mode="tab" />
        {:else}
          <HuntPanel />
        {/if}
      </div>
    </div>
  </div>
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
  /* The table takes the remaining height under the tab/filter/assign bars and
     scrolls internally (FrameTable's .tablewrap is height:100% of this). */
  .tablearea {
    flex: 1;
    min-height: 0;
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
</style>
