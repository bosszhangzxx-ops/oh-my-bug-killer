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
收集问题 → 读代码提假设 → 埋点 → 等用户复现
→ 采集日志分析 → 给出修复方案 → 用户确认
→ 修复 → 清理埋点 → 构建/测试 → 复盘
```

## 配置日志源

在**被调试项目**的 `.opencode/bug-killer.json` 中配置：

```json
{
  "markerPrefix": "BK",
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

相对路径按项目根目录解析。浏览器 console 日志需要手动粘贴到对话里。

也可以不配置，采集时临时指定：

```bash
node <脚本> collect --log logs/app.log
node <脚本> collect --command "docker logs --tail 2000 my-api"
```

## 状态文件

skill 会在被调试项目里创建：

```text
.bugkiller/
├── .gitignore        # 内容为 *，整个目录不会被 git 跟踪
├── state.json        # 当前调试状态，不要手动编辑
├── hypotheses.json   # 假设载荷（临时）
├── steps.json        # 复现步骤载荷（临时）
└── plan.json         # 修复方案载荷（临时）
```

一个项目同时只保留一份调试状态。开始新问题前先运行 `reset`；如果还有未清理的埋点，需要 `reset --force`（只清状态，不删代码里的日志）。

## 脚本命令

脚本位于 `skills/bug-killer/scripts/bugkiller.mjs`，零依赖，Node 18+ 可运行。在项目根目录执行：

```text
status                          查看当前阶段、假设、埋点和下一步
begin --symptom "..."           开始或补充问题
hypothesize --file ...          提交假设，进入埋点阶段
probe-add ...                   登记一条埋点，返回 marker 和日志模板
probe-verify                    检查所有 marker 是否写入文件
repro --file ...                记录复现步骤，进入等待复现阶段
collect [--log|--command]       采集日志并生成分析报告
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
```

`examples/demo-app` 用于演示和回归测试，不影响 skill 安装。

## 本地开发

修改 `skills/bug-killer/` 后，重新复制到全局目录并执行 `/reload`。至少运行：

```bash
node --check skills/bug-killer/scripts/bugkiller.mjs
```

建议再在临时项目里跑一遍完整流程：`begin → hypothesize → probe-add → probe-verify → repro → collect → plan → confirm → apply → cleanup --apply → finish`。

## License

MIT
