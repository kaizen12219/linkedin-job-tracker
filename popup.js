const scrapeButton = document.querySelector("#scrape");
const copyJsonButton = document.querySelector("#copyJson");
const saveSheetButton = document.querySelector("#saveSheet");
const openApplyUrlLink = document.querySelector("#openApplyUrl");
const sheetTabSelect = document.querySelector("#sheetTab");
const refreshTabsButton = document.querySelector("#refreshTabs");
const statusEl = document.querySelector("#status");
const SHEETS_BRIDGE_BASE_URL = "https://plank-undergo-sandbag.ngrok-free.dev";
const SHEETS_BRIDGE_HEADERS = {
  "ngrok-skip-browser-warning": "true"
};
const SHEETS_BRIDGE_URL = `${SHEETS_BRIDGE_BASE_URL}/jobs`;
const SHEET_TABS_URL = `${SHEETS_BRIDGE_BASE_URL}/tabs`;
const SHEET_TABS_CACHE_KEY = "sheetTabsCache";
const fields = {
  title: document.querySelector("#title"),
  company: document.querySelector("#company"),
  applyUrl: document.querySelector("#applyUrl"),
  description: document.querySelector("#description")
};
const jsonEl = document.querySelector("#json");

let latestPayload = null;
let sheetTabs = [];

document.addEventListener("DOMContentLoaded", () => {
  loadSheetTabs();
  scrapeCurrentTab();
});

scrapeButton.addEventListener("click", () => {
  scrapeCurrentTab();
});

refreshTabsButton.addEventListener("click", () => {
  loadSheetTabs({ forceRefresh: true });
});

sheetTabSelect.addEventListener("change", async () => {
  const selectedTab = getSelectedSheetTab();

  if (selectedTab) {
    await chrome.storage.local.set({
      selectedSheetGid: selectedTab.sheetId,
      selectedSheetTitle: selectedTab.title
    });
  }

  setSaveEnabled(Boolean(latestPayload && selectedTab));
});

copyJsonButton.addEventListener("click", async () => {
  if (!latestPayload) {
    return;
  }

  await navigator.clipboard.writeText(JSON.stringify(latestPayload, null, 2));
  setStatus("Copied JSON to clipboard.");
});

saveSheetButton.addEventListener("click", async () => {
  if (!latestPayload) {
    return;
  }

  if (!getSelectedSheetGid()) {
    setStatus("Select a destination tab before saving.");
    return;
  }

  saveSheetButton.disabled = true;
  setStatus("Saving to Google Sheet...");

  try {
    const response = await fetch(SHEETS_BRIDGE_URL, {
      method: "POST",
      headers: {
        ...SHEETS_BRIDGE_HEADERS,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...latestPayload,
        targetSheetGid: getSelectedSheetGid()
      })
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Sheets bridge returned HTTP ${response.status}.`);
    }

    if (result.status === "duplicate") {
      setStatus(result.message || `Skipped because ${latestPayload.company} already exists.`);
      return;
    }

    setStatus(`Saved to "${result.sheetTitle}"${result.updatedRange ? ` (${result.updatedRange})` : ""}.`);
  } catch (error) {
    setStatus(`Could not save. Start the local Sheets bridge, then try again. ${error.message}`);
  } finally {
    setSaveEnabled(Boolean(latestPayload && getSelectedSheetGid()));
  }
});

openApplyUrlLink.addEventListener("click", (event) => {
  if (openApplyUrlLink.classList.contains("disabled")) {
    event.preventDefault();
  }
});

async function scrapeCurrentTab() {
  setStatus("Scraping active tab...");
  setBusy(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    if (!isSupportedUrl(tab.url || "")) {
      throw new Error("Open a LinkedIn job page before scraping.");
    }

    const response = await requestScrape(tab.id);

    if (!response?.ok) {
      throw new Error(response?.error || "The scraper did not return data.");
    }

    renderResult(response.data);
  } catch (error) {
    latestPayload = null;
    clearResult();
    setStatus(error.message);
    setCopyEnabled(false);
  } finally {
    setBusy(false);
  }
}

async function loadSheetTabs({ forceRefresh = false } = {}) {
  refreshTabsButton.disabled = true;
  sheetTabSelect.disabled = true;

  if (!forceRefresh) {
    const cachedTabs = await getCachedSheetTabs();

    if (cachedTabs) {
      await applySheetTabs(cachedTabs);
      refreshTabsButton.disabled = false;
      return;
    }
  }

  if (!sheetTabs.length) {
    renderSheetTabs([], "");
  }

  try {
    const response = await fetch(SHEET_TABS_URL, {
      headers: SHEETS_BRIDGE_HEADERS
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Sheets bridge returned HTTP ${response.status}.`);
    }

    const nextSheetTabs = {
      defaultSheetId: result.defaultSheetId || "",
      sheets: result.sheets || []
    };

    if (!nextSheetTabs.sheets.length) {
      throw new Error("No tabs were returned by the Sheets bridge.");
    }

    await cacheSheetTabs(nextSheetTabs);
    await applySheetTabs(nextSheetTabs);
  } catch (error) {
    if (!sheetTabs.length) {
      renderSheetTabs([], "");
      setSaveEnabled(false);
    } else {
      setSaveEnabled(Boolean(latestPayload && getSelectedSheetGid()));
    }

    setStatus(`Could not load sheet tabs. Start the local Sheets bridge, then refresh tabs. ${error.message}`);
  } finally {
    refreshTabsButton.disabled = false;
  }
}

