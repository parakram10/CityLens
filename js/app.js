// CityLens — dashboard app (index.html). Requires js/data.js and js/auth.js first.

// DATA comes from js/data.js, loaded before this file.
const TYPE = {
  pothole:{label:'Pothole',c:'#d32f2f'}, waterlogging:{label:'Waterlogging',c:'#3b6fc4'},
  garbage_pile:{label:'Garbage',c:'#c98a12'}, street_obstruction:{label:'Obstruction',c:'#e56a00'}
};
const SEVW = {1:1,2:2,3:3.5,4:5.5,5:8};
const SEVC = {1:'#8a9099',2:'#3b6fc4',3:'#c98a12',4:'#e56a00',5:'#d32f2f'};
const OPEN = new Set(['confirmed','reported','candidate']);
const fmtDate = s => new Date(s).toLocaleDateString('en-IN',{day:'numeric',month:'short'});
const fmtDT = s => new Date(s).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const issues = DATA.issues;                 // mutable — resolve/verify write here
const wardsFC = DATA.wards;

/* ---------- field crew (one specialism each) ---------- */
// CREW / CREW_CAPACITY come from js/data.js, loaded before this file.
(function assignCrew(){ // deterministic round-robin per category, respecting capacity — every issue gets a responsible crew member while room lasts
  const idx={}, openLoad={};
  issues.forEach(i=>{
    const pool=CREW.filter(c=>c.type===i.type); if(!pool.length)return;
    idx[i.type]=idx[i.type]||0;
    const isOpen=OPEN.has(i.status);
    let pick=null;
    for(let tries=0;tries<pool.length;tries++){
      const cand=pool[idx[i.type]%pool.length]; idx[i.type]++;
      if(!isOpen || (openLoad[cand.id]||0)<CREW_CAPACITY){ pick=cand; break; }
    }
    if(!pick) return;                    // every specialist for this category is at capacity — leave unassigned (backlog)
    i.crew=pick.id;
    if(isOpen) openLoad[pick.id]=(openLoad[pick.id]||0)+1;
  });
})();
function crewById(id){ return CREW.find(c=>c.id===id); }
function crewOpenCount(id){ return issues.filter(i=>i.crew===id&&OPEN.has(i.status)).length; }
function crewLoad(){
  return CREW.map(c=>{
    const mine=issues.filter(i=>i.crew===c.id);
    return {...c, total:mine.length, open:mine.filter(i=>OPEN.has(i.status)).length};
  });
}
function nextCrewId(){
  const used=new Set(CREW.map(c=>c.id)); let n=1;
  while(used.has('CR-'+String(n).padStart(2,'0')))n++;
  return 'CR-'+String(n).padStart(2,'0');
}
function removeCrew(id){
  const idx=CREW.findIndex(c=>c.id===id); if(idx<0)return;
  const removed=CREW[idx];
  CREW.splice(idx,1);
  const pool=CREW.filter(c=>c.type===removed.type);        // reassign their tasks to a remaining specialist, round-robin, respecting capacity
  const openLoad={}; pool.forEach(c=>openLoad[c.id]=crewOpenCount(c.id));
  let n=0;
  issues.forEach(i=>{
    if(i.crew!==id) return;
    const isOpen=OPEN.has(i.status);
    let pick=null;
    for(let tries=0;tries<pool.length;tries++){
      const cand=pool[n%pool.length]; n++;
      if(!isOpen || (openLoad[cand.id]||0)<CREW_CAPACITY){ pick=cand; break; }
    }
    if(pick){ i.crew=pick.id; if(isOpen) openLoad[pick.id]=(openLoad[pick.id]||0)+1; }
    else i.crew=null;                    // no specialist has room — task drops back to unassigned backlog
  });
}

/* ---------- scoring ---------- */
function wardScores(){
  const by={}; wardsFC.features.forEach(f=>by[f.properties.ward]={ward:f.properties.ward,area:f.properties.area,open:0,load:0,resolved:0,mttrSum:0,mttrN:0,total:0});
  issues.forEach(i=>{const w=by[i.ward]; if(!w)return; w.total++;
    if(OPEN.has(i.status)){w.open++; w.load+=SEVW[i.severity];}
    if(i.status==='verified_fixed'||i.status==='resolved'){w.resolved++;
      const d=(new Date(i.last_seen)-new Date(i.first_seen))/36e5; if(d>0){w.mttrSum+=d;w.mttrN++;}}
  });
  Object.values(by).forEach(w=>{
    const density=w.load/Math.max(6,w.total);           // severity-weighted open density
    const fixRate=w.total? w.resolved/w.total:0;
    w.score=Math.max(5,Math.min(100, Math.round(100 - density*11 + fixRate*8)));
    w.mttr=w.mttrN? (w.mttrSum/w.mttrN):0;
    w.trend=((i=>i.charCodeAt(0)%2)?1:-1);              // demo trend
    w.trend=(w.ward.charCodeAt(0)+w.open)%2? +(Math.random()*3+0.5).toFixed(1):-(Math.random()*3+0.5).toFixed(1);
  });
  return by;
}
const SCORES = wardScores();
function scoreColor(s){ return s>=75?'#2e7d32': s>=55?'#c98a12': s>=40?'#e56a00':'#d32f2f'; }
function cityScore(){const v=Object.values(SCORES); let tot=0,wt=0; v.forEach(w=>{tot+=w.score*Math.max(1,w.total);wt+=Math.max(1,w.total)}); return Math.round(tot/wt);}
function priority(i){ return SEVW[i.severity]*Math.log2(1+i.passes); }

