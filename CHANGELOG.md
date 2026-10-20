# Changelog

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
