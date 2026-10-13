import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureDirectory } from "./repair-extra.inc.ts";
import { fileURLToPath } from "node:url";
import { CLI_PAGE_LIMIT_MAX, createCliTransport, readDeliveryPage, runJsonCli } from "../src/am-cli.ts";
const fixture=fileURLToPath(new URL("./fixtures/am-fixture.mjs",import.meta.url));
async function pidIn(path:string){for(let i=0;i<100;i++){try{return Number(await readFile(path,"utf8"));}catch{await new Promise(r=>setTimeout(r,10));}}throw new Error("fixture did not start");}
test("argv is not interpreted by a shell",async()=>{
 const argv=["echo","$(printf attack)","semi;colon","two words"];
 assert.deepEqual(await runJsonCli(process.execPath,[fixture,...argv]),{argv});
});
test("JSON, exit, output and config failures are bounded and sanitized",async()=>{
 assert.throws(()=>runJsonCli("node",[]),/invalid_executable/);
 assert.throws(()=>runJsonCli(process.execPath,[],{timeoutMs:5001}),/invalid_cli_limits/);
 await assert.rejects(runJsonCli(process.execPath,[fixture,"bad-json"]),/cli_invalid_json/);
 await assert.rejects(runJsonCli(process.execPath,[fixture,"overflow"],{maxBytes:4096}),/cli_output_limit/);
 await assert.rejects(runJsonCli(process.execPath,[fixture,"exit-error"]),e=>e instanceof Error && e.message==="cli_exit_failed");
 await assert.rejects(runJsonCli("/does/not/exist/am",[]),/cli_spawn_failed/);
});
test("timeout joins and leaves no process",async()=>{
 const dir=await fixtureDirectory("am-cli-timeout-");const path=join(dir,"pid");
 const pending=runJsonCli(process.execPath,[fixture,"hang",path],{timeoutMs:500});
 const rejection=assert.rejects(pending,/cli_timeout/);
 const pid=await pidIn(path);await rejection;
 assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});
});
test("abort joins and already-aborted signal never spawns",async()=>{
 const dir=await fixtureDirectory("am-cli-abort-");const path=join(dir,"pid");
 const controller=new AbortController();
 const pending=runJsonCli(process.execPath,[fixture,"hang",path],{signal:controller.signal});
 const rejection=assert.rejects(pending,/cli_aborted/);
 const pid=await pidIn(path);controller.abort();await rejection;
 assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});
 await assert.rejects(runJsonCli(process.execPath,[],{signal:controller.signal}),/cli_aborted/);
});
test("parent exit with TERM-resistant inherited-pipe child settles without waiting for the call timeout",{timeout:5000},async()=>{
 const dir=await fixtureDirectory("am-cli-tree-exit-");const path=join(dir,"pid");
 const start=performance.now();
 const pending=runJsonCli(process.execPath,[fixture,"tree-exit",path],{timeoutMs:2000});
 const rejection=assert.rejects(pending,e=>e instanceof Error && ["cli_descendant_detected","cli_cleanup_unverified"].includes(e.message));
 const pid=await pidIn(path);await rejection;
 assert.ok(performance.now()-start<1200,"must react to exit, not the 2s call deadline");
 let state:string;
 try{state=(await readFile(`/proc/${pid}/stat`,"utf8")).split(") ")[1].split(" ")[0];}catch{state="absent";}
 assert.ok(state==="Z" || state==="absent",`descendant still executing: ${state}`);
 console.log(JSON.stringify({fixture:dir,pid,state,reaped:state==="absent"}));
});

test("abort and timeout stop TERM-resistant process groups with independent reap evidence",{timeout:10000},async()=>{
 for(const mode of ["abort","timeout","reap"]){
  const dir=await fixtureDirectory(`am-cli-tree-${mode}-`);const path=join(dir,"pid");
  const controller=new AbortController();const start=performance.now();let code="";
  const pending=runJsonCli(process.execPath,[fixture,mode==="reap"?"tree-reap":"tree-hang",path],{signal:controller.signal,timeoutMs:mode==="timeout"?500:2000});
  const observed=pending.catch(error=>{code=error.message;});
  const leaf=await pidIn(path),parent=await pidIn(path+".parent");
  if(mode!=="timeout")controller.abort();await observed;
  assert.ok(["cli_aborted","cli_timeout","cli_cleanup_unverified"].includes(code),code);
  assert.ok(performance.now()-start<1500,"bounded settlement");
  const states:Record<string,string>={};
  for(const pid of [parent,leaf]){try{states[pid]=(await readFile(`/proc/${pid}/stat`,"utf8")).split(") ")[1].split(" ")[0];}catch{states[pid]="absent";}}
  assert.ok(Object.values(states).every(state=>state==="Z"||state==="absent"),JSON.stringify(states));
  const reaped=Object.values(states).every(state=>state==="absent");
  if(!reaped)assert.equal(code,"cli_cleanup_unverified","zombies are not proven reaped");
  if(mode==="reap")assert.equal(reaped,true,"cooperative parent must reap its child");
  console.log(JSON.stringify({fixture:dir,mode,code,parent,leaf,states,reaped}));
 }
});

