const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto, randomUUID } = require('node:crypto');

const KEY = 'jobTrackerFailureReportsV1';
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'failure-reports.js'), 'utf8');
function fixture() {
  const values = {}, files = new Map(), calls = [], alarms = new Map();
  let destination = 'applicantally-file:' + randomUUID(), permission = true, storageWritable = true;
  const storage = {
    get: async key => ({ [key]: structuredClone(values[key]) }),
    set: async update => { if (!storageWritable) throw new Error('Storage quota unavailable'); Object.assign(values, structuredClone(update)); }
  };
  const sheetClient = {
    getStatus: async () => ({ sheetUrl: destination }),
    async saveFailureReport(report, options) {
      calls.push({ report: structuredClone(report), options: structuredClone(options), persisted: structuredClone(values[KEY]) });
      if (!permission) throw new Error('Folder permission expired');
      if (options.sheetUrl !== destination) throw new Error('Original destination changed');
      files.set(destination + '/' + report.reportId + '.json', structuredClone(report));
    }
  };
  const context = vm.createContext({ URL, Date }); vm.runInContext(source, context);
  const create = () => context.JobFailureReports.create({ storage, sheetClient, cryptoImpl: webcrypto,
    alarms: { create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name) } });
  return { create, values, files, calls, alarms, alarm: context.JobFailureReports.ALARM,
    destination: () => destination, changeDestination: value => { destination = value; },
    deny: () => { permission = false; }, allow: () => { permission = true; },
    failStorage: () => { storageWritable = false; }, restoreStorage: () => { storageWritable = true; } };
}
const job = () => ({ company: 'Review Company', title: 'Senior Software Engineer', description: 'Build production systems. '.repeat(1000),
  sourceUrl: 'https://www.linkedin.com/jobs/view/123', applyUrl: 'https://example.com/careers/123', jobId: '123',
  selectedRegion: 'US', selectedRegionSource: 'linkedin-search', workplaceType: 'Remote', isEasyApply: true });

test('report includes full captured job and prompt decision details and persists before filesystem write', async () => {
  const f = fixture(), reports = f.create(), requestId = randomUUID(), captured = job();
  const result = await reports.record(captured, { requestId, stage: 'research', status: 'skipped', reason: 'No external application route',
    model: 'model-alpha', reasoningEffort: 'xhigh', profile: 'kevin', research: { state: 'completed', threadId: 'thread-1',
      result: { decision: 'skip', role: { eligible: true, category: 'software-development', evidence: 'Build production systems.' }, reason: 'No route' },
      diagnostics: { prompt: 'Evaluate role and remote evidence.', events: [{ at: '2026-10-14T00:00:00Z', type: 'callback-rejected', reason: 'Email was not verified',
        result: { decision: 'save', emails: [{ email: 'jobs@example.com', source: 'https://example.com/jobs' }] } }] } } });
  assert.equal(result.written, true); assert.equal(result.reportId, requestId);
  const written = f.calls[0].report;
  assert.deepEqual(written.job, captured); assert.equal(written.reasoningEffort, 'xhigh'); assert.equal(written.profile, 'kevin');
  assert.equal(written.research.diagnostics.events[0].reason, 'Email was not verified');
  assert.equal(f.calls[0].persisted.entries[0].report.reportId, requestId);
  assert.equal(f.values[KEY].entries.length, 0); assert.equal(f.alarms.size, 0);
});

test('permission outage survives worker restart and flush writes one idempotent report', async () => {
  const f = fixture(), requestId = randomUUID(); f.deny();
  const result = await f.create().record(job(), { requestId, stage: 'save', status: 'failed', reason: 'Folder permission expired' });
  assert.equal(result.queued, true); assert.equal(f.values[KEY].entries.length, 1); assert.equal(f.alarms.has(f.alarm), true);
  f.allow(); const restarted = f.create();
  assert.equal((await restarted.flush()).written, 1); assert.equal((await restarted.flush()).written, 0);
  assert.equal(f.files.size, 1); assert.equal(f.values[KEY].entries.length, 0); assert.equal(f.alarms.size, 0);
});

test('reports remain pinned to original destination after folder selection changes', async () => {
  const f = fixture(), original = f.destination(), requestId = randomUUID(); f.deny();
  await f.create().record(job(), { requestId, sheetUrl: original, stage: 'research', status: 'skipped', reason: 'Above Senior' });
  f.allow(); f.changeDestination('applicantally-file:' + randomUUID());
  const restarted = f.create(); assert.equal((await restarted.flush()).queued, 1); assert.equal(f.files.size, 0);
  assert.equal(f.values[KEY].entries[0].report.destination, original);
  f.changeDestination(original); assert.equal((await restarted.flush()).written, 1); assert.equal(f.files.size, 1);
});

