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
const MODELS = [
  { id: "session-alpha", name: "Session Alpha", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "medium" },
  { id: "session-beta", name: "Session Beta", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" }
];

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
  selectedModel = "",
  selectedReasoningEffort = "",
  models = MODELS,
  configured = true,
  respond,
  banned = []
} = {}) {
  const ids = [
    "scrape", "copyJson", "saveSheet", "openApplyUrl", "refreshConnection", "folderSettings", "profile",
    "connectionStatus", "status", "duplicate", "json", "title", "company", "applyUrl", "description",
    "sheetSettings", "credentialsFile", "credentialsStatus", "sheetUrl", "sheetGid",
    "saveSheetSettings", "removeSheetSettings", "bannedSettings", "bannedCompanies", "bannedStatus",
    "saveBanned", "exportBanned", "importBanned", "researchModel", "researchEffort", "researchModelStatus", "refreshResearchModels", "startResearch"
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
      getURL: file => `chrome-extension://${extensionId}/${file}`,
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
        if (message.type === "KAI_TRACKER_RESEARCH_MODELS") return { ok: true, result: {
          models, defaultModel: "session-alpha", defaultReasoningEffort: "xhigh", selectedModel, selectedReasoningEffort
        } };
        if (message.type === "KAI_TRACKER_RESEARCH_MODEL_SET") {
          selectedModel = message.model;
          if (selectedReasoningEffort && !models.find(model => model.id === (selectedModel || "session-alpha"))?.reasoningEfforts?.includes(selectedReasoningEffort)) selectedReasoningEffort = "";
          return { ok: true, result: { selectedModel, selectedReasoningEffort } };
        }
        if (message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET") {
          selectedReasoningEffort = message.reasoningEffort;
          return { ok: true, result: { selectedModel, selectedReasoningEffort } };
        }
        if (message.type === "KAI_TRACKER_RESEARCH_START") return { ok: true, result: { status: "ready", alreadyRunning: false } };
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
      async create(options) { injected.push(structuredClone(options)); },
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
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/profile-routing.js"), "utf8"), context);
  vm.runInContext(SOURCE, context, { filename: "popup-kai-flow.js" });
  return {
    elements, messages, storageWrites, clipboard, injected, confirmations,
    async start() { await document.dispatch("DOMContentLoaded"); await settle(); },
    async click(id) { await elements[id].dispatch("click"); await settle(); },
    async input(id, value) { elements[id].value = value; await elements[id].dispatch("input"); await settle(); },
    async select(value) { elements.profile.value = value; await elements.profile.dispatch("change"); await settle(); },
    async selectModel(value) { elements.researchModel.value = value; await elements.researchModel.dispatch("change"); await settle(); },
    async selectEffort(value) { elements.researchEffort.value = value; await elements.researchEffort.dispatch("change"); await settle(); },
    async chooseFile(file) { elements.credentialsFile.files = [file]; await elements.credentialsFile.dispatch("change"); await settle(); }
  };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("popup contains direct Google Sheet settings and no pairing or server controls", () => {
  assert.doesNotMatch(HTML, /credentialsFile|sheetSettings|Destination tab gid/);
  assert.match(HTML, /Jobs are saved directly in your ApplicantAlly data folder/);
  assert.doesNotMatch(HTML + SOURCE, /pairing|connectServer|Server connection|permissions\.request|\/api\/tracker/iu);
  assert.deepEqual([...HTML.matchAll(/<script\b[^>]*src="([^"]+)"/gu)].map((match) => match[1]), ["src/profile-routing.js", "src/popup-kai-flow.js"]);
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
  assert.match(app.elements.status.textContent, /Saved to ApplicantAlly · Pending/);
});

test("UK search selects Michal, Colombia/LATAM select Jose, and US waits for Kevin/Jagjeet analysis", async () => {
  const profiles = ["kevin", "jagjeet", "jose-ibero-2page", "michal-stefanow-2page"];
  for (const [selectedRegion, expected] of [["uk", "michal-stefanow-2page"], ["colombia", "jose-ibero-2page"], ["latam", "jose-ibero-2page"], ["us", "__automatic_profile__"]]) {
    const app = createPopup({ job: { ...JOB, selectedRegion, selectedRegionSource: "search-control" }, profiles, selectedProfile: "kevin" });
    await app.start(); assert.equal(app.elements.profile.value, expected); assert.equal(app.elements.profile.disabled, true);
    assert.equal(app.elements.saveSheet.disabled, false); assert.equal(app.storageWrites.length, 0);
    await app.click("saveSheet");
    assert.equal(app.messages.find((message) => message.type === "KAI_TRACKER_SAVE").profile, selectedRegion === "us" ? "" : expected);
  }
});

test("missing required regional profile blocks capture instead of saving another candidate", async () => {
  const app = createPopup({ job: { ...JOB, selectedRegion: "uk" }, profiles: ["kevin"], selectedProfile: "kevin" });
  await app.start(); assert.equal(app.elements.profile.value, ""); assert.equal(app.elements.saveSheet.disabled, true);
  assert.match(app.elements.status.textContent, /Michal Stefanow is unavailable/);
});

test("unconfigured popup opens settings and cannot save", async () => {
  const app = createPopup({ configured: false });
  await app.start();
  assert.equal(app.elements.sheetSettings.open, false);
  assert.equal(app.elements.saveSheet.disabled, true);
  assert.match(app.elements.connectionStatus.textContent, /Choose ApplicantAlly folder/i);
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_OPTIONS"), false);
  await app.click("folderSettings");
  assert.equal(app.injected.at(-1).url, "chrome-extension://lomiekljcjnlhfpklnjmmhomknfigofn/folder.html");
});

test("Sheet duplicates and banned companies block Save and render concise text", async () => {
  const duplicate = { rowNumber: 7, company: "Example Company", jobTitle: "Existing role", status: "tailored", jobDescriptionPreview: "Existing work" };
  const duplicateApp = createPopup({ respond(message) {
    if (message.type === "KAI_TRACKER_DUPLICATE") return { ok: true, result: { duplicate } };
  } });
  await duplicateApp.start();
  assert.equal(duplicateApp.elements.saveSheet.disabled, true);
  assert.match(duplicateApp.elements.duplicate.textContent, /Already in ApplicantAlly/);
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

test("research models load before folder setup and selections persist through the background only", async () => {
  const app = createPopup({ configured: false, selectedModel: "session-beta" });
  await app.start();
  assert.equal(app.elements.researchModel.disabled, false);
  assert.equal(app.elements.researchModel.value, "session-beta");
  assert.deepEqual(app.elements.researchModel.children.map(option => [option.textContent, option.value]),
    [["Session default · Session Alpha", ""], ["Session Alpha", "session-alpha"], ["Session Beta", "session-beta"]]);
  await app.selectModel("");
  assert.deepEqual(app.messages.find(message => message.type === "KAI_TRACKER_RESEARCH_MODEL_SET"),
    { type: "KAI_TRACKER_RESEARCH_MODEL_SET", model: "" });
  assert.equal(app.storageWrites.length, 0);
  assert.equal(app.elements.researchModel.value, "");
  assert.match(app.elements.researchModelStatus.textContent, /saved for new job sessions/);
  assert.equal(app.elements.saveSheet.disabled, true);
});

test("an unavailable saved model remains visible until an explicit replacement is saved", async () => {
  const app = createPopup({ selectedModel: "retired-model" });
  await app.start();
  assert.equal(app.elements.researchModel.value, "retired-model");
  assert.equal(app.elements.researchModel.children.at(-1).disabled, true);
  assert.match(app.elements.researchModelStatus.textContent, /saved model is unavailable/);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_MODEL_SET"), false);
  await app.selectModel("session-beta");
  assert.equal(app.elements.researchModel.value, "session-beta");
  assert.equal(app.elements.saveSheet.disabled, false);
});

test("a rejected model choice reverts the control and leaves profile and save controls usable", async () => {
  const app = createPopup({ selectedModel: "session-alpha", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_MODEL_SET") return { ok: false, error: { message: "Selected model is no longer available." } };
  } });
  await app.start();
  await app.selectModel("session-beta");
  assert.equal(app.elements.researchModel.value, "session-alpha");
  assert.match(app.elements.researchModelStatus.textContent, /no longer available/);
  assert.equal(app.elements.researchModel.disabled, false);
  assert.equal(app.elements.refreshResearchModels.disabled, false);
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.equal(app.storageWrites.length, 0);
});

test("model discovery outages do not disable folder captures and refresh recovers the catalog", async () => {
  let offline = true;
  const app = createPopup({ respond(message) {
    if (offline && message.type === "KAI_TRACKER_RESEARCH_MODELS") return { ok: false, error: { message: "Start the research worker and refresh." } };
  } });
  await app.start();
  assert.equal(app.elements.researchModel.disabled, true);
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.match(app.elements.researchModelStatus.textContent, /Start the research worker/);
  offline = false;
  await app.click("refreshResearchModels");
  assert.equal(app.elements.researchModel.disabled, false);
  assert.equal(app.elements.researchModel.children.length, 3);
  assert.equal(app.elements.connectionStatus.textContent, "Connected · Jobs");
});

test("starting research recovers an offline catalog without altering the saved model or folder capture", async () => {
  let online = false;
  const app = createPopup({ selectedModel: "session-beta", selectedProfile: "Alex", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_MODELS" && !online) {
      return { ok: false, error: { code: "RESEARCH_UNAVAILABLE", message: "The research worker is unavailable." } };
    }
    if (message.type === "KAI_TRACKER_RESEARCH_START") online = true;
  } });
  await app.start();
  assert.match(HTML, /id="startResearch"[^>]*>Start \/ reconnect research/);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_START"), false);
  assert.equal(app.elements.startResearch.disabled, false);
  await app.click("startResearch");
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_RESEARCH_START").length, 1);
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_RESEARCH_MODELS").length, 2);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_MODEL_SET"), false);
  assert.equal(app.elements.researchModel.value, "session-beta");
  assert.equal(app.elements.researchModel.disabled, false);
  assert.equal(app.elements.profile.value, "Alex");
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.deepEqual(app.storageWrites, []);
  assert.match(app.elements.researchModelStatus.textContent, /Models reported/);
});

