import { createServer } from "node:http"

const inventory = new Map([
  ["E-1", { id: "E-1", name: "输液泵", status: "available" }],
  ["E-2", { id: "E-2", name: "监护仪", status: "available" }]
])

export function borrow(id, user) {
  const item = inventory.get(id)
  if (!item) return { ok: false, reason: "not found" }
  if (item.status === "available") {
    item.status = "borrowed"
    item.user = user
    return { ok: true, item }
  }
  return { ok: false, reason: "not available" }
}

export function returnItem(id) {
  const item = inventory.get(id)
  if (!item) return { ok: false, reason: "not found" }
  item.status = "available"
  item.user = undefined
  return { ok: true, item }
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname === "/api/borrow") {
    try {
      const result = borrow(url.searchParams.get("id"), url.searchParams.get("user"))
      const status = result.ok ? 200 : result.reason === "not found" ? 404 : 409
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(result))
    } catch (error) {
      console.error("borrow failed", error)
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    }
    return
  }
  res.writeHead(404).end()
}).listen(18080, () => console.log("demo app on http://127.0.0.1:18080"))
