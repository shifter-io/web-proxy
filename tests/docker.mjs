import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export function dockerSync(args) {
  return process.platform==='darwin'
    ?execFileSync('/bin/zsh',['-c','exec "$@"','sh','docker',...args],{encoding:'utf8',maxBuffer:4*1024*1024})
    :execFileSync('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024});
}
export async function docker(args) {
  const result=process.platform==='darwin'
    ?await run('/bin/zsh',['-c','exec "$@"','sh','docker',...args],{encoding:'utf8',maxBuffer:4*1024*1024})
    :await run('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024});
  return result.stdout;
}
