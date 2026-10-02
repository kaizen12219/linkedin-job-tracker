(function registerKaiLocalStoreClient(root) {
  "use strict";
  const ENDPOINT = "http://127.0.0.1:8787/job-store";
  const CLIENT_KEY = "jobTrackerResearchClientV1";
  const STATE_KEY = "kaiLocalTrackerV1";
  function create({ storage = chrome.storage.local, fetchImpl = fetch, cryptoImpl = crypto, extensionId = chrome.runtime.id } = {}) {
    let state = { configured: true, connection: "checking", sheetUrl: "", entries: [] };
    let initialized, clientKey, tail = Promise.resolve();
    async function init() {
      if (!initialized) initialized = (async () => {
        const saved = await storage.get([STATE_KEY, CLIENT_KEY, "kaiSheetDirectTrackerV1"]);
        state = { ...state, ...saved[STATE_KEY] };
        if (!state.sheetUrl && saved.kaiSheetDirectTrackerV1?.target) state.sheetUrl = saved.kaiSheetDirectTrackerV1.target.sheetUrl || "";
        clientKey = saved[CLIENT_KEY];
        if (!/^[a-f0-9]{64}$/u.test(clientKey || "")) {
          clientKey = [...cryptoImpl.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
          await storage.set({ [CLIENT_KEY]: clientKey });
        }
      })();
      await initialized;
    }
    async function request(route, body) {
      await init();
      let response;
      try {
        response = await fetchImpl(`${ENDPOINT}${route}`, { method: body ? "POST" : "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
          headers: { "X-Job-Tracker-Extension": extensionId, "X-Job-Tracker-Client": clientKey, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch { throw Object.assign(new Error("Start Kai Flow and Rezi Builder to access your saved jobs."), { code: "LOCAL_STORE_UNAVAILABLE" }); }
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error?.message || value.error || "The local job store is unavailable."), { code: value.error?.code || "LOCAL_STORE_UNAVAILABLE", details: value.error?.details });
      return value;
    }
    async function getStatus() {
      await init();
      try {
        state = await request("/status");
        await storage.set({ [STATE_KEY]: state });
        await storage.remove?.("kaiSheetDirectTrackerV1");
      } catch { state = { ...state, connection: "offline" }; }
      return structuredClone(state);
    }
    async function getOptions() {
      const result = await request("/options");
      await getStatus();
      return result;
    }
    async function configure() { await init(); return getStatus(); }
    async function clearConfiguration() { await storage.remove?.(STATE_KEY); state = { configured: true, connection: "checking", sheetUrl: "", entries: [] }; return getStatus(); }
    async function lookupDuplicate(company) { const result = await request(`/duplicate?company=${encodeURIComponent(company || "")}`); return { duplicate: result.duplicate }; }
    async function getCompanies({ revision = "" } = {}) { return request(`/companies?revision=${encodeURIComponent(revision)}`); }
    function saveJob(job, { profile = "", requestId = cryptoImpl.randomUUID() } = {}) {
      const save = () => request("/jobs", { company: job.company, jobTitle: job.jobTitle || job.title, jobDescription: job.jobDescription || job.description,
        applyUrl: job.applyUrl || "", info: job.info || "", profile, requestId });
      const result = tail.then(save, save); tail = result.catch(() => {}); return result;
    }
    return Object.freeze({ init, configure, clearConfiguration, getOptions, lookupDuplicate, getCompanies, saveJob, getStatus });
  }
  root.KaiLocalStoreClient = Object.freeze({ create });
})(globalThis);
