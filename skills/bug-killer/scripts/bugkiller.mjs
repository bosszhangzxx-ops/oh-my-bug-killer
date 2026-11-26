#!/usr/bin/env node
/**
 * bugkiller.mjs — helper CLI for the bug-killer skill.
 * Zero dependencies. Requires Node 18+.
 * The browser log source uses the built-in WebSocket, so it requires Node 22+.
 *
 * State file: <project>/.bugkiller/state.json
 * Log config: <project>/.opencode/bug-killer.json
 */

import { exec } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

const execAsync = promisify(exec)

const STATE_DIR = ".bugkiller"
const STATE_FILE = join(STATE_DIR, "state.json")
const CONFIG_FILE = join(".opencode", "bug-killer.json")

const PHASES = [
  "idle",
  "intake",
  "diagnose",
  "instrument",
  "await_repro",
  "collect",
  "analyze",
  "fix_plan",
  "fix",
  "verify",
  "done"
]

const PHASE_LABEL = {
  idle: "空闲",
  intake: "收集问题",
  diagnose: "诊断中",
  instrument: "埋点中",
  await_repro: "等待复现",
  collect: "采集日志",
  analyze: "分析中",
  fix_plan: "等待确认方案",
  fix: "修复中",
  verify: "验证中",
  done: "已完成"
}

const DEFAULT_CONFIG = {
  markerPrefix: "BK",
  logSources: [],
  maxLogBytes: 2 * 1024 * 1024,
  maxLogLines: 5000,
  maxCollectChars: 60000
}

