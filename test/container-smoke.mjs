import { requestJSON } from "./http-client.mjs";
// CI-only Docker smoke test. No model calls or real credentials.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const name = `collab-smoke-${process.pid}`,
  volume = `${name}-data`;
const setupKey = "ci-only-not-a-secret-at-least-32-characters";
const origin = "https://collab.example.test";
let port;
const docker = (...args) => exec("docker", args, { timeout: 60000 });
async function request(path, body, token = "") {
  return requestJSON(`http://127.0.0.1:${port}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Host: "collab.example.test",
      Origin: origin,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}
async function healthy() {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await request("health")).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Container did not become healthy");
}
try {
  await docker("volume", "create", volume);
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--tmpfs",
    "/tmp:size=16m",
    "-p",
    "127.0.0.1::4317",
    "-v",
    `${volume}:/data`,
    "-e",
    `PUBLIC_ORIGIN=${origin}`,
    "-e",
    `AGENT_COLLAB_SETUP_KEY=${setupKey}`,
    "agent-collab:ci",
  );
  const mapping = await docker("port", name, "4317");
  port = mapping.stdout.trim().split(":").at(-1);
  await healthy();
  assert.equal(
    (
      await request("spaces", {
        name: "No key",
        goal: "No key",
        memberName: "Unknown",
      })
    ).status,
    403,
  );
  const owner = await request("spaces", {
    name: "Container team",
    goal: "Two people collaborate",
    memberName: "Owner",
    setupKey,
  });
  assert.equal(owner.status, 201);
  const invite = await request("invites", {}, owner.data.token);
  const partner = await request("join", {
    invite: invite.data.invite,
    name: "Partner",
  });
  assert.equal(partner.status, 201);
  const agent = await request(
    "agents",
    { name: "Partner demo", kind: "demo" },
    partner.data.token,
  );
  const task = await request(
    "tasks",
    {
      title: "Deployment smoke",
      description: "Verify shared task handoff",
      acceptance: "Human review is required",
      agentId: agent.data.agentId,
    },
    owner.data.token,
  );
  const run = await request(
    "worker/claim",
    { taskId: task.data.taskId, kind: "demo" },
    agent.data.token,
  );
  assert.equal(
    (
      await request(
        "worker/finish",
        {
          runId: run.data.runId,
          outcome: "success",
          summary: "Simulated connector protocol verified",
        },
        agent.data.token,
      )
    ).status,
    200,
  );
  await docker(
    "exec",
    name,
    "node",
    "bin/backup.mjs",
    "/data/backups/smoke.sqlite",
  );
  await docker("restart", name);
  await healthy();
  let state = await request("state", undefined, owner.data.token);
  assert.equal(state.data.members.length, 2);
  assert.equal(state.data.tasks[0].status, "review");
  assert.equal(
    (
      await request(
        `tasks/${task.data.taskId}/action`,
        { action: "approve" },
        partner.data.token,
      )
    ).status,
    403,
  );
  await request(
    `tasks/${task.data.taskId}/action`,
    { action: "approve" },
    owner.data.token,
  );
  state = await request("state", undefined, owner.data.token);
  assert.equal(state.data.tasks[0].status, "done");
  console.log(
    "Container: two-member handoff, authorization, backup and restart persistence passed.",
  );
} finally {
  await docker("rm", "-f", name).catch(() => {});
  await docker("volume", "rm", volume).catch(() => {});
}
