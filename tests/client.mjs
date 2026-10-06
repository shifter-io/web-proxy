import WebSocket from 'ws';
import {Duplex} from 'node:stream';
import { randomBytes } from 'node:crypto';
export const origin = process.env.CONTROL_ORIGIN || 'http://localhost:8080';
export const runtime = process.env.RUNTIME_ORIGIN || 'http://localhost:8081';
export const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export class Visitor {
  constructor() { this.cookie = `shifter_dev=${randomBytes(16).toString('hex')}`; }
  get key() { return `daily:${this.cookie.split('=')[1]}:${Math.floor(Date.now()/86400000)}`; }
  async api(path, method='GET', body, expected=200) {
    const response = await fetch(`${origin}/api/${path}`, { method,
      headers:{Origin:origin,Cookie:this.cookie,...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined, signal:AbortSignal.timeout(20000) });
    const data = await response.json().catch(()=>({}));
    if (response.status!==expected) throw new Error(`API ${path}: expected ${expected}, got ${response.status}`);
    return data;
  }
  async start(country='us') { return this.api('sessions','POST',{country}); }
  async ticket() { return (await this.api('session/tickets','POST')).ticket; }
  async connect() { return Wisp.connect(await this.ticket()); }
}
export class Wisp {
  static async connect(ticket, overrideOrigin=runtime) {
    const ws = new WebSocket(`${runtime.replace(/^http/,'ws')}/wisp/?ticket=${ticket}`,{origin:overrideOrigin,perMessageDeflate:false,maxPayload:1024*1024});
    const client = new Wisp(ws);
    await client.ready; return client;
  }
  constructor(ws) {
    this.ws=ws; this.next=1; this.streams=new Map(); this.bytes=0; this.closed=false;
    this.ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new Error('Wisp handshake timeout'));ws.terminate();},20000);
      this.handshake=()=>{clearTimeout(timer);resolve();};
      ws.once('error',()=>{clearTimeout(timer);reject(new Error('Wisp connection rejected'));});
      ws.once('unexpected-response',(_,response)=>{clearTimeout(timer);response.resume();reject(new Error(`Wisp rejected (${response.statusCode})`));ws.terminate();});
      ws.once('close',()=>{clearTimeout(timer);reject(new Error('Wisp closed before handshake'));});
    });
    ws.on('error',()=>{});
    ws.on('message',data=>{
      if (data.length<5) return;
      const type=data[0],id=data.readUInt32LE(1),stream=this.streams.get(id);
      if (type===3 && id===0) {this.window=data.readUInt32LE(5);this.handshake();return;}
      if (!stream) return;
      if(stream.socket) {
        if(type===2) stream.socket.push(data.subarray(5));
        else if(type===3) {stream.credit=data.readUInt32LE(5);stream.flush();}
        else if(type===4) {this.streams.delete(id);stream.socket.push(null);}
        return;
      }
      if (type===2) {
        this.bytes+=data.length-5;stream.length+=data.length-5;
        if (stream.length>4*1024*1024+65536) {stream.reject(new Error('Response cap reached'));ws.terminate();return;}
        stream.chunks.push(data.subarray(5));
        const response=Buffer.concat(stream.chunks), boundary=response.indexOf('\r\n\r\n');
        if(boundary>=0) {
          const header=response.subarray(0,boundary).toString();
          const size=/content-length:\s*(\d+)/i.exec(header);
          const chunked=/transfer-encoding:\s*chunked/i.test(header);
          if((size && response.length>=boundary+4+Number(size[1])) || (chunked && response.subarray(boundary+4).includes(Buffer.from('\r\n0\r\n\r\n')))) {
            clearTimeout(stream.timer);this.streams.delete(id);
            const close=Buffer.alloc(6);close[0]=4;close.writeUInt32LE(id,1);close[5]=1;ws.send(close);stream.resolve(response);
          }
        }
      } else if (type===4) {
        clearTimeout(stream.timer);this.streams.delete(id);
        const body=Buffer.concat(stream.chunks);
        if (body.length) stream.resolve(body); else stream.reject(new Error(`Stream closed (${data[5]})`));
      }
    });
    ws.on('close',()=>{this.closed=true;for(const stream of this.streams.values()){if(stream.socket){stream.socket.destroy(new Error('Transport closed'));continue;}clearTimeout(stream.timer);stream.reject(new Error('Transport closed'));}this.streams.clear();});
  }
  request(host='fixture.test', path='/ip', {port=80,type=1,method='GET',body='',headers={}}={}) {
    const id=this.next++;
    const connect=Buffer.alloc(8+Buffer.byteLength(host));connect[0]=1;connect.writeUInt32LE(id,1);connect[5]=type;connect.writeUInt16LE(port,6);connect.write(host,8);
    const request=Buffer.from(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')}${body?`Content-Length: ${Buffer.byteLength(body)}\r\n`:''}\r\n${body}`);
    const packet=Buffer.alloc(5+request.length);packet[0]=2;packet.writeUInt32LE(id,1);request.copy(packet,5);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.streams.delete(id);reject(new Error('Destination timeout'));},20000);
      this.streams.set(id,{resolve,reject,timer,chunks:[],length:0});
      this.ws.send(connect);this.ws.send(packet);
    });
  }
  tunnel(host,port=443) {
    const id=this.next++,ws=this.ws,streams=this.streams;
    const stream={credit:this.window,queue:[],flush(){while(this.credit>0&&this.queue.length){const {data,done}=this.queue.shift();const packet=Buffer.alloc(5+data.length);packet[0]=2;packet.writeUInt32LE(id,1);data.copy(packet,5);ws.send(packet,done);this.credit--;}}};
    const socket=new Duplex({read(){},write(chunk,encoding,done){for(let offset=0;offset<chunk.length;offset+=16384){const data=chunk.subarray(offset,offset+16384);stream.queue.push({data,done:offset+data.length===chunk.length?done:undefined});}stream.flush();},destroy(error,done){streams.delete(id);if(ws.readyState===WebSocket.OPEN){const packet=Buffer.alloc(6);packet[0]=4;packet.writeUInt32LE(id,1);packet[5]=1;ws.send(packet);}done(error);}});
    stream.socket=socket;this.streams.set(id,stream);
    const packet=Buffer.alloc(8+Buffer.byteLength(host));packet[0]=1;packet.writeUInt32LE(id,1);packet[5]=1;packet.writeUInt16LE(port,6);packet.write(host,8);ws.send(packet);
    return socket;
  }
  async json(host='fixture.test',path='/ip') {
    const response=await this.request(host,path);
    const boundary=response.indexOf('\r\n\r\n');let body=response.subarray(boundary+4);
    if(/transfer-encoding:\s*chunked/i.test(response.subarray(0,boundary).toString())) {
      const chunks=[];while(body.length){const end=body.indexOf('\r\n');const n=parseInt(body.subarray(0,end).toString(),16);if(!n)break;chunks.push(body.subarray(end+2,end+2+n));body=body.subarray(end+4+n);}body=Buffer.concat(chunks);
    }
    return JSON.parse(body.toString());
  }
  async close() {
    if (this.closed) return;
    await new Promise(resolve=>{this.ws.once('close',resolve);this.ws.close();setTimeout(()=>{this.ws.terminate();resolve();},500).unref();});
  }
}
