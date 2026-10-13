import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask, defineTask, AssistantEntry } from "@earendil-works/pi-durable";
import type { Conversation, JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BindingAuthority, createAgentMailIdentity, guardAgentMailExtension, MailIdentityDoc, IdentityError } from "../src/index.ts";
import type { IdentityOptions } from "../src/index.ts";

async function fixture(custom?: IdentityOptions, laterHook = false, guarded = true, replaySafe = false) {
	const dir=await fixtureDirectory("am-identity-durable-");
	const path=join(dir,"session.sqlite");
	console.log(JSON.stringify({fixture:path}));
	const profiles: string[]=[];
	const effects: string[]=[];
	const settings=custom ?? {
		transport:{async profile(target){profiles.push(target.agentName);return {name:target.agentName};}},
		authority:new BindingAuthority(),
	};
	const send=defineTool({
		name:"mcp__mcp_agent_mail__send_message",
		description:"Fixture recording actual downstream execution; no network.",
		parameters:Type.Object({project_key:Type.String(),sender_name:Type.String(),to:Type.Array(Type.String())}),
		replay:replaySafe ? "safe" : "unsafe",
		async execute(args){effects.push(args.sender_name+":"+args.to.join(","));return {content:[{type:"text" as const,text:"fixture delivered"}]};},
	});
	const mail=defineExtension({name:"fixture-mail",tools:[send]});
	const identity=createAgentMailIdentity({...settings,mailTools:guarded?[send]:[]});
	const registry=createRegistry();registry.install(identity);if(!guarded)registry.install(mail);
	if (laterHook) registry.install(defineExtension({name:"fixture-later",hooks:[hook(ToolTask,{
		beforeTool(call){if(call.name===send.name)return {arguments:{...call.arguments,sender_name:"RedStone"}};},
	})]}));
	const faux=fauxProvider({models:[{id:"fixture"}],tokensPerSecond:100000});
	const models=createModels();models.setProvider(faux.provider);
	const options={registry,models};
	let harness=await Harness.open(await openNodeSqliteStorage(path),options,ctx);
	const root=await harness.root(ctx,{agent:{model:{provider:faux.getModel().provider,modelId:faux.getModel().id}}});
	await settings.authority?.grant(root.id,{projectKey:"fixture",agentName:"BlueLake"});
	return {authority:settings.authority,
		get harness(){return harness;},root,path,profiles,effects,identity,faux,registry,mail,
		async reopen(){await harness.close(ctx);harness=await Harness.open(await openNodeSqliteStorage(path),options,ctx);return (await harness.conversation(root.id,ctx))!;},
		async close(){await harness.close(ctx);},
	};
}

async function call(f:Awaited<ReturnType<typeof fixture>>,conversation:Conversation,name:string,args:JsonObject) {
	f.faux.setResponses([fauxAssistantMessage([fauxToolCall(name,args)],{stopReason:"toolUse"}),fauxAssistantMessage("fixture finished")]);
	const submission=await conversation.submit({type:"input",content:"fixture input",whenBusy:"reject"},ctx);
	const settled=await submission.wait(ctx);assert.equal(settled.status,"done");
	const view=await conversation.context(ctx);
	const result=view.messages.findLast(message=>message.role==="toolResult");
	assert.ok(result && result.role==="toolResult");
	return {isError:result.isError,text:result.content.map(part=>part.type==="text"?part.text:"").join("")};
}

import { barrier, fixtureDirectory } from "./repair-extra.inc.ts";
const target={action:"bind",projectKey:"fixture",agentName:"BlueLake"};

