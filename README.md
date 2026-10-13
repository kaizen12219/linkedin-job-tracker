# LinkedIn Job Tracker → ApplicantAlly

This extension captures qualifying LinkedIn jobs into ApplicantAlly. Research uses independent Codex sessions in Rezi Builder; saving and duplicate checks use ApplicantAlly’s local JSON store.

## Install and start

1. For first-time setup, open ApplicantAlly once to prepare its app-folder store. It may then be closed.
2. Extract the extension ZIP into a permanent folder.
3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Use **Reload** after updating an existing installation. The bundled public manifest key keeps the extension ID stable.
4. Open the popup’s **Folder settings** and choose the extracted ApplicantAlly app folder or its `data/workspace` directory.
5. Start the research worker with `scripts/start-research.ps1` and keep Codex signed in.
6. Capture a job. Profiles, duplicate checks and saves use the selected folder directly.

Jobs, results, and résumé links are stored in ApplicantAlly’s app-folder data. In the extension popup, open **Folder settings → Choose folder** and select your extracted ApplicantAlly folder or its `data/workspace` directory. Chrome remembers the folder handle. The tracker reads profiles and duplicate records and writes new job files directly, including while ApplicantAlly is closed. ApplicantAlly watches these files when open and loads them on startup. Google Sheets receives a snapshot only when you use ApplicantAlly’s publish button.

## Capture a job

Click a LinkedIn search-result card to select it and start capture. The tracker waits for that exact job's details to finish loading. Once that click authorizes capture, switching tabs or covering SunBrowser does not pause the handoff. The exact job identity, changed description, stable details and ten-second expiry still apply. It preserves the existing native × dismissal behavior, and skips duplicate/banned companies. Automatic dismissal, native buttons, modified clicks, and synthetic page clicks do not start capture.

Every capture, including popup Save and the keyboard shortcut, uses this order:

1. Skip clear excluded nonengineering titles such as Business Analyst, Data Analyst, Product/Project Manager, Scrum Master, recruitment, sales, IT support and manual QA. Only Senior or below qualifies. Clear Staff, Principal, Distinguished, Fellow, Chief and higher engineering management titles, and descriptions explicitly assigning this position a higher level, are skipped locally, including queued captures. AI evaluates ambiguous titles such as Lead, Architect, Founding Engineer and numbered ranks using the actual duties, decision-making authority, company ladder and scope across teams. Team-level design, mentoring and complex independent delivery can remain Senior; working with higher-level colleagues does not give this role their level. Every remaining job starts its own AI session and requires eligible software, web, mobile, infrastructure, data/AI or software-test engineering classification with an exact 24–2000 character description quote. Above-Senior, unclear or nonengineering results skip before remote checks, profile analysis and application/contact research.
2. Read the selected job's workplace pill. **Hybrid**, **On-site**, and missing/unrecognized labels start their own research session. The session reads the description and checks for explicit fully remote work without required office attendance. If that check fails, it returns skip through MCP and stops before Easy Apply research. No local text filter rejects these jobs before a session starts; the returned evidence is checked before any central-store save.
3. For **Easy Apply**, research the exact company/title for a currently open, free external application page, a published application email, or the named job poster's published work email. Prefer the employer's careers page or authorized ATS. A job-specific page inviting email applications also counts as an application page when research verifies the current invitation, published address, employer/recruiter and a distinctive description passage of at least 100 characters matching the captured vacancy. Only this same-vacancy email route can accept an alternate displayed title. Reject LinkedIn destinations and redirects, paid/gated application routes, expired postings, generic careers/contact pages, unrelated roles, and guessed/private emails.
4. Save only when the required checks pass. A verified external application page, including an email application page, replaces **Apply URL**. The complete original LinkedIn job URL, published emails, and any remote-work confirmation go in **Info**. Do not repeat the application page URL in the email's source suffix. Other email sources remain in Info; an email without a verified application page retains the existing Apply URL as a reference. Ordinary Remote jobs with an external Apply button save only after the role classification passes.

Each new job passing the title exclusions creates its own persistent local Codex session titled `Job research · Company · Role`. Retries of the same pending request recover that job's session; different jobs never share a session. The session returns structured findings using the research worker’s `complete_job_capture` MCP tool; it cannot call resume, validation, application-answer tools, or change a destination. After rechecking the banned list, the extension checks the current folder records and commits a `capture-<requestId>.json` job file with its selected profile and Pending status. ApplicantAlly assigns the permanent job ID when it loads the capture. Failed checks add nothing.

