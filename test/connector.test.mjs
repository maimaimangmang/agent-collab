import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../src/server.mjs";
const exec = promisify(execFile);
const root = resolve(".");
async function fixture(t, kind) {
  const dir = await mkdtemp(join(tmpdir(), "collab-connector-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "project"),
    bin = join(dir, "bin");
  await mkdir(repo);
  await mkdir(bin);
  for (const args of [
    ["init"],
    ["config", "user.name", "Connector Test"],
    ["config", "user.email", "test@example.invalid"],
  ])
    await exec("git", args, { cwd: repo });
  await writeFile(join(repo, "README.md"), "Test project\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "Initial"], { cwd: repo });
  const app = createApp();
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.server.close(r)));
  const auth = app.store.create({
      name: "Test",
      goal: "Run collaborators",
      memberName: "Owner",
    }),
    member = app.store.member(auth.token);
  const registration = app.store.register(member, {
      name: "Test runtime",
      kind,
    }),
    agent = app.store.agent(registration.token);
  const task = app.store.createTask(member, {
    title: "Create greeting",
    description: "Create hello.txt",
    acceptance: "hello.txt contains hello",
    agentId: agent.id,
  });
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    AGENT_COLLAB_TOKEN: registration.token,
    TEST_HELPER: join(root, "bin/collab.mjs"),
  };
  const argv = [
    join(root, "bin/connector.mjs"),
    "--agent",
    kind,
    "--repo",
    repo,
    "--server",
    `http://127.0.0.1:${app.server.address().port}`,
    "--auto-accept",
  ];
  async function runtime(source) {
    await writeFile(join(bin, kind), `#!${process.execPath}\n${source}`, {
      mode: 0o755,
    });
  }
  return { ...app, dir, repo, member, agent, task, argv, env, runtime };
}
for (const kind of ["codex", "claude"])
  test(`${kind} adapter executes isolated worktree, forwards mailbox, and retains source repository`, async (t) => {
    const f = await fixture(t, kind);
    await f.runtime(`
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
if(process.env.AGENT_COLLAB_TOKEN)throw new Error('Token leaked to child');
fs.writeFileSync('hello.txt','hello');
execFileSync(process.execPath,[process.env.TEST_HELPER,'message','Created greeting in isolated worktree']);
if(${JSON.stringify(kind)}==='codex')fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'Created hello.txt; content verified.');
else console.log(JSON.stringify({type:'result',result:'Created hello.txt; content verified.',is_error:false}));
`);
    const result = await exec(process.execPath, f.argv, {
      env: f.env,
      timeout: 20000,
    });
    assert.match(
      result.stdout,
      /结果已提交 · success/,
      JSON.stringify(f.store.snapshot(f.member).runs),
    );
    const state = f.store.snapshot(f.member),
      run = state.runs[0];
    assert.equal(state.tasks[0].status, "review");
    assert.match(run.branch, /^codex\/collab-/);
    assert.equal(
      await readFile(join(run.worktree, "hello.txt"), "utf8"),
      "hello",
    );
    await assert.rejects(readFile(join(f.repo, "hello.txt")), {
      code: "ENOENT",
    });
    assert.ok(
      state.messages.some(
        (m) => m.content === "Created greeting in isolated worktree",
      ),
    );
    const changes = (
      await exec("git", ["status", "--porcelain"], { cwd: run.worktree })
    ).stdout;
    assert.ok(!changes.includes(".collab"));
    const sourceChanges = (
      await exec("git", ["status", "--porcelain"], { cwd: f.repo })
    ).stdout;
    assert.equal(sourceChanges, "");
    assert.match(run.artifact, /hello.txt/);
    assert.ok(!run.artifact.includes("context.json"));
    const log = JSON.parse(
      await readFile(join(run.worktree, "..", "result.json"), "utf8"),
    );
    assert.equal(log.outcome, "success");
  });
test("successful CLI exit without a final result is an error, not a review", async (t) => {
  const f = await fixture(t, "codex");
  await f.runtime("process.exit(0)");
  await exec(process.execPath, f.argv, { env: f.env, timeout: 20000 });
  const state = f.store.snapshot(f.member);
  assert.equal(state.tasks[0].status, "blocked");
  assert.equal(state.runs[0].status, "error");
});
test("Claude permission denials are reported as blocked", async (t) => {
  const f = await fixture(t, "claude");
  await f.runtime(
    `console.log(JSON.stringify({type:'result',result:'Need permission',permission_denials:[{tool_name:'Bash'}]}))`,
  );
  await exec(process.execPath, f.argv, { env: f.env, timeout: 20000 });
  assert.equal(f.store.snapshot(f.member).tasks[0].status, "blocked");
});
test("cancellation kills an unresponsive child before reporting completion", async (t) => {
  const f = await fixture(t, "codex");
  await f.runtime("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
  const child = spawn(process.execPath, f.argv, { env: f.env, stdio: "pipe" });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const completion = new Promise((res, rej) => {
    child.once("error", rej);
    child.once("close", res);
  });
  const deadline = Date.now() + 10000;
  while (!output.includes("启动 codex") && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.match(output, /启动 codex/);
  await new Promise((r) => setTimeout(r, 300));
  f.store.action(f.member, f.task.taskId, { action: "cancel" });
  await completion;
  const state = f.store.snapshot(f.member);
  assert.equal(state.runs[0].status, "cancelled");
  assert.equal(state.tasks[0].status, "blocked");
});
