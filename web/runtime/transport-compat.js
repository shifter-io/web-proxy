// BareMux 2.1.9 handles non-transferable response streams, but not request streams.
// Normalize before the first send, so a POST is never retried or duplicated.
function installRequestBodyCompatibility(client) {
  const worker = client.worker;
  const send = worker.sendMessage.bind(worker);
  let transferable;
  function supportsStreams() {
    if (transferable !== undefined) return transferable;
    const channel = new MessageChannel();
    const stream = new ReadableStream({start(controller) { controller.close(); }});
    channel.port2.onmessage = event => { event.data.cancel().catch(() => {}); channel.port2.close(); };
    try { channel.port1.postMessage(stream, [stream]); transferable = true; }
    catch { transferable = false; channel.port2.close(); }
    finally { channel.port1.close(); }
    return transferable;
  }
  worker.sendMessage = async function(message, transfers = []) {
    const body = message.type === 'fetch' && message.fetch?.body;
    if (!body || typeof body.getReader !== 'function' || supportsStreams()) return send(message, transfers);
    const reader = body.getReader(), chunks = [];
    let length = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        // Cap memory in browsers that cannot stream between workers.
        if (length > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new RangeError('Request body exceeds the browser compatibility limit.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return send({...message, fetch:{...message.fetch, body:bytes.buffer}}, [...transfers.filter(item => item !== body), bytes.buffer]);
  };
}