test("research recovery serializes duplicate clicks and blocks model changes until the catalog is refreshed", async () => {
  let finishStart;
  const app = createPopup({ selectedModel: "session-beta", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_START") return new Promise(resolve => { finishStart = resolve; });
  } });
  await app.start();
  await app.click("startResearch");
  assert.equal(app.elements.startResearch.disabled, true);
  assert.equal(app.elements.startResearch.textContent, "Starting…");
  assert.equal(app.elements.researchModel.disabled, true);
  assert.equal(app.elements.refreshResearchModels.disabled, true);
  assert.match(app.elements.researchModelStatus.textContent, /Starting the research worker/);
  assert.equal(app.elements.saveSheet.disabled, false);
  await app.click("startResearch");
  await app.click("refreshResearchModels");
  await app.selectModel("session-alpha");
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_RESEARCH_START").length, 1);
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_RESEARCH_MODELS").length, 1);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_MODEL_SET"), false);
  finishStart({ ok: true, result: { status: "ready", alreadyRunning: true } });
  await settle();
  assert.equal(app.elements.startResearch.disabled, false);
  assert.equal(app.elements.startResearch.textContent, "Start / reconnect research");
  assert.equal(app.elements.researchModel.value, "session-beta");
  assert.equal(app.elements.researchModel.disabled, false);
  assert.equal(app.elements.refreshResearchModels.disabled, false);
});

