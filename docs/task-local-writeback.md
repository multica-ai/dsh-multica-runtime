# 任务内本地回写闭环

`dsh-multica-runtime` 仅负责把 Multica 任务的 `issue_id` 通过
`MULTICA_ISSUE_ID` 环境变量透传给模型生成的子进程。任务内是否回写、何时回写，
由任务自身通过 `multica` CLI 和本目录中的脚本完成，平台编排不需要任何改动。

## 前置条件

1. 任务内已存在有效的 `MULTICA_TOKEN`（`mat_` 前缀）。运行时会按既有安全策略
   只透传该 token，不修改任何 provider credential 的脱敏逻辑。
2. 下发 `execute` 命令时携带可选 `issue_id` 字段，例如：

   ```json
   {
     "v": 1,
     "type": "execute",
     "request_id": "req-1",
     "cwd": "/work",
     "prompt": "修复问题",
     "issue_id": "049c05e8-70ed-4c43-8ffa-9a313bb94c50"
   }
   ```

   运行时收到该字段后，会把 `process.env.MULTICA_ISSUE_ID` 设置为该值。
3. `multica` CLI 在任务内可用，并继承 `MULTICA_TOKEN` 与 `MULTICA_ISSUE_ID`。

## 进度回写

任务执行过程中，把 `progress.jsonl` 中最新一条含 `phase` 或 `last_artifact`
的记录写入 issue metadata：

```bash
node scripts/multica-local-progress.mjs .multica/progress.jsonl
```

脚本会依次执行：

```bash
multica issue metadata set <issue-id> --key phase --value <phase> --type string
multica issue metadata set <issue-id> --key last_artifact --value <artifact> --type string
```

`progress.jsonl` 每行是一个 JSON 对象，脚本按顺序扫描，后出现的
`phase` / `last_artifact` 覆盖先出现的值；只要二者至少存在一个，脚本即成功。

## 验收回写

任务完成并跑完 `required_checks` 后调用：

```bash
node scripts/multica-local-acceptance.mjs \
  --result passed \
  --log .multica/acceptance.log
```

失败时：

```bash
node scripts/multica-local-acceptance.mjs \
  --result failed \
  --log .multica/acceptance.log \
  --summary "required_checks 中 pnpm test 退出码为 1"
```

脚本行为：

- `passed`：将 issue 置为 `in_review`。
- `failed`：将 issue 置为 `blocked`。
- 生成评论文件到 `.multica/acceptance-comment.md`，并通过
  `multica issue comment add <issue-id> --content-file <file>` 发布。
- 评论中包含结果、摘要、失败原因和日志摘要。

## 幂等与防抖动

- 状态修改前先读取 `multica issue get`，只有当前状态与目标状态不同才调用
  `multica issue status`，避免无意义的状态切换。
- 评论发布前先比较 issue metadata 中的 `local_acceptance_fingerprint`。
  指纹由 `result + summary + log` 计算得到；指纹相同则跳过评论，避免重复评论。
- 评论发布成功后才把新指纹写入 `local_acceptance_fingerprint`。如果评论失败，
  下次重跑仍会尝试发布。
- 若日志内容或摘要变化，指纹会变化，此时允许发布一条新的验收评论；这是有意
  的“可覆盖”，便于对失败修复后再次报告。

## 与平台原生 acceptance 消费共存

平台未来如果在 WIN-94 中直接消费 runtime 出站的 `acceptance` 帧，本地脚本仍可
安全运行：

- 本地脚本只使用 issue metadata 和 issue comment/status 这些用户态接口，不读取
  或修改 runtime 的 protocol 帧。
- 状态与评论均为幂等；平台回写与本地回写到达顺序不同，也不会造成状态抖动。
- 平台侧应继续消费 runtime 的 `progress` / `result.acceptance`，本地 metadata
  只是给当前 Multica 上层提供可读的短状态，不替代平台数据源。
