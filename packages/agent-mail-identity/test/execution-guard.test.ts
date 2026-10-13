import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { guardAgentMailExtension } from "../src/execution-guard.ts";
import { bindIdentity, initialIdentity } from "../src/identity.ts";
import { barrier } from "./repair-extra.inc.ts";

// Unit probe for an argument reference held by another trusted hook.
test("execution guard captures final arguments before asynchronous document reads",async()=>{
	const entered=barrier(),release=barrier();const effects:string[]=[];
	const tool=defineTool({
		name:"mcp__mcp_agent_mail__send_message",description:"local unit probe",
		parameters:Type.Object({project_key:Type.String(),sender_name:Type.String()}),
		async execute(args){effects.push(args.sender_name);return {content:[]};},
	});
	const extension=guardAgentMailExtension(defineExtension({name:"unit-mail",tools:[tool]}));
	const api={
		conversationId:1,
		async agent(){entered.resolve();await release.promise;return {extensions:[{name:"agent-mail-identity"}]};},
		async snapshot(){return bindIdentity(initialIdentity(),1,{projectKey:"fixture",agentName:"BlueLake"},"one");},
	} as unknown as ToolExecutionApi;
	const args={project_key:"fixture",sender_name:"BlueLake"};
	const running=extension.tools![0].execute(args,api,context);
	await entered.promise;args.sender_name="RedStone";release.resolve();await running;
	assert.deepEqual(effects,["BlueLake"]);
	assert.equal(guardAgentMailExtension(extension).tools![0],extension.tools![0]);
});
