const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const popupSource = fs.readFileSync(path.join(root, "src/popup-kai-flow.js"), "utf8");
const securitySource = fs.readFileSync(path.join(root, "src/tracker-security.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const defaultJob = Object.freeze({
  title: "Software Engineer",
  company: "Example Company",
  description: "Build and maintain accessible software.",
  applyUrl: "https://example.test/jobs/123",
});

class Element {
  constructor(tagName = "div", value = "") {
    this.tagName = tagName.toUpperCase();
    this.value = value;
    this.disabled = false;
    this.hidden = false;
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
      },
    };
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(_) { throw new Error("Popup must render untrusted data as text, not HTML."); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, handler) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), handler]);
  }
  async dispatch(name) {
    // Match native buttons: a disabled button cannot be clicked by the user.
    if (name === "click" && this.disabled) return;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await Promise.all((this.listeners.get(name) || []).map((handler) => handler(event)));
    return event;
  }
}

function createPopup({ job = defaultJob, profiles = ["Kai", "Alex"], profileLabels, selectedProfile = "", respond, scrapeWait, paired = true, entries = [], permissionGranted = true } = {}) {
  const ids = ["scrape", "copyJson", "saveSheet", "openApplyUrl", "refreshConnection", "profile", "connectionStatus", "status", "duplicate", "json", "title", "company", "applyUrl", "description", "pairingSettings", "pairingLink", "deviceName", "connectServer", "queueSummary", "queueList"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element(id === "profile" ? "select" : "div")]));
  elements.profile.append(Object.assign(new Element("option", ""), { textContent: "No profile" }));
  elements.profile.disabled = true;
  elements.saveSheet.disabled = true;
  elements.duplicate.hidden = true;
  elements.openApplyUrl.classList.add("disabled");
  const document = new Element("document");
  const createdElements = [];
  document.querySelector = (selector) => {
    assert.match(selector, /^#[A-Za-z]+$/);
    assert.ok(elements[selector.slice(1)], `Unexpected popup selector: ${selector}`);
    return elements[selector.slice(1)];
  };
  document.createElement = (tag) => {
    const element = new Element(tag);
    createdElements.push(element);
    return element;
  };
  const messages = [];
  const storageWrites = [];
  const storage = { kaiFlowSelectedProfile: selectedProfile };
  const clipboard = [];
  const injected = [];
  const permissionRequests = [];
  const confirms = [];
  const runtimeListeners = [];
  const extensionId = "lomiekljcjnlhfpklnjmmhomknfigofn";
  const chrome = {
    runtime: {
      id: extensionId,
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      async sendMessage(message) {
        const copied = structuredClone(message);
        messages.push(copied);
        if (respond) {
          const response = await respond(copied, messages);
          if (response !== undefined) return response;
        }
        if (["KAI_TRACKER_STATUS", "KAI_TRACKER_CANCEL", "KAI_TRACKER_RETRY", "KAI_TRACKER_PAIR"].includes(message.type)) return { ok: true, result: { paired, connection: paired ? "connected" : "unpaired", origin: paired ? "https://kai.example.test" : "", entries, profileOptions: { profiles, profileLabels: profileLabels || {} } } };
        if (message.type === "KAI_TRACKER_OPTIONS") return { ok: true, result: { profiles, ...(profileLabels ? { profileLabels } : {}) } };
        if (message.type === "KAI_TRACKER_DUPLICATE") return { ok: true, result: { duplicate: null } };
        if (message.type === "KAI_TRACKER_SAVE") return { ok: true, result: { status: "inserted" } };
        throw new Error(`Unexpected message: ${message.type}`);
      },
    },
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { storageWrites.push(structuredClone(values)); Object.assign(storage, values); },
    } },
    tabs: {
      async query() { return [{ id: 1, url: "https://www.linkedin.com/jobs/view/123" }]; },
      async sendMessage(tabId, message) {
        assert.equal(tabId, 1);
        assert.equal(message.type, "SCRAPE_LINKEDIN_JOB");
        if (scrapeWait) await scrapeWait;
        return { ok: true, data: structuredClone(job) };
      },
    },
    scripting: { async executeScript(details) { injected.push(structuredClone(details)); } },
    permissions: { async request(value) { permissionRequests.push(structuredClone(value)); return permissionGranted; } },
  };
  const context = vm.createContext({
    document, chrome, URL, console, setTimeout, clearTimeout,
    confirm(message) { confirms.push(message); return true; },
    Option: function Option(text, value) { return Object.assign(new Element("option", value), { textContent: text }); },
    navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } },
  });
  vm.runInContext(securitySource, context, { filename: "tracker-security.js" });
  vm.runInContext(popupSource, context, { filename: "popup-kai-flow.js" });
  return {
    elements, messages, storageWrites, storage, clipboard, injected, createdElements, permissionRequests, confirms,
    async start() { await document.dispatch("DOMContentLoaded"); await settle(); },
    async click(id) { await elements[id].dispatch("click"); await settle(); },
    async select(profile) { elements.profile.value = profile; await elements.profile.dispatch("change"); await settle(); },
    async input(id, value) { elements[id].value = value; await elements[id].dispatch("input"); await settle(); },
    async notify(message, sender = { id: extensionId }) {
      runtimeListeners.forEach((listener) => listener(message, sender));
      await settle();
    },
  };
}

