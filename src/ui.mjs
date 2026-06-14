// baleia — minimal LAN UI (Helena/UX: zero-friction capture, guided review).
// One file, no build. Tabs: Inbox · Context · Proposed. Helper text throughout.

export const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>baleia</title>
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
  input{flex:1;min-width:160px;padding:10px 12px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;font:inherit}
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
</style></head><body>
<header><b>🐋 baleia</b><span class="s" id="status">…</span>
  <div class="flow"><b>Dump</b> → <b>Distill</b> (→ Context) → <b>Plan</b> (→ Proposed) → <b>Approve</b> → <b>Push to krill</b></div>
</header>
<nav>
  <button class="on" onclick="tab('inbox',this)">Inbox</button>
  <button onclick="tab('context',this)">Context</button>
  <button onclick="tab('proposed',this)">Proposed</button>
</nav>
<main>
  <section id="inbox">
    <p class="hint">Dump <b>anything</b> from any project — ⌘/Ctrl-Enter to send. A <i>project hint</i> is optional (baleia routes it if you skip it).
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
    <p class="hint">baleia's living memory — one <b>CONTEXT.md</b> per project, built from your dumps. Pick a project to read it, then <b>Plan this</b> to have the team propose tasks from it. <b>Onboard</b> audits a code project (read-only) into CONTEXT so baleia knows it.</p>
    <div class="row">
      <input id="obk" placeholder="project key to onboard (e.g. arqtrack, baleia)"/>
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
</main>
<script>
const j=(u,o)=>fetch(u,o).then(r=>r.json());
function tab(id,btn){for(const s of ['inbox','context','proposed'])document.getElementById(s).style.display=s===id?'':'none';
  for(const b of document.querySelectorAll('nav button'))b.classList.toggle('on',b===btn);
  if(id==='context')loadContext(); if(id==='proposed')loadProposed();}
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

async function status(){const h=await j('/api/health');document.getElementById('status').textContent=
  'runner='+h.runner+' · bypass='+h.autonomy.bypass+' · autoPush='+h.autonomy.autoPush;}

async function loadInbox(){const {entries}=await j('/api/inbox');const l=document.getElementById('ilist');
  if(!entries.length){l.innerHTML='<li class="empty">empty — drop your first thing above.</li>';return;}
  l.innerHTML=entries.map(e=>'<li>'+esc(e.text)+'<div class="meta"><span class="pill">'+e.status+'</span>'+
    (e.lane?'<span class="pill lane-'+e.lane+'">'+e.lane.replace('_',' ')+'</span>':'')+
    (e.project_hint?'<span class="pill">'+esc(e.project_hint)+'</span>':'')+
    '<span>'+new Date(e.created_at).toLocaleString()+'</span>'+
    '<button class="ghost" onclick="route(\\''+e.id+'\\')" title="Ask the router where this note belongs, and file it.">route?</button></div></li>').join('');}
async function dump(){const t=document.getElementById('t'),h=document.getElementById('hint');
  if(!t.value.trim())return; await j('/api/inbox',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:t.value.trim(),project_hint:h.value.trim()||null})}); t.value='';h.value='';t.focus();loadInbox();}
async function distill(){const r=await j('/api/distill',{method:'POST'});
  alert('Distilled '+r.distilled+' note(s) → Context for: '+(r.keys||[]).map(k=>k.key).join(', ')+'\\n\\nOpen the Context tab to read them.'); loadInbox();}
