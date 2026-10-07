// Epoxy's Wisp AsyncWrite adapter does not observe DATA credits. Sending past
// the gateway's bounded receive window can drop encrypted bytes and corrupt
// TLS records. Pace DATA on the native WebSocket path, independently per stream.
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export function flowControlledSocket(Socket) {
  return class extends Socket {
    constructor(...args) {
      super(...args);
      this.windowSize = 0;
      this.streams = new Map();
      this.queued = 0;
      this.addEventListener('message', event => {
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 5) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const id = view.getUint32(1, true);
        if (bytes[0] === 3 && bytes.length >= 9) {
          const credit = view.getUint32(5, true);
          if (id === 0) this.windowSize = credit;
          else {
            const stream = this.streams.get(id);
            if (stream) { stream.credit = Math.min(credit, this.windowSize); this.flush(stream, id); }
          }
        } else if (bytes[0] === 4) this.remove(id);
      });
      this.addEventListener('close', () => { this.streams.clear(); this.queued = 0; });
    }
    remove(id) {
      const stream = this.streams.get(id);
      if (stream) for (const bytes of stream.queue) this.queued -= bytes.byteLength;
      this.streams.delete(id);
    }
    flush(stream, id) {
      while (stream.queue.length && (stream.credit || stream.queue[0][0] === 4)) {
        const bytes = stream.queue.shift();
        this.queued -= bytes.byteLength;
        if (bytes[0] === 2) stream.credit--;
        super.send(bytes);
        if (bytes[0] === 4) { this.remove(id); break; }
      }
    }
    send(value) {
      // The WASM adapter may reuse its view as soon as send returns.
      const view = value instanceof ArrayBuffer ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (view.byteLength > MAX_QUEUED_BYTES) {
        this.close(4009, 'Wisp send buffer exceeded');
        throw new Error('Wisp send buffer exceeded');
      }
      const bytes = view.slice();
      if (bytes.length < 5) return super.send(bytes);
      const id = new DataView(bytes.buffer).getUint32(1, true);
      if (bytes[0] === 1) this.streams.set(id, {credit:this.windowSize, queue:[], closing:false});
      else if (bytes[0] === 2 || bytes[0] === 4) {
        const stream = this.streams.get(id);
        if (!stream) return bytes[0] === 4 ? super.send(bytes) : undefined;
        if (stream.closing) return;
        // A synchronous WebSocket send cannot apply producer backpressure.
        // Bound retained data and fail the connection rather than losing bytes.
        if (this.queued + bytes.byteLength + 5*Math.ceil(bytes.byteLength/16384) > MAX_QUEUED_BYTES) {
          this.close(4009, 'Wisp send buffer exceeded');
          throw new Error('Wisp send buffer exceeded');
        }
        if (bytes[0] === 4) stream.closing = true;
        // Epoxy may write a whole request body at once. The gateway accepts
        // at most 64 KiB per frame; 16 KiB payloads also bound each credit.
        if (bytes[0] === 2) {
          for (let offset=5; offset<bytes.length; offset+=16384) {
            const chunk=new Uint8Array(5+Math.min(16384,bytes.length-offset));
            chunk.set(bytes.subarray(0,5)); chunk.set(bytes.subarray(offset,offset+16384),5);
            stream.queue.push(chunk); this.queued+=chunk.byteLength;
          }
        } else { stream.queue.push(bytes); this.queued+=bytes.byteLength; }
        this.flush(stream, id);
        return;
      }
      super.send(bytes);
    }
  };
}

export const FlowControlledWebSocket = flowControlledSocket(globalThis.WebSocket);
