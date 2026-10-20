const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { webcrypto, randomUUID } = require('node:crypto');

function notFound(error) { if (error.code === 'ENOENT') error.name = 'NotFoundError'; throw error; }
function directoryHandle(directory) {
  return { kind: 'directory', name: path.basename(directory), queryPermission: async () => 'granted',
    async getDirectoryHandle(name, { create = false } = {}) { const target = path.join(directory, name); if (create) await fs.mkdir(target, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; }); await fs.stat(target).catch(notFound); return directoryHandle(target); },
    async getFileHandle(name, { create = false } = {}) {
      const target = path.join(directory, name);
      if (create) await fs.writeFile(target, '', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await fs.stat(target).catch(notFound);
      return { kind: 'file', getFile: async () => ({ text: () => fs.readFile(target, 'utf8') }),
        async createWritable() { let raw; return { write: async value => { raw = value; }, abort: async () => {},
          close: async () => { const temporary = target + '.' + randomUUID() + '.tmp'; await fs.writeFile(temporary, raw); await fs.rename(temporary, target); } }; } };
    },
    async *entries() { for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isFile()) yield [entry.name, await this.getFileHandle(entry.name)]; }
  };
}
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-file-client-'));
  t.after(() => { assert.equal(path.dirname(temporary), os.tmpdir()); return fs.rm(temporary, { recursive: true, force: true }); });
  const runtime = path.join(temporary, 'data', 'workspace'), jobs = path.join(runtime, 'job-primary', 'applicantally-1', 'jobs'), library = path.join(runtime, 'profile-library');
  await fs.mkdir(jobs, { recursive: true }); await fs.mkdir(library);
  await fs.writeFile(path.join(runtime, 'applicantally-store.json'), JSON.stringify({ version: 1, format: 'applicantally-job-files', storeId: randomUUID(), jobsDirectory: 'job-primary/applicantally-1/jobs', profilesRegistry: 'profile-library/registry.json' }));
  const settings = { version: 1, profiles: ['kevin', 'jagjeet', 'michal', 'jose'].map(key => ({ key, label: key, enabled: true })) };
  await fs.writeFile(path.join(library, 'settings.json'), JSON.stringify(settings));
  await fs.writeFile(path.join(library, 'registry.json'), JSON.stringify(settings));
  const values = {}, storage = { get: async key => ({ [key]: values[key] }), set: async value => Object.assign(values, value), remove: async key => { delete values[key]; } };
  const context = vm.createContext({ structuredClone, TextEncoder, Uint8Array, navigator: {}, fetch() { throw Error('File integration must not call HTTP.'); } });
  for (const file of ['folder-access.js', 'kai-local-store-client.js']) vm.runInContext(await fs.readFile(path.join(__dirname, '..', 'src', file), 'utf8'), context);
  const handle = directoryHandle(temporary);
  let granted = true, selected = handle;
  handle.queryPermission = async () => granted ? 'granted' : 'prompt';
  const folderAccess = { read: async () => selected, clear: async () => { selected = null; }, resolve: context.ApplicantAllyFolder.resolve, readJson: context.ApplicantAllyFolder.readJson };
  const client = context.KaiLocalStoreClient.create({ folderAccess, cryptoImpl: webcrypto, storage });
  return { client, jobs, runtime, library, settings, deny: () => { granted = false; }, restore: () => { granted = true; },
    async record(name, job, deleted = false) { await fs.writeFile(path.join(jobs, name), JSON.stringify({ version: 1, kind: 'job', deleted, job })); } };
}
const job = company => ({ company, title: 'Engineer', description: 'Build services' });

test('tracker reads app-folder profiles and saves files with ApplicantAlly closed and no HTTP service', async t => {
  const f = await fixture(t), status = await f.client.getStatus();
  assert.equal(status.mode, 'files'); assert.equal(status.connection, 'connected');
  assert.deepEqual([...status.profileOptions.profiles], ['kevin', 'jagjeet', 'michal', 'jose']);
  const requestId = randomUUID(), result = await f.client.saveJob(job('Acme'), { profile: 'jose', requestId });
  assert.equal(result.inserted, true);
  const saved = JSON.parse(await fs.readFile(path.join(f.jobs, `capture-${requestId}.json`), 'utf8'));
  assert.equal(saved.job.profile, 'jose'); assert.equal(saved.job.status, 'added'); assert.equal(saved.job.addedBy, 'Job Tracker');
  assert.equal(saved.job.captureRequestId, requestId); assert.equal(saved.kind, 'capture');
});

