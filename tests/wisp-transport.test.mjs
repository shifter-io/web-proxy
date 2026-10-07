import {test} from 'node:test';
import assert from 'node:assert/strict';
import {flowControlledSocket} from '../web/runtime/wisp-transport.mjs';

function packet(type, id, value=0, length=type===3?9:6) {
  const bytes=new Uint8Array(length), view=new DataView(bytes.buffer);
  bytes[0]=type; view.setUint32(1,id,true);
  if(type===3)view.setUint32(5,value,true); else bytes[5]=value;
  return bytes;
}
class Socket extends EventTarget {
  sent=[];
  bufferedAmount=0;
  send(bytes) { this.sent.push(bytes.slice()); }
  emit(bytes) { this.dispatchEvent(new MessageEvent('message',{data:bytes.buffer})); }
  close(code) { this.closeCode=code; this.dispatchEvent(new Event('close')); }
}
function fixture() {
  const socket=new (flowControlledSocket(Socket))();
  socket.emit(packet(3,0,4));
  return socket;
}
test('DATA stops at the advertised packet window and resumes in order on CONTINUE',()=>{
  const socket=fixture();socket.send(packet(1,1));
  for(let i=0;i<7;i++)socket.send(packet(2,1,i));
  assert.equal(socket.sent.length,5);
  socket.emit(packet(3,1,3));
  assert.deepEqual(socket.sent.slice(1).map(bytes=>bytes[5]),[0,1,2,3,4,5,6]);
});
test('a waiting stream does not block another stream or borrow its credits',()=>{
  const socket=fixture();socket.send(packet(1,1));socket.send(packet(1,2));
  for(let i=0;i<5;i++)socket.send(packet(2,1,i));
  socket.send(packet(2,2,99));socket.emit(packet(3,2,4));
  assert.equal(socket.sent.at(-1)[5],99);
  assert.equal(socket.sent.length,7);
  socket.emit(packet(3,1,4));assert.equal(socket.sent.at(-1)[5],4);
});
test('queued packets retain their bytes when Epoxy reuses the source view',()=>{
  const socket=fixture();socket.send(packet(1,1));
  for(let i=0;i<4;i++)socket.send(packet(2,1,i));
  const bytes=packet(2,1,37);socket.send(bytes);bytes[5]=99;
  socket.emit(packet(3,1,4));assert.equal(socket.sent.at(-1)[5],37);
});
test('local stream CLOSE follows queued DATA while peer CLOSE discards unsent data',()=>{
  const socket=fixture();socket.send(packet(1,1));
  for(let i=0;i<5;i++)socket.send(packet(2,1,i));
  socket.send(packet(4,1,1));assert.equal(socket.sent.at(-1)[0],2);
  socket.emit(packet(3,1,4));
  assert.deepEqual(socket.sent.slice(-2).map(bytes=>bytes[0]),[2,4]);
  socket.send(packet(1,2));for(let i=0;i<5;i++)socket.send(packet(2,2,i));
  const sent=socket.sent.length;
  socket.emit(packet(4,2,1));socket.emit(packet(3,2,4));
  assert.equal(socket.sent.length,sent);
});
test('the send backlog is bounded and fails closed instead of dropping TLS bytes',()=>{
  const socket=fixture();socket.send(packet(1,1));
  assert.throws(()=>{for(let i=0;i<140;i++)socket.send(packet(2,1,0,65536));},/buffer exceeded/);
  assert.equal(socket.closeCode,4009);
  assert.equal(socket.streams.size,0);assert.equal(socket.queued,0);
});
test('large writes are split into bounded DATA packets without changing their bytes',()=>{
  const socket=fixture();socket.send(packet(1,1));
  const bytes=packet(2,1,0,70000);
  for(let i=5;i<bytes.length;i++)bytes[i]=i%251;
  socket.send(bytes);
  assert.equal(socket.sent.length,5);
  socket.emit(packet(3,1,4));
  const sent=socket.sent.slice(1);
  assert.ok(sent.every(chunk=>chunk.length<=16389));
  assert.deepEqual(Buffer.concat(sent.map(chunk=>chunk.subarray(5))),Buffer.from(bytes.subarray(5)));
});
