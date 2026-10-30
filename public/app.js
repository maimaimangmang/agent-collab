const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {ready:'待领取',running:'执行中',waiting:'待协作',review:'待验收',blocked:'已阻塞',done:'已完成',error:'执行失败',lost:'连接失联',cancelled:'已停止'};
const date = n => new Date(n).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
let token = localStorage.getItem('agent-collab-token') || '', state, lastSnapshot = '', currentView = 'board', toastTimer, syncing = false;
async function api(path,body,auth = token) {
  const res = await fetch(`/api/${path}`,{method:body === undefined ? 'GET' : 'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth}`},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const data = await res.json(); if (!res.ok) { const error = new Error(data.error || '请求失败'); error.status = res.status; throw error; } return data;
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(()=>$('#toast').hidden = true,4200); }
function openModal(title,html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); }
$('#close-modal').onclick = ()=>$('#modal').close();
function bindForm(selector,handler) {
  $(selector).onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button[type="submit"],button.primary');
    form.querySelector('.form-error')?.remove(); if (button) button.disabled = true;
    try { await handler(Object.fromEntries(new FormData(form)),form); }
    catch(error) { const p = document.createElement('p'); p.className = 'form-error'; p.setAttribute('role','alert'); p.textContent = error.message; form.append(p); }
    finally { if (button) button.disabled = false; }
  };
}
function setEntry(mode) {
  for (const name of ['create','join','restore']) $(`#${name}-form`).hidden = name !== mode;
  document.querySelectorAll('[data-entry]').forEach(b=>b.classList.toggle('active',b.dataset.entry === mode));
}
document.querySelectorAll('[data-entry]').forEach(b=>b.onclick=()=>setEntry(b.dataset.entry));
async function enter(secret) { const next = await api('state',undefined,secret); token = secret; localStorage.setItem('agent-collab-token',token); state = next; lastSnapshot = ''; render(); }
bindForm('#create-form',async data=>{ const result = await api('spaces',data); await enter(result.token); showIdentity(true); });
bindForm('#join-form',async data=>{ if (data.invite.includes('#invite=')) data.invite = new URL(data.invite).hash.slice(8); const result = await api('join',data); await enter(result.token); history.replaceState(null,'','/'); showIdentity(true); });
bindForm('#restore-form',async data=>enter(data.token.trim()));
const invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
if (invitation) { setEntry('join'); $('#join-form input[name=invite]').value = invitation; }
function owner() { return state.me.role === 'owner'; }
function availableAgents() { return state.agents.filter(a=>owner() || a.member_id === state.me.id); }
function agentOptions(includeBlank = true) { return `${includeBlank ? '<option value="">暂不分配</option>' : ''}${availableAgents().map(a=>`<option value="${a.id}">${esc(a.name)} · ${esc(a.kind)}</option>`).join('')}`; }
function taskOptions() { return state.tasks.map(t=>`<option value="${t.id}">${esc(t.title)}</option>`).join(''); }
function render() {
  $('#welcome').hidden = true; $('#workspace').hidden = false;
  $('#space-name').textContent = state.space.name; $('#goal-text').textContent = state.space.goal; $('#identity').textContent = `${state.me.name} · ${owner() ? '负责人' : '成员'} ↗`;
  $('#task-count').textContent = state.tasks.length; $('#member-count').textContent = `${state.members.length} 人`;
  $('#invite-button').hidden = !owner(); $('#decision-form').hidden = !owner();
  $('#stats').innerHTML = `<span><b>${state.tasks.length}</b>全部任务</span><span><b>${state.agents.filter(a=>a.online).length}</b>在线 Agent</span><span><b>${state.tasks.filter(t=>t.status==='done').length}</b>已验收</span><span><b>${state.tasks.filter(t=>['blocked','waiting'].includes(t.status)).length}</b>需要关注</span>`;
  $('#board').innerHTML = ['ready','running','review','waiting','blocked','done'].map(status=>{
    const tasks = state.tasks.filter(t=>t.status===status);
    return `<div class="column"><div class="column-head"><i class="status-dot ${status}"></i>${labels[status]}<b>${tasks.length}</b></div>${tasks.map(t=>{
      const agent = state.agents.find(a=>a.id===t.agent_id), dependency = state.tasks.find(d=>d.id===t.depends_on);
      return `<button class="task-card" data-task="${t.id}"><span class="card-id">TASK / ${t.id.slice(0,4).toUpperCase()}</span><h3>${esc(t.title)}</h3><p>${esc(t.description)}</p>${dependency ? `<p class="dependency">↳ ${dependency.status==='done' ? '依赖已验收' : '等待：'+esc(dependency.title)}</p>` : ''}<div class="card-footer"><span class="card-avatar">${esc(agent?.name.slice(0,1) || '＋')}</span>${esc(agent?.name || '等待成员认领')}</div></button>`;
    }).join('') || `<div class="column-empty">${status==='ready' ? '把目标拆成任务<br>开始团队协作' : '暂无任务'}</div>`}</div>`;
  }).join('');
  document.querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>showTask(b.dataset.task));
  $('#team').innerHTML = state.members.map(m=>`<div class="member"><div class="member-header"><span class="avatar">${esc(m.name.slice(0,1))}</span>${esc(m.name)}<small>${m.role==='owner'?'负责人':m.id===state.me.id?'你':'成员'}</small></div>${state.agents.filter(a=>a.member_id===m.id).map(a=>`<div class="agent-row"><i class="agent-dot ${a.online?'':'offline'}"></i>${esc(a.name)}<small>${esc(a.kind)} · ${a.online?'连接中':'等待连接'}</small></div>`).join('') || '<div class="agent-row muted">尚未接入 Agent</div>'}</div>`).join('');
  $('#messages').innerHTML = state.messages.map(m=>`<article class="message ${m.kind==='system'?'system':''}"><div class="message-head"><b>${esc(m.author)}</b>${m.kind==='question'||m.kind==='blocked'?`<span>${m.kind==='question'?'提问':'阻塞'}</span>`:''}${m.task_id?`<span>${esc(state.tasks.find(t=>t.id===m.task_id)?.title || '任务')}</span>`:''}<time>${date(m.created_at)}</time></div><p>${esc(m.content)}</p></article>`).join('') || '<div class="empty-state">进展、问题和接口约定，都可以在这里讨论。</div>';
  $('#decisions').innerHTML = state.decisions.map(d=>`<article class="decision"><p>${esc(d.content)}</p><small>✓ ${esc(d.author)} 确认 · ${date(d.created_at)}</small></article>`).join('') || '<div class="empty-state">把讨论中达成的共识记录下来，所有 Agent 都能读取。</div>';
  const selected = $('#message-task').value; $('#message-task').innerHTML = '<option value="">整个空间</option>'+taskOptions(); $('#message-task').value = selected;
}
async function refresh() {
  if (!token || syncing) return; syncing = true;
  try { const next = await api('state'); const json = JSON.stringify(next); state = next; if (json !== lastSnapshot) { render(); lastSnapshot = json; } $('#sync').textContent = '● 已同步'; $('#sync').classList.remove('error'); }
  catch(error) { $('#sync').textContent = '○ 连接中断'; $('#sync').classList.add('error'); if (error.status===401) { token=''; localStorage.removeItem('agent-collab-token'); $('#workspace').hidden=true; $('#welcome').hidden=false; toast(error.message); } }
  finally { syncing=false; }
}
for (const button of document.querySelectorAll('[data-view]')) button.onclick=()=>{
  currentView=button.dataset.view; document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));
  for (const view of ['board','discussion','decisions']) $(`#${view}-view`).hidden = view!==currentView;
  $('#view-title').textContent = {board:'任务看板',discussion:'团队讨论',decisions:'项目决定'}[currentView];
  $('#headline').textContent = {board:'一起把任务做完',discussion:'让协作有来有回',decisions:'让团队保持一致'}[currentView];
  $('#new-task').hidden = currentView!=='board';
};
$('#new-task').onclick=()=>{
  openModal('创建一个可交付的任务',`<form id="task-form"><label>任务标题<input name="title" maxlength="120" required placeholder="例如：实现用户登录接口"></label><label>任务说明<textarea name="description" rows="3" required maxlength="8000" placeholder="明确工作范围、接口约定和需要参考的内容。"></textarea></label><label>验收标准<textarea name="acceptance" rows="2" required maxlength="4000" placeholder="怎样才算完成？需要通过哪些检查？"></textarea></label><label>分配给<select name="agentId">${agentOptions()}</select></label><label>前置任务<select name="dependsOn"><option value="">无依赖，可独立开展</option>${taskOptions()}</select></label><p class="modal-note">依赖只控制执行顺序。前置任务的代码需要团队先合并到目标仓库，后续 Agent 才能使用。</p><button class="primary wide">创建任务</button></form>`);
  bindForm('#task-form',async data=>{await api('tasks',data); $('#modal').close(); await refresh();toast('任务已创建');});
};
function showTask(id) {
  const t = state.tasks.find(t=>t.id===id); if (!t) return;
  const runs = state.runs.filter(r=>r.task_id===id), current = runs.find(r=>r.id===t.current_run);
  openModal(t.title,`<span class="muted">TASK / ${t.id.slice(0,4).toUpperCase()} · ${labels[t.status]}</span><div class="detail-label">任务说明</div><div class="detail-text">${esc(t.description)}</div><div class="detail-label">验收标准</div><div class="detail-text">${esc(t.acceptance)}</div>${t.status==='ready'&&availableAgents().length?`<form id="assign-form"><label>执行 Agent<select name="agentId">${agentOptions(false)}</select></label><button class="primary">分配 / 认领</button></form>`:''}${runs.length ? '<div class="detail-label">执行与成果记录</div>' : ''}${runs.map(r=>`<article class="result"><h3>${labels[r.status] || esc(r.status)} · ${date(r.started_at)}${r.cancel_requested?' · 已请求停止':''}</h3><div class="detail-text">${esc(r.summary || '连接器正在本地执行，结果尚未提交。')}</div>${r.blocked_reason?`<p class="warning">${esc(r.blocked_reason)}</p>`:''}<details><summary>分支、工作目录与改动摘要</summary><pre>${esc(r.artifact || `Branch: ${r.branch||'尚未创建'}\nWorktree: ${r.worktree||'尚未创建'}`)}</pre></details></article>`).join('')}${current?.status==='lost'&&owner()?'<label class="check-label"><input type="checkbox" id="confirm-stopped">我已在成员电脑上确认失联的 Agent 进程已停止，可以重新派发。</label>':''}${t.status==='review'&&owner()?'<p class="modal-note">验收表示你已查看成果及验证结果，不会自动合并代码。后续任务需要相关代码时，请先完成提交和同步。</p>':''}<div class="detail-actions">${owner()&&t.status==='running'?'<button class="secondary" data-action="cancel">停止执行</button>':''}${owner()&&t.status==='review'?'<button class="primary" data-action="approve">验收通过 ✓</button>':''}${owner()&&['review','waiting','blocked'].includes(t.status)?'<button class="secondary" data-action="retry">重新派发</button>':''}<button class="secondary" id="discuss-task">讨论此任务 ↗</button></div><p id="task-error" class="form-error" role="alert"></p>`);
  if ($('#assign-form')) { if (t.agent_id) $('#assign-form select').value=t.agent_id; bindForm('#assign-form',async data=>{await api(`tasks/${id}/assign`,data);await refresh();showTask(id);toast('任务分配已更新');}); }
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    try {await api(`tasks/${id}/action`,{action:b.dataset.action,confirmStopped:$('#confirm-stopped')?.checked || false});await refresh();showTask(id);toast('任务状态已更新');}
    catch(e){$('#task-error').textContent=e.message;} finally{b.disabled=false;}
  });
  $('#discuss-task').onclick=()=>{$('#modal').close(); $('[data-view=discussion]').click();$('#message-task').value=id;$('#message-form textarea').focus();};
}
$('#add-agent').onclick=()=>{
  openModal('接入你的 Agent',`<p class="modal-note">创建连接器凭证后，在你自己的电脑启动连接器。执行前默认由你逐项确认。</p><form id="agent-form"><label>Agent 名称<input name="name" required maxlength="60" placeholder="例如：Zoey 的 Codex"></label><label>运行工具<select name="kind"><option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="demo">Demo · 仅演示协作流程</option></select></label><button class="primary wide">生成连接器凭证</button></form>`);
  bindForm('#agent-form',async data=>{
    const result=await api('agents',data); await refresh();
    const command=`AGENT_COLLAB_TOKEN='${result.token}' npm run connector -- --agent ${result.kind} --server '${location.origin}'${result.kind==='demo'?'':' --repo /path/to/your/repo'} --watch`;
    openModal('在成员电脑上完成连接',`<p class="modal-note">在本项目目录中运行下面的命令。${result.kind==='demo'?'演示不会调用模型或生成代码。':'将仓库路径换成你要协作开发的 Git 仓库；需要先有提交，并安装、登录对应 CLI。'}</p><pre class="code">${esc(command)}</pre><p class="warning">凭证只显示这一次，请妥善保存，不要提交到 Git。远程成员需要连接可访问的 HTTPS 服务地址。</p><button class="primary" id="copy-connector">复制连接命令</button>`);
    $('#copy-connector').onclick=()=>copy(command);
  });
};
async function copy(value){try{await navigator.clipboard.writeText(value);toast('已复制');}catch{toast('浏览器未允许复制，请手动选择文字复制');}}
$('#invite-button').onclick=async()=>{
  try{const result=await api('invites',{});const link=`${location.origin}/#invite=${result.invite}`;openModal('邀请伙伴加入',`<p class="modal-note">链接有效期 7 天，最多可加入 10 名成员。每个人加入后接入自己的 Agent。</p><pre class="code">${esc(link)}</pre>${['localhost','127.0.0.1'].includes(location.hostname)?'<p class="warning">当前是本机地址。远程伙伴需要使用部署后的 HTTPS 地址访问此服务。</p>':''}<button id="copy-invite" class="primary">复制邀请链接</button>`);$('#copy-invite').onclick=()=>copy(link);}catch(e){toast(e.message);}
};
function showIdentity(first=false){
  openModal(first?'保存你的访问凭证':'我的访问凭证',`<p class="modal-note">当前身份：${esc(state.me.name)}。此版本使用凭证恢复身份；清空浏览器数据后，需要凭证重新进入空间。</p><input class="token" type="password" readonly value="${esc(token)}" aria-label="成员访问凭证"><div class="copy-actions"><button id="copy-member" class="primary">复制并保存凭证</button><button id="reveal-member" class="secondary">显示凭证</button>${first?'':'<button id="logout" class="secondary">退出此浏览器</button>'}</div><p class="warning">凭证相当于此成员的密码，请勿分享给其他成员或 Agent。</p>`);
  $('#copy-member').onclick=()=>copy(token);$('#reveal-member').onclick=()=>{$('.token').type=$('.token').type==='password'?'text':'password';};
  if($('#logout'))$('#logout').onclick=()=>{localStorage.removeItem('agent-collab-token');token='';state=null;$('#modal').close();$('#workspace').hidden=true;$('#welcome').hidden=false;};
}
$('#identity').onclick=()=>showIdentity();
bindForm('#message-form',async(data,form)=>{await api('messages',data);form.elements.content.value='';await refresh();$('#messages').scrollTop=$('#messages').scrollHeight;});
bindForm('#decision-form',async(data,form)=>{await api('decisions',data);form.reset();await refresh();toast('项目决定已同步');});
if(token && !invitation) refresh();
setInterval(()=>{if(!invitation || !$('#workspace').hidden)void refresh();},2000);
