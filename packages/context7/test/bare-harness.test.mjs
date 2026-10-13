import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('real bare Durable Harness example invokes extension and import guard', async () => {
  const { stdout } = await run(process.execPath, ['--experimental-strip-types', 'examples/bare-durable.mjs'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, CONTEXT7_API_KEY: '', CONTEXT7_KEY_FILE: '' } });
  if (!stdout.includes('"status":"PASS"')) throw Error(`Harness example did not report PASS: ${stdout}`);
});
