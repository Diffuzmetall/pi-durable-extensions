import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAnswer, savedAnswerText, answerNotification } from '../src/reports.ts';
const entry = text => ({conversationId:7,model:[{role:'assistant',content:[{type:'text',text}]}]});
const tx = value => ({entry:async()=>value});
test('ordinary, JSON and malformed JSON answers are literal text without report validation',async()=>{
 for(const text of ['plain\n','{"status":"anything"}','{broken','', '🙂你好'.repeat(20000)]) {
  assert.equal((await canonicalAnswer(tx(entry(text)),7,'durable:7:9')).text,text);
  assert.equal(await savedAnswerText(tx(entry(text)),7,{answerRef:'durable:7:9',text:'OLD SUMMARY'}),text);
  assert.ok(answerNotification('worker','native-request','durable:7:9',text).endsWith(text));
 }
});
test('canonical references fail closed on invalid or foreign ownership, never substitute old summary',async()=>{
 for(const reference of ['invented','durable:8:9','durable:7:0','durable:7:9007199254740992'])
  await assert.rejects(canonicalAnswer(tx(entry('secret')),7,reference),/ownership/);
 await assert.rejects(canonicalAnswer(tx({...entry('foreign'),conversationId:8}),7,'durable:7:9'),/ownership/);
 assert.equal(await savedAnswerText(tx(undefined),7,{answerRef:'durable:7:9',text:'SUMMARY NOT RAW'}),'Canonical answer unavailable: durable:7:9');
});
test('legacy-only stored text is explicitly not reconstructed as a canonical answer',async()=>{
 assert.equal(await savedAnswerText(tx(undefined),7,{text:'historical formatted summary'}),'Saved result without canonical answer reference:\nhistorical formatted summary');
});
test('minimal notification attribution escapes terminal/bidi controls without mutating canonical text',async()=>{
 const raw='literal\n\u001b[2J\u0000\r\u202eend',name='worker\nforged';
 const value=await canonicalAnswer(tx(entry(raw)),7,'durable:7:9');assert.equal(value.text,raw);
 const notice=answerNotification(name,'native-request','durable:7:9',raw);
 assert.doesNotMatch(notice,/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/u);
 assert.match(notice,/Subagent "worker\\nforged" requestId="native-request" Details="durable:7:9"/);
 assert.match(notice,/\\u001b/);assert.doesNotMatch(notice,/Needs=|Verify:|reported=|not acceptance/);
});
