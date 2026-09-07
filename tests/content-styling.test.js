const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const CONTENT = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");

class FakeCard {
  constructor(company, title, { modern = false } = {}) {
    this.company = company;
    this.title = title;
    this.modern = modern;
    this.attributes = new Map();
    this.titleParagraph = { innerText: title, textContent: `${title}${title}` };
    this.companyParagraph = { innerText: company, textContent: company };
    this.locationParagraph = { innerText: "United States (Remote)", textContent: "United States (Remote)" };
    this.titleSpan = {
      innerText: title,
      textContent: title,
      closest: (selector) => selector === "p" ? this.titleParagraph : null
    };
  }

  contains() { return false; }

  querySelector(selector) {
    if (!this.modern && selector === "[data-test-job-card-company-name]") {
      return { innerText: this.company };
    }
    if (!this.modern && selector === ".job-card-list__title--link") {
      return { innerText: this.title };
    }
    if (this.modern && selector === "p span[aria-hidden='true']") return this.titleSpan;
    return null;
  }

  querySelectorAll(selector) {
    return this.modern && selector === "p"
      ? [this.titleParagraph, this.companyParagraph, this.locationParagraph]
      : [];
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("LinkedIn cards give duplicates and banned companies the same visible treatment", async () => {
  const duplicate = new FakeCard("Acme", "Platform Engineer", { modern: true });
  const banned = new FakeCard("Blocked Co", "Backend Engineer", { modern: true });
  const cards = [duplicate, banned];
  let installedCss = "";
  const listeners = [];
  const classifications = [];
  let intervalCallback = null;
  const document = {
    documentElement: { append(element) { installedCss = element.textContent || ""; } },
    head: { append(element) { installedCss = element.textContent || ""; } },
    querySelector(selector) {
      return selector === "#kai-flow-linkedin-job-styles" && installedCss ? {} : null;
    },
    querySelectorAll() { return cards; },
    createElement() { return { id: "", textContent: "" }; }
  };
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendMessage(message) {
        classifications.push(message);
        assert.equal(message.type, "KAI_TRACKER_CLASSIFY_COMPANIES");
        assert.deepEqual([...message.companies].sort(), ["Acme", "Blocked Co"]);
        return {
          ok: true,
          result: {
            companies: [
              { company: "Acme", banned: false, duplicate: { status: "tailored" } },
              { company: "Blocked Co", banned: true, duplicate: null }
            ]
          }
        };
      }
    }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
  }
  const window = { location: { href: "https://www.linkedin.com/jobs/search-results/" } };
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    window,
    document,
    chrome,
    MutationObserver,
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { intervalCallback = callback; return 1; },
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      queueMicrotask(() => {
        if (!timers.has(id)) return;
        timers.delete(id);
        callback();
      });
      return id;
    },
    URL,
    console
  });

  vm.runInContext(CONTENT, context, { filename: "src/content.js" });
  await settle();

  assert.equal(listeners.length, 1);
  assert.equal(classifications[0].refresh, false,
    "the initial classification must reuse the shared background snapshot");
  intervalCallback();
  await settle();
  assert.equal(classifications.at(-1).refresh, false,
    "each LinkedIn tab must not force its own Google Sheet refresh");
  assert.match(CONTENT, /\[role='button'\]\[componentkey\^='job-card-component-ref-'\]/u,
    "the current generated-class LinkedIn card structure must be discovered by its stable component marker");
  assert.equal(duplicate.getAttribute("data-kai-flow-job-state"), "duplicate");
  assert.equal(banned.getAttribute("data-kai-flow-job-state"), "banned");
  assert.match(installedCss, /\[data-kai-flow-job-state\]\s*>\s*\*/u,
    "the original LinkedIn card contents receive the dismissed-job treatment");
  assert.match(installedCss, /opacity:\s*\.3/u);
  assert.doesNotMatch(installedCss, /Already tracked|Banned company|::after|outline:|box-shadow:/u,
    "styling must not add labels, decorations, or layout-changing content");
  assert.equal(duplicate.getAttribute("data-kai-flow-job-label"), null);
  assert.equal(banned.getAttribute("data-kai-flow-job-label"), null);
  assert.doesNotMatch(installedCss, /data-kai-flow-job-state=["'](?:duplicate|banned)/u,
    "one shared state selector keeps duplicate and banned cards visually identical");
});
