import { readFileSync } from "node:fs";

export function validateConfig({
  publicOrigin = "",
  setupKey = "",
  production = false,
} = {}) {
  if (typeof publicOrigin !== "string" || typeof setupKey !== "string")
    throw new Error("无效的服务配置");
  let origin = "";
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "PUBLIC_ORIGIN 必须是完整网站地址，不能包含路径、凭证或参数",
      );
    if (production && url.protocol !== "https:")
      throw new Error("生产环境 PUBLIC_ORIGIN 必须使用 HTTPS");
    origin = url.origin;
  }
  if (setupKey && setupKey.length < 32)
    throw new Error("建空间口令至少需要 32 个字符");
  if (production && (!origin || !setupKey))
    throw new Error(
      "生产环境必须配置 PUBLIC_ORIGIN 和 AGENT_COLLAB_SETUP_KEY 或 AGENT_COLLAB_SETUP_KEY_FILE",
    );
  return { publicOrigin: origin, setupKey, production };
}

export function readConfig(env = process.env) {
  if (env.AGENT_COLLAB_SETUP_KEY && env.AGENT_COLLAB_SETUP_KEY_FILE)
    throw new Error("建空间口令不能同时从环境变量和文件读取");
  const setupKey = env.AGENT_COLLAB_SETUP_KEY_FILE
    ? readFileSync(env.AGENT_COLLAB_SETUP_KEY_FILE, "utf8").trim()
    : env.AGENT_COLLAB_SETUP_KEY || "";
  return validateConfig({
    publicOrigin: env.PUBLIC_ORIGIN || "",
    setupKey,
    production: env.NODE_ENV === "production",
  });
}
