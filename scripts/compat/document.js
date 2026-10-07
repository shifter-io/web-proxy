// Runs in each rewritten document before Scramjet hooks and destination scripts.
// Native View Transitions can crash Chrome's compositor in the proxied iframe.
// Let sites select their ordinary DOM-update fallback through feature detection.
// The embedding page, runtime controls, and worker globals are unaffected.
if (typeof Document !== 'undefined') {
  delete Document.prototype.startViewTransition;
  delete Element.prototype.startViewTransition;
}
