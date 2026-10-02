const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

function fixture(fetchImpl) {
  const values = {}; const storage = { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])), set: async value => Object.assign(values, value), remove: async key => { delete values[key]; } };
  const context = vm.createContext({ URL, AbortSignal, structuredClone, Uint8Array });
  vm.runInContext(fs.readFileSync(require.resolve('../src/kai-local-store-client.js'), 'utf8'), context);
  return context.KaiLocalStoreClient.create({ storage, fetchImpl, cryptoImpl: crypto, extensionId: 'tracker' });
}
test('tracker saves to the local endpoint with persistent request identity', async () => {
  let sent; const client = fixture(async (url, options) => { sent = { url, ...options }; return { ok: true, json: async () => ({ inserted: true, rowNumber: 3 }) }; });
  await client.saveJob({ company: 'Acme', title: 'Engineer', description: 'Software' }, { profile: 'sample', requestId: 'fixed-request' });
  assert.equal(sent.url, 'http://127.0.0.1:8787/job-store/jobs'); assert.equal(JSON.parse(sent.body).requestId, 'fixed-request'); assert.match(sent.headers['X-Job-Tracker-Client'], /^[a-f0-9]{64}$/); assert.equal(sent.headers.Authorization, undefined);
});
test('local duplicate and company snapshots retain the background protocol', async () => {
  const client = fixture(async url => ({ ok: true, json: async () => url.includes('/duplicate') ? { duplicate: { company: 'Acme' } } : { companies: ['Acme'], revision: '2' } }));
  assert.equal((await client.lookupDuplicate('Acme')).duplicate.company, 'Acme'); assert.equal((await client.getCompanies()).revision, '2');
});
test('temporary outages keep tracker configured for durable research recovery', async () => {
  const client = fixture(async () => { throw Error('offline'); }); const status = await client.getStatus(); assert.equal(status.configured, true); assert.equal(status.connection, 'offline');
  await assert.rejects(client.saveJob({ company: 'Acme' }), { code: 'LOCAL_STORE_UNAVAILABLE' });
});