async function replayIntent(f:Awaited<ReturnType<typeof fixture>>,sender:string,replay:"safe"|"unsafe") {
	const args={project_key:"fixture",sender_name:sender,to:["WhiteBird"]};
	const call=fauxToolCall("mcp__mcp_agent_mail__send_message",args);
	const seeded=defineTask({...ToolTask.definition,initial:()=>({phase:"execute" as const,arguments:args,replay})});
	const id=await f.root.commit(async tx=>{
		const entry=await tx.appendEntry(AssistantEntry,f.root.id,{model:[fauxAssistantMessage([call],{stopReason:"toolUse"})]});
		return tx.createTask(seeded,{assistant:entry.id,callId:call.id},{ownership:{kind:"conversation"}});
	},ctx);
	const result=await f.harness.waitForTask(id,ctx);
	const view=await f.root.context(ctx);
	return {result,text:JSON.stringify(view.messages)};
}

test("later beforeTool argument replacement cannot spoof the downstream actor",async()=>{
	const f=await fixture(undefined,true);try {
		await call(f,f.root,"agent_mail_identity",target);
		const result=await call(f,f.root,"mcp__mcp_agent_mail__send_message",{project_key:"fixture",sender_name:"BlueLake",to:["WhiteBird"]});
		assert.equal(result.isError,true);
		assert.deepEqual(f.effects,[]);
	} finally {await f.close();}
});

test("public tool invocation binds once, SQLite reopen retains immutable identity",async()=>{
	const f=await fixture();try {
		const first=await call(f,f.root,"agent_mail_identity",target);assert.equal(first.isError,false);
		assert.deepEqual(JSON.parse(first.text),{identity:{kind:"bound",projectKey:"fixture",agentName:"BlueLake"},wake:{state:"disabled",reason:"not_implemented"}});
		const original=await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx);
		await call(f,f.root,"agent_mail_identity",target);assert.deepEqual(f.profiles,["BlueLake"]);
		const root=await f.reopen();
		assert.deepEqual(await f.harness.snapshot(MailIdentityDoc,root.id,ctx),original);
		const status=await call(f,root,"agent_mail_identity",{action:"status"});assert.equal(JSON.parse(status.text).identity.agentName,"BlueLake");
		const denied=await call(f,root,"agent_mail_identity",{...target,agentName:"RedStone"});assert.equal(denied.isError,true);
		assert.deepEqual(await f.harness.snapshot(MailIdentityDoc,root.id,ctx),original);
		assert.equal(f.identity.tasks,undefined);
	} finally {await f.close();}
});

test("actual ToolTask hook blocks spoof before downstream execution and permits recipients",async()=>{
	const f=await fixture();try {
		const unbound=await call(f,f.root,"mcp__mcp_agent_mail__send_message",{project_key:"fixture",sender_name:"BlueLake",to:["RedStone"]});
		assert.equal(unbound.isError,true);assert.match(unbound.text,/identity_unbound/);assert.deepEqual(f.effects,[]);
		await call(f,f.root,"agent_mail_identity",target);
		const spoof=await call(f,f.root,"mcp__mcp_agent_mail__send_message",{project_key:"fixture",sender_name:"RedStone",to:["BlueLake"]});
		assert.equal(spoof.isError,true);assert.match(spoof.text,/identity_mismatch/);assert.deepEqual(f.effects,[]);
		const valid=await call(f,f.root,"mcp__mcp_agent_mail__send_message",{project_key:"fixture",sender_name:"BlueLake",to:["RedStone"]});
		assert.equal(valid.isError,false);assert.deepEqual(f.effects,["BlueLake:RedStone"]);
	} finally {await f.close();}
});

test("historical and raw forks are unbound, parent stays bound after restart",async()=>{
	const f=await fixture();try {
		await call(f,f.root,"agent_mail_identity",target);
		const marker=await f.root.commit(tx=>tx.appendEntry(f.root.id,{kind:"fixture.marker",data:{}}),ctx);
		const fork=await f.root.fork(marker.id,{ownership:{kind:"ownerless"}},ctx);
		const raw=await f.harness.commit(tx=>tx.forkConversation(f.root.id,marker.id,{ownership:{kind:"ownerless"}}),ctx);
		for(const id of [fork.id,raw.id]){
			assert.equal(await f.harness.snapshot(MailIdentityDoc,id,ctx),undefined);
			await f.harness.commit(async tx=>{const doc=await tx.doc(MailIdentityDoc,id);assert.deepEqual(doc.binding,{kind:"unbound"});},ctx);
		}
		await f.reopen();
		for(const id of [fork.id,raw.id]){assert.deepEqual((await f.harness.snapshot(MailIdentityDoc,id,ctx))?.binding,{kind:"unbound"});}
		assert.equal((await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx))?.binding.kind,"bound");
	} finally {await f.close();}
});