test('a captured destination must match the resolved folder before any job file can be written', async t => {
  const f = await fixture(t);
  const status = await f.client.getStatus();
  const other = `applicantally-file:${randomUUID()}`;
  await assert.rejects(f.client.saveJob(job('Wrong destination'), { profile: 'kevin', sheetUrl: other }), error => error.code === 'SAVE_DESTINATION_CHANGED');
  assert.deepEqual(await fs.readdir(f.jobs), []);
  const saved = await f.client.saveJob(job('Correct destination'), { profile: 'kevin', sheetUrl: status.sheetUrl });
  assert.equal(saved.inserted, true);
});

test('expired research can reconcile an existing capture but cannot create a new job file', async t => {
  const f = await fixture(t), requestId = randomUUID();
  await assert.rejects(f.client.saveJob(job('Expired'), { requestId, replayOnly: true }), error => error.code === 'RESEARCH_RESULT_EXPIRED');
  assert.deepEqual(await fs.readdir(f.jobs), []);
  await f.client.saveJob(job('Already saved'), { requestId, profile: 'kevin' });
  const replayed = await f.client.saveJob(job('Changed stale input'), { requestId, profile: 'jagjeet', replayOnly: true });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.job.company, 'Already saved');
  assert.equal(replayed.job.profile, 'kevin');
});

test('Kevin and Jagjeet file saves discard every retired Trash flag and enter Pending', async t => {
  const f = await fixture(t);
  for (const profile of ['kevin', 'jagjeet']) {
    const result = await f.client.saveJob({ ...job(profile), status: 'trashed', trashMarked: true, initialTrash: true }, { profile, trashed: true, saveTrashed: true });
    assert.equal(result.job.status, 'added'); assert.equal(result.job.trashMarked, undefined); assert.equal(result.job.originalStatus, undefined);
  }
});

test('replays preserve app edits, recognize old API captures, and never recreate deleted jobs', async t => {
  const f = await fixture(t), requestId = randomUUID();
  await f.client.saveJob(job('Acme'), { requestId });
  await f.record(`capture-${requestId}.json`, { ...job('Acme'), jobTitle: 'Engineer', jobDescription: 'Original', status: 'tailored', rowNumber: 22, captureRequestId: requestId });
  const replay = await f.client.saveJob(job('Acme'), { requestId }); assert.equal(replay.replayed, true); assert.equal(replay.job.status, 'tailored');
  const previousRequest = randomUUID(); await f.record('row-23.json', { company: 'Previous API capture', status: 'added', captureRequestId: previousRequest });
  assert.equal((await f.client.saveJob(job('Previous API capture'), { requestId: previousRequest })).replayed, true);
  await f.record(`capture-${requestId}.json`, replay.job, true);
  await assert.rejects(f.client.saveJob(job('Acme'), { requestId }), { code: 'CAPTURE_DELETED' });
});

test('duplicate checks and company snapshots use fresh files and retain lifecycle exceptions', async t => {
  const f = await fixture(t);
  await f.record('row-2.json', { company: ' Acme ', status: 'tailored', rowNumber: 2 });
  await f.record('row-3.json', { company: 'Trash Company', status: 'trashed', trashMarked: true });
  await f.record('row-4.json', { company: 'Restricted Company', status: 'location restriction' });
  assert.equal((await f.client.lookupDuplicate('ACME')).duplicate.rowNumber, 2);
  assert.equal((await f.client.lookupDuplicate('Restricted Company')).duplicate, null);
  assert.equal((await f.client.lookupDuplicate('Trash Company')).duplicate, null);
  const snapshot = await f.client.getCompanies(); assert.deepEqual([...snapshot.companies], ['Acme']);
  assert.equal((await f.client.getCompanies({ revision: snapshot.revision })).unchanged, true);
  await assert.rejects(f.client.saveJob(job('Acme')), { code: 'DUPLICATE_COMPANY' });
  const saves = await Promise.allSettled([1, 2].map(() => f.client.saveJob(job('Same Company'))));
  assert.equal(saves.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(saves.find(value => value.status === 'rejected').reason.code, 'DUPLICATE_COMPANY');
});

test('profile sync rereads settings, including renamed and disabled profiles while app is closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.getOptions()).profiles[0], 'kevin');
  await fs.writeFile(path.join(f.library, 'settings.json'), JSON.stringify({ version: 1, profiles: [
    { key: 'kevin-lee-2page', label: 'Updated Kevin', enabled: true }, { key: 'jagjeet', label: 'Jagjeet', enabled: false }
  ] }));
  const latest = await f.client.getOptions({ refresh: true });
  assert.deepEqual([...latest.profiles], ['kevin-lee-2page']); assert.equal(latest.profileLabels['kevin-lee-2page'], 'Updated Kevin');
  await assert.rejects(f.client.saveJob(job('Disabled profile'), { profile: 'jagjeet' }), { code: 'PROFILE_NOT_FOUND' });
  await fs.unlink(path.join(f.library, 'settings.json'));
  assert.equal((await f.client.getOptions()).profiles[0], 'kevin');
  await fs.writeFile(path.join(f.library, 'settings.json'), '{');
  await assert.rejects(f.client.getOptions());
});

