import { promises as fs, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const ids=process.argv.slice(2);
if(!ids.length) throw new Error('Provide package IDs to check.');
const retained=await fs.mkdtemp(path.join(os.tmpdir(),'pi12-compat-'));
await fs.chmod(retained,0o700);
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.toLowerCase().startsWith('npm_')));
function run(command,args,cwd,log){return new Promise((resolve,reject)=>{
 const sink=createWriteStream(log,{mode:0o600});
 const child=spawn(command,args,{cwd,env:{...cleanEnv,npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'},stdio:['ignore','pipe','pipe']});
 let tail='',zeroTests=false;
 for(const stream of [child.stdout,child.stderr]){
  stream.setEncoding('utf8');
  stream.on('data',chunk=>{ const sample=tail+chunk; zeroTests ||= /(?:ℹ|#) tests 0\r?\n/.test(sample); tail=sample.slice(-256); });
  stream.pipe(sink,{end:false});
 }
 sink.on('error',error=>{child.kill();reject(error);});
 child.on('error',error=>sink.write(String(error)));
 child.on('close',async code=>{
  zeroTests ||= /(?:ℹ|#) tests 0$/.test(tail);
  sink.end();
  try { await finished(sink); resolve({code,log,zeroTests}); } catch(error){reject(error);}
 });
});}
const report={runtime:{node:process.version,pi:'1.2.0'},retained,packages:[]};
for(const id of ids){
 if(!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid package ID');
 const cwd=path.join(retained,id);await fs.cp(path.join(root,'packages',id),cwd,{recursive:true});
 const manifest=JSON.parse(await fs.readFile(path.join(cwd,'package.json'),'utf8'));
 const checks=[];
 checks.push(await run('npm',['install','--ignore-scripts','--no-audit','--no-fund'],cwd,path.join(retained,id+'-install.log')));
 if(checks[0].code===0){
  const script=manifest.scripts?.check??manifest.scripts?.typecheck;
  if(script)checks.push(await run('npm',['run',manifest.scripts?.check?'check':'typecheck'],cwd,path.join(retained,id+'-check.log')));
  if(manifest.scripts?.build)checks.push(await run('npm',['run','build'],cwd,path.join(retained,id+'-build.log')));
  // Run each package's declared fixture suite, never optional live provider/DCG/Pocket scripts.
  if(!manifest.scripts?.test)throw new Error(`Missing fixture test script: ${id}`);
  const tests = await run('npm',['test'],cwd,path.join(retained,id+'-test.log'));
  if(tests.code===0 && tests.zeroTests) {
   tests.code=1; tests.reason='Fixture test command executed zero tests';
  }
  checks.push(tests);
 }
 const record={id,cwd,checks};report.packages.push(record);
 await fs.writeFile(path.join(retained,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(record));
}
console.log('REPORT '+path.join(retained,'report.json'));
if(report.packages.some(p=>p.checks.some(c=>c.code!==0)))process.exitCode=1;
