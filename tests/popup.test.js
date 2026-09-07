const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "src/popup-kai-flow.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyzABCDE/edit#gid=123";
const JOB = Object.freeze({
  title: "Software Engineer",
  company: "Example Company",
  description: "Build and maintain accessible software.",
  applyUrl: "https://example.test/jobs/123"
});

class Element {
  constructor(tagName = "div", value = "") {
    this.tagName = tagName.toUpperCase();
    this.value = value;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.href = "";
    this.files = [];
    this.children = [];
    this.listeners = new Map();
    this._text = "";
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      }
    };
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(_) { throw new Error("Popup must render untrusted data as text, not HTML."); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, handler) { this.listeners.set(name, [...(this.listeners.get(name) || []), handler]); }
  async dispatch(name) {
    if (name === "click" && this.disabled) return;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await Promise.all((this.listeners.get(name) || []).map((handler) => handler(event)));
    return event;
  }
}

function createPopup({
  job = JOB,
  profiles = ["Kai", "Alex"],
  selectedProfile = "",
  configured = true,
  respond,
  banned = []
} = {}) {
  const ids = [
    "scrape", "copyJson", "saveSheet", "openApplyUrl", "refreshConnection", "profile",
    "connectionStatus", "status", "duplicate", "json", "title", "company", "applyUrl", "description",
    "sheetSettings", "credentialsFile", "credentialsStatus", "sheetUrl", "sheetGid",
    "saveSheetSettings", "removeSheetSettings", "bannedSettings", "bannedCompanies", "bannedStatus",
    "saveBanned", "exportBanned", "importBanned"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element(id === "profile" ? "select" : "div")]));
  elements.profile.append(Object.assign(new Element("option", ""), { textContent: "No profile" }));
  elements.profile.disabled = true;
  elements.saveSheet.disabled = true;
  elements.duplicate.hidden = true;
  elements.openApplyUrl.classList.add("disabled");
  const document = new Element("document");
  document.body = new Element("body");
  document.querySelector = (selector) => {
    assert.match(selector, /^#[A-Za-z]+$/u);
    assert.ok(elements[selector.slice(1)], `Unexpected popup selector: ${selector}`);
    return elements[selector.slice(1)];
  };
  document.createElement = (tag) => new Element(tag);
  const messages = [];
  const storage = { kaiFlowSelectedProfile: selectedProfile };
  const storageWrites = [];
  const clipboard = [];
  const injected = [];
  const confirmations = [];
  const extensionId = "lomiekljcjnlhfpklnjmmhomknfigofn";
  const chrome = {
    runtime: {
      id: extensionId,
      onMessage: { addListener() {} },
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (respond) {
          const result = await respond(message, messages);
          if (result !== undefined) return result;
        }
        if (message.type === "KAI_TRACKER_STATUS") return { ok: true, result: {
          configured,
          connection: configured ? "connected" : "unconfigured",
          sheetUrl: configured ? SHEET_URL : "",
          sheetGid: configured ? 123 : "",
          sheetTitle: configured ? "Jobs" : "",
          profileOptions: { profiles }
        } };
        if (message.type === "KAI_TRACKER_OPTIONS") return { ok: true, result: { profiles } };
        if (message.type === "KAI_TRACKER_CONFIGURE") {
          configured = true;
          return { ok: true, result: { configured: true, connection: "connected", sheetUrl: SHEET_URL, sheetGid: 123, sheetTitle: "Jobs" } };
        }
        if (message.type === "KAI_TRACKER_CLEAR_CONFIG") {
          configured = false;
          return { ok: true, result: { configured: false, connection: "unconfigured", sheetUrl: "", sheetGid: "", sheetTitle: "" } };
        }
        if (message.type === "KAI_TRACKER_DUPLICATE") return { ok: true, result: { duplicate: null } };
        if (message.type === "KAI_TRACKER_BANNED_GET") return { ok: true, result: { companies: banned } };
        if (message.type === "KAI_TRACKER_BANNED_SET") {
          banned = message.companies;
          return { ok: true, result: { companies: banned } };
        }
        if (message.type === "KAI_TRACKER_SAVE") return { ok: true, result: { status: "inserted", replayed: false } };
        throw new Error(`Unexpected message: ${message.type}`);
      }
    },
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { storageWrites.push(structuredClone(values)); Object.assign(storage, values); }
    } },
    tabs: {
      async query() { return [{ id: 1, url: "https://www.linkedin.com/jobs/view/123" }]; },
      async sendMessage(tabId, message) {
        assert.equal(tabId, 1);
        assert.equal(message.type, "SCRAPE_LINKEDIN_JOB");
        return { ok: true, data: structuredClone(job) };
      }
    },
    scripting: { async executeScript(value) { injected.push(structuredClone(value)); } }
  };
  const context = vm.createContext({
    document,
    chrome,
    URL,
    console,
    setTimeout,
    clearTimeout,
    confirm(message) { confirmations.push(message); return true; },
    Option: function Option(text, value) { return Object.assign(new Element("option", value), { textContent: text }); },
    navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } },
    Blob,
    structuredClone
  });
  vm.runInContext(SOURCE, context, { filename: "popup-kai-flow.js" });
  return {
    elements, messages, storageWrites, clipboard, injected, confirmations,
    async start() { await document.dispatch("DOMContentLoaded"); await settle(); },
    async click(id) { await elements[id].dispatch("click"); await settle(); },
    async input(id, value) { elements[id].value = value; await elements[id].dispatch("input"); await settle(); },
    async select(value) { elements.profile.value = value; await elements.profile.dispatch("change"); await settle(); },
    async chooseFile(file) { elements.credentialsFile.files = [file]; await elements.credentialsFile.dispatch("change"); await settle(); }
  };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("popup contains direct Google Sheet settings and no pairing or server controls", () => {
  assert.match(HTML, /Service-account credentials JSON/);
  assert.match(HTML, /Google Sheet URL/);
  assert.match(HTML, /Destination tab gid/);
  assert.doesNotMatch(HTML + SOURCE, /pairing|connectServer|Server connection|permissions\.request|\/api\/tracker/iu);
  assert.deepEqual([...HTML.matchAll(/<script\b[^>]*src="([^"]+)"/gu)].map((match) => match[1]), ["src/popup-kai-flow.js"]);
  assert.doesNotMatch(SOURCE, /fetch\s*\(/u);
});

test("configured popup loads Sheet profiles and saves the captured job directly", async () => {
  const app = createPopup();
  await app.start();
  assert.equal(app.elements.connectionStatus.textContent, "Connected · Jobs");
  assert.deepEqual(app.elements.profile.children.map((item) => [item.textContent, item.value]), [
    ["No profile", ""], ["Kai", "Kai"], ["Alex", "Alex"]
  ]);
  assert.equal(app.elements.saveSheet.disabled, false);
  await app.click("saveSheet");
  const save = app.messages.find((message) => message.type === "KAI_TRACKER_SAVE");
  assert.deepEqual(save.job, JOB);
  assert.equal(save.profile, "");
  assert.match(app.elements.status.textContent, /Saved to Google Sheet · Pending/);
});

test("unconfigured popup opens settings and cannot save", async () => {
  const app = createPopup({ configured: false });
  await app.start();
  assert.equal(app.elements.sheetSettings.open, true);
  assert.equal(app.elements.saveSheet.disabled, true);
  assert.match(app.elements.connectionStatus.textContent, /not configured/i);
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_OPTIONS"), false);
});

test("credentials file, Sheet URL, and gid are sent once to the trusted worker configuration action", async () => {
  const app = createPopup({ configured: false });
  await app.start();
  const credentials = { type: "service_account", client_email: "synthetic@example.test", private_key: "synthetic-private-key" };
  await app.chooseFile({ name: "service-account.json", size: 200, async text() { return JSON.stringify(credentials); } });
  app.elements.sheetUrl.value = SHEET_URL;
  app.elements.sheetGid.value = "123";
  await app.click("saveSheetSettings");
  const configure = app.messages.find((message) => message.type === "KAI_TRACKER_CONFIGURE");
  assert.deepEqual(configure, { type: "KAI_TRACKER_CONFIGURE", credentials, sheetUrl: SHEET_URL, sheetGid: "123" });
  assert.equal(app.elements.credentialsFile.value, "");
  assert.match(app.elements.credentialsStatus.textContent, /stored locally/i);
  assert.equal(app.storageWrites.some((value) => JSON.stringify(value).includes("private_key")), false,
    "the popup never stores credentials; only the trusted service worker does");
});

test("updating an existing Sheet target does not require resending credentials", async () => {
  const app = createPopup({ configured: true });
  await app.start();
  app.elements.sheetUrl.value = SHEET_URL;
  app.elements.sheetGid.value = "123";
  await app.click("saveSheetSettings");
  const configure = app.messages.find((message) => message.type === "KAI_TRACKER_CONFIGURE");
  assert.equal(Object.hasOwn(configure, "credentials"), false);
});

test("invalid credentials JSON never reaches the service worker", async () => {
  const app = createPopup({ configured: false });
  await app.start();
  await app.chooseFile({ name: "broken.json", size: 20, async text() { return "{"; } });
  await app.click("saveSheetSettings");
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_CONFIGURE"), false);
  assert.match(app.elements.credentialsStatus.textContent, /not valid JSON/i);
});

test("Remove settings clears the direct configuration after confirmation", async () => {
  const app = createPopup({ configured: true });
  await app.start();
  await app.click("removeSheetSettings");
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_CLEAR_CONFIG"), true);
  assert.equal(app.elements.sheetSettings.open, true);
  assert.equal(app.elements.saveSheet.disabled, true);
});

test("Sheet duplicates and banned companies block Save and render concise text", async () => {
  const duplicate = { rowNumber: 7, company: "Example Company", jobTitle: "Existing role", status: "tailored", jobDescriptionPreview: "Existing work" };
  const duplicateApp = createPopup({ respond(message) {
    if (message.type === "KAI_TRACKER_DUPLICATE") return { ok: true, result: { duplicate } };
  } });
  await duplicateApp.start();
  assert.equal(duplicateApp.elements.saveSheet.disabled, true);
  assert.match(duplicateApp.elements.duplicate.textContent, /Already in Google Sheet/);
  assert.doesNotMatch(duplicateApp.elements.duplicate.textContent, /<img|onerror/iu);

  const bannedApp = createPopup({ banned: ["Example Company"] });
  await bannedApp.start();
  assert.equal(bannedApp.elements.saveSheet.disabled, true);
  assert.match(bannedApp.elements.duplicate.textContent, /Banned company/);
});

test("an unconfirmed direct save is never retried or queued by the popup", async () => {
  let saves = 0;
  const app = createPopup({ respond(message) {
    if (message.type === "KAI_TRACKER_SAVE") {
      saves += 1;
      return { ok: false, error: { code: "TRACKER_SAVE_UNCONFIRMED", message: "Check the Google Sheet before saving again." } };
    }
  } });
  await app.start();
  await app.click("saveSheet");
  assert.equal(saves, 1);
  assert.match(app.elements.status.textContent, /Check the Google Sheet/);
  assert.doesNotMatch(HTML, /Save queue|queueList|queueSummary/iu);
});

test("popup field order remains company, title, URL, profile, description", () => {
  const positions = ["company", "title", "applyUrl", "profile", "description"].map((id) => HTML.indexOf(`id="${id}"`));
  assert.equal(positions.every((position, index) => index === 0 || position > positions[index - 1]), true);
});
