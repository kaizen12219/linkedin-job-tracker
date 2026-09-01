(function registerKaiFlowTrackerClient(root) {
  "use strict";

  const STORAGE_KEY = "kaiFlowRemoteTracker";
  const LIMIT = 256;
  const RETRY_MS = 30000;
  const RETENTION_MS = 7 * 86400000;
  const MAX_RESPONSE_BYTES = 384 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ACTIVE = new Set(["queued", "sending", "retry", "auth-paused"]);
  const FIELD_LIMITS = { company: 1000, jobTitle: 1000, jobDescription: 49000, applyUrl: 4096, profile: 200 };
  function error(code, message, details) { return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) }); }
  function field(value, name) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw error("INVALID_JOB_FIELD", `${name} must be text.`);
    const cleaned = value.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").trim();
    if (cleaned.length > FIELD_LIMITS[name]) throw error("CELL_TOO_LARGE", `${name} is too long. Shorten it before saving.`);
    return cleaned;
  }
  function normalizeJob(raw, profile) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw error("MISSING_JOB_FIELDS", "Capture a job before saving.");
    const job = { company: field(raw.company, "company"), jobTitle: field(raw.jobTitle ?? raw.title, "jobTitle"), jobDescription: field(raw.jobDescription ?? raw.description, "jobDescription"), applyUrl: field(raw.applyUrl, "applyUrl"), profile: field(profile, "profile") };
    if (!job.company || !job.jobTitle || !job.jobDescription) throw error("MISSING_JOB_FIELDS", "Company, job title, and job description are required.");
    if (job.applyUrl) {
      let url;
      try { url = new URL(job.applyUrl); } catch { /* Use the validation message below. */ }
      if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw error("INVALID_APPLY_URL", "The application URL must be an http or https link without credentials.");
    }
    return job;
  }
  function companyKey(value) { return value.toLowerCase().replace(/\s+/g, " ").trim(); }
  function sameConnection(entry, config) { return Boolean(config && entry.origin === config.origin && entry.serverId === config.serverId && entry.deviceId === config.deviceId); }
  function expiryMs(value) { return typeof value === "number" ? value : Date.parse(value); }

  function create(options = {}) {
    const storage = options.storage ?? root.chrome?.storage?.local;
    const permissions = options.permissions ?? root.chrome?.permissions;
    const fetchImpl = options.fetchImpl ?? root.fetch.bind(root);
    const cryptoImpl = options.cryptoImpl ?? root.crypto;
    const now = options.now ?? (() => Date.now());
    const setTimer = options.setTimeoutImpl ?? root.setTimeout.bind(root);
    const clearTimer = options.clearTimeoutImpl ?? root.clearTimeout.bind(root);
    const timeoutMs = options.timeoutMs ?? 20000;
    let state = null;
    let initialization = null;
    let storageTail = Promise.resolve();
    let pump = null;
    let closed = false;
    let connection = "unpaired";

    function changed() { try { options.onChange?.(); } catch { /* Popup will also refresh on open. */ } }
    function lock(work) { const task = storageTail.then(work, work); storageTail = task.catch(() => {}); return task; }
    async function init() {
      if (!initialization) initialization = (async () => {
        try {
          // Content scripts share local storage by default. Deny them access BEFORE reading credentials.
          if (!storage?.setAccessLevel) throw new Error("Trusted storage is unavailable");
          await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
          const saved = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY];
          if (saved !== undefined && (saved?.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > LIMIT)) throw new Error("Invalid queue");
          state = saved ?? { version: 1, config: null, entries: [] };
          if (state.config) {
            const config = state.config;
            if (root.KaiFlowTrackerSecurity.parseOrigin(config.origin) !== config.origin || typeof config.token !== "string" || !config.token || typeof config.deviceId !== "string" || typeof config.serverId !== "string" || !Number.isFinite(expiryMs(config.expiresAt))) throw new Error("Invalid pairing");
          }
          const ids = new Set();
          for (const entry of state.entries) {
            if (!entry || !UUID.test(entry.requestId) || ids.has(entry.requestId) || typeof entry.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(entry.fingerprint) || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt) || typeof entry.mayHaveSaved !== "boolean" || typeof entry.deviceId !== "string" || typeof entry.serverId !== "string" || root.KaiFlowTrackerSecurity.parseOrigin(entry.origin) !== entry.origin) throw new Error("Invalid queue entry");
            normalizeJob(entry.job, entry.job?.profile);
            if (![...ACTIVE, "saved", "rejected", "canceled", "review"].includes(entry.state)) throw new Error("Invalid queue state");
            ids.add(entry.requestId);
            // A worker restart can happen between submission and acknowledgement.
            if (entry.state === "sending") { entry.state = "retry"; entry.nextAttemptAt = now(); }
          }
          connection = state.config ? "checking" : "unpaired";
        } catch {
          throw error("KAI_FLOW_STORAGE_ERROR", "The tracker could not safely read its connection and saved requests. Nothing was sent. Do not clear extension data until earlier saves are checked.");
        }
      })();
      return initialization;
    }
    async function persist() {
      try {
        if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 8 * 1024 * 1024) throw new Error("Queue storage limit");
        await storage.set({ [STORAGE_KEY]: state });
      }
      catch { throw error("KAI_FLOW_STORAGE_ERROR", "The tracker could not safely remember this operation. Check its queue before retrying; do not clear extension data."); }
    }
    function prune() {
      // Sent-but-unconfirmed tombstones are never discarded, even if canceled.
      state.entries = state.entries.filter((entry) => ACTIVE.has(entry.state) || entry.state === "review" || (entry.mayHaveSaved && entry.state !== "saved") || now() - entry.updatedAt <= RETENTION_MS);
    }
    function getConfig() {
      if (closed) throw error("TRACKER_CLOSED", "Reopen the tracker to reconnect.");
      const config = state.config;
      if (!config) throw error("TRACKER_NOT_PAIRED", "Connect this extension using a pairing link from the Kai Flow owner.");
      if (expiryMs(config.expiresAt) <= now()) { connection = "expired"; throw error("TRACKER_TOKEN_EXPIRED", "This tracker connection expired. Ask the owner for a new pairing link. Earlier queued jobs remain with their original connection."); }
      if (config.blockedCode) { connection = "revoked"; throw error(config.blockedCode, "This tracker connection is no longer authorized. Ask the owner for a new pairing link; queued jobs are paused."); }
      return { ...config };
    }
    async function transport(origin, action, payload, token) {
      if (root.KaiFlowTrackerSecurity.parseOrigin(origin) !== origin || !["pair", "options", "duplicate", "save"].includes(action)) throw error("TRACKER_BAD_ORIGIN", "The configured server address is not allowed.");
      if (!await permissions?.contains({ origins: [`${origin}/*`] })) throw error("TRACKER_PERMISSION_REQUIRED", "Allow access to this Kai Flow server using the Connect button.");
      const controller = new AbortController();
      const timer = setTimer(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${origin}/api/tracker/${action}`, {
          method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload)
        });
        if (response.redirected || (response.url && new URL(response.url).origin !== origin)) throw error("TRACKER_REDIRECT_BLOCKED", "Kai Flow redirected the request. Ask the owner for a current pairing link; credentials were not forwarded.");
        const content = await response.text();
        if (new TextEncoder().encode(content).byteLength > MAX_RESPONSE_BYTES) throw error("TRACKER_PROTOCOL_ERROR", "Kai Flow returned an invalid response.");
        let data;
        try { data = JSON.parse(content); } catch { throw error("TRACKER_PROTOCOL_ERROR", "Kai Flow did not return a valid response. Check the server connection."); }
        if (!response.ok || data?.ok !== true) {
          const remote = data?.error;
          const e = error(typeof remote?.code === "string" ? remote.code : `TRACKER_HTTP_${response.status}`, typeof remote?.message === "string" ? remote.message : `Kai Flow could not complete the request (${response.status}).`, remote?.details);
          e.status = response.status; e.fromServer = true; throw e;
        }
        if (action !== "pair") connection = "connected";
        return data.result;
      } catch (e) {
        if (e.code) throw e;
        connection = "offline";
        throw error("TRACKER_OFFLINE", "Cannot reach the Kai Flow server. Saved requests stay queued and retry automatically; no local Kai Flow installation is needed.");
      } finally { clearTimer(timer); }
    }
    async function remote(action, payload) {
      const config = getConfig();
      try { return await transport(config.origin, action, payload, config.token); }
      catch (e) {
        if (e.status === 401 || e.status === 403) {
          await lock(async () => {
            if (sameConnection(config, state.config)) { state.config.blockedCode = e.code; await persist(); }
          });
          connection = /EXPIRED/i.test(e.code) ? "expired" : "revoked";
        }
        throw e;
      }
    }
    async function pair(link, deviceName = "LinkedIn tracker") {
      await init();
      const { origin, code } = root.KaiFlowTrackerSecurity.parsePairingLink(link);
      const result = await transport(origin, "pair", { code, deviceName: String(deviceName).trim().slice(0, 80) || "LinkedIn tracker" });
      if (!result || typeof result.token !== "string" || result.token.length < 16 || typeof result.deviceId !== "string" || !result.deviceId || typeof result.serverId !== "string" || !result.serverId || !Number.isFinite(expiryMs(result.expiresAt)) || expiryMs(result.expiresAt) <= now()) throw error("TRACKER_PROTOCOL_ERROR", "Kai Flow returned an invalid connection. Request a new pairing link.");
      await lock(async () => {
        state.config = { origin, token: result.token, deviceId: result.deviceId, serverId: result.serverId, expiresAt: expiryMs(result.expiresAt) };
        // Existing entries keep their original server AND device identity. Pairing never moves jobs.
        await persist();
      });
      connection = "connected"; changed();
      return getStatus();
    }
    async function getOptions({ refresh = false } = {}) {
      await init();
      const config = getConfig();
      const result = await remote("options", { refresh });
      if (!result || !Array.isArray(result.profiles) || !result.profiles.every((value) => typeof value === "string")) throw error("TRACKER_PROTOCOL_ERROR", "Kai Flow returned an invalid profile list.");
      await lock(async () => {
        if (sameConnection(config, state.config)) { state.config.profileOptions = { profiles: [...result.profiles], profileLabels: result.profileLabels || {} }; await persist(); }
      });
      return result;
    }
    async function lookupDuplicate(company) {
      await init();
      const normalized = field(company, "company");
      if (!normalized) return { duplicate: null };
      const result = await remote("duplicate", { company: normalized });
      if (!result || !(result.duplicate === null || (typeof result.duplicate === "object" && !Array.isArray(result.duplicate)))) throw error("TRACKER_PROTOCOL_ERROR", "Kai Flow returned an invalid duplicate check.");
      return result;
    }
    function queueResult(entry) {
      if (entry.state === "saved") return { ...entry.result, replayed: true };
      if (entry.state === "rejected") throw error(entry.error?.code || "TRACKER_SAVE_REJECTED", entry.error?.message || "Kai Flow could not save this job.", entry.error?.details);
      return { status: entry.state === "canceled" ? "canceled" : "queued", requestId: entry.requestId, state: entry.state, mayHaveSaved: entry.mayHaveSaved };
    }
    async function saveJob(raw, { profile = "" } = {}) {
      await init();
      const job = normalizeJob(raw, profile);
      const config = getConfig();
      const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(job)));
      const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      let created = false;
      const requestId = await lock(async () => {
        prune();
        const existing = state.entries.find((entry) => {
          // Only an explicit user Save can replace a definitively rejected or never-sent canceled request.
          // Its old receipt is retained; retries of uncertain/sent requests NEVER mint another ID.
          if (["rejected", "canceled"].includes(entry.state) && !entry.mayHaveSaved) return false;
          return sameConnection(entry, config) && (entry.fingerprint === fingerprint || ((ACTIVE.has(entry.state) || entry.state === "review" || (entry.state === "canceled" && entry.mayHaveSaved)) && companyKey(entry.job.company) === companyKey(job.company)));
        });
        if (existing) return existing.requestId;
        if (state.entries.length >= LIMIT) {
          const safeHistory = state.entries.filter((entry) => entry.state === "saved" || (["rejected", "canceled"].includes(entry.state) && !entry.mayHaveSaved)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
          if (safeHistory) state.entries.splice(state.entries.indexOf(safeHistory), 1);
        }
        if (state.entries.length >= LIMIT) throw error("TRACKER_QUEUE_FULL", "The tracker has 256 retained requests. Resolve earlier queued or unconfirmed saves before adding more jobs.");
        if (new TextEncoder().encode(JSON.stringify(state) + JSON.stringify(job)).byteLength > 7 * 1024 * 1024) throw error("TRACKER_QUEUE_FULL", "The saved queue is full. Resolve earlier requests before adding more jobs.");
        const id = cryptoImpl.randomUUID();
        state.entries.push({ requestId: id, fingerprint, origin: config.origin, serverId: config.serverId, deviceId: config.deviceId, job, state: "queued", mayHaveSaved: false, attempts: 0, nextAttemptAt: now(), createdAt: now(), updatedAt: now() });
        await persist(); created = true; return id;
      });
      changed();
      await flushQueue();
      const entry = state.entries.find((item) => item.requestId === requestId);
      const result = queueResult(entry);
      if (created && entry.state === "saved") result.replayed = Boolean(entry.result?.replayed);
      return result;
    }
    async function attempt(requestId) {
      let snapshot;
      let config;
      await lock(async () => {
        const entry = state.entries.find((item) => item.requestId === requestId);
        if (!entry || !ACTIVE.has(entry.state) || !sameConnection(entry, state.config)) return;
        if (now() - entry.createdAt > RETENTION_MS) {
          entry.state = "review"; entry.updatedAt = now(); entry.error = { code: "TRACKER_RETRY_EXPIRED", message: "Automatic retry stopped after 7 days. Ask the owner to check this request before adding it again." }; await persist(); return;
        }
        try { config = getConfig(); }
        catch (e) { entry.state = "auth-paused"; entry.error = { code: e.code, message: e.message }; entry.nextAttemptAt = now() + RETRY_MS; await persist(); return; }
        entry.state = "sending"; entry.mayHaveSaved = true; entry.attempts++; entry.updatedAt = now(); entry.nextAttemptAt = now() + RETRY_MS;
        // Persist uncertainty BEFORE network I/O; cancellation cannot claim a submitted job was deleted.
        await persist(); snapshot = { ...entry, job: { ...entry.job } };
      });
      if (!snapshot) { changed(); return; }
      changed();
      let result, failure;
      try {
        result = await transport(config.origin, "save", { requestId: snapshot.requestId, ...snapshot.job }, config.token);
        if (result?.status !== "inserted" || !result.job || typeof result.job !== "object") throw error("TRACKER_PROTOCOL_ERROR", "The save acknowledgement was invalid. The original request remains queued; no new request will be created.");
      } catch (e) { failure = e; }
      await lock(async () => {
        const entry = state.entries.find((item) => item.requestId === requestId);
        if (!entry) return;
        entry.updatedAt = now();
        if (!failure) { entry.state = "saved"; entry.result = result; delete entry.error; }
        else {
          entry.error = { code: failure.code || "TRACKER_OFFLINE", message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) };
          const auth = failure.status === 401 || failure.status === 403;
          if (auth && sameConnection(config, state.config)) { state.config.blockedCode = failure.code; connection = /EXPIRED/i.test(failure.code) ? "expired" : "revoked"; }
          if (failure.fromServer && failure.details?.saveRejected === true) {
            entry.mayHaveSaved = false;
            if (entry.state !== "canceled") entry.state = auth ? "auth-paused" : "rejected";
          } else if (entry.state !== "canceled") {
            entry.state = auth ? "auth-paused" : /UNCERTAIN|UNCONFIRMED|NOT_CONFIRMED/.test(failure.code || "") ? "review" : "retry";
          }
          entry.nextAttemptAt = now() + RETRY_MS;
        }
        await persist();
      });
      changed();
    }
    async function flushQueue() {
      await init();
      if (closed) return;
      if (pump) return pump;
      const task = (async () => {
        // A short batch avoids monopolizing a worker event. Alarms resume remaining work.
        for (let count = 0; count < 4; count++) {
          const next = state.entries.find((entry) => ACTIVE.has(entry.state) && entry.state !== "sending" && sameConnection(entry, state.config) && entry.nextAttemptAt <= now());
          if (!next) break;
          await attempt(next.requestId);
        }
      })();
      pump = task;
      try { await task; } finally { if (pump === task) pump = null; }
    }
    async function cancel(requestId) {
      await init();
      await lock(async () => {
        const entry = state.entries.find((item) => item.requestId === requestId);
        if (!entry || entry.state === "saved" || entry.state === "rejected") return;
        entry.state = "canceled"; entry.updatedAt = now(); await persist();
      });
      changed(); return getStatus();
    }
    async function getStatus() {
      await init();
      const config = state.config;
      if (config && expiryMs(config.expiresAt) <= now()) connection = "expired";
      else if (config?.blockedCode) connection = /EXPIRED/i.test(config.blockedCode) ? "expired" : "revoked";
      return { paired: Boolean(config), connection, origin: config?.origin || "", expiresAt: config?.expiresAt || "", profileOptions: config?.profileOptions || null, entries: state.entries.map((entry) => ({ requestId: entry.requestId, company: entry.job.company, jobTitle: entry.job.jobTitle, state: entry.state, connectionMatches: sameConnection(entry, config), origin: entry.origin, mayHaveSaved: entry.mayHaveSaved, error: entry.error, createdAt: entry.createdAt, updatedAt: entry.updatedAt })) };
    }
    function close() { closed = true; }
    return Object.freeze({ init, pair, getOptions, lookupDuplicate, saveJob, flushQueue, cancel, getStatus, close });
  }
  root.KaiFlowTrackerClient = Object.freeze({ create });
})(globalThis);