const LOG_LINE =
  /^\s*(?:\/\/|#|\*|\/\*)?\s*(?:console\.(?:log|debug|info|warn|error)|log(?:ger)?\.(?:info|debug|warn|error|trace)|System\.out\.print(?:ln)?|print|printf|fmt\.Print(?:ln|f)?|Debug\.Log|LOGGER\.(?:info|debug|warn|error|trace))\b/

const ERROR_LINE =
  /(\bERROR\b|\bFATAL\b|\bSEVERE\b|\bException\b|Caused by:|\bpanic\b|\bCRITICAL\b|\[pageerror\]|\[console\.(?:error|warn|assert)\]|\[browser\.(?:error|warning)\])/
const TIMESTAMP = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/

/* ------------------------------------------------------------------ */
/* generic helpers                                                     */
/* ------------------------------------------------------------------ */

function fail(message) {
  console.error(`[bugkiller] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === "--") {
      out._.push(...argv.slice(index + 1))
      break
    }
    if (!token.startsWith("--")) {
      out._.push(token)
      continue
    }
    const equals = token.indexOf("=")
    let key
    let value
    if (equals >= 0) {
      key = token.slice(2, equals)
      value = token.slice(equals + 1)
    } else {
      key = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) {
        value = true
      } else {
        value = next
        index++
      }
    }
    if (out[key] === undefined) out[key] = value
    else if (Array.isArray(out[key])) out[key].push(value)
    else out[key] = [out[key], value]
  }
  return out
}

function arr(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function bool(value) {
  return value === true || value === "true" || value === "1" || value === "yes"
}

function text(value, fallback = "") {
  if (value === undefined || value === null || value === true) return fallback
  return String(value)
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function clip(value, limit) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n...（输出已截断，共 ${value.length} 字符；可调大 maxCollectChars 或收窄日志源）`
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未记录"
}

function parseTime(line) {
  const match = TIMESTAMP.exec(line)
  if (!match) return undefined
  const value = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  ).getTime()
  return Number.isFinite(value) ? value : undefined
}

/* ------------------------------------------------------------------ */
/* project paths and state                                             */
/* ------------------------------------------------------------------ */

function statePath(project) {
  return join(project, STATE_DIR, "state.json")
}

function normalizeState(raw, project) {
  const now = Date.now()
  const base = {
    version: 1,
    runId: randomBytes(3).toString("hex"),
    projectRoot: project,
    phase: "idle",
    symptom: "",
    hypotheses: [],
    probes: [],
    reproSteps: [],
    createdAt: now,
    updatedAt: now
  }
  const state = { ...base, ...(raw && typeof raw === "object" ? raw : {}) }
  state.projectRoot = project
  state.hypotheses = Array.isArray(state.hypotheses) ? state.hypotheses : []
  state.probes = Array.isArray(state.probes) ? state.probes : []
  state.reproSteps = Array.isArray(state.reproSteps) ? state.reproSteps : []
  if (!PHASES.includes(state.phase)) state.phase = "idle"
  if (!state.runId) state.runId = randomBytes(3).toString("hex")
  return state
}

async function loadState(project) {
  try {
    const raw = await readFile(statePath(project), "utf8")
    return normalizeState(JSON.parse(raw), project)
  } catch {
    return undefined
  }
}

async function saveState(project, state) {
  state.updatedAt = Date.now()
  const dir = join(project, STATE_DIR)
  await mkdir(dir, { recursive: true })
  const ignore = join(dir, ".gitignore")
  if (!existsSync(ignore)) await writeFile(ignore, "*\n", "utf8")
  await writeFile(statePath(project), `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

async function requireState(project) {
  const state = await loadState(project)
  if (!state) {
    fail(
      [
        "当前项目没有调试状态。先收集问题，然后运行：",
        `  node <脚本> begin --symptom '问题现象、触发路径、期望结果'`,
        "",
        "如果是继续之前的调试，先运行 status 查看状态。"
      ].join("\n")
    )
  }
  return state
}

function nextHint(state) {
  switch (state.phase) {
    case "idle":
      return "让用户描述问题，然后运行 begin --symptom '...'"
    case "intake":
      return "让用户描述问题，然后运行 begin --symptom '...'"
    case "diagnose":
      return "只读代码定位可疑链路，给出 2-4 个假设，写 hypotheses.json 后运行 hypothesize --file"
    case "instrument":
      return "用 probe-add 登记埋点并插入日志，全部完成后运行 probe-verify"
    case "await_repro":
      return "等待用户复现；用户回复完成后运行 collect"
    case "collect":
      return "运行 collect 采集日志"
    case "analyze":
      return "对照假设分析日志，写 plan.json 后运行 plan --file"
    case "fix_plan":
      return "向用户展示方案并等待明确确认；确认后运行 confirm，再运行 apply"
    case "fix":
      return "按已确认方案修改代码，完成后运行 cleanup --apply"
    case "verify":
      return "运行项目现有的构建/测试，然后运行 finish --summary '...'"
    case "done":
      return "本次调试已结束；运行 reset 后可开始新问题"
    default:
      return "运行 status 查看状态"
  }
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

function isLogSource(value) {
  if (!value || typeof value !== "object") return false
  if (value.type === "file") return typeof value.path === "string" && value.path.length > 0
  if (value.type === "command") return typeof value.command === "string" && value.command.length > 0
  if (value.type === "browser") {
    if (value.url !== undefined && (typeof value.url !== "string" || !value.url.trim())) return false
    if (value.port !== undefined) {
      const port = Number(value.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return false
    }
    return true
  }
  return false
}

function parseConfig(raw) {
  const prefix =
    typeof raw.markerPrefix === "string" && raw.markerPrefix.trim()
      ? raw.markerPrefix.trim().replace(/[^A-Za-z0-9_-]/g, "")
      : "BK"
  return {
    markerPrefix: prefix || "BK",
    logSources: Array.isArray(raw.logSources) ? raw.logSources.filter(isLogSource) : [],
    maxLogBytes: positiveNumber(raw.maxLogBytes, DEFAULT_CONFIG.maxLogBytes),
    maxLogLines: positiveNumber(raw.maxLogLines, DEFAULT_CONFIG.maxLogLines),
    maxCollectChars: positiveNumber(raw.maxCollectChars, DEFAULT_CONFIG.maxCollectChars)
  }
}

async function readConfig(project) {
  try {
    const raw = await readFile(join(project, CONFIG_FILE), "utf8")
    return parseConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_CONFIG, logSources: [] }
  }
}

/* ------------------------------------------------------------------ */
/* file and marker helpers                                             */
/* ------------------------------------------------------------------ */

function toRelative(project, file) {
  const absolute = isAbsolute(file) ? file : resolve(project, file)
  return relative(project, absolute).replaceAll("\\", "/")
}

function toAbsolute(project, file) {
  return isAbsolute(file) ? file : resolve(project, file)
}

async function readLines(path) {
  const content = await readFile(path, "utf8")
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  return { lines: content.split(/\r?\n/), eol }
}

async function writeLines(path, lines, eol) {
  await writeFile(path, lines.join(eol), "utf8")
}

async function readTail(path, maxBytes, maxLines) {
  const handle = await open(path, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { source: path, lines: [], error: "不是普通文件" }
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    if (length <= 0) return { source: path, lines: [] }

    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let value = buffer.toString("utf8")
    if (start > 0) {
      const firstBreak = value.indexOf("\n")
      if (firstBreak >= 0) value = value.slice(firstBreak + 1)
    }

    const all = value.split(/\r?\n/).filter((line) => line.length > 0)
    const note = all.length > maxLines ? `仅保留最后 ${maxLines} 行` : undefined
    return { source: path, lines: maxLines > 0 ? all.slice(-maxLines) : all, note }
  } finally {
    await handle.close()
  }
}

async function readCommand(source, project) {
  try {
    const { stdout, stderr } = await execAsync(source.command, {
      cwd: source.cwd ? resolve(project, source.cwd) : project,
      timeout: positiveNumber(Number(source.timeoutMs), 20000),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      shell: source.shell
    })
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`
    return {
      source: `$ ${source.command}`,
      lines: output.split(/\r?\n/).filter((line) => line.length > 0)
    }
  } catch (error) {
    return {
      source: `$ ${source.command}`,
      lines: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/* ------------------------------------------------------------------ */
/* browser (CDP) log source                                            */
/* ------------------------------------------------------------------ */

const CDP_DEFAULT_PORT = 9222
const CDP_DEFAULT_WAIT_MS = 1200
const CDP_DEFAULT_MAX_EVENTS = 1000

function browserEndpoint(source) {
  const raw = typeof source.url === "string" ? source.url.trim() : ""
  if (raw) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
    const url = new URL(withScheme)
    if (!url.port) url.port = String(CDP_DEFAULT_PORT)
    return url.origin
  }
  const port = Number(source.port)
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : CDP_DEFAULT_PORT}`
}

function isPageTarget(target) {
  return (
    target &&
    target.type === "page" &&
    typeof target.webSocketDebuggerUrl === "string" &&
    /^(https?|file):/i.test(String(target.url || ""))
  )
}

async function fetchCdpJson(url, timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function shorten(value, limit = 1000) {
  const str = String(value)
  return str.length > limit ? `${str.slice(0, limit)}…` : str
}

function shortUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === "file:" ? url.pathname : `${url.host}${url.pathname}${url.search}`
  } catch {
    return String(value)
  }
}

function toEpochMs(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return Date.now()
  return Math.round(num < 1e12 ? num * 1000 : num)
}

function formatStamp(value) {
  const date = new Date(toEpochMs(value))
  const pad = (num) => String(num).padStart(2, "0")
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  ].join(" ")
}

function serializeRemoteObject(value) {
  if (!value || typeof value !== "object") return "undefined"
  if (value.type === "string") return String(value.value ?? "")
  if (value.unserializableValue !== undefined) return String(value.unserializableValue)
  if (value.value === null) return "null"
  if (value.value !== undefined && typeof value.value !== "object") return String(value.value)

  const preview = value.preview
  if (preview) {
    const props = Array.isArray(preview.properties)
      ? preview.properties.map((prop) => `${prop.name}: ${prop.value ?? prop.type}`).join(", ")
      : ""
    const tail = preview.overflow ? (props ? ", …" : "…") : ""
    const description = preview.description || value.description || "Object"
    const label = description === "Object" ? "" : description
    return `${label}{${props}${tail}}`
  }
  return String(value.description ?? value.type ?? "unknown")
}

function serializePropertyValue(value) {
  if (!value || typeof value !== "object") return "undefined"
  if (value.type === "string") return JSON.stringify(value.value ?? "")
  return serializeRemoteObject(value)
}

function formatPropertyPreview(value, properties) {
  const list = (Array.isArray(properties) ? properties : [])
    .filter((prop) => prop && typeof prop.name === "string" && !prop.name.startsWith("[["))
    .filter((prop) => prop.value)
    .slice(0, 20)
  if (!list.length) return undefined

  if (value.subtype === "array") {
    const body = list.map((prop) => shorten(serializePropertyValue(prop.value), 120)).join(", ")
    const label = value.description && value.description !== "Array" ? `${value.description} ` : ""
    return `${label}[${body}${list.length === 20 ? ", …" : ""}]`
  }

  const body = list
    .map((prop) => `${prop.name}: ${shorten(serializePropertyValue(prop.value), 120)}`)
    .join(", ")
  return `{${body}${list.length === 20 ? ", …" : ""}}`
}

function canPreview(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.objectId &&
      value.type === "object" &&
      (value.subtype === undefined || value.subtype === "array")
  )
}

async function serializeConsoleArg(value, sendCommand, budget) {
  if (!value || typeof value !== "object") return "undefined"
  if (value.type === "string") return String(value.value ?? "")
  if (value.unserializableValue !== undefined) return String(value.unserializableValue)
  if (value.value === null) return "null"
  if (value.value !== undefined && typeof value.value !== "object") return String(value.value)

  if (canPreview(value) && budget.left > 0) {
    budget.left--
    try {
      const result = await sendCommand("Runtime.getProperties", {
        objectId: value.objectId,
        ownProperties: true,
        generatePreview: true
      })
      const preview = formatPropertyPreview(value, result?.result)
      if (preview) return preview
    } catch {
      // 对象预览失败时退回 description
    }
  }
  return serializeRemoteObject(value)
}

async function formatConsoleEvent(params, sendCommand, budget) {
  const type = params.type === "warning" ? "warn" : String(params.type || "log")
  const args = Array.isArray(params.args) ? params.args : []
  const parts = []
  for (const arg of args) parts.push(await serializeConsoleArg(arg, sendCommand, budget))
  const frame = params.stackTrace?.callFrames?.[0]
  const location =
    frame && frame.url ? ` @ ${shortUrl(frame.url)}:${Number(frame.lineNumber) + 1}` : ""
  return `${formatStamp(params.timestamp)} [console.${type}] ${shorten(parts.join(" "))}${location}`
}

function formatExceptionEvent(params) {
  const details = params.exceptionDetails || {}
  const text = details.exception?.description || details.text || "Uncaught exception"
  const location =
    details.url ? ` @ ${shortUrl(details.url)}:${Number(details.lineNumber) + 1}` : ""
  return `${formatStamp(params.timestamp)} [pageerror] ${shorten(text, 1200)}${location}`
}

function formatBrowserLog(params) {
  const entry = params.entry || {}
  const level = String(entry.level || "")
  if (level !== "error" && level !== "warning") return undefined
  const source = entry.source ? `[${entry.source}] ` : ""
  const location = entry.url ? ` @ ${shortUrl(entry.url)}` : ""
  return `${formatStamp(entry.timestamp)} [browser.${level}] ${source}${shorten(entry.text || "")}${location}`
}

function captureBrowserTarget(target, waitMs, maxEvents) {
  const source = `browser ${target.url || target.id}`
  return new Promise((resolve) => {
    const events = []
    const lines = []
    const pending = new Map()
    const budget = { left: 50 }
    let settled = false
    let finishing = false
    let truncated = false
    let socket
    let timer
    let openTimer
    let nextId = 0

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(openTimer)
      for (const entry of pending.values()) entry.reject(new Error("采集已结束"))
      pending.clear()
      try {
        socket?.close()
      } catch {
        // already closed
      }
      resolve({ source, lines, error })
    }

    const sendCommand = (method, params = {}, timeoutMs = 1000) =>
      new Promise((resolveCommand, rejectCommand) => {
        if (settled) {
          rejectCommand(new Error("采集已结束"))
          return
        }
        const id = ++nextId
        const timeout = setTimeout(() => {
          pending.delete(id)
          rejectCommand(new Error(`${method} 超时`))
        }, timeoutMs)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout)
            resolveCommand(value)
          },
          reject: (error) => {
            clearTimeout(timeout)
            rejectCommand(error)
          }
        })
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          clearTimeout(timeout)
          pending.delete(id)
          rejectCommand(error)
        }
      })

    const flush = async () => {
      if (finishing) return
      finishing = true
      clearTimeout(timer)
      const deadline = Date.now() + 5000

      for (const event of events) {
        if (settled) return
        if (Date.now() > deadline) break
        if (event.kind === "console") {
          lines.push(await formatConsoleEvent(event.params, sendCommand, budget))
        } else if (event.kind === "exception") {
          lines.push(formatExceptionEvent(event.params))
        } else if (event.kind === "log") {
          const line = formatBrowserLog(event.params)
          if (line) lines.push(line)
        }
        if (settled) return
      }

      if (truncated) lines.push(`…（已达到 maxEvents=${maxEvents}，后续事件未采集）`)
      finish()
    }

    try {
      socket = new WebSocket(target.webSocketDebuggerUrl)
    } catch (error) {
      resolve({ source, lines, error: error instanceof Error ? error.message : String(error) })
      return
    }

    openTimer = setTimeout(() => finish("连接 WebSocket 超时"), 5000)
    timer = setTimeout(() => finish(), waitMs + 5000)

    socket.onopen = () => {
      clearTimeout(openTimer)
      clearTimeout(timer)
      try {
        socket.send(JSON.stringify({ id: ++nextId, method: "Runtime.enable" }))
        socket.send(JSON.stringify({ id: ++nextId, method: "Log.enable" }))
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error))
        return
      }
      timer = setTimeout(() => void flush(), waitMs)
    }
    socket.onerror = () => finish("WebSocket 连接失败")
    socket.onclose = () => finish()
    socket.onmessage = (event) => {
      if (settled) return
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }

      if (message.id !== undefined) {
        const entry = pending.get(message.id)
        if (entry) {
          pending.delete(message.id)
          if (message.error) entry.reject(new Error(message.error.message || "CDP 调用失败"))
          else entry.resolve(message.result)
        }
        return
      }

      if (finishing) return
      if (events.length >= maxEvents) {
        truncated = true
        void flush()
        return
      }

      let kind
      if (message.method === "Runtime.consoleAPICalled") kind = "console"
      else if (message.method === "Runtime.exceptionThrown") kind = "exception"
      else if (message.method === "Log.entryAdded") kind = "log"
      else return
      events.push({ kind, params: message.params || {} })
    }
  })
}

async function readBrowserSource(source) {
  let endpoint
  try {
    endpoint = browserEndpoint(source)
  } catch (error) {
    return [
      {
        source: "browser",
        lines: [],
        error: `CDP 地址无效：${error instanceof Error ? error.message : String(error)}`
      }
    ]
  }

  const label = `browser ${endpoint}`
  if (typeof WebSocket === "undefined") {
    return [
      {
        source: label,
        lines: [],
        error: `浏览器日志源需要 Node 22+（当前 ${process.version}），可改用 --command 或手动粘贴`
      }
    ]
  }

  let targets
  try {
    targets = await fetchCdpJson(`${endpoint}/json`)
  } catch (error) {
    const port = new URL(endpoint).port
    return [
      {
        source: label,
        lines: [],
        error: [
          `连接 CDP 失败（${error instanceof Error ? error.message : String(error)}）`,
          `请先以 --remote-debugging-port=${port} --user-data-dir=<独立目录> 启动 Chrome/Edge 并打开页面`,
          "Chrome 136+ 不允许在默认用户目录上开启远程调试"
        ].join("；")
      }
    ]
  }

  const pages = (Array.isArray(targets) ? targets : []).filter(isPageTarget)
  const filter = typeof source.urlFilter === "string" ? source.urlFilter.trim() : ""
  const selected = filter
    ? pages.filter((target) => `${target.url || ""} ${target.title || ""}`.includes(filter))
    : pages

  if (!selected.length) {
    const available = pages.map((target) => target.url).filter(Boolean).slice(0, 6)
    return [
      {
        source: label,
        lines: [],
        error: `没有匹配的页面${filter ? `（urlFilter=${filter}）` : ""}${
          available.length ? `；当前页面：${available.join("、")}` : "；请先在浏览器中打开要复现的页面"
        }`
      }
    ]
  }

  const waitMs = Math.min(15000, positiveNumber(Number(source.waitMs), CDP_DEFAULT_WAIT_MS))
  const maxEvents = Math.min(
    5000,
    Math.round(positiveNumber(Number(source.maxEvents), CDP_DEFAULT_MAX_EVENTS))
  )
  return Promise.all(selected.map((target) => captureBrowserTarget(target, waitMs, maxEvents)))
}

function makeMarker(prefix, runId, hypothesisId, probeNo) {
  return `[${prefix}:${runId}:${hypothesisId}:P${probeNo}]`
}

function templatesFor(file, marker, code) {
  const ext = extname(file).toLowerCase()
  const values = code.trim() || "value"
  if ([".java", ".kt", ".scala"].includes(ext)) {
    return [
      `log.info("${marker} " + ${values});`,
      `System.out.println("${marker} " + ${values});`
    ]
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs", ".cjs"].includes(ext)) {
    return [`console.log("${marker}", ${values});`]
  }
  if (ext === ".py") return [`print(f"${marker} {${values}}")`]
  if (ext === ".go") return [`fmt.Println("${marker}", ${values})`]
  if (ext === ".cs") return [`Console.WriteLine($"${marker} {${values}}");`]
  return [`// 在日志中输出: ${marker} <${values}>`]
}

function isRemovableLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (LOG_LINE.test(line)) return true
  return /^(\/\/|#|\*|\/\*)/.test(trimmed)
}

async function scanProbe(project, probe) {
  try {
    const { lines } = await readLines(toAbsolute(project, probe.file))
    const index = lines.findIndex((line) => line.includes(probe.marker))
    return { probe, present: index >= 0, line: index >= 0 ? index + 1 : undefined }
  } catch {
    return { probe, present: false }
  }
}

async function scanProbes(project, probes) {
  const result = []
  for (const probe of probes) {
    if (probe.removed) {
      result.push({ probe, present: false })
      continue
    }
    result.push(await scanProbe(project, probe))
  }
  return result
}

async function cleanupProbes(project, probes, apply) {
  const removed = []
  const manual = []
  const changedFiles = []
  const active = probes.filter((probe) => !probe.removed)

  const byFile = new Map()
  for (const probe of active) {
    const list = byFile.get(probe.file) ?? []
    list.push(probe)
    byFile.set(probe.file, list)
  }

  for (const [file, fileProbes] of byFile) {
    const absolute = toAbsolute(project, file)
    let loaded
    try {
      loaded = await readLines(absolute)
    } catch {
      for (const probe of fileProbes) {
        manual.push({ probe, file, line: probe.line, reason: "文件读取失败" })
      }
      continue
    }

    const keep = []
    let changed = false

    loaded.lines.forEach((line, index) => {
      const matched = fileProbes.filter((probe) => line.includes(probe.marker))
      if (!matched.length) {
        keep.push(line)
        return
      }
      if (!isRemovableLine(line)) {
        for (const probe of matched) {
          manual.push({
            probe,
            file,
            line: index + 1,
            reason: "标记与其它代码在同一行，无法安全自动删除"
          })
        }
        keep.push(line)
        return
      }
      for (const probe of matched) {
        removed.push({ probe, file, line: index + 1, content: line.trim() })
        changed = true
      }
    })

    if (changed && apply) {
      await writeLines(absolute, keep, loaded.eol)
      if (!changedFiles.includes(file)) changedFiles.push(file)
    }
  }

  const scans = apply ? await scanProbes(project, active) : []
  const remaining = scans.filter((scan) => scan.present)
  if (apply) {
    for (const scan of scans) {
      if (!scan.present && !manual.some((item) => item.probe === scan.probe)) {
        scan.probe.removed = true
      }
    }
  }

  return { removed, manual, remaining, changedFiles }
}

function buildFlow(steps) {
  const lines = []
  steps.forEach((step, index) => {
    lines.push(`[${index + 1}] ${step.action}`)
    if (step.expect) lines.push(`    预期: ${step.expect}`)
    if (step.watch) lines.push(`    留意: ${step.watch}`)
    if (index < steps.length - 1) {
      lines.push("     │")
      lines.push("     ▼")
    }
  })
  lines.push("     │")
  lines.push("     ▼")
  lines.push("[✓] 完成后回复“已完成”")
  return lines.join("\n")
}

async function codeContext(project, probe) {
  try {
    const { lines } = await readLines(toAbsolute(project, probe.file))
    const start = Math.max(1, probe.line - 4)
    const end = Math.min(lines.length, probe.line + 4)
    const body = []
    for (let index = start; index <= end; index++) {
      const prefix = index === probe.line ? ">" : " "
      body.push(`${prefix} ${String(index).padStart(4, " ")} | ${lines[index - 1] ?? ""}`)
    }
    return body.join("\n")
  } catch {
    return `（无法读取 ${probe.file}）`
  }
}

async function readJson(project, file, label) {
  if (!file || file === true) fail(`缺少 --file ${label}`)
  const path = isAbsolute(String(file)) ? String(file) : resolve(project, String(file))
  let raw
  try {
    raw = await readFile(path, "utf8")
  } catch {
    fail(`读不到 ${path}。请先创建 ${label}。`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    fail(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

function appendSymptom(existing, symptom, notes) {
  const parts = [existing.trim(), symptom.trim(), notes ? `补充: ${notes.trim()}` : ""].filter(Boolean)
  return parts.join("\n")
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdBegin(project, args) {
  const symptom = text(args.symptom).trim()
  if (!symptom) fail("缺少 --symptom。请先让用户描述问题现象、触发路径和期望结果。")
  const notes = text(args.notes).trim()

  let state = await loadState(project)
  if (!state) {
    state = normalizeState(undefined, project)
    state.symptom = appendSymptom("", symptom, notes)
    state.phase = "diagnose"
    await saveState(project, state)
    console.log(
      [
        "已记录问题，阶段: diagnose（诊断中）。",
        "下一步：只读相关代码，定位可疑链路，不要修改任何文件。",
        "给出 2-4 个按可能性排序的假设，写 hypotheses.json 后运行 hypothesize --file。"
      ].join("\n")
    )
    return
  }

  if (state.phase === "idle" || state.phase === "intake" || state.phase === "diagnose") {
    state.symptom = appendSymptom(state.symptom, symptom, notes)
    state.phase = "diagnose"
    await saveState(project, state)
    console.log(
      [
        "已更新问题描述，阶段: diagnose（诊断中）。",
        "下一步：只读相关代码，给出 2-4 个假设后运行 hypothesize --file。"
      ].join("\n")
    )
    return
  }

  if (state.phase === "done") {
    state = normalizeState(undefined, project)
    state.symptom = appendSymptom("", symptom, notes)
    state.phase = "diagnose"
    await saveState(project, state)
    console.log("上一轮调试已完成，已开始新一轮调试，阶段: diagnose（诊断中）。")
    return
  }

  const pending = state.probes.filter((probe) => !probe.removed)
  fail(
    [
      `当前调试还在「${PHASE_LABEL[state.phase]}」阶段，不能直接覆盖。`,
      pending.length ? `还有 ${pending.length} 条未清理埋点。` : "",
      "先运行 status 查看状态；如果确实要放弃当前调试，运行 reset --force（不会删除代码里的日志）。"
    ]
      .filter(Boolean)
      .join("\n")
  )
}

async function cmdHypothesize(project, args) {
  const state = await requireState(project)
  if (!["diagnose", "instrument"].includes(state.phase)) {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），现在不能提交假设。先运行 begin 记录问题。`)
  }
  if (state.phase === "instrument" && state.probes.some((probe) => !probe.removed)) {
    fail("已经登记了埋点，不能再替换假设。先完成本轮调试，或运行 reset --force 后重新开始。")
  }

  const payload = await readJson(project, args.file, "hypotheses.json")
  const list = Array.isArray(payload) ? payload : payload?.hypotheses
  if (!Array.isArray(list) || list.length === 0) fail("hypotheses.json 需要是非空数组，或 { \"hypotheses\": [...] }。")
  if (list.length > 6) fail("假设最多 6 个，建议 2-4 个。")

  const normalized = []
  for (let index = 0; index < list.length; index++) {
    const item = list[index] ?? {}
    const cause = text(item.cause).trim()
    if (!cause) fail(`第 ${index + 1} 个假设缺少 cause。`)
    const id = text(item.id, `H${index + 1}`).trim() || `H${index + 1}`
    if (normalized.some((entry) => entry.id === id)) fail(`假设 ID 重复: ${id}`)
    const confidence = ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "medium"
    normalized.push({
      id,
      cause,
      evidence: text(item.evidence).trim() || undefined,
      confidence,
      verify: text(item.verify).trim() || undefined
    })
  }

  state.hypotheses = normalized
  if (state.phase !== "instrument") state.phase = "instrument"
  await saveState(project, state)

  console.log(
    [
      `已记录 ${normalized.length} 个假设，阶段: instrument（埋点）。`,
      ...normalized.map((item) => `- ${item.id}. ${item.cause}（${item.confidence}）`),
      "",
      "下一步：为每个假设选择 1-3 个关键位置，运行 probe-add 登记埋点，再按返回的模板插入日志。",
      "全部插入后运行 probe-verify。"
    ].join("\n")
  )
}

async function cmdProbeAdd(project, args) {
  const state = await requireState(project)
  if (state.phase !== "instrument") {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），只有 instrument（埋点）阶段可以登记埋点。`)
  }

  const hypothesisId = text(args.hypothesis).trim()
  if (!hypothesisId) fail("缺少 --hypothesis，例如 H1。")
  if (!state.hypotheses.some((item) => item.id === hypothesisId)) {
    fail(`找不到假设 ${hypothesisId}。可用假设: ${state.hypotheses.map((item) => item.id).join(", ") || "（无）"}`)
  }

  const file = text(args.file).trim()
  if (!file) fail("缺少 --file（相对项目根目录的文件路径）。")
  const line = Number(args.line)
  if (!Number.isInteger(line) || line < 1) fail("缺少 --line（大于 0 的行号）。")
  const code = text(args.code).trim()
  if (!code) fail("缺少 --code（要打印的变量或表达式）。")

  const relativePath = toRelative(project, file)
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    fail("文件必须位于当前项目目录内，请使用相对项目根目录的路径。")
  }

  const absolute = toAbsolute(project, relativePath)
  if (!existsSync(absolute)) fail(`读不到文件 ${relativePath}。请确认路径是否正确（相对项目根目录）。`)

  const config = await readConfig(project)
  const { lines } = await readLines(absolute)
  const lineContent = lines[Math.max(0, Math.min(line, lines.length) - 1)] ?? ""
  const probeNo =
    state.probes
      .filter((probe) => probe.hypothesisId === hypothesisId)
      .reduce((max, probe) => Math.max(max, Number(String(probe.id).split("-P")[1]) || 0), 0) + 1 || 1

  const marker = makeMarker(config.markerPrefix, state.runId, hypothesisId, probeNo)
  const probe = {
    id: `${hypothesisId}-P${probeNo}`,
    hypothesisId,
    marker,
    file: relativePath,
    line,
    code,
    note: text(args.note).trim() || undefined,
    createdAt: Date.now()
  }
  state.probes.push(probe)
  await saveState(project, state)

  console.log(
    [
      `已登记埋点 ${probe.id}`,
      `marker: ${marker}`,
      `文件: ${relativePath}:${line}`,
      `当前该行内容: ${lineContent.trim() || "（空行）"}`,
      "",
      "插入模板（选一种，单独占一行；模板仅示意，多个表达式请按语言语法拼接）：",
      ...templatesFor(relativePath, marker, code).map((item) => `  ${item}`),
      "",
      "提醒：不要改动原有业务代码；日志行必须包含 marker；不要打印密码、token 等敏感信息。",
      "完成后可以继续登记下一条，或运行 probe-verify 检查。"
    ].join("\n")
  )
}

async function cmdProbeVerify(project) {
  const state = await requireState(project)
  if (state.phase !== "instrument") {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），埋点检查只在 instrument 阶段使用。`)
  }

  const active = state.probes.filter((probe) => !probe.removed)
  if (!active.length) fail("还没有登记任何埋点。先运行 probe-add。")

  const scans = await scanProbes(project, active)
  for (const scan of scans) {
    if (scan.present && scan.line) scan.probe.line = scan.line
  }
  await saveState(project, state)

  const missing = scans.filter((scan) => !scan.present)
  console.log(`埋点检查结果（${scans.length - missing.length}/${scans.length} 已就位）：`)
  for (const scan of scans) {
    const status = scan.present ? `✅ 第 ${scan.line} 行` : "❌ 未找到 marker"
    console.log(`- ${scan.probe.id} ${scan.probe.marker} → ${scan.probe.file} ${status}`)
  }
  console.log("")

  if (missing.length) {
    console.log(`还有 ${missing.length} 条埋点没有写入文件。请补齐后再次运行 probe-verify。marker 必须原样保留。`)
    process.exitCode = 1
    return
  }

  console.log(
    [
      "全部就位。下一步：写 steps.json，运行 repro --file .bugkiller/steps.json。",
      "repro 会记录复现步骤并打印给用户的复现流程。"
    ].join("\n")
  )
}

async function cmdRepro(project, args) {
  const state = await requireState(project)
  if (state.phase !== "instrument") {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），只有埋点完成后才能进入复现阶段。`)
  }

  const active = state.probes.filter((probe) => !probe.removed)
  if (!active.length) fail("还没有登记任何埋点。先运行 probe-add。")

  const scans = await scanProbes(project, active)
  for (const scan of scans) {
    if (scan.present && scan.line) scan.probe.line = scan.line
  }
  const missing = scans.filter((scan) => !scan.present)
  if (missing.length) {
    fail(
      [
        `还有 ${missing.length} 条埋点没有写入文件，不能进入复现阶段：`,
        ...missing.map((scan) => `- ${scan.probe.marker} @ ${scan.probe.file}:${scan.probe.line}`),
        "请补齐后运行 probe-verify，再重试。"
      ].join("\n")
    )
  }

  const payload = await readJson(project, args.file, "steps.json")
  const rawSteps = Array.isArray(payload) ? payload : payload?.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) fail("steps.json 需要是非空数组，或 { \"steps\": [...] }。")
  if (rawSteps.length > 12) fail("复现步骤最多 12 步。")

  const steps = rawSteps.map((item, index) => {
    const action = text(item?.action).trim()
    if (!action) fail(`第 ${index + 1} 步缺少 action。`)
    return {
      action,
      expect: text(item.expect).trim() || undefined,
      watch: text(item.watch).trim() || undefined
    }
  })

  state.reproSteps = steps
  state.windowStart = Date.now()
  state.phase = "await_repro"
  await saveState(project, state)

  console.log(
    [
      `已进入等待复现阶段（共 ${active.length} 条埋点）。`,
      "把下面的流程完整展示给用户，然后停止，等待用户回复“已完成”：",
      "",
      "```",
      buildFlow(steps),
      "```",
      "",
      "现在不要继续分析，也不要修改任何文件。"
    ].join("\n")
  )
}

async function cmdCollect(project, args) {
  const state = await requireState(project)
  if (!["await_repro", "collect", "analyze"].includes(state.phase)) {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），还不能采集日志。等用户完成复现后再试。`)
  }

  const config = await readConfig(project)
  const browserFilter = text(args["browser-filter"]).trim()
  const adHoc = [
    ...arr(args.log).map((path) => ({ type: "file", path: String(path) })),
    ...arr(args.command).map((command) => ({ type: "command", command: String(command) })),
    ...arr(args.browser).map((value) => {
      const raw = text(value).trim()
      const source = /^\d+$/.test(raw)
        ? { type: "browser", port: Number(raw) }
        : raw
          ? { type: "browser", url: raw }
          : { type: "browser" }
      return browserFilter ? { ...source, urlFilter: browserFilter } : source
    })
  ]
  const sources = adHoc.length ? adHoc : config.logSources

  if (!sources.length) {
    fail(
      [
        "没有配置日志源，无法自动采集。",
        "",
        `可以在 ${CONFIG_FILE} 中配置 logSources，或直接传：`,
        "  collect --log logs/app.log",
        '  collect --command "docker logs --tail 2000 my-api"',
        "  collect --browser 9222",
        '  collect --browser http://127.0.0.1:9222 --browser-filter "localhost:5173"',
        "",
        "也可以让用户把日志粘贴到对话里，再人工分析。"
      ].join("\n")
    )
  }

  state.phase = "collect"
  await saveState(project, state)

  const chunks = []
  for (const source of sources) {
    if (source.type === "file") {
      const path = isAbsolute(source.path) ? source.path : resolve(project, source.path)
      try {
        const chunk = await readTail(path, config.maxLogBytes, source.maxLines ?? config.maxLogLines)
        chunks.push({ ...chunk, source: path })
      } catch (error) {
        chunks.push({
          source: path,
          lines: [],
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } else if (source.type === "browser") {
      chunks.push(...(await readBrowserSource(source)))
    } else {
      chunks.push(await readCommand(source, project))
    }
  }

  const active = state.probes.filter((probe) => !probe.removed)
  const hits = []
  const errorLines = []
  const snippets = new Set()
  const windowStart = state.windowStart ?? 0
  const includeErrors = !bool(args["no-errors"])

  for (const chunk of chunks) {
    chunk.lines.forEach((line, index) => {
      for (const probe of active) {
        if (line.includes(probe.marker)) {
          hits.push({ probe, source: chunk.source, line })
          for (
            let offset = Math.max(0, index - 3);
            offset <= Math.min(chunk.lines.length - 1, index + 3);
            offset++
          ) {
            snippets.add(`${chunk.source} | ${chunk.lines[offset]}`)
          }
        }
      }
      if (includeErrors && ERROR_LINE.test(line)) {
        const time = parseTime(line)
        if (!windowStart || time === undefined || time >= windowStart - 5000) {
          errorLines.push(`${chunk.source} | ${line}`)
        }
      }
    })
  }

  const grouped = new Map()
  for (const hit of hits) {
    const list = grouped.get(hit.probe.marker) ?? []
    list.push(hit)
    grouped.set(hit.probe.marker, list)
  }
  const missed = active.filter((probe) => !grouped.has(probe.marker))

  const contextBlocks = []
  for (const probe of active) {
    contextBlocks.push(`### ${probe.id} ${probe.marker}  ${probe.file}:${probe.line}`)
    contextBlocks.push(await codeContext(project, probe))
    contextBlocks.push("")
  }

  const sourceLines = chunks.length
    ? chunks.map((chunk) =>
        chunk.error
          ? `- ${chunk.source}: 读取失败（${chunk.error}）`
          : `- ${chunk.source}: ${chunk.lines.length} 行${chunk.note ? `（${chunk.note}）` : ""}`
      )
    : ["- 未配置日志源"]

  const hitLines = []
  for (const probe of active) {
    const list = grouped.get(probe.marker)
    if (!list) continue
    hitLines.push(`- ${probe.marker}  ${probe.file}:${probe.line}  命中 ${list.length} 次（假设 ${probe.hypothesisId}）`)
    for (const hit of list.slice(0, 3)) {
      hitLines.push(`    ${hit.line.trim().slice(0, 400)}`)
    }
  }

  const missedLines = missed.map(
    (probe) =>
      `- ${probe.marker}  ${probe.file}:${probe.line}  假设 ${probe.hypothesisId}${probe.note ? `（${probe.note}）` : ""}`
  )

  const report = [
    "# 日志采集结果",
    `时间窗: ${formatTime(state.windowStart)} 之后`,
    "",
    "## 日志源",
    ...sourceLines,
    "",
    `## 埋点命中（${active.length - missed.length}/${active.length}）`,
    ...(hitLines.length ? hitLines : ["（没有任何埋点命中）"]),
    "",
    "## 未命中埋点（重点）",
    ...(missedLines.length ? missedLines : ["（全部埋点都有输出）"]),
    "",
    "未命中通常意味着：对应代码路径没有执行 / 请求没走到 / 日志级别被过滤 / 埋点位置不在实际分支上。",
    "",
    "## 错误与异常行",
    ...(errorLines.length ? errorLines.slice(0, 80) : ["（未捕获到错误关键字）"]),
    "",
    "## 代码上下文",
    ...contextBlocks,
    "",
    "## 原始日志片段（命中行前后各 3 行，去重）",
    ...(snippets.size ? [...snippets].slice(0, 400) : ["（无）"]),
    ""
  ].join("\n")

  state.phase = "analyze"
  state.collectedAt = Date.now()
  await saveState(project, state)

  const maxChars = positiveNumber(Number(args["max-chars"]), config.maxCollectChars)
  console.log(clip(report, maxChars))
  console.log("")
  console.log("---")
  console.log("请基于以上证据逐条判断假设：成立 / 不成立 / 证据不足，并解释未命中埋点说明什么。")
  console.log("分析完成后写 plan.json，运行 plan --file .bugkiller/plan.json；不要直接改代码。")
}

async function cmdPlan(project, args) {
  const state = await requireState(project)
  if (state.phase !== "analyze") {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），需要先完成日志采集和分析，再提交修复方案。`)
  }

  const payload = await readJson(project, args.file, "plan.json")
  const rootCause = text(payload?.rootCause).trim()
  const changes = Array.isArray(payload?.changes)
    ? payload.changes.map((item) => text(item).trim()).filter(Boolean)
    : []
  if (!rootCause) fail("plan.json 缺少 rootCause。")
  if (!changes.length) fail("plan.json 需要至少一条 changes。")

  state.fixPlan = {
    rootCause,
    hypothesisId: text(payload.hypothesisId).trim() || undefined,
    changes,
    risks: Array.isArray(payload.risks) ? payload.risks.map((item) => text(item).trim()).filter(Boolean) : [],
    verification: Array.isArray(payload.verification)
      ? payload.verification.map((item) => text(item).trim()).filter(Boolean)
      : [],
    createdAt: Date.now()
  }
  state.confirmedAt = undefined
  state.phase = "fix_plan"
  await saveState(project, state)

  const plan = state.fixPlan
  console.log(
    [
      "修复方案已记录，阶段: fix_plan（等待确认）。",
      "在用户明确确认前，不要修改项目代码。",
      "",
      "展示给用户：",
      `1. 根因：${plan.rootCause}`,
      `2. 改动点：${plan.changes.join("；")}`,
      `3. 风险：${plan.risks.length ? plan.risks.join("；") : "无明显风险"}`,
      `4. 验证：${plan.verification.length ? plan.verification.join("；") : "按项目现有构建/测试"}`,
      "",
      "最后明确询问用户是否按此方案修复，然后停止。",
      "用户明确同意后，运行 confirm，再运行 apply。"
    ].join("\n")
  )
}

async function cmdConfirm(project) {
  const state = await requireState(project)
  if (state.phase !== "fix_plan") {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），没有等待确认的修复方案。`)
  }
  state.confirmedAt = Date.now()
  await saveState(project, state)
  console.log("已记录用户确认。下一步运行 apply 进入修复阶段。")
}

async function cmdApply(project) {
  const state = await requireState(project)
  if (state.phase === "fix") {
    console.log("已经处于修复阶段，可以直接按方案修改代码。")
    return
  }
  if (state.phase !== "fix_plan") {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），还没有待确认的修复方案。`)
  }
  if (!state.confirmedAt) {
    fail("用户还没有确认修复方案。先展示方案并等待明确同意，然后运行 confirm。不要自行开始修改。")
  }

  state.phase = "fix"
  await saveState(project, state)
  console.log(
    [
      "已进入修复阶段（fix）。",
      "按已确认的方案修改代码，不要做无关重构。",
      "完成后运行 cleanup --apply 清除全部埋点，再运行项目现有的构建/测试。"
    ].join("\n")
  )
}

async function cmdCleanup(project, args) {
  const state = await requireState(project)
  if (!["fix", "verify", "done"].includes(state.phase)) {
    fail(
      `当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），埋点清理只能在修复完成后进行。` +
        "如果中途放弃，运行 reset --force。"
    )
  }

  const active = state.probes.filter((probe) => !probe.removed)
  if (!active.length) {
    if (state.phase !== "verify" && state.phase !== "done") {
      state.phase = "verify"
      await saveState(project, state)
    }
    console.log("没有残留埋点。下一步运行项目现有的构建/测试，然后运行 finish --summary '...'。")
    return
  }

  const apply = bool(args.apply)
  const report = await cleanupProbes(project, state.probes, apply)
  await saveState(project, state)

  if (!apply) {
    console.log(`预览：将删除 ${report.removed.length} 行日志埋点。`)
    if (report.removed.length) {
      for (const item of report.removed) {
        console.log(`- ${item.file}:${item.line}  ${item.content.slice(0, 160)}`)
      }
    } else {
      console.log("（没有匹配到可自动删除的日志行）")
    }
    if (report.manual.length) {
      console.log("")
      console.log(`另有 ${report.manual.length} 处无法安全自动删除，需要手动处理：`)
      for (const item of report.manual) {
        console.log(`- ${item.file}:${item.line}（${item.reason}）`)
      }
    }
    console.log("")
    console.log("确认无误后运行 cleanup --apply。")
    return
  }

  if (!report.remaining.length && !report.manual.length) {
    state.phase = "verify"
    await saveState(project, state)
    console.log(
      [
        `已清理 ${report.removed.length} 行埋点，涉及 ${report.changedFiles.length} 个文件：`,
        ...report.changedFiles.map((file) => `- ${file}`),
        "",
        "所有 marker 已清除。现在运行项目现有的构建/测试，把结果告诉用户。",
        "验证通过后运行 finish --summary '...' 收尾。"
      ].join("\n")
    )
    return
  }

  console.log(`已删除 ${report.removed.length} 行，但仍有残留：`)
  for (const scan of report.remaining) {
    console.log(`- ${scan.probe.marker} @ ${scan.probe.file}:${scan.line ?? "?"}`)
  }
  if (report.manual.length) {
    console.log(`无法自动删除 ${report.manual.length} 处：`)
    for (const item of report.manual) {
      console.log(`- ${item.file}:${item.line}（${item.reason}）`)
    }
  }
  console.log("")
  console.log("请手动删除这些行后再次运行 cleanup --apply。")
  process.exitCode = 1
}

async function cmdFinish(project, args) {
  const state = await requireState(project)
  if (state.phase !== "verify") {
    fail(`当前阶段是 ${state.phase}（${PHASE_LABEL[state.phase]}），需要先完成修复和清理，再标记完成。`)
  }
  state.phase = "done"
  state.summary = text(args.summary).trim() || undefined
  await saveState(project, state)
  console.log(
    [
      "已标记为 done。",
      state.summary ? `复盘: ${state.summary}` : "",
      "本次调试结束。运行 reset 可以清空状态，开始下一次排查。"
    ]
      .filter(Boolean)
      .join("\n")
  )
}

async function cmdReset(project, args) {
  const state = await loadState(project)
  if (!state) {
    console.log("当前没有调试状态，无需清空。")
    return
  }

  const pending = state.probes.filter((probe) => !probe.removed)
  if (pending.length && !bool(args.force)) {
    fail(
      [
        `还有 ${pending.length} 条埋点没有清理：${pending.map((probe) => probe.marker).join("、")}。`,
        "先完成清理；如果确实要放弃，运行 reset --force（不会删除代码里的日志）。"
      ].join("\n")
    )
  }

  try {
    await unlink(statePath(project))
  } catch {
    // state file already gone
  }
  console.log("已清空调试状态。直接描述新的问题即可开始下一次排查。")
}

async function cmdStatus(project, args) {
  const state = await loadState(project)
  const config = await readConfig(project)

  if (!state) {
    if (bool(args.json)) {
      console.log(JSON.stringify({ active: false, phase: "idle", logSources: config.logSources.length }, null, 2))
      return
    }
    console.log(
      [
        "当前项目没有调试状态。",
        "先让用户描述问题，然后运行：",
        "  begin --symptom '问题现象、触发路径、期望结果'"
      ].join("\n")
    )
    return
  }

  const active = state.probes.filter((probe) => !probe.removed)
  if (bool(args.json)) {
    console.log(
      JSON.stringify(
        {
          active: state.phase !== "idle",
          phase: state.phase,
          label: PHASE_LABEL[state.phase],
          symptom: state.symptom,
          hypotheses: state.hypotheses,
          probes: active,
          logSources: config.logSources.length,
          next: nextHint(state),
          updatedAt: state.updatedAt
        },
        null,
        2
      )
    )
    return
  }

  const hypothesisLines = state.hypotheses.length
    ? state.hypotheses.map((item) => `- ${item.id}. ${item.cause}（${item.confidence}）`)
    : ["- 暂无"]
  const probeLines = active.length
    ? active.map(
        (probe) =>
          `- ${probe.id} ${probe.marker} @ ${probe.file}:${probe.line}（假设 ${probe.hypothesisId}）`
      )
    : ["- 暂无"]

  console.log(
    [
      `阶段: ${state.phase}（${PHASE_LABEL[state.phase]}）`,
      `问题: ${state.symptom || "（未记录）"}`,
      "假设:",
      ...hypothesisLines,
      "埋点:",
      ...probeLines,
      `日志源: ${config.logSources.length} 个`,
      `下一步: ${nextHint(state)}`
    ].join("\n")
  )
}

function usage() {
  return [
    "bugkiller.mjs — Bug Killer 调试辅助脚本",
    "",
    "用法:",
    "  node bugkiller.mjs [--project <dir>] <命令> [选项]",
    "",
    "命令:",
    '  begin       --symptom "..." [--notes "..."]',
    "  hypothesize --file .bugkiller/hypotheses.json",
    '  probe-add   --hypothesis H1 --file src/a.ts --line 120 --code "userId, status" [--note "..."]',
    "  probe-verify",
    "  repro       --file .bugkiller/steps.json",
    '  collect     [--log path] [--command "docker logs ..."] [--browser [port|url]] [--browser-filter text] [--no-errors] [--max-chars N]',
    "  plan        --file .bugkiller/plan.json",
    "  confirm",
    "  apply",
    "  cleanup     [--apply]",
    '  finish      --summary "..."',
    "  reset       [--force]",
    "  status      [--json]",
    "",
    `状态文件: <项目>/${STATE_FILE}`,
    `日志源配置: <项目>/${CONFIG_FILE}`,
    "",
    "示例:",
    "  node bugkiller.mjs status",
    '  node bugkiller.mjs begin --symptom "点击借出后接口 500"',
    "  node bugkiller.mjs probe-verify",
    "  node bugkiller.mjs collect --log logs/app.log",
    "  node bugkiller.mjs collect --browser 9222 --browser-filter localhost:5173"
  ].join("\n")
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2))
const command = typeof args._[0] === "string" ? args._[0] : "help"
const project = args.project ? resolve(String(args.project)) : process.cwd()

if (command === "help" || command === "--help" || command === "-h") {
  console.log(usage())
  process.exit(0)
}

if (!existsSync(project)) fail(`项目目录不存在: ${project}`)

const handlers = {
  begin: cmdBegin,
  hypothesize: cmdHypothesize,
  "probe-add": cmdProbeAdd,
  "probe-verify": cmdProbeVerify,
  repro: cmdRepro,
  collect: cmdCollect,
  plan: cmdPlan,
  confirm: cmdConfirm,
  apply: cmdApply,
  cleanup: cmdCleanup,
  finish: cmdFinish,
  reset: cmdReset,
  status: cmdStatus
}

const handler = handlers[command]
if (!handler) fail(`未知命令: ${command}\n\n${usage()}`)

try {
  await handler(project, args)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