// DOMContentLoaded and duplicate previews deliberately start detached promises.
// Advance event-loop turns, not a guessed wall-clock timeout, before assertions.
async function settle() {
  for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve));
}

test("popup declares an optional profile and uses only the new Kai Flow entry point", () => {
  assert.match(popupHtml, /Profile \(optional\)/);
  assert.match(popupHtml, /<select id="profile"[^>]*><option value="">No profile<\/option><\/select>/);
  assert.deepEqual([...popupHtml.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1]), ["src/tracker-security.js", "src/popup-kai-flow.js"]);
  assert.doesNotMatch(popupHtml + popupSource, /8787|ngrok|script\.google\.com|sheets-server|fetch\s*\(/i);
});

test("loads live profile options and leaves the default selection empty", async () => {
  const app = createPopup({ profiles: ["Kai", "Alex", "Kai", "", null] });
  await app.start();
  assert.deepEqual(app.elements.profile.children.map((item) => [item.textContent, item.value]), [["No profile", ""], ["Kai", "Kai"], ["Alex", "Alex"]]);
  assert.equal(app.elements.profile.value, "");
  assert.equal(app.elements.profile.disabled, false);
  assert.equal(app.elements.connectionStatus.textContent, "Connected · kai.example.test");
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.equal(JSON.parse(app.elements.json.textContent).profile, "");
  assert.deepEqual(app.storageWrites, []);
});

test("preserves an optional profile selection for the shortcut and sends it with Save", async () => {
  const app = createPopup();
  await app.start();
  await app.select("Alex");
  assert.deepEqual(app.storageWrites, [{ kaiFlowSelectedProfile: "Alex" }]);
  assert.equal(JSON.parse(app.elements.json.textContent).profile, "Alex");
  await app.click("saveSheet");
  assert.deepEqual(app.messages.filter((message) => message.type === "KAI_TRACKER_SAVE"), [{ type: "KAI_TRACKER_SAVE", job: defaultJob, profile: "Alex" }]);
  assert.match(app.elements.status.textContent, /Saved to Kai Flow · Pending/);
});

test("shows friendly profile names while retaining the selected permanent key in storage, JSON and Save", async () => {
  const app = createPopup({
    profiles: ["stable-alex", "stable-jamie"],
    profileLabels: { "stable-alex": "Alex Morgan", "stable-jamie": "Jamie Taylor" },
    selectedProfile: "stable-alex"
  });
  await app.start();
  assert.deepEqual(app.elements.profile.children.map((item) => [item.textContent, item.value]), [
    ["No profile", ""], ["Alex Morgan", "stable-alex"], ["Jamie Taylor", "stable-jamie"]
  ]);
  assert.equal(app.elements.profile.value, "stable-alex");
  assert.deepEqual(app.storageWrites, [], "rendering a display label must not rewrite the assignment");
  await app.select("stable-jamie");
  assert.deepEqual(app.storageWrites, [{ kaiFlowSelectedProfile: "stable-jamie" }]);
  assert.equal(JSON.parse(app.elements.json.textContent).profile, "stable-jamie");
  await app.click("saveSheet");
  assert.equal(app.messages.find((message) => message.type === "KAI_TRACKER_SAVE").profile, "stable-jamie");
});

