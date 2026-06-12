// baleia — minimal LAN UI (Helena/UX: zero-friction capture, plain review).
// One file, no build. Tabs: Inbox · Context · Proposed.

export const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>baleia</title>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0d1117;color:#e6edf3}
  header{padding:16px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  header b{font-size:18px}header .s{color:#7d8590;font-size:12px}
  nav{display:flex;gap:4px;padding:10px 20px 0}
  nav button{background:none;border:0;color:#7d8590;padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;font:inherit}
  nav button.on{color:#e6edf3;background:#161b22;border:1px solid #21262d;border-bottom:0}
  main{max-width:760px;margin:0 auto;padding:20px}
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
  .by{background:#0f2a33;color:#5ad}.empty{color:#7d8590}
  pre{white-space:pre-wrap;background:#0f141a;border:1px solid #21262d;border-radius:8px;padding:14px;font:inherit}
  h3{margin:18px 0 8px;color:#9aa4ad;font-size:13px;text-transform:uppercase;letter-spacing:.05em}
</style></head><body>
<header><b>🐋 baleia</b><span class="s" id="status">…</span></header>
<nav>
  <button class="on" onclick="tab('inbox',this)">Inbox</button>
  <button onclick="tab('context',this)">Context</button>
  <button onclick="tab('proposed',this)">Proposed</button>
</nav>
<main>
  <section id="inbox">
    <textarea id="t" placeholder="Dump anything — krill, meu veleiro, saas factory, arqtrack, a stray thought." autofocus></textarea>
    <div class="row">
      <input id="hint" placeholder="project hint (optional)"/>
      <button class="act" onclick="dump()">Dump</button>
      <button class="ghost" onclick="distill()">Distill all →</button>
    </div>
    <ul id="ilist"><li class="empty">loading…</li></ul>
  </section>
  <section id="context" style="display:none"></section>
  <section id="proposed" style="display:none"></section>
</main>
<script>
const j=(u,o)=>fetch(u,o).then(r=>r.json());
function tab(id,btn){for(const s of ['inbox','context','proposed'])document.getElementById(s).style.display=s===id?'':'none';
  for(const b of document.querySelectorAll('nav button'))b.classList.toggle('on',b===btn);
  if(id==='context')loadContext(); if(id==='proposed')loadProposed();}
const esc=s=>s.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

async function status(){const h=await j('/api/health');document.getElementById('status').textContent=
  'runner='+h.runner+' · bypass='+h.autonomy.bypass+' · autoPush='+h.autonomy.autoPush;}

async function loadInbox(){const {entries}=await j('/api/inbox');const l=document.getElementById('ilist');
  if(!entries.length){l.innerHTML='<li class="empty">empty — drop your first thing above.</li>';return;}
  l.innerHTML=entries.map(e=>'<li>'+esc(e.text)+'<div class="meta"><span class="pill">'+e.status+'</span>'+
    (e.project_hint?'<span class="pill">'+esc(e.project_hint)+'</span>':'')+
    '<span>'+new Date(e.created_at).toLocaleString()+'</span>'+
    '<button class="ghost" onclick="route(\\''+e.id+'\\')">route?</button></div></li>').join('');}
async function dump(){const t=document.getElementById('t'),h=document.getElementById('hint');
  if(!t.value.trim())return; await j('/api/inbox',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:t.value.trim(),project_hint:h.value.trim()||null})}); t.value='';h.value='';t.focus();loadInbox();}
async function distill(){const r=await j('/api/distill',{method:'POST'});
  alert('distilled '+r.distilled+' entries → '+(r.keys||[]).map(k=>k.key).join(', ')); loadInbox();}
async function route(id){const r=await j('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
  alert('→ '+r.dest+(r.projectKey?' ['+r.projectKey+']':'')+(r.question?' — '+r.question:'')+(r.gated?' (gated)':'')+'\\n'+(r.reason||''));}

async function loadContext(){const {keys}=await j('/api/context');const el=document.getElementById('context');
  if(!keys.length){el.innerHTML='<p class="empty">No context yet. Dump things, then Distill.</p>';return;}
  el.innerHTML='<h3>projects</h3>'+keys.map(k=>'<button class="ghost" onclick="viewCtx(\\''+k+'\\')">'+esc(k)+'</button> ').join('')+'<div id="ctxview"></div>';}
async function viewCtx(k){const {md}=await j('/api/context?key='+encodeURIComponent(k));
  document.getElementById('ctxview').innerHTML='<div class="row" style="margin:14px 0"><b>'+esc(k)+
    '</b><button class="act" onclick="plan(\\''+k+'\\')">Plan this →</button></div><pre>'+esc(md||'(empty)')+'</pre>';}
async function plan(k){const r=await j('/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})});
  alert('proposed '+(r.proposed||[]).length+' task(s) for '+k+' → see Proposed tab');}

async function loadProposed(){const {proposed}=await j('/api/proposed');const el=document.getElementById('proposed');
  if(!proposed.length){el.innerHTML='<p class="empty">Nothing proposed. Distill, then Plan a project.</p>';return;}
  el.innerHTML=proposed.map(p=>'<li><b>'+esc(p.name)+'</b>'+(p.description?'<div class="meta">'+esc(p.description)+'</div>':'')+
    '<div class="meta"><span class="pill '+(p.risk_tier||'')+'">'+(p.risk_tier||'?')+'</span>'+
    '<span class="pill">'+p.priority+'</span><span class="pill">'+p.mode+'</span>'+
    (p.bypass?'<span class="pill by">bypass</span>':'<span class="pill">review</span>')+
    '<span class="pill">'+p.status+'</span><span class="pill">'+esc(p.project_key)+'</span></div>'+
    '<div class="meta">'+esc(p.rationale||'')+(p.push_error?' · ⚠ '+esc(p.push_error):'')+'</div>'+
    (p.status==='proposed'?'<div class="row" style="margin-top:8px">'+
      '<button class="act" onclick="pAct(\\''+p.id+'\\',\\'approve\\')">Approve</button>'+
      '<button class="ghost danger" onclick="pAct(\\''+p.id+'\\',\\'reject\\')">Reject</button></div>':
     p.status==='approved'?'<div class="row" style="margin-top:8px"><button class="act" onclick="pAct(\\''+p.id+'\\',\\'push\\')">Push to krill</button></div>':'')+
    '</li>').join('');}
async function pAct(id,a){const r=await j('/api/proposed/'+id+'/'+a,{method:'POST'});
  if(r.error||r.note)alert((r.error?'⚠ '+r.error:'')+(r.note?r.note:'')); loadProposed();}

status();loadInbox();
document.getElementById('t').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')dump();});
</script></body></html>`;
