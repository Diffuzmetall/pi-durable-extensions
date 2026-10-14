// EXCLUDED UNSUPPORTED POLICY diagnostic: expected known FAIL, never package acceptance.
// Exact strict assertion/corpus retained from pre-policy-split-20261013T1314/dcg.test.ts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {realFixture,robot} from './real-support.ts';
test('ISC-23 robot cd-scoped policy falsifier: scoped source permission must not authorize destructive target scope', async () => {
  const f = await realFixture(); const configDir = join(f.evaluatorEnv.XDG_CONFIG_HOME, 'dcg'); await mkdir(configDir);
  await writeFile(join(configDir, 'allowlist.toml'), '[[allow]]\nrule = "core.git:reset-hard"\nreason = "test source scope only"\npaths = [' + JSON.stringify(f.env.cwd) + ']\n');
  const source = await robot(f, 'git reset --hard HEAD', 'source-scope'); assert.equal(source.json.decision, 'allow');
  const target = await robot(f, 'git reset --hard HEAD', 'target-scope', join(f.dir, 'other')); assert.equal(target.json.decision, 'deny');
  const cross = await robot(f, `cd ${join(f.dir, 'other')} && git reset --hard HEAD`, 'cross-scope');
  assert.equal(cross.json.decision, 'deny', 'robot has unintended cross-directory allow; scoped owner policy is NOT admitted');
});