Start the research worker on this PC at `http://127.0.0.1:8787`, and keep the Codex desktop account signed in. From this repository, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-research.ps1`. ApplicantAlly can be closed. Open the updated app once to prepare its file-store descriptor before first choosing the folder. Reload the extension and LinkedIn tabs after updating. Research uses the signed-in account’s normal usage allowance; it does not purchase anything or apply to jobs.

In LinkedIn's job details panel, click the **job title** to copy the title or the **company name** to copy the company. A dotted underline on hover and a brief confirmation identify the copy action. Tab to either field and press Enter or Space to copy with the keyboard. Modified link clicks keep their normal navigation behavior. Search result cards retain their existing selection and dismissal behavior.

Open a LinkedIn job and select the extension. **Scrape** reads the company, job title, description, and real application URL. Review or edit the fields in this order: Company → Job title → Apply URL → Profile → Job description, then choose **Save**. Company, title, and description are required.

New jobs use a permanent local job ID, status `added` (Pending), no application date, and **Job Tracker** attribution. Profile choices come from ApplicantAlly’s local settings. A blank Profile is allowed and remembered for the shortcut. Temporary save failures retry the same capture ID so a lost response cannot create a duplicate.

`Ctrl+Shift+Y` scrapes and saves the active LinkedIn job without opening the popup. Change the shortcut at `chrome://extensions/shortcuts`. **Copy JSON** and **Apply URL** remain available.

ApplicantAlly’s profile data lives in `<app folder>/data/workspace/profile-library`: `settings.json` stores the current choices, `registry.json` is the generated manifest, and `snapshots/` contains the profile JSON revisions. The tracker reads enabled IDs and display names directly from `settings.json` on every options read and before a save, using `registry.json` for older folders without settings. Changed labels, disabled profiles and new IDs are picked up with ApplicantAlly closed. Full profile contents remain in the app library; the job stores the selected profile ID.

Profile selection for AI-approved eligible roles follows the country selected on LinkedIn's job-search page, including its visible country dropdown. **United Kingdom → Michal Stefanow; Colombia or LATAM → Jose Ibero.** For **United States**, AI extracts required engineering experience: **5+ years → Kevin Lee; below 5 → Jagjeet Wani**. Use the lower bound of a required range and ignore preferred years. When required years are absent, a Senior/Lead/Architect title or AI-confirmed senior technical scope selects Kevin; ordinary/mid-level scope selects Jagjeet. Above-Senior roles remain excluded regardless of profile or required years. “No minimum years” uses the scope fallback rather than zero. The current two-page profile ID is preferred when available; older profile IDs remain compatible.

The search country dropdown takes priority over stale URL state, and committed URL filters take priority over an unsubmitted location-input edit. Captures never infer the search country from an employer address, job description, or another card. Other regions retain the manual profile. Known-region routing overrides the remembered manual choice without overwriting it. Each capture freezes its selected country and resolved profile for retries. US analysis uses the existing research session and an exact captured-description quote. All profiles save as **Pending**; automatic Trash is removed, including old queued Kevin flags.

## Collect a search automatically

On LinkedIn job search results, press **Ctrl+Shift+U** to start collecting active jobs from the top of the current results page. Collection continues when you switch tabs, use another app, or minimize SunBrowser. Keep the browser and LinkedIn tab open. Press the same shortcut from any tab in that browser to stop, or press **Escape** on the LinkedIn tab. Collection runs without a progress panel or per-job messages. Only start/stop/completion alerts, warnings and errors appear, and each disappears after five seconds. You can change the shortcut at `chrome://extensions/shortcuts`.

The collector skips duplicate/banned companies, native grey/dismissed cards and Undo controls, jobs already processed in the run, and cards captured manually earlier in that tab. It clicks one active card using the normal selection and native **×** dismissal behavior, waits for that exact job's header and description to settle, then pauses for a short review before using the existing save action once. Its own × turning the selected card grey or removing it does not cancel that job's save. The selected title's job link identifies the details in layouts with either a heading or a standalone title link; a changed search URL alone never proves the identity. Actions are separated by random 0.45–1.25 second pauses. Review pauses vary with description word count and random timing, bounded to 5–45 seconds. These are half the previous pacing delays; readiness checks and loading timeouts retain their existing limits. Each qualifying research request uses its own session and the existing `complete_job_capture` callback. After a research request is accepted, collection moves on while AI finishes in the background.

The results column scrolls to discover more cards, then the collector uses **Next** until the last results page. Lazy-loaded cards are checked before pagination. A repeated page, a blocked click, incomplete job details, or a failed pagination transition cannot authorize a save. If the research worker is temporarily unavailable or busy, jobs remain durably queued and collection continues; submission retries about every 30 seconds while Chrome is running, using the same request IDs. A queued job is not a saved job: it still needs successful AI checks before writing to ApplicantAlly. Temporary local-store outages keep verified research queued; saves retry with the same request ID, so a lost response cannot duplicate a job. Native duplicate/banned X dismissal is suspended during collection so it cannot race the paced selections.

Collection delays run in the extension worker in cancellable intervals of at most 20 seconds, so hidden-page timer throttling does not stretch every polling or review interval. Delays use elapsed time; each wake rechecks job identity and never catches up by firing a burst of clicks. An exclusive Web Lock gives the collector one tab owner and protects its active work from Chrome's automatic freezing. The collecting tab temporarily disables automatic discarding and restores its previous preference when the run ends. Background scrolling is immediate so hidden-page animations cannot block selection. All page-overlay and exact-job checks still apply; collection never activates a tab or brings the browser to the foreground.

