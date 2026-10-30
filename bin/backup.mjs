#!/usr/bin/env node
import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, open, chmod, link, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function backupDatabase(source, destination) {
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination) throw new Error("备份不能覆盖源数据库");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temp = destination + "." + randomUUID() + ".tmp";
  const placeholder = await open(temp, "wx", 0o600);
  await placeholder.close();
  let database;
  try {
    database = new DatabaseSync(source, { readOnly: true });
    await backup(database, temp);
    const check = new DatabaseSync(temp, { readOnly: true });
    try {
      if (
        check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      )
        throw new Error("备份完整性校验失败");
    } finally {
      check.close();
    }
    await chmod(temp, 0o600);
    // Atomic publish without replacing an existing backup or symlink.
    await link(temp, destination);
    return destination;
  } finally {
    database?.close();
    await unlink(temp).catch(() => {});
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const data = resolve(
    process.env.AGENT_COLLAB_DATA || join(root, ".agent-collab"),
  );
  const destination =
    process.argv[2] ||
    join(
      data,
      "backups",
      `collab-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`,
    );
  try {
    console.log(
      `备份已通过完整性检查：${await backupDatabase(join(data, "collab.sqlite"), destination)}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
