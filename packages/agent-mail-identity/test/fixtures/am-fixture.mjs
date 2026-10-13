#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const args=process.argv.slice(2);
const effect=(name)=>{if(process.env.AM_FIXTURE_EFFECT_LOG)appendFileSync(process.env.AM_FIXTURE_EFFECT_LOG,name+"\n");};
if(args[0]==="tree-leaf"){
 process.on("SIGTERM",()=>{});
 writeFileSync(args[1],String(process.pid));
 process.send?.("ready");
 setTimeout(()=>process.exit(0),3000);
}
else if(args[0]==="tree-exit" || args[0]==="tree-hang" || args[0]==="tree-reap"){
 writeFileSync(args[1]+".parent",String(process.pid));
 const leaf=spawn(process.execPath,[fileURLToPath(import.meta.url),"tree-leaf",args[1]],{stdio:["ignore","inherit","inherit","ipc"]});
 const lifetime=setTimeout(()=>{leaf.kill("SIGKILL");},3500);
 leaf.on("close",()=>{clearTimeout(lifetime);process.exit(0);});
 if(args[0]==="tree-reap")process.on("SIGTERM",()=>leaf.kill("SIGKILL"));
 else process.on("SIGTERM",()=>{});
 leaf.on("message",()=>{if(args[0]==="tree-exit")process.exit(0);});
}
else if(args[0]==="hang"){writeFileSync(args[1],String(process.pid));setTimeout(()=>process.exit(0),3000);}
else if(args[0]==="overflow"){process.stdout.write("x".repeat(300000));}
else if(args[0]==="bad-json"){process.stdout.write("not JSON");}
else if(args[0]==="exit-error"){process.stderr.write("PRIVATE_VALUE_NOT_FOR_ERRORS");process.exitCode=2;}
else if(args[0]==="agents" && args[1]==="show"){
 const name=process.env.AM_FIXTURE_MODE==="mismatch" ? "RedStone" : args.at(-1);
 process.stdout.write(JSON.stringify({name,is_active:process.env.AM_FIXTURE_MODE!=="inactive"}));
}
else if(args[0]==="delivery" && args[1]==="list"){
 // Read-only listing: it writes an effect-log line and never marks any message read or acknowledged.
 effect("list"+(args[2]?":"+args[2]:""));
 const page=process.env.AM_FIXTURE_MAILBOX ? JSON.parse(readFileSync(process.env.AM_FIXTURE_MAILBOX,"utf8")) : {events:[]};
 process.stdout.write(JSON.stringify(page));
}
else if(args[0]==="inbox-events"){
 // Emulates the verified read-only `am inbox-events` contract: --after <cursor>, --limit 1..1000, --position-now,
 // --json, and the exact response fields (events[].cursor/message_id/kind/delivered_ts/subject/from/
 // importance/ack_required, next_cursor, has_more, oldest_available_cursor, tail_cursor).
 const flag=(name)=>args.includes(name);
 const value=(name)=>{const at=args.indexOf(name);return at>=0?args[at+1]:undefined;};
 const after=value("--after");
 const limit=Number(value("--limit")??"100");
 const positionNow=flag("--position-now");
 effect("inbox-events:"+(positionNow?"position-now":`after=${after}`)+`:limit=${limit}`);
 const seed=process.env.AM_FIXTURE_MAILBOX ? JSON.parse(readFileSync(process.env.AM_FIXTURE_MAILBOX,"utf8")) : {events:[]};
 if(seed.malformed){process.stdout.write("not JSON");process.exit(0);}
 if(seed.exit){process.stderr.write("PRIVATE_VALUE_NOT_FOR_ERRORS");process.exit(seed.exit);}
 if(seed.shape){process.stdout.write(JSON.stringify({events:"not-an-array"}));process.exit(0);}
 const all=seed.events??[];
 const tail=seed.tail_cursor??(all.length?all.at(-1).cursor:0);
 const oldest=seed.oldest_available_cursor??(all.length?all[0].cursor:0);
 // `omit_oldest` emulates a listing that serves events without reporting the oldest position it still keeps.
 const oldestField=seed.omit_oldest===true?{}:{oldest_available_cursor:oldest};
 if(positionNow){
  process.stdout.write(JSON.stringify({events:[],next_cursor:tail,has_more:false,...oldestField,tail_cursor:tail}));
 }
 else{
  const from=after===undefined?0:Number(after);
  const events=all.filter(entry=>entry.cursor>from).slice(0,Number.isSafeInteger(limit)&&limit>0?limit:100);
  const next=events.length?events.at(-1).cursor:(after===undefined?tail:from);
  process.stdout.write(JSON.stringify({events,next_cursor:next,has_more:events.length>0&&next<tail,...oldestField,tail_cursor:tail}));
 }
}
else if((args[0]==="delivery" && args[1]==="mark-read") || args[0]==="mark-all-read" || (args[0]==="mail" && args[1]==="ack") || (args[0]==="mail" && args[1]==="read")){
 // The real read-marking commands (`am mark-all-read`, `am mail ack`, `am mail read`). Monitoring must never issue
 // one; the fixture records it if anything ever calls it, so the detector is not vacuous.
 effect(args.join("-"));
 process.stdout.write(JSON.stringify({marked:true}));
}
else if(args[0]==="env-echo"){
 process.stdout.write(JSON.stringify({
  path:typeof process.env.PATH==="string",
  home:typeof process.env.HOME==="string",
  sentinel:typeof process.env.AM_TEST_SENTINEL==="string",
  secret:typeof process.env.SECRET_TOKEN==="string",
  agentMail:typeof process.env.AGENT_MAIL_PROJECT==="string",
  explicit:process.env.AM_EXPLICIT??null,
 }));
}
else {process.stdout.write(JSON.stringify({argv:args}));}
