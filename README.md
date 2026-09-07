# LinkedIn Job Tracker → Google Sheets

This Chrome extension captures LinkedIn jobs directly into a Kai Sheet-compatible Google Sheet. It does not connect to the Kai Flow dashboard, a local bridge, a public tunnel, or any pairing service. The dashboard can be stopped while the extension is used.

## Install and configure

1. Share the target Google Sheet with the service account's `client_email` as an **Editor**.
2. Extract the extension ZIP into a permanent folder.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that folder. Use **Reload** after updating an existing installation. The bundled public manifest key keeps the extension ID stable; it is not a secret credential.
4. Open the extension and expand **Google Sheet settings**.
5. Choose the Google service-account credentials JSON file, paste the full `https://docs.google.com/spreadsheets/d/...` URL, enter the destination tab `gid`, and choose **Save settings**. The URL's `#gid=` value is also accepted.

The destination tab must use the Kai Sheet headers `Date`, `Company`, `Job Title`, `Job Description`, `Apply URL`, `Profile`, `Status`, `Salary`, and `Info` in A:I. The extension safely creates the managed `Trashed`, `Added By`, and `Applied By` headers in K:M when those columns are unused. It refuses to write if the expected headers were repurposed.

The credentials are reduced to the service-account fields needed for authentication and stored only in trusted `chrome.storage.local` for that browser profile. They are never put in Chrome Sync, exported, shown in status responses, sent to LinkedIn, or sent to Kai Flow. OAuth access tokens remain only in service-worker memory. **Remove settings** deletes the saved credentials, target, and local receipts from the profile.

Because a service-account JSON contains a long-lived private key, configure it only in a browser profile and PC you trust. Use a narrowly scoped service account shared only with the intended Sheet, and rotate/revoke its key if the PC or extracted extension folder is compromised. Each separate PC/browser profile needs its own setup.

## Capture a job

Open a LinkedIn job and select the extension. **Scrape** reads the company, job title, description, and real application URL. Review or edit the fields in this order: Company → Job title → Apply URL → Profile → Job description, then choose **Save**. Company, title, and description are required.

New rows are written with:

- the first row considered empty by Kai Sheet's job-row rule;
- status `added` (Pending);
- no application date;
- `Job tracker` in **Added By**;
- an empty **Applied By** value.

If the tab needs another row or managed columns, the extension expands it before writing. **Profile** values come from the F2 dropdown plus profiles already present in column F. A nonblank profile must be one of those live options; blank remains allowed and is remembered for the keyboard shortcut.

`Ctrl+Shift+Y` scrapes and saves the active LinkedIn job without opening the popup. Change the shortcut at `chrome://extensions/shortcuts`. **Copy JSON** and **Apply URL** remain available.

## Duplicate and banned-company behavior

Company matching trims/collapses whitespace and ignores case. A matching recorded company blocks another save regardless of its ordinary lifecycle status. The only exceptions are:

- a row marked in column K as Trash;
- `trashed` or legacy `deleted` status;
- `clearance`, `location restriction`, `location-restriction`, `on-site`, `onsite`, `language`, `not applicable`, `not-applicable`, or `restricted`.

The authoritative duplicate check runs again immediately before every write. LinkedIn search cards for duplicate companies are styled using a short cached snapshot of the same Sheet rule.

**Banned companies** remains a separate editable list. It uses Chrome synced storage when available, and Export/Import can transfer it across unrelated profiles or PCs. Banned and duplicate LinkedIn cards use the same concise visual treatment. Banned companies cannot be saved until removed from that list.

## Save safety and limitations

There is no persistent retry queue. Each Save performs one direct Google Sheets operation. A bounded local receipt is written before the Sheet call and can reconcile an uncertain response if the exact row reached Google. It does not replay work automatically.

Writes from the popup and keyboard shortcut are serialized inside one extension service worker so they cannot choose the same gap. Google Sheets' Values API does not provide a compare-and-swap insert, so two different PCs can still race if they save at exactly the same time. The duplicate scan greatly reduces ordinary collisions but cannot make cross-PC writes fully atomic.

If a result is uncertain, check the Google Sheet before trying again. A later identical save can recognize its locally receipted row. A different browser profile has no access to that local receipt.

## Network and permissions

Runtime network access is limited to:

- `https://oauth2.googleapis.com` for the signed service-account JWT exchange;
- `https://sheets.googleapis.com` for Sheet reads and writes;
- LinkedIn job pages for scraping and duplicate/banned styling.

There is no localhost, WebSocket, ngrok, arbitrary HTTPS, Kai Flow API, bearer pairing token, alarm-based retry, or dashboard connection.

## Development and distribution

Run `npm test` for offline tests with generated credentials and synthetic Sheet responses. Tests never access a live account or write a live Sheet.

Run `npm run preview:popup` for the synthetic popup fixture. Supported modes include `?mode=unconfigured`, `?mode=offline`, `?mode=duplicate`, and `?mode=uncertain`.

Run `npm run package:extension` on Windows to create a versioned ZIP under `dist/`. Packaging uses a fixed allowlist and excludes service-account files, tests, development scripts, `.env` files, and unrelated repository content. Distribute that ZIP rather than the complete repository.
