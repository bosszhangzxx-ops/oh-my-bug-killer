# oh-my-bug-killer

OpenCode 的「复现驱动排障」skill：先读代码提出假设，再插入日志埋点取证，引导用户复现、采集日志分析，用户确认修复方案后才改代码。

这是 **skill 版本**，不再依赖 OpenCode 插件。

## 安装

把 `skills/bug-killer` 复制到全局 skills 目录。

Windows PowerShell：

```powershell
$dest = "$env:USERPROFILE\.config\opencode\skills\bug-killer"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item .\skills\bug-killer\* $dest -Recurse -Force
```

macOS / Linux：

```bash
mkdir -p ~/.config/opencode/skills/bug-killer
cp -R skills/bug-killer/. ~/.config/opencode/skills/bug-killer/
```

复制后 OpenCode 会自动发现；如果列表里还没出现，执行 `/reload`。

## 使用

直接描述问题即可，例如：

```text
帮我排查一下：点击借出后接口 500，设备不存在时必现，期望返回 404 业务提示
```

也可以显式触发：

```text
@bug-killer 帮我定位这个报错
```

skill 会按下面的流程推进：

```text
收集问题 → 读代码提假设 → 埋点 → 启动调试浏览器 → 等用户复现
→ 采集日志分析 → 给出修复方案 → 用户确认
→ 修复 → 清理埋点 → 构建/测试 → 复盘
```

需要浏览器日志时，skill 会在复现前运行 `browser-open`，自动打开一个带调试端口的 Chrome/Edge，并持续采集页面日志，页面跳转或刷新都不会丢。

## 配置日志源

在**被调试项目**的 `.opencode/bug-killer.json` 中配置：

```json
{
  "markerPrefix": "BK",
  "browser": {
    "kind": "chrome",
    "port": 9222,
    "urlFilter": "localhost:5173"
  },
  "logSources": [
    { "type": "file", "path": "logs/app.log", "maxLines": 5000 },
    {
      "type": "command",
      "command": "docker logs --tail 2000 my-api",
      "timeoutMs": 20000
    }
  ],
  "maxCollectChars": 60000
}
```

相对路径按项目根目录解析。`browser` 段用于 `browser-open`：`kind` 为 `chrome` 或 `edge`，也可以用 `executable` 指定可执行文件路径；`port` 是起始端口，被占用时自动往后找；`urlFilter` 只采集 URL 或标题匹配的页面。

也可以不配置，采集时临时指定（这些是一次性抓取）：

```bash
node <脚本> collect --log logs/app.log
node <脚本> collect --command "docker logs --tail 2000 my-api"
node <脚本> collect --browser 9222
node <脚本> collect --browser http://127.0.0.1:9222 --browser-filter "localhost:5173"
```

### 自动识别项目日志源

在**被调试项目**根目录运行：

```bash
node <脚本> discover
```

输出包括：

- 识别到的技术栈（Java/Maven、Gradle、Next.js、Node、Python、Go、.NET、PHP 等）
- 候选日志文件，按最近修改时间排序
- Docker Compose、PM2、systemd、k8s 的终端命令建议（不会自动执行）
- 是否适合浏览器采集

把发现的日志文件写入配置：

```bash
node <脚本> discover --apply
```

没有配置任何日志源时，`collect` 会自动采用发现到的日志文件。

后端日志的三种来源：

- **日志文件**：`--log logs/app.log`，或由 `discover` 自动配置。Spring Boot 建议设置 `logging.file.name`，Python 建议 `PYTHONUNBUFFERED=1` 或 `print(..., flush=True)`
- **终端**：`--command "docker compose logs --tail 2000"`、`--command "pm2 logs --nostream --lines 2000"`、`--command "journalctl -u my-api -n 2000 --no-pager"`；本地开发进程把输出重定向到文件后用 `--log`
- **控制台**：前端页面用 `browser-open`

### 浏览器 console 日志（CDP）

推荐流程是在复现前运行 `browser-open`：

```bash
node <脚本> browser-open
node <脚本> browser-open --url http://localhost:5173
```

它会：

- 自动查找 Chrome，找不到再用 Edge（Chrome 优先）；也可以用 `--browser <路径>` 指定
- 使用独立用户目录（`.bugkiller/browser-profile`）和自动选择的端口启动，不需要手动带参数
- 同时启动后台监听进程，持续采集 `console.log/warn/error`、未捕获异常和浏览器错误日志
- 页面跳转、刷新期间持续记录，不依赖 DevTools 的保留日志
- 用户复现完成后，`collect` 自动停止监听并纳入这些日志

