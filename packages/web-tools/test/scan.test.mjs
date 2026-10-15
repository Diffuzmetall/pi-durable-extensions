import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,writeFile,mkdir,open,readdir,stat,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';
// Its own temp root: this suite deliberately fills the download folder to test its budget.
process.env.TMPDIR = await mkdtemp(join(tmpdir(), 'web-tools-scan-'));
const missing=process.env.NO_OPTIONALS==='1'?['wreq-js','linkedom','defuddle/node']:(process.env.NO_OPTIONALS??'').split(',');
registerHooks({resolve(s,c,n){if(missing.includes(s))throw Error('disabled optional');return n(s,c);}});
const given=process.env.WEB_TOOLS;
const path=given?(given.startsWith('file:')?fileURLToPath(given):given):fileURLToPath(new URL('../src/web-tools.ts',import.meta.url));
const source=await readFile(path,'utf8');
// Beside the test, not in the OS temp folder: bare imports must resolve to this repo's node_modules.
const instrument=join(fileURLToPath(new URL('.',import.meta.url)),`.scan-helpers-${process.pid}.ts`);
await writeFile(instrument,source+'\nexport {attributesOf,refreshTarget,alternateTarget,titleOf,withDownloadFile,saveBinary};\n');
const m=await import(pathToFileURL(instrument));
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log('PASS SCAN',name);}catch(e){failed++;console.log('FAIL SCAN',name,e.message);}}
const hugeTitle='<title>'+'T'.repeat(100000)+'</title><main><p>REAL ARTICLE</p></main>';
const large='<p>Readable paragraph text</p>'.repeat(600000);
const server=http.createServer((req,res)=>{
 res.setHeader('content-type','text/html');
 if(req.url==='/title')res.end(hugeTitle);
 else if(req.url==='/controls'){res.setHeader('content-type','text/plain');res.end('\u0001'.repeat(40000));}
 else if(req.url.startsWith('/batch')){res.setHeader('content-type','application/json');res.end(JSON.stringify({body:'x'.repeat(15000)}));}
 else if(req.url==='/alternate')res.end('<link rel="alternate" type="text/plain" href="/long"><p>short</p>');
 else if(req.url==='/long'){res.setHeader('content-type','text/plain');res.end('X'.repeat(100000));}
 else if(req.url==='/large')res.end(large);
 else if(req.url==='/prefix')res.end('<script>SECRET</scripture><meta http-equiv="refresh" content="0;url=/landing"></script><p>REAL</p>');
 else if(req.url==='/lines'){res.setHeader('content-type','text/plain');res.end('abc\n'.repeat(15000));}
 else res.end('<p>LANDING</p>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
server.unref();
const base=`http://127.0.0.1:${server.address().port}`;
const bounded=(text,size,lines=1900)=>{assert.ok(text.length<=size,`chars ${text.length} > ${size}`);assert.ok(Buffer.byteLength(text)<=size,`bytes ${Buffer.byteLength(text)} > ${size}`);assert.ok(text.split('\n').length<=lines);};
try{
 await check('40KB attribute bomb under 10ms in both metadata paths',async()=>{
  const tag='meta '+'a'.repeat(40000);
  m.attributesOf('meta warmup=yes');
  for(const name of ['meta','link']){
   const input='<'+name+' '+'a'.repeat(40000)+'>';
   const times=[];for(let i=0;i<3;i++){const t=performance.now();if(name==='meta')m.refreshTarget(input,base);else m.alternateTarget(input,base,'text');times.push(performance.now()-t);}
   const ms=Math.min(...times);console.log('ATTRIBUTE MS',name,ms.toFixed(3));assert.ok(ms<10,`${name}: ${ms}ms`);
  }
  const a=m.attributesOf('meta bare x=one y="two words" z=\'three\' spaced = four');
  assert.deepEqual([...a],[['bare',''],['x','one'],['y','two words'],['z','three'],['spaced','four']]);
 });
 await check('100KB title is shortened, not carried',async()=>{for(const format of ['markdown','text','json','html','raw']){
  const p=await m.fetchPage(base+'/title',1000,format),text=m.renderPage(p);bounded(text,1000);
  assert.ok(p.title.endsWith('…'),'the shortened title says so: '+p.title.slice(-20));
  assert.ok(text.includes('shortened to fit'),'and the answer says why');
  if(format==='json'){const j=JSON.parse(text);assert.ok(j.title.length<=200);}
 }});
 await check('escaped controls bound serialized JSON',async()=>{const p=await m.fetchPage(base+'/controls',40000,'json'),text=m.renderPage(p);bounded(text,40000);const j=JSON.parse(text);assert.equal(j.truncated,true);assert.equal(await readFile(j.filePath,'utf8'),'\u0001'.repeat(40000));assert.ok(j.text.length<40000);});
 await check('five compliant JSON pages share aggregate budget',async()=>{
  const tool=m.default().tools.find(x=>x.name==='batch_web_fetch');const out=await tool.execute({requests:Array.from({length:5},(_,i)=>({url:base+'/batch'+i,format:'json',maxChars:40000}))});
  const text=out.output[0].text;bounded(text,48000);
  const pages=text.split('\n\n---\n\n');assert.equal(pages.length,5);
  for(const p of pages){const j=JSON.parse(p.slice(p.indexOf('\n\n')+2));assert.equal(j.truncated,true);assert.ok(j.filePath);assert.equal(JSON.parse(await readFile(j.filePath,'utf8')).body.length,15000);}
 });
 await check('main/article selection excludes all inert poisons and tracks nesting',()=>{
  for(const input of ['<!-- <main>POISON</main> --><p>REAL</p>','<script>"<main>POISON</main>"</script><p>REAL</p>','<template><main>POISON</main></template><p>REAL</p>','<div data-x="<main>POISON</main>">REAL</div>','<main data-x=">POISON">REAL</main>'])assert.equal(m.htmlToText(input),'REAL',input);
  assert.equal(m.htmlToText('<main><p>OUTER</p><main>INNER</main><p>TAIL</p></main><p>OTHER</p>'),'OUTER\nINNER\nTAIL');
  assert.equal(m.htmlToText('<main>A</mainland>B</main>'),'AB');
  assert.equal(m.htmlToText('<article>A</article><main>M</main>'),'M');
 });
 await check('raw closing-name prefix cannot reveal refresh or alternate',async()=>{
  assert.equal(m.refreshTarget('<script>SECRET</scripture><meta http-equiv="refresh" content="0;url=/landing"></script>',base),undefined);
  assert.equal(m.alternateTarget('<script>SECRET</scripture><link rel="alternate" type="text/plain" href="/landing"></script>',base,'text'),undefined);
  assert.equal(m.htmlToText('before<script>SECRET</scripture>LEAK</script>after'),'beforeafter');
  const p=await m.fetchPage(base+'/prefix',1000,'text');assert.equal(p.finalUrl,base+'/prefix');assert.equal(p.text,'REAL');
 });
 await check('large HTML fetch bounds extraction and names what it read',async()=>{const p=await m.fetchPage(base+'/large',1000,'text');bounded(m.renderPage(p),1000);assert.equal(p.truncated,true);assert.match(p.note??'',/Extraction limited/);assert.equal(p.fileHolds,'source');const saved=await readFile(p.filePath,'utf8');assert.ok(saved.length<large.length,'the file holds the part that was read');assert.ok(saved.startsWith('<'),'and it is the page source from where extraction began');assert.match(m.renderPage(p),/part of the page that was read/);});
 await check('truncated text alternate renders its saved path',async()=>{const p=await m.fetchPage(base+'/alternate',1000,'text');assert.ok(p.sourceUrl);assert.equal(p.truncated,true);assert.ok(m.renderPage(p).includes(p.filePath));assert.equal(await readFile(p.filePath,'utf8'),'X'.repeat(100000));bounded(m.renderPage(p),1000);});
 await check('line counts are bounded with a saved full text',async()=>{const p=await m.fetchPage(base+'/lines',40000,'text');bounded(m.renderPage(p),40000);assert.equal(await readFile(p.filePath,'utf8'),'abc\n'.repeat(15000));});
 await check('quota admission covers two concurrent 100MB saves at 199MB',async()=>{
  const folder=join(tmpdir(),'pi-durable-web-tools');await mkdir(folder,{recursive:true});
  // The command uses a fresh TMPDIR; account for files created by prior cases.
  let held=0;for(const name of await readdir(folder))held+=(await stat(join(folder,name))).size;
  const f=await open(join(folder,'quota-existing-'+process.pid),'wx');
  // Real bytes, not a truncate hole: the budget measures blocks on disk, and a sparse file
  // occupies none of them.
  {const chunk=Buffer.alloc(1<<20,7);let written=0;const want=199000000-held;while(written<want){const n=Math.min(chunk.length,want-written);await f.write(chunk,0,n);written+=n;}await f.close();}
  const before=await readdir(folder);
  const save=()=>m.withDownloadFile(base+'/sparse',async file=>{await new Promise(r=>setTimeout(r,20));await file.truncate(100000000);},100000000);
  const results=await Promise.allSettled([save(),save()]);assert.equal(results.filter(x=>x.status==='rejected').length,2);
  assert.deepEqual(await readdir(folder),before);let total=0;for(const name of await readdir(folder))total+=(await stat(join(folder,name))).size;assert.equal(total,199000000);
  const binary=()=>{let emitted=0;return new Response(new ReadableStream({pull(c){if(emitted>=100000000){c.close();return;}emitted+=1000000;c.enqueue(new Uint8Array(1000000));}}),{headers:{'content-type':'application/octet-stream'}});};
  const streams=await Promise.allSettled([m.saveBinary(binary(),base+'/stream1'),m.saveBinary(binary(),base+'/stream2')]);assert.equal(streams.filter(x=>x.status==='rejected').length,2);assert.deepEqual(await readdir(folder),before);
  const retry=await m.withDownloadFile(base+'/retry',async f=>f.write(new Uint8Array([1])),1);assert.equal(retry.fileSize,1);
 });
 // Run the remaining cases with a clean process/folder via the separate quota runner below.
}catch(e){failed++;console.log('FAIL SCAN harness',e.stack);}finally{console.log('RETAINED SCAN INSTRUMENT',instrument);}
await check('18MB direct stripping uses bounded work and timer',async()=>{
 const start=performance.now();const timer=new Promise(r=>setTimeout(()=>r(performance.now()-start),10));m.htmlToText(large);const sync=performance.now()-start,delay=await timer;console.log('LARGE SCAN MS',sync.toFixed(1),'TIMER MS',delay.toFixed(1));assert.ok(sync<100&&delay<125,`sync ${sync}, timer ${delay}`);
});
await check('comment and unfinished markup preserve preceding prose',()=>{assert.equal(m.htmlToText('before<!-- hidden -->after'),'beforeafter');assert.equal(m.htmlToText('before<!-- hidden'),'before');assert.equal(m.htmlToText('before<div x="unterminated'),'before');});
await check('Unicode folding cannot corrupt offsets',()=>{assert.equal(m.htmlToText('İ'.repeat(20)+'<script>HIDDEN</script><p>REAL</p>'),'İ'.repeat(20)+'REAL');assert.equal(m.titleOf('İ<title>REAL</title><p>BODY</p>','fallback'),'REAL');});
console.log(`SCAN CHECKS: ${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
