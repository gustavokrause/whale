// whale — minimal LAN UI (Helena/UX: zero-friction capture, guided review).
// One file, no build. Tabs: Inbox · Context · Proposed. Helper text throughout.

export const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>whale</title>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0d1117;color:#e6edf3}
  header{padding:14px 20px;border-bottom:1px solid #21262d}
  header b{font-size:18px}header .s{color:#7d8590;font-size:12px;margin-left:8px}
  .flow{color:#7d8590;font-size:12px;margin-top:4px}
  .flow b{color:#9aa4ad}
  nav{display:flex;gap:4px;padding:10px 20px 0}
  nav button{background:none;border:0;color:#7d8590;padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;font:inherit}
  nav button.on{color:#e6edf3;background:#161b22;border:1px solid #21262d;border-bottom:0}
  main{max-width:760px;margin:0 auto;padding:20px}
  .hint{color:#7d8590;font-size:12.5px;margin:0 0 14px;padding:8px 12px;background:#0f141a;border:1px solid #21262d;border-left:2px solid #2d4a63;border-radius:6px}
  textarea{width:100%;min-height:110px;resize:vertical;padding:12px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;font:inherit}
  .row{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}
  input,select{flex:1;min-width:120px;padding:10px 12px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;font:inherit}
  label{display:inline-flex;align-items:center;gap:8px}label input[type=checkbox]{flex:0;min-width:0;width:16px;height:16px}
  button.act{padding:10px 16px;background:#238636;color:#fff;border:0;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}
  button.ghost{padding:8px 12px;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:8px;cursor:pointer;font:inherit}
  button.danger{background:#3d1418;color:#ff9b9b;border:1px solid #5d2026}
  ul{list-style:none;padding:0;margin:18px 0 0}
  li{padding:12px 14px;border:1px solid #21262d;border-radius:8px;margin-bottom:8px;background:#0f141a}
  .meta{color:#7d8590;font-size:12px;margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .pill{display:inline-block;padding:1px 8px;border-radius:99px;background:#21262d;color:#9aa4ad;font-size:11px}
  .low{background:#13261a;color:#6fd38a}.medium{background:#2a2410;color:#e3c969}.high{background:#3d1418;color:#ff9b9b}
  .by{background:#0f2a33;color:#5ad}
  .lane-task{background:#13233d;color:#7db3ff}.lane-context{background:#21262d;color:#9aa4ad}
  .lane-new_project{background:#2a2410;color:#e3c969}.lane-ask{background:#3d1418;color:#ff9b9b}
  .empty{color:#7d8590}
  pre{white-space:pre-wrap;background:#0f141a;border:1px solid #21262d;border-radius:8px;padding:14px;font:inherit}
  h3{margin:18px 0 8px;color:#9aa4ad;font-size:13px;text-transform:uppercase;letter-spacing:.05em}
  #bar{position:fixed;top:0;left:-30%;height:2px;width:30%;background:#2f81f7;z-index:9;opacity:0}
  body.busy #bar{opacity:1;animation:ind 1.1s linear infinite}
  @keyframes ind{0%{left:-30%}100%{left:100%}}
  body.busy{cursor:progress}
  body.busy main button{opacity:.55;pointer-events:none}
  #busy{color:#e3c969}
</style></head><body>
<div id="bar"></div>
<header><b>🐋 whale</b><span class="s" id="status">…</span><span class="s" id="busy"></span>
  <div class="flow"><b>Dump</b> → <b>Distill</b> (→ Context) → <b>Plan</b> (→ Proposed) → <b>Approve</b> → <b>Push to krill</b></div>
</header>
<nav>
  <button data-tab="inbox" onclick="location.hash='inbox'">Inbox</button>
  <button data-tab="context" onclick="location.hash='context'">Context</button>
  <button data-tab="proposed" onclick="location.hash='proposed'">Proposed</button>
  <button data-tab="settings" onclick="location.hash='settings'">Settings</button>
</nav>
<main>
  <section id="inbox">
    <p class="hint">Dump <b>anything</b> from any project — ⌘/Ctrl-Enter to send. A <i>project hint</i> is optional (whale routes it if you skip it).
       <b>Distill all</b> folds raw notes into per-project Context. <b>route?</b> files one note into a lane (task / context / new&nbsp;project / ask).</p>
    <textarea id="t" placeholder="A thought, a chat snippet, a request, whatever…" autofocus></textarea>
    <div class="row">
      <input id="hint" placeholder="project hint (optional)"/>
      <button class="act" onclick="dump()" title="Save this note. Instant, no AI.">Dump</button>
      <button class="ghost" onclick="distill()" title="Fold all raw notes into CONTEXT.md per project (runs the distiller).">Distill all →</button>
    </div>
    <ul id="ilist"><li class="empty">loading…</li></ul>
  </section>
  <section id="context" style="display:none">
    <p class="hint">whale's living memory — one <b>CONTEXT.md</b> per project, built from your dumps. Pick a project to read it, then <b>Plan this</b> to have the team propose tasks from it. <b>Onboard</b> audits a code project (read-only) into CONTEXT so whale knows it.</p>
    <div class="row">
      <input id="obk" placeholder="project key to onboard (e.g. arqtrack, whale)"/>
      <button class="ghost" onclick="onboard()" title="Audit a code project (read-only) into CONTEXT, or flag seed-needed for idea projects.">Onboard →</button>
    </div>
    <div id="ctxbody"></div>
  </section>
  <section id="proposed" style="display:none">
    <p class="hint">The review gate. Each task shows its <b>risk</b> and whether it'll <b>bypass</b> your review (🟢) or wait for it (🔴/🟡). <b>Approve</b> → <b>Push to krill</b>, or <b>Push batch</b> to send a whole project in dependency order. Nothing reaches krill without passing here.</p>
    <div class="row">
      <input id="batchk" placeholder="project key for batch push"/>
      <button class="act" onclick="pushBatch()" title="Push all pushable tasks for this project to krill, in dependency order.">Push batch →</button>
    </div>
    <div id="propbody"></div>
  </section>
  <section id="settings" style="display:none">
    <p class="hint">Runtime dials — saved to whale's DB and applied <b>live</b> (no restart). The <b>self-edit guard</b> (protected projects) is env-only and read-only here: a no-auth LAN UI must not be able to weaken it.</p>
    <div id="setbody"><p class="empty">loading…</p></div>
  </section>
</main>
<script>
const j=(u,o)=>fetch(u,o).then(r=>r.json());
const TABS=['inbox','context','proposed','settings'];
const curTab=()=>{const h=location.hash.slice(1);return TABS.includes(h)?h:'inbox';};
function applyTab(){const id=curTab();
  for(const s of TABS)document.getElementById(s).style.display=s===id?'':'none';
  for(const b of document.querySelectorAll('nav button'))b.classList.toggle('on',b.dataset.tab===id);
  if(id==='inbox')loadInbox(); else if(id==='context')loadContext(); else if(id==='proposed')loadProposed(); else if(id==='settings')loadSettings();}
window.addEventListener('hashchange',applyTab);
// Live refresh: poll the active LIST view (inbox/proposed) while the tab is
// visible; skip context/settings (would wipe an open CONTEXT or unsaved form).
function refreshActive(){const id=curTab(); if(id==='inbox')loadInbox(); else if(id==='proposed')loadProposed();}
setInterval(()=>{ if(!document.hidden) refreshActive(); }, 5000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden){ status(); refreshActive(); } });
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

// global async/loading state — every long call goes through withBusy so the user
// sees the app is working during the 1-3 min real-Claude waits.
let _busy=0,_label='';
function renderBusy(){document.body.classList.toggle('busy',_busy>0);
  document.getElementById('busy').textContent=_busy>0?('⏳ '+_label+'…'):'';}
async function withBusy(label,p){_busy++;_label=label;renderBusy();
  try{return await p;}finally{_busy--;renderBusy();}}

async function status(){try{const s=await j('/api/status');const dot=s.krill.up?'🟢':'🔴';
  document.getElementById('status').textContent=
    'runner='+s.runner+' · bypass='+s.autonomy.bypass+' · autoPush='+s.autonomy.autoPush+
    ' · krill '+dot+' · inbox '+s.inbox.raw+'/'+s.inbox.total+' · proposed '+s.proposed.total;
  }catch{document.getElementById('status').textContent='status unavailable';}}

async function loadInbox(){const {entries}=await j('/api/inbox');const l=document.getElementById('ilist');
  if(!entries.length){l.innerHTML='<li class="empty">empty — drop your first thing above.</li>';return;}
  l.innerHTML=entries.map(e=>'<li>'+esc(e.text)+'<div class="meta"><span class="pill">'+e.status+'</span>'+
    (e.lane?'<span class="pill lane-'+e.lane+'">'+e.lane.replace('_',' ')+'</span>':'')+
    (e.project_hint?'<span class="pill">'+esc(e.project_hint)+'</span>':'')+
    '<span>'+new Date(e.created_at).toLocaleString()+'</span>'+
    '<button class="ghost" onclick="route(\\''+e.id+'\\')" title="Ask the router where this note belongs, and file it.">route?</button>'+
    '<button class="ghost danger" onclick="delEntry(\\''+e.id+'\\')" title="Delete this note permanently.">✕</button></div></li>').join('');}
async function dump(){const t=document.getElementById('t'),h=document.getElementById('hint');
  if(!t.value.trim())return; await j('/api/inbox',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:t.value.trim(),project_hint:h.value.trim()||null})}); t.value='';h.value='';t.focus();loadInbox();}
async function distill(){const r=await withBusy('Distilling all notes',j('/api/distill',{method:'POST'}));
  alert('Distilled '+r.distilled+' note(s) → Context for: '+(r.keys||[]).map(k=>k.key).join(', ')+'\\n\\nOpen the Context tab to read them.'); loadInbox();}
async function route(id){const r=await withBusy('Routing note',j('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}));
  alert('Filed as: '+r.lane+(r.projectKey?' ['+r.projectKey+']':'')+(r.question?'\\n'+r.question:'')+(r.gated?'\\n('+r.note+')':'')+'\\n\\nwhy: '+(r.reason||'')); loadInbox();}

async function onboard(){const k=document.getElementById('obk').value.trim(); if(!k)return;
  const r=await withBusy('Auditing '+k+' (real Claude — can take 1-3 min)',j('/api/onboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})}));
  alert(r.ok?('Onboarded '+r.key+' → CONTEXT ('+r.chars+' chars). Open it below.'):('⚠ '+(r.note||r.error))); document.getElementById('obk').value=''; loadContext();}
async function loadContext(){const {keys}=await j('/api/context');const el=document.getElementById('ctxbody');
  if(!keys.length){el.innerHTML='<p class="empty">No context yet. Dump things in Inbox, then hit <b>Distill all</b>.</p>';return;}
  el.innerHTML='<h3>projects</h3>'+keys.map(k=>'<button class="ghost" onclick="viewCtx(\\''+k+'\\')">'+esc(k)+'</button> ').join('')+'<div id="ctxview"></div>';}
async function viewCtx(k){const {md}=await j('/api/context?key='+encodeURIComponent(k));
  document.getElementById('ctxview').innerHTML='<div class="row" style="margin:14px 0"><b>'+esc(k)+
    '</b><button class="act" onclick="plan(\\''+k+'\\')" title="Run the planner (Augusto+Maria) over this context to propose tasks.">Plan this →</button></div><pre>'+esc(md||'(empty)')+'</pre>';}
async function plan(k){const r=await withBusy('Planning '+k+' (real Claude)',j('/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})}));
  alert('Proposed '+(r.proposed||[]).length+' task(s) for '+k+'.\\n\\nReview them in the Proposed tab.');}

async function pushBatch(){const k=document.getElementById('batchk').value.trim(); if(!k)return;
  const post=(body)=>withBusy('Pushing batch to krill',j('/api/proposed/push-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
  let r=await post({key:k});
  if(r.needsConfirm){ if(!confirm('⚠ ARM AUTO-FINISH\\n\\n'+r.message)){loadProposed();return;} r=await post({key:k,confirm:true}); }
  alert(r.ok?('Pushed '+r.pushed+'/'+(r.total||r.pushed)+' to krill (dependency-ordered).'):('⚠ '+r.error)); loadProposed();}
async function loadProposed(){const {proposed}=await j('/api/proposed');const el=document.getElementById('propbody');
  const rejN=proposed.filter(p=>p.status==='rejected').length;
  const show=window._showRej?proposed:proposed.filter(p=>p.status!=='rejected');
  const hdr=rejN?'<p class="meta">'+rejN+' rejected hidden · <button class="ghost" onclick="window._showRej=!window._showRej;loadProposed()">'+(window._showRej?'hide':'show')+'</button></p>':'';
  if(!show.length){el.innerHTML=hdr+'<p class="empty">Nothing to review. Distill, then Plan a project in the Context tab.</p>';return;}
  el.innerHTML=hdr+'<ul>'+show.map(p=>'<li><b>'+esc(p.name)+'</b>'+(p.description?'<div class="meta">'+esc(p.description)+'</div>':'')+
    '<div class="meta"><span class="pill '+(p.risk_tier||'')+'">'+(p.risk_tier||'?')+' risk</span>'+
    '<span class="pill">'+p.priority+'</span><span class="pill">'+p.mode+'</span>'+
    (p.bypass?'<span class="pill by">bypass review</span>':'<span class="pill">needs your review</span>')+
    '<span class="pill">'+p.status+'</span><span class="pill">'+esc(p.project_key)+'</span>'+
    '<span class="pill by">flow: '+flowOf(p)+'</span></div>'+
    '<div class="meta">'+esc(p.rationale||'')+(p.push_error?' · ⚠ '+esc(p.push_error):'')+
      (JSON.parse(p.refine_log||'[]').length?' · ✎ refined '+JSON.parse(p.refine_log).length+'×':'')+'</div>'+
    '<div class="row" style="margin-top:8px">'+
      (p.status==='proposed'?'<button class="act" onclick="pAct(\\''+p.id+'\\',\\'approve\\')" title="Accept this task. With autoPush off it stages for a manual push.">Approve</button>'+
        '<button class="ghost danger" onclick="pAct(\\''+p.id+'\\',\\'reject\\')" title="Soft-discard (keeps the row, hidden by default).">Reject</button>':'')+
      (p.status==='approved'?'<button class="act" onclick="pAct(\\''+p.id+'\\',\\'push\\')" title="Send to krill as a BACKLOG task (carries the bypass flag).">Push to krill</button>':'')+
      (p.status!=='pushed'&&p.status!=='rejected'?'<button class="ghost" onclick="refineTask(\\''+p.id+'\\')" title="Give input — whale re-evaluates the task. Repeat until you Approve/Decline.">Input</button>'+
        '<button class="ghost" onclick="reassignTask(\\''+p.id+'\\')" title="Move to a different project and re-triage (re-runs risk + self-edit guard).">Reassign</button>':'')+
      '<button class="ghost danger" onclick="delProposed(\\''+p.id+'\\')" title="Delete this proposal permanently (whale-local; does not touch krill).">✕ delete</button>'+
    '</div>'+
    '</li>').join('')+'</ul>';}
function flowOf(p){ if(p.risk_tier==='high')return '🔴 full review'; if(p.auto_publish)return '🟢 auto-finish→DONE'; if(p.bypass)return '🟡 →deliverable'; return 'plan review'; }
async function refineTask(id){const input=prompt('Input — what should change about this task?'); if(!input)return;
  const r=await withBusy('Refining task (real Claude)',j('/api/proposed/'+id+'/refine',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input})}));
  if(r.error){alert('⚠ '+r.error);} else {alert('Refined → '+r.task.name+'\\nflow: '+r.flow);} loadProposed();}
async function pAct(id,a){const post=(body)=>withBusy(a,j('/api/proposed/'+id+'/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}));
  let r=await post();
  if(r.needsConfirm){ if(!confirm('⚠ ARM AUTO-FINISH\\n\\n'+r.message)){loadProposed();return;} r=await post({confirm:true}); }
  if(r.error)alert('⚠ '+r.error); else if(r.note)alert(r.note); else if(r.pushed)alert('Pushed to krill as '+(r.task&&r.task.krill_task_id||'?')); loadProposed();}
async function reassignTask(id){const k=prompt('Reassign to which project? (e.g. whale, krill, arqtrack, mv)'); if(!k)return;
  const r=await withBusy('Reassigning + re-triaging',j('/api/proposed/'+id+'/reassign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_key:k.trim()})}));
  if(r.error)alert('⚠ '+r.error); loadProposed();}
async function delEntry(id){if(!confirm('Delete this note permanently?'))return; await withBusy('Deleting note',j('/api/inbox/'+id,{method:'DELETE'})); loadInbox();}
async function delProposed(id){if(!confirm('Delete this proposal permanently?\\n(whale-local — does not touch krill.)'))return; await withBusy('Deleting',j('/api/proposed/'+id,{method:'DELETE'})); loadProposed();}

const opt=(val,opts)=>opts.map(o=>'<option'+(o===val?' selected':'')+'>'+o+'</option>').join('');
async function loadSettings(){const c=await j('/api/config');const el=document.getElementById('setbody');
  const M=['haiku','sonnet','opus'];
  el.innerHTML=
    '<h3>runner</h3><div class="row"><select id="s_runner">'+opt(c.runner,['stub','real'])+'</select></div>'+
    '<h3>models</h3><div class="row"><label>distill <select id="s_md">'+opt(c.models.distill,M)+'</select></label>'+
      '<label>plan <select id="s_mp">'+opt(c.models.plan,M)+'</select></label>'+
      '<label>route <select id="s_mr">'+opt(c.models.route,M)+'</select></label></div>'+
    '<h3>autonomy</h3><div class="row"><label>bypass <select id="s_bypass">'+opt(c.autonomy.bypass,['conservative','balanced','aggressive'])+'</select></label></div>'+
    '<div class="row"><label><input type="checkbox" id="s_autopush"'+(c.autonomy.autoPush?' checked':'')+'/> auto-push approved tasks</label></div>'+
    '<div class="row"><label><input type="checkbox" id="s_allownew"'+(c.autonomy.allowNewProjects?' checked':'')+'/> allow proposing new projects</label></div>'+
    '<div class="row"><button class="act" onclick="saveSettings()" title="Apply live — no restart.">Save</button></div>'+
    '<h3>env-locked (read-only)</h3><div class="meta"><span class="pill high">self-edit guard: '+esc((c.envLocked.protected||[]).join(', '))+'</span>'+
      '<span class="pill">krill: '+esc(c.envLocked.krillUrl)+'</span></div>';}
async function saveSettings(){const v=id=>document.getElementById(id);
  const body={runner:v('s_runner').value,model_distill:v('s_md').value,model_plan:v('s_mp').value,model_route:v('s_mr').value,
    bypass:v('s_bypass').value,auto_push:v('s_autopush').checked,allow_new_projects:v('s_allownew').checked};
  const r=await withBusy('Saving settings',j('/api/config',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
  if(r.error){alert('⚠ '+r.error);return;} alert('Saved — applied live.'); status(); loadSettings();}

status();applyTab();
document.getElementById('t').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')dump();});
</script></body></html>`;
