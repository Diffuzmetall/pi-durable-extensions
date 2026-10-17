import { fixture, until } from './team-fixture.mjs';
const [path, phase] = process.argv.slice(2);
const f = await fixture({ path, onReply: phase === 'answered' ? async () => {
  process.send({ ready: 'answered' });
  await new Promise(() => {});
} : undefined });
await f.invoke('subagent', { name: 'recover', task: 'job:decision:recover', requestId: 'recover' });
await until(async () => (await f.requests()).length === 1);
if (phase === 'pending') { process.send({ ready: phase }); await new Promise(() => {}); }
else { const request = (await f.requests())[0]; await f.invoke('subagent_supervisor', { action: 'reply', replyTo: request.id, message: 'persisted-answer' }); }
