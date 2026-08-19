# In-task local writeback loop

`dsh-multica-runtime` only forwards a Multica task's `issue_id` to model-spawned
subprocesses through the `MULTICA_ISSUE_ID` environment variable. Whether and when
a task writes back is decided by the task itself via the `multica` CLI and the
scripts in this directory; no platform orchestration changes are required.

## Prerequisites

1. A valid `MULTICA_TOKEN` (with the `mat_` prefix) already exists inside the task.
   The runtime forwards only this token following existing security policy and does
   not change any provider-credential scrubbing logic.
2. The `execute` command carries an optional `issue_id` field, for example:

   ```json
   {
     "v": 1,
     "type": "execute",
     "request_id": "req-1",
     "cwd": "/work",
     "prompt": "Fix the issue",
     "issue_id": "049c05e8-70ed-4c43-8ffa-9a313bb94c50"
   }
   ```

   When the runtime receives this field, it sets `process.env.MULTICA_ISSUE_ID` to
   that value.
3. The `multica` CLI is available inside the task and inherits `MULTICA_TOKEN` and
   `MULTICA_ISSUE_ID`.

## Progress writeback

During task execution, write the latest `progress.jsonl` record containing `phase`
or `last_artifact` into issue metadata:

```bash
node scripts/multica-local-progress.mjs .multica/progress.jsonl
```

The script runs, in order:

```bash
multica issue metadata set <issue-id> --key phase --value <phase> --type string
multica issue metadata set <issue-id> --key last_artifact --value <artifact> --type string
```

Each line in `progress.jsonl` is a JSON object. The script scans lines in order,
and later `phase` / `last_artifact` values overwrite earlier ones. It succeeds as
long as at least one of the two fields is present.

## Acceptance writeback

After the task finishes and runs `required_checks`, call:

```bash
node scripts/multica-local-acceptance.mjs \
  --result passed \
  --log .multica/acceptance.log
```

On failure:

```bash
node scripts/multica-local-acceptance.mjs \
  --result failed \
  --log .multica/acceptance.log \
  --summary "pnpm test in required_checks exited with code 1"
```

Script behavior:

- `passed`: sets the issue to `in_review`.
- `failed`: sets the issue to `blocked`.
- Generates a comment file at `.multica/acceptance-comment.md` and publishes it with
  `multica issue comment add <issue-id> --content-file <file>`.
- The comment includes the result, summary, failure reason, and log summary.

## Idempotency and anti-flapping

- Before changing status, the script reads `multica issue get` and only calls
  `multica issue status` when the current status differs from the target, avoiding
  meaningless status transitions.
- Before publishing a comment, it compares `local_acceptance_fingerprint` in issue
  metadata. The fingerprint is computed from `result + summary + log`; if it is
  unchanged, the comment is skipped to avoid duplicates.
- The new fingerprint is written to `local_acceptance_fingerprint` only after the
  comment is published successfully. If the comment fails, the next retry still
  attempts to publish it.
- If the log content or summary changes, the fingerprint changes, allowing a new
  acceptance comment. This intentional "overwrite" behavior lets the task report
  again after fixing a failure.

## Coexisting with platform-native acceptance consumption

If the platform later consumes the runtime's outgoing `acceptance` frame directly
(WIN-94), the local scripts can still run safely:

- The local scripts only use user-level interfaces such as issue metadata and issue
  comment/status; they do not read or modify runtime protocol frames.
- Status changes and comments are idempotent; even if platform writeback and local
  writeback arrive in different orders, status will not flap.
- The platform side should continue to consume the runtime's `progress` /
  `result.acceptance`. Local metadata only provides a readable short status for the
  current Multica upper layer and does not replace the platform data source.