test("a failed research start displays actionable errors and keeps model, profile, and save usable", async () => {
  const failure = "Research launcher is not installed. Run scripts/install-research-launcher.ps1 once, then reconnect.";
  const app = createPopup({ selectedModel: "session-beta", selectedProfile: "Alex", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_START") return { ok: false, error: { code: "RESEARCH_LAUNCHER_NOT_INSTALLED", message: failure } };
  } });
  await app.start();
  await app.click("startResearch");
  assert.equal(app.elements.researchModelStatus.textContent, failure);
  assert.equal(app.elements.researchModel.value, "session-beta");
  assert.equal(app.elements.researchModel.disabled, false);
  assert.equal(app.elements.profile.value, "Alex");
  assert.equal(app.elements.profile.disabled, false);
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.equal(app.elements.startResearch.disabled, false);
  assert.equal(app.elements.refreshResearchModels.disabled, false);
  assert.equal(app.messages.filter(message => message.type === "KAI_TRACKER_RESEARCH_MODELS").length, 1);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_MODEL_SET"), false);
  assert.deepEqual(app.storageWrites, []);
});

test("research recovery is available before configuring the ApplicantAlly folder", async () => {
  const app = createPopup({ configured: false });
  await app.start();
  await app.click("startResearch");
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_START"), true);
  assert.equal(app.elements.researchModel.disabled, false);
  assert.equal(app.elements.saveSheet.disabled, true);
  assert.match(app.elements.connectionStatus.textContent, /Choose ApplicantAlly folder/);
});

