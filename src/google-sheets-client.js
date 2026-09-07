(function registerGoogleSheetsTrackerClient(root) {
  "use strict";

  const STORAGE_KEY = "kaiSheetDirectTrackerV1";
  const LEGACY_STORAGE_KEY = "kaiFlowRemoteTracker";
  const RECEIPTS_KEY = "kaiSheetDirectTrackerReceiptsV1";
  const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_COMPANY_SNAPSHOT_SIZE = 20_000;
  const MAX_RECEIPTS = 256;
  const SNAPSHOT_TTL_MS = 30_000;
  const FIELD_LIMITS = { company: 1000, jobTitle: 1000, jobDescription: 49000, applyUrl: 4096, profile: 200 };
  const REQUIRED_HEADERS = ["Date", "Company", "Job Title", "Job Description", "Apply URL", "Profile", "Status", "Salary", "Info"];
  const MANAGED_HEADERS = new Map([[10, "Trashed"], [11, "Added By"], [12, "Applied By"]]);
  const RESTRICTED_STATUSES = new Set([
    "clearance", "location restriction", "location-restriction", "on-site", "onsite",
    "language", "not applicable", "not-applicable", "restricted"
  ]);

  function failure(code, message, details) {
    return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
  }

  function plainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ||
      (Object.prototype.toString.call(value) === "[object Object]" && prototype?.constructor?.name === "Object");
  }

  function clean(value, name, maximum) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw failure("INVALID_JOB_FIELD", `${name} must be text.`);
    const result = value.replace(/\u00a0/gu, " ").replace(/\r\n?/gu, "\n").trim();
    if (result.length > maximum) throw failure("CELL_TOO_LARGE", `${name} is too long. Shorten it before saving.`);
    return result;
  }

  function normalizeJob(raw, profile) {
    if (!plainObject(raw)) throw failure("MISSING_JOB_FIELDS", "Capture a job before saving.");
    const job = {
      company: clean(raw.company, "company", FIELD_LIMITS.company),
      jobTitle: clean(raw.jobTitle ?? raw.title, "jobTitle", FIELD_LIMITS.jobTitle),
      jobDescription: clean(raw.jobDescription ?? raw.description, "jobDescription", FIELD_LIMITS.jobDescription),
      applyUrl: clean(raw.applyUrl, "applyUrl", FIELD_LIMITS.applyUrl),
      profile: clean(profile, "profile", FIELD_LIMITS.profile)
    };
    if (!job.company || !job.jobTitle || !job.jobDescription) {
      throw failure("MISSING_JOB_FIELDS", "Company, job title, and job description are required.");
    }
    if (job.applyUrl) {
      let url;
      try { url = new URL(job.applyUrl); } catch { /* The check below supplies the message. */ }
      if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw failure("INVALID_APPLY_URL", "The application URL must be an http or https link without credentials.");
      }
    }
    return job;
  }

  function normalizeCompany(value) {
    return String(value ?? "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  }

  function normalizeStatus(value) {
    return String(value ?? "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  }

  function parseSheetTarget(sheetUrl, explicitGid = "") {
    let url;
    try { url = new URL(String(sheetUrl || "").trim()); } catch {
      throw failure("INVALID_SHEET_URL", "Paste the full Google Sheet URL.");
    }
    const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,200})(?:\/|$)/u.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.username || url.password || !match) {
      throw failure("INVALID_SHEET_URL", "Use a docs.google.com spreadsheet URL without embedded credentials.");
    }
    const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const gidText = String(explicitGid ?? "").trim() || hash.get("gid") || url.searchParams.get("gid") || "";
    if (!/^\d{1,12}$/u.test(gidText) || Number(gidText) > 2147483647) {
      throw failure("INVALID_SHEET_GID", "Enter the destination tab gid from the Google Sheet URL.");
    }
    return {
      spreadsheetId: match[1],
      sheetGid: Number(gidText),
      sheetUrl: `https://docs.google.com/spreadsheets/d/${match[1]}/edit#gid=${Number(gidText)}`
    };
  }

  function sanitizeCredentials(value) {
    if (!plainObject(value) || value.type !== "service_account") {
      throw failure("INVALID_SERVICE_ACCOUNT", "Choose a Google service-account credentials JSON file.");
    }
    const clientEmail = typeof value.client_email === "string" ? value.client_email.trim() : "";
    const privateKey = typeof value.private_key === "string" ? value.private_key.replace(/\r\n?/gu, "\n").trim() : "";
    if (!/^.{1,250}@.{1,200}$/u.test(clientEmail) ||
      !/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/u.test(privateKey) || privateKey.length > 20_000) {
      throw failure("INVALID_SERVICE_ACCOUNT", "The JSON file is missing a valid client_email or private_key.");
    }
    return {
      type: "service_account",
      client_email: clientEmail,
      private_key: privateKey,
      ...(typeof value.private_key_id === "string" && value.private_key_id.length <= 256 ? { private_key_id: value.private_key_id } : {}),
      ...(typeof value.project_id === "string" && value.project_id.length <= 256 ? { project_id: value.project_id } : {})
    };
  }

  function validStoredConfig(value) {
    if (!plainObject(value) || value.version !== 1 || !plainObject(value.target)) return false;
    try {
      sanitizeCredentials(value.credentials);
      const parsed = parseSheetTarget(value.target.sheetUrl, value.target.sheetGid);
      return parsed.spreadsheetId === value.target.spreadsheetId && parsed.sheetGid === value.target.sheetGid;
    } catch {
      return false;
    }
  }

  function quoteSheetName(value) {
    return `'${String(value).replace(/'/gu, "''")}'`;
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return root.btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
  }

  function jsonPart(value) {
    return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  }

  function pemBytes(value) {
    const encoded = value.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, "");
    let binary;
    try { binary = root.atob(encoded); } catch { throw failure("INVALID_SERVICE_ACCOUNT", "The service-account private key is invalid."); }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function responseMessage(payload, fallback) {
    return typeof payload?.error_description === "string" ? payload.error_description
      : typeof payload?.error?.message === "string" ? payload.error.message
        : typeof payload?.error === "string" ? payload.error : fallback;
  }

  function create(options = {}) {
    const storage = options.storage ?? root.chrome?.storage?.local;
    const fetchImpl = options.fetchImpl ?? root.fetch.bind(root);
    const cryptoImpl = options.cryptoImpl ?? root.crypto;
    const now = options.now ?? (() => Date.now());
    const setTimer = options.setTimeoutImpl ?? root.setTimeout.bind(root);
    const clearTimer = options.clearTimeoutImpl ?? root.clearTimeout.bind(root);
    const timeoutMs = options.timeoutMs ?? 30_000;
    let state = null;
    let initialization = null;
    let accessToken = null;
    let snapshotCache = null;
    let connection = "unconfigured";
    let mutationTail = Promise.resolve();

    function changed() {
      try { options.onChange?.(); } catch { /* The popup refreshes independently. */ }
    }

    async function initialize() {
      if (!initialization) initialization = (async () => {
        if (!storage?.setAccessLevel) throw failure("TRACKER_STORAGE_ERROR", "Trusted extension storage is unavailable.");
        try {
          await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
          const saved = await storage.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
          if (saved?.[STORAGE_KEY] !== undefined && !validStoredConfig(saved[STORAGE_KEY])) {
            throw new Error("Invalid direct-Sheet configuration");
          }
          state = saved?.[STORAGE_KEY] || null;
          connection = state ? "checking" : "unconfigured";
          if (saved?.[LEGACY_STORAGE_KEY] !== undefined) await storage.remove(LEGACY_STORAGE_KEY);
        } catch (error) {
          state = null;
          connection = "invalid";
          if (error?.code) throw error;
          throw failure("TRACKER_STORAGE_ERROR", "The tracker could not safely read its Google Sheet settings.");
        }
      })();
      return initialization;
    }

    async function persist(nextState) {
      try { await storage.set({ [STORAGE_KEY]: nextState }); }
      catch { throw failure("TRACKER_STORAGE_ERROR", "The tracker could not save its Google Sheet settings."); }
      state = nextState;
    }

    function requireConfig() {
      if (!state) throw failure("TRACKER_CONFIG_REQUIRED", "Choose service-account credentials and a Google Sheet before saving.");
      return state;
    }

    async function createAssertion(credentials) {
      const issuedAt = Math.floor(now() / 1000) - 30;
      const unsigned = `${jsonPart({ alg: "RS256", typ: "JWT" })}.${jsonPart({
        iss: credentials.client_email,
        scope: SHEETS_SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600
      })}`;
      let key;
      try {
        key = await cryptoImpl.subtle.importKey(
          "pkcs8", pemBytes(credentials.private_key),
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
        );
      } catch {
        throw failure("INVALID_SERVICE_ACCOUNT", "The service-account private key could not be read.");
      }
      const signature = await cryptoImpl.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
      return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
    }

    async function fetchJson(url, init, { tokenRequest = false } = {}) {
      const controller = new AbortController();
      const timer = setTimer(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          ...init,
          signal: controller.signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error"
        });
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
          throw failure("GOOGLE_RESPONSE_INVALID", "Google returned an unexpectedly large response.");
        }
        let payload = {};
        if (text) {
          try { payload = JSON.parse(text); }
          catch { throw failure("GOOGLE_RESPONSE_INVALID", "Google returned an invalid response."); }
        }
        if (!response.ok) {
          const code = tokenRequest ? "GOOGLE_AUTH_FAILED"
            : response.status === 403 ? "GOOGLE_SHEET_FORBIDDEN"
              : response.status === 404 ? "GOOGLE_SHEET_NOT_FOUND" : "GOOGLE_API_ERROR";
          const generic = tokenRequest
            ? "Google rejected the service-account credentials."
            : response.status === 403
              ? "The service account cannot edit this Google Sheet. Share the Sheet with its client email as an editor."
              : response.status === 404 ? "The Google Sheet or tab was not found." : `Google Sheets returned HTTP ${response.status}.`;
          const problem = failure(code, responseMessage(payload, generic));
          problem.status = response.status;
          throw problem;
        }
        return payload;
      } catch (error) {
        if (error?.code) throw error;
        if (error?.name === "AbortError") throw failure("GOOGLE_REQUEST_TIMEOUT", "Google did not respond in time.");
        throw failure("TRACKER_OFFLINE", "Google Sheets could not be reached. Nothing was queued.");
      } finally {
        clearTimer(timer);
      }
    }

    async function tokenFor(credentials, { force = false } = {}) {
      if (!force && accessToken?.clientEmail === credentials.client_email && accessToken.expiresAt > now() + 300_000) {
        return accessToken.value;
      }
      const assertion = await createAssertion(credentials);
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      }).toString();
      const payload = await fetchJson(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      }, { tokenRequest: true });
      if (typeof payload.access_token !== "string" || !payload.access_token || !Number.isFinite(Number(payload.expires_in))) {
        throw failure("GOOGLE_RESPONSE_INVALID", "Google OAuth did not return a usable access token.");
      }
      accessToken = {
        clientEmail: credentials.client_email,
        value: payload.access_token,
        expiresAt: now() + Math.max(60, Number(payload.expires_in)) * 1000
      };
      return accessToken.value;
    }

    async function google(config, suffix, { method = "GET", body, retryAuth = true } = {}) {
      const token = await tokenFor(config.credentials);
      try {
        return await fetchJson(`${SHEETS_API}/${encodeURIComponent(config.target.spreadsheetId)}${suffix}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch (error) {
        if (retryAuth && error?.status === 401) {
          accessToken = null;
          await tokenFor(config.credentials, { force: true });
          return google(config, suffix, { method, body, retryAuth: false });
        }
        throw error;
      }
    }

    async function metadata(config) {
      const fields = "sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))";
      const result = await google(config, `?fields=${encodeURIComponent(fields)}`);
      const sheets = (result.sheets || []).map((entry) => entry.properties).filter(Boolean);
      const sheet = sheets.find((entry) => Number(entry.sheetId) === Number(config.target.sheetGid));
      if (!sheet) throw failure("GOOGLE_SHEET_TAB_NOT_FOUND", `No tab with gid ${config.target.sheetGid} exists in this spreadsheet.`);
      return sheet;
    }

    async function values(config, range) {
      const result = await google(config, `/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
      return Array.isArray(result.values) ? result.values : [];
    }

    async function batchValues(config, ranges) {
      const query = new URLSearchParams({ majorDimension: "ROWS" });
      for (const range of ranges) query.append("ranges", range);
      const result = await google(config, `/values:batchGet?${query.toString()}`);
      return ranges.map((_, index) => result.valueRanges?.[index]?.values || []);
    }

    async function ensureColumnCapacity(config, sheet) {
      if (Number(sheet.gridProperties?.columnCount || 0) < 13) {
        await google(config, ":batchUpdate", { method: "POST", body: { requests: [{
          updateSheetProperties: {
            properties: { sheetId: sheet.sheetId, gridProperties: { columnCount: 13 } },
            fields: "gridProperties.columnCount"
          }
        }] } });
        sheet.gridProperties = { ...(sheet.gridProperties || {}), columnCount: 13 };
      }
    }

    async function ensureManagedSchema(config, sheet, header, managedRows) {
      const actual = REQUIRED_HEADERS.map((_, index) => String(header[index] ?? "").trim());
      if (REQUIRED_HEADERS.some((expected, index) => actual[index] !== expected)) {
        throw failure("SHEET_SCHEMA_MISMATCH", "The destination tab must use the Kai Sheet Date-to-Info headers in columns A through I.", {
          expected: REQUIRED_HEADERS, actual
        });
      }
      const missing = [];
      for (const [index, expected] of MANAGED_HEADERS) {
        const current = String(header[index] ?? "").trim();
        if (current && current !== expected) {
          throw failure("SHEET_SCHEMA_MISMATCH", `Column ${String.fromCharCode(65 + index)} must be named ${expected}.`);
        }
        if (!current) {
          const managedIndex = index - 4;
          const occupied = managedRows.some((row) => {
            const value = row?.[managedIndex];
            return index === 10 ? trashMarked(value) : String(value ?? "").trim() !== "";
          });
          if (occupied) throw failure("SHEET_SCHEMA_MISMATCH", `Column ${String.fromCharCode(65 + index)} contains data but has no ${expected} header.`);
          missing.push({ index, expected });
        }
      }
      if (missing.length) {
        await google(config, "/values:batchUpdate", { method: "POST", body: {
          valueInputOption: "RAW",
          data: missing.map(({ index, expected }) => ({
            range: `${quoteSheetName(sheet.title)}!${String.fromCharCode(65 + index)}1`,
            majorDimension: "ROWS",
            values: [[expected]]
          }))
        } });
        for (const { index, expected } of missing) header[index] = expected;
      }
    }

    function trashMarked(value) {
      if (value === true) return true;
      return ["true", "yes", "1", "trashed"].includes(normalizeStatus(value));
    }

    function summaryRowOccupied(left, right) {
      // Match Kai Sheet's summary-row rule exactly. Template formatting,
      // descriptions without a job identity, and unchecked template metadata
      // do not move the insertion point. A real K Trash tombstone does.
      return [left?.[0], left?.[1], right?.[0], right?.[1], right?.[2], right?.[3], right?.[4]]
        .some((value) => String(value ?? "").trim() !== "") || trashMarked(right?.[6]);
    }

    function rowJob(row, rowNumber) {
      return {
        rowNumber,
        company: String(row?.[1] ?? "").trim(),
        jobTitle: String(row?.[2] ?? "").trim(),
        jobDescription: String(row?.[3] ?? "").trim(),
        applyUrl: String(row?.[4] ?? "").trim(),
        profile: String(row?.[5] ?? "").trim(),
        status: normalizeStatus(row?.[6]),
        trashed: trashMarked(row?.[10]),
        addedBy: String(row?.[11] ?? "").trim(),
        appliedBy: String(row?.[12] ?? "").trim()
      };
    }

    function summaryJob(left, right, rowNumber) {
      return {
        rowNumber,
        company: String(left?.[0] ?? "").trim(),
        jobTitle: String(left?.[1] ?? "").trim(),
        jobDescription: "",
        applyUrl: String(right?.[0] ?? "").trim(),
        profile: String(right?.[1] ?? "").trim(),
        status: normalizeStatus(right?.[2]),
        trashed: trashMarked(right?.[6]),
        addedBy: String(right?.[7] ?? "").trim(),
        appliedBy: String(right?.[8] ?? "").trim()
      };
    }

    function blocksDuplicate(job) {
      return !job.trashed && job.status !== "trashed" && job.status !== "deleted" && !RESTRICTED_STATUSES.has(job.status);
    }

    function brief(job) {
      return {
        rowNumber: job.rowNumber,
        company: job.company,
        jobTitle: job.jobTitle,
        status: job.status
      };
    }

    function nextAvailableRow(occupiedRows) {
      let rowNumber = 2;
      while (occupiedRows.has(rowNumber)) rowNumber += 1;
      return rowNumber;
    }

    async function validationProfiles(config, title) {
      const range = `${quoteSheetName(title)}!F2`;
      const fields = "sheets.data.rowData.values.dataValidation";
      try {
        const result = await google(config,
          `?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`);
        const condition = result.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.dataValidation?.condition;
        if (condition?.type !== "ONE_OF_LIST") return [];
        return [...new Set((condition.values || []).map((entry) => String(entry.userEnteredValue || "").trim()).filter(Boolean))];
      } catch {
        return [];
      }
    }

    async function readSnapshot(config, { force = false } = {}) {
      const cacheKey = `${config.target.spreadsheetId}:${config.target.sheetGid}`;
      if (!force && snapshotCache?.key === cacheKey && snapshotCache.expiresAt > now()) return snapshotCache.value;
      const sheet = await metadata(config);
      await ensureColumnCapacity(config, sheet);
      const quoted = quoteSheetName(sheet.title);
      const [headerRows, leftRows, rightRows] = await batchValues(config, [
        `${quoted}!A1:M1`, `${quoted}!B2:C`, `${quoted}!E2:M`
      ]);
      const header = headerRows[0] || [];
      await ensureManagedSchema(config, sheet, header, rightRows);
      const jobs = [];
      const occupiedRows = new Set();
      const rowCount = Math.max(leftRows.length, rightRows.length);
      for (let index = 0; index < rowCount; index += 1) {
        const left = leftRows[index] || [];
        const right = rightRows[index] || [];
        if (!summaryRowOccupied(left, right)) continue;
        occupiedRows.add(index + 2);
        jobs.push(summaryJob(left, right, index + 2));
      }
      const dropdownProfiles = await validationProfiles(config, sheet.title);
      const seenProfiles = jobs.map((job) => job.profile).filter(Boolean);
      const profiles = [...new Set([...dropdownProfiles, ...seenProfiles])];
      const snapshot = { sheet, occupiedRows, jobs, profiles };
      snapshotCache = { key: cacheKey, value: snapshot, expiresAt: now() + SNAPSHOT_TTL_MS };
      connection = "connected";
      return snapshot;
    }

    async function configure({ credentials, sheetUrl, sheetGid } = {}) {
      await initialize();
      const previous = state;
      const serviceAccount = credentials === undefined || credentials === null
        ? previous?.credentials : sanitizeCredentials(credentials);
      if (!serviceAccount) throw failure("INVALID_SERVICE_ACCOUNT", "Choose a Google service-account credentials JSON file.");
      const target = parseSheetTarget(sheetUrl || previous?.target?.sheetUrl, sheetGid ?? previous?.target?.sheetGid);
      const candidate = { version: 1, credentials: serviceAccount, target, sheetTitle: "", profileOptions: null };
      accessToken = null;
      snapshotCache = null;
      connection = "checking";
      try {
        const snapshot = await readSnapshot(candidate, { force: true });
        candidate.sheetTitle = snapshot.sheet.title;
        candidate.profileOptions = { profiles: snapshot.profiles };
        await persist(candidate);
        connection = "connected";
        changed();
        return getStatus();
      } catch (error) {
        state = previous;
        accessToken = null;
        snapshotCache = null;
        connection = previous ? "offline" : "unconfigured";
        throw error;
      }
    }

    async function clearConfiguration() {
      if (!storage?.setAccessLevel) throw failure("TRACKER_STORAGE_ERROR", "Trusted extension storage is unavailable.");
      try {
        await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        await storage.remove([STORAGE_KEY, LEGACY_STORAGE_KEY, RECEIPTS_KEY]);
      }
      catch { throw failure("TRACKER_STORAGE_ERROR", "The tracker could not remove its Google Sheet settings."); }
      state = null;
      accessToken = null;
      snapshotCache = null;
      connection = "unconfigured";
      initialization = Promise.resolve();
      changed();
      return getStatus();
    }

    async function getOptions({ refresh = false } = {}) {
      await initialize();
      const config = requireConfig();
      const snapshot = await readSnapshot(config, { force: refresh });
      const result = { profiles: [...snapshot.profiles] };
      if (refresh || JSON.stringify(config.profileOptions) !== JSON.stringify(result)) {
        await persist({ ...config, sheetTitle: snapshot.sheet.title, profileOptions: result });
      }
      return result;
    }

    async function lookupDuplicate(company) {
      await initialize();
      const normalized = normalizeCompany(company);
      if (!normalized) return { duplicate: null };
      const snapshot = await readSnapshot(requireConfig());
      const match = snapshot.jobs.filter(blocksDuplicate)
        .filter((job) => normalizeCompany(job.company) === normalized)
        .sort((left, right) => right.rowNumber - left.rowNumber)[0];
      return { duplicate: match ? brief(match) : null };
    }

    async function revisionFor(companies) {
      const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(companies)));
      return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    }

    async function getCompanies({ refresh = false, revision = "" } = {}) {
      await initialize();
      const snapshot = await readSnapshot(requireConfig(), { force: refresh });
      const companies = [];
      const seen = new Set();
      for (const job of snapshot.jobs.filter(blocksDuplicate)) {
        const key = normalizeCompany(job.company);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        companies.push(job.company);
        if (companies.length > MAX_COMPANY_SNAPSHOT_SIZE) {
          throw failure("SHEET_TOO_LARGE", `The tracker supports up to ${MAX_COMPANY_SNAPSHOT_SIZE.toLocaleString()} tracked companies.`);
        }
      }
      companies.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
      const currentRevision = await revisionFor(companies.map(normalizeCompany));
      return revision && revision === currentRevision
        ? { companies: [], revision: currentRevision, unchanged: true }
        : { companies, revision: currentRevision, unchanged: false };
    }

    async function fingerprint(config, job) {
      const input = JSON.stringify([config.target.spreadsheetId, config.target.sheetGid,
        normalizeCompany(job.company), job.jobTitle, job.jobDescription, job.applyUrl, job.profile]);
      const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(input));
      return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    }

    async function receipts() {
      try {
        const value = (await storage.get(RECEIPTS_KEY))?.[RECEIPTS_KEY];
        return Array.isArray(value) ? value.filter((entry) => plainObject(entry) && typeof entry.fingerprint === "string").slice(-MAX_RECEIPTS) : [];
      } catch {
        throw failure("TRACKER_STORAGE_ERROR", "The tracker could not safely read its local save receipts, so nothing was written.");
      }
    }

    async function saveReceipt(entry) {
      const current = await receipts();
      const next = [...current.filter((item) => item.fingerprint !== entry.fingerprint), entry].slice(-MAX_RECEIPTS);
      try { await storage.set({ [RECEIPTS_KEY]: next }); }
      catch { throw failure("TRACKER_STORAGE_ERROR", "The tracker could not save its local receipt, so nothing was written."); }
    }

    function jobMatches(job, input) {
      return normalizeCompany(job.company) === normalizeCompany(input.company) && job.jobTitle === input.jobTitle &&
        job.jobDescription === input.jobDescription && job.applyUrl === input.applyUrl && job.profile === input.profile;
    }

    async function exactJob(config, sheetTitle, rowNumber) {
      const range = `${quoteSheetName(sheetTitle)}!A${rowNumber}:M${rowNumber}`;
      const result = await values(config, range);
      return result[0] ? rowJob(result[0], rowNumber) : null;
    }

    async function saveJobNow(raw, { profile = "" } = {}) {
      await initialize();
      const config = requireConfig();
      const job = normalizeJob(raw, profile);
      const jobFingerprint = await fingerprint(config, job);
      const knownReceipts = await receipts();
      const receipt = knownReceipts.find((entry) => entry.fingerprint === jobFingerprint);
      const snapshot = await readSnapshot(config, { force: true });
      const duplicate = snapshot.jobs.filter(blocksDuplicate)
        .filter((candidate) => normalizeCompany(candidate.company) === normalizeCompany(job.company))
        .sort((left, right) => right.rowNumber - left.rowNumber)[0];
      if (duplicate) {
        if (receipt && receipt.rowNumber === duplicate.rowNumber) {
          const exact = await exactJob(config, snapshot.sheet.title, duplicate.rowNumber);
          if (exact && blocksDuplicate(exact) && jobMatches(exact, job)) {
            try {
              await saveReceipt({ fingerprint: jobFingerprint, rowNumber: duplicate.rowNumber, status: "confirmed", savedAt: now() });
            } catch { /* The matching Sheet row is already authoritative. */ }
            return { status: "inserted", replayed: true, job: exact };
          }
        }
        throw failure("DUPLICATE_COMPANY",
          `An existing ${duplicate.status || "recorded"} job for ${duplicate.company} was found in row ${duplicate.rowNumber}.`,
          { duplicate: brief(duplicate) });
      }
      if (job.profile && !snapshot.profiles.includes(job.profile)) {
        throw failure("INVALID_PROFILE", "Choose a profile that exists in the Google Sheet, or No profile.");
      }

      const rowNumber = nextAvailableRow(snapshot.occupiedRows);
      await saveReceipt({ fingerprint: jobFingerprint, rowNumber, status: "pending", savedAt: now() });
      const range = `${quoteSheetName(snapshot.sheet.title)}!A${rowNumber}:M${rowNumber}`;
      try {
        if (rowNumber > Number(snapshot.sheet.gridProperties?.rowCount || 0)) {
          await google(config, ":batchUpdate", { method: "POST", body: { requests: [{
            updateSheetProperties: {
              properties: { sheetId: snapshot.sheet.sheetId, gridProperties: { rowCount: rowNumber } },
              fields: "gridProperties.rowCount"
            }
          }] } });
          snapshot.sheet.gridProperties = { ...(snapshot.sheet.gridProperties || {}), rowCount: rowNumber };
        }
        await google(config, "/values:batchUpdate", { method: "POST", body: {
          valueInputOption: "RAW",
          data: [{ range, majorDimension: "ROWS", values: [[
            "", job.company, job.jobTitle, job.jobDescription, job.applyUrl, job.profile,
            "added", "", "", "", "", "Job tracker", ""
          ]] }]
        } });
      } catch (error) {
        if (["TRACKER_OFFLINE", "GOOGLE_REQUEST_TIMEOUT", "GOOGLE_RESPONSE_INVALID"].includes(error?.code)) {
          throw failure("TRACKER_SAVE_UNCONFIRMED",
            "The Google Sheet save could not be confirmed. Nothing will retry automatically; check the Sheet before saving this company again.");
        }
        throw error;
      }

      let confirmed;
      try {
        confirmed = await exactJob(config, snapshot.sheet.title, rowNumber);
      } catch {
        throw failure("TRACKER_SAVE_UNCONFIRMED",
          "The Google Sheet save could not be confirmed. Nothing will retry automatically; check the Sheet before saving this company again.");
      }
      if (!confirmed || !jobMatches(confirmed, job) || confirmed.status !== "added" || confirmed.addedBy !== "Job tracker") {
        throw failure("TRACKER_SAVE_UNCONFIRMED",
          "Google did not return the row that was just written. Check the Sheet before saving this company again.");
      }
      try {
        await saveReceipt({ fingerprint: jobFingerprint, rowNumber, status: "confirmed", savedAt: now() });
      } catch { /* A confirmed Sheet write must remain a success even if receipt cleanup fails. */ }
      snapshotCache = null;
      connection = "connected";
      return { status: "inserted", replayed: false, job: confirmed };
    }

    function saveJob(raw, options = {}) {
      // Serialize only live writes in this service-worker instance. This is
      // not a retry queue: each caller receives its own immediate outcome.
      const operation = mutationTail.then(
        () => saveJobNow(raw, options),
        () => saveJobNow(raw, options)
      );
      mutationTail = operation.catch(() => {});
      return operation;
    }

    async function getStatus() {
      await initialize();
      return {
        configured: Boolean(state),
        connection,
        sheetUrl: state?.target?.sheetUrl || "",
        sheetGid: state?.target?.sheetGid ?? "",
        sheetTitle: state?.sheetTitle || "",
        profileOptions: state?.profileOptions || null,
        entries: []
      };
    }

    return Object.freeze({
      init: initialize,
      configure,
      clearConfiguration,
      getOptions,
      lookupDuplicate,
      getCompanies,
      saveJob,
      getStatus
    });
  }

  root.GoogleSheetsTrackerClient = Object.freeze({
    create,
    parseSheetTarget,
    sanitizeCredentials,
    normalizeCompany,
    STORAGE_KEY,
    RECEIPTS_KEY
  });
})(globalThis);
