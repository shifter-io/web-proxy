// Setup deadlines are separate from destination loading and proxy recovery.
async function runtimeDeadline(task, message, milliseconds = 12000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForRuntimeWorker(workerUrl) {
  const workers = navigator.serviceWorker;
  const controlled = () => workers.controller?.scriptURL === new URL(workerUrl, location.href).href;
  if (controlled()) return;
  let changed;
  try {
    await runtimeDeadline(() => new Promise(resolve => {
      changed = () => { if (controlled()) resolve(); };
      workers.addEventListener('controllerchange', changed);
      changed();
    }), 'The browser did not activate its service worker. Open this page in a full browser and select Reload.');
  } finally { if (changed) workers.removeEventListener('controllerchange', changed); }
}
