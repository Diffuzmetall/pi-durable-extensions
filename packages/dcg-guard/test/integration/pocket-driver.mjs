// Runs ONLY in a retained, test-owned one-shot process. Never app.close(): that deletes harness.lock.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { ok } from '@earendil-works/pi-durable/env';
const [hostRoot, root] = process.argv.slice(2); const dataDir = join(root, 'app-data');
const { PocketApp } = await import(pathToFileURL(join(hostRoot, 'src/server/app.ts')).href);
const { SubagentsDoc } = await import(pathToFileURL(join(hostRoot, 'src/server/docs.ts')).href);
const route = context => {
  const last = context.messages.findLast(m => m.role !== 'system'); const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
  if (last?.role === 'toolResult') return fauxAssistantMessage('fixture finished');
  const index = text.indexOf('DCG_CASE:');
  if (index >= 0) { const { name, args } = JSON.parse(text.slice(index + 9)); return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }); }
  if (text.includes('child-danger')) return fauxAssistantMessage([fauxToolCall('bash', { command: 'git reset --hard HEAD' })], { stopReason: 'toolUse' });
  return fauxAssistantMessage('fixture done');
};
const faux = fauxProvider({ models: [{ id: 'pocket-fixture' }], tokensPerSecond: 100000 }); faux.setResponses(Array.from({ length: 500 }, () => route));
const app = await PocketApp.open({ dataDir, defaultCwd: join(root, 'cwd'), home: join(root, 'home'), supervised: false, log: message => console.log('HOST ' + message), configureModels: models => models.registerNativeProvider(faux.provider) });
const owner = app.config.users.find(u => u.role === 'owner'); assert.ok(owner);
const checks = []; const starts = new Map();
async function session(cwd = join(root, 'cwd'), recording = true) {
  const { id } = await app.commands.createSession(owner, { cwd }); await app.commands.configure(id, owner, { model: { provider: 'faux', modelId: 'pocket-fixture' }, thinkingLevel: 'off' });
  if (recording) {
    const env = app.envFor(id); const list = starts.get(cwd) ?? []; starts.set(cwd, list);
    // Installed before ANY call; unconditional recording means destructive DATA can never become a live shell.
    env.exec = async function(command, options, context) { assert.equal(this, env); list.push({ command, cwd: options?.cwd ?? this.cwd }); options?.onOutput?.('pocket-recorded\n', context, { stream: 'stdout' }); return ok({ exitCode: 0 }); };
    await env.exec('rm -rf /DATA_ONLY_NEVER_EXECUTE', {}, ctx); assert.equal(list.at(-1).command, 'rm -rf /DATA_ONLY_NEVER_EXECUTE');
  }
  return id;
}
async function call(id, name, args) {
  const { submissionId } = await app.commands.submit(id, owner, { text: 'DCG_CASE:' + JSON.stringify({ name, args }), requestId: crypto.randomUUID() }); await (await app.harness.submission(submissionId, ctx)).wait(ctx);
  const messages = (await (await app.harness.conversation(id, ctx)).context(ctx)).messages; const result = messages.findLast(m => m.role === 'toolResult' && m.toolName === name); assert.ok(result); return result;
}
const count = cwd => (starts.get(cwd) ?? []).length;
async function refusal(id, name, args, pattern, cwd) { const before = count(cwd); const r = await call(id, name, args); assert.equal(r.isError, true); assert.match(JSON.stringify(r), pattern); assert.equal(count(cwd), before); return r; }
try {
  const listed = await app.extensions(owner); const drop = listed.modules.find(m => m.file === 'dcg-guard.ts'); assert.ok(drop); assert.equal(drop.enabled, false); checks.push('loader-off');
  await app.setExtensionEnabled(owner, 'guard.ts', false);
  const cwd = join(root, 'cwd'), other = join(root, 'other'); const id = await session(cwd); const second = await session(other);
  let before = count(cwd); const unguarded = await call(id, 'bash', { command: 'git reset --hard HEAD' }); assert.equal(unguarded.isError, false); assert.equal(count(cwd) - before, 1); checks.push('recorder-independent-off');
  await app.setExtensionEnabled(owner, 'dcg-guard.ts', true); const selected = (await (await app.harness.conversation(id, ctx)).agent(ctx)).extensions; assert.ok(selected.some(e => e.name === 'dcg-guard')); checks.push('loader-enabled-selected');
  for (const [sid, folder] of [[id, cwd], [second, other]]) {
    before = count(folder); assert.equal((await call(sid, 'bash', { command: 'git status --short' })).isError, false); assert.equal(count(folder) - before, 1); assert.equal(starts.get(folder).at(-1).cwd, folder);
    await refusal(sid, 'bash', { command: 'git reset --hard HEAD' }, /DCG_DENIED/, folder);
    before = count(folder); assert.equal((await call(sid, 'codemode', { code: 'text(await tools.bash({command:"git status --short"}));' })).isError, false); assert.equal(count(folder) - before, 1);
    await refusal(sid, 'codemode', { code: 'text(await tools.bash({command:"git reset --hard HEAD"}));' }, /DCG_DENIED/, folder);
  } checks.push('direct-codemode-two-cwds');
  await app.setExtensionEnabled(owner, 'dcg-late.ts', true);
  await refusal(id, 'bash', { command: 'echo REWRITE_MARKER' }, /DCG_DENIED/, cwd);
  await refusal(id, 'codemode', { code: 'text(await tools.bash({command:"echo REWRITE_MARKER"}));' }, /DCG_DENIED/, cwd); checks.push('actual-late-hook-rewrite');
  await app.reloadExtension('dcg-guard.ts'); await refusal(id, 'bash', { command: 'git reset --hard HEAD' }, /DCG_DENIED/, cwd); checks.push('actual-loader-reload');
  await app.setExtensionEnabled(owner, 'dcg-guard.ts', false); before = count(cwd); assert.equal((await call(id, 'bash', { command: 'git reset --hard HEAD' })).isError, false); assert.equal(count(cwd) - before, 1);
  await app.setExtensionEnabled(owner, 'dcg-guard.ts', true); await refusal(id, 'bash', { command: 'git reset --hard HEAD' }, /DCG_DENIED/, cwd); checks.push('off-on');
  // Separate unmodified default environment is used ONLY for this harmless real-shell streaming source.
  const streaming = join(root, 'streaming'); await mkdir(streaming); const streamId = await session(streaming, false);
  const streamed = await call(streamId, 'bash', { command: 'printf "pocket-stream-one\\n"; printf "pocket-stream-two\\n" >&2' }); assert.equal(streamed.isError, false); assert.match(JSON.stringify(streamed), /pocket-stream-one/); assert.match(JSON.stringify(streamed), /pocket-stream-two/); checks.push('actual-harmless-shell-streaming');
  const beforeChild = count(cwd);
  const childResult = await call(id, 'subagent', { action: 'spawn', name: 'dcg-fixture-child', message: 'child-danger', tools: ['bash'] }); assert.equal(childResult.isError, false);
  const childId = (await app.harness.snapshot(SubagentsDoc, id, ctx)).agents['dcg-fixture-child'].conversationId;
  const child = await app.harness.conversation(childId, ctx); assert.equal(app.envFor(childId), app.envFor(id), 'task-owned child must use the already-inert cached cwd environment'); assert.ok((await child.agent(ctx)).extensions.some(e => e.name === 'dcg-guard'));
  const deadline = Date.now() + 5000; let childTool; const childPoll = [];
  while (Date.now() < deadline) { const view = await child.context(ctx); childTool = view.entries.flatMap(entry => entry.model ?? []).find(m => m.role === 'toolResult' && m.toolName === 'bash'); childPoll.push({ at: Date.now(), committedResult: childTool ?? null, projectedResult: view.messages.find(m => m.role === 'toolResult' && m.toolName === 'bash') ?? null }); if (childTool) break; await new Promise(r => setTimeout(r, 10)); }
  await writeFile(join(root, 'child-completion.json'), JSON.stringify(childPoll, null, 2));
  assert.ok(childTool, 'actual committed child tool result must complete within the deadline, not a synthetic context placeholder'); assert.equal(childTool.isError, true); assert.match(JSON.stringify(childTool), /DCG_DENIED/); assert.equal(count(cwd), beforeChild); checks.push('actual-subagent-selected');
  await app.setExtensionEnabled(owner, 'guard.ts', true); const status = await app.guard.status(); assert.equal(status.available, true, 'actual Lancet installed module prerequisite failed'); assert.equal(status.enabled, true);
  const settings = await readFile(join(root, 'home/.pi/lancet-guard.json'), 'utf8'); const judged = await app.guard.judge('bash', { command: 'echo LANCET_BLOCK' }, cwd); assert.equal(judged.decision.action, 'block');
  const unsubscribe = app.approvals.subscribe(() => queueMicrotask(() => { for (const request of app.approvals.all()) app.approvals.answer(request.id, { allow: false, by: 'isolated-test-owner' }); }));
  const protectedFile = join(cwd, '.env'); await writeFile(protectedFile, 'PROTECTED_FIXTURE');
  const baseline = [];
  for (const enabled of [false, true]) {
    await app.setExtensionEnabled(owner, 'dcg-guard.ts', enabled);
    const block = await refusal(id, 'bash', { command: 'echo LANCET_BLOCK' }, /Lancet Guard blocked/, cwd); assert.ok(!JSON.stringify(block).includes('DCG_'));
    const write = await call(id, 'write', { path: protectedFile, content: 'SHOULD_NOT_BE_WRITTEN' }); const edit = await call(id, 'edit', { path: protectedFile, oldText: 'PROTECTED_FIXTURE', newText: 'SHOULD_NOT_BE_EDITED' });
    assert.equal(write.isError, true); assert.equal(edit.isError, true); assert.match(JSON.stringify(write), /denied.*after Lancet Guard asked/); assert.match(JSON.stringify(edit), /denied.*after Lancet Guard asked/); assert.equal(await readFile(protectedFile, 'utf8'), 'PROTECTED_FIXTURE');
    baseline.push({ block: judged.decision.action, write: write.isError, edit: edit.isError });
  }
  assert.deepEqual(baseline[0], baseline[1]); unsubscribe(); checks.push('actual-lancet-block-ask-file-composition');
  const allowed = await app.guard.judge('bash', { command: 'git reset --hard HEAD' }, cwd); assert.equal(allowed.decision.action, 'allow', 'configured Lancet fixture allow prerequisite differs');
  await refusal(id, 'bash', { command: 'git reset --hard HEAD' }, /DCG_DENIED/, cwd); checks.push('lancet-allow-cannot-override-dcg');
  await writeFile(join(root, 'pocket-results.json'), JSON.stringify({ checks, starts: Object.fromEntries(starts), status, settings, sameRootLifecycle: 'BLOCKED: app.close removes harness.lock; no close invoked', artifact: process.env.DCG_TEST_ARCHIVE }, null, 2));
  console.log(JSON.stringify({ result: 'PASS_PARTIAL', checks, sameRootLifecycle: 'BLOCKED', retained: root }));
  // Authorized one-shot process end: no PocketApp.close, no graceful host lifecycle claimed.
  process.exit(0);
} catch (error) {
  await writeFile(join(root, 'pocket-failure.json'), JSON.stringify({ checks, error: String(error), stack: error.stack }, null, 2)); console.error(error); process.exit(1);
}
