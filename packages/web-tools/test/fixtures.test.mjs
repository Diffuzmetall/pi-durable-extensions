import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import {registerHooks} from 'node:module';
import {readFile,writeFile,mkdir,mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const missing=process.env.NO_OPTIONALS==='1'?['wreq-js','linkedom','defuddle/node']:(process.env.NO_OPTIONALS??'').split(',');
// A fresh temp root per run: the module writes downloads under os.tmpdir(), and a shared
// folder would carry a previous run's bytes into this one's budget.
process.env.TMPDIR = await mkdtemp(join(tmpdir(), 'web-tools-test-'));
let nativeForBinaryCap=false;
registerHooks({resolve(s,c,n){if(missing.includes(s)||(nativeForBinaryCap&&s==='wreq-js'))throw Error('disabled optional');return n(s,c);}});
const m=await import(process.env.WEB_TOOLS??new URL('../src/web-tools.ts',import.meta.url).href);
const plain='a < b and c > d &amp; literal';
const json=JSON.stringify({value:'<secret>keep</secret>',amp:'&amp;'});
const pdf=Buffer.from('%PDF-1.7\n\x00\xff\xfe compressed <data> binary','latin1');
let active=0,peak=0;const hits=[];const closed=new Set();
const server=http.createServer((req,res)=>{
 hits.push(req.url);active++;peak=Math.max(active,peak);
 res.on('close',()=>{active--;closed.add(req.url);});
 res.setHeader('content-type','text/html');
 const html=(extra='',text='Stay here')=>`<html><head><title>Fixture title</title>${extra}</head><body><article><p>${text}</p></article></body></html>`;
 if(req.url==='/plain'){res.setHeader('content-type','text/plain');res.end(plain);}
 else if(req.url==='/json'){res.setHeader('content-type','application/problem+json');res.end(json);}
 else if(req.url==='/charset'){res.setHeader('content-type','text/plain; charset=windows-1252');res.end(Buffer.from([99,97,102,233]));}
 else if(req.url==='/pdf'){res.setHeader('content-type','application/pdf');res.end(pdf);}
 else if(req.url==='/chunk'||req.url==='/oversized-file'){
  res.setHeader('content-type',req.url==='/chunk'?'text/plain':'application/octet-stream');
  const chunk=Buffer.alloc(128*1024,120);let size=0;const max=req.url==='/chunk'?22_000_000:501_000_000;
  function send(){if(res.destroyed)return;while(size<max){size+=chunk.length;if(!res.write(chunk)){res.once('drain',send);return;}}res.end();}send();
 }
 else if(req.url==='/gzip'){res.setHeader('content-type','text/plain');const b=zlib.gzipSync(Buffer.alloc(21_000_000,120));res.setHeader('content-encoding','gzip');res.setHeader('content-length',b.length);res.end(b);}
 else if(req.url==='/declared'){res.setHeader('content-length',90000000);res.write('a');const t=setTimeout(()=>res.end(),1000);res.on('close',()=>clearTimeout(t));}
 else if(req.url==='/404'){res.writeHead(404);res.write('not found');const t=setTimeout(()=>res.end(),1000);res.on('close',()=>clearTimeout(t));}
 else if(req.url==='/comment')res.end(html('<!-- <meta http-equiv="refresh" content="0;url=/landing"> -->'));
 else if(req.url==='/script')res.end(html('<script>const sample=\'<meta http-equiv="refresh" content="0;url=/landing">\';</script>'));
 else if(req.url==='/style'||req.url==='/noscript'||req.url==='/template'){const tag=req.url.slice(1);res.end(html(`<${tag}><meta http-equiv="refresh" content="0;url=/landing"></${tag}>`));}
 else if(req.url==='/thin')res.end(html('<link rel="alternate" type="text/markdown" href="/alternate">'));
 else if(req.url==='/full')res.end(html('<link rel="alternate" type="text/markdown" href="/alternate">','Substantial content. '.repeat(40)));
 else if(req.url==='/thin-text')res.end(html('<link rel="alternate" type="text/plain" href="/alternate">'));
 else if(req.url==='/thin-json')res.end(html('<link rel="alternate" type="application/json" href="/json">'));
 else if(req.url==='/wrong')res.end(html('<link rel="alternate" type="application/json" href="/alternate">'));
 else if(req.url==='/short')res.end(html('<link rel="alternate" type="text/markdown" href="/short-alt">'));
 else if(req.url==='/short-alt'){res.setHeader('content-type','text/markdown');res.end('x');}
 else if(req.url==='/alternate'){res.setHeader('content-type','text/markdown');res.end('# Alternate\n'+'Alternate text content. '.repeat(25));}
 else if(req.url==='/article'){res.end(`<html><head><title>Article page</title></head><body><nav>Site navigation</nav><article><p>${'Article body text. '.repeat(40)}</p></article><footer>Site footer</footer></body></html>`);}
 else if(req.url==='/long'){res.setHeader('content-type','text/plain');res.end('x'.repeat(100000));}
 else if(req.url==='/textarea')res.end(html('<textarea><meta http-equiv="refresh" content="0;url=/landing"></textarea>'));
 else if(req.url==='/attr')res.end(html(`<div data-x='<meta http-equiv="refresh" content="0;url=/landing">'>inline</div>`));
 else if(req.url==='/unclosed-comment')res.end(`<html><head><title>Fixture title</title></head><body><article><p>Stay here</p></article><!-- <meta http-equiv="refresh" content="0;url=/landing">`);
 else if(req.url==='/wrong-type')res.end(html('<link rel="alternate" type="text/markdown" href="/css">'));
 else if(req.url==='/css'){res.setHeader('content-type','text/css');res.end('.a{color:red}'.repeat(50));}
 else res.end(html('', 'Content has <b>bold</b> &amp; prose.'));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));server.unref();const base=`http://127.0.0.1:${server.address().port}`;
const fetch=(route,format)=>m.fetchPage(base+route,1000,format);
let failures=0,passed=0;
async function check(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(e){failures++;console.error('FAIL',name,e.message);}}
async function waitClosed(route){for(let i=0;i<50&&!closed.has(route);i++)await new Promise(r=>setTimeout(r,10));assert.ok(closed.has(route),'connection closed: '+route);}
try{
 await check('chunked decoded cap and cancellation',async()=>{await assert.rejects(fetch('/chunk'),/20(?:000000| MB)/);await waitClosed('/chunk');});
 await check('gzip expanded cap',()=>assert.rejects(fetch('/gzip'),/20(?:000000| MB)/));
 await check('declared cap and cancellation',async()=>{await assert.rejects(fetch('/declared'),/20(?:000000| MB)/);await waitClosed('/declared');});
 await check('plain text exact in all formats',async()=>{for(const f of ['markdown','html','text','raw']){const p=await fetch('/plain',f);assert.equal(p.text,plain);assert.equal(m.renderPage(p),plain);assert.equal(p.title,base+'/plain');}});
 await check('JSON tag strings intact and valid json format',async()=>{assert.equal((await fetch('/json')).text,json);assert.deepEqual(JSON.parse((await fetch('/json','json')).text),JSON.parse(json));});
 await check('header charset decoding',async()=>assert.equal((await fetch('/charset')).text,'café'));
 await check('binary saved exact with path/type/size',async()=>{const p=await fetch('/pdf');assert.ok(p.filePath?.startsWith(join(tmpdir(),'pi-durable-web-tools')));assert.deepEqual(await readFile(p.filePath),pdf);assert.equal(p.fileSize,pdf.length);assert.match(m.renderPage(p),/application\/pdf/);assert.ok(m.renderPage(p).includes(p.filePath));assert.ok(m.renderPage(p).includes(pdf.length+' bytes'));});
 await check('binary cap cancels and removes partial',async()=>{const dir=join(tmpdir(),'pi-durable-web-tools');const before=await readdir(dir);
  // Quota rejects this stream at 200MB, not near its 501MB end. wreq-js retains cancelled
  // streaming sockets (its documented drain-cap boundary); native fetch proves cancellation.
  nativeForBinaryCap=true;try{await assert.rejects(fetch('/oversized-file'),/500(?:000000| MB)|download folder budget/);}finally{nativeForBinaryCap=false;}
  await waitClosed('/oversized-file');assert.deepEqual(await readdir(dir),before);
 });
 await check('HTML formats source/text/json/raw',async()=>{const thinHtml=m.renderPage(await fetch('/html','html'));assert.match(thinHtml,/^no article was found/,'thin page says it is showing the source');assert.match(thinHtml,/<html>.*<b>bold<\/b>/);assert.match(m.renderPage(await fetch('/html','raw')),/^<html>.*<b>bold<\/b>/,'raw is the source with nothing in front');const p=await fetch('/html','text');assert.match(p.text,/Content has bold & prose/);assert.doesNotMatch(p.text,/<b>/);const j=JSON.parse(m.renderPage(await fetch('/html','json')));assert.equal(j.url,base+'/html');assert.equal(j.finalUrl,j.url);assert.equal(j.title,'Fixture title');assert.equal(j.contentType,'text/html');assert.equal(j.extractor,'built-in');assert.match(j.text,/bold & prose/);const non=JSON.parse((await fetch('/plain','json')).text);assert.equal(non.text,plain);});
 await check('thin markdown alternate only and provenance',async()=>{const start=hits.length;const p=await fetch('/thin');assert.match(p.text,/Alternate text/);assert.equal(p.sourceUrl,base+'/alternate');assert.ok(m.renderPage(p).includes(base+'/alternate'));assert.equal(hits.slice(start).filter(h=>h==='/alternate').length,1);await fetch('/full');assert.equal(hits.slice(start).filter(h=>h==='/alternate').length,1);});
 await check('text/json alternate and wrong/short leave original',async()=>{const p=await fetch('/thin-text','text');assert.match(p.text,/Alternate text/);assert.ok(m.renderPage(p).includes(base+'/alternate'));assert.deepEqual(JSON.parse((await fetch('/thin-json','json')).text),JSON.parse(json));const n=hits.filter(h=>h==='/alternate').length;assert.match((await fetch('/wrong')).text,/Stay here/);assert.equal(hits.filter(h=>h==='/alternate').length,n);assert.match((await fetch('/short')).text,/Stay here/);});
 await check('inert refresh never follows',async()=>{for(const r of ['/comment','/script','/style','/noscript','/template']){const p=await fetch(r);assert.equal(p.finalUrl,base+r);assert.match(p.text,/Stay here/);}assert.ok(!hits.includes('/landing'));});
 await check('404 once and same-host queue cancellation',async()=>{peak=0;const before=hits.filter(h=>h==='/404').length;await assert.rejects(fetch('/404'),/HTTP 404/);await fetch('/ok');await waitClosed('/404');assert.equal(hits.filter(h=>h==='/404').length,before+1);assert.equal(peak,1);});
 await check('async settings project/clamp/junk',async()=>{const root=await mkdtemp(join(tmpdir(),'web-settings-'));await mkdir(join(root,'.pi'));await writeFile(join(root,'settings.json'),'{"smartWebSearch":{"resultsPerQuery":4}}');await writeFile(join(root,'.pi','settings.json'),'{"smartWebSearch":{"resultsPerQuery":2}}');const promise=m.loadResultsPerQuery(root,root);assert.ok(promise instanceof Promise);assert.equal(await promise,2);await writeFile(join(root,'.pi','settings.json'),'{"smartWebSearch":{"resultsPerQuery":99}}');assert.equal(await m.loadResultsPerQuery(root,root),10);await writeFile(join(root,'settings.json'),'junk');await writeFile(join(root,'.pi','settings.json'),'junk');assert.equal(await m.loadResultsPerQuery(root,root),5);});
 await check('DDG sponsored excluded before ranking/extraction',async()=>{const original=globalThis.fetch;globalThis.fetch=async()=>new Response('<html><head></head><body><div class="result result--ad"><a class="result__a" href="https://ad.example">Sponsored poison</a></div><div class="result result--sponsored"><a class="result__a" href="https://ad2.example">Sponsored poison two</a></div><div class="result"><a class="result__a" href="https://organic.example">Organic fixture</a><a class="result__snippet">Organic preview</a></div></body></html>',{headers:{'content-type':'text/html'}});try{const p=await m.duckDuckGo('fixture',1);assert.deepEqual(p.links,[{title:'Organic fixture',url:'https://organic.example',...(p.links[0]?.snippet?{snippet:'Organic preview'}:{})}]);assert.doesNotMatch(p.markdown,/poison|ad\.example|ad2\.example/);}finally{globalThis.fetch=original;}});
 await check('format html is cleaned markup, raw is the source',async()=>{const cleaned=m.renderPage(await fetch('/article','html'));assert.match(cleaned,/Article body text/);assert.doesNotMatch(cleaned,/<nav|Site navigation|Site footer/);const source=m.renderPage(await fetch('/article','raw'));assert.match(source,/^<html>/);assert.match(source,/Site navigation/);});
 await check('nothing exceeds maxChars and json stays valid',async()=>{const p=await fetch('/long','text');assert.ok(m.renderPage(p).length<=1000);assert.ok(p.text.length>0&&p.text.length<1000);assert.equal(p.truncated,true);assert.ok(p.filePath?.startsWith(join(tmpdir(),'pi-durable-web-tools')));assert.equal((await readFile(p.filePath,'utf8')).length,100000);const j=JSON.parse(m.renderPage(await fetch('/long','json')));assert.equal(j.truncated,true);assert.ok(j.text.length>0&&j.text.length<1000);assert.ok(JSON.stringify(j).length<=1000);assert.ok(j.filePath);const r=await fetch('/long','raw');assert.ok(r.text.length<=1000);assert.equal(r.truncated,true);});
 await check('inert markup never redirects',async()=>{for(const r of ['/textarea','/attr','/unclosed-comment']){const p=await fetch(r);assert.equal(p.finalUrl,base+r,'final url for '+r);assert.match(p.text,/Stay here/,'text for '+r);}assert.ok(!hits.includes('/landing'));});
 await check('an alternate of the wrong type is refused',async()=>{const p=await fetch('/wrong-type');assert.match(p.text,/Stay here/);assert.equal(p.sourceUrl,undefined);assert.ok(hits.includes('/css'));});
}finally{console.log('RETAINED FIXTURE SERVER ARTIFACTS; no file cleanup performed');}
console.log(`FIXTURE CHECKS: ${passed} passed, ${failures} failed`);if(failures)process.exitCode=1;
// New regressions run against the same candidate, with a fresh private quota directory.
const {execFile}=await import('node:child_process');
const {fileURLToPath}=await import('node:url');
const scratch=await mkdtemp(join(tmpdir(),'web-tools-scan-'));
await new Promise((resolve)=>execFile(process.execPath,[fileURLToPath(new URL('./scan.test.mjs',import.meta.url))],{env:{...process.env,TMPDIR:scratch,WEB_TOOLS:process.env.WEB_TOOLS??new URL('../src/web-tools.ts',import.meta.url).href},maxBuffer:1000000},(error,out,err)=>{process.stdout.write(out);process.stderr.write(err);if(error)process.exitCode=1;resolve();}));
