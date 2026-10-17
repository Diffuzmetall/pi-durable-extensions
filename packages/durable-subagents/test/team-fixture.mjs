import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createSubagent, SubagentsDoc, SupervisorDoc, TeamDoc } from '../src/index.ts';
import { savedAnswerText } from '../src/reports.ts';

const pause = ms => new Promise(r => setTimeout(r, ms));
export const until = async probe => { for (let i=0;i<800;i++) { const result = await probe(); if (result) return result; await pause(5); } throw new Error('condition not reached'); };
const report = summary => JSON.stringify({status:'done',summary,changes:[],verify:[],outputs:[],needs:[]});
const call = (tool,args) => fauxAssistantMessage(fauxToolCall(tool,args),{stopReason:'toolUse'});
export const output = entry => JSON.stringify(entry?.model);
export { context };
export async function fixture({path,admit,options,registry: existing,models: existingModels,provider: existingProvider,onReply}={}) {
  const provider=existingProvider??fauxProvider(), models=existingModels??createModels();
  if (!existingModels) models.setProvider(provider.provider);
  const registry=existing??createRegistry(), errors=[], childInputs=[], parentInputs=[], blocked=[];
  if (!existing) {
    registry.install(defineExtension({name:'fixture',tools:[
      defineTool({name:'read',parameters:Type.Object({}),execute:async()=>({output:[{type:'text',text:'read-ok'}]})}),
      defineTool({name:'gate',parameters:Type.Object({}),replay:'unsafe',execute:async(_a,api,ctx)=>{
        blocked.push(api.conversationId);
        await new Promise((_resolve,reject)=>{ctx.abortSignal.addEventListener('abort',()=>reject(ctx.abortSignal.reason),{once:true});});
        return {};
      }}),
      defineTool({name:'bridge',callers:['model'],parameters:Type.Object({name:Type.String()}),execute:async(a,api,ctx)=>{
        const r=await api.executeTool(a.name,{},ctx);return {output:[{type:'text',text:JSON.stringify(r)}]};
      }}),
      defineTool({name:'mcp_read',callers:['tools'],parameters:Type.Object({}),execute:async()=>({output:[{type:'text',text:'mcp-ok'}]})}),
    ],hooks:onReply?[hook(ToolTask,{afterTool:async(call,result)=>{
      if(call.name==='subagent_supervisor')await onReply();
    } })]:[]}));
  }
  registry.install(createSubagent(admit,options));
  provider.setResponses(Array.from({length:4000},()=>transcript=>{
    const messages=transcript.messages,user=messages.findLast(m=>m.role==='user');
    const content=typeof user?.content==='string'?user.content:'';
    const last=messages.at(-1);
    if(content.startsWith('job:')) {
      const results=messages.slice(messages.lastIndexOf(user)+1).filter(m=>m.role==='toolResult');
      if(!results.length) childInputs.push(content);
      const kind=content.split(':')[1];
      if(kind==='decision'||kind==='interview') return results.length?fauxAssistantMessage(report(`continued:${content}:${JSON.stringify(results.at(-1).content)}`)):
        call('contact_supervisor',{reason:kind==='interview'?'interview_request':'need_decision',message:content,
          ...(kind==='interview'?{interview:{questions:[{id:'color',question:'Color?',options:['red','blue']}]}}:{})});
      if(kind==='update') return !results.length?call('contact_supervisor',{reason:'important_update',message:'Implementation must use the corrected contract'}):call('gate',{});
      if(kind==='progress') return !results.length?call('contact_supervisor',{reason:'progress_update',message:'halfway'}):call('gate',{});
      if(kind==='nested') return results.length?fauxAssistantMessage(report(output({model:results}))):call('bridge',{name:'mcp_read'});
      if(kind==='forge') return results.length?fauxAssistantMessage(report(output({model:results}))):call('bridge',{name:'subagent_supervisor'});
      if(kind==='invalid')return fauxAssistantMessage('not valid report JSON');
      if(kind==='failed')return fauxAssistantMessage(JSON.stringify({status:'failed',summary:'failure',changes:[],verify:[{name:'regression',outcome:'fail',ref:null}],outputs:[],needs:['decision needed']}));
      return fauxAssistantMessage(report(content));
    }
    parentInputs.push(content);
    if(content.startsWith('Subagent ')) return fauxAssistantMessage('ack');
    if(last?.role==='toolResult') return fauxAssistantMessage('command complete');
    const command=JSON.parse(content);return call(command.tool,command.args);
  }));
  const storage=path?await openNodeSqliteStorage(path):new MemoryStorage();
  const harness=await Harness.open(storage,{registry,models,onReport:e=>errors.push(e)},context);
  const root=await harness.root(context,{agent:{model:{provider:provider.getModel().provider,modelId:provider.getModel().id}}});
  const invoke=async(tool,args,who=root)=>{
    const s=await who.submit({type:'input',content:JSON.stringify({tool,args})},context),done=await s.wait(context);
    assert.equal(done.status,'done');
    const entries=(await who.entries({maxEntryId:done.answer},100,undefined,context)).items;
    return entries.find(e=>e.kind==='pi.tool-result');
  };
  const state=async()=>await harness.snapshot(SubagentsDoc,root.id,context);
  const record=async name=>Object.values((await state())?.agents??{}).find(a=>a.name===name);
  const answer=async name=>{const r=await record(name);const runs=Object.values((await harness.snapshot(TeamDoc,root.id,context)).executions).filter(e=>e.child===r.conversationId&&e.done);return root.commit(tx=>savedAnswerText(tx,r.conversationId,runs.at(-1).done),context);};
  const requests=async()=>Object.values((await harness.snapshot(SupervisorDoc,root.id,context))?.requests??{});
  return {harness,root,provider,models,registry,errors,childInputs,parentInputs,blocked,invoke,state,record,requests,answer,close:()=>harness.close(context)};
}
