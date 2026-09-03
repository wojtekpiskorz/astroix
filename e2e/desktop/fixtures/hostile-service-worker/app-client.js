// The app-shell stand-in's client module (#247's focused lane): binds
// the HMR label into the document and receives the canvas iframe's
// same-origin probe results.
import { label, render } from '/hmr-mod.js';

render(document.getElementById('hmr-label'));
window.__hmr_label = label;
window.__hmr_update_count = 0;
window.addEventListener('message', (event) => {
  if (event.data !== null && typeof event.data === 'object' && event.data.canvas !== undefined) {
    window.__canvas_probe = event.data.canvas;
  }
});