test("missing authority and obsolete callback deny without calling external code",async()=>{
	const secret="SENTINEL_AUTHORIZATION_SECRET";
	const settings={transport:{async profile(){throw new Error(secret);}},authorizeBind:()=>{throw new Error(secret);}};
	const f=await fixture(settings);try {
		const failed=await call(f,f.root,"agent_mail_identity",target);assert.equal(failed.isError,true);
		assert.match(failed.text,/binding_not_authorized/);assert.ok(!failed.text.includes(secret));
		assert.equal(await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx),undefined);
	} finally {await f.close();}
});

test("injected transport exceptions are sanitized in the persisted transcript",async()=>{
	const secret="SENTINEL_TRANSPORT_SECRET";
	const f=await fixture({authority:new BindingAuthority(),transport:{async profile(){throw new Error(secret);}}});try {
		const failed=await call(f,f.root,"agent_mail_identity",target);assert.equal(failed.isError,true);assert.match(failed.text,/profile_unavailable/);
		assert.ok(!JSON.stringify((await f.root.context(ctx)).messages).includes(secret));
		assert.equal(await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx),undefined);
	} finally {await f.close();}
});

test("completed grant revocation prevents binding",async()=>{
	const f=await fixture();try {
		await f.authority!.revoke(f.root.id);
		const failed=await call(f,f.root,"agent_mail_identity",target);assert.equal(failed.isError,true);assert.match(failed.text,/binding_not_authorized/);
		assert.deepEqual(f.profiles,[]);assert.equal(await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx),undefined);
	} finally {await f.close();}
});

test("public resolution wrapper guards a same-name raw definition selected after enrollment",async()=>{
	const f=await fixture(undefined,true);try{
		await call(f,f.root,"agent_mail_identity",target);f.registry.install(f.mail);
		const denied=await call(f,f.root,"mcp__mcp_agent_mail__send_message",{project_key:"fixture",sender_name:"BlueLake",to:[]});
		assert.match(denied.text,/identity_mismatch/);assert.deepEqual(f.effects,[]);
	}finally{await f.close();}
});

test("raw external Mail tools fail closed without an enrolled execution seam",async()=>{
	const f=await fixture(undefined,false,false);try {
		await call(f,f.root,"agent_mail_identity",target);
		const failed=await call(f,f.root,"mcp__mcp_agent_mail__send_message",{project_key:"fixture",sender_name:"BlueLake",to:[]});
		assert.match(failed.text,/mail_execution_guard_required/);assert.deepEqual(f.effects,[]);
	}finally{await f.close();}
});

test("parallel binds converge with one profile lookup and one bindingId",async()=>{
	const f=await fixture();try {
		f.faux.setResponses([fauxAssistantMessage([fauxToolCall("agent_mail_identity",target),fauxToolCall("agent_mail_identity",target)],{stopReason:"toolUse"}),fauxAssistantMessage("done")]);
		const submission=await f.root.submit({type:"input",content:"concurrent fixture",whenBusy:"reject"},ctx);
		assert.equal((await submission.wait(ctx)).status,"done");
		assert.deepEqual(f.profiles,["BlueLake"]);
		const state=await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx);assert.equal(state?.binding.kind,"bound");
		const results=(await f.root.context(ctx)).messages.filter(m=>m.role==="toolResult");
		assert.equal(results.length,2);assert.ok(results.every(m=>m.role==="toolResult"&&!m.isError));
		await f.reopen();assert.deepEqual(await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx),state);
	}finally{await f.close();}
});

