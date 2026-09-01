# LinkedIn Job Tracker → Kai Flow

This extension is a **standalone remote client**. It works on a different PC or in an AdsPower/proxy profile. It does not connect to localhost, does not require Kai Flow installed on the capture PC, and does not need an open dashboard. The central Kai Flow server and its public HTTPS connection must remain running.

## Install and connect

1. Use Chrome/Chromium 120+ (or an AdsPower profile with a compatible Chromium kernel). Extract the extension-only ZIP on the capture PC. Keep the extracted folder in a permanent location.
2. Open `chrome://extensions`, enable **Developer mode**, then **Load unpacked** and choose that folder. For an existing installation, update its files and **Reload**. The extension ID remains `lomiekljcjnlhfpklnjmmhomknfigofn`.
3. Ask the Kai Flow owner to open **Job tracker → Create pairing link**, and send the link privately. Links are single-use and do not expire; ask the owner to cancel an unused link if it was shared by mistake. Do not paste owner/viewer dashboard tokens into the tracker.
4. In the extension, expand **Server connection**, paste the complete `https://…/#tracker-pair=…` link, optionally enter a device name, and click **Connect**. Approve browser access to that one server origin. The extension does not request access to every HTTPS site.
5. The popup should say **Connected** and show the central server hostname. You may close the dashboard and popup; the extension remains independently paired in that browser profile.

Pairing credentials last 90 days unless revoked by the owner. Expired/revoked connections pause saves and ask you to reconnect. A new pairing is a new device identity: earlier queued requests stay visibly paused with their original connection, even when the new link points at the same server. They are **not** silently transferred or resubmitted. Ask the owner to reconcile earlier requests before recreating them.

Changing the proxy does not require a local service. If the server is unreachable, check that the proxy can reach its HTTPS hostname and that the central server/tunnel is online. **Refresh** requests the live profile list and checks due queued work. No local-port permission or port-scan exception is used by this version.

## Capture a job

Open a LinkedIn job and click the extension icon. **Scrape** reads company, job title, description, and application URL. Review or edit those fields, optionally choose a profile, then click **Save**. Company, title, and description are required. The description has its own fixed-height scroll area; Save stays visible below the scrolling form.

**Profile (optional)** starts with **No profile**. Blank stays blank. An explicit selection is remembered for **Ctrl+Shift+Y**, which scrapes and saves the active LinkedIn job directly. Profile labels come from the server, while permanent keys are saved. Options refresh on popup open and Refresh. An unavailable selected profile remains visible until you choose another profile or No profile; it is never silently reassigned. If offline, previously loaded choices may be used, and the server validates the selection when delivery resumes.

Company duplicate checks run after scraping and while typing (350 ms debounce). An existing match shows a short job brief; no-match checks show no message. Kai Flow repeats the authoritative duplicate check before inserting a job, including its existing Restricted exception.

Saved jobs enter **Pending**, with no application date until they are marked applied. All dashboards update through Kai Flow's existing synchronization. Google Sheet writes, validation, tailoring, and prompt dispatch remain server-side. The extension has no profile JSON, Google credentials, owner controls, or arbitrary Sheet-write access.

**Copy JSON** and **Apply URL** remain available. Change the keyboard shortcut at `chrome://extensions/shortcuts`.

## Save queue and safe retries

- A save request and its unique ID are persisted **before** any network send. Connection loss or timeout leaves it queued, and retries use that same ID. A browser/worker restart cannot create a new request for an uncertain save.
- The worker checks due work about every **30 seconds** while the browser/profile is running. Chrome may delay alarms; closed or sleeping browsers do not guarantee delivery. Pending work resumes on browser startup. No dashboard tab is involved.
- **Save queue** shows queued, sending, saved, not-saved, paused, and owner-check states. Repeated clicks, or edits to an unresolved same-company job, do not silently create another pending request.
- **Cancel retries** stops further attempts. It cannot undo an in-flight or already accepted save. A potentially submitted request keeps a warning and retained receipt; check with the owner before adding it again.
- An explicit server uncertainty response pauses for owner review instead of blindly appending again. Automatic retry also stops after **7 days**. Those requests remain visible and retained for reconciliation.
- An explicit fresh Save may use a new ID only after the server definitively rejected the earlier request, or the user canceled a request known never to have been sent. Automatic retries never create fresh IDs.
- Up to **256** request records and about **7 MB** of queued data are accepted. Completed and definitively rejected history expires after 7 days, or earlier to make room for new saves. Unresolved/sent cancellation records are never silently evicted; a full unresolved queue asks you to resolve earlier work.
- Do not uninstall the extension, clear its storage, or delete an AdsPower profile while it has unresolved saves. The queue is stored in that browser profile, not in the dashboard. A different profile has its own pairing and queue.

## Security and API boundary

The manifest carries a public identity key, not a secret signing key. Pairing requests use `POST /api/tracker/pair` with `{code, deviceName}` and receive `{ok:true,result:{token,deviceId,serverId,expiresAt}}`, where `expiresAt` is epoch milliseconds. Subsequent authenticated POSTs use `/api/tracker/options`, `/duplicate`, and `/save` only. Save bodies include a stable UUID `requestId` and the editable job fields plus the optional profile.

Credentials are stored only in trusted extension contexts. LinkedIn content scripts cannot read them or call privileged tracker actions: the worker accepts those messages only from its exact own popup. The credential is sent only to its paired HTTPS origin. Requests omit browser cookies, omit referrers, disable caching, and reject redirects. Pairing codes stay in the pasted link fragment until exchanged with that server; the successful connection clears the input. The popup never receives the stored bearer token.

The implementation follows Chrome's [optional-permission/user-gesture model](https://developer.chrome.com/docs/extensions/reference/api/permissions), [trusted-context storage controls](https://developer.chrome.com/docs/extensions/reference/api/storage), and [alarm persistence and timing guidance](https://developer.chrome.com/docs/extensions/reference/api/alarms).

## Development and distribution

Run `npm test` for offline tests with synthetic jobs. They never save live records. `npm run preview:popup` serves a synthetic visual fixture; use `?mode=unpaired`, `?mode=offline`, or `?mode=duplicate` for those states.

Run `npm run package:extension` on Windows to create a versioned ZIP under `dist/`. Packaging uses a fixed allowlist of the manifest, popup assets, scraper/content scripts, and remote-client worker files. It excludes legacy scripts, service-account credentials, `.env`, tests, and unrelated repository files. Distribute **that ZIP**, not the complete development repository.

The source scraper keeps its existing LinkedIn extraction logic, including the real offsite application link. Old `popup.js` and `scripts/sheets-server.js` are retained in the development repository for historical use only. They are not referenced by the current manifest/popup, are not packaged, and must not be started for this integration.
