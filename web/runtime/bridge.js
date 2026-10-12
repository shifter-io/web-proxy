// Bind every runtime document (including reset) to one parent and SDK generation.
window.createRuntimeBridge = async () => {
  const params = new URLSearchParams(location.search);
  const parentOrigin = params.get('parentOrigin');
  const channel = params.get('channel');
  const protocolVersion = Number(params.get('protocolVersion'));
  const request = new AbortController();
  const timer = setTimeout(() => request.abort(), 5000);
  let config;
  try {
    const response = await fetch('/settings', {signal:request.signal});
    if (!response.ok) throw new Error('Runtime configuration unavailable');
    config = await response.json();
  } finally { clearTimeout(timer); }
  if (parent === window || !config.allowedOrigins.includes(parentOrigin)
    || !config.protocolVersions.includes(protocolVersion) || !/^[a-f0-9-]{36}$/.test(channel || '')) {
    throw new Error('Invalid runtime parent');
  }
  return {
    query:params.toString(),
    send:(type, data = {}) => parent.postMessage({source:'shifter-runtime',protocolVersion,channel,type,...data},parentOrigin),
    accepts:event => event.source === parent && event.origin === parentOrigin
      && event.data?.source === 'shifter-control' && event.data.protocolVersion === protocolVersion && event.data.channel === channel,
  };
};
