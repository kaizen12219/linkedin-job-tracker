(function exposeJobResearchClient(root) {
  "use strict";
  const ENDPOINT = "http://127.0.0.1:8787/job-research";
  const STORAGE_KEY = "jobTrackerResearchV1";
  const CLIENT_KEY = "jobTrackerResearchClientV1";
  const MODEL_KEY = "jobTrackerResearchModelV1";
  const EFFORT_KEY = "jobTrackerResearchEffortV1";
  const RECOVERY_HOST = "com.applicantally.job_research";
  const ALARM = "job-tracker-research";
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  function researchUnavailable(status) {
    return Object.assign(new Error("Job research is temporarily unavailable. This job is queued and will retry automatically when the local research worker is running."),
      { code: "RESEARCH_UNAVAILABLE", retryableResearch: true, ...(status ? { status } : {}) });
  }
  function create({ storage = chrome.storage.local, fetchImpl = fetch, cryptoImpl = crypto,
    alarms = chrome.alarms, extensionId = chrome.runtime.id, sheetClient, bannedCompanies,
    nativeMessaging = chrome.runtime.sendNativeMessage?.bind(chrome.runtime),
    onSaved = async () => {}, onOutcome = async () => {}, onProfileSelected = async () => {}, onNotSaved = async () => {} } = {}) {
    let tail = Promise.resolve();
    let recovery = null;
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
      if (records.some((record) => !record.terminal || record.saveClaim)) await alarms.create(ALARM, { periodInMinutes: 0.5 });
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
    const fileDestination = (destination) => typeof destination === "string" && destination.startsWith("applicantally-file:");
    function coordinationFailure(error) {
      return Object.assign(new Error(error?.message || "Another browser is saving this company. This job will retry automatically."),
        { code: error?.code === "SAVE_COORDINATION_BUSY" ? error.code : "SAVE_COORDINATION_UNAVAILABLE", saveCoordination: true });
    }
    async function persistSaveState(records) {
      try { await write(records); }
      catch (error) { error.saveStatePersistence = true; throw error; }
    }
    async function acquireSaveClaim(record, records) {
      record.saveClaim = { ...record.saveClaim, destination: record.sheetUrl, phase: "acquiring" };
      record.terminal = false; record.state = "waiting-save";
      await persistSaveState(records);
      let result;
      try {
        if (!UUID.test(record.sheetUrl.slice("applicantally-file:".length))) throw new Error("The original ApplicantAlly destination is invalid.");
        result = await request(`/${encodeURIComponent(record.requestId)}/save-claim`, { action: "acquire", destination: record.sheetUrl });
        if (result?.acquired !== true || !UUID.test(result.token || "")) throw coordinationFailure(result);
      } catch (error) { throw error.saveCoordination ? error : coordinationFailure(error); }
      record.saveClaim = { token: result.token, destination: record.sheetUrl, phase: "writing" };
      record.terminal = false; record.state = "waiting-save";
      // A crash can replay the same request/file. Never write before ownership
      // and its recovery identity have reached durable browser storage.
      await persistSaveState(records);
    }
    async function settleSaveClaim(record, records) {
      const claim = record.saveClaim;
      if (claim?.phase !== "settle") return false;
      try {
        const result = await request(`/${encodeURIComponent(record.requestId)}/save-claim`,
          { action: "settle", destination: claim.destination, token: claim.token });
        if (result?.settled !== true) return false;
      } catch { return false; }
      delete record.saveClaim;
      delete record.saveResearch;
      await persistSaveState(records);
      return true;
    }
    async function cancelSaveClaim(record, records) {
      if (!record.saveClaim) return true;
      record.saveCancelled = true; record.terminal = true; record.state = "cancelled";
      await persistSaveState(records);
      if (record.saveClaim.phase !== "settle") {
        // This function runs only after this client's save promise has settled.
        // Recover an ambiguous grant before cancelling; never start a file write.
        if (!record.saveClaim.token) {
          let result;
          try { result = await request(`/${encodeURIComponent(record.requestId)}/save-claim`, { action: "acquire", destination: record.saveClaim.destination }); }
          catch { return false; }
          if (result?.acquired !== true || !UUID.test(result.token || "")) return false;
          record.saveClaim.token = result.token;
        }
        record.saveClaim.phase = "settle";
        await persistSaveState(records);
      }
      return settleSaveClaim(record, records);
    }
    async function saveJob(record, job, records, response) {
      const gated = fileDestination(record.sheetUrl);
      if (gated) {
        record.saveResearch = { state: response.state, completedAt: response.completedAt, result: response.result };
        await acquireSaveClaim(record, records);
      }
      let result;
      try {
        result = await sheetClient.saveJob(job, { profile: record.profile, requestId: record.requestId,
          ...(gated ? { sheetUrl: record.sheetUrl,
            ...(Date.now() - Date.parse(response.completedAt) >= 60 * 60 * 1000 ? { replayOnly: true } : {}) } : {}) });
      } catch (error) {
        if (gated) {
          // The filesystem promise has settled, including close/abort. Only
          // this phase may release a claim, even after a worker restart.
          record.saveClaim.phase = "settle";
          await persistSaveState(records);
        }
        throw error;
      }
      record.terminal = true; record.state = "saved";
      if (gated) {
        record.saveClaim.phase = "settle";
        await persistSaveState(records);
        await settleSaveClaim(record, records);
      }
      return result;
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
    async function selectedSettings() {
      const values = await storage.get([MODEL_KEY, EFFORT_KEY]);
      return { selectedModel: typeof values[MODEL_KEY] === "string" ? values[MODEL_KEY] : "",
        selectedReasoningEffort: typeof values[EFFORT_KEY] === "string" ? values[EFFORT_KEY] : "" };
    }
    function startWorker() {
      if (recovery) return recovery;
      recovery = (async () => {
        const missing = () => Object.assign(new Error("The recovery helper is not installed. Run scripts/install-research-helper.cmd once from your extension folder, then reconnect."), { code: "RESEARCH_HELPER_MISSING" });
        if (typeof nativeMessaging !== "function") throw missing();
        let result;
        try {
          const timeout = AbortSignal.timeout(25000);
          const expired = new Promise((_, reject) => timeout.addEventListener("abort", () => reject(
            Object.assign(new Error("Research has not finished starting. Wait a moment, then reconnect again."), { code: "RESEARCH_START_TIMEOUT" })), { once: true }));
          result = await Promise.race([nativeMessaging(RECOVERY_HOST, { action: "start" }), expired]);
        } catch (error) {
          if (error.code === "RESEARCH_START_TIMEOUT") throw error;
          if (/not found|not installed|specified native messaging host/u.test(String(error.message).toLowerCase())) throw missing();
          throw Object.assign(new Error("Research recovery could not connect. Reload the extension and try again."), { code: "RESEARCH_HELPER_FAILED" });
        }
        if (result?.ok !== true || result.status !== "ready") throw Object.assign(new Error(result?.error?.message || "Research could not start. Try reconnecting again."),
          { code: result?.error?.code || "RESEARCH_START_FAILED" });
        void poll().catch(() => {});
        return { status: "ready", alreadyRunning: result.alreadyRunning === true };
      })().finally(() => { recovery = null; });
      return recovery;
    }
    async function getModels() {
      let catalog;
      try { catalog = await request("/models"); }
      catch (error) {
        if (error.retryableResearch) error.message = "Research is offline. Click Start / reconnect research to start it and load the AI models.";
        throw error;
      }
      if (!catalog || !Array.isArray(catalog.models) || typeof catalog.defaultModel !== "string" ||
        catalog.models.some((model) => typeof model?.id !== "string" || !model.id || typeof model.name !== "string")) {
        throw Object.assign(new Error("The signed-in session's model list could not be read. Refresh the AI models."),
          { code: "RESEARCH_MODELS_UNAVAILABLE" });
      }
      return { models: catalog.models.map((model) => ({ id: model.id, name: model.name,
        ...(typeof model.description === "string" ? { description: model.description } : {}),
        ...(Array.isArray(model.reasoningEfforts) ? { reasoningEfforts: model.reasoningEfforts.filter((effort) => typeof effort === "string") } : {}),
        ...(typeof model.defaultReasoningEffort === "string" ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}) })),
        defaultModel: catalog.defaultModel,
        ...(typeof catalog.defaultReasoningEffort === "string" ? { defaultReasoningEffort: catalog.defaultReasoningEffort } : {}),
        ...await selectedSettings() };
    }
    function setModel(model) {
      return serial(async () => {
        if (typeof model !== "string" || model.length > 200) {
          throw Object.assign(new Error("Choose an AI model from the signed-in session's list."), { code: "RESEARCH_MODEL_INVALID" });
        }
        let { selectedReasoningEffort } = await selectedSettings();
        if (model || selectedReasoningEffort) {
          const catalog = await getModels();
          const available = catalog.models.find(entry => entry.id === (model || catalog.defaultModel));
          if (!available) throw Object.assign(new Error("That AI model is unavailable in the signed-in session. Refresh the model list and choose again."),
            { code: "RESEARCH_MODEL_UNAVAILABLE" });
          if (!available.reasoningEfforts?.includes(selectedReasoningEffort)) selectedReasoningEffort = "";
        }
        // Store the pair together so a capture cannot combine preferences from two saves.
        await storage.set({ [MODEL_KEY]: model, [EFFORT_KEY]: selectedReasoningEffort });
        return { selectedModel: model, selectedReasoningEffort };
      });
    }
    function setReasoningEffort(reasoningEffort) {
      return serial(async () => {
        if (typeof reasoningEffort !== "string" || reasoningEffort.length > 100) {
          throw Object.assign(new Error("Choose a reasoning level from the selected model's list."), { code: "RESEARCH_EFFORT_INVALID" });
        }
        const { selectedModel } = await selectedSettings();
        if (reasoningEffort) {
          const catalog = await getModels();
          const available = catalog.models.find(entry => entry.id === (selectedModel || catalog.defaultModel));
          if (!available?.reasoningEfforts?.includes(reasoningEffort)) {
            throw Object.assign(new Error("That reasoning level is unavailable for the selected model. Refresh the models and choose a supported level."),
              { code: "RESEARCH_EFFORT_UNAVAILABLE" });
          }
        }
        await storage.set({ [MODEL_KEY]: selectedModel, [EFFORT_KEY]: reasoningEffort });
        return { selectedModel, selectedReasoningEffort: reasoningEffort };
      });
    }
    function submission(record) {
      return { requestId: record.requestId, job: publicJob(record.job), ...(record.model ? { model: record.model } : {}),
        ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}) };
    }
    function freezeAcceptedSettings(record, response) {
      if (!record.model && typeof response?.model === "string" && response.model) record.model = response.model;
      if (!record.reasoningEffort && typeof response?.reasoningEffort === "string" && response.reasoningEffort) record.reasoningEffort = response.reasoningEffort;
    }
    function publicJob(job) {
      return Object.fromEntries(["company", "title", "description", "applyUrl", "sourceUrl", "jobId", "isEasyApply", "workplaceType", "posterName", "applicationsClosed", "selectedRegion", "selectedRegionSource", "profileRoutingVersion"]
        .map((name) => [name, job[name]]).filter(([, value]) => value !== undefined));
    }
    async function notSaved(record, details) {
      const summary = { stage: details.stage, status: details.status || record.state, reason: details.reason,
        willRetry: details.willRetry === true,
        ...(details.research?.retryCount ? { retryCount: details.research.retryCount, retryAt: details.research.retryAt } : {}),
        ...(details.error ? { error: { code: details.error.code, message: details.error.message } } : {}) };
      if (JSON.stringify(record.notSaved) === JSON.stringify(summary)) return;
      record.notSaved = summary;
      try { await onNotSaved(record, { ...summary, ...(details.research ? { research: details.research } : {}) }); }
      catch { /* Reporting cannot change research or save outcomes. */ }
    }
    function verificationFailure(record, response, verifiedAt) {
      if (response.state === "failed") return { stage: "research", reason: response.error || "Research failed without a verified MCP result.", code: "RESEARCH_FAILED" };
      if (response.result?.decision === "skip") return { stage: "ai-decision", reason: response.result.reason || response.result.role?.reason || "AI decided to skip this job without providing a reason.", code: "AI_SKIP" };
      if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt >= 60 * 60 * 1000 || verifiedAt > Date.now() + 60_000) {
        return { stage: "verification", reason: "Research completion time is missing, invalid or older than one hour. Nothing was saved.", code: "RESEARCH_RESULT_EXPIRED" };
      }
      if (JobCapturePolicy.key(response.result?.company) !== JobCapturePolicy.key(record.job.company) ||
        JobCapturePolicy.key(response.result?.title) !== JobCapturePolicy.key(record.job.title)) {
        return { stage: "verification", reason: "Research findings do not match the captured company and role.", code: "RESEARCH_IDENTITY_MISMATCH" };
      }
      if (!JobCapturePolicy.verifiedRole(record.job, response.result)) return { stage: "role-verification", reason: "Skipped: software engineering role not confirmed.", code: "ROLE_EVIDENCE_INVALID" };
      if (JobCapturePolicy.remoteSkipReason(record.job) || (JobCapturePolicy.needsRemoteCheck(record.job) &&
        (response.result?.fullyRemote !== true || JobCapturePolicy.text(response.result?.remoteEvidence).length < 8 ||
          !JobCapturePolicy.hasFullyRemoteOffer(response.result?.remoteEvidence) ||
          !JobCapturePolicy.key(record.job.description).includes(JobCapturePolicy.key(response.result?.remoteEvidence))))) {
        return { stage: "remote-verification", reason: "Skipped: fully remote work not confirmed.", code: "REMOTE_EVIDENCE_INVALID" };
      }
      return { stage: "application-verification", reason: "Skipped: no verified apply link or email.", code: "APPLICATION_EVIDENCE_INVALID" };
    }
    async function start(job, { profile = "", tabId = null } = {}) {
      return serial(async () => {
        const roleSkipReason = JobCapturePolicy.roleSkipReason(job);
        if (roleSkipReason) return { status: "skipped", reason: roleSkipReason };
        const state = await sheetClient.getStatus();
        if (!state.configured) throw new Error("Choose your ApplicantAlly data folder before researching jobs.");
        const region = JobProfileRouting.jobRegion(job);
        if (JobCapturePolicy.sourceSite(job.sourceUrl) === "jobright" &&
          (region !== "us" || job.selectedRegionSource !== "search-control"))
          throw new Error("Select United States in Jobright's search country filter, then reopen the job before saving.");
        const capturedJob = { ...job, ...(region ? { selectedRegion: region, profileRoutingVersion: JobProfileRouting.VERSION } : {}),
          ...(JobCapturePolicy.sourceSite(job.sourceUrl) === "jobright"
            ? { isEasyApply: job.isEasyApply !== false || !JobCapturePolicy.publicUrl(job.applyUrl) } : {}) };
        const records = await read();
        const sourceIdentity = JobCapturePolicy.sourceSite(job.sourceUrl) === "jobright" ? `jobright:${job.jobId || job.sourceUrl}` : job.jobId || job.sourceUrl || "";
        const identity = JSON.stringify([sourceIdentity, job.company, job.title, job.description, state.sheetUrl, region ? "automatic" : profile, ...(region ? [region] : [])]);
        const existing = records.find((entry) => entry.identity === identity && !entry.terminal);
        if (existing) return { status: "researching", ...(existing.state === "requesting" ? { queued: true } : {}), requestId: existing.requestId, replayed: true, profile: existing.profile, profileRouting: existing.profileRouting };
        if (records.filter((entry) => !entry.terminal).length >= 100) throw new Error("Too many jobs are being researched. Wait for the current jobs to finish.");
        const routing = region ? JobProfileRouting.snapshot(capturedJob, await sheetClient.getOptions({ refresh: true })) : null;
        const selection = routing && region !== "us" ? JobProfileRouting.choose(capturedJob, routing) : null;
        const settings = await selectedSettings();
        const record = { requestId: cryptoImpl.randomUUID(), identity, job: capturedJob, model: settings.selectedModel, reasoningEffort: settings.selectedReasoningEffort,
          profile: selection?.profile ?? (routing ? "" : profile), tabId,
          ...(routing ? { profileRouting: routing } : {}), ...(selection ? { profileSelection: selection } : {}),
          sheetUrl: state.sheetUrl, createdAt: Date.now(), state: "requesting" };
        const active = records.filter((entry) => !entry.terminal || entry.saveClaim);
        const historyLimit = Math.max(0, 199 - active.length);
        const history = historyLimit ? records.filter((entry) => entry.terminal && !entry.saveClaim && Date.now() - entry.createdAt < MAX_AGE).slice(-historyLimit) : [];
        const next = [...history, ...active, record];
        await write(next);
        if (selection) await onProfileSelected(record, selection);
        try {
          freezeAcceptedSettings(record, await request("", submission(record)));
          record.state = "researching";
          await write(next);
        } catch (error) {
          if (error.retryableResearch) {
            await notSaved(record, { stage: "submission", status: "pending", reason: error.message, error, willRetry: true });
            await write(next);
            return { status: "researching", queued: true, requestId: record.requestId, profile: record.profile, profileRouting: record.profileRouting };
          }
          if (error.status) { record.terminal = true; record.state = "failed"; await write(next); }
          await notSaved(record, { stage: "submission", status: record.terminal ? "failed" : "pending", reason: error.message, error, willRetry: !record.terminal });
          error.notSavedReported = true;
          throw error;
        }
        return { status: "researching", requestId: record.requestId, profile: record.profile, profileRouting: record.profileRouting };
      });
    }
    async function poll() {
      return serial(async () => {
        const records = await read();
        // Saved terminal records still owe an ACK if the worker went offline
        // after close. Retrying it must never repeat or reverse their save.
        for (const record of records) {
          if (record.saveCancelled && record.saveClaim) await cancelSaveClaim(record, records);
          else if (record.saveClaim?.phase === "settle") await settleSaveClaim(record, records);
        }
        const state = await sheetClient.getStatus();
        for (const record of records.filter((entry) => !entry.terminal)) {
          if (record.saveClaim?.phase === "settle") continue;
          const roleSkipReason = JobCapturePolicy.roleSkipReason(record.job);
          if (roleSkipReason) {
            if (record.saveClaim) await cancelSaveClaim(record, records);
            record.terminal = true; record.state = "skipped";
            await notSaved(record, { stage: "local-policy", reason: roleSkipReason });
            await write(records);
            await onOutcome(record, roleSkipReason);
            continue;
          }
          if (!state.configured || state.sheetUrl !== record.sheetUrl || (!record.saveClaim && Date.now() - record.createdAt > MAX_AGE)) {
            if (record.saveClaim) await cancelSaveClaim(record, records);
            record.terminal = true; record.state = "cancelled";
            await notSaved(record, { stage: "queue", reason: !state.configured ? "ApplicantAlly folder configuration was cleared."
              : state.sheetUrl !== record.sheetUrl ? "The ApplicantAlly destination changed after this job was captured."
              : "The research request expired after 24 hours." });
            continue;
          }
          let response;
          try {
            if (["acquiring", "writing"].includes(record.saveClaim?.phase) && record.saveResearch) response = record.saveResearch;
            else {
              if (record.state === "requesting") {
                freezeAcceptedSettings(record, await request("", submission(record)));
                record.state = "researching";
              }
              response = await request(`/${encodeURIComponent(record.requestId)}`);
            }
          } catch (error) {
            // One outage must not hold the capture queue for 12 seconds per job.
            // The next alarm retries, retaining the original request IDs.
            if (error.retryableResearch) {
              await notSaved(record, { stage: "research", status: "pending", reason: error.message, error, willRetry: true });
              break;
            }
            if (error.status === 404 || error.status === 409) {
              if (record.saveClaim) await cancelSaveClaim(record, records);
              record.terminal = true; record.state = "failed";
            }
            await notSaved(record, { stage: "research", status: record.terminal ? "failed" : "pending", reason: error.message, error, willRetry: !record.terminal });
            continue;
          }
          freezeAcceptedSettings(record, response);
          if (!["completed", "failed"].includes(response.state)) {
            if (response.error) await notSaved(record, { stage: "research", status: "pending", reason: response.error, research: response, willRetry: true });
            continue;
          }
          // Captures carry a persistent request ID. A lost local-store response
          // can be retried without inserting the job twice.
          record.terminal = !fileDestination(record.sheetUrl);
          record.state = response.state === "failed" ? "failed" : "skipped";
          await write(records);
          const verifiedAt = Date.parse(response.completedAt);
          const job = response.state === "completed" && Number.isFinite(verifiedAt) &&
            (record.saveClaim || Date.now() - verifiedAt < 60 * 60 * 1000) && verifiedAt <= Date.now() + 60_000
            ? JobCapturePolicy.verifiedJob(record.job, response.result) : null;
          if (!job) {
            if (record.saveClaim) {
              await cancelSaveClaim(record, records);
            }
            record.terminal = true;
            const failure = verificationFailure(record, response, verifiedAt);
            await notSaved(record, { ...failure, research: response, error: { code: failure.code, message: failure.reason } });
            await write(records);
            await onOutcome(record, failure.reason);
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
            const result = await saveJob(record, job, records, response);
            try { await onSaved(job.company); } catch { /* Post-save UI updates cannot reverse a confirmed file save. */ }
            try { await onOutcome(record, "Saved to ApplicantAlly.", result); } catch { /* Reporting and notifications remain independent of saving. */ }
          } catch (error) {
            if (error.saveStatePersistence) throw error;
            if (error.saveCoordination || error.code === "LOCAL_STORE_UNAVAILABLE") {
              record.terminal = false;
              record.state = "waiting-save";
              await notSaved(record, { stage: error.saveCoordination ? "save-coordination" : "save", status: "pending", reason: error.message, error, research: response, willRetry: true });
              await write(records);
              await settleSaveClaim(record, records);
              continue;
            }
            if (record.saveClaim && record.saveClaim.phase !== "settle") await cancelSaveClaim(record, records);
            record.terminal = true;
            record.state = error.code === "TRACKER_SAVE_UNCONFIRMED" ? "save-unconfirmed" : "failed";
            await write(records);
            await settleSaveClaim(record, records);
            await notSaved(record, { stage: /^PROFILE_/u.test(error.code || "") ? "profile-selection" : "save", reason: error.message, error, research: response });
            await onOutcome(record, error.code === "BANNED_COMPANY" ? error.message
              : error.code === "TRACKER_SAVE_UNCONFIRMED" ? "Save not confirmed. Check ApplicantAlly."
              : /^PROFILE_ROUTING_/u.test(error.code || "") ? error.message
              : "Could not save to ApplicantAlly.");
          }
        }
        await write(records);
      });
    }
    function clear() { return serial(async () => {
      const records = await read();
      for (const record of records) if (record.saveClaim?.phase === "settle") await settleSaveClaim(record, records);
      for (const record of records.filter(entry => !entry.terminal)) {
        if (record.saveClaim) await cancelSaveClaim(record, records);
        record.state = "cancelled";
        await notSaved(record, { stage: "queue", reason: "Pending research was cleared by the user." });
      }
      const retained = records.filter(record => record.saveClaim);
      if (retained.length) await write(retained);
      else { await storage.remove(STORAGE_KEY); await alarms.clear(ALARM); }
    }); }
    return { start, poll, clear, getModels, setModel, setReasoningEffort, startWorker };
  }
  root.JobResearchClient = Object.freeze({ create, ALARM });
})(typeof globalThis === "undefined" ? this : globalThis);
