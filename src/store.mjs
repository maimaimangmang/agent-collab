import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const id = () => randomUUID();
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function required(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${label}不能为空，且不能超过 ${max} 字符`);
  return value.trim();
}
const check = (condition, status, message) => { if (!condition) throw new AppError(status, message); };

export class Store {
  constructor(file, { now = () => Date.now(), leaseMs = 45000 } = {}) {
    this.now = now;
    this.leaseMs = leaseMs;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), expires_at INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), member_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, last_seen INTEGER, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), status TEXT NOT NULL, depends_on TEXT REFERENCES tasks(id), current_run TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL REFERENCES agents(id), token_hash TEXT UNIQUE NOT NULL, status TEXT NOT NULL, lease_until INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT, summary TEXT, artifact TEXT, worktree TEXT, branch TEXT, base_commit TEXT);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), task_id TEXT REFERENCES tasks(id), author TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run_messages (run_id TEXT NOT NULL REFERENCES runs(id), message_id TEXT NOT NULL, PRIMARY KEY(run_id,message_id));
      CREATE INDEX IF NOT EXISTS task_space ON tasks(space_id);
      CREATE INDEX IF NOT EXISTS message_space ON messages(space_id, created_at);
    `);
  }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  exec(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
  member(secret) {
    const row = this.one('SELECT * FROM members WHERE token_hash=?', hash(secret));
    check(row, 401, '访问凭证无效，请重新进入空间'); return row;
  }
  agent(secret) {
    const row = this.one('SELECT * FROM agents WHERE token_hash=? AND enabled=1', hash(secret));
    check(row, 401, '连接器凭证无效或已停用'); return row;
  }
  activeRun(secret) {
    const row = this.one(`SELECT r.*, t.space_id, t.current_run, a.name AS agent_name FROM runs r JOIN tasks t ON t.id=r.task_id JOIN agents a ON a.id=r.agent_id WHERE r.token_hash=?`, hash(secret));
    check(row && row.current_run === row.id && row.status === 'running' && row.lease_until > this.now() && !row.cancel_requested, 409, '本轮执行已停止或连接租约已失效'); return row;
  }
  ownTask(member, taskId) {
    const task = this.one('SELECT * FROM tasks WHERE id=? AND space_id=?', taskId, member.space_id);
    check(task, 404, '任务不存在'); return task;
  }
  owner(member) { check(member.role === 'owner', 403, '只有空间负责人可以执行此操作'); }
  event(space, author, content, taskId = null, kind = 'system') {
    this.exec('INSERT INTO messages VALUES (?,?,?,?,?,?,?)', id(), space, taskId, author, kind, content, this.now());
  }
  create({ name, goal, memberName }) {
    name = required(name, '空间名称', 80); goal = required(goal, '共同目标', 8000); memberName = required(memberName, '你的名字', 40);
    return this.transaction(() => {
      const spaceId = id(), memberId = id(), secret = token();
      this.exec('INSERT INTO spaces VALUES (?,?,?,?)', spaceId, name, goal, this.now());
      this.exec('INSERT INTO members VALUES (?,?,?,?,?,?)', memberId, spaceId, memberName, 'owner', hash(secret), this.now());
      return { token: secret, spaceId };
    });
  }
  invite(member) {
    this.owner(member); const secret = token();
    this.exec('INSERT INTO invites (token_hash,space_id,expires_at) VALUES (?,?,?)', hash(secret), member.space_id, this.now() + 7 * 86400000);
    return { invite: secret, expiresInDays: 7 };
  }
  join({ invite, name }) {
    name = required(name, '名字', 40); invite = required(invite, '邀请码', 200);
    return this.transaction(() => {
      const invitation = this.one('SELECT * FROM invites WHERE token_hash=?', hash(invite));
      check(invitation && invitation.expires_at > this.now() && invitation.uses < 10, 400, '邀请码无效、过期或已达到 10 人上限');
      const secret = token();
      this.exec('INSERT INTO members VALUES (?,?,?,?,?,?)', id(), invitation.space_id, name, 'member', hash(secret), this.now());
      this.exec('UPDATE invites SET uses=uses+1 WHERE token_hash=?', hash(invite));
      this.event(invitation.space_id, name, '加入了任务空间');
      return { token: secret, spaceId: invitation.space_id };
    });
  }
  register(member, { name, kind }) {
    name = required(name, 'Agent 名称', 60); check(['codex', 'claude', 'demo'].includes(kind), 400, '不支持的 Agent 类型');
    const agentId = id(), secret = token();
    this.exec('INSERT INTO agents (id,space_id,member_id,name,kind,token_hash) VALUES (?,?,?,?,?,?)', agentId, member.space_id, member.id, name, kind, hash(secret));
    this.event(member.space_id, member.name, `添加了 ${name}（${kind}）`);
    return { agentId, token: secret, kind };
  }
  createTask(member, body) {
    const title = required(body.title, '标题', 120), description = required(body.description, '任务说明', 8000), acceptance = required(body.acceptance, '验收标准', 4000);
    const agentId = body.agentId || null, dependency = body.dependsOn || null;
    if (agentId) {
      const agent = this.one('SELECT * FROM agents WHERE id=? AND space_id=? AND enabled=1', agentId, member.space_id);
      check(agent, 400, 'Agent 不属于此空间');
      check(member.role === 'owner' || agent.member_id === member.id, 403, '成员只能给自己的 Agent 分配任务');
    }
    if (dependency) this.ownTask(member, dependency);
    const taskId = id();
    this.exec('INSERT INTO tasks (id,space_id,title,description,acceptance,agent_id,status,depends_on,created_at) VALUES (?,?,?,?,?,?,?,?,?)', taskId, member.space_id, title, description, acceptance, agentId, 'ready', dependency, this.now());
    this.event(member.space_id, member.name, `创建任务：${title}`, taskId);
    return { taskId };
  }
  assign(member, taskId, agentId) {
    const task = this.ownTask(member, taskId);
    check(task.status === 'ready', 409, '只有待领取任务可以调整分配');
    const agent = this.one('SELECT * FROM agents WHERE id=? AND space_id=? AND enabled=1', agentId, member.space_id);
    check(agent, 404, 'Agent 不存在');
    check(member.role === 'owner' || (agent.member_id === member.id && (!task.agent_id || task.agent_id === agentId)), 403, '成员只能认领未分配的任务到自己的 Agent');
    this.exec('UPDATE tasks SET agent_id=? WHERE id=?', agentId, taskId);
    this.event(member.space_id, member.name, `将任务分配给 ${agent.name}`, taskId);
  }
  sweep() {
    const lost = this.all(`SELECT r.id,t.id AS task_id,t.space_id FROM runs r JOIN tasks t ON t.current_run=r.id WHERE r.status='running' AND r.lease_until<=?`, this.now());
    for (const run of lost) {
      this.exec("UPDATE runs SET status='lost' WHERE id=?", run.id);
      this.exec("UPDATE tasks SET status='blocked' WHERE id=?", run.task_id);
      this.event(run.space_id, '系统', '连接器失联，执行结果未知。确认本地进程已停止后才能重试。', run.task_id);
    }
  }
  snapshot(member) {
    this.sweep();
    return {
      me: { id: member.id, name: member.name, role: member.role },
      space: this.one('SELECT * FROM spaces WHERE id=?', member.space_id),
      members: this.all('SELECT id,name,role FROM members WHERE space_id=? ORDER BY created_at', member.space_id),
      agents: this.all('SELECT id,member_id,name,kind,last_seen,enabled FROM agents WHERE space_id=?', member.space_id).map(a => ({ ...a, online: !!a.last_seen && a.last_seen > this.now() - this.leaseMs })),
      tasks: this.all('SELECT * FROM tasks WHERE space_id=? ORDER BY created_at', member.space_id),
      runs: this.all('SELECT r.id,r.task_id,r.agent_id,r.status,r.started_at,r.ended_at,r.cancel_requested,r.blocked_reason,r.summary,r.artifact,r.worktree,r.branch,r.base_commit FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.space_id=? ORDER BY r.started_at', member.space_id),
      messages: this.all('SELECT * FROM (SELECT * FROM messages WHERE space_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200) ORDER BY created_at', member.space_id),
      decisions: this.all('SELECT * FROM decisions WHERE space_id=? ORDER BY created_at', member.space_id),
    };
  }
  next(agent) {
    this.sweep(); this.exec('UPDATE agents SET last_seen=? WHERE id=?', this.now(), agent.id);
    if (this.one("SELECT id FROM runs WHERE agent_id=? AND status IN ('running','lost')", agent.id)) return { task: null, kind:agent.kind };
    return { kind:agent.kind, task: this.one(`SELECT t.* FROM tasks t LEFT JOIN tasks d ON t.depends_on=d.id WHERE t.space_id=? AND t.agent_id=? AND t.status='ready' AND (t.depends_on IS NULL OR d.status='done') ORDER BY t.created_at LIMIT 1`, agent.space_id, agent.id) || null };
  }
  claim(agent, taskId, kind = agent.kind) {
    check(kind === agent.kind, 400, '连接器类型与登记的 Agent 不一致');
    return this.transaction(() => {
      this.sweep();
      check(!this.one("SELECT id FROM runs WHERE agent_id=? AND status IN ('running','lost')", agent.id), 409, 'Agent 已有未结清的执行');
      const task = this.one('SELECT * FROM tasks WHERE id=? AND space_id=?', taskId, agent.space_id);
      check(task && task.agent_id === agent.id && task.status === 'ready', 409, '任务已被领取或未分配给此 Agent');
      if (task.depends_on) check(this.one('SELECT status FROM tasks WHERE id=?', task.depends_on)?.status === 'done', 409, '依赖任务尚未验收');
      const runId = id(), secret = token();
      this.exec('INSERT INTO runs (id,task_id,agent_id,token_hash,status,lease_until,started_at) VALUES (?,?,?,?,?,?,?)', runId, task.id, agent.id, hash(secret), 'running', this.now() + this.leaseMs, this.now());
      this.exec("UPDATE tasks SET status='running',current_run=? WHERE id=?", runId, task.id);
      this.exec('UPDATE agents SET last_seen=? WHERE id=?', this.now(), agent.id);
      this.event(agent.space_id, agent.name, '已领取任务，准备执行', task.id);
      return { runId, runToken: secret, task, context: this.context(agent.space_id, task.id), leaseMs: this.leaseMs };
    });
  }
  context(spaceId, taskId) {
    return { results: this.all('SELECT r.task_id,r.status,r.summary,r.artifact FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.space_id=? AND r.summary IS NOT NULL ORDER BY r.started_at DESC LIMIT 20', spaceId), space: this.one('SELECT * FROM spaces WHERE id=?', spaceId), task: this.one('SELECT * FROM tasks WHERE id=?', taskId), tasks: this.all('SELECT id,title,status,acceptance FROM tasks WHERE space_id=?', spaceId), decisions: this.all('SELECT author,content,created_at FROM decisions WHERE space_id=?', spaceId), messages: this.all('SELECT author,kind,content,task_id FROM messages WHERE space_id=? AND (task_id=? OR task_id IS NULL) ORDER BY created_at DESC LIMIT 30', spaceId, taskId).reverse() };
  }
  ownedRun(agent, runId) {
    const run = this.one('SELECT r.*,t.current_run,t.space_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=? AND r.agent_id=?', runId, agent.id);
    check(run && run.current_run === run.id, 409, '执行已被替换或不属于此 Agent'); return run;
  }
  heartbeat(agent, { runId, worktree, branch, baseCommit }) {
    this.sweep(); const run = this.ownedRun(agent, runId);
    this.exec('UPDATE agents SET last_seen=? WHERE id=?', this.now(), agent.id);
    if (run.status !== 'running') return { cancel: true, reason: '执行租约已失效' };
    this.exec('UPDATE runs SET lease_until=?,worktree=COALESCE(?,worktree),branch=COALESCE(?,branch),base_commit=COALESCE(?,base_commit) WHERE id=?', this.now() + this.leaseMs, typeof worktree === 'string' ? worktree.slice(0,2000) : null, typeof branch === 'string' ? branch.slice(0,200) : null, typeof baseCommit === 'string' ? baseCommit.slice(0,100) : null, run.id);
    return { cancel: !!run.cancel_requested };
  }
  finish(agent, { runId, outcome, summary, artifact }) {
    summary = required(summary, '执行结果', 16000);
    check(['success', 'error', 'cancelled'].includes(outcome), 400, '执行结果无效');
    return this.transaction(() => {
      this.sweep();
      const run = this.ownedRun(agent, runId);
      if (!['running', 'lost'].includes(run.status)) return { duplicate: true };
      const stopped = run.cancel_requested || run.status === 'lost' || outcome === 'cancelled';
      const status = stopped ? 'cancelled' : outcome === 'error' ? 'error' : run.blocked_reason ? 'waiting' : 'review';
      this.exec('UPDATE runs SET status=?,ended_at=?,summary=?,artifact=? WHERE id=?', status, this.now(), summary, typeof artifact === 'string' ? artifact.slice(0,16000) : '', run.id);
      this.exec('UPDATE tasks SET status=? WHERE id=?', status === 'review' ? 'review' : status === 'waiting' ? 'waiting' : 'blocked', run.task_id);
      this.event(agent.space_id, agent.name, status === 'review' ? '提交了成果，等待负责人验收' : status === 'waiting' ? '需要协作，等待补充信息' : '执行已停止或失败，请查看结果', run.task_id);
      return { status };
    });
  }
  action(member, taskId, { action, confirmStopped }) {
    this.owner(member); const task = this.ownTask(member, taskId);
    const run = task.current_run ? this.one('SELECT * FROM runs WHERE id=?', task.current_run) : null;
    if (action === 'cancel') {
      check(run && run.status === 'running', 409, '当前没有正在执行的任务');
      this.exec('UPDATE runs SET cancel_requested=1 WHERE id=?', run.id);
      this.event(member.space_id, member.name, '请求停止执行，等待连接器确认', taskId);
    } else if (action === 'approve') {
      check(task.status === 'review', 409, '只有待验收任务可以完成');
      this.exec("UPDATE tasks SET status='done' WHERE id=?", taskId);
      this.event(member.space_id, member.name, '验收通过', taskId);
    } else if (action === 'retry') {
      check(['review','waiting','blocked'].includes(task.status), 409, '任务当前不能重新派发');
      check(!run || run.status !== 'lost' || confirmStopped === true, 409, '必须先确认失联的本地进程已停止');
      if (run?.status === 'lost') this.exec("UPDATE runs SET status='cancelled',ended_at=? WHERE id=?", this.now(), run.id);
      this.exec("UPDATE tasks SET status='ready',current_run=NULL WHERE id=?", taskId);
      this.event(member.space_id, member.name, '重新派发任务；新执行将使用新的 worktree，已有成果仍保留', taskId);
    } else throw new AppError(400, '未知操作');
  }
  postMessage(member, body) {
    const content = required(body.content, '消息', 4000), taskId = body.taskId || null;
    if (taskId) this.ownTask(member, taskId);
    check(['message','question'].includes(body.kind || 'message'), 400, '消息类型无效');
    this.event(member.space_id, member.name, content, taskId, body.kind || 'message');
  }
  postDecision(member, body) {
    this.owner(member); const content = required(body.content, '项目决定', 4000);
    this.exec('INSERT INTO decisions VALUES (?,?,?,?,?)', id(), member.space_id, member.name, content, this.now());
    this.event(member.space_id, member.name, '确认了一项项目决定');
  }
  runMessage(run, body) {
    const content = required(body.content, '消息', 4000), kind = body.kind || 'message';
    check(['message','question','blocked'].includes(kind), 400, '消息类型无效');
    const messageId = required(body.messageId, '消息 ID', 100);
    return this.transaction(() => {
      if (this.one('SELECT 1 FROM run_messages WHERE run_id=? AND message_id=?',run.id,messageId)) return { duplicate:true };
      this.exec('INSERT INTO run_messages VALUES (?,?)',run.id,messageId);
      this.event(run.space_id, run.agent_name, content, run.task_id, kind);
      if (kind === 'blocked') this.exec('UPDATE runs SET blocked_reason=? WHERE id=?', content, run.id);
    });
  }
}
