(function registerKaiLocalStoreClient(root) {
  'use strict';
  const normalize = value => String(value || '').replace(/\s+/gu, ' ').trim();
  const companyKey = value => normalize(value).toLocaleLowerCase('en-US');
  const fail = (message, code = 'LOCAL_STORE_UNAVAILABLE', details) => Object.assign(new Error(message), { code, details });
  const recordName = /^(?:row-\d+|capture-[a-f0-9-]{36})\.json$/u;
  const nonBlockingStatuses = new Set(['trashed', 'deleted', 'restricted', 'clearance', 'location restriction', 'location-restriction',
    'on-site', 'onsite', 'language', 'not applicable', 'not-applicable']);
  const blocksCompany = job => !job.trashMarked && !nonBlockingStatuses.has(companyKey(job.status));
  function create({ folderAccess = ApplicantAllyFolder, cryptoImpl = crypto, locks = navigator.locks, storage = globalThis.chrome?.storage.local } = {}) {
    let tail = Promise.resolve();
    let targetIdentity = '';
    async function init() { /* Folder handles are read afresh after worker restarts. */ }
    async function workspace() {
      const handle = await folderAccess.read();
      if (!handle) throw fail('Choose your ApplicantAlly data folder in Folder settings.', 'CONFIG_REQUIRED');
      if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted')
        throw fail('Allow access to your ApplicantAlly folder in Folder settings.');
      try {
        const result = await folderAccess.resolve(handle);
        let jobs = result.directory;
        for (const part of result.descriptor.jobsDirectory.split('/')) jobs = await jobs.getDirectoryHandle(part);
        return { ...result, jobs };
      } catch (error) { throw fail('The ApplicantAlly folder needs attention: ' + error.message, 'INVALID_FILE_STORE'); }
    }
    async function optionsAt(folder) {
      const library = await folder.directory.getDirectoryHandle('profile-library');
      // settings.json is authoritative; registry.json supports older app folders.
      let registry;
      try { registry = await folderAccess.readJson(library, 'settings.json'); }
      catch (error) { if (error.name !== 'NotFoundError') throw error; registry = await folderAccess.readJson(library, 'registry.json'); }
      if (registry.version !== 1 || !Array.isArray(registry.profiles)) throw fail('The profile registry is invalid.', 'INVALID_FILE_STORE');
      const active = registry.profiles.filter(profile => profile.enabled !== false);
      if (active.some(profile => !profile.key || !profile.label) || new Set(active.map(profile => profile.key)).size !== active.length)
        throw fail('The profile registry contains invalid or duplicate profiles.', 'INVALID_FILE_STORE');
      return { profiles: active.map(profile => profile.key), profileLabels: Object.fromEntries(active.map(profile => [profile.key, profile.label])),
        statuses: ['added', 'validated', 'tailored', 'applied', 'interviewed', 'trashed'] };
    }
    async function recordsAt(folder, { includeDeleted = false } = {}) {
      const records = [];
      for await (const [name, handle] of folder.jobs.entries()) {
        if (handle.kind !== 'file' || !recordName.test(name)) continue;
        try {
          const raw = await (await handle.getFile()).text();
          if (!raw) continue;
          const record = JSON.parse(raw);
          if (record.version !== 1 || !['job', 'capture'].includes(record.kind) || !record.job) throw new Error('Invalid record.');
          if (!record.deleted || includeDeleted) records.push({ name, record });
        } catch (error) { throw fail(`Cannot read job file ${name}. Retry after the file has finished saving.`, 'LOCAL_STORE_UNAVAILABLE'); }
      }
      return records;
    }
    function duplicateIn(records, company) {
      const found = records.filter(value => !value.record.deleted).map(value => value.record.job).filter(job => blocksCompany(job) && companyKey(job.company) === companyKey(company))
        .sort((a, b) => (Number(b.rowNumber) || 0) - (Number(a.rowNumber) || 0))[0];
      return found ? { rowNumber: found.rowNumber || null, company: found.company, jobTitle: found.jobTitle, status: found.status,
        jobDescriptionPreview: String(found.jobDescription || '').slice(0, 280) } : null;
    }
    async function getOptions() { return optionsAt(await workspace()); }
    async function getStatus() {
      targetIdentity ||= (await storage?.get('applicantAllyFolderIdentity'))?.applicantAllyFolderIdentity || '';
      const configured = Boolean(await folderAccess.read());
      try {
        const folder = await workspace();
        targetIdentity = `applicantally-file:${folder.descriptor.storeId}`;
        await storage?.set({ applicantAllyFolderIdentity: targetIdentity });
        return { configured: true, connection: 'connected', mode: 'files', sheetTitle: 'ApplicantAlly data folder',
          sheetUrl: targetIdentity, entries: [], profileOptions: await optionsAt(folder) };
      } catch (error) { return { configured, connection: configured ? 'offline' : 'unconfigured', mode: 'files',
        sheetUrl: targetIdentity, entries: [], error: { code: error.code, message: error.message } }; }
    }
    async function configure() { return getStatus(); }
    async function clearConfiguration() { await folderAccess.clear(); targetIdentity = ''; await storage?.remove('applicantAllyFolderIdentity'); return getStatus(); }
    async function lookupDuplicate(company) { return { duplicate: duplicateIn(await recordsAt(await workspace()), company) }; }
    async function getCompanies({ revision = '' } = {}) {
      const records = await recordsAt(await workspace());
      const companies = [...new Map(records.filter(({ record }) => blocksCompany(record.job))
        .filter(({ record }) => normalize(record.job.company)).map(({ record }) => [companyKey(record.job.company), normalize(record.job.company)])).values()]
        .sort((a, b) => a.localeCompare(b));
      const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(companies)));
      const current = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return current === revision ? { revision: current, unchanged: true } : { companies, revision: current, unchanged: false };
    }
    function saveJob(input, { profile = '', requestId = cryptoImpl.randomUUID() } = {}) {
      const save = async () => {
        const folder = await workspace();
        if (!/^[a-f0-9-]{36}$/u.test(requestId)) throw fail('Invalid capture identity.', 'INVALID_CAPTURE_REQUEST');
        const name = `capture-${requestId}.json`;
        const records = await recordsAt(folder, { includeDeleted: true });
        const existing = records.find(value => value.name === name || value.record.job.captureRequestId === requestId);
        if (existing?.record.deleted) throw fail('This captured job was deleted in ApplicantAlly.', 'CAPTURE_DELETED');
        if (existing) return { inserted: false, replayed: true, job: existing.record.job, rowNumber: existing.record.job.rowNumber || null };
        const job = { company: normalize(input.company), jobTitle: normalize(input.jobTitle || input.title),
          jobDescription: String(input.jobDescription || input.description || '').trim(), applyUrl: normalize(input.applyUrl),
          info: String(input.info || ''), profile, status: 'added',
          date: '', addedBy: 'Job Tracker', captureRequestId: requestId };
        if (!job.company || !job.jobTitle || !job.jobDescription || job.company.length > 1000 || job.jobTitle.length > 1000 ||
          job.jobDescription.length > 49000 || job.applyUrl.length > 4096 || job.info.length > 49000)
          throw fail('Enter a complete job within the field limits.', 'INVALID_CAPTURE_REQUEST');
        if (profile && !(await optionsAt(folder)).profiles.includes(profile)) throw fail('Select an active profile from ApplicantAlly.', 'PROFILE_NOT_FOUND');
        const duplicate = duplicateIn(records, job.company);
        if (duplicate) throw fail('This company already has a recorded job.', 'DUPLICATE_COMPANY', { duplicate });
        const handle = await folder.jobs.getFileHandle(name, { create: true });
        const writable = await handle.createWritable({ mode: 'exclusive' });
        try {
          await writable.write(JSON.stringify({ version: 1, kind: 'capture', createdAt: new Date().toISOString(), job }));
          await writable.close();
        } catch (error) { await writable.abort().catch(() => {}); throw fail('The job file could not be saved: ' + error.message); }
        const confirmed = JSON.parse(await (await handle.getFile()).text());
        if (confirmed.job?.captureRequestId !== requestId || confirmed.deleted) throw fail('The file save was not confirmed.', 'TRACKER_SAVE_UNCONFIRMED');
        return { inserted: true, replayed: false, job: confirmed.job, rowNumber: confirmed.job.rowNumber || null };
      };
      const run = () => locks?.request ? locks.request('applicantally-job-save', save) : save();
      const result = tail.then(run, run); tail = result.catch(() => {}); return result;
    }
    return Object.freeze({ init, configure, clearConfiguration, getOptions, lookupDuplicate, getCompanies, saveJob, getStatus });
  }
  root.KaiLocalStoreClient = Object.freeze({ create });
})(globalThis);
