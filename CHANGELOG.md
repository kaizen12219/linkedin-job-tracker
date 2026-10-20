# Changelog

## 0.8.8 — 2026-10-21

- Allow separate LinkedIn postings of the same role to share description text when the selected ID, company and title match and a fresh description render is observed. Keep unchanged old bodies and mismatched identities blocked.
- Apply the same description-readiness rule to automatic and manual selection, and preserve the specific verification reason and extension version in LinkedIn failure reports.

## 0.8.7 — 2026-10-21

- Recheck LinkedIn's live top-frame URL when its browser message retains a previous job ID after in-page navigation. Accept only the captured job in the same active document; mismatched jobs, sources, documents and frames remain blocked.

## 0.8.6 — 2026-10-21

- Keep collecting when Jobright unmounts the selected card after opening its details. Require the exact previously selected ID, company, title and committed search to match the rendered detail metadata; changed or ambiguous cards remain blocked.
- Permit the bounded detail recovery to restore an unmounted card before rechecking its identity.
- Retain the specific detail-verification reason and loaded extension version in failure reports, including when the surrounding capture handler supplies only a generic reason.

## 0.8.5 — 2026-10-21

- Follow the same Jobright job when its card is remounted, using its ID, title and company instead of a stale DOM node. Match harmless casing differences and select the unique detail panel whose rendered metadata identifies that job.
- Reopen an unreadable detail view once before any capture, then report the specific verification failure and continue to subsequent jobs. Never retry an uncertain save.
- Allow a captured public external application link when Jobright omits its Apply control. Keep strict search, rendered-job identity, closure and profile-routing checks; show collection progress on the page.

## 0.8.4 — 2026-10-21

- Treat Jobright jobs with captured public external links like ordinary LinkedIn Apply jobs. Remove forced Easy Apply classification from the scraper, research client and local worker; portal-only or unusable originals still require route research.
- Accept engineering work described under qualifications as role evidence. Generic skill keywords alone remain insufficient, and candidate skill matching is not part of collection.
- Include the matching worker update and regression tests. Existing seniority exclusions, remote checks, identity verification, profile routing and coordinated Pending saves remain in place.

## 0.8.3 — 2026-10-21

- Verify Jobright captures against the current top-frame URL and document identity after in-page job navigation. A stale initial message URL no longer rejects the newly selected job; mismatched jobs, documents and frames remain blocked.
- Record pre-research identity failures in the existing failure reports with a specific reason code.

## 0.8.2 — 2026-10-21

- Preserve Jobright's committed search filters and card identities while its job-detail view fades the mounted results list, preventing a false "search changed" stop. Real filter changes still stop collection.
- Close the job-detail view before returning to the results to select or lazy-load more jobs.
- Distinguish match-score and company-chart progress bars from actual loading indicators so collection can reach subsequent results and finish normally.

## 0.8.1 — 2026-10-21

- Recognize Jobright's committed United States filter even when it uses the default topbar state. Ignore draft controls, setting icons and hidden measurement copies; reject conflicting visible countries.
- Keep Jobright collection running when job-card navigation drops homepage tracking parameters, while still detecting changes to search filters.

## 0.8.0 — 2026-10-21

- Add Jobright recommendations and job-detail capture with the same US eligibility checks, Kevin Lee/Jagjeet Wani profile selection, ApplicantAlly folder saves and failure reports as LinkedIn.
- Support two simultaneous automatic collectors per browser profile, including one LinkedIn tab and one Jobright tab. Each collector keeps its own search context, progress and stop controls.
- Reject a third collector without interrupting either active run. Keep a shortcut from an unsupported page available to stop all collectors in that browser profile.
- Coordinate saves from separate browsers through durable ownership claims in the existing research worker, while continuing to read and write ApplicantAlly files directly.
- Align extension, package and lockfile release versions and check their consistency before tests and packaging.

The 0.7.7 rollback selected an earlier implementation as the baseline. It did not freeze the version for subsequent releases; 0.8.0 includes the later fixes and features.

## Versioning policy

Use `major.minor.patch` and increment the version for each distributed update:

- **Patch**, for example 0.8.0 → 0.8.1: fixes and compatible maintenance without a new user-facing feature.
- **Minor**, for example 0.8.1 → 0.9.0: compatible new features or capabilities.
- **Major**, for example 0.9.0 → 1.0.0: incompatible changes to supported behavior, saved data or required setup. Record migrations in the release notes.

Update `manifest.json`, `package.json`, both root-package version fields in `package-lock.json`, and this changelog together. Dependency versions remain independent. Run `npm run check:version`, `npm test`, and `npm run package:extension` before distribution. A rollback establishes a code baseline; the next distributed change still receives its own higher version.
