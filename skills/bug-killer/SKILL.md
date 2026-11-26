---
name: Bug Killer
description: 复现驱动排障：先读代码提出假设，再插入日志埋点取证，引导用户复现、采集日志分析，用户确认修复方案后才改代码。用于排查报错、异常数据、接口 500、偶现 bug、前后端问题定位。
---

# Bug Killer

你的目标不是“猜一个原因然后改代码”，而是：**先取证，再定位，最后在用户确认后修复**。

## 适用与不适用

适用：

- 用户报告报错、异常、接口 500、数据不对、偶现问题
- 需要定位“哪条分支没走到 / 参数是什么 / 状态为什么不对”
- 前后端联调问题，需要看日志和调用链

不适用：

- 纯功能开发、页面改版、依赖升级
- 用户明确要求直接改代码，且问题原因已经确定
- 没有代码访问权限、也无法提供日志的场景

## 铁律

1. **先取证，再下结论。** 不要在没有日志或代码证据时直接改代码。
2. **用户明确确认修复方案前，不要修改项目代码。** 唯一允许写入的是 `.bugkiller/` 下的状态和载荷文件，以及 `instrument`（埋点）阶段插入的日志行。
3. **埋点必须先登记。** 每条日志都要先运行 `probe-add` 拿到 marker，再把 marker 原样写入代码；日志必须单独占一行。
4. **不要编造日志、执行结果或文件内容。** 不确定就继续读代码或问用户。
5. **不要做与当前问题无关的重构、格式化或依赖升级。**
6. **修复方案必须等用户明确同意后才能实施。** “看一下”“你觉得呢”不算确认。

## 脚本位置

本 skill 自带 `scripts/bugkiller.mjs`。实际安装路径：

- Windows：`%USERPROFILE%\.config\opencode\skills\bug-killer\scripts\bugkiller.mjs`
- macOS / Linux：`~/.config/opencode/skills/bug-killer/scripts/bugkiller.mjs`

在**项目根目录**执行。PowerShell 示例：

```powershell
node "$env:USERPROFILE\.config\opencode\skills\bug-killer\scripts\bugkiller.mjs" status
```

bash 示例：

```bash
node ~/.config/opencode/skills/bug-killer/scripts/bugkiller.mjs status
```

如果项目内也有 `.opencode/skills/bug-killer/scripts/bugkiller.mjs`，优先用项目内版本。

脚本会维护：

- `<项目>/.bugkiller/state.json`：当前调试状态，不要手动编辑
- `<项目>/.bugkiller/*.json`：临时载荷文件
- `<项目>/.opencode/bug-killer.json`：日志源配置（可选）

---

## 工作流

### 第 0 步：先看状态

每次开始排查，先运行：

```bash
node <脚本> status
```

- 有进行中的调试：从当前阶段继续，先告诉用户现在在哪一步。
- 没有状态：进入第 1 步。
- 阶段是 `done`：本次已结束；用户开始新问题时，运行 `reset` 后再 `begin`。
- 有未清理埋点又要开始新问题：先清理，或征得用户同意后 `reset --force`（不会删除代码里的日志）。

### 第 1 步：收集问题（intake）

用户可能只说“帮我看看”。信息不足时追问：

- **现象**：看到了什么错误、异常或错误数据？
- **触发路径**：哪个页面、接口或操作？
- **期望结果**：正常情况下应该是什么？
- **频率与环境**：必现还是偶现？只在某个环境出现？

用户已经给出完整信息时，不要重复询问。信息足够后运行：

```bash
node <脚本> begin --symptom '问题现象、触发路径、期望结果'
```

后续补充信息：

```bash
node <脚本> begin --symptom '补充后的完整描述' --notes '频率、环境、报错文本'
```

`begin` 会把阶段推进到 `diagnose`。不要在这一步读大量代码或改文件。

### 第 2 步：诊断与假设（diagnose）

用 `grep` / `read` 定位相关代码，沿调用链确认：

- 请求入口、参数校验、分支条件
- 状态变更、事务边界、异步回调
- 异常处理与日志

给出 **2-4 个按可能性排序的假设**，每个包含：原因、代码依据（文件:行）、置信度、验证方法。

把假设写进 `.bugkiller/hypotheses.json`：

```json
[
  {
    "id": "H1",
    "cause": "错误码分支没有兜底，item 为空时继续读取 status",
    "evidence": "src/borrow.ts:18",
    "confidence": "high",
    "verify": "打印 item 和 id，确认是否命中 not found 分支"
  },
  {
    "id": "H2",
    "cause": "并发借出导致状态被覆盖",
    "evidence": "src/borrow.ts:31",
    "confidence": "medium",
    "verify": "打印进入 borrow 前的 status 和返回后的 status"
  }
]
```

运行：

```bash
node <脚本> hypothesize --file .bugkiller/hypotheses.json
```

然后把假设列表展示给用户。提交后自动进入 `instrument`，不需要用户确认。

### 第 3 步：埋点（instrument）

为每个假设选 1-3 个关键位置，逐条登记：

```bash
node <脚本> probe-add --hypothesis H1 --file src/borrow.ts --line 18 --code "id, item, item?.status" --note "确认 item 是否为空"
```

脚本会返回：

- 唯一 marker，例如 `[BK:ab12cd:H1:P1]`
- 当前行内容
- 对应语言的日志模板

按模板把日志插入代码。模板只是示意，多个表达式要按语言语法拼接（例如 Java 用 `log.info("marker {} {}", a, b)` 或字符串拼接）。规则：

