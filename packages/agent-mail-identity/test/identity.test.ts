import { test } from "node:test";
import assert from "node:assert/strict";
import { bindIdentity, bindingFor, initialIdentity, validateTarget } from "../src/identity.ts";
import { BindingAuthority } from "../src/authority.ts";
const target = {projectKey:"/fixture/project",agentName:"BlueLake"};
test("new state is unbound and wake disabled",()=>{assert.deepEqual(initialIdentity(),{schemaVersion:1,binding:{kind:"unbound"},wake:{state:"disabled",reason:"not_implemented"}});});
test("binding converges and cannot change project, actor or owner",()=>{
 const state=bindIdentity(initialIdentity(),1,target,"one");
 assert.equal(bindIdentity(state,1,target,"two"),state);
 assert.equal(bindingFor(state,2),undefined);
 assert.equal(bindingFor(undefined,1),undefined);
 assert.throws(()=>bindIdentity(state,1,{...target,agentName:"RedStone"},"two"),/identity_mismatch/);
 assert.throws(()=>bindIdentity(state,1,{...target,projectKey:"other"},"two"),/identity_mismatch/);
 assert.throws(()=>bindIdentity(state,2,target,"two"),/identity_owner_mismatch/);
});
test("validate target at the boundary",()=>{
 assert.deepEqual(validateTarget(target),target);
 for(const agentName of ["", " BlueLake", "BlueLake;evil", "bluelake"]){assert.throws(()=>validateTarget({...target,agentName}),/invalid_agent_name/);}
 for(const projectKey of ["", " /project", "/project\nsecret", "x".repeat(4097)]){assert.throws(()=>validateTarget({...target,projectKey}),/invalid_project_key/);}
});
test("a project key a CLI would read as an option is rejected before any argv",()=>{
 for(const projectKey of ["-project", "--json", "-x", "--", "- "]){
  assert.throws(()=>validateTarget({projectKey,agentName:"BlueLake"}),/invalid_project_key/,projectKey);
 }
 assert.deepEqual(validateTarget({projectKey:"/project-with-inner-dash",agentName:"BlueLake"}).projectKey,"/project-with-inner-dash");
 assert.throws(()=>new BindingAuthority().grant(1,{projectKey:"--json",agentName:"BlueLake"}),/invalid_project_key/);
});
