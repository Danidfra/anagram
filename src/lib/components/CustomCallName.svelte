<script lang="ts">
  import { customCallNameCss } from '#src/utils/customCallNameCss.ts';
  export let name: string;
  export let css: string;
  function render(node: HTMLElement, value: { name: string; css: string }) {
    const root = node.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    const label = document.createElement('div');
    label.className = 'customname';
    root.append(style, label);
    function update(next: typeof value) {
      label.textContent = next.name;
      style.textContent = customCallNameCss(next.css);
      // Shadow mutations do not reach the recording-stage observer.
      node.setAttribute('data-name-revision', String(Number(node.dataset.nameRevision || 0) + 1));
    }
    update(value);
    return { update };
  }
</script>

<div class="custom-call-name" data-testid="custom-call-name" use:render={{ name, css }}></div>

<style>
  .custom-call-name {
    position: absolute;
    inset: 0;
    contain: layout;
    pointer-events: none;
    text-align: left;
  }
</style>
