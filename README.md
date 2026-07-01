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