test("an authenticated profile-change notification refreshes labels without changing the saved key", async () => {
  let reads = 0;
  const app = createPopup({
    selectedProfile: "stable-alex",
    respond(message) {
      if (message.type !== "KAI_TRACKER_OPTIONS") return undefined;
      reads += 1;
      return { ok: true, result: {
        profiles: reads === 1 ? ["stable-alex"] : ["stable-jamie", "stable-alex"],
        profileLabels: { "stable-alex": reads === 1 ? "Alex" : "Alex Morgan", "stable-jamie": "Jamie Taylor" }
      } };
    }
  });
  await app.start();
  await app.notify({ type: "KAI_TRACKER_PROFILES_CHANGED" }, { id: "another-extension" });
  await app.notify({ type: "UNRELATED_MESSAGE" });
  assert.equal(reads, 1, "foreign and unrelated notifications are ignored");
  await app.notify({ type: "KAI_TRACKER_PROFILES_CHANGED" });
  assert.equal(reads, 2);
  assert.deepEqual(app.messages.filter((message) => message.type === "KAI_TRACKER_OPTIONS").at(-1), { type: "KAI_TRACKER_OPTIONS", refresh: true });
  assert.deepEqual(app.elements.profile.children.map((item) => [item.textContent, item.value]), [
    ["No profile", ""], ["Jamie Taylor", "stable-jamie"], ["Alex Morgan", "stable-alex"]
  ]);
  assert.equal(app.elements.profile.value, "stable-alex");
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.deepEqual(app.storageWrites, []);
});

test("a newly deactivated selected profile remains unassigned to any replacement after a live refresh", async () => {
  let reads = 0;
  const app = createPopup({
    selectedProfile: "stable-alex",
    respond(message) {
      if (message.type !== "KAI_TRACKER_OPTIONS") return undefined;
      return { ok: true, result: { profiles: ++reads === 1 ? ["stable-alex"] : ["stable-jamie"], profileLabels: { "stable-alex": "Alex Morgan", "stable-jamie": "Jamie Taylor" } } };
    }
  });
  await app.start();
  await app.notify({ type: "KAI_TRACKER_PROFILES_CHANGED" });
  assert.equal(app.elements.profile.value, "stable-alex");
  assert.equal(app.elements.saveSheet.disabled, true);
  assert.match(app.elements.status.textContent, /saved profile is unavailable/);
  assert.deepEqual(app.storageWrites, []);
  await app.click("saveSheet");
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_SAVE"), false);
});

test("Save sends no profile when the user leaves the optional field blank", async () => {
  const app = createPopup();
  await app.start();
  await app.click("saveSheet");
  assert.equal(app.messages.find((message) => message.type === "KAI_TRACKER_SAVE").profile, "");
});

test("restores a valid saved profile without assigning the first live option", async () => {
  const app = createPopup({ selectedProfile: "Alex" });
  await app.start();
  assert.equal(app.elements.profile.value, "Alex");
  assert.equal(app.elements.saveSheet.disabled, false);
});

test("a stale saved profile remains visible and invalid until explicitly changed", async () => {
  const app = createPopup({ selectedProfile: "Retired Candidate" });
  await app.start();
  assert.equal(app.elements.profile.value, "Retired Candidate");
  assert.match(app.elements.profile.children.at(-1).textContent, /Retired Candidate — unavailable/);
  assert.equal(app.elements.saveSheet.disabled, true);
  await app.click("saveSheet");
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_SAVE"), false);
  assert.deepEqual(app.storageWrites, []);
  await app.select("");
  assert.equal(app.elements.saveSheet.disabled, false);
  await app.click("saveSheet");
  assert.equal(app.messages.find((message) => message.type === "KAI_TRACKER_SAVE").profile, "");
});

