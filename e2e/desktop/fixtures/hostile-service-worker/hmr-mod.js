// The HMR-observing module (#247's focused lane): the live label the
// spec flips through a real file edit — only the native Vite HMR
// WebSocket can deliver the update (a Service Worker cannot intercept
// it), so the label change under bypass is the functional HMR proof.
export let label = 'hmr-v1';

export function render(target) {
  if (target !== null) target.textContent = label;
}

if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    label = next.label;
    render(document.getElementById('hmr-label'));
    window.__hmr_label = label;
    window.__hmr_update_count = (window.__hmr_update_count ?? 0) + 1;
  });
}
