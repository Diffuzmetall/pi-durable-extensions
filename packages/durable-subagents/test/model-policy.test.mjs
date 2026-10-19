import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAvailableModel } from '../src/model-policy.ts';

const api = getAvailable => ({ models: { getAvailable } });

test('resolves an exact authenticated provider/model, preserving slashes in model IDs', async () => {
  const calls = [];
  const result = await resolveAvailableModel('configured/vendor/model', api(async provider => {
    calls.push(provider);
    return [{ provider: 'configured', id: 'vendor/model' }];
  }));
  assert.deepEqual(result, { provider: 'configured', modelId: 'vendor/model' });
  assert.deepEqual(calls, ['configured']);
});

test('rejects ambiguous or malformed selections before inspecting providers', async () => {
  for (const value of ['astra', '/model', 'provider/', '', ' provider/model', 'provider/model ']) {
    await assert.rejects(resolveAvailableModel(value, api(() => {
      assert.fail('invalid selector must not query provider configuration');
    })), /exact provider\/model/);
  }
});

test('catalog presence without configured auth, unknown models and wrong providers never fall back', async () => {
  for (const available of [[], [{ provider: 'configured', id: 'other' }], [{ provider: 'other', id: 'model' }]]) {
    const calls = [];
    await assert.rejects(resolveAvailableModel('configured/model', api(async provider => {
      calls.push(provider); return available;
    })), /unavailable|not authenticated/);
    assert.deepEqual(calls, ['configured']);
  }
});

test('authentication lookup failure propagates rather than selecting another model', async () => {
  const failure = Error('provider auth unavailable');
  await assert.rejects(resolveAvailableModel('configured/model', api(async () => { throw failure; })), error => error === failure);
});
