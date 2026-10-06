/* Stable v1 loader. Change only RELEASE to promote or roll back a compatible release. */
(() => {
  if (window.ShifterWebProxy) return;
  const script = document.currentScript;
  const base = new URL(script.src);
  const RELEASE = '1.0.1';
  const implementation = import(new URL(`../releases/${RELEASE}/client.js`, base));
  window.ShifterWebProxy = Object.freeze({
    version: RELEASE,
    create(options = {}) {
      let snapshot = Object.freeze({status:'initializing', countries:[], active:false, busy:false, loading:false});
      const listeners = new Set();
      const client = implementation.then(module => {
        const instance = module.create({apiOrigin:base.origin, nonce:script.nonce, ...options});
        instance.subscribe(state => {
          snapshot = state;
          for (const listener of listeners) { try { listener(structuredClone(state)); } catch (error) { console.error('Web proxy UI callback failed', error); } }
        });
        return instance;
      });
      // Avoid unhandled rejections when a blocked script fails before init() is called.
      client.catch(() => {});
      const facade = {
        getState:() => structuredClone(snapshot),
        subscribe(callback) { listeners.add(callback); callback(structuredClone(snapshot)); return () => listeners.delete(callback); },
      };
      for (const method of ['init','search','navigate','back','forward','reload','changeCountry','stop','destroy']) {
        facade[method] = (...args) => client.then(instance => instance[method](...args));
      }
      return Object.freeze(facade);
    },
  });
})();