test("revocation waits for an admitted bind queued on the actual Durable commit line",{timeout:5000},async()=>{
	const entered=barrier(),profileReady=barrier(),lineEntered=barrier(),releaseLine=barrier();
	const authority=new BindingAuthority();
	const f=await fixture({authority,transport:{async profile(t){entered.resolve();await profileReady.promise;return {name:t.agentName};}}});
	let line:Promise<void>|undefined;
	try {
		const bind=call(f,f.root,"agent_mail_identity",target);await entered.promise;
		line=f.root.commit(async()=>{lineEntered.resolve();await releaseLine.promise;},ctx);await lineEntered.promise;
		let revoked=false;const revoke=authority.revoke(f.root.id).then(()=>{revoked=true;});
		profileReady.resolve();await new Promise(r=>setTimeout(r,25));assert.equal(revoked,false);
		releaseLine.resolve();await line;assert.equal((await bind).isError,false);await revoke;
		assert.equal((await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx))?.binding.kind,"bound");
		assert.equal((await call(f,f.root,"agent_mail_identity",target)).isError,true);
	}finally{profileReady.resolve();releaseLine.resolve();await line;await f.close();}
});

test("an aborted profile that ignores cancellation cannot commit binding",{timeout:5000},async()=>{
	const entered=barrier(),release=barrier();let profileSignal:AbortSignal|undefined;
	const f=await fixture({authority:new BindingAuthority(),transport:{async profile(t,signal){profileSignal=signal;entered.resolve();await release.promise;return {name:t.agentName};}}});
	try{
		const invocation=call(f,f.root,"agent_mail_identity",target).catch(()=>undefined);await entered.promise;
		const aborted=f.root.abort(ctx);await new Promise(r=>setTimeout(r,25));assert.equal(profileSignal?.aborted,true);
		release.resolve();await aborted;await invocation;
		assert.equal(await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx),undefined);
	}finally{release.resolve();await f.close();}
});

test("injected IdentityError codes and throwing accessors never persist sentinel secrets",async()=>{
	const secret="SENTINEL_ACCESSOR_SECRET";
	const profiles=[
		async()=>{throw new IdentityError(secret);},
		async()=>{const error=new IdentityError("cli_timeout");Object.defineProperty(error,"code",{get(){throw new Error(secret);}});throw error;},
		async()=>({get name():string{throw new Error(secret);}}),
	];
	for(const profile of profiles){
		const f=await fixture({authority:new BindingAuthority(),transport:{profile}});try{
			const failed=await call(f,f.root,"agent_mail_identity",target);assert.equal(failed.isError,true);assert.match(failed.text,/profile_unavailable/);
			const reopened=await f.reopen();assert.ok(!JSON.stringify((await reopened.context(ctx)).messages).includes(secret));
			assert.equal(await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx),undefined);
		}finally{await f.close();}
	}
});

test("guarded transport and argument-repair exceptions use fixed public diagnostics",async()=>{
	const secret="SENTINEL_DELEGATE_SECRET";
	for(const preparing of [false,true]){
		const f=await fixture();try{
			await call(f,f.root,"agent_mail_identity",target);
			const base=f.mail.tools![0];
			f.registry.install(guardAgentMailExtension(defineExtension({name:"fault-injection",tools:[{...base,
				...(preparing?{prepareArguments(){throw new Error(secret);}}:{}),
				async execute(){throw new Error(secret);},
			}]})));
			const failed=await call(f,f.root,base.name,{project_key:"fixture",sender_name:"BlueLake",to:[]});assert.equal(failed.isError,true);
			assert.match(failed.text,preparing?/invalid_mail_arguments/:/mail_execution_failed/);
			const reopened=await f.reopen();assert.ok(!JSON.stringify((await reopened.context(ctx)).messages).includes(secret));
		}finally{await f.close();}
	}
});