test("a slower scrape cannot replace a stale-profile warning with ready-to-save feedback", async () => {
  let releaseScrape;
  const scrapeWait = new Promise((resolve) => { releaseScrape = resolve; });
  const app = createPopup({ selectedProfile: "Retired Candidate", scrapeWait });
  await app.start();
  assert.equal(app.elements.connectionStatus.textContent, "Connected · kai.example.test");
  assert.equal(app.elements.title.value, "");
  assert.match(app.elements.status.textContent, /saved profile is unavailable/);
  releaseScrape();
  await settle();
  assert.equal(app.elements.title.value, defaultJob.title);
  assert.equal(app.elements.profile.value, "Retired Candidate");
  assert.equal(app.elements.saveSheet.disabled, true);
  assert.match(app.elements.status.textContent, /saved profile is unavailable/);
  assert.doesNotMatch(app.elements.status.textContent, /Ready to save/);
});

test("a server-side duplicate blocks Save and renders only safe job summary text", async () => {
  const duplicate = {
    company: '<img src=x onerror="throw Error()">',
    jobTitle: "<script>alert('title')</script>",
    jobDescriptionPreview: "<svg onload=alert('description')>Preview</svg>",
    status: "added",
  };
  const app = createPopup({ respond(message) {
    if (message.type === "KAI_TRACKER_SAVE") return { ok: false, error: { code: "DUPLICATE_COMPANY", message: "Duplicate", details: { duplicate } } };
  } });
  await app.start();
  await app.click("saveSheet");
  assert.equal(app.elements.duplicate.hidden, false);
  assert.deepEqual(app.elements.duplicate.children.map((item) => item.tagName), ["STRONG", "SPAN", "SPAN", "P"]);
  assert.equal(app.elements.duplicate.children[1].textContent, `${duplicate.company} · ${duplicate.jobTitle}`);
  assert.equal(app.elements.duplicate.children[2].textContent, "Pending");
  assert.equal(app.elements.duplicate.children[3].textContent, duplicate.jobDescriptionPreview);
  assert.equal(app.createdElements.some((element) => ["IMG", "SCRIPT", "SVG"].includes(element.tagName)), false);
  assert.equal(app.elements.saveSheet.disabled, true);
  assert.match(app.elements.status.textContent, /Nothing was added/);
});

test("a live duplicate preview prevents Save before submission", async () => {
  const app = createPopup({ respond(message) {
    if (message.type === "KAI_TRACKER_DUPLICATE") return { ok: true, result: { duplicate: { company: "Example Company", jobTitle: "Previous role", status: "applied", jobDescriptionPreview: "Existing job" } } };
  } });
  await app.start();
  assert.equal(app.elements.duplicate.hidden, false);
  assert.match(app.elements.duplicate.textContent, /Previous role/);
  assert.equal(app.elements.saveSheet.disabled, true);
  await app.click("saveSheet");
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_SAVE"), false);
});

test("no duplicate match shows no warning or no-match message", async () => {
  const app = createPopup();
  await app.start();
  assert.ok(app.messages.some((message) => message.type === "KAI_TRACKER_DUPLICATE"));
  assert.equal(app.elements.duplicate.hidden, true);
  assert.equal(app.elements.duplicate.textContent, "");
  assert.doesNotMatch(app.elements.status.textContent, /no.*(?:duplicate|match)|reviewed.or.later/i);
});

for (const missing of ["title", "description", "company"]) {
  test(`missing ${missing} prevents Save`, async () => {
    const app = createPopup({ job: { ...defaultJob, [missing]: "  " } });
    await app.start();
    assert.equal(app.elements.saveSheet.disabled, true);
    assert.match(app.elements.status.textContent, new RegExp(`Missing ${missing}`));
    await app.click("saveSheet");
    assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_SAVE"), false);
  });
}