要求：

- Node 22+（使用内置 WebSocket；`file` / `command` 源仍支持 Node 18+）
- 本机安装 Chrome 或 Edge

注意：

- 启动的是全新配置的浏览器实例，需要重新登录项目
- 页面关闭瞬间的极少数日志可能丢失；正常跳转、刷新不受影响
- 停止监听用 `browser-stop`，加 `--close` 可同时关闭浏览器

## 状态文件

skill 会在被调试项目里创建：

```text
.bugkiller/
├── .gitignore          # 内容为 *，整个目录不会被 git 跟踪
├── state.json          # 当前调试状态，不要手动编辑
├── hypotheses.json     # 假设载荷（临时）
├── steps.json          # 复现步骤载荷（临时）
├── plan.json           # 修复方案载荷（临时）
├── browser-session.json # 调试浏览器监听会话
├── browser-events.log  # 持续采集的浏览器日志
├── browser-listen.log  # 监听进程日志
└── browser-profile/    # 调试浏览器用户目录（reset 不会删除）
```

一个项目同时只保留一份调试状态。开始新问题前先运行 `reset`；如果还有未清理的埋点，需要 `reset --force`（只清状态，不删代码里的日志）。

## 脚本命令

脚本位于 `skills/bug-killer/scripts/bugkiller.mjs`，零依赖，Node 18+ 可运行（`browser` 日志源需要 Node 22+）。在项目根目录执行：

```text
status                          查看当前阶段、假设、埋点和下一步
begin --symptom "..."           开始或补充问题
hypothesize --file ...          提交假设，进入埋点阶段
probe-add ...                   登记一条埋点，返回 marker 和日志模板
probe-verify                    检查所有 marker 是否写入文件
discover [--json] [--apply]     识别技术栈、日志文件和终端命令建议
repro --file ...                记录复现步骤，进入等待复现阶段
browser-open [--url ...]        启动调试浏览器并持续采集浏览器日志
browser-stop [--close]          停止浏览器日志监听，可选关闭浏览器
collect [--log|--command|--browser] 采集日志并生成分析报告
plan --file ...                 提交修复方案，等待用户确认
confirm                         记录用户已确认
apply                           进入修复阶段
cleanup [--apply]               预览或删除日志埋点
finish --summary "..."          标记本次调试完成
reset [--force]                 清空调试状态
```

完整用法：

```bash
node skills/bug-killer/scripts/bugkiller.mjs --help
```

## 与插件版的差异

| 能力 | 插件版 | skill 版 |
| --- | --- | --- |
| 编辑门禁 | 按阶段硬拒绝 edit/write | 只能靠 skill 规则约束 |
| 阶段上下文 | 每轮自动注入 | skill 加载后常驻上下文 |
| 状态栏 | 有 | 无 |
| `/debug` `/done` `/apply` | 有 | 无，用自然语言或 `@bug-killer` |
| agent 自动切换 | 有 | 无，在任意 agent 里使用 |
| 埋点登记/校验 | 插件工具 | 辅助脚本 |
| 日志采集/清理 | 插件工具 | 辅助脚本 |
| 状态恢复 | 插件存储 | 项目内 `.bugkiller/state.json` |

## 仓库结构

```text
skills/bug-killer/
├── SKILL.md
└── scripts/
    └── bugkiller.mjs

examples/demo-app/
├── app.log
└── server.mjs

examples/browser-demo/
├── README.md
├── index.html
└── page2.html
```

`examples/demo-app` 用于演示和回归测试，不影响 skill 安装。`examples/browser-demo` 用于验证浏览器日志采集和跨页面跳转。`bugkiller.mjs` 脚本和 `SKILL.md` 文档是唯一需要安装的文件。

## 本地开发

修改 `skills/bug-killer/` 后，重新复制到全局目录并执行 `/reload`。至少运行：

```bash
node --check skills/bug-killer/scripts/bugkiller.mjs
```

建议再在临时项目里跑一遍完整流程：`discover → begin → hypothesize → probe-add → probe-verify → repro → browser-open → collect → plan → confirm → apply → cleanup --apply → finish`。

## License

MIT
