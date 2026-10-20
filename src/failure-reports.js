(function exposeJobFailureReports(root) {
  'use strict';
  const STORAGE_KEY = 'jobTrackerFailureReportsV1';
  const ALARM = 'job-tracker-failure-reports';
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  const statuses = new Set(['skipped', 'failed', 'cancelled', 'pending', 'save-unconfirmed']);
  const transient = new Set(['pending', 'save-unconfirmed']);
  const researchKeys = new Set(['schemaVersion', 'requestId', 'job', 'model', 'reasoningEffort', 'createdAt', 'updatedAt',
    'threadId', 'turnId', 'completedAt', 'state', 'result', 'error', 'reason', 'prompt', 'events', 'diagnostics',
    'retryAt', 'retryCount', 'retryableResearch', 'at', 'timestamp', 'type', 'status', 'code', 'message', 'decision',
    'company', 'title', 'description', 'jobTitle', 'jobDescription', 'sourceUrl', 'applyUrl', 'finalUrl', 'url', 'jobId',
    'isEasyApply', 'workplaceType', 'posterName', 'applicationsClosed', 'selectedRegion', 'selectedRegionSource',
    'profileRoutingVersion', 'eligible', 'category', 'evidence', 'role', 'experience', 'minimumYears', 'scope',
    'fullyRemote', 'remoteEvidence', 'application', 'emails', 'email', 'address', 'source', 'sourceType',
    'route', 'active', 'applicationsOpen', 'free', 'descriptionEvidence', 'sourceEvidence', 'sourceQuote', 'kind',
    'detailAvailability', 'applicationsAvailable', 'jobIdSource', 'rejectedCallbacks', 'verificationReason', 'trackerVersion', 'descriptionDiagnostics']);
  const jobKeys = ['company', 'title', 'description', 'jobTitle', 'jobDescription', 'sourceUrl', 'applyUrl', 'jobId',
    'isEasyApply', 'workplaceType', 'posterName', 'applicationsClosed', 'applicationsAvailable', 'detailAvailability', 'jobIdSource',
    'selectedRegion', 'selectedRegionSource', 'profileRoutingVersion', 'verificationReason', 'trackerVersion', 'descriptionDiagnostics'];
  const detailMetadataLimits = { verificationReason: 2000, trackerVersion: 64, descriptionDiagnostics: 6000 };
  function cleanText(value) {
    return String(value).replace(/\b[a-f0-9]{64}\b/giu, '[redacted]')
      .replace(/\bsk-(?:proj-|svcacct-)?[a-z0-9_-]{12,}\b/giu, '[redacted]')
      .replace(/\b(Bearer\s+)[a-z0-9._~-]+/giu, '$1[redacted]')
      .replace(/((?:captureRef|access_token|refresh_token|api[_-]?key|client[_-]?nonce)\s*[:=]\s*["']?)[^\s,"'}&]+/giu, '$1[redacted]');
  }
  function cleanUrl(value) {
    if (!/^https?:\/\//iu.test(value)) return '';
    try {
      const parsed = new URL(value);
      parsed.username = ''; parsed.password = ''; parsed.hash = '';
      for (const name of [...parsed.searchParams.keys()]) if (/token|secret|api.?key|capture.?ref|client|access|authorization/iu.test(name)) parsed.searchParams.delete(name);
      return cleanText(parsed.href);
    } catch { return ''; }
  }
  function sanitize(value, depth = 0) {
    if (depth > 14) return undefined;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1)).filter(item => item !== undefined);
    if (!value || typeof value !== 'object') return undefined;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (!researchKeys.has(key)) continue;
      if (Object.hasOwn(detailMetadataLimits, key)) {
        if (typeof item === 'string') result[key] = cleanText(item).slice(0, detailMetadataLimits[key]);
        continue;
      }
      const safe = /(?:url|source)$/iu.test(key) && typeof item === 'string' && /^https?:\/\//iu.test(item)
        ? cleanUrl(item) : sanitize(item, depth + 1);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
  function publicJob(job) {
    const result = {};
    for (const key of jobKeys) if (job?.[key] !== undefined) {
      const value = job[key];
      if (Object.hasOwn(detailMetadataLimits, key)) {
        if (typeof value === 'string') result[key] = cleanText(value).slice(0, detailMetadataLimits[key]);
        continue;
      }
      if (typeof value === 'string') result[key] = /Url$/u.test(key) ? cleanUrl(value) : cleanText(value);
      else if (typeof value === 'boolean' || typeof value === 'number' || value === null) result[key] = value;
    }
    return result;
  }
  const destinationPattern = /^applicantally-file:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  function historyEntry(report) {
    return { at: report.updatedAt, status: report.status, stage: report.stage, reason: report.reason,
      willRetry: report.willRetry, ...(report.error ? { error: report.error } : {}),
      ...(report.research?.retryCount ? { retryCount: report.research.retryCount, retryAt: report.research.retryAt } : {}) };
  }
  function create({ storage = root.chrome?.storage.local, alarms = root.chrome?.alarms, sheetClient, cryptoImpl = root.crypto } = {}) {
    let tail = Promise.resolve(), state;
    const serial = operation => { const result = tail.then(operation, operation); tail = result.catch(() => {}); return result; };
    async function load() {
      if (state) return state;
      const saved = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
      if (saved !== undefined && (saved?.version !== 1 || !Array.isArray(saved.entries))) throw new Error('The failure report outbox could not be read.');
      state = saved || { version: 1, entries: [] };
      return state;
    }
    async function persist() {
      try { await storage.set({ [STORAGE_KEY]: state }); }
      finally {
        try {
          if (state.entries.some(entry => !entry.written)) await alarms?.create(ALARM, { periodInMinutes: 0.5 });
          else await alarms?.clear(ALARM);
        } catch { /* Logging alarms cannot change a capture result. */ }
      }
    }
    const warning = error => cleanText(error?.message || 'The failure report could not be written.');
    async function writeEntry(entry) {
      if (!entry.report.destination && entry.report.destinationUnassigned) {
        let destination;
        try {
          destination = (await sheetClient.getStatus()).sheetUrl;
        } catch { /* Await the first folder selection; known identities never move. */ }
        if (destinationPattern.test(destination || '')) {
          entry.report.destination = destination;
          delete entry.report.destinationUnassigned;
          try { await persist(); }
          catch (error) { return { reportId: entry.report.reportId, written: false, queued: true, warning: warning(error) }; }
        }
      }
      if (!entry.report.destination) return { reportId: entry.report.reportId, written: false, queued: true,
        warning: 'Choose the original ApplicantAlly data folder to write this report.' };
      try {
        await sheetClient.saveFailureReport(entry.report, { sheetUrl: entry.report.destination });
        entry.written = true;
        if (!transient.has(entry.report.status)) state.entries = state.entries.filter(value => value !== entry);
        await persist();
        return { reportId: entry.report.reportId, written: true, queued: false };
      } catch (error) {
        // Retain a successful write too if Chrome storage cannot acknowledge it;
        // the next flush rewrites the same UUID file without duplicate job files.
        entry.written = false;
        if (!state.entries.includes(entry)) state.entries.push(entry);
        try { await persist(); } catch { /* Keep the in-memory outbox available for another attempt. */ }
        return { reportId: entry.report.reportId, written: false, queued: true, warning: warning(error) };
      }
    }
    function record(job, details = {}) {
      return serial(async () => {
        let reportId;
        try {
          await load();
          const requestId = typeof details.requestId === 'string' ? cleanText(details.requestId) : '';
          let entry = requestId ? state.entries.find(value => value.report.requestId === requestId) : null;
          reportId = entry?.report.reportId || (uuid.test(requestId) ? requestId : cryptoImpl.randomUUID());
          let destination = entry?.report.destination || (typeof details.sheetUrl === 'string' ? details.sheetUrl : '');
          if (!destination && details.sheetUrl === undefined) {
            try { destination = (await sheetClient.getStatus()).sheetUrl || ''; } catch { /* Keep the report queued without moving it to a later workspace. */ }
          }
          if (!destinationPattern.test(destination)) destination = '';
          const timestamp = new Date().toISOString();
          const report = { version: 1, kind: 'job-tracker-not-saved', reportId,
            ...(requestId ? { requestId } : {}), destination, ...(!destination ? { destinationUnassigned: true } : {}), createdAt: entry?.report.createdAt || timestamp, updatedAt: timestamp,
            status: statuses.has(details.status) ? details.status : 'failed', stage: cleanText(details.stage || 'capture'),
            reason: cleanText(details.reason || 'The job was not saved.'), job: publicJob(job),
            ...(typeof details.model === 'string' ? { model: cleanText(details.model) } : {}),
            ...(typeof details.reasoningEffort === 'string' ? { reasoningEffort: cleanText(details.reasoningEffort) } : {}),
            ...(typeof details.profile === 'string' ? { profile: cleanText(details.profile) } : {}),
            ...(details.research ? { research: sanitize(details.research) } : {}),
            ...(details.error ? { error: sanitize({ code: details.error.code, message: details.error.message }) } : {}),
            ...(typeof details.willRetry === 'boolean' ? { willRetry: details.willRetry } : {}),
            history: entry?.report.history || [] };
          if (entry) report.history = [...report.history, historyEntry(entry.report)].slice(-50);
          else { entry = { report, written: false }; state.entries.push(entry); }
          entry.report = report; entry.written = false;
          await persist(); // Always persist before attempting a filesystem write.
          return writeEntry(entry);
        } catch (error) { return { reportId: reportId || null, written: false, queued: true, warning: warning(error) }; }
      });
    }
    function flush() {
      return serial(async () => {
        try {
          await load(); await persist();
          const results = [];
          for (const entry of [...state.entries]) if (!entry.written) results.push(await writeEntry(entry));
          return { written: results.filter(value => value.written).length, queued: state.entries.filter(value => !value.written).length,
            warnings: results.filter(value => value.warning).map(value => value.warning) };
        } catch (error) { return { written: 0, queued: state?.entries.length || 0, warnings: [warning(error)] }; }
      });
    }
    function resolve(requestId) {
      return serial(async () => {
        try {
          await load();
          const entry = state.entries.find(value => value.report.requestId === requestId && ['pending', 'save-unconfirmed'].includes(value.report.status));
          if (!entry) return { resolved: false };
          const previous = entry.report;
          entry.report = { ...previous, updatedAt: new Date().toISOString(), status: 'saved', stage: 'saved',
            reason: 'The job was saved successfully after retry.', willRetry: false,
            history: [...previous.history, historyEntry(previous)].slice(-50) };
          entry.written = false;
          await persist();
          return { resolved: true, ...await writeEntry(entry) };
        } catch (error) { return { resolved: false, queued: true, warning: warning(error) }; }
      });
    }
    return Object.freeze({ record, flush, resolve });
  }
  root.JobFailureReports = Object.freeze({ create, ALARM });
})(globalThis);