test("an older model request cannot overwrite recovery progress or a recovery failure", async () => {
  let finishCatalog;
  let finishStart;
  const app = createPopup({ respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_MODELS") return new Promise(resolve => { finishCatalog = resolve; });
    if (message.type === "KAI_TRACKER_RESEARCH_START") return new Promise(resolve => { finishStart = resolve; });
  } });
  await app.start();
  await app.click("startResearch");
  finishCatalog({ ok: true, result: { models: [{ id: "stale", name: "Stale" }], defaultModel: "stale", selectedModel: "stale" } });
  await settle();
  assert.match(app.elements.researchModelStatus.textContent, /Starting the research worker/);
  assert.equal(app.elements.researchModel.value, "");
  assert.equal(app.elements.refreshResearchModels.disabled, true);
  finishStart({ ok: false, error: { message: "Port 8787 belongs to another app. Stop that app and reconnect." } });
  await settle();
  assert.match(app.elements.researchModelStatus.textContent, /Port 8787 belongs to another app/);
  assert.equal(app.elements.researchModel.value, "");
  assert.equal(app.elements.researchModel.disabled, true);
  assert.equal(app.elements.startResearch.disabled, false);
});

test("an older model request cannot replace the recovered model catalog", async () => {
  let finishCatalog;
  let calls = 0;
  const app = createPopup({ selectedModel: "session-beta", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_MODELS" && ++calls === 1) return new Promise(resolve => { finishCatalog = resolve; });
  } });
  await app.start();
  await app.click("startResearch");
  assert.equal(app.elements.researchModel.value, "session-beta");
  finishCatalog({ ok: false, error: { message: "Stale worker failure." } });
  await settle();
  assert.equal(app.elements.researchModel.value, "session-beta");
  assert.equal(app.elements.researchModel.disabled, false);
  assert.match(app.elements.researchModelStatus.textContent, /Models reported/);
});

test("reasoning levels come from the selected model and use ApplicantAlly labels", async () => {
  const app = createPopup({ configured: false });
  await app.start();
  assert.match(HTML, /<span>Reasoning level<\/span>/);
  assert.match(HTML, /Running and queued sessions keep their model and reasoning level/);
  assert.equal(app.elements.researchEffort.disabled, false);
  assert.deepEqual(app.elements.researchEffort.children.map(option => [option.textContent, option.value]), [
    ["Automatic · Extra high (xhigh)", ""], ["Low", "low"], ["Medium", "medium"], ["High", "high"],
    ["Extra high (xhigh)", "xhigh"], ["Maximum (max)", "max"], ["Ultra", "ultra"]
  ]);
  await app.selectEffort("medium");
  assert.deepEqual(app.messages.find(message => message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET"),
    { type: "KAI_TRACKER_RESEARCH_EFFORT_SET", reasoningEffort: "medium" });
  assert.equal(app.elements.researchEffort.value, "medium");
  assert.equal(app.elements.researchModel.value, "");
  assert.match(app.elements.researchModelStatus.textContent, /Reasoning level saved/);
  assert.deepEqual(app.storageWrites, []);
  await app.selectModel("session-beta");
  assert.equal(app.elements.researchEffort.value, "medium");
  assert.equal(app.elements.researchEffort.children.some(option => option.value === "ultra"), false);
});

test("switching models displays the returned compatible level or automatic reset", async () => {
  const app = createPopup({ selectedModel: "session-alpha", selectedReasoningEffort: "ultra" });
  await app.start();
  assert.equal(app.elements.researchEffort.value, "ultra");
  await app.selectModel("session-beta");
  assert.equal(app.elements.researchEffort.value, "");
  assert.equal(app.elements.researchEffort.children.some(option => option.value === "ultra"), false);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET"), false);
});

test("automatic level uses the selected model default when the research default is unsupported", async () => {
  const app = createPopup({ selectedModel: "session-beta", models: [MODELS[0],
    { id: "session-beta", name: "Session Beta", reasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium" }
  ] });
  await app.start();
  assert.deepEqual(app.elements.researchEffort.children.map(option => [option.textContent, option.value]),
    [["Automatic · Medium", ""], ["Low", "low"], ["Medium", "medium"]]);
});

test("catalogs without reasoning metadata offer only automatic, without invented levels", async () => {
  const app = createPopup({ models: [{ id: "session-alpha", name: "Session Alpha" }] });
  await app.start();
  assert.deepEqual(app.elements.researchEffort.children.map(option => [option.textContent, option.value]), [["Automatic", ""]]);
  assert.equal(app.elements.researchEffort.disabled, true);
  assert.equal(app.elements.researchModel.disabled, false);
});

test("an unavailable saved level remains visible until an explicit level change", async () => {
  const app = createPopup({ selectedModel: "session-beta", selectedReasoningEffort: "ultra" });
  await app.start();
  assert.equal(app.elements.researchEffort.value, "ultra");
  assert.equal(app.elements.researchEffort.children.at(-1).disabled, true);
  assert.match(app.elements.researchModelStatus.textContent, /saved reasoning level is unavailable/);
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET"), false);
  await app.selectEffort("");
  assert.equal(app.elements.researchEffort.value, "");
  assert.equal(app.elements.researchEffort.children.some(option => option.value === "ultra"), false);
});

test("a rejected reasoning choice rolls back both controls while captures remain usable", async () => {
  const app = createPopup({ selectedModel: "session-alpha", selectedReasoningEffort: "high", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET") return { ok: false, error: { message: "Ultra is no longer supported." } };
  } });
  await app.start();
  await app.selectEffort("ultra");
  assert.equal(app.elements.researchModel.value, "session-alpha");
  assert.equal(app.elements.researchEffort.value, "high");
  assert.equal(app.elements.researchEffort.disabled, false);
  assert.equal(app.elements.researchModel.disabled, false);
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.match(app.elements.researchModelStatus.textContent, /no longer supported/);
});

test("a rejected model choice preserves its saved reasoning level", async () => {
  const app = createPopup({ selectedModel: "session-alpha", selectedReasoningEffort: "ultra", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_MODEL_SET") return { ok: false, error: { message: "Model is no longer available." } };
  } });
  await app.start();
  await app.selectModel("session-beta");
  assert.equal(app.elements.researchModel.value, "session-alpha");
  assert.equal(app.elements.researchEffort.value, "ultra");
  assert.equal(app.elements.researchEffort.children.at(-1).disabled, false);
});

