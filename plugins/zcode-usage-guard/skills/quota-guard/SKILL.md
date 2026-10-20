---
name: quota-guard
description: 无人值守续跑协议。当用户要求长时间/通宵/无人值守运行任务,或额度快用完想自动续跑,或 Stop hook 注入了额度收尾协议时使用。定义交接文件格式、看门狗定时任务、以及唤醒后的恢复流程。
---

# quota-guard:无人值守续跑协议(v2 看门狗模式)

目标:额度耗尽时优雅收尾,重置后由**看门狗循环任务**驱动自动恢复,支持多周期长跑(如 24 小时任务跨 4-5 个重置周期)。

## 关键事实

- 额度快照:`~/.zcode/scripts/usage-state.json`(由悬浮窗每 N 分钟、会话启动 hook 实时刷新)。
  字段:`pools[]{key,label,usedPct,resetAt}`,`resetAt` 是 epoch 毫秒。
- 阈值:`~/.zcode/scripts/quota-guard-settings.json` 的 `threshold`(默认 95)全局共用;
  `thresholds{prompt5h,weekly,mcp}` 可按池覆盖(悬浮窗 ⚙ 保存即写全三池,支持任意 0–99 自定义值),
  设 0 表示关闭该池;任一有效池达标即触发,快照里每池独立比对。
- 绑定约束:**超阈值池中重置时间最晚者是绑定池**——每周额度耗尽时,5 小时池重置了也没用。
- **登记制**:只有登记进 `~/.zcode/scripts/quota-guard-optin.json`
  (`{"sessions": {"<会话id>": {"at": <epoch>}}}`)的会话才会被拦截/告警;普通对话零打扰。
  会话 id 取环境变量 `CLAUDE_SESSION_ID`(hook 与 Bash 里 `echo $CLAUDE_SESSION_ID` 都拿得到)。
- 两个硬限制:
  - **Stop hook 最多放行 3 次续跑**:第一轮必须完成全部收尾动作。
  - **被定时任务恢复的会话不能再 CronCreate**(ZCode 防递归策略):因此看门狗必须在普通会话里
    首次创建;拦截会话只负责「交接 + 标记」,不负责排程。这就是必须用看门狗而非逐周期一次性任务的原因。

## 收尾流程(收到 Stop hook 的 reason,或用户要求布置续跑时)

0. **登记会话**(若尚未登记):把当前会话 id 追加进 `~/.zcode/scripts/quota-guard-optin.json`
   的 `sessions` 表(Bash:`echo $CLAUDE_SESSION_ID` 取 id)。用户同意长时间无人值守的那一刻
   就该登记——只有登记的会话受管,其他对话零打扰。
1. **写交接文件** `~/.zcode/quota-handoff.md`,必须自包含(新会话看不到当前上下文):

   ```markdown
   # 无人值守交接 <日期时间>
   ## 任务目标
   <一段话说清要做成什么,验收标准>
   ## 已完成
   - <进度清单,含关键文件路径/分支/commit>
   ## 下一步(按序)
   1. <具体到可直接执行的步骤>
   ## 恢复指引
   - 工作目录:<绝对路径>
   - 相关会话:sess_xxx(可用 ReadSessionContext 找回细节)
   - 注意事项:<约定、坑、不要动的东西>
   ```

2. **确保看门狗存在**:先用 CronList 查有没有「quota-guard 看门狗」;没有才创建——
   recurring 循环任务、每 15 分钟(intervalUnit=minute、interval=15、不设 maxRuns),
   prompt 用下方「看门狗 prompt」原文。若本会话由定时任务恢复(CronCreate 被防递归策略拒绝),
   说明看门狗应已存在,跳过本步即可。
3. **写标记文件**:向 `~/.zcode/scripts/resume-armed.flag` 写入
   `{"armedForResetAt": <绑定池 resetAt>}`。Stop 检查据此放行;重置周期翻篇后自动失效,
   下个周期额度再达阈值时会重新拦截收尾——多周期循环由此自然形成。
4. 正常结束回复,不再发起新的大型工作。

## 看门狗 prompt(CronCreate 原文,自包含)

```text
这是 quota-guard 看门狗,严格按序执行,任何分支都要尽快结束:
1. 若 ~/.zcode/quota-handoff.md 不存在 → 任务不在无人值守状态,静默结束。
2. 复查额度:运行 node ~/.zcode/scripts/zcode-usage.mjs(该路径不存在时改用
   ~/.zcode/cli/plugins/cache/ 下 zcode-usage-guard 插件缓存内的同目录脚本)。
3. 若 5 小时池用量 ≥ 阈值(~/.zcode/scripts/quota-guard-settings.json 的 threshold,
   默认 95)→ 仍在限额期,静默结束,等下一轮。
4. 若交接文件标记了「任务已完成」→ 删除交接文件与 ~/.zcode/scripts/resume-armed.flag,
   用 CronDelete 删除本看门狗,向用户汇报后结束。
5. 否则(已重置且任务未完成)→ 先把自己的会话 id(echo $CLAUDE_SESSION_ID)登记进
   ~/.zcode/scripts/quota-guard-optin.json,再按交接文件「下一步」继续执行任务。
```

## 唤醒/恢复流程(看门狗触发或用户回到任务会话)

1. 复查额度(路径同上),确认低于阈值;仍超阈值 → 结束,等看门狗下一轮,不要空转消耗。
2. 读 `~/.zcode/quota-handoff.md`,必要时用 ReadSessionContext 按交接文件里的会话 id 找回细节。
3. 按「下一步」继续执行;任务完成或用户接管后:标记交接文件「任务已完成」→ 看门狗会自行
   CronDelete 并清理交接文件与 `resume-armed.flag`。

## 用户主动询问时

- "还剩多少额度/什么时候重置":运行 `node ~/.zcode/scripts/zcode-usage.mjs`(不存在时改用插件缓存同目录脚本)汇报,不要读快照文件猜数字。
- "帮我把这个任务跑到明天早上/跑 24 小时":评估额度是否够(不够就说明会自动跨几个重置周期);征得同意后按本协议布置看门狗再开工。
- "注意额度/别让任务断/这个任务要跑很久":登记当前会话并按需建看门狗;向用户说明只有该会话受管,其他对话零打扰。