/* ---------- app state + router ---------- */
let state={view:'city',ward:null,street:null,type:null};
let map=null, layers=null;

function setActive(){
  document.querySelectorAll('.nav a').forEach(a=>{
    const v=a.dataset.view, t=a.dataset.type;
    a.classList.toggle('active', v===state.view && (v!=='cat'|| t===state.type));
  });
}
function counts(){
  const open=issues.filter(i=>OPEN.has(i.status));
  document.getElementById('ct-city').textContent=open.length;
  document.getElementById('ct-bus').textContent=DATA.buses.length;
  document.getElementById('ct-crew').textContent=CREW.length;
  Object.keys(TYPE).forEach(t=>{const e=document.getElementById('ct-'+t); if(e)e.textContent=open.filter(i=>i.type===t).length;});
  document.getElementById('sensing-n').textContent=DATA.buses.length+' buses sensing';
  const passes=issues.reduce((a,i)=>a+i.passes,0);
  document.getElementById('sensing-sub').textContent=passes.toLocaleString('en-IN')+' passes logged today';
  const cs=cityScore(); const chip=document.querySelector('#scorechip .v');
  chip.textContent=cs; chip.style.background=scoreColor(cs);
}
function crumb(parts){ // parts: [{t,go}]
  const c=document.getElementById('crumb'); c.innerHTML='';
  parts.forEach((p,i)=>{ if(i)c.insertAdjacentHTML('beforeend','<span class="sep">/</span>');
    if(p.go){const a=document.createElement('a');a.textContent=p.t;a.onclick=p.go;c.appendChild(a);}
    else c.insertAdjacentHTML('beforeend','<span>'+p.t+'</span>'); });
}

/* ---------- map helpers ---------- */
function newMap(id){
  const m=L.map(id,{zoomControl:true,attributionControl:false}).setView([19.09,72.87],11);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{maxZoom:19,subdomains:'abcd'}).addTo(m);
  return m;
}
function markerFor(i){
  const r=3+i.severity*1.4;
  return L.circleMarker([i.lat,i.lon],{radius:r,fillColor:TYPE[i.type].c,color:'#fff',weight:1.4,
    fillOpacity:i.status==='candidate'?0.4:0.9, dashArray:i.status==='candidate'?'2':null})
    .on('click',()=>openIssue(i.id));
}
function drawWards(m,{fillByScore=false,only=null,onclick=null}={}){
  return L.geoJSON(wardsFC,{
    filter:f=>!only||f.properties.ward===only,
    style:f=>{const s=SCORES[f.properties.ward];
      return {color:'#8a9099',weight:1,fillColor:fillByScore?scoreColor(s.score):'#8aa0c0',
        fillOpacity:fillByScore?0.5:0.06};},
    onEachFeature:(f,l)=>{ l.bindTooltip(f.properties.ward+' · '+f.properties.area+(fillByScore?' · '+SCORES[f.properties.ward].score:''),{sticky:true});
      if(onclick)l.on('click',()=>onclick(f.properties.ward)); }
  }).addTo(m);
}
function plot(m,list){ list.forEach(i=>markerFor(i).addTo(m)); }

/* ---------- views ---------- */
function render(){
  const session=getSession();
  if(session && session.role==='ward_officer' && state.view==='ward'){ state.ward=session.ward; }
  setActive(); counts();
  const c=document.getElementById('content'); c.innerHTML='';
  ({city:viewCity,wards:viewWards,ward:viewWard,street:viewStreet,fleet:viewFleet,cat:viewCat,crew:viewCrew})[state.view]();
}

function kpiStrip(list){
  const open=list.filter(i=>OPEN.has(i.status));
  const conf=list.filter(i=>i.status==='confirmed').length;
  const sev45=open.filter(i=>i.severity>=4).length;
  const fixed=list.filter(i=>i.status==='verified_fixed').length;
  const mttrN=list.filter(i=>i.status==='verified_fixed'||i.status==='resolved');
  let mt=0,mn=0; mttrN.forEach(i=>{const d=(new Date(i.last_seen)-new Date(i.first_seen))/864e5;if(d>0){mt+=d;mn++;}});
  const mttr=mn?(mt/mn).toFixed(1):'—';
  return `<div class="kpis">
    <div class="kpi"><div class="k">Open issues</div><div class="v">${open.length}</div><div class="d">${conf} confirmed · ${open.length-conf} pending gate</div></div>
    <div class="kpi"><div class="k">High severity (4–5)</div><div class="v" style="color:var(--pothole)">${sev45}</div><div class="d down">needs priority action</div></div>
    <div class="kpi"><div class="k">Verified fixed</div><div class="v" style="color:var(--good)">${fixed}</div><div class="d up">re-checked on later passes</div></div>
    <div class="kpi"><div class="k">Avg. resolution</div><div class="v">${mttr}<span style="font-size:15px;color:var(--faint)"> d</span></div><div class="d">first-seen → cleared</div></div>
  </div>`;
}