test("synchronous spawn exceptions do not expose injected configuration errors",async()=>{
 const secret="SENTINEL_SPAWN_SECRET";
 const env=Object.defineProperty({},"BAD",{enumerable:true,get(){throw new Error(secret);}});
 await assert.rejects(runJsonCli(process.execPath,[fixture],{env}),error=>error instanceof Error&&error.message==="cli_spawn_failed");
});

test("CLI profile confirms exact existing identity, never registers",async()=>{
 const target={projectKey:"/fixture/project",agentName:"BlueLake"};
 const cli=createCliTransport(fixture);assert.deepEqual(await cli.profile(target),{name:"BlueLake"});
 await assert.rejects(createCliTransport(fixture,{env:{AM_FIXTURE_MODE:"mismatch"}}).profile(target),/identity_mismatch/);
 await assert.rejects(createCliTransport(fixture,{env:{AM_FIXTURE_MODE:"inactive"}}).profile(target),/identity_inactive/);
});
test("child environment is an allowlist, never the whole process environment",async()=>{
 const target={projectKey:"/fixture/project",agentName:"BlueLake"};
 const previous={sentinel:process.env.AM_TEST_SENTINEL,secret:process.env.SECRET_TOKEN,mail:process.env.AGENT_MAIL_PROJECT};
 process.env.AM_TEST_SENTINEL="sentinel";process.env.SECRET_TOKEN="secret";process.env.AGENT_MAIL_PROJECT="/fixture/project";
 try{
  assert.deepEqual(await runJsonCli(process.execPath,[fixture,"env-echo"],{env:{AM_EXPLICIT:"explicit"}}),{
   path:true,home:true,sentinel:false,secret:false,agentMail:true,explicit:"explicit",
  });
 } finally {
  for(const [name,value] of [["AM_TEST_SENTINEL",previous.sentinel],["SECRET_TOKEN",previous.secret],["AGENT_MAIL_PROJECT",previous.mail]] as const){
   if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
 }
 console.log(JSON.stringify({allowlist:["PATH","HOME","AGENT_MAIL_*","options.env"]}));
});

/* ----------------------------------------------------------------------------------------------------------------
 * CLI delivery listing: `am inbox-events` over the contract read from the live CLI.
 * -------------------------------------------------------------------------------------------------------------- */

const page = (id: number, messageId: number) => ({cursor:id,message_id:messageId,kind:"to",delivered_ts:"2026-10-12T16:56:12.035902Z",subject:"subject "+id,from:"FrostyRobin",importance:"normal",ack_required:false});

async function mailboxFixture(seed: unknown, suffix: string) {
 const dir=await fixtureDirectory("am-inbox-events-"+suffix+"-");
 const mailbox=join(dir,"mailbox.json");const log=join(dir,"effects.log");
 await writeFile(mailbox,JSON.stringify(seed));
 return {dir,mailbox,log,
  transport:(options: Parameters<typeof createCliTransport>[1] = {}) => createCliTransport(fixture,{...options,env:{AM_FIXTURE_MAILBOX:mailbox,AM_FIXTURE_EFFECT_LOG:log,...options.env}}),
  async effects(){try{return (await readFile(log,"utf8")).trim().split("\n");}catch{return [];}}};
}
const listingTarget={projectKey:"/home/ubuntu/Projects/pi-pocket-sandbox",agentName:"BlueLake"};

test("CLI poll reads a bounded page of the verified contract and never marks mail read",async()=>{
 const f=await mailboxFixture({events:[page(11713,8244),page(11714,8245),page(11715,8246)],tail_cursor:11715,oldest_available_cursor:11713},"page");
 const transport=f.transport({pageLimit:2});
 assert.ok(transport.poll);
 // A null cursor asks for the current position, not the backlog: the mailbox answers with its durable tail.
 const now=await transport.poll(listingTarget,null);
 assert.deepEqual(now,{events:[],cursor:"11715"});
 assert.deepEqual(await f.effects(),["inbox-events:position-now:limit=100"]);
 const first=await transport.poll(listingTarget,"11713");
 assert.deepEqual(first,{events:[
  {eventId:"11714",messageId:"8245",cursor:"11714",from:"FrostyRobin",subject:"subject 11714",body:null,createdAt:Date.parse("2026-10-12T16:56:12.035902Z")},
  {eventId:"11715",messageId:"8246",cursor:"11715",from:"FrostyRobin",subject:"subject 11715",body:null,createdAt:Date.parse("2026-10-12T16:56:12.035902Z")},
 ],cursor:"11715"});
 const repeated=await transport.poll(listingTarget,"11715");
 assert.equal(repeated.events.length,0);
 assert.equal(repeated.cursor,"11715");
 const effects=await f.effects();
 assert.equal(effects.length,3);
 assert.ok(effects.every(name=>name.startsWith("inbox-events:")),"monitoring must only ever read: "+JSON.stringify(effects));
 assert.ok(!effects.some(name=>name.includes("mark-read")));
 console.log(JSON.stringify({fixture:f.dir,pages:2,effects:effects.length}));
});

test("an empty position-now read adopts the durable tail and an old cursor is refused instead of skipping",async()=>{
 const f=await mailboxFixture({events:[page(11713,8244),page(11714,8245)],tail_cursor:11902,oldest_available_cursor:11713},"tail");
 const transport=f.transport();
 assert.ok(transport.poll);
 const now=await transport.poll(listingTarget,null);
 assert.deepEqual(now,{events:[],cursor:"11902"});
 await assert.rejects(transport.poll(listingTarget,"11700"),/watch_cursor_expired/);
 await assert.rejects(transport.poll(listingTarget,"1"),/watch_cursor_expired/);
 assert.equal((await f.effects()).filter(name=>name.includes("mark-read")).length,0);
});

test("a page that carries events without a usable oldest position fails closed",async()=>{
 // Defence in depth: the live listing always reports `oldest_available_cursor`, and without it a page that starts
 // after the requested cursor cannot be told apart from a page that skipped events.
 assert.throws(()=>readDeliveryPage({events:[{cursor:6,message_id:1}],next_cursor:6},"5"),/invalid_delivery_page/);
 assert.throws(()=>readDeliveryPage({events:[{cursor:6,message_id:1}],next_cursor:6,oldest_available_cursor:"oldest"},"5"),/invalid_delivery_page/);
 assert.throws(()=>readDeliveryPage({events:[{cursor:6,message_id:1}],next_cursor:6,oldest_available_cursor:1.5},"5"),/invalid_delivery_page/);
 assert.throws(()=>readDeliveryPage({events:[{cursor:6,message_id:1}],next_cursor:6,oldest_available_cursor:-1},"5"),/invalid_delivery_page/);
 // A page that carries nothing reports no position to trust, so it is unaffected.
 assert.deepEqual(readDeliveryPage({events:[],next_cursor:7,oldest_available_cursor:"oldest"},"5"),{events:[],cursor:"7"});
 assert.deepEqual(readDeliveryPage({events:[],next_cursor:7},"5"),{events:[],cursor:"7"});
 // The packaged transport reaches the same refusal end to end. A position-now read carries no events, so the missing
 // field cannot matter there and it is unaffected.
 const f=await mailboxFixture({events:[page(5,9)],tail_cursor:5,omit_oldest:true},"omit-oldest");
 const transport=f.transport();
 assert.ok(transport.poll);
 assert.deepEqual(await transport.poll(listingTarget,null),{events:[],cursor:"5"});
 await assert.rejects(transport.poll(listingTarget,"4"),/invalid_delivery_page/);
 console.log(JSON.stringify({fixture:f.dir,refused:6}));
});

test("CLI listing failures fail closed: malformed JSON, unexpected shape, nonzero exit, junk cursor",async()=>{
 const malformed=await mailboxFixture({events:[],malformed:true},"malformed");
 const bad=await mailboxFixture({events:[],shape:true},"shape");
 const exited=await mailboxFixture({events:[],exit:3},"exit");
 for(const [f,code] of [[malformed,/cli_invalid_json/],[bad,/invalid_delivery_page/],[exited,/cli_exit_failed/]] as const){
  const transport=f.transport();
  await assert.rejects(transport.poll!(listingTarget,null),code);
  await assert.rejects(transport.poll!(listingTarget,"-5"),/invalid_watch_cursor/);
  await assert.rejects(transport.poll!(listingTarget,"cursor-1"),/invalid_watch_cursor/);
 }
 const good=await mailboxFixture({events:[page(5,9)],tail_cursor:5,oldest_available_cursor:5},"strict");
 assert.throws(()=>createCliTransport(fixture,{pageLimit:0}),/invalid_cli_limits/);
 assert.throws(()=>createCliTransport(fixture,{pageLimit:CLI_PAGE_LIMIT_MAX+1}),/invalid_cli_limits/);
 assert.ok(good.transport({pageLimit:CLI_PAGE_LIMIT_MAX}).poll);
 assert.throws(()=>readDeliveryPage({events:[{cursor:9,message_id:1},{cursor:9,message_id:2}]},"5"),/invalid_delivery_page/);
 assert.throws(()=>readDeliveryPage({events:[{cursor:4,message_id:1}]},"5"),/invalid_delivery_page/);
 assert.throws(()=>readDeliveryPage({events:[{cursor:6,message_id:"x"}]},null),/invalid_delivery_page/);
 assert.throws(()=>readDeliveryPage({events:[{cursor:6,message_id:1,subject:7}]},null),/invalid_delivery_page/);
 console.log(JSON.stringify({fixtures:[malformed.dir,bad.dir,exited.dir,good.dir]}));
});
