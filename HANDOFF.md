# HANDOFF — zcode-usage-guard 0.5.0 交接(给在 ZCode 中继续开发的 agent)

> 移植与交接留档。粘贴本文件给任何 agent 即可接手。

## 你接手的状态

仓库 `E:\github\zcode-usage-guard`(已推送 GitHub,HEAD `41fe9ce`,版本 0.5.0)。
0.4.0–0.5.0 两次提交新增**额度采样历史与用量曲线全家桶**(曲线页源自早期 Python/Tk 原型,已归为本插件原生功能)。

## 架构地图(改动涉及的文件)

| 文件 | 职责 |
|---|---|
| `skills/zcode-usage/scripts/zcode-usage.mjs` | 核心:凭据探测(ensureCred/findCred/setCred)、请求层 get、采样记录 recordSample/readSamples、周期/日汇总 periodsOf/dayConsumption、官方响应解析 parseModelUsage/parseToolUsage、API 估价(API_PRICES_CNY/estimateCostCny/costBreakdownCny/peakHourShareCny)、采样开关 samplesEnabled()、--quota-history/--export-quota-csv 视图、--install/--uninstall |
| `skills/zcode-usage/scripts/quota-curve.mjs` | 曲线服务+窗口:curvePayloadFromFile(JSONL→页面 periods)、modelsPayloadFor(代理+估价+30s 缓存)、127.0.0.1 服务、Edge/Chrome --app、单实例(端口文件)、闲置退出 |
| `skills/zcode-usage/scripts/curve.html` + `echarts.min.js` | 曲线页面(自 widget web/ 原样,仅改品牌),全家桶:今日默认视图/渐变填充/重置衔接/拖选/双击选周期(终点钳制到 now)/月视图/悬停公式/绝对时间戳缩放 |
| `skills/zcode-usage/scripts/zcode-usage-widget.ps1` | ⚙ 设置「额度采样记录」checkbox(quotaSamples 键)、右键「📈 用量曲线」 |
| `skills/zcode-usage/scripts/*.test.mjs` ×3 | node --test,36 用例全绿 |
| `PORT-PLAN.md` | 移植决策、语义守则、两轮评审(28 代理)全部发现与修复记录 |

## 不可破坏的不变量(违反即语义回归)

1. **观测口径**:采样只记观测事实——不回填、不插值、不把跨周期连起来;`resetAt<=at` 的过期
   窗口必须拒绝;`(at,resetAt,host)` 全文件去重;水位为 null/缺失/非有限数绝不落盘
   (Number(null)=0 陷阱,有单测钉死);周期最终使用率未知,展示层只说"水位/下界"。
2. **零依赖 Node>=18**:不许引入 npm 包;node:sqlite 只在 Node>=22.5 可选使用(参考 localSqliteStats 的门控写法)。
3. **凭据安全**:Key 只在进程内;曲线服务无凭据时优雅降级(/models 返回 {},曲线照常),绝不 process.exit。
4. **数据文件**:`~/.zcode/scripts/quota-samples.jsonl` 是用户数据,卸载不删;格式一行一 JSON
   `{at,resetAt,usedPct,level,host}`(epoch ms)。
5. **单文件分发**:`--install` 把 zcode-usage.mjs/PS1/曲线三件套复制到 ~/.zcode/scripts;改文件名/拆模块前先想 install/uninstall 同步。

## 测试与验证

```bash
cd /e/github/zcode-usage-guard
node --test plugins/zcode-usage-guard/skills/zcode-usage/scripts/*.test.mjs   # 36 用例
node plugins/zcode-usage-guard/skills/zcode-usage/scripts/quota-curve.mjs     # 实开曲线窗口
```

截图验证(无头,不真开窗):先 `node quota-curve.mjs --no-open --samples <文件>` 后台起服务,
再 `msedge --headless=new --screenshot=out.png --window-size=1280,1080 --virtual-time-budget=12000 <url>`。
注意:chrome-devtools MCP 的 Chrome 154 跑不了 echarts 5.5.1(setOption 吞系列),别用它验页面。

## 遗留 TODO(按优先级)

1. **PS1 checkbox 实机验证**:用户装 0.5.0 后打开 ⚙ 面板确认「额度采样记录」显示/保存正常
   (代码按既有 sessionInject 模式写,未实机跑过 WPF)。
2. **窗口尺寸自适应**:quota-curve 目前固定 1180×860;widget 的 curve_browser.py 有按主屏
   工作区计算的实现可抄。
3. **macOS 曲线窗口**:目前退化为系统默认浏览器打开(open);可换成 `open -na "Google Chrome"
   --args --app=<url>`。
4. **widget 历史导入器**:`--import-widget-db <sqlite>`(node:sqlite 门控,只读
   旧版悬浮窗在本机的历史库(%LOCALAPPDATA% 下)→ 追加 samples.jsonl,注意 (at,resetAt,host)
   去重与 provider→host 映射)。预览时已验证转换可行。
5. 曲线页 known-good:系列 id 用 provider@reset/@bstart 防 "id duplicates";dataZoom 用
   dispatchAction 后置(值直塞 option 会漂移);endValue 超出末采样会整体左移——动 curve.html 前读
   widget 仓库 docs/verification.md 的三个相关批次。

## 环境事实

- 本机已装插件版本 **0.2.0**(比仓库旧三版)——要在 ZCode 里市场更新到 0.5.0 才能吃到全部功能
- widget 项目仍在运行(Python 悬浮窗,5 分钟采样),两套历史并行无冲突
- quota-guard.mjs(阈值告警/续跑)本轮未动;settings JSON 键见 README