test("a paired but offline connection allows durable Queue save and refreshes live options", async () => {
  let available = false;
  const app = createPopup({ respond(message) {
    if (message.type === "KAI_TRACKER_OPTIONS" && !available) return { ok: false, error: { code: "TRACKER_UNAVAILABLE", message: "Start Kai Flow first." } };
  } });
  await app.start();
  assert.match(app.elements.connectionStatus.textContent, /Server unavailable/);
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.equal(app.elements.saveSheet.textContent, "Queue save");
  assert.equal(app.elements.profile.disabled, false);
  await app.click("saveSheet");
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_SAVE"), true);
  available = true;
  await app.click("refreshConnection");
  assert.ok(app.messages.some((message) => message.type === "KAI_TRACKER_OPTIONS" && message.refresh === true));
  assert.equal(app.elements.saveSheet.disabled, false);
});

test("unpaired tracker asks for pairing instead of asking to start a local server", async () => {
  const app = createPopup({ paired: false });
  await app.start();
  assert.equal(app.elements.pairingSettings.open, true);
  assert.equal(app.elements.saveSheet.disabled, true);
  assert.match(app.elements.connectionStatus.textContent, /pairing link/);
  assert.equal(app.messages.some((message) => message.type === "KAI_TRACKER_OPTIONS"), false);
  assert.doesNotMatch(popupSource, /Start Kai Flow on this|127\.0\.0\.1|ws:\/\//);
});

test("Connect requests only the user-selected HTTPS origin and clears the one-use link", async () => {
  const app = createPopup(); await app.start();
  app.elements.pairingLink.value = "https://kai.example.test/#tracker-pair=kfp_01234567890123456789012345678901";
  app.elements.deviceName.value = "AdsPower tracker";
  await app.click("connectServer");
  assert.deepEqual(app.permissionRequests, [{ origins: ["https://kai.example.test/*"] }]);
  const pairing = app.messages.find((message) => message.type === "KAI_TRACKER_PAIR");
  assert.equal(pairing.deviceName, "AdsPower tracker");
  assert.match(pairing.link, /#tracker-pair=kfp_/);
  assert.equal(app.elements.pairingLink.value, "");
});

test("refusing permission or entering a local link sends no pairing request", async () => {
  const denied = createPopup({ permissionGranted: false }); await denied.start();
  denied.elements.pairingLink.value = "https://kai.example.test/#tracker-pair=kfp_01234567890123456789012345678901";
  await denied.click("connectServer");
  assert.equal(denied.messages.some((message) => message.type === "KAI_TRACKER_PAIR"), false);
  const local = createPopup(); await local.start();
  local.elements.pairingLink.value = "https://127.0.0.1/#tracker-pair=kfp_01234567890123456789012345678901";
  await local.click("connectServer");
  assert.equal(local.permissionRequests.length, 0);
  assert.equal(local.messages.some((message) => message.type === "KAI_TRACKER_PAIR"), false);
});

test("company edits are debounced and latest text is submitted with title/description edits", async () => {
  const app = createPopup(); await app.start();
  const initial = app.messages.filter((message) => message.type === "KAI_TRACKER_DUPLICATE").length;
  await app.input("company", "New");
  await app.input("company", "New Company");
  await app.input("title", "Edited title");
  await app.input("description", "Edited job description");
  assert.equal(app.messages.filter((message) => message.type === "KAI_TRACKER_DUPLICATE").length, initial);
  await new Promise((resolve) => setTimeout(resolve, 380));
  const previews = app.messages.filter((message) => message.type === "KAI_TRACKER_DUPLICATE");
  assert.equal(previews.length, initial + 1);
  assert.equal(previews.at(-1).company, "New Company");
  await app.click("saveSheet");
  const saved = app.messages.find((message) => message.type === "KAI_TRACKER_SAVE");
  assert.equal(saved.job.title, "Edited title");
  assert.equal(saved.job.company, "New Company");
  assert.equal(saved.job.description, "Edited job description");
});

test("queue displays connection isolation and cancellation explains possible prior save", async () => {
  const entries = [{ requestId: "request-1", company: defaultJob.company, jobTitle: defaultJob.title, state: "retry", connectionMatches: false, origin: "https://old.example.test", mayHaveSaved: true, updatedAt: 10 }];
  const app = createPopup({ entries }); await app.start();
  assert.match(app.elements.queueList.textContent, /earlier connection/);
  assert.match(app.elements.queueList.textContent, /Not transferred/);
  const button = app.elements.queueList.children[0].children.find((child) => child.tagName === "BUTTON");
  await button.dispatch("click");
  assert.match(app.confirms[0], /may already have reached Kai Flow/);
  assert.match(app.confirms[0], /will not remove a saved job/);
  assert.deepEqual(app.messages.find((message) => message.type === "KAI_TRACKER_CANCEL"), { type: "KAI_TRACKER_CANCEL", requestId: "request-1" });
});

test("pending same-company request blocks another Save and appears in the queue", async () => {
  const entries = [{ requestId: "request-1", company: defaultJob.company, jobTitle: defaultJob.title, state: "retry", connectionMatches: true, origin: "https://kai.example.test", mayHaveSaved: true, updatedAt: 10 }];
  const app = createPopup({ entries }); await app.start();
  assert.equal(app.elements.saveSheet.disabled, true);
  assert.equal(app.elements.saveSheet.textContent, "In queue");
  assert.match(app.elements.queueSummary.textContent, /1 waiting/);
});

test("popup width is fixed and Save remains outside scrolling content", () => {
  const css = fs.readFileSync(path.join(root, "popup.css"), "utf8");
  assert.match(css, /min-width:\s*420px/);
  assert.doesNotMatch(css, /max-width:\s*100vw/);
  assert.match(css, /\.scroll-content\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(popupHtml, /<\/div>\s*<section class="actions">/);
});

test("every active queue entry remains cancellable when an outage queues more than 30 jobs", async () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({ requestId: `request-${index}`, company: `Company ${index}`, jobTitle: "Role", state: "retry", connectionMatches: true, origin: "https://kai.example.test", mayHaveSaved: true, updatedAt: index }));
  const app = createPopup({ entries }); await app.start();
  assert.equal(app.elements.queueList.children.length, 60);
  assert.ok(app.elements.queueList.children.every((item) => item.children.some((child) => child.tagName === "BUTTON")));
});

for (const code of ["TRACKER_SAVE_UNCERTAIN", "KAI_FLOW_SAVE_UNCONFIRMED"]) {
  test(`${code} offers Check save and retries exactly the same payload`, async () => {
    let saveCount = 0;
    const app = createPopup({ respond(message) {
      if (message.type !== "KAI_TRACKER_SAVE") return;
      saveCount++;
      if (saveCount === 1) return { ok: false, error: { code, message: "Save was not confirmed. Check the previous save." } };
      return { ok: true, result: { replayed: true } };
    } });
    await app.start();
    await app.select("Kai");
    await app.click("saveSheet");
    assert.equal(app.elements.saveSheet.textContent, "Check save");
    assert.equal(app.elements.saveSheet.disabled, false);
    assert.match(app.elements.status.textContent, /not confirmed/);
    await app.click("saveSheet");
    const saves = app.messages.filter((message) => message.type === "KAI_TRACKER_SAVE");
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1], saves[0]);
    assert.equal(app.elements.saveSheet.textContent, "Save");
    assert.match(app.elements.status.textContent, /Already saved.*No duplicate was created/);
  });
}

test("a lost extension response also leaves an ambiguous save checkable", async () => {
  const app = createPopup({ respond(message) {
    if (message.type === "KAI_TRACKER_SAVE") throw new Error("The message port closed.");
  } });
  await app.start();
  await app.click("saveSheet");
  assert.equal(app.elements.saveSheet.textContent, "Check save");
  assert.equal(app.elements.saveSheet.disabled, false);
  assert.match(app.elements.status.textContent, /could not confirm/);
});