test('expired folder permission preserves destination for queued research, and missing folder requires setup', async t => {
  const f = await fixture(t), before = await f.client.getStatus(); f.deny();
  const offline = await f.client.getStatus(); assert.equal(offline.configured, true); assert.equal(offline.connection, 'offline'); assert.equal(offline.sheetUrl, before.sheetUrl);
  await assert.rejects(f.client.saveJob(job('Denied')), { code: 'LOCAL_STORE_UNAVAILABLE' });
  f.restore(); assert.equal((await f.client.getStatus()).connection, 'connected');
  await f.client.clearConfiguration(); assert.equal((await f.client.getStatus()).configured, false);
  await assert.rejects(f.client.saveJob(job('Missing')), { code: 'CONFIG_REQUIRED' });
});

test('failure reports write readable idempotent JSON beside jobs without inserting or trashing jobs', async t => {
  const f = await fixture(t), destination = (await f.client.getStatus()).sheetUrl;
  const report = { version: 1, reportId: randomUUID(), destination, updatedAt: '2026-10-14T00:00:00.000Z', status: 'skipped', reason: 'Above Senior scope', job: job('Unsaved Company') };
  await f.client.saveFailureReport(report, { sheetUrl: destination });
  await f.client.saveFailureReport(report, { sheetUrl: destination });
  const reportDirectory = path.join(f.runtime, 'job-tracker-reports', 'not-saved');
  assert.deepEqual(await fs.readdir(reportDirectory), [report.reportId + '.json']);
  const raw = await fs.readFile(path.join(reportDirectory, report.reportId + '.json'), 'utf8');
  assert.match(raw, /\n  "reason": "Above Senior scope"/u);
  assert.deepEqual(JSON.parse(raw), report);
  assert.deepEqual(await fs.readdir(f.jobs), []);
  assert.equal((await f.client.lookupDuplicate('Unsaved Company')).duplicate, null);
});

test('failure report filenames reject traversal and mismatched or missing original destinations', async t => {
  const f = await fixture(t), destination = (await f.client.getStatus()).sheetUrl;
  for (const reportId of ['../../escape', 'a'.repeat(36), randomUUID() + '/escape', randomUUID().toUpperCase()])
    await assert.rejects(f.client.saveFailureReport({ reportId, destination }, { sheetUrl: destination }), { code: 'INVALID_FAILURE_REPORT' });
  await assert.rejects(f.client.saveFailureReport({ reportId: randomUUID(), destination }), { code: 'REPORT_DESTINATION_REQUIRED' });
  const other = 'applicantally-file:' + randomUUID();
  await assert.rejects(f.client.saveFailureReport({ reportId: randomUUID(), destination: other }, { sheetUrl: other }), { code: 'REPORT_DESTINATION_CHANGED' });
  await assert.rejects(fs.stat(path.join(f.runtime, 'job-tracker-reports')), { code: 'ENOENT' });
  f.deny();
  await assert.rejects(f.client.saveFailureReport({ reportId: randomUUID(), destination }, { sheetUrl: destination }), { code: 'LOCAL_STORE_UNAVAILABLE' });
});
