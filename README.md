# LinkedIn Job Scraper Chrome Extension

This is a Manifest V3 Chrome extension that extracts the current LinkedIn job:

- Job title
- Company
- Job description
- Apply URL

The scraper avoids the generated LinkedIn class names. It uses stable page structure instead: job detail containers, `/jobs/view/` links, `/company/` links, the about-job expandable text box, accessible apply labels, and LinkedIn redirect URLs.

## Load in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `C:\Users\user\OneDrive\Documents\linkedin_job_tracker`.
5. Open a LinkedIn job page and click the extension icon.

## Output Shape

```json
{
  "title": "Cloud Support Engineer",
  "company": "Strategy",
  "description": "Company Description\n\n...",
  "applyUrl": "https://jobs.smartrecruiters.com/MicroStrategy1/744000123013774-cloud-support-engineer",
  "sourceUrl": "https://www.linkedin.com/jobs/view/...",
  "scrapedAt": "2026-07-01T00:00:00.000Z"
}
```

If LinkedIn wraps an offsite application link with `https://www.linkedin.com/safety/go/?url=...`, the extension unwraps it and returns the real destination as `applyUrl`.

## Save to Google Sheets

The extension does not store the service-account key in browser code. Instead, run the local Sheets bridge before clicking **Save to Sheet** in the popup.

Optional access check:

```powershell
npm run sheets:check -- --credentials "D:\rezi-builder-mcp\rezi-builder-95b56753ae45.json"
```

Start the bridge:

```powershell
npm run sheets:server -- --credentials "D:\rezi-builder-mcp\rezi-builder-95b56753ae45.json"
```

Keep that terminal open. The popup sends scraped jobs to `http://127.0.0.1:8787/jobs`, and the bridge writes to this sheet:

- Spreadsheet ID: `1arOqpFZYqsjAKL-whYlQhQ9Veeep66oAG88xc20NeIg`
- Sheet gid: `1956783810`
- Columns written: `B:E` as `Company`, `Job Title`, `Job Description`, `Apply URL`

Before writing, the bridge scans column `B` and skips the write when the same normalized company already exists. New jobs are written explicitly to `B{nextRow}:E{nextRow}` so the sheet's `Date` column in `A` is left untouched.

## Hotkey Save

After reloading the unpacked extension, press this default shortcut on a LinkedIn job page:

```text
Ctrl+Shift+Y
```

The shortcut scrapes the active job and saves it to Google Sheets through the local bridge. Keep the bridge running first:

```powershell
npm run sheets:server -- --credentials "D:\rezi-builder-mcp\rezi-builder-95b56753ae45.json"
```

The extension badge shows:

- `OK` when the job was saved
- `SKIP` when the company already exists in column `B`
- `ERR` when scraping or saving failed

To change the shortcut, open `chrome://extensions/shortcuts` and edit **Scrape the active LinkedIn job and save it to Google Sheets**.
