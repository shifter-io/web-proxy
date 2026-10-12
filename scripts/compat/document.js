// Runs in each rewritten document before Scramjet hooks and destination scripts.
// Native View Transitions can crash Chrome's compositor in the proxied iframe.
// Let sites select their ordinary DOM-update fallback through feature detection.
// The embedding page, runtime controls, and worker globals are unaffected.
if (typeof Document !== 'undefined') {
  // Capture the trusted runtime's port factory before parent/window hooks.
  // Nested rewritten frames and srcdoc documents use the same transport.
  try {
    let owner = window.parent;
    while (owner !== window) {
      if (typeof owner.__shifterBareMuxPort === 'function') {
        window.__shifterBareMuxPort = () => owner.__shifterBareMuxPort();
        break;
      }
      if (owner === owner.parent) break;
      owner = owner.parent;
    }
  } catch {}
  delete Document.prototype.startViewTransition;
  delete Element.prototype.startViewTransition;
}
