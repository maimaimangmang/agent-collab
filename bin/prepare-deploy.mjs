#!/usr/bin/env node
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, ".deployment", "secrets");
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(join(root, ".deployment"), 0o700);
await chmod(directory, 0o700);
const file = join(directory, "setup-key");
try {
  // Parent directories are private; the mounted file must be readable by the non-root container user.
  await writeFile(file, randomBytes(32).toString("base64url") + "\n", {
    flag: "wx",
    mode: 0o444,
  });
  console.log(`已生成建空间口令文件：${file}（口令未打印）`);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("建空间口令文件已存在，保持原值。");
}
console.log("配置 .env 中的 DOMAIN，随后执行 docker compose up -d --build。");
