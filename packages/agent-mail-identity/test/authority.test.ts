import { test } from "node:test";
import assert from "node:assert/strict";
import { BindingAuthority } from "../src/authority.ts";
const target={projectKey:"fixture",agentName:"BlueLake"};
test("queued admission captures its target instead of reading a mutable caller object",async()=>{
 const authority=new BindingAuthority();await authority.grant(1,target);
 const mutable={...target,agentName:"RedStone"};
 const denied=assert.rejects(authority.admit(1,mutable,async()=>{throw new Error("must not commit");}),/binding_not_authorized/);
 mutable.agentName="BlueLake";await denied;
 const restarted=new BindingAuthority();await assert.rejects(restarted.admit(1,target,async()=>{}),/binding_not_authorized/);
});
test("revocation cannot complete while an admitted binding commit is pending",async()=>{
 const authority=new BindingAuthority();await authority.grant(1,target);
 let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
 const events:string[]=[];
 const bind=authority.admit(1,target,async()=>{entered();await pending;events.push("commit");});
 await started;const revoke=authority.revoke(1).then(()=>{events.push("revoked");});
 await Promise.resolve();assert.deepEqual(events,[]);release();await Promise.all([bind,revoke]);
 assert.deepEqual(events,["commit","revoked"]);
 await assert.rejects(authority.admit(1,target,async()=>{throw new Error("must not commit");}),/binding_not_authorized/);
});
test("queued admission checks current grant, scope, actor and cancellation",async()=>{
 const authority=new BindingAuthority();await authority.grant(1,target);
 await assert.rejects(authority.admit(2,target,async()=>{}),/binding_not_authorized/);
 await assert.rejects(authority.admit(1,{...target,agentName:"RedStone"},async()=>{}),/binding_not_authorized/);
 await assert.rejects(authority.admit(1,{...target,projectKey:"other"},async()=>{}),/binding_not_authorized/);
 const revoke=authority.revoke(1);const denied=assert.rejects(authority.admit(1,target,async()=>{}),/binding_not_authorized/);await Promise.all([revoke,denied]);
 await authority.grant(1,target);const controller=new AbortController();controller.abort();
 await assert.rejects(authority.admit(1,target,async()=>{},controller.signal),/binding_aborted/);
 assert.throws(()=>authority.grant(0,target),/invalid_conversation_id/);
});
