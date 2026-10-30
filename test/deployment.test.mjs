import { requestJSON } from "./http-client.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { readConfig, validateConfig } from "../src/config.mjs";
import { backupDatabase } from "../bin/backup.mjs";
import { Store } from "../src/store.mjs";

const setupKey = "test-only-setup-key-32-characters-long";
const publicOrigin = "https://collab.example.test";

test("production refuses missing secrets, plaintext origin and URL credentials", () => {
  assert.throws(
    () => readConfig({ NODE_ENV: "production" }),
    /生产环境必须配置/,
  );
  assert.throws(
    () =>
      validateConfig({
        production: true,
        setupKey,
        publicOrigin: "http://collab.example.test",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateConfig({
        publicOrigin: "https://user:password@collab.example.test",
      }),
    /凭证/,
  );
  assert.throws(
    () => validateConfig({ publicOrigin: publicOrigin + "/prefix" }),
    /路径/,
  );
  assert.throws(() => validateConfig({ setupKey: "short" }), /32/);
  assert.throws(
    () =>
      readConfig({
        AGENT_COLLAB_SETUP_KEY: setupKey,
        AGENT_COLLAB_SETUP_KEY_FILE: "/not-read",
      }),
    /同时/,
  );
});

test("deployment protects space creation and checks exact origin behind a proxy", async (t) => {
  const app = createApp({
    config: { production: true, publicOrigin, setupKey },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.server.close(r)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, body, extra = {}) {
    return requestJSON(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Host: "collab.example.test",
        Origin: publicOrigin,
        "Content-Type": "application/json",
        ...extra,
      },
      body,
    });
  }
  const config = await request("/api/config");
  assert.equal(config.data.requiresSetupKey, true);
  assert.ok(!JSON.stringify(config.data).includes(setupKey));
  const payload = {
    name: "Private team",
    goal: "Team work",
    memberName: "Owner",
  };
  assert.equal((await request("/api/spaces", payload)).status, 403);
  assert.equal(
    (await request("/api/spaces", { ...payload, setupKey: "wrong" })).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/spaces",
        { ...payload, setupKey },
        { Origin: "http://collab.example.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/config", undefined, { Origin: "null" })).status,
    403,
  );
  assert.equal(
    (
      await request("/api/config", undefined, {
        Host: "attacker.example",
        Origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  const owner = await request("/api/spaces", { ...payload, setupKey });
  assert.equal(owner.status, 201);
  const invitation = await request(
    "/api/invites",
    {},
    { Authorization: `Bearer ${owner.data.token}` },
  );
  const member = await request("/api/join", {
    name: "Partner",
    invite: invitation.data.invite,
  });
  assert.equal(member.status, 201);
  const state = await request("/api/state", undefined, {
    Authorization: `Bearer ${member.data.token}`,
  });
  assert.equal(state.data.members.length, 2);
  // Container liveness uses an internal Host and does not require a creation key.
  assert.equal((await fetch(base + "/api/health")).status, 200);
});

test("online SQLite backup includes WAL commits and can restore credentials and decisions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "collab-backup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source.sqlite"),
    destination = join(dir, "backup.sqlite");
  const store = new Store(source);
  t.after(() => store.close());
  const auth = store.create({
    name: "Team",
    goal: "Persistent collaboration",
    memberName: "Owner",
  });
  store.postDecision(store.member(auth.token), {
    content: "A committed WAL decision",
  });
  await backupDatabase(source, destination);
  const restored = new Store(destination);
  t.after(() => restored.close());
  assert.equal(
    restored.snapshot(restored.member(auth.token)).decisions[0].content,
    "A committed WAL decision",
  );
  const saved = await readFile(destination);
  await assert.rejects(backupDatabase(source, destination), { code: "EEXIST" });
  assert.deepEqual(await readFile(destination), saved);
  await assert.rejects(backupDatabase(source, source), /不能覆盖/);
});