- marker 必须原样保留
- 日志单独占一行
- 不要改动原有业务逻辑
- 不要打印密码、token、身份证等敏感信息
- Java 用 `log.info` 或 `System.out.println`，前端用 `console.log`，Python 用 `print`，Go 用 `fmt.Println`，C# 用 `Console.WriteLine`

全部插入后运行：

```bash
node <脚本> probe-verify
```

如果提示 marker 未找到，补齐后再运行一次。**不要跳过校验。**

### 第 4 步：引导复现（await_repro）

写 `.bugkiller/steps.json`：

```json
{
  "steps": [
    {
      "action": "打开借出页面，输入设备编号 NOT-EXIST，点击借出",
      "expect": "接口返回 404 或业务提示，不应出现 500",
      "watch": "控制台是否出现 [BK:...:H1:P1]"
    },
    {
      "action": "用正常编号 E-1 再借出一次",
      "expect": "借出成功",
      "watch": "对比两次的 item 和 status"
    }
  ]
}
```

运行：

```bash
node <脚本> repro --file .bugkiller/steps.json
```

脚本会校验所有 marker 已就位，打印 ASCII 复现流程。把流程完整展示给用户，然后**停止**：

- 不要继续分析
- 不要修改代码
- 告诉用户操作完成后回复“已完成”

### 第 5 步：采集与分析（collect / analyze）

用户回复“已完成”后运行：

```bash
node <脚本> collect
```

如果提示没有日志源，可以让用户配置 `.opencode/bug-killer.json`，或临时传（传了 `--log` / `--command` 时只使用传入的源）：

```bash
node <脚本> collect --log logs/app.log
node <脚本> collect --command "docker logs --tail 2000 my-api"
```

分析时重点看：

- **命中的埋点**：走到了哪条路径，变量值是什么，和假设是否一致
- **未命中的埋点**：哪段代码没有执行，是不是分支没进、请求没到、日志级别被过滤、埋点位置不对
- **错误行**：异常类型、堆栈、发生时间与埋点的时间关系

逐条判断假设：**成立 / 不成立 / 证据不足**。不要在这一步改代码。

### 第 6 步：修复方案（fix_plan）

写 `.bugkiller/plan.json`：

```json
{
  "rootCause": "borrow 在 item 不存在时没有提前返回，继续读取 item.status 导致 TypeError",
  "hypothesisId": "H1",
  "changes": [
    "src/borrow.ts: 在 item 为空时直接返回 { ok: false, reason: 'not found' }",
    "src/borrow.ts: 调用方根据 reason 返回 404，不再落到 500"
  ],
  "risks": ["需要确认调用方是否依赖原有异常行为"],
  "verification": ["npm test", "手动复现 NOT-EXIST 和 E-1 两条路径"]
}
```

运行：

```bash
node <脚本> plan --file .bugkiller/plan.json
```

向用户展示：

1. 根因（一句话）
2. 改动点（文件 + 具体做法）
3. 风险与影响范围
4. 验证方式

最后明确问：“是否按这个方案修复？确认后我将开始修改。”然后**停止等待**。

### 第 7 步：修复与验证（fix / verify）

只有用户明确回复“确认”“同意”“按这个方案”“开始修复”等，才运行：

```bash
node <脚本> confirm
node <脚本> apply
```

然后：

- 只改方案里列出的内容
- 不要顺手改无关代码
- 修改完成后运行：

```bash
node <脚本> cleanup --apply
```

清理成功后，运行项目现有的构建/测试（如 `mvn compile -DskipTests`、`npm test`、`npm run lint`）。

验证通过后运行：

```bash
node <脚本> finish --summary '根因与修复结果的一句话复盘'
```

最后给一份简短复盘：根因、改动、验证结果。

---

## 命令速查

```text
status                          查看当前阶段、假设、埋点和下一步
begin --symptom "..."           开始或补充问题
hypothesize --file ...          提交假设，进入埋点阶段
probe-add ...                   登记一条埋点，返回 marker 和模板
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

## 日志源配置

在项目 `.opencode/bug-killer.json` 中配置：

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

相对路径按项目根目录解析。浏览器 console 日志需要用户手动粘贴。

## 常见错误

- **`hypothesize` 报阶段不对**：先运行 `begin` 记录问题。
- **`probe-verify` 找不到 marker**：检查日志行是否原样包含 marker，是否被格式化工具改写。
- **`repro` 报还有埋点没写入**：先补齐并运行 `probe-verify`。
- **`collect` 说没有日志源**：配置 `logSources`，或用 `--log` / `--command` 临时指定。
- **`apply` 被拒绝**：用户还没有确认，先运行 `confirm`；确认必须是用户明确说的。
- **`cleanup` 有残留**：marker 可能和业务代码在同一行，需要手动删除该日志行。
- **想放弃当前调试**：先尝试清理；确实要放弃时运行 `reset --force`，它只清状态，不删代码里的日志。

## 输出风格

- 中文，结论优先，简洁
- 流程图用 ASCII，不要用 Mermaid（终端不渲染）
- 不要输出大段代码，除非用户要求
- 每次阶段变化，用一句话告诉用户当前在做什么、下一步需要他做什么

## 限制

- skill 没有硬门禁，无法像插件一样拒绝 `edit` / `write`；必须自觉遵守“确认前不改代码”
- 一个项目同时只保留一份调试状态，多会话并行会互相覆盖
- 自动清理只处理“marker 单独占一行”的日志
- 全局安装的副本需要手动更新
