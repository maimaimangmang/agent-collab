#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
let mailbox = process.env.AGENT_COLLAB_MAILBOX;
if (args[0] === '--mailbox') { mailbox = args[1]; args.splice(0,2); }
if (!mailbox) { console.error('此命令需要连接器准备的 --mailbox 路径'); process.exit(1); }
mailbox = resolve(mailbox);
const [command, ...text] = args;
if (command === 'context') {
  console.log(readFileSync(join(mailbox,'context.json'),'utf8'));
} else if (['message','question','block'].includes(command)) {
  const content = text.join(' ').trim();
  if (!content || content.length > 4000) { console.error('消息需为 1–4000 字符'); process.exit(1); }
  const outbox = join(mailbox,'outbox'); mkdirSync(outbox,{recursive:true});
  const name = randomUUID();
  writeFileSync(join(outbox,`${name}.tmp`),JSON.stringify({ kind:command === 'block' ? 'blocked' : command, content }),{mode:0o600});
  renameSync(join(outbox,`${name}.tmp`),join(outbox,`${name}.json`));
  console.log('消息已写入本地发件箱，由连接器同步到团队空间。');
} else {
  console.error('用法：collab.mjs --mailbox <目录> context | message <内容> | question <问题> | block <阻塞原因>');
  process.exit(1);
}