async function applySheetTabs(tabPayload) {
  sheetTabs = normalizeSheetTabs(tabPayload.sheets || []);

  const stored = await chrome.storage.local.get("selectedSheetGid");
  const selectedSheetGid = chooseSelectedSheetGid(stored.selectedSheetGid, tabPayload.defaultSheetId);
  renderSheetTabs(sheetTabs, selectedSheetGid);
  await persistSelectedSheetTab();
  setSaveEnabled(Boolean(latestPayload && getSelectedSheetGid()));
}

async function getCachedSheetTabs() {
  const result = await chrome.storage.local.get(SHEET_TABS_CACHE_KEY);
  const cache = result[SHEET_TABS_CACHE_KEY];

  if (!cache?.sheets?.length) {
    return null;
  }

  return {
    defaultSheetId: cache.defaultSheetId || "",
    sheets: cache.sheets
  };
}

async function cacheSheetTabs(tabPayload) {
  await chrome.storage.local.set({
    [SHEET_TABS_CACHE_KEY]: {
      cachedAt: Date.now(),
      defaultSheetId: String(tabPayload.defaultSheetId || ""),
      sheets: normalizeSheetTabs(tabPayload.sheets || [])
    }
  });
}

function normalizeSheetTabs(tabs) {
  return tabs
    .map((tab) => ({
      sheetId: String(tab.sheetId || ""),
      title: String(tab.title || ""),
      index: Number(tab.index || 0)
    }))
    .filter((tab) => tab.sheetId && tab.title);
}

async function requestScrape(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_LINKEDIN_JOB" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/scraper.js", "src/content.js"]
    });

    return chrome.tabs.sendMessage(tabId, { type: "SCRAPE_LINKEDIN_JOB" });
  }
}

function renderResult(data) {
  latestPayload = data;
  fields.title.value = data.title || "";
  fields.company.value = data.company || "";
  fields.applyUrl.value = data.applyUrl || "";
  fields.description.value = data.description || "";
  jsonEl.textContent = JSON.stringify(data, null, 2);

  if (data.applyUrl) {
    openApplyUrlLink.href = data.applyUrl;
    openApplyUrlLink.classList.remove("disabled");
  } else {
    openApplyUrlLink.href = "#";
    openApplyUrlLink.classList.add("disabled");
  }

  setCopyEnabled(true);
  setSaveEnabled(Boolean(getSelectedSheetGid()));
  const warningText = data.warnings?.length ? ` ${data.warnings.join(" ")}` : "";
  setStatus(`Scraped ${countPresentFields(data)} of 4 fields.${warningText}`);
}

function clearResult() {
  fields.title.value = "";
  fields.company.value = "";
  fields.applyUrl.value = "";
  fields.description.value = "";
  jsonEl.textContent = "{}";
  openApplyUrlLink.href = "#";
  openApplyUrlLink.classList.add("disabled");
  setSaveEnabled(false);
}

function countPresentFields(data) {
  return ["title", "company", "description", "applyUrl"].filter((key) => Boolean(data[key])).length;
}

function renderSheetTabs(tabs, selectedSheetGid) {
  sheetTabSelect.replaceChildren();

  if (!tabs.length) {
    sheetTabSelect.append(new Option("Start bridge to load tabs", ""));
    sheetTabSelect.disabled = true;
    return;
  }

  for (const tab of tabs) {
    sheetTabSelect.append(new Option(tab.title, tab.sheetId));
  }

  sheetTabSelect.value = selectedSheetGid;
  sheetTabSelect.disabled = false;
}

function chooseSelectedSheetGid(storedSheetGid, defaultSheetGid) {
  const availableIds = new Set(sheetTabs.map((tab) => tab.sheetId));

  if (storedSheetGid && availableIds.has(storedSheetGid)) {
    return storedSheetGid;
  }

  if (defaultSheetGid && availableIds.has(defaultSheetGid)) {
    return defaultSheetGid;
  }

  return sheetTabs[0]?.sheetId || "";
}

async function persistSelectedSheetTab() {
  const selectedTab = getSelectedSheetTab();

  if (!selectedTab) {
    return;
  }

  await chrome.storage.local.set({
    selectedSheetGid: selectedTab.sheetId,
    selectedSheetTitle: selectedTab.title
  });
}

function getSelectedSheetTab() {
  const selectedSheetGid = getSelectedSheetGid();
  return sheetTabs.find((tab) => tab.sheetId === selectedSheetGid) || null;
}

function getSelectedSheetGid() {
  return sheetTabSelect.value || "";
}

function isSupportedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("linkedin.com") && parsed.pathname.startsWith("/jobs");
  } catch (error) {
    return false;
  }
}

function setBusy(isBusy) {
  scrapeButton.disabled = isBusy;
}

function setCopyEnabled(isEnabled) {
  copyJsonButton.disabled = !isEnabled;
}

function setSaveEnabled(isEnabled) {
  saveSheetButton.disabled = !isEnabled;
}

function setStatus(message) {
  statusEl.textContent = message;
}
