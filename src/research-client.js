(function exposeJobResearchClient(root) {
  "use strict";
  const ENDPOINT = "http://127.0.0.1:8787/job-research";
  const STORAGE_KEY = "jobTrackerResearchV1";
  const CLIENT_KEY = "jobTrackerResearchClientV1";
  const ALARM = "job-tracker-research";
  const MAX_AGE = 24 * 60 * 60 * 1000;
  function create({ storage = chrome.storage.local, fetchImpl = fetch, cryptoImpl = crypto,
    alarms = chrome.alarms, extensionId = chrome.runtime.id, sheetClient, bannedCompanies,
    onSaved = async () => {}, onOutcome = async () => {} } = {}) {
    let tail = Promise.resolve();
    const serial = (operation) => {
      const result = tail.then(operation, operation);
      tail = result.catch(() => {});
      return result;
    };
    async function read() {
      const records = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
      if (records === undefined) return [];
      if (!Array.isArray(records)) throw new Error("The saved research requests could not be read.");
      return records;
    }
    async function write(records) {
      await storage.set({ [STORAGE_KEY]: records });
      if (records.some((record) => !record.terminal)) await alarms.create(ALARM, { periodInMinutes: 0.5 });
      else await alarms.clear(ALARM);
    }
    async function clientKey() {
      let value = (await storage.get(CLIENT_KEY))[CLIENT_KEY];
      if (!/^[a-f0-9]{64}$/u.test(value || "")) {
        value = [...cryptoImpl.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        await storage.set({ [CLIENT_KEY]: value });
      }
      return value;
    }
    async function request(route, body) {
      let response;
      try {
        response = await fetchImpl(`${ENDPOINT}${route}`, {
          method: body ? "POST" : "GET", redirect: "error", cache: "no-store",
          headers: { "X-Job-Tracker-Extension": extensionId, "X-Job-Tracker-Client": await clientKey(),
            ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000)
        });
      } catch {
        throw new Error("Rezi Builder research is unavailable. Start the local Rezi Builder; this job has not been saved.");
      }
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || "Research request failed."), { status: response.status });
      return value;
    }
    function publicJob(job) {
      return Object.fromEntries(["company", "title", "description", "applyUrl", "sourceUrl", "jobId", "isEasyApply", "workplaceType", "posterName", "applicationsClosed"]
        .map((name) => [name, job[name]]).filter(([, value]) => value !== undefined));
    }
    async function start(job, { profile = "", tabId = null } = {}) {
      return serial(async () => {
        const roleSkipReason = JobCapturePolicy.roleSkipReason(job);
        if (roleSkipReason) return { status: "skipped", reason: roleSkipReason };
        const state = await sheetClient.getStatus();
        if (!state.configured) throw new Error("Start Kai Flow before researching jobs.");
        const records = await read();
        const identity = JSON.stringify([job.jobId || job.sourceUrl || "", job.company, job.title, job.description, state.sheetUrl, profile]);
        const existing = records.find((entry) => entry.identity === identity && !entry.terminal);
        if (existing) return { status: "researching", requestId: existing.requestId, replayed: true };
        if (records.filter((entry) => !entry.terminal).length >= 100) throw new Error("Too many jobs are being researched. Wait for the current jobs to finish.");
        const record = { requestId: cryptoImpl.randomUUID(), identity, job, profile, tabId,
          sheetUrl: state.sheetUrl, createdAt: Date.now(), state: "requesting" };
        const active = records.filter((entry) => !entry.terminal);
        const history = records.filter((entry) => entry.terminal && Date.now() - entry.createdAt < MAX_AGE).slice(-(199 - active.length));
        const next = [...history, ...active, record];
        await write(next);
        try {
          await request("", { requestId: record.requestId, job: publicJob(job) });
          record.state = "researching";
          await write(next);
        } catch (error) {
          if (error.status && error.status !== 503) { record.terminal = true; record.state = "failed"; await write(next); }
          throw error;
        }
        return { status: "researching", requestId: record.requestId };
      });
    }
    async function poll() {
      return serial(async () => {
        const records = await read();
        const state = await sheetClient.getStatus();
        for (const record of records.filter((entry) => !entry.terminal)) {
          const roleSkipReason = JobCapturePolicy.roleSkipReason(record.job);
          if (roleSkipReason) {
            record.terminal = true; record.state = "skipped";
            await write(records);
            await onOutcome(record, roleSkipReason);
            continue;
          }
          if (!state.configured || state.sheetUrl !== record.sheetUrl || Date.now() - record.createdAt > MAX_AGE) {
            record.terminal = true; record.state = "cancelled"; continue;
          }
          let response;
          try {
            if (record.state === "requesting") {
              await request("", { requestId: record.requestId, job: publicJob(record.job) });
              record.state = "researching";
            }
            response = await request(`/${encodeURIComponent(record.requestId)}`);
          } catch (error) {
            if (error.status === 404 || error.status === 409) { record.terminal = true; record.state = "failed"; }
            continue;
          }
          if (!["completed", "failed"].includes(response.state)) continue;
          // Captures carry a persistent request ID. A lost local-store response
          // can be retried without inserting the job twice.
          record.terminal = true;
          record.state = response.state === "failed" ? "failed" : "skipped";
          await write(records);
          const verifiedAt = Date.parse(response.completedAt);
          const job = response.state === "completed" && Number.isFinite(verifiedAt) &&
            Date.now() - verifiedAt < 60 * 60 * 1000 && verifiedAt <= Date.now() + 60_000
            ? JobCapturePolicy.verifiedJob(record.job, response.result) : null;
          if (!job) {
            const remoteUnconfirmed = JobCapturePolicy.remoteSkipReason(record.job) ||
              (JobCapturePolicy.needsRemoteCheck(record.job) && response.result?.fullyRemote !== true);
            await onOutcome(record, response.state === "failed" ? "Research failed."
              : !JobCapturePolicy.verifiedRole(record.job, response.result) ? "Skipped: software engineering role not confirmed."
              : remoteUnconfirmed ? "Skipped: fully remote work not confirmed."
              : "Skipped: no verified apply link or email.");
            continue;
          }
          try {
            if (await bannedCompanies.has(job.company)) throw Object.assign(new Error("Skipped: company is banned."), { code: "BANNED_COMPANY" });
            const result = await sheetClient.saveJob(job, { profile: record.profile, requestId: record.requestId });
            record.state = "saved";
            await onSaved(job.company);
            await onOutcome(record, "Saved to Kai Flow.", result);
          } catch (error) {
            if (error.code === "LOCAL_STORE_UNAVAILABLE") {
              record.terminal = false;
              record.state = "waiting-save";
              continue;
            }
            record.state = error.code === "TRACKER_SAVE_UNCONFIRMED" ? "save-unconfirmed" : "failed";
            await onOutcome(record, error.code === "BANNED_COMPANY" ? error.message
              : error.code === "TRACKER_SAVE_UNCONFIRMED" ? "Save not confirmed. Check Kai Flow."
              : "Could not save to Kai Flow.");
          }
        }
        await write(records);
      });
    }
    function clear() { return serial(async () => { await storage.remove(STORAGE_KEY); await alarms.clear(ALARM); }); }
    return { start, poll, clear };
  }
  root.JobResearchClient = Object.freeze({ create, ALARM });
})(typeof globalThis === "undefined" ? this : globalThis);