test("saving a level locks both settings and stale model refresh cannot replace the saved tuple", async () => {
  let finishCatalog;
  let finishSave;
  let catalogCalls = 0;
  const app = createPopup({ selectedModel: "session-alpha", selectedReasoningEffort: "medium", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_MODELS" && ++catalogCalls === 2) return new Promise(resolve => { finishCatalog = resolve; });
    if (message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET") return new Promise(resolve => { finishSave = resolve; });
  } });
  await app.start();
  await app.click("refreshResearchModels");
  const selecting = app.selectEffort("ultra");
  await settle();
  assert.equal(app.elements.researchEffort.disabled, true);
  assert.equal(app.elements.researchModel.disabled, true);
  assert.equal(app.elements.startResearch.disabled, true);
  assert.equal(app.elements.refreshResearchModels.disabled, true);
  assert.equal(app.elements.saveSheet.disabled, false);
  await app.click("startResearch");
  await app.selectModel("session-beta");
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_START" || message.type === "KAI_TRACKER_RESEARCH_MODEL_SET"), false);
  finishSave({ ok: true, result: { selectedModel: "session-alpha", selectedReasoningEffort: "ultra" } });
  await selecting;
  finishCatalog({ ok: true, result: { models: MODELS, defaultModel: "session-alpha", selectedModel: "session-beta", selectedReasoningEffort: "low" } });
  await settle();
  assert.equal(app.elements.researchModel.value, "session-alpha");
  assert.equal(app.elements.researchEffort.value, "ultra");
  assert.equal(app.elements.researchEffort.disabled, false);
  assert.match(app.elements.researchModelStatus.textContent, /Reasoning level saved/);
});

test("research recovery retains both settings and blocks reasoning edits while starting", async () => {
  let finishStart;
  const app = createPopup({ selectedModel: "session-alpha", selectedReasoningEffort: "ultra", respond(message) {
    if (message.type === "KAI_TRACKER_RESEARCH_START") return new Promise(resolve => { finishStart = resolve; });
  } });
  await app.start();
  await app.click("startResearch");
  assert.equal(app.elements.researchEffort.disabled, true);
  await app.selectEffort("medium");
  assert.equal(app.messages.some(message => message.type === "KAI_TRACKER_RESEARCH_EFFORT_SET"), false);
  finishStart({ ok: true, result: { status: "ready", alreadyRunning: true } });
  await settle();
  assert.equal(app.elements.researchModel.value, "session-alpha");
  assert.equal(app.elements.researchEffort.value, "ultra");
  assert.equal(app.elements.researchEffort.disabled, false);
});
