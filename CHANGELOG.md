# Changelog

## 0.8.13 — 2026-10-21

- Keep bounded recovery polling when only failed research remains, so an approved worker repair can resume and import without another capture or reconnect. Persist probe order across extension suspension and retain destination, lifetime, cancellation and save guards.
- Recover explicitly authorized interrupted research under its original request and thread after verifying the exact interrupted turn. Preserve frozen job/model/profile settings and keep unrelated interruptions blocked.
- Report previously submitted Jobright jobs as skipped when collection restarts in the same page, without resubmitting them or relaxing active-card checks.
- Record bounded review timing and changed field names when detail verification times out, without logging URLs or description contents or relaxing identity/stability checks.

## 0.8.12 — 2026-10-21

- Retry and serialize research-worker file replacements when Windows temporarily locks the destination. Keep exhausted storage failures queued under the same request ID, and require durable decisions before publishing results or authorizing a save.
- Recover retained failed research requests only when the worker explicitly identifies a repaired storage failure. Preserve their original destination, model, job and profile rules; cancellation, expired requests and uncertain saves remain excluded.
- Bring the exact selected Jobright qualifications section into view while waiting for lazy content. Retain strict job identity and complete-description checks, and include bounded layout diagnostics with unreadable-detail reports.
- Match LinkedIn's `Sr`/`Senior` title spelling and explicitly separated leading `Remote` labels for the same verified job. Keep the remaining title, employer, ID and changed-description checks, and retain actual rendered title/company in bounded failure diagnostics.

## 0.8.11 — 2026-10-21

- Recover selected LinkedIn descriptions whose About section stays unhydrated in a hidden tab by reading that exact public job page in the extension worker. Verify job ID, title and company before using its description; recheck the live document and collector ownership before and after the credential-free request.
- Bound each public request to 20 seconds and 750 KB, allow at most two attempts within the existing readiness window, and reject unrelated redirects, login pages, mismatched or ambiguous content. Preserve closed-posting status and all existing eligibility/profile checks.
- Discard late description responses after Stop or a changed selection. Include bounded fallback status in failure diagnostics.

## 0.8.10 — 2026-10-21

- Recognize selected LinkedIn About headings rendered as paragraphs, ARIA headings or plain divs for description extraction and lazy loading. Keep exact heading labels and selected-job boundaries.
- Save bounded, redacted description-layout diagnostics with verification failures so missing content, loading state and panel boundaries can be distinguished without guessing. Retain the 90-second readiness wait, profile routing and capture checks.

## 0.8.9 — 2026-10-21

- Wait up to 90 seconds for slow job details and require the selected ID, company, title and changed description to settle. Recheck and review late description updates within a three-minute per-job budget; keep Stop and search-change cancellation responsive.
- Read selected LinkedIn descriptions from modern plain About sections and legacy description containers. Ignore loading placeholders and descriptions outside the selected job.
- Keep the selected LinkedIn card intact until capture is handed off or a bounded details failure is reported, then dismiss it. Remove the equal-description exception introduced in 0.8.8; a header or DOM replacement alone cannot authorize the previous job's text.

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
