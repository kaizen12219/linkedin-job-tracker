const scrapeButton = document.querySelector("#scrape");
const copyJsonButton = document.querySelector("#copyJson");
const saveSheetButton = document.querySelector("#saveSheet");
const openApplyUrlLink = document.querySelector("#openApplyUrl");
const statusEl = document.querySelector("#status");
const SHEETS_BRIDGE_URL = "http://127.0.0.1:8787/jobs";
const fields = {
  title: document.querySelector("#title"),
  company: document.querySelector("#company"),
  applyUrl: document.querySelector("#applyUrl"),
  description: document.querySelector("#description")
};
const jsonEl = document.querySelector("#json");

let latestPayload = null;

document.addEventListener("DOMContentLoaded", () => {
  scrapeCurrentTab();
});

scrapeButton.addEventListener("click", () => {
  scrapeCurrentTab();
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

  saveSheetButton.disabled = true;
  setStatus("Saving to Google Sheet...");

  try {
    const response = await fetch(SHEETS_BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(latestPayload)
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Sheets bridge returned HTTP ${response.status}.`);
    }

    if (result.status === "duplicate") {
      setStatus(result.message || `Skipped because ${latestPayload.company} already exists.`);
      return;
    }

    setStatus(`Saved to Google Sheet${result.updatedRange ? ` (${result.updatedRange})` : ""}.`);
  } catch (error) {
    setStatus(`Could not save. Start the local Sheets bridge, then try again. ${error.message}`);
  } finally {
    saveSheetButton.disabled = !latestPayload;
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
  setSaveEnabled(true);
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
