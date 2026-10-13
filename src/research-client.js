(function exposeJobResearchClient(root) {
  "use strict";
  const ENDPOINT = "http://127.0.0.1:8787/job-research";
  const STORAGE_KEY = "jobTrackerResearchV1";
  const CLIENT_KEY = "jobTrackerResearchClientV1";
  const ALARM = "job-tracker-research";
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
  function researchUnavailable(status) {
    return Object.assign(new Error("Job research is temporarily unavailable. This job is queued and will retry automatically when the local research worker is running."),
      { code: "RESEARCH_UNAVAILABLE", retryableResearch: true, ...(status ? { status } : {}) });
  }
  function create({ storage = chrome.storage.local, fetchImpl = fetch, cryptoImpl = crypto,
    alarms = chrome.alarms, extensionId = chrome.runtime.id, sheetClient, bannedCompanies,
    onSaved = async () => {}, onOutcome = async () => {}, onProfileSelected = async () => {} } = {}) {
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
      // Storage errors must remain errors: only a failed research request can
      // authorize continuing collection with a durably queued job.
      const key = await clientKey();
      let response;
      try {
        response = await fetchImpl(`${ENDPOINT}${route}`, {
          method: body ? "POST" : "GET", redirect: "error", cache: "no-store",
          headers: { "X-Job-Tracker-Extension": extensionId, "X-Job-Tracker-Client": key,
            ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000)
        });
      } catch {
        throw researchUnavailable();
      }
      // Busy/unavailable services may return HTML rather than JSON.
      if (!response.ok && RETRYABLE_STATUS.has(response.status)) throw researchUnavailable(response.status);
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || "Research request failed."), { status: response.status });
      return value;
    }
    function publicJob(job) {
      return Object.fromEntries(["company", "title", "description", "applyUrl", "sourceUrl", "jobId", "isEasyApply", "workplaceType", "posterName", "applicationsClosed", "selectedRegion", "selectedRegionSource", "profileRoutingVersion"]
        .map((name) => [name, job[name]]).filter(([, value]) => value !== undefined));
    }
    async function start(job, { profile = "", tabId = null } = {}) {
      return serial(async () => {
        const roleSkipReason = JobCapturePolicy.roleSkipReason(job);
        if (roleSkipReason) return { status: "skipped", reason: roleSkipReason };
        const state = await sheetClient.getStatus();
        if (!state.configured) throw new Error("Choose your ApplicantAlly data folder before researching jobs.");
        const region = JobProfileRouting.jobRegion(job);
        const capturedJob = region ? { ...job, selectedRegion: region, profileRoutingVersion: JobProfileRouting.VERSION } : job;
        const records = await read();
        const identity = JSON.stringify([job.jobId || job.sourceUrl || "", job.company, job.title, job.description, state.sheetUrl, region ? "automatic" : profile, ...(region ? [region] : [])]);
        const existing = records.find((entry) => entry.identity === identity && !entry.terminal);
        if (existing) return { status: "researching", ...(existing.state === "requesting" ? { queued: true } : {}), requestId: existing.requestId, replayed: true, profile: existing.profile, profileRouting: existing.profileRouting };
        if (records.filter((entry) => !entry.terminal).length >= 100) throw new Error("Too many jobs are being researched. Wait for the current jobs to finish.");
        const routing = region ? JobProfileRouting.snapshot(capturedJob, await sheetClient.getOptions({ refresh: true })) : null;
        const selection = routing && region !== "us" ? JobProfileRouting.choose(capturedJob, routing) : null;
        const record = { requestId: cryptoImpl.randomUUID(), identity, job: capturedJob, profile: selection?.profile ?? (routing ? "" : profile), tabId,
          ...(routing ? { profileRouting: routing } : {}), ...(selection ? { profileSelection: selection } : {}),
          sheetUrl: state.sheetUrl, createdAt: Date.now(), state: "requesting" };
        const active = records.filter((entry) => !entry.terminal);
        const history = records.filter((entry) => entry.terminal && Date.now() - entry.createdAt < MAX_AGE).slice(-(199 - active.length));
        const next = [...history, ...active, record];
        await write(next);
        if (selection) await onProfileSelected(record, selection);
        try {
          await request("", { requestId: record.requestId, job: publicJob(record.job) });
          record.state = "researching";
          await write(next);
        } catch (error) {
          if (error.retryableResearch) return { status: "researching", queued: true, requestId: record.requestId, profile: record.profile, profileRouting: record.profileRouting };
          if (error.status) { record.terminal = true; record.state = "failed"; await write(next); }
          throw error;
        }
        return { status: "researching", requestId: record.requestId, profile: record.profile, profileRouting: record.profileRouting };
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
            // One outage must not hold the capture queue for 12 seconds per job.
            // The next alarm retries, retaining the original request IDs.
            if (error.retryableResearch) break;
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
            if (record.profileRouting && !record.profileSelection) {
              record.profileSelection = JobProfileRouting.choose(record.job, record.profileRouting, response.result?.experience);
              record.profile = record.profileSelection.profile;
              await write(records);
              await onProfileSelected(record, record.profileSelection);
            }
            // Old queued captures may contain the retired Kevin-to-Trash flag.
            // Every capture now saves through the normal Pending creation path.
            if (Object.hasOwn(record, "saveTrashed") || Object.hasOwn(record.profileSelection || {}, "trashed")) {
              delete record.saveTrashed;
              if (record.profileSelection) delete record.profileSelection.trashed;
              await write(records);
            }
            if (await bannedCompanies.has(job.company)) throw Object.assign(new Error("Skipped: company is banned."), { code: "BANNED_COMPANY" });
            const result = await sheetClient.saveJob(job, { profile: record.profile, requestId: record.requestId });
            record.state = "saved";
            await onSaved(job.company);
            await onOutcome(record, "Saved to ApplicantAlly.", result);
          } catch (error) {
            if (error.code === "LOCAL_STORE_UNAVAILABLE") {
              record.terminal = false;
              record.state = "waiting-save";
              continue;
            }
            record.state = error.code === "TRACKER_SAVE_UNCONFIRMED" ? "save-unconfirmed" : "failed";
            await onOutcome(record, error.code === "BANNED_COMPANY" ? error.message
              : error.code === "TRACKER_SAVE_UNCONFIRMED" ? "Save not confirmed. Check ApplicantAlly."
              : /^PROFILE_ROUTING_/u.test(error.code || "") ? error.message
              : "Could not save to ApplicantAlly.");
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
