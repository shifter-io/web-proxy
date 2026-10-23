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
  // `https://*.example.com` allows any subdomain of example.com (not the apex).
  const allowed = pattern => {
    const [scheme, suffix] = pattern.split('://*.');
    if (suffix === undefined) return pattern === parentOrigin;
    const labels = parentOrigin?.startsWith(scheme + '://') && parentOrigin.endsWith('.' + suffix)
      ? parentOrigin.slice(scheme.length + 3, -suffix.length - 1) : '';
    return labels.split('.').every(label => /^[a-z0-9-]+$/.test(label));
  };
  if (parent === window || !config.allowedOrigins.some(allowed)
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
