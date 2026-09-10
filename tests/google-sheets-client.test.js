const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, generateKeyPairSync, createHash } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "src/google-sheets-client.js"), "utf8");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const ID = "lomiekljcjnlhfpklnjmmhomknfigofn";
const SHEET_ID = "1abcdefghijklmnopqrstuvwxyzABCDE";
const GID = 123;
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${GID}`;
const HEADERS = ["Date", "Company", "Job Title", "Job Description", "Apply URL", "Profile", "Status", "Salary", "Info", "Attachment", "Trashed", "Added By", "Applied By"];
const JOB = { company: "Example Company", title: "Software Engineer", description: "Build thoughtful software.", applyUrl: "https://example.test/jobs/123" };
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDENTIALS = Object.freeze({
  type: "service_account",
  client_email: "tracker@example-project.iam.gserviceaccount.com",
  private_key: privateKey,
  private_key_id: "generated-test-key",
  project_id: "example-project"
});

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(payload); }
});

function harness(options = {}) {
  const stored = clone(options.stored || {});
  const events = [];
  const calls = [];
  let rows = clone(options.rows || [HEADERS]);
  const profiles = clone(options.profiles || []);
  const storage = {
    async setAccessLevel(value) { events.push(["access", clone(value)]); },
    async get(keys) {
      events.push(["get", clone(keys)]);
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.map((key) => [key, clone(stored[key])]));
    },
    async set(values) {
      if (options.failStorage) throw new Error("storage failed");
      events.push(["set", Object.keys(values)]);
      Object.assign(stored, clone(values));
    },
    async remove(keys) {
      events.push(["remove", clone(keys)]);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
    }
  };

  async function fetchImpl(url, init) {
    const parsed = new URL(url);
    const call = { url, init, parsed };
    calls.push(call);
    if (options.onFetch) {
      const override = await options.onFetch(call, { rows, stored, calls });
      if (override !== undefined) return override;
    }
    if (url === "https://oauth2.googleapis.com/token") {
      return response({ access_token: "synthetic-access-token", expires_in: 3600 });
    }
    if (parsed.hostname !== "sheets.googleapis.com") throw new Error("Unexpected host");
    if (parsed.pathname.endsWith(":batchUpdate") && !parsed.pathname.endsWith("values:batchUpdate")) {
      return response({ replies: [{}] });
    }
    if (parsed.pathname.endsWith("/values:batchUpdate")) {
      const body = JSON.parse(init.body);
      for (const entry of body.data) {
        const match = /!A(\d+):M\1$/u.exec(entry.range);
        if (match) rows[Number(match[1]) - 1] = clone(entry.values[0]);
        else if (/![KLM]1$/u.test(entry.range)) {
          const column = entry.range.match(/!([KLM])1$/u)[1].charCodeAt(0) - 65;
          rows[0][column] = entry.values[0][0];
        }
      }
      return response({ totalUpdatedRows: 1 });
    }
    if (parsed.pathname.endsWith("/values:batchGet")) {
      const valueRanges = parsed.searchParams.getAll("ranges").map((range) => {
        if (/!A1:M1$/u.test(range)) return { range, values: rows[0] ? [clone(rows[0])] : [] };
        if (/!B2:C$/u.test(range)) return { range, values: rows.slice(1).map((row) => clone(row.slice(1, 3))) };
        if (/!E2:M$/u.test(range)) return { range, values: rows.slice(1).map((row) => clone(row.slice(4, 13))) };
        throw new Error(`Unexpected batch range: ${range}`);
      });
      return response({ valueRanges });
    }
    if (parsed.pathname.includes("/values/")) {
      const range = decodeURIComponent(parsed.pathname.split("/values/")[1]);
      const rowMatch = /!A(\d+):M\1$/u.exec(range);
      return response({ values: rowMatch ? (rows[Number(rowMatch[1]) - 1] ? [clone(rows[Number(rowMatch[1]) - 1])] : []) : clone(rows) });
    }
    if (parsed.searchParams.get("includeGridData") === "true") {
      return response({ sheets: [{ data: [{ rowData: [{ values: [{ dataValidation: {
        condition: { type: "ONE_OF_LIST", values: profiles.map((value) => ({ userEnteredValue: value })) }
      } }] }] }] }] });
    }
    return response({ sheets: [{ properties: {
      sheetId: GID,
      title: "Jobs",
      index: 0,
      gridProperties: { rowCount: options.rowCount ?? Math.max(100, rows.length), columnCount: options.columnCount ?? 13 }
    } }] });
  }

  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    AbortController,
    console,
    crypto: webcrypto,
    atob(value) { return Buffer.from(value, "base64").toString("binary"); },
    btoa(value) { return Buffer.from(value, "binary").toString("base64"); },
    setTimeout,
    clearTimeout
  });
  vm.runInContext(SOURCE, context, { filename: "google-sheets-client.js" });
  const client = context.GoogleSheetsTrackerClient.create({
    storage,
    fetchImpl,
    cryptoImpl: webcrypto,
    timeoutMs: 1000,
    now: () => 1_800_000_000_000
  });
  return { client, stored, events, calls, getRows: () => clone(rows), api: context.GoogleSheetsTrackerClient };
}

async function configure(h, overrides = {}) {
  return h.client.configure({ credentials: CREDENTIALS, sheetUrl: SHEET_URL, sheetGid: String(GID), ...overrides });
}

test("manifest keeps its identity and grants only LinkedIn plus official Google API hosts", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json")));
  const identity = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/gu, (hex) => String.fromCharCode(97 + parseInt(hex, 16)));
  assert.equal(identity, ID);
  assert.equal(manifest.version, "0.4.3");
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
  assert.deepEqual(manifest.host_permissions.slice(0, 2), [
    "https://oauth2.googleapis.com/*", "https://sheets.googleapis.com/*"
  ]);
  assert.equal(manifest.host_permissions.some((value) => /localhost|127\.|ngrok|\*:\/\//u.test(value)), false);
  assert.match(manifest.content_security_policy.extension_pages, /oauth2\.googleapis\.com/);
  assert.match(manifest.content_security_policy.extension_pages, /sheets\.googleapis\.com/);
  assert.doesNotMatch(SOURCE + BACKGROUND, /WebSocket|\/api\/tracker|tracker-pair|127\.0\.0\.1|ngrok/iu);
  assert.equal(fs.existsSync(path.join(ROOT, "src/kai-flow-client.js")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "src/tracker-security.js")), false);
});

test("Sheet target and service-account validation reject arbitrary credential destinations", () => {
  const h = harness();
  assert.deepEqual(clone(h.api.parseSheetTarget(SHEET_URL, "")), {
    spreadsheetId: SHEET_ID, sheetGid: GID, sheetUrl: SHEET_URL
  });
  assert.throws(() => h.api.parseSheetTarget(SHEET_URL.replace("docs.google.com", "evil.example"), GID), { code: "INVALID_SHEET_URL" });
  assert.throws(() => h.api.parseSheetTarget(SHEET_URL, "not-a-gid"), { code: "INVALID_SHEET_GID" });
  const sanitized = clone(h.api.sanitizeCredentials({ ...CREDENTIALS, token_uri: "https://evil.example/token", extra_secret: "drop" }));
  assert.deepEqual(Object.keys(sanitized).sort(), ["client_email", "private_key", "private_key_id", "project_id", "type"]);
});

test("configuration authenticates with a signed JWT, stores credentials only locally, and returns safe status", async () => {
  const h = harness();
  const status = await configure(h);
  assert.equal(status.configured, true);
  assert.equal(status.connection, "connected");
  assert.equal(status.sheetTitle, "Jobs");
  assert.doesNotMatch(JSON.stringify(status), /private|client_email|access-token|gserviceaccount/iu);
  assert.equal(h.events.some(([type, value]) => type === "access" && value.accessLevel === "TRUSTED_CONTEXTS"), true);
  const tokenCall = h.calls.find((call) => call.url === "https://oauth2.googleapis.com/token");
  assert.ok(tokenCall);
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims] = form.get("assertion").split(".").slice(0, 2)
    .map((part) => JSON.parse(Buffer.from(part.replace(/-/gu, "+").replace(/_/gu, "/"), "base64url").toString("utf8")));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(claims.iss, CREDENTIALS.client_email);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(h.calls.every((call) => ["oauth2.googleapis.com", "sheets.googleapis.com"].includes(call.parsed.hostname)), true);
});

test("legacy server pairing state is purged and is never exposed as configured", async () => {
  const h = harness({ stored: { kaiFlowRemoteTracker: { version: 2, config: { token: "retired" } } } });
  await h.client.init();
  assert.equal((await h.client.getStatus()).configured, false);
  assert.equal(Object.hasOwn(h.stored, "kaiFlowRemoteTracker"), false);
});

test("malformed stored direct configuration fails closed but can still be removed", async () => {
  const seed = harness();
  const h = harness({ stored: {
    [seed.api.STORAGE_KEY]: { version: 1, credentials: { type: "service_account" }, target: {} },
    [seed.api.RECEIPTS_KEY]: [{ fingerprint: "stale", rowNumber: 2 }]
  } });
  await assert.rejects(h.client.getStatus(), { code: "TRACKER_STORAGE_ERROR" });
  const cleared = await h.client.clearConfiguration();
  assert.equal(cleared.configured, false);
  assert.equal(Object.hasOwn(h.stored, h.api.STORAGE_KEY), false);
  assert.equal(Object.hasOwn(h.stored, h.api.RECEIPTS_KEY), false);
  assert.equal((await h.client.getStatus()).connection, "unconfigured");
});

test("snapshots use one bounded batch summary read and never fetch column D descriptions", async () => {
  const h = harness({ rows: [HEADERS, ["", "Large Co", "Role", "x".repeat(49_000), "https://example.test", "", "added"]] });
  await configure(h);
  const batchCalls = h.calls.filter((call) => call.parsed.pathname.endsWith("/values:batchGet"));
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0].parsed.searchParams.getAll("ranges"), ["'Jobs'!A1:M1", "'Jobs'!B2:C", "'Jobs'!E2:M"]);
  assert.equal(h.calls.some((call) => decodeURIComponent(call.parsed.pathname).includes("!A1:M")), false);
  const duplicate = await h.client.lookupDuplicate("Large Co");
  assert.deepEqual(clone(duplicate.duplicate), { rowNumber: 2, company: "Large Co", jobTitle: "Role", status: "added" });
});

test("duplicate rules ignore K Trash and every Kai restriction outcome but block all other statuses", async () => {
  const restricted = ["clearance", "location restriction", "location-restriction", "on-site", "onsite", "language", "not applicable", "not-applicable", "restricted"];
  const rows = [HEADERS, ["", "Active Co", "Role", "JD", "", "", "", "", ""],
    ["", "K Trash", "Role", "JD", "", "", "applied", "", "", "", true],
    ["", "Trashed", "Role", "JD", "", "", "trashed"],
    ["", "Deleted", "Role", "JD", "", "", "deleted"],
    ...restricted.map((status) => ["", `Restricted ${status}`, "Role", "JD", "", "", status])];
  const h = harness({ rows });
  await configure(h);
  assert.equal((await h.client.lookupDuplicate(" active   co ")).duplicate.company, "Active Co");
  for (const name of ["K Trash", "Trashed", "Deleted", ...restricted.map((status) => `Restricted ${status}`)]) {
    assert.equal((await h.client.lookupDuplicate(name)).duplicate, null, name);
  }
  assert.deepEqual(clone((await h.client.getCompanies({ refresh: true })).companies), ["Active Co"]);
});

test("save ignores unchecked template metadata and stamps Added By in the first actual gap", async () => {
  const metadataOnly = ["old date", "", "", "orphan description", "", "", "", "", "", "Resume.pdf", false, "Someone", "Someone"];
  const rows = [HEADERS,
    ["", "Existing", "Role", "JD", "", "", "added"],
    metadataOnly,
    ["", "Later", "Role", "JD", "", "", "tailored"]];
  const h = harness({ rows });
  await configure(h);
  const result = await h.client.saveJob(JOB);
  assert.equal(result.job.rowNumber, 3);
  assert.deepEqual(h.getRows()[2], [
    "", JOB.company, JOB.title, JOB.description, JOB.applyUrl, "", "added", "", "", "", "", "Job tracker", ""
  ]);
});

test("a truthy K Trash marker occupies its row even when the ordinary job summary is blank", async () => {
  const h = harness({ rows: [
    HEADERS,
    ["", "Existing", "Role", "JD", "", "", "added"],
    ["", "", "", "orphan description", "", "", "", "", "", "", true]
  ] });
  await configure(h);
  const result = await h.client.saveJob(JOB);
  assert.equal(result.job.rowNumber, 4);
  assert.equal(h.getRows()[2][10], true, "the Trash tombstone row was preserved");
});

test("nonblank profile is rejected when the live Sheet options are empty", async () => {
  const h = harness({ profiles: [] });
  await configure(h);
  await assert.rejects(h.client.saveJob(JOB, { profile: "invented" }), { code: "INVALID_PROFILE" });
  assert.equal(h.calls.filter((call) => call.parsed.pathname.endsWith("/values:batchUpdate")).length, 0);
});

test("an uncertain write is reconciled from the local receipt without writing twice", async () => {
  let writes = 0;
  let rows = [HEADERS];
  const h = harness({
    rows,
    async onFetch(call, state) {
      if (!call.parsed.pathname.endsWith("/values:batchUpdate")) return undefined;
      writes += 1;
      const body = JSON.parse(call.init.body);
      const entry = body.data[0];
      const rowNumber = Number(/!A(\d+):M/u.exec(entry.range)[1]);
      state.rows[rowNumber - 1] = clone(entry.values[0]);
      throw new TypeError("connection ended after upload");
    }
  });
  await configure(h);
  await assert.rejects(h.client.saveJob(JOB), { code: "TRACKER_SAVE_UNCONFIRMED" });
  const replay = await h.client.saveJob(JOB);
  assert.equal(replay.replayed, true);
  assert.equal(writes, 1);
});

test("simultaneous saves are serialized and each re-reads the Sheet before choosing a row", async () => {
  const h = harness({ rows: [HEADERS] });
  await configure(h);
  const [first, second] = await Promise.all([
    h.client.saveJob({ ...JOB, company: "First Co" }),
    h.client.saveJob({ ...JOB, company: "Second Co" })
  ]);
  assert.equal(first.job.rowNumber, 2);
  assert.equal(second.job.rowNumber, 3);
  assert.equal(h.getRows()[1][1], "First Co");
  assert.equal(h.getRows()[2][1], "Second Co");
});

test("save expands a completely filled tab before writing its next row", async () => {
  const h = harness({
    rowCount: 2,
    rows: [HEADERS, ["", "Existing", "Role", "JD", "", "", "added"]]
  });
  await configure(h);
  const result = await h.client.saveJob(JOB);
  assert.equal(result.job.rowNumber, 3);
  const resize = h.calls.find((call) => call.parsed.pathname.endsWith(":batchUpdate") &&
    !call.parsed.pathname.endsWith("values:batchUpdate") && JSON.parse(call.init.body).requests?.[0]?.updateSheetProperties?.properties?.gridProperties?.rowCount === 3);
  assert.ok(resize, "the tab was expanded to include row 3 before the value write");
});

test("missing managed headers are created only when their columns contain no managed data", async () => {
  const headers = [...HEADERS];
  headers[10] = "";
  headers[11] = "";
  headers[12] = "";
  const h = harness({ rows: [headers, ["", "Existing", "Role", "JD", "", "", "added", "", "", "", false]] });
  await configure(h);
  assert.deepEqual(h.getRows()[0].slice(10, 13), ["Trashed", "Added By", "Applied By"]);

  const occupiedHeaders = [...HEADERS];
  occupiedHeaders[11] = "";
  const invalid = harness({ rows: [occupiedHeaders, ["", "Existing", "Role", "JD", "", "", "added", "", "", "", false, "Existing actor"]] });
  await assert.rejects(configure(invalid), { code: "SHEET_SCHEMA_MISMATCH" });
});

test("configuration expands a narrow legacy tab before reading through column M", async () => {
  const h = harness({ columnCount: 9, rows: [HEADERS] });
  await configure(h);
  const resize = h.calls.find((call) => call.parsed.pathname.endsWith(":batchUpdate") &&
    !call.parsed.pathname.endsWith("values:batchUpdate") && JSON.parse(call.init.body).requests?.[0]?.updateSheetProperties?.properties?.gridProperties?.columnCount === 13);
  assert.ok(resize);
  const resizeIndex = h.calls.indexOf(resize);
  const valuesIndex = h.calls.findIndex((call) => call.parsed.pathname.endsWith("/values:batchGet"));
  assert.ok(resizeIndex < valuesIndex, "column capacity is expanded before A:M is read");
});
