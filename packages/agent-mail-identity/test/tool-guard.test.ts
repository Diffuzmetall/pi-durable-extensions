import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { bindIdentity, initialIdentity } from "../src/identity.ts";
import { AGENT_MAIL_PREFIX as P, guardMailCall, MAIL_OPERATION_POLICY } from "../src/tool-guard.ts";
const state=bindIdentity(initialIdentity(),1,{projectKey:"fixture",agentName:"BlueLake"},"one");
const denied=["ensure_project","register_agent","create_agent_identity","retire_agent","unretire_agent","deregister_agent","resolve_pane_identity","cleanup_pane_identities","request_contact","force_release_file_reservation","install_precommit_guard","uninstall_precommit_guard","macro_start_session","macro_prepare_thread","macro_contact_handshake","ensure_product","products_link","search_messages_product","fetch_inbox_product","summarize_thread_product"];
test("inspected native MCP source snapshot matches all policy operations and acting-field schemas",async()=>{
 const moduleUrl=new URL("../../../../pi-durable-agent-mail/src/index.ts",import.meta.url);
 const source=await readFile(moduleUrl,"utf8");
 const match=source.match(/const SPECS = (\[[\s\S]*?\n\]);/);assert.ok(match,"literal catalog boundary");
 const specs=runInNewContext(`(${match[1]})`,Object.create(null),{timeout:100,contextCodeGeneration:{strings:false,wasm:false}});
 assert.equal(specs.length,45);
 const names=specs.map((tool:{name:string})=>tool.name);
 assert.deepEqual(new Set(names),new Set([...Object.keys(MAIL_OPERATION_POLICY.actors),...MAIL_OPERATION_POLICY.projectReads,...denied,"health_check"]));
 for(const spec of specs){
  const op=spec.name;const actor=MAIL_OPERATION_POLICY.actors[op];
  if(actor){assert.ok(spec.inputSchema.properties[actor].type.includes("string"),op);assert.ok(spec.inputSchema.required.includes(actor),op);}
  if(op!=="health_check"&&!denied.includes(op))assert.equal(spec.inputSchema.properties.project_key.type,"string",op);
 }
 assert.ok(source.includes('replay: spec.name === "health_check" ? "safe" : "unsafe"'));
});

test("45 catalog operations have an explicit classification",()=>{
 assert.equal(Object.keys(MAIL_OPERATION_POLICY.actors).length+MAIL_OPERATION_POLICY.projectReads.length+denied.length+1,45);
 for(const op of denied){assert.equal(guardMailCall(P+op,{project_key:"fixture",agent_name:"BlueLake",name:"BlueLake"},state,1),"mail_operation_not_permitted",op);}
 assert.equal(guardMailCall(P+"unknown_operation",{},state,1),"mail_operation_not_permitted");
 assert.equal(guardMailCall(P+"__send_message",{},state,1),"mail_operation_not_permitted");
});
test("each acting field is checked, other projects and unbound forks blocked",()=>{
 for(const [operation,key] of Object.entries(MAIL_OPERATION_POLICY.actors)){
  const args={project_key:"fixture",[key]:"BlueLake"};
  assert.equal(guardMailCall(P+operation,args,state,1),undefined,operation);
  assert.equal(guardMailCall(P+operation,{...args,[key]:"RedStone"},state,1),"identity_mismatch",operation);
  assert.equal(guardMailCall(P+operation,{project_key:"fixture"},state,1),"identity_mismatch",operation);
  assert.equal(guardMailCall(P+operation,{...args,project_key:"other"},state,1),"project_mismatch",operation);
  assert.equal(guardMailCall(P+operation,args,state,2),"identity_unbound",operation);
 }
});
test("recipient, lookup and search filter are not acting identities",()=>{
 assert.equal(guardMailCall(P+"send_message",{project_key:"fixture",sender_name:"BlueLake",to:["RedStone"],cc:["WhiteBird"]},state,1),undefined);
 assert.equal(guardMailCall(P+"respond_contact",{project_key:"fixture",to_agent:"BlueLake",from_agent:"RedStone"},state,1),undefined);
 for(const op of ["whois","list_contacts","search_messages"]){assert.equal(guardMailCall(P+op,{project_key:"fixture",agent_name:"RedStone",sender_name:"RedStone"},state,1),undefined);}
});
test("credential-bearing arguments and malformed calls fail closed",()=>{
 assert.equal(guardMailCall(P+"send_message",{project_key:"fixture",sender_name:"BlueLake",sender_token:"secret"},state,1),"model_credentials_not_permitted");
 assert.equal(guardMailCall(P+"send_message",[],state,1),"invalid_mail_arguments");
 assert.equal(guardMailCall(P+"fetch_inbox",{},undefined,1),"identity_unbound");
 assert.equal(guardMailCall(P+"health_check",{},undefined,1),undefined);
 assert.equal(guardMailCall("other_tool",{},undefined,1),undefined);
});
