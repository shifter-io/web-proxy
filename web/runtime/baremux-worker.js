// BareMux's worker already handles every transport operation on MessagePorts.
importScripts('/vendor/baremux/worker.js');
self.onmessage = event => {
  if (event.data?.port) self.onconnect({ports:[event.data.port]});
};
