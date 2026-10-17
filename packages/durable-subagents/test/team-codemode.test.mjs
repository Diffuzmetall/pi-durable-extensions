import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { McpClient, toLlmContent } from '@earendil-works/pi-mcp';
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing';
import { Harness, createRegistry, defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createSubagent, SubagentsDoc } from '../src/index.ts';

test('real CodeMode + real native read + pi-mcp protocol client inherit original guards; reviewer stays read-only',{timeout:20000},async()=>{
  const directory=await mkdtemp(join(tmpdir(), 'subagents-codemode-'));
  const marker=join(directory,'marker.txt');await writeFile(marker,'PRIVATE-CODEMODE-READ');
  const transport=createInMemoryTransportPair();let effects=0,deniedEffects=0;
  transport.server.onMessage(message=>{
    if(!('method' in message)||!('id' in message))return;
    let result={};
    if(message.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'private-readonly',version:'1'}};
    if(message.method==='tools/list')result={tools:[{name:'read_marker',description:'Private read-only marker',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]};
    if(message.method==='tools/call'){effects++;result={content:[{type:'text',text:'PRIVATE-MCP-READ'}]};}
    void transport.server.send({jsonrpc:'2.0',id:message.id,result});
  });
  await transport.server.start();const client=new McpClient({name:'private-core-test',version:'1'});await client.connect(transport.client);
  const listed=await client.listTools();assert.equal(listed[0].annotations.readOnlyHint,true);
  const sandbox=new CodemodeSandbox({memoryLimitBytes:128*1024*1024});
  const registry=createRegistry(),provider=fauxProvider(),models=createModels();models.setProvider(provider.provider);
  registry.install(CodingTools);registry.install(createCodemodeExtension({sandbox,models:false}));
  registry.install(defineExtension({name:'fixture-mcp',tools:[
    defineTool({name:'mcp_read',callers:['tools'],parameters:Type.Object({}),execute:async()=>({output:toLlmContent(await client.callTool('read_marker',{}))})}),
    defineTool({name:'mcp_denied',parameters:Type.Object({}),execute:async()=>{deniedEffects++;return {};}}),
  ],hooks:[hook(ToolTask,{beforeTool:call=>['mcp_denied','bash'].includes(call.name)?{block:'ORIGINAL-GUARD-DENIED'}:undefined})]}));
  registry.install(createSubagent());
  const code=`text(await tools.read({path:${JSON.stringify(marker)}})); text(await tools.mcp_read({})); try {await tools.mcp_denied({});} catch(e) {text(String(e));} try {await tools.subagent({task:'forbidden'});} catch(e) {text(String(e));}`;
  const report=summary=>JSON.stringify({status:'done',summary,changes:[],verify:[],outputs:[],needs:[]});
  provider.setResponses(Array.from({length:1000},()=>transcript=>{
    const messages=transcript.messages,user=messages.findLast(m=>m.role==='user'),content=typeof user?.content==='string'?user.content:'';
    const last=messages.at(-1);
    if(content.startsWith('job:')) {
      if(last?.role==='toolResult')return fauxAssistantMessage(report(JSON.stringify(last.content)));
      if(content==='job:cm')return fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'});
      if(content==='job:deny')return fauxAssistantMessage(fauxToolCall('mcp_denied',{}),{stopReason:'toolUse'});
      return fauxAssistantMessage(report('reviewer done'));
    }
    if(content.startsWith('Subagent '))return fauxAssistantMessage('ack');
    if(last?.role==='toolResult')return fauxAssistantMessage('command complete');
    return fauxAssistantMessage(fauxToolCall('subagent',JSON.parse(content)),{stopReason:'toolUse'});
  }));
  const errors=[],harness=await Harness.open(await openNodeSqliteStorage(join(directory,'session.sqlite')),
    {models,registry,env:()=>new NodeExecutionEnv({cwd:directory}),onReport:e=>errors.push(e)},context);
  const root=await harness.root(context,{agent:{model:{provider:provider.getModel().provider,modelId:provider.getModel().id}}});
  const invoke=async args=>{const sub=await root.submit({type:'input',content:JSON.stringify(args)},context);assert.equal((await sub.wait(context)).status,'done');};
  try {
    await invoke({name:'worker',task:'job:cm',requestId:'worker',background:false});
    const agents=(await harness.snapshot(SubagentsDoc,root.id,context)).agents;
    const child=await harness.conversation(agents['subagent:worker'].conversationId,context);
    const entries=(await child.entries({},100,undefined,context)).items;
    const tool=entries.find(e=>e.kind==='pi.tool-result');const raw=JSON.stringify(tool.model);
    assert.match(raw,/PRIVATE-CODEMODE-READ/);assert.match(raw,/PRIVATE-MCP-READ/);
    assert.match(raw,/ORIGINAL-GUARD-DENIED/);assert.match(raw,/subagent/);
    assert.equal(effects,1);assert.equal(deniedEffects,0);
    await invoke({action:'send',name:'worker',task:'job:deny',requestId:'deny',background:false});
    const after=(await child.entries({},100,undefined,context)).items;
    assert.match(JSON.stringify(after.find(e=>e.kind==='pi.tool-result').model),/ORIGINAL-GUARD-DENIED/);
    assert.equal(deniedEffects,0);
    await invoke({name:'reviewer',task:'job:review',requestId:'reviewer',role:'reviewer',background:false});
    const state=await harness.snapshot(SubagentsDoc,root.id,context);
    const reviewer=await harness.conversation(state.agents['subagent:reviewer'].conversationId,context);
    assert.deepEqual((await reviewer.agent(context)).tools.map(t=>t.name).sort(),['contact_supervisor','read']);
    assert.deepEqual((await reviewer.agent(context)).callable.map(t=>t.name),['read']);
    assert.ok(!(await child.agent(context)).tools.some(t=>['subagent','subagent_supervisor','subagent_send_many'].includes(t.name)));
    assert.equal(effects,1);assert.deepEqual(errors,[]);
  }finally{await harness.close(context);await client.close();await transport.server.close();await sandbox.close();}
});