function viewCity(){
  state.ward=state.street=state.type=null;
  document.getElementById('h-title').textContent='Mumbai — street-condition survey';
  document.getElementById('h-sub').textContent='Every BMC ward, sensed by the bus fleet. Click a ward to drill in.';
  crumb([{t:'Mumbai'}]);
  const c=document.getElementById('content');
  const board=Object.values(SCORES).sort((a,b)=>a.score-b.score);
  c.innerHTML = kpiStrip(issues) + `
    <div class="row map-side">
      <div class="card"><div class="ch"><h3>Live detection map</h3><span class="r">${issues.filter(i=>OPEN.has(i.status)).length} open · wards shaded by health score</span></div>
        <div id="map"></div>
        <div class="legend">
          ${Object.entries(TYPE).map(([k,v])=>`<span class="it"><span class="sw" style="background:${v.c}"></span>${v.label}</span>`).join('')}
          <span class="it" style="margin-left:auto"><span class="sw" style="background:#2e7d32"></span>healthy ward</span>
          <span class="it"><span class="sw" style="background:#d32f2f"></span>at-risk ward</span>
        </div>
      </div>
      <div class="card"><div class="ch"><h3>Ward health leaderboard</h3><span class="r">worst first</span></div>
        <div style="max-height:512px;overflow-y:auto"><table><thead><tr><th></th><th>Ward</th><th>Score</th><th>Open</th><th>7-day</th></tr></thead>
        <tbody>${board.map((w,i)=>`<tr class="clk" data-w="${w.ward}"><td class="rank">${i+1}</td>
          <td><b>${w.ward}</b><div style="font-size:11px;color:var(--faint)">${w.area}</div></td>
          <td><span class="scorepill" style="background:${scoreColor(w.score)}">${w.score}</span></td>
          <td>${w.open}</td>
          <td class="trend ${w.trend>=0?'up':'down'}">${w.trend>=0?'▲':'▼'} ${Math.abs(w.trend)}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>`;
  map=newMap('map'); drawWards(map,{fillByScore:true,onclick:w=>{state.ward=w;state.view='ward';render();}});
  plot(map, issues.filter(i=>OPEN.has(i.status)));
  c.querySelectorAll('tr[data-w]').forEach(tr=>tr.onclick=()=>{state.ward=tr.dataset.w;state.view='ward';render();});
}

function viewWards(){
  document.getElementById('h-title').textContent='Wards';
  document.getElementById('h-sub').textContent='24 BMC administrative wards — pick your area of responsibility.';
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Wards'}]);
  const board=Object.values(SCORES).sort((a,b)=>a.score-b.score);
  document.getElementById('content').innerHTML=`<div class="card"><div class="ch"><h3>All wards</h3><span class="r">click to open the ward officer view</span></div>
    <table><thead><tr><th></th><th>Ward</th><th>Area</th><th>Health</th><th>Open</th><th>High sev</th><th>Fixed</th></tr></thead><tbody>
    ${board.map((w,i)=>{const wi=issues.filter(x=>x.ward===w.ward);
      const hs=wi.filter(x=>OPEN.has(x.status)&&x.severity>=4).length; const fx=wi.filter(x=>x.status==='verified_fixed').length;
      return `<tr class="clk" data-w="${w.ward}"><td class="rank">${i+1}</td><td><b>${w.ward}</b></td><td>${w.area}</td>
      <td><span class="scorepill" style="background:${scoreColor(w.score)}">${w.score}</span></td><td>${w.open}</td>
      <td style="color:var(--pothole);font-weight:700">${hs}</td><td style="color:var(--good);font-weight:700">${fx}</td></tr>`;}).join('')}
    </tbody></table></div>`;
  document.querySelectorAll('tr[data-w]').forEach(tr=>tr.onclick=()=>{state.ward=tr.dataset.w;state.view='ward';render();});
}

function viewWard(){
  const w=SCORES[state.ward]; const list=issues.filter(i=>i.ward===state.ward);
  document.getElementById('h-title').innerHTML=`Ward ${w.ward} <span style="font-weight:600;color:var(--muted);font-size:15px">· ${w.area}</span>`;
  document.getElementById('h-sub').textContent='Ward officer view — resolution queue for open issues, highest priority first.';
  const session=getSession();
  if(session && session.role==='ward_officer'){ crumb([{t:'Ward '+w.ward}]); }
  else crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Wards',go:()=>{state.view='wards';render();}},{t:'Ward '+w.ward}]);
  const open=list.filter(i=>OPEN.has(i.status)).sort((a,b)=>priority(b)-priority(a));
  const c=document.getElementById('content');
  c.innerHTML = kpiStrip(list) + `
    <div class="row map-side">
      <div class="card"><div class="ch"><h3>Resolution queue</h3><span class="r">${open.length} open · severity × persistence</span></div>
        <div style="max-height:452px;overflow-y:auto" id="queue"></div></div>
      <div class="card"><div class="ch"><h3>Ward ${w.ward}</h3><span class="r">health ${w.score}</span></div><div id="wardmap"></div></div>
    </div>`;
  const q=c.querySelector('#queue');
  if(!open.length) q.innerHTML='<div class="hint">No open issues in this ward. All clear.</div>';
  open.forEach(i=>q.appendChild(qItem(i)));
  const wm=L.map('wardmap',{zoomControl:true,attributionControl:false});
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{subdomains:'abcd'}).addTo(wm);
  const wl=drawWards(wm,{only:state.ward}); wm.fitBounds(wl.getBounds(),{padding:[20,20]});
  plot(wm,list);
}

function qItem(i,opts={}){
  const el=document.createElement('div'); el.className='qitem';
  el.innerHTML=`<span class="tdot" style="background:${TYPE[i.type].c}"></span>
    <div class="meta"><div class="t1">${TYPE[i.type].label}
      <span class="sev" style="background:${SEVC[i.severity]}">SEV ${i.severity}</span>
      <span class="badge ${i.status}">${i.status.replace('_',' ')}</span>
      ${i.type!=='waterlogging'?`<span class="badge ${i.crew?'assigned':'unassigned'}">${i.crew?'Assigned':'Unassigned'}</span>`:''}</div>
      <div class="t2">${i.street} · ${i.id} · ${i.passes} passes · ${Math.round(i.confidence*100)}% conf</div></div>
    <div class="pri">P ${priority(i).toFixed(1)}</div>`;
  el.onclick=()=>openIssue(i.id,opts); return el;
}

function viewStreet(){
  state.street=state.street||null;
  document.getElementById('h-title').textContent='Streets & corridors';
  document.getElementById('h-sub').textContent='Issues aggregated along a road segment.';
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Streets'}]);
  const streets=[...new Set(issues.map(i=>i.street))].map(s=>{
    const li=issues.filter(i=>i.street===s); const open=li.filter(i=>OPEN.has(i.status));
    return {s,total:li.length,open:open.length,load:open.reduce((a,i)=>a+SEVW[i.severity],0)};
  }).sort((a,b)=>b.load-a.load);
  const sel=state.street||streets[0].s;
  const list=issues.filter(i=>i.street===sel);
  const c=document.getElementById('content');
  c.innerHTML=`<div class="row map-side">
    <div class="card"><div class="ch"><h3>${sel}</h3><span class="r">${list.length} detections along corridor</span></div>
      <div id="streetmap"></div>
      <div class="legend">${Object.entries(TYPE).map(([k,v])=>`<span class="it"><span class="sw" style="background:${v.c}"></span>${v.label}</span>`).join('')}</div></div>
    <div class="card"><div class="ch"><h3>Corridors by open load</h3><span class="r">worst first</span></div>
      <div style="max-height:512px;overflow-y:auto"><table><thead><tr><th>Street</th><th>Open</th><th>Load</th></tr></thead><tbody>
      ${streets.map(x=>`<tr class="clk" data-s="${x.s}"><td><b>${x.s}</b></td><td>${x.open}</td>
        <td><span class="scorepill" style="background:${x.load>18?'#d32f2f':x.load>10?'#e56a00':'#c98a12'}">${x.load.toFixed(0)}</span></td></tr>`).join('')}
      </tbody></table></div></div></div>`;
  const sm=L.map('streetmap',{zoomControl:true,attributionControl:false});
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{subdomains:'abcd'}).addTo(sm);
  plot(sm,list);
  if(list.length){const g=L.featureGroup(list.map(i=>L.marker([i.lat,i.lon]))); sm.fitBounds(g.getBounds().pad(0.3));}
  c.querySelectorAll('tr[data-s]').forEach(tr=>tr.onclick=()=>{state.street=tr.dataset.s;render();});
}

function viewCat(){
  const t=state.type; const list=issues.filter(i=>i.type===t);
  document.getElementById('h-title').textContent=TYPE[t].label+' — city-wide';
  document.getElementById('h-sub').textContent='One category across every ward, ranked for the responsible department.';
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:TYPE[t].label}]);
  const open=list.filter(i=>OPEN.has(i.status)).sort((a,b)=>priority(b)-priority(a));
  const c=document.getElementById('content');
  c.innerHTML=kpiStrip(list)+`<div class="row map-side">
    <div class="card"><div class="ch"><h3>${TYPE[t].label} map</h3><span class="r">${open.length} open</span></div><div id="map"></div></div>
    <div class="card"><div class="ch"><h3>Priority list</h3><span class="r">severity × persistence</span></div>
      <div style="max-height:512px;overflow-y:auto" id="queue"></div></div></div>`;
  map=newMap('map'); drawWards(map,{fillByScore:false}); plot(map,open);
  const q=c.querySelector('#queue'); open.slice(0,60).forEach(i=>q.appendChild(qItem(i)));
}

/* ---------- crew info ---------- */
function viewCrew(){
  state.ward=state.street=state.type=null;
  document.getElementById('h-title').textContent='Crew info';
  document.getElementById('h-sub').textContent='Field repair & cleanup teams — one specialism each, worklist drawn from the same confirmed-issue set.';
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Crew info'}]);
  const rows=crewLoad().sort((a,b)=>b.open-a.open);
  const session=getSession();
  const canManage=session && (session.role==='admin' || session.role==='ward_officer'); // roster edits — same access tier as issue resolution
  const c=document.getElementById('content');
  c.innerHTML=`<div class="card"><div class="ch"><h3>Crew roster</h3><span class="r">${CREW.length} members · click a member to see their worklist</span>
      ${canManage?'<button class="btn primary sm" id="addCrewBtn">+ Add crew member</button>':''}</div>
    <table><thead><tr><th></th><th>Crew ID</th><th>Name</th><th>Specialism</th><th>Assigned</th><th>Completed</th><th></th></tr></thead><tbody>
    ${rows.map((cm,i)=>`<tr class="clk" data-crew="${cm.id}"><td class="rank">${i+1}</td>
      <td><b>${cm.id}</b></td><td>${cm.name}</td>
      <td><span class="tdot" style="background:${TYPE[cm.type].c};display:inline-block;margin-right:6px;vertical-align:middle"></span>${TYPE[cm.type].label}</td>
      <td><span class="scorepill" style="background:${cm.open>=CREW_CAPACITY?'#d32f2f':cm.open?'#e56a00':'#2e7d32'}">${cm.open}/${CREW_CAPACITY}</span>${cm.open>=CREW_CAPACITY?' <span class="badge confirmed" style="margin-left:6px">full</span>':''}</td>
      <td>${cm.total-cm.open}</td>
      <td>${canManage?`<button class="btn sm danger" data-remove="${cm.id}">Remove</button>`:''}</td></tr>`).join('')}
    </tbody></table></div>`;
  c.querySelectorAll('tr[data-crew]').forEach(tr=>tr.onclick=()=>openCrew(tr.dataset.crew));
  c.querySelectorAll('button[data-remove]').forEach(btn=>btn.onclick=(e)=>{
    e.stopPropagation();
    const cm=crewById(btn.dataset.remove); if(!cm)return;
    if(confirm(`Remove ${cm.name} (${cm.id})? Their open tasks will be reassigned to another ${TYPE[cm.type].label.toLowerCase()} specialist.`)){
      removeCrew(cm.id); viewCrew();
    }
  });
  if(canManage) document.getElementById('addCrewBtn').onclick=openAddCrew;
}
function openCrew(id){
  const cm=crewById(id); if(!cm)return;
  const mine=issues.filter(i=>i.crew===id);
  const open=mine.filter(i=>OPEN.has(i.status)).sort((a,b)=>priority(b)-priority(a));
  const done=mine.filter(i=>!OPEN.has(i.status));
  const m=document.getElementById('crewModal'), s=document.getElementById('scrim');
  m.innerHTML=`<div class="mh"><span class="tdot" style="background:${TYPE[cm.type].c};width:14px;height:14px"></span>
      <div><b style="font-size:15px">${cm.name}</b>
      <div style="font-size:12px;color:var(--faint)">${cm.id} · ${TYPE[cm.type].label} specialist</div></div>
      <button class="x" id="cx" style="margin-left:auto">×</button></div>
    <div class="mb">
      <div class="section-t" style="margin:14px 16px 6px">Assigned — ${open.length}/${CREW_CAPACITY} open${open.length>=CREW_CAPACITY?' <span class="badge confirmed" style="text-transform:none;letter-spacing:0">worklist full</span>':''}</div>
      <div id="crewQueue"></div>
      ${done.length?`<div class="section-t" style="margin:18px 16px 6px">Completed — ${done.length}</div><div id="crewDone"></div>`:''}
    </div>`;
  const q=m.querySelector('#crewQueue');
  if(!open.length) q.innerHTML='<div class="hint">No open tasks — worklist clear.</div>';
  open.forEach(i=>q.appendChild(qItem(i,{hideAssign:true})));
  const dq=m.querySelector('#crewDone');
  if(dq) done.forEach(i=>dq.appendChild(qItem(i,{hideAssign:true})));
  document.getElementById('cx').onclick=closeDrawer; s.onclick=closeDrawer;
  s.classList.add('on'); m.classList.add('on');
}
function openAddCrew(){
  const id=nextCrewId();
  const m=document.getElementById('crewModal'), s=document.getElementById('scrim');
  m.innerHTML=`<div class="mh"><div><b style="font-size:15px">Add crew member</b>
      <div style="font-size:12px;color:var(--faint)">New ID will be ${id}</div></div>
      <button class="x" id="cx">×</button></div>
    <div class="mb" style="padding:16px 20px">
      <div class="field"><label>Name</label><input type="text" id="ncName" placeholder="e.g. Rahul Verma"></div>
      <div class="field"><label>Specialism</label><select id="ncType">
        ${Object.entries(TYPE).filter(([k])=>k!=='waterlogging').map(([k,v])=>`<option value="${k}">${v.label}</option>`).join('')}
      </select></div>
      <div id="ncErr" style="color:var(--pothole);font-size:12px;min-height:16px"></div>
    </div>
    <div class="mf">
      <button class="btn primary" id="ncSave">Add crew member</button>
      <button class="btn" id="ncCancel">Cancel</button>
    </div>`;
  document.getElementById('cx').onclick=closeDrawer;
  document.getElementById('ncCancel').onclick=closeDrawer;
  s.onclick=closeDrawer;
  document.getElementById('ncSave').onclick=()=>{
    const name=document.getElementById('ncName').value.trim();
    const type=document.getElementById('ncType').value;
    if(!name){document.getElementById('ncErr').textContent='Enter a name.';return;}
    CREW.push({id,name,type});
    closeDrawer(); viewCrew();
  };
  s.classList.add('on'); m.classList.add('on');
}

/* ---------- fleet + replay ---------- */
let replay={timer:null,t:0,seen:new Set()};
function viewFleet(){
  document.getElementById('h-title').textContent='Fleet & route replay';
  document.getElementById('h-sub').textContent='Per-bus contribution, and the survey replayed with detections dropping in sync.';
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Fleet'}]);
  const perBus=DATA.buses.map(b=>{const li=issues.filter(i=>i.bus===b);
    return {b,total:li.length,open:li.filter(i=>OPEN.has(i.status)).length};}).sort((a,b)=>b.total-a.total);
  const c=document.getElementById('content');
  c.innerHTML=`<div class="row map-side">
    <div class="card">
      <div class="ch"><h3>Route replay — A-71 (Bandra → Goregaon)</h3><span class="r">bus MH01-BST-2087</span></div>
      <div class="videoslot"><div class="rd"><span class="d"></span>DASHCAM</div>
        Drop your sourced clip here (<code>&lt;video&gt;</code> slot) — map pins already sync to the route timeline below.</div>
      <div id="fleetmap"></div>
      <div class="controls">
        <button class="btn primary sm" id="play">▶ Play</button>
        <button class="btn sm" id="reset">↺</button>
        <div class="track" id="track"><div class="fill" id="fill"></div></div>
        <span id="clock" style="font-size:12px;color:var(--faint);font-weight:700;min-width:66px;text-align:right">0.0 km</span>
      </div>
    </div>
    <div class="card"><div class="ch"><h3>Detections this run</h3><span class="r" id="feedn">0</span></div>
      <div class="feed" id="feed"><div class="hint">Press play — confirmed detections along the route appear here as the bus passes them.</div></div>
      <div class="ch" style="border-top:1px solid var(--line)"><h3>Fleet contribution</h3></div>
      <div style="max-height:220px;overflow-y:auto"><table><thead><tr><th>Bus</th><th>Detections</th><th>Open</th></tr></thead><tbody>
      ${perBus.map(x=>`<tr><td><b>${x.b}</b></td><td>${x.total}</td><td>${x.open}</td></tr>`).join('')}
      </tbody></table></div>
    </div></div>`;

  const fm=L.map('fleetmap',{zoomControl:true,attributionControl:false});
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{subdomains:'abcd'}).addTo(fm);
  const route=DATA.routes['A-71'];
  const poly=L.polyline(route,{color:'#3b6fc4',weight:4,opacity:.6}).addTo(fm);
  fm.fitBounds(poly.getBounds().pad(0.25));
  const bus=L.circleMarker(route[0],{radius:8,fillColor:'#f57c00',color:'#fff',weight:2,fillOpacity:1}).addTo(fm);
  const routeIssues=DATA.replay_ids.map(id=>issues.find(i=>i.id===id)).filter(Boolean);
  const pinLayer={}; // id -> marker (revealed progressively)

  function seg(t){ // t in 0..1 -> [lat,lon] along polyline + km
    const n=route.length-1, x=t*n, i=Math.min(n-1,Math.floor(x)), f=x-i;
    const a=route[i],b=route[i+1];
    return [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f];
  }
  const totalKm=8.6;
  function step(){
    replay.t=Math.min(1,replay.t+0.006);
    const p=seg(replay.t); bus.setLatLng(p);
    document.getElementById('fill').style.width=(replay.t*100)+'%';
    document.getElementById('clock').textContent=(replay.t*totalKm).toFixed(1)+' km';
    routeIssues.forEach((i,idx)=>{ const at=(idx+1)/(routeIssues.length+1);
      if(replay.t>=at && !replay.seen.has(i.id)){ replay.seen.add(i.id);
        markerFor(i).addTo(fm); addFeed(i); }});
    if(replay.t>=1){stopReplay();}
  }
  function addFeed(i){ const feed=document.getElementById('feed');
    if(replay.seen.size===1)feed.innerHTML='';
    const el=document.createElement('div');el.className='feeditem';
    el.innerHTML=`<span class="tdot" style="background:${TYPE[i.type].c}"></span>
      <div class="meta"><div class="t1">${TYPE[i.type].label} <span class="sev" style="background:${SEVC[i.severity]}">SEV ${i.severity}</span></div>
      <div class="t2">${(replay.t*totalKm).toFixed(1)} km · ${Math.round(i.confidence*100)}% · ${i.id}</div></div>`;
    el.onclick=()=>openIssue(i.id); feed.prepend(el);
    document.getElementById('feedn').textContent=replay.seen.size;
  }
  window._replayStep=step;
  document.getElementById('play').onclick=toggleReplay;
  document.getElementById('reset').onclick=()=>{stopReplay();replay.t=0;replay.seen.clear();viewFleet();};
}
function toggleReplay(){ const b=document.getElementById('play');
  if(replay.timer){stopReplay();} else {b.textContent='❚❚ Pause';replay.timer=setInterval(()=>window._replayStep(),90);} }
function stopReplay(){ if(replay.timer){clearInterval(replay.timer);replay.timer=null;}
  const b=document.getElementById('play'); if(b)b.textContent= replay.t>=1?'▶ Replay':'▶ Play'; }

/* ---------- issue detail drawer ---------- */
let issueCtx={};
function openIssue(id,opts){
  const i=issues.find(x=>x.id===id); if(!i)return;
  issueCtx=opts||{};                     // remember how this drawer was opened (e.g. from crew flow) across resolve/verify refreshes
  document.getElementById('crewModal').classList.remove('on');
  const d=document.getElementById('drawer'), s=document.getElementById('scrim');
  const hist=(i.history&&i.history.length)?i.history:[{t:i.first_seen,bus:i.bus,detected:true},{t:i.last_seen,bus:i.bus,detected:i.status!=='verified_fixed'}];
  d.innerHTML=`<div class="dh"><span class="tdot" style="background:${TYPE[i.type].c};width:14px;height:14px"></span>
      <div><b style="font-size:15px">${TYPE[i.type].label}</b>
      <div style="font-size:12px;color:var(--faint)">${i.id} · Ward ${i.ward}</div></div>
      <button class="x" id="dx">×</button></div>
    <div class="db">
      <div class="evidence">${evidenceSVG(i)}</div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <span class="sev" style="background:${SEVC[i.severity]};padding:4px 9px">SEVERITY ${i.severity}</span>
        <span class="badge ${i.status}" style="padding:4px 11px">${i.status.replace('_',' ')}</span>
        <span class="badge" style="background:#f0f1f4;color:var(--muted);padding:4px 11px">${Math.round(i.confidence*100)}% confidence</span>
      </div>
      <dl class="dl">
        <dt>Location</dt><dd>${i.street}, Ward ${i.ward}</dd>
        <dt>GPS</dt><dd>${i.lat.toFixed(5)}, ${i.lon.toFixed(5)}</dd>
        <dt>Route / bus</dt><dd>${i.route} · ${i.bus}</dd>
        <dt>First seen</dt><dd>${fmtDT(i.first_seen)}</dd>
        <dt>Independent passes</dt><dd>${i.passes} ${i.passes>=3?'✓ confirmed':'· awaiting gate'}</dd>
        ${i.type!=='waterlogging'?`<dt>Assigned crew</dt><dd>${i.crew? crewById(i.crew).name+' · '+i.crew : 'Unassigned · backlog'}</dd>`:''}
      </dl>
      <div class="section-t" style="margin-top:4px">Pass history</div>
      <ul class="tl">${hist.map(h=>`<li class="${h.detected?'':'miss'}"><b>${h.detected?'Detected':'Not detected'}</b>
        <span class="w"> · ${fmtDT(h.t)} · ${h.bus}</span></li>`).join('')}</ul>
      <div class="hint" style="padding:8px 0">Severity is an estimated triage score from detection size + confidence — calibrate against crew feedback.</div>
    </div>
    <div class="df" id="df"></div>`;
  drawerActions(i);
  s.classList.add('on'); d.classList.add('on');
  document.getElementById('dx').onclick=closeDrawer; s.onclick=closeDrawer;
}
function drawerActions(i){
  const df=document.getElementById('df');
  if(i.type==='waterlogging'){
    df.innerHTML='<div class="hint" style="padding:4px">Waterlogging clears with weather, not a repair crew — no assignment needed. Recurring flooding at this spot is flagged for drainage/disaster-management review.</div>';
    return;
  }
  const session=getSession();
  const canEdit=session && (session.role==='admin' || session.role==='ward_officer');
  if(!canEdit){ df.innerHTML='<div class="hint" style="padding:4px">Read-only access — sign in as an admin or ward officer to update this issue.</div>'; return; }
  if(i.status==='verified_fixed'){df.innerHTML='<div style="color:var(--good);font-weight:700;padding:4px">✓ Verified fixed — cleared on a later pass with no re-detection.</div>';return;}
  if(i.status==='resolved'){
    df.innerHTML='<button class="btn good" id="verify">Confirm fixed</button><button class="btn" id="reopen">Reopen</button>';
    df.querySelector('#verify').onclick=()=>{i.status='verified_fixed';i.last_seen=new Date().toISOString();afterAction(i);};
    df.querySelector('#reopen').onclick=()=>{i.status='confirmed';afterAction(i);};
    return;
  }
  df.innerHTML='<button class="btn primary" id="resolve">Mark resolved</button>'
    +(issueCtx.hideAssign
      ? (i.crew?'<button class="btn danger" id="unassign">Unassign</button>':'')
      : `<button class="btn ${i.crew?'good':''}" id="assign">${i.crew?'Assigned ✓':'Assign crew'}</button>`);
  df.querySelector('#resolve').onclick=()=>{i.status='resolved';i.last_seen=new Date().toISOString();afterAction(i);};
  if(!issueCtx.hideAssign) df.querySelector('#assign').onclick=()=>openAssignCrew(i.id);
  if(issueCtx.hideAssign&&i.crew){
    const cid=i.crew;
    df.querySelector('#unassign').onclick=()=>{
      i.crew=null;
      Object.assign(SCORES, wardScores());
      closeDrawer(); openCrew(cid); render();
    };
  }
}
function openAssignCrew(id){
  const i=issues.find(x=>x.id===id); if(!i)return;
  const pool=CREW.filter(c=>c.type===i.type&&(i.crew===c.id||crewOpenCount(c.id)<CREW_CAPACITY));
  const m=document.getElementById('crewModal'), s=document.getElementById('scrim');
  const back=()=>{ m.classList.remove('on'); s.onclick=closeDrawer; };
  m.innerHTML=`<div class="mh"><span class="tdot" style="background:${TYPE[i.type].c};width:14px;height:14px"></span>
      <div><b style="font-size:15px">Assign crew</b>
      <div style="font-size:12px;color:var(--faint)">${TYPE[i.type].label} specialists · ${i.id}</div></div>
      <button class="x" id="cx">×</button></div>
    <div class="mb" style="padding:6px 0">
      ${pool.length?`<table><thead><tr><th>Crew ID</th><th>Name</th><th>Load</th><th></th></tr></thead><tbody>
        ${pool.map(cm=>{
          const open=crewOpenCount(cm.id);
          const current=i.crew===cm.id;
          return `<tr><td>${cm.id}</td><td>${cm.name}</td>
            <td><span class="scorepill" style="background:${open>=CREW_CAPACITY?'#d32f2f':open?'#e56a00':'#2e7d32'}">${open}/${CREW_CAPACITY}</span></td>
            <td><button class="btn ${current?'good':'primary'} sm" data-assign="${cm.id}">${current?'Assigned ✓':'Assign'}</button></td></tr>`;
        }).join('')}
      </tbody></table>`:`<div class="hint">All ${TYPE[i.type].label.toLowerCase()} specialists are at capacity — no one available right now.</div>`}
    </div>`;
  document.getElementById('cx').onclick=back; s.onclick=back;
  m.querySelectorAll('button[data-assign]').forEach(btn=>btn.onclick=()=>{
    i.crew=btn.dataset.assign;
    s.onclick=closeDrawer; m.classList.remove('on');
    afterAction(i);
  });
  m.classList.add('on');
}
function afterAction(i){ // recompute scores + refresh underlying view, keep drawer open
  Object.assign(SCORES, wardScores());
  openIssue(i.id,issueCtx); const keep=state.view; render(); // re-render list/map behind, preserving open/crew context
}
function closeDrawer(){document.getElementById('drawer').classList.remove('on');document.getElementById('crewModal').classList.remove('on');document.getElementById('scrim').classList.remove('on');}

function evidenceSVG(i){
  const c=TYPE[i.type].c;
  return `<svg viewBox="0 0 320 200" width="100%" height="100%" style="display:block">
    <rect width="320" height="200" fill="#2b2f36"/>
    <polygon points="0,200 130,96 190,96 320,200" fill="#3a3f47"/>
    <polygon points="150,96 156,96 176,200 120,200" fill="#4a4f57"/>
    <rect x="140" y="60" width="40" height="36" fill="#31363d"/>
    <line x1="153" y1="112" x2="150" y2="200" stroke="#c9ccd1" stroke-width="2" stroke-dasharray="10 12" opacity=".5"/>
    <rect x="${110+i.severity*4}" y="${150-i.severity*3}" width="${26+i.severity*10}" height="${16+i.severity*7}" fill="none" stroke="${c}" stroke-width="3" rx="3"/>
    <rect x="${108+i.severity*4}" y="${134-i.severity*3}" width="${64}" height="15" fill="${c}"/>
    <text x="${112+i.severity*4}" y="${145-i.severity*3}" fill="#fff" font-size="10" font-family="Noto Sans" font-weight="700">${TYPE[i.type].label} ${Math.round(i.confidence*100)}%</text>
    <text x="10" y="188" fill="#8b9099" font-size="9" font-family="Noto Sans">frame evidence · schematic · ${i.id}</text>
  </svg>`;
}


/* ---------- wire up ---------- */
document.querySelectorAll('.nav a').forEach(a=>a.onclick=()=>{
  stopReplay();
  state.view=a.dataset.view;
  if(a.dataset.type)state.type=a.dataset.type;
  if(state.view==='street')state.street=null;
  if(a.id==='nav-myward'){const s=getSession(); if(s)state.ward=s.ward;}
  render();
});

/* ---------- session guard + role UI (index.html only) ---------- */
const session = getSession();
if (!session) {
  location.href = 'login.html';
} else {
  document.getElementById('appRoot').style.display = '';
  applyRoleUI(session);
  render();
}

function applyRoleUI(session){
  const chip=document.getElementById('userchip');
  chip.innerHTML=`<span class="rolebadge role-${session.role}">${session.role.replace('_',' ')}</span>
    <b>${session.username}</b><button class="btn sm" id="logoutBtn">Log out</button>`;
  document.getElementById('logoutBtn').onclick=logout;
  document.body.classList.remove('role-admin','role-ward_officer','role-user');
  document.body.classList.add('role-'+session.role);
  if(session.role==='ward_officer'){ state.view='ward'; state.ward=session.ward; }
}
