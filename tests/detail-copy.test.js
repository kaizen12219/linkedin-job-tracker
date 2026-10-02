const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "../src/detail-copy.js"), "utf8");
const scraper = fs.readFileSync(path.join(__dirname, "../src/scraper.js"), "utf8");
const fixture = `<main>
  <li data-occludable-job-id="1"><a href="/jobs/view/1">Search card title</a><a href="/company/list">Search company</a></li>
  <section data-sdui-screen="SemanticJobDetails">
    <header><a href="/company/doit"><img alt="DoiT logo"></a><a id="company" href="/company/doit"><span>DoiT</span></a>
      <h1><a href="/jobs/view/123">Senior Full-Stack Engineer - AI<br>Cost Visibility</a><svg><title>Verified</title></svg><span class="visually-hidden">Verified job</span></h1>
      <button>Easy Apply</button>
    </header>
    <section><a href="/company/other">Unrelated company</a></section>
  </section>
</main>`;

function setup(t, html = fixture) {
  const dom = new JSDOM(html, { url: "https://www.linkedin.com/jobs/view/123/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { copied.push(value); } } });
  window.eval(source);
  return {
    window, document: window.document, copied,
    click(node, options = {}) { return node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...options })); },
    settle: () => new Promise((resolve) => window.setTimeout(resolve, 15))
  };
}

test("title and company copy separately, without badges or navigating their links", async (t) => {
  const app = setup(t);
  const title = app.document.querySelector("h1");
  const company = app.document.querySelector("#company");
  let pageClicks = 0;
  title.addEventListener("click", () => pageClicks++);
  assert.equal(app.click(title.querySelector("a")), false);
  await app.settle();
  assert.deepEqual(app.copied, ["Senior Full-Stack Engineer - AI Cost Visibility"]);
  assert.equal(app.document.querySelector("[role=status]").textContent, "Job title copied");
  assert.equal(pageClicks, 0);
  app.click(company.querySelector("span"));
  await app.settle();
  assert.equal(app.copied.at(-1), "DoiT");
  assert.equal(app.document.querySelector("[role=status]").textContent, "Company name copied");
  assert.equal(title.getAttribute("title"), "Click to copy job title");
});

test("scraping for Save returns the company name while click-copy remains enabled", async (t) => {
  const app = setup(t);
  app.window.eval(scraper);
  assert.equal(app.window.LinkedInJobScraper.scrape(app.document).company, "DoiT");
  app.click(app.document.querySelector("#company"));
  await app.settle();
  assert.equal(app.copied.at(-1), "DoiT");
  assert.equal(app.window.LinkedInJobScraper.scrape(app.document).company, "DoiT");
  app.document.querySelector("#company span").textContent = "New Company";
  await app.settle();
  assert.equal(app.window.LinkedInJobScraper.scrape(app.document).company, "New Company");
  app.click(app.document.querySelector("#company"));
  await app.settle();
  assert.equal(app.copied.at(-1), "New Company");
});

test("scraping ignores leftover copy hints while preserving real company metadata fallbacks", (t) => {
  const app = setup(t);
  app.window.eval(scraper);
  const company = app.document.querySelector("#company");
  company.removeAttribute("data-kai-copy-field");
  assert.equal(app.window.LinkedInJobScraper.scrape(app.document).company, "DoiT");
  company.innerHTML = "";
  company.setAttribute("title", "DoiT");
  assert.equal(app.window.LinkedInJobScraper.scrape(app.document).company, "DoiT");
});

test("legacy detail headers support Enter and Space copying", async (t) => {
  const app = setup(t, `<main><div class="jobs-search__job-details--container"><div class="job-details-jobs-unified-top-card__company-name">Acme</div><div class="job-details-jobs-unified-top-card__job-title"><h2>Engineer</h2></div></div></main>`);
  for (const [field, key] of [["title", "Enter"], ["company", " "]]) {
    const node = app.document.querySelector(`[data-kai-copy-field=${field}]`);
    assert.equal(node.getAttribute("role"), "button");
    assert.equal(node.getAttribute("tabindex"), "0");
    assert.equal(node.dispatchEvent(new app.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })), false);
  }
  await app.settle();
  assert.deepEqual(app.copied, ["Engineer", "Acme"]);
});

test("generated-class headers with linked titles are detected without changing search links", async (t) => {
  const app = setup(t, fixture.replace('<h1>', '<h2 class="generated-title">').replace('</h1>', '</h2>'));
  const titleLink = app.document.querySelector("h2 a");
  assert.equal(titleLink.getAttribute("data-kai-copy-field"), "title");
  app.click(titleLink);
  await app.settle();
  assert.deepEqual(app.copied, ["Senior Full-Stack Engineer - AI Cost Visibility"]);
  assert.equal(app.document.querySelector("li a").hasAttribute("data-kai-copy-field"), false);
});

test("job changes copy the latest details and newly rendered headers work", async (t) => {
  const app = setup(t);
  app.document.querySelector("header").innerHTML = '<a id="new-company" href="/company/new">New Company</a><h1>New Role</h1>';
  await app.settle();
  app.click(app.document.querySelector("h1"));
  app.click(app.document.querySelector("#new-company"));
  await app.settle();
  assert.deepEqual(app.copied, ["New Role", "New Company"]);
});

test("search cards and unrelated controls retain their click behavior", async (t) => {
  const app = setup(t);
  const nodes = [app.document.querySelector("li a"), app.document.querySelector("button"), app.document.querySelector("a[href='/company/other']")];
  let pageClicks = 0;
  for (const node of nodes) {
    node.addEventListener("click", (event) => { pageClicks++; event.preventDefault(); });
    app.click(node);
    assert.equal(node.closest("[data-kai-copy-field]"), null);
  }
  assert.equal(pageClicks, 3);
  assert.deepEqual(app.copied, []);
  assert.doesNotMatch(app.document.querySelector("style").textContent, /opacity|data-kai-flow-job-state/);
});

test("modified link clicks remain available and do not copy", async (t) => {
  const app = setup(t);
  const node = app.document.querySelector("#company");
  let received = 0;
  node.addEventListener("click", (event) => { received++; event.preventDefault(); });
  for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) app.click(node, { [key]: true });
  assert.equal(received, 4);
  assert.deepEqual(app.copied, []);
});

test("clipboard rejection falls back and reports failure when both methods fail", async (t) => {
  const app = setup(t);
  app.window.navigator.clipboard.writeText = async () => { throw new Error("Denied"); };
  app.document.execCommand = () => false;
  app.click(app.document.querySelector("#company"));
  await app.settle();
  assert.match(app.document.querySelector("[role=status]").textContent, /Could not copy/);
  assert.equal(app.document.querySelector("textarea"), null);
  app.document.execCommand = (command) => {
    assert.equal(command, "copy");
    assert.equal(app.document.querySelector("textarea").value, "DoiT");
    return true;
  };
  app.click(app.document.querySelector("#company"));
  await app.settle();
  assert.equal(app.document.querySelector("[role=status]").textContent, "Company name copied");
});

test("reinjecting does not duplicate clipboard writes or styling", async (t) => {
  const app = setup(t);
  app.window.eval(source);
  app.click(app.document.querySelector("#company"));
  await app.settle();
  assert.deepEqual(app.copied, ["DoiT"]);
  assert.equal(app.document.querySelectorAll("style").length, 1);
});
