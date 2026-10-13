# LinkedIn tracker

This is the extension source shipped in the current ApplicantAlly package at `workspace/linkedin-tracker`. It preserves collection, AI qualification, profile routing and banned companies. All captured profiles enter Pending, including Kevin Lee.

Reload the extension after updating its source. Open **Folder settings**, choose the ApplicantAlly package or its `data/workspace` folder, and grant read/write access. Open the updated app once first to migrate its saved jobs. If Chrome asks for permission again, use **Allow access** in Folder settings.

Profiles come from `data/workspace/profile-library/settings.json`, with `registry.json` used for older folders without settings. Each job is stored in `data/workspace/job-primary/applicantally-1/jobs`. The extension creates a final job record directly. ApplicantAlly assigns its numeric ID when loading it and updates that same file through validation and tailoring. There is no inbox or running-app connection for profiles, duplicate checks or saves. The old `job-primary/applicantally-1.json` is a compatibility index and publication metadata snapshot; edit individual job files rather than that index.

The existing AI research worker on port 8787 is still needed to qualify jobs and verify application routes. The extension writes its results to the selected folder. Pending research retains its capture ID if folder access expires and resumes after access is restored.

Run `npm ci`, then `npm test` for extension tests. The parent repository's `workspace/test/file-store.test.mjs` covers disk writes, migration, concurrent tailoring, deletion and recovery. `workspace/test/chrome-file-store.mjs` probes Chrome file handles, IndexedDB, the extension worker and popup using a disposable browser profile.

`scripts/package-extension.ps1` writes one current archive from a runtime asset allowlist. It includes no credentials, job data, tests or legacy Google Sheets client.