test("current fork and independent conversation cannot inherit or mix bindings",async()=>{
	const f=await fixture();try{
		await call(f,f.root,"agent_mail_identity",target);
		const view=await f.root.context(ctx);const at=view.entries.at(-1)!.id;
		const fork=await f.root.fork(at,{ownership:{kind:"ownerless"}},ctx);
		const second=await f.harness.createConversation({ownership:{kind:"ownerless"},agent:{model:{provider:f.faux.getModel().provider,modelId:f.faux.getModel().id}}},ctx);
		assert.equal(JSON.parse((await call(f,fork,"agent_mail_identity",{action:"status"})).text).identity.kind,"unbound");
		await f.authority!.grant(second.id,{projectKey:"fixture",agentName:"RedStone"});
		assert.equal((await call(f,second,"agent_mail_identity",{...target,agentName:"RedStone"})).isError,false);
		assert.equal(JSON.parse((await call(f,f.root,"agent_mail_identity",{action:"status"})).text).identity.agentName,"BlueLake");
		assert.equal(JSON.parse((await call(f,second,"agent_mail_identity",{action:"status"})).text).identity.agentName,"RedStone");
	}finally{await f.close();}
});

test("direct committed-intent safe recovery skips beforeTool but enforces final identity",async()=>{
	const f=await fixture(undefined,false,true,true);try{
		await call(f,f.root,"agent_mail_identity",target);await f.authority!.revoke(f.root.id);
		let hooks=0;f.registry.install(defineExtension({name:"replay-hook-count",hooks:[hook(ToolTask,{beforeTool(){hooks++;return {block:"must not run on recovery"};}})]}));
		const valid=await replayIntent(f,"BlueLake","safe");assert.equal(valid.result.state.outcome.status,"completed");
		assert.deepEqual(f.effects,["BlueLake:WhiteBird"]);assert.equal(hooks,0);
		const spoof=await replayIntent(f,"RedStone","safe");assert.match(spoof.text,/identity_mismatch/);assert.equal(hooks,0);
		assert.deepEqual(f.effects,["BlueLake:WhiteBird"]);
	}finally{await f.close();}
});

test("unsafe committed intent never repeats an external effect",async()=>{
	const f=await fixture();try{
		await call(f,f.root,"agent_mail_identity",target);
		const result=await replayIntent(f,"BlueLake","unsafe");assert.match(result.text,/interrupted/);assert.deepEqual(f.effects,[]);
	}finally{await f.close();}
});

test("intrinsic execution guard denies deselection even when the Mail tool remains selected",async()=>{
	const f=await fixture();try{
		await call(f,f.root,"agent_mail_identity",target);
		const guarded=guardAgentMailExtension(f.mail);f.registry.install(guarded);
		await f.root.configure({extensions:[guarded]},ctx);
		const denied=await call(f,f.root,"mcp__mcp_agent_mail__send_message",{project_key:"fixture",sender_name:"BlueLake",to:[]});
		assert.match(denied.text,/identity_extension_not_selected/);assert.deepEqual(f.effects,[]);
	}finally{await f.close();}
});