Changing the search or manually operating a job/navigation control stops the run. Progress in Chrome session storage lets a normal Next-page navigation or worker restart continue without replaying attempted jobs; closing the tab ends the run, and Chrome clears [session storage](https://developer.chrome.com/docs/extensions/reference/api/storage#session) when the browser restarts or the extension reloads. Reloading the extension stops the current collection run. Research requests already submitted continue through the existing validation pipeline after collection stops. Closing the browser or putting the PC to sleep stops browser execution; it is not a background service outside SunBrowser.

## Duplicate and banned-company behavior

Company matching trims/collapses whitespace and ignores case. A matching recorded company blocks another save regardless of its ordinary lifecycle status. The only exceptions are:

- a job in local Trash;
- `trashed` or legacy `deleted` status;
- `clearance`, `location restriction`, `location-restriction`, `on-site`, `onsite`, `language`, `not applicable`, `not-applicable`, or `restricted`.

The authoritative duplicate check runs again immediately before every write. LinkedIn search cards are classified for automatic dismissal using a short cached snapshot of the local store.

**Banned companies** remains a separate editable list. It uses Chrome synced storage when available, and Export/Import can transfer it across unrelated profiles or PCs. Duplicate and banned cards retain LinkedIn's native appearance; the tracker adds no dimming or custom card styling. Banned companies cannot be saved until removed from that list.

Duplicate and banned search results are automatically dismissed by clicking LinkedIn's own **Dismiss (×)** button as soon as classification confirms them, one job at a time with no intentional dismissal delay. The tracker acts only in a visible tab on an uncovered, on-screen dismiss button. Scroll to bring more results into view. It rechecks the current company classification and job identity before clicking, skips disabled or missing buttons, and attempts each job only once per page session. LinkedIn controls the resulting dismissed state and its Undo action.

Click any open job card—active, duplicate, or banned—to select it normally, then click its native × button after the original click finishes. The tracker lets the original click reach LinkedIn and rechecks the card before dismissal. Manual card clicks do not wait for a company lookup and work before local classification or when ApplicantAlly is offline. Automatic closing applies only to duplicate and banned jobs, without random pauses. Once × has been clicked, either directly or by the tracker, clicking the card does not click × again during that page session. Native controls such as Undo keep their normal behavior.

## Save safety and limitations

Pending research requests survive worker/browser restarts and are checked about every 30 seconds while Chrome is running. Offline research submission retries with the same request ID. Temporary model errors, including capacity, overload and rate limits, remain queued with retry delays of 30 seconds, 1 minute, 2 minutes and so on, capped at 15 minutes. A confirmed failed model turn retries in the same persistent job session with a fresh turn identity; uncertain delivery is inspected before any resubmission. The model and profile-routing snapshot stay fixed. Retries stop after the existing 24-hour request expiry. Authentication, exhausted account quota and invalid requests remain actionable failures. Changing the local destination or clearing pending requests cancels pending saves. Only results verified within the last hour can be saved.

Each eligible result is written to its own file with the capture’s persistent request ID. If folder permission is unavailable, the pending save waits for recovery: open Folder settings and allow access again. Replaying a capture returns the existing job, preserving edits made by ApplicantAlly and respecting deleted records. Other failed or uncertain responses require checking ApplicantAlly before retrying.

Writes from the popup and keyboard shortcut are serialized inside one extension service worker and across extension contexts with a Web Lock. The tracker checks current company records immediately before writing, commits the file through a writable stream, and reads it back to confirm the capture identity. ApplicantAlly uses its existing file-store writer lock when importing and editing jobs. Tracker captures never choose Google Sheet gaps or invoke the Google Sheets Values API.

If a result is uncertain, check the job in ApplicantAlly before trying again. Capture receipts belong to the central store; different captures are also protected by its duplicate-company check.

## Network and permissions

Runtime network access is limited to:

- LinkedIn job pages for scraping and native card dismissal.
- `http://127.0.0.1:8787/job-research` for public captured job details and scoped research results. Google credentials and candidate profiles are not sent to this endpoint.
- Chrome’s granted folder handle for local profile choices, duplicate checks, company snapshots and saves. These operations perform no HTTP requests.

The extension has no Google API or arbitrary research-site permissions. The isolated local Codex session performs web research. The research worker accepts its scoped research route only from the fixed tracker extension with a private per-browser client key; browser access to its general MCP route remains blocked. The data connection uses the selected local folder and requires no ApplicantAlly API, tracker token or running ApplicantAlly process.

## Development and distribution

Run `npm test` for offline tests with synthetic local-store and research responses; retained legacy Google client tests also use generated credentials and synthetic responses. Tests never access a live account or write live jobs or a live Sheet. The legacy Google client is neither imported by the tracker nor included in its packaged extension.

Run `npm run preview:popup` for the synthetic popup fixture. Supported modes include `?mode=unconfigured`, `?mode=offline`, `?mode=duplicate`, and `?mode=uncertain`.

Run `npm run package:extension` on Windows to create a versioned ZIP under `dist/`. Packaging uses a fixed allowlist and excludes service-account files, tests, development scripts, `.env` files, and unrelated repository content. Distribute that ZIP rather than the complete repository.