async function route(id){const r=await j('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
  alert('Filed as: '+r.lane+(r.projectKey?' ['+r.projectKey+']':'')+(r.question?'\\n'+r.question:'')+(r.gated?'\\n('+r.note+')':'')+'\\n\\nwhy: '+(r.reason||'')); loadInbox();}

async function onboard(){const k=document.getElementById('obk').value.trim(); if(!k)return;
  const r=await j('/api/onboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})});
  alert(r.ok?('Onboarded '+r.key+' → CONTEXT ('+r.chars+' chars). Open it below.'):('⚠ '+(r.note||r.error))); document.getElementById('obk').value=''; loadContext();}
async function loadContext(){const {keys}=await j('/api/context');const el=document.getElementById('ctxbody');
  if(!keys.length){el.innerHTML='<p class="empty">No context yet. Dump things in Inbox, then hit <b>Distill all</b>.</p>';return;}
  el.innerHTML='<h3>projects</h3>'+keys.map(k=>'<button class="ghost" onclick="viewCtx(\\''+k+'\\')">'+esc(k)+'</button> ').join('')+'<div id="ctxview"></div>';}
async function viewCtx(k){const {md}=await j('/api/context?key='+encodeURIComponent(k));
  document.getElementById('ctxview').innerHTML='<div class="row" style="margin:14px 0"><b>'+esc(k)+
    '</b><button class="act" onclick="plan(\\''+k+'\\')" title="Run the planner (Augusto+Maria) over this context to propose tasks.">Plan this →</button></div><pre>'+esc(md||'(empty)')+'</pre>';}
async function plan(k){const r=await j('/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})});
  alert('Proposed '+(r.proposed||[]).length+' task(s) for '+k+'.\\n\\nReview them in the Proposed tab.');}

async function pushBatch(){const k=document.getElementById('batchk').value.trim(); if(!k)return;
  const post=(body)=>j('/api/proposed/push-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let r=await post({key:k});
  if(r.needsConfirm){ if(!confirm('⚠ ARM AUTO-FINISH\\n\\n'+r.message)){loadProposed();return;} r=await post({key:k,confirm:true}); }
  alert(r.ok?('Pushed '+r.pushed+'/'+(r.total||r.pushed)+' to krill (dependency-ordered).'):('⚠ '+r.error)); loadProposed();}
async function loadProposed(){const {proposed}=await j('/api/proposed');const el=document.getElementById('propbody');
  if(!proposed.length){el.innerHTML='<p class="empty">Nothing proposed yet. Distill, then Plan a project in the Context tab.</p>';return;}
  el.innerHTML='<ul>'+proposed.map(p=>'<li><b>'+esc(p.name)+'</b>'+(p.description?'<div class="meta">'+esc(p.description)+'</div>':'')+
    '<div class="meta"><span class="pill '+(p.risk_tier||'')+'">'+(p.risk_tier||'?')+' risk</span>'+
    '<span class="pill">'+p.priority+'</span><span class="pill">'+p.mode+'</span>'+
    (p.bypass?'<span class="pill by">bypass review</span>':'<span class="pill">needs your review</span>')+
    '<span class="pill">'+p.status+'</span><span class="pill">'+esc(p.project_key)+'</span></div>'+
    '<div class="meta">'+esc(p.rationale||'')+(p.push_error?' · ⚠ '+esc(p.push_error):'')+'</div>'+
    (p.status!=='pushed'?'<div class="row" style="margin-top:8px">'+
      (p.status==='proposed'?'<button class="act" onclick="pAct(\\''+p.id+'\\',\\'approve\\')" title="Accept this task. With autoPush off it stages for a manual push.">Approve</button>'+
        '<button class="ghost danger" onclick="pAct(\\''+p.id+'\\',\\'reject\\')" title="Discard this proposal.">Reject</button>':'')+
      (p.status==='approved'?'<button class="act" onclick="pAct(\\''+p.id+'\\',\\'push\\')" title="Send to krill as a BACKLOG task (carries the bypass flag).">Push to krill</button>':'')+
      '<button class="ghost" onclick="reassignTask(\\''+p.id+'\\')" title="Move to a different project and re-triage (re-runs risk + self-edit guard).">Reassign</button>'+
      '</div>':'')+
    '</li>').join('')+'</ul>';}
async function pAct(id,a){const post=(body)=>j('/api/proposed/'+id+'/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  let r=await post();
  if(r.needsConfirm){ if(!confirm('⚠ ARM AUTO-FINISH\\n\\n'+r.message)){loadProposed();return;} r=await post({confirm:true}); }
  if(r.error)alert('⚠ '+r.error); else if(r.note)alert(r.note); else if(r.pushed)alert('Pushed to krill as '+(r.task&&r.task.krill_task_id||'?')); loadProposed();}
async function reassignTask(id){const k=prompt('Reassign to which project? (e.g. baleia, krill, arqtrack, mv)'); if(!k)return;
  const r=await j('/api/proposed/'+id+'/reassign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_key:k.trim()})});
  if(r.error)alert('⚠ '+r.error); loadProposed();}

status();loadInbox();
document.getElementById('t').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')dump();});
</script></body></html>`;
