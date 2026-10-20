# Research worker updates

The extension's 0.8.0 file-save protocol requires the matching local research worker. The worker continues to store research and ownership metadata only; ApplicantAlly profiles and jobs are accessed through the extension's granted folder handle.

`0.8.0-save-coordination.patch` records the backend change from the Jobright-capable 0.7.7 worker. Check it against the intended source with `git apply --unidiff-zero --check`, then apply with `git apply --unidiff-zero`. Copy `save-coordination.test.mjs` into the worker's `tests/` folder and run it with the existing research tests. A worker already containing `saveClaim` does not need the patch again.

Keep the standalone worker, ApplicantAlly's rebuild source under `workspace/tracker-captures`, and its bundled builder copy aligned. Restart the local research worker after updating it. The extension must keep saves queued when ownership coordination is unavailable.

The local installation was updated as part of this release. These maintenance files are excluded from the extension ZIP's runtime allowlist.
