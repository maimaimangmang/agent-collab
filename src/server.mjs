import http from "node:http";
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, AppError } from "./store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicFiles = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);
export function createApp({ database = ":memory:", storeOptions } = {}) {
  const store = new Store(database, storeOptions);
  const limits = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && publicFiles.has(url.pathname)) {
        const [file, type] = publicFiles.get(url.pathname);
        res.writeHead(200, {
          "Content-Type": `${type}; charset=utf-8`,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        return res.end(readFileSync(join(root, "public", file)));
      }
      if (url.pathname === "/api/health" && req.method === "GET")
        return send(200, { ok: true, version: "0.1.0" });
      if (!url.pathname.startsWith("/api/"))
        throw new AppError(404, "页面不存在");
      if (!["GET", "POST"].includes(req.method))
        throw new AppError(405, "不支持的请求方法");
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        throw new AppError(403, "不允许跨站请求");
      let body = {};
      if (req.method === "POST") {
        if (!(req.headers["content-type"] || "").startsWith("application/json"))
          throw new AppError(415, "请发送 JSON");
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64000) throw new AppError(413, "请求内容过大");
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        } catch {
          throw new AppError(400, "JSON 格式错误");
        }
        if (!body || Array.isArray(body) || typeof body !== "object")
          throw new AppError(400, "请求必须是对象");
      }
      const route = `${req.method} ${url.pathname}`;
      if (["POST /api/spaces", "POST /api/join"].includes(route)) {
        const key = req.socket.remoteAddress;
        const current = limits.get(key);
        const now = Date.now();
        const limit =
          current && current.until > now
            ? current
            : { count: 0, until: now + 60000 };
        if (++limit.count > 20)
          throw new AppError(429, "请求过于频繁，请稍后重试");
        limits.set(key, limit);
        if (limits.size > 1000)
          for (const [k, v] of limits) if (v.until < now) limits.delete(k);
        return send(
          201,
          route.endsWith("/spaces") ? store.create(body) : store.join(body),
        );
      }
      const secret = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (!secret) throw new AppError(401, "需要访问凭证");
      let result;
      if (url.pathname.startsWith("/api/worker/")) {
        const agent = store.agent(secret);
        if (route === "GET /api/worker/next") result = store.next(agent);
        else if (route === "POST /api/worker/claim")
          result = store.claim(agent, body.taskId, body.kind);
        else if (route === "POST /api/worker/heartbeat")
          result = store.heartbeat(agent, body);
        else if (route === "POST /api/worker/finish")
          result = store.finish(agent, body);
        else throw new AppError(404, "接口不存在");
      } else if (url.pathname.startsWith("/api/run/")) {
        const run = store.activeRun(secret);
        if (route === "GET /api/run/context")
          result = store.context(run.space_id, run.task_id);
        else if (route === "POST /api/run/message")
          result = store.runMessage(run, body);
        else throw new AppError(404, "接口不存在");
      } else {
        const member = store.member(secret);
        if (route === "GET /api/state") result = store.snapshot(member);
        else if (route === "POST /api/invites") result = store.invite(member);
        else if (route === "POST /api/agents")
          result = store.register(member, body);
        else if (route === "POST /api/tasks")
          result = store.createTask(member, body);
        else if (route === "POST /api/messages")
          result = store.postMessage(member, body);
        else if (route === "POST /api/decisions")
          result = store.postDecision(member, body);
        else {
          const match = url.pathname.match(
            /^\/api\/tasks\/([a-f0-9-]+)\/(assign|action)$/,
          );
          if (req.method !== "POST" || !match)
            throw new AppError(404, "接口不存在");
          result =
            match[2] === "assign"
              ? store.assign(member, match[1], body.agentId)
              : store.action(member, match[1], body);
        }
      }
      send(200, result || { ok: true });
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent)
        send(error.status || 500, {
          error: error.status ? error.message : "服务异常，请查看服务端日志",
        });
      else res.end();
    }
  });
  server.on("close", () => store.close());
  return { server, store };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dataDir = resolve(
    process.env.AGENT_COLLAB_DATA || join(root, ".agent-collab"),
  );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const { server } = createApp({ database: join(dataDir, "collab.sqlite") });
  const host = process.env.HOST || "127.0.0.1",
    port = Number(process.env.PORT || 4317);
  server.listen(port, host, () =>
    console.log(`Agent Collab → http://${host}:${port}\nData → ${dataDir}`),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