test('unconfigured reports bind once to first selected destination and persist that identity before write', async () => {
  const f = fixture(); f.changeDestination('');
  await f.create().record(job(), { requestId: randomUUID(), stage: 'setup', status: 'failed', reason: 'No data folder selected' });
  assert.equal(f.values[KEY].entries[0].report.destinationUnassigned, true); assert.equal(f.files.size, 0);
  const selected = 'applicantally-file:' + randomUUID(); f.changeDestination(selected);
  assert.equal((await f.create().flush()).written, 1);
  assert.equal(f.calls[0].persisted.entries[0].report.destination, selected);
});

test('transient pending and unconfirmed reports become saved with preserved failure history', async () => {
  for (const status of ['pending', 'save-unconfirmed']) {
    const f = fixture(), reports = f.create(), requestId = randomUUID();
    await reports.record(job(), { requestId, stage: 'save', status, reason: 'Awaiting confirmation', willRetry: true,
      research: { result: { decision: 'save', reason: 'Verified route' } } });
    assert.equal(f.values[KEY].entries[0].written, true); assert.equal(f.alarms.size, 0);
    const resolved = await f.create().resolve(requestId); assert.equal(resolved.resolved, true); assert.equal(resolved.written, true);
    const latest = [...f.files.values()][0]; assert.equal(latest.status, 'saved'); assert.equal(latest.willRetry, false);
    assert.equal(latest.history[0].status, status); assert.equal(latest.history[0].reason, 'Awaiting confirmation');
    assert.equal(latest.research.result.reason, 'Verified route'); assert.equal(f.values[KEY].entries.length, 0);
    assert.equal(f.files.size, 1);
  }
});

test('storage persistence outage never writes an undurable report and can retry in the same worker', async () => {
  const f = fixture(), reports = f.create(); f.failStorage();
  const queued = await reports.record(job(), { requestId: randomUUID(), stage: 'research', status: 'failed', reason: 'Model failed' });
  assert.equal(queued.queued, true); assert.equal(f.calls.length, 0); assert.match(queued.warning, /Storage quota/u);
  f.restoreStorage(); assert.equal((await reports.flush()).written, 1); assert.equal(f.files.size, 1);
});

test('explicit whitelist omits private data and redacts tokens from errors, prompts and URLs', async () => {
  const f = fixture(), captureRef = 'a'.repeat(64), apiKey = 'sk-proj-' + 'S'.repeat(24), requestId = randomUUID();
  await f.create().record({ ...job(), privateProfile: 'PRIVATE_RESUME', sourceUrl: 'https://example.com/job?job=123&access_token=SECRET#access=SECRET' },
    { requestId, stage: 'research', status: 'failed', reason: `Invalid captureRef ${captureRef}`, client: 'PRIVATE_CLIENT',
      error: { code: 'CALLBACK_INVALID', message: `Bearer SECRET_TOKEN and ${apiKey}`, stack: 'PRIVATE_STACK' },
      research: { captureRef, client: 'PRIVATE_CLIENT', profileData: 'PRIVATE_RESUME', diagnostics: { prompt: `Use captureRef ${captureRef}`, privateProfile: 'PRIVATE_RESUME',
        events: [{ type: 'callback-rejected', reason: 'Invalid evidence', result: { decision: 'save', captureRef, candidate: 'PRIVATE_RESUME' } }] } } });
  const report = [...f.files.values()][0], raw = JSON.stringify(report);
  for (const secret of [captureRef, apiKey, 'PRIVATE_RESUME', 'PRIVATE_CLIENT', 'PRIVATE_STACK', 'SECRET_TOKEN', 'access_token', '#access']) assert.equal(raw.includes(secret), false);
  assert.equal(report.job.sourceUrl, 'https://example.com/job?job=123'); assert.match(report.error.message, /\[redacted\]/u);
  assert.equal(report.research.diagnostics.events[0].result.decision, 'save');
});

test('retry history stays bounded without repeating full descriptions and prompts', async () => {
  const f = fixture(), reports = f.create(), requestId = randomUUID();
  for (let retryCount = 1; retryCount <= 55; retryCount++) await reports.record(job(), { requestId, stage: 'research', status: 'pending',
    reason: 'Model at capacity', willRetry: true, research: { retryCount, diagnostics: { prompt: 'Classify this full captured job.' } } });
  const report = [...f.files.values()][0];
  assert.equal(report.history.length, 50);
  assert.equal(report.research.retryCount, 55);
  assert.equal(report.history[0].retryCount, 5);
  assert.ok(report.history.every(entry => entry.job === undefined && entry.research === undefined));
  assert.equal(f.values[KEY].entries.length, 1);
});