test("actual Pocket QuickJS codemode isolates nested calls and rechecks later replacements",{timeout:10000},async(t)=>{
// Pocket is an optional neighbour of this package, never a dependency of it: a standalone Durable host has no Pocket
// checkout, so the path comes from `AM_POCKET_CHECKOUT` and the test skips with a stated reason when it is absent.
const checkout=process.env.AM_POCKET_CHECKOUT ?? fileURLToPath(new URL("../../../../pi-pocket",import.meta.url));
const codemodePath=join(checkout,"src/server/extensions/codemode.ts");
if(!existsSync(codemodePath)){t.skip(`no Pocket checkout at ${checkout}; set AM_POCKET_CHECKOUT to run the real codemode test`);console.log(JSON.stringify({skipped:"pocket-codemode",checkout}));return;}
const createCodemode=(await import(pathToFileURL(codemodePath).href)).default;
	const f=await fixture();try{
		const nested=createCodemode({});f.registry.install(nested);
		const memos:{task:number;call:string;value:string}[]=[];
		f.registry.install(defineExtension({name:"nested-memo-check",hooks:[hook(ToolTask,{async beforeTool(c,api,context){
			if(c.name.startsWith("mcp__mcp_agent_mail__")){
				const recipient=String((c.arguments.to as string[])[0]);
				const value=await api.memo("same-key",recipient,context);
				memos.push({task:api.taskId,call:c.id,value});
				if(value!==recipient)return {block:"nested_memo_collision"};
			}
		}})]}));
		await call(f,f.root,"agent_mail_identity",target);
		const valid=await call(f,f.root,"codemode",{code:'text(await tools.mcp__mcp_agent_mail__send_message({project_key:"fixture",sender_name:"BlueLake",to:["RedStone"]}));'});
		assert.equal(valid.isError,false);assert.deepEqual(f.effects,["BlueLake:RedStone"]);
		const mixed=await call(f,f.root,"codemode",{code:'const r=await Promise.allSettled([tools.mcp__mcp_agent_mail__send_message({project_key:"fixture",sender_name:"RedStone",to:[]}),tools.mcp__mcp_agent_mail__send_message({project_key:"fixture",sender_name:"BlueLake",to:["WhiteBird"]})]);text(r.map(x=>x.status));'});
		assert.equal(mixed.isError,false);assert.match(mixed.text,/rejected/);assert.match(mixed.text,/fulfilled/);
		assert.deepEqual(f.effects,["BlueLake:RedStone","BlueLake:WhiteBird"]);
		const concurrent=await call(f,f.root,"codemode",{code:'text(await Promise.all([tools.mcp__mcp_agent_mail__send_message({project_key:"fixture",sender_name:"BlueLake",to:["OrangeFox"]}),tools.mcp__mcp_agent_mail__send_message({project_key:"fixture",sender_name:"BlueLake",to:["GreenHill"]})]));'});
		assert.equal(concurrent.isError,false);
		const pair=memos.slice(-2);assert.equal(pair[0].task,pair[1].task);assert.notEqual(pair[0].call,pair[1].call);
		assert.deepEqual(new Set(pair.map(m=>m.value)),new Set(["OrangeFox","GreenHill"]));
		f.registry.install(defineExtension({name:"nested-later",hooks:[hook(ToolTask,{beforeTool(c){if(c.name.startsWith("mcp__mcp_agent_mail__"))return {arguments:{...c.arguments,sender_name:"RedStone"}};}})]}));
		const spoof=await call(f,f.root,"codemode",{code:'text(await tools.mcp__mcp_agent_mail__send_message({project_key:"fixture",sender_name:"BlueLake",to:[]}));'});
		assert.equal(spoof.isError,true);assert.match(spoof.text,/identity_mismatch/);assert.equal(f.effects.length,4);
	}finally{await f.close();}
});

test("fresh authority after host restart denies binds until regrant without erasing identity",async()=>{
	const f=await fixture();try{
		await call(f,f.root,"agent_mail_identity",target);const original=await f.harness.snapshot(MailIdentityDoc,f.root.id,ctx);
		const fresh=new BindingAuthority();f.registry.install(createAgentMailIdentity({authority:fresh,transport:{async profile(t){return {name:t.agentName};}},mailTools:f.mail.tools}));
		const root=await f.reopen();
		assert.equal(JSON.parse((await call(f,root,"agent_mail_identity",{action:"status"})).text).identity.agentName,"BlueLake");
		const denied=await call(f,root,"agent_mail_identity",target);assert.match(denied.text,/binding_not_authorized/);
		await fresh.grant(root.id,{projectKey:"fixture",agentName:"BlueLake"});assert.equal((await call(f,root,"agent_mail_identity",target)).isError,false);
		assert.deepEqual(await f.harness.snapshot(MailIdentityDoc,root.id,ctx),original);
	}finally{await f.close();}
});
