# 浏览器日志采集 Demo

用于验证 `browser-open` 的持续采集能力：

- 首页加载后输出 console 日志
- 2 秒后输出"跳转前"日志并跳转到 `page2.html`
- 详情页继续输出日志和延迟日志

## 直接验证采集

1. 在被调试项目根目录初始化一次调试状态，并完成 `probe-verify`、`repro`（参考 `skills/bug-killer/SKILL.md`）。
2. 运行：

```bash
node <脚本> browser-open --url "file:///<仓库路径>/examples/browser-demo/index.html"
```

3. 等待 5 秒，浏览器自动完成页面跳转。
4. 查看采集结果：

```bash
cat .bugkiller/browser-events.log
```

应能看到：

- 首页加载日志和对象参数展开
- 跳转前的 `console.log` 和 `console.warn`
- 详情页加载日志和延迟日志

即页面跳转前的日志不会丢失。

## 已验证结果

在 Windows + Chrome + Node 24.11.1 环境实测通过，`collect` 报告：

- 日志源：`browser chrome:9222`，7 行
- 埋点命中：2/2
- 跳转前日志：`跳转前：准备进入详情页`、`跳转前：这是一条警告日志` 均在报告中
- 跳转后日志：`详情页加载完成`、`[BK:...:H1:P2]`、`详情页延迟日志` 均在报告中
