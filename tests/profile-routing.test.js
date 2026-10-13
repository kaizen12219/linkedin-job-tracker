const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const Routing = require("../src/profile-routing.js");
const options = { profiles: ["kevin", "jagjeet", "jose-ibero-1page", "michal-stefanow-1page"] };
const duties = "Design and implement reliable software features within the existing architecture.";
const job = { title: "Software Engineer", description: duties, selectedRegion: "us" };

test("the committed country filter wins over job location or an edited search input", () => {
  for (const [id, region] of [["100876405", "colombia"], ["101165590", "uk"], ["103644278", "us"]]) {
    const url = `https://www.linkedin.com/jobs/search/?geoId=${id}&location=Other`;
    assert.equal(Routing.selectedRegion({ querySelector() { return { value: "LATAM" }; } }, url), region);
  }
  assert.equal(Routing.regionFromUrl("https://www.linkedin.com/jobs/search/?location=Latin%20America"), "latam");
  assert.equal(Routing.selectedRegion({ querySelector() { return { value: "Latin America" }; } }, "https://www.linkedin.com/jobs/search-results/?geoId=999"), "latam");
  assert.equal(Routing.selectedRegion({ querySelector() { return { value: "Colombia" }; } }, "https://www.linkedin.com/jobs/search/?geoId=100876405,103644278"), "");
  assert.equal(Routing.snapshot({ ...job, sourceUrl: "https://www.linkedin.com/jobs/search/?geoId=100876405,103644278" }, options), null);
  assert.equal(Routing.selectedRegion({ querySelector() { return { value: "United States" }; } }, "https://www.linkedin.com/jobs/view/123"), "");
  assert.equal(Routing.regionFromUrl("https://other.example/jobs/search/?geoId=103644278"), "");
});

test("regional routing resolves real Kai option values, including aliases and labels", () => {
  for (const [region, profile] of [["colombia", "jose-ibero-1page"], ["latam", "jose-ibero-1page"], ["uk", "michal-stefanow-1page"]]) {
    const target = { ...job, selectedRegion: region };
    assert.equal(Routing.choose(target, Routing.snapshot(target, options)).profile, profile);
  }
  const labels = { profiles: ["a", "b"], profileLabels: { a: "Kevin Lee", b: "Jagjeet Wani" } };
  assert.equal(Routing.snapshot(job, labels).profiles.kevin, "a");
  assert.equal(Routing.snapshot(job, { profiles: ["kevin", "kevin-lee-1page", "jagjeet"] }).profiles.kevin, "kevin-lee-1page");
  assert.equal(Routing.snapshot(job, { profiles: ["kevin", "kevin-lee-1page", "kevin-lee-2page", "jagjeet"] }).profiles.kevin, "kevin-lee-2page");
  assert.throws(() => Routing.snapshot(job, { profiles: ["kevin"] }), /Jagjeet Wani is unavailable/);
  assert.throws(() => Routing.snapshot(job, { profiles: ["a", "b", "jagjeet"], profileLabels: { a: "Kevin Lee", b: "Kevin Lee" } }), /more than one/);
  assert.equal(Routing.snapshot({ ...job, selectedRegion: "Canada" }, options), null);
});

test("required experience wins over title, including ranges and the exact five-year boundary", () => {
  const cases = [[0, "0 to 5", "jagjeet"], [3, "3–5", "jagjeet"], [4, "4–7", "jagjeet"], [5, "5+", "kevin"], [6, "six or more", "kevin"]];
  for (const [minimumYears, wording, profile] of cases) {
    const evidence = `Requires ${wording} years of professional software engineering experience.`;
    const target = { ...job, title: minimumYears < 5 ? "Senior Software Engineer" : "Software Engineer", description: `${duties} ${evidence}` };
    assert.equal(Routing.choose(target, Routing.snapshot(target, options), { minimumYears, evidence, scope: "senior" }).profile, profile);
    assert.equal(Object.hasOwn(Routing.choose(target, Routing.snapshot(target, options), { minimumYears, evidence, scope: "senior" }), "trashed"), false);
  }
});

test("the visible search-country dropdown wins over stale URL state and never reads a job's location", (t) => {
  const dom = new JSDOM(`<header><button>Jobs</button><button>United Kingdom</button><input id="jobs-search-box-location-id" value="United States"></header>
    <main><li data-occludable-job-id="123"><button>Colombia</button></li><div class="jobs-details"><button>United States</button></div></main>
    <div role="listbox"><button>LATAM</button></div><button hidden>United States</button>`);
  t.after(() => dom.window.close());
  const sourceUrl = "https://www.linkedin.com/jobs/search/?geoId=103644278";
  const selected = Routing.selectedSearchRegion(dom.window.document, sourceUrl);
  assert.deepEqual(selected, { region: "uk", source: "search-control" });
  const target = { ...job, sourceUrl, selectedRegion: selected.region, selectedRegionSource: selected.source };
  assert.equal(Routing.choose(target, Routing.snapshot(target, options)).profile, "michal-stefanow-1page");
  dom.window.document.querySelector("header button:nth-child(2)").textContent = "LATAM";
  assert.equal(Routing.selectedRegion(dom.window.document, sourceUrl), "latam");
  dom.window.document.querySelector("header button:nth-child(2)").textContent = "Colombia";
  assert.equal(Routing.selectedRegion(dom.window.document, sourceUrl), "colombia");
  dom.window.document.querySelector("header button:nth-child(2)").setAttribute("aria-label", "Location: Canada");
  dom.window.document.querySelector("header button:nth-child(2)").textContent = "Canada";
  const other = Routing.selectedSearchRegion(dom.window.document, sourceUrl);
  assert.deepEqual(other, { region: "", source: "search-control" });
  assert.equal(Routing.snapshot({ ...target, selectedRegion: other.region }, options), null);
});

test("only absent required years enables the seniority fallback", () => {
  for (const [title, scope, profile] of [["Senior Software Engineer", "ordinary", "kevin"], ["Senior Software Engineer", "senior", "kevin"], ["Software Engineer", "senior", "kevin"], ["Software Engineer", "ordinary", "jagjeet"]]) {
    const target = { ...job, title };
    assert.equal(Routing.choose(target, Routing.snapshot(target, options), { minimumYears: null, scope, evidence: duties }).profile, profile);
  }
});

test("missing or fabricated analysis cannot choose a US profile", () => {
  const target = { ...job, description: `${duties} Requires 3–5 years of software engineering experience.` };
  const routing = Routing.snapshot(target, options);
  for (const analysis of [undefined, { minimumYears: 3, evidence: "Invented requirement", scope: "ordinary" },
    { minimumYears: 5, evidence: "Requires 3–5 years of software engineering experience.", scope: "senior" },
    { minimumYears: null, evidence: duties, scope: "unknown" }]) {
    assert.throws(() => Routing.choose(target, routing, analysis), /could not be confirmed/);
  }
});
