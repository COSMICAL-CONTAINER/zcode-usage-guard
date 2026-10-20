---
name: zcode-usage
description: 查询智谱 GLM Coding Plan 的用量与额度(5 小时 Prompt 池、每周额度、MCP 月度额度、当日模型用量)。当用户询问 Coding Plan 用量、剩余额度、何时重置等问题时使用,API Key 登录 ZCode 的用户同样可用。
allowed-tools: Bash, Read
---

# GLM Coding Plan 用量查询

执行本技能自带脚本(相对本技能的 base directory,即文末注入的路径):

```bash
node scripts/zcode-usage.mjs
```

若工作目录不在技能目录,使用绝对路径运行 `<base-directory>/scripts/zcode-usage.mjs`;Windows Git Bash 下也可用 glob 定位:

```bash
node "$(ls -d "$HOME/.zcode/cli/plugins/cache"/*/zcode-usage-guard/*/skills/zcode-usage/scripts/zcode-usage.mjs 2>/dev/null | sort -V | tail -1)"
```

脚本零依赖(Node >= 18),自动按顺序读取凭据:`--key/--base` 参数 → `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` 环境变量 → 手动配置文件 `~/.zcode/zcode-usage-manual.json`(悬浮窗「🔑 配置 API Key」界面写入,Windows/macOS/CLI 三端共用) → ZCode 配置 `~/.zcode/v2/config.json` 中已启用的 provider。**不要把 API Key 写进命令或文件**。

## 关键约束

- **只执行一次查询**,无论成功失败,立即返回结果,不要重试
- 成功:整理成中文表格汇报(5 小时池、每周额度、MCP 月度额度、当日用量含高峰期/非高峰期拆分),数字以脚本输出为准
- 失败:原样展示错误;提示用户可在悬浮窗点「🔑 配置 API Key」手动填写;HTTP 401 时提示检查 `~/.zcode/v2/config.json` 中的 API Key 或前往智谱开放平台「个人编程套餐 > 用量统计」
- 需要原始 JSON 时,运行同一命令并加 `--json` 参数
- 用户询问**历史水位/近期消耗趋势**(如"最近一周用得猛不猛""每个五小时周期用了多少")时,运行同一脚本加 `--quota-history`(纯本地读取采样历史,无需凭据、不发网络请求);逐条采样可 `--export-quota-csv <路径>` 导出。口径:窗口末次水位 = 各周期末次已用百分比按日平均(汇总按窗口加权);观测下界,周期最终使用率未知
- 用户想看**曲线图**时,运行 node ~/.zcode/scripts/quota-curve.mjs(独立浏览器窗口,悬浮窗右键「📈 用量曲线」同效);该命令立即返回,窗口由后台服务托管,不需要等待
