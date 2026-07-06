// CityLens — dashboard app (index.html). Requires js/data.js and js/auth.js first.

// DATA comes from js/data.js, loaded before this file.
const TYPE = {
  pothole:{label:'Pothole',c:'#d32f2f'}, waterlogging:{label:'Waterlogging',c:'#3b6fc4'},
  garbage_pile:{label:'Garbage',c:'#c98a12'}, street_obstruction:{label:'Obstruction',c:'#e56a00'}
};
const SEVW = {1:1,2:2,3:3.5,4:5.5,5:8};
const SEVC = {1:'#8a9099',2:'#3b6fc4',3:'#c98a12',4:'#e56a00',5:'#d32f2f'};
const OPEN = new Set(['confirmed','reported','candidate']);
const NOW = new Date(DATA.generated);       // fixed "now" for the demo — real Date() would drift from the seeded historical dates
const fmtDate = s => new Date(s).toLocaleDateString('en-IN',{day:'numeric',month:'short'});
const fmtDT = s => new Date(s).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const daysOpen = i => Math.floor((NOW-new Date(i.first_seen))/864e5);
const resolutionDays = i => Math.floor((new Date(i.last_seen)-new Date(i.first_seen))/864e5);
const issues = DATA.issues;                 // mutable — resolve/verify write here
const wardsFC = DATA.wards;

/* ---------- field crew (one specialism each) ---------- */
// CREW / CREW_CAPACITY come from js/data.js, loaded before this file.
function issueHash(id){ // stable pseudo-random per id (FNV-1a + finalizer, for a well-mixed 0..1 split that looks the same on every reload)
  let h=2166136261;
  for(const ch of id){ h^=ch.charCodeAt(0); h=Math.imul(h,16777619); }
  h^=h>>>16; h=Math.imul(h,0x85ebca6b); h^=h>>>13; h=Math.imul(h,0xc2b2ae35); h^=h>>>16;
  return (h>>>0)/4294967296;
}
(function assignCrew(){ // deterministic round-robin per category, respecting capacity — closed issues always show a contractor; only a minority of open issues come pre-assigned so the rest can be assigned live in a demo
  const idx={}, openLoad={};
  const OPEN_ASSIGN_RATE=0.2;
  issues.forEach(i=>{
    if(i.type==='waterlogging') return;
    if(WARD_CREW[i.ward] && crewById(WARD_CREW[i.ward])){ i.crew=WARD_CREW[i.ward]; return; } // ward contractor takes the whole ward, any type
    const isOpen=OPEN.has(i.status);
    if(isOpen && issueHash(i.id)>=OPEN_ASSIGN_RATE) return;  // leave most open issues unassigned for the demo
    const pool=CREW.filter(c=>c.type===i.type); if(!pool.length)return;
    idx[i.type]=idx[i.type]||0;
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
function assignWardToCrew(ward,crewId){ // hand the whole ward's repairable backlog to one contractor, any issue type
  WARD_CREW[ward]=crewId;
  saveWardCrew(WARD_CREW);
  issues.forEach(i=>{ if(i.ward===ward && i.type!=='waterlogging') i.crew=crewId; });
  Object.assign(SCORES, wardScores());
}
function unassignWardCrew(ward){
  delete WARD_CREW[ward];
  saveWardCrew(WARD_CREW);
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
let state={view:'city',ward:null,street:null,type:null,assignFilter:'all',bus:null,trip:null};
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
  document.getElementById('ct-wards').textContent=wardsFC.features.length;
  document.getElementById('ct-bus').textContent=DATA.buses.length;
  document.getElementById('ct-crew').textContent=CREW.length;
  document.getElementById('ct-performance').textContent=issues.filter(i=>i.type!=='waterlogging'&&OPEN.has(i.status)&&daysOpen(i)>7).length;
  const session=getSession(), cm=session&&session.role==='crew'?crewById(session.crewId):null;
  document.getElementById('ct-mywork').textContent=cm?crewOpenCount(cm.id):'';
  Object.keys(TYPE).forEach(t=>{const e=document.getElementById('ct-'+t); if(e)e.textContent=open.filter(i=>i.type===t).length;});
  document.getElementById('sensing-n').textContent=DATA.buses.length+' buses sensing';
  const passes=issues.reduce((a,i)=>a+i.passes,0);
  document.getElementById('sensing-sub').textContent=passes.toLocaleString('en-IN')+' passes logged this survey';
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
function addRouteOverlay(m){ // the fixed A-71 demo route — only drawn on the Fleet trip-replay map, exactly as it was originally
  return L.polyline(DATA.routes['A-71'],{color:'#3b6fc4',weight:4,opacity:.6}).addTo(m);
}
function markerFor(i){ return markerAt(i,[i.lat,i.lon]); }
function markerAt(i,pos){
  const r=3+i.severity*1.4;
  return L.circleMarker(pos,{radius:r,fillColor:TYPE[i.type].c,color:'#fff',weight:1.4,
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
function haversineKm(a,b){
  const R=6371, toRad=d=>d*Math.PI/180;
  const dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
  const s=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

/* ---------- views ---------- */
function render(){
  const session=getSession();
  if(session && session.role==='ward_officer' && state.view==='ward'){ state.ward=session.ward; }
  setActive(); counts();
  const c=document.getElementById('content'); c.innerHTML='';
  ({city:viewCity,wards:viewWards,ward:viewWard,street:viewStreet,fleet:viewFleet,cat:viewCat,crew:viewCrew,performance:viewPerformance,mywork:viewMyWork})[state.view]();
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
  document.getElementById('h-sub').textContent=`${wardsFC.features.length} BMC administrative wards — pick your area of responsibility.`;
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Wards'}]);
  const board=Object.values(SCORES).sort((a,b)=>a.score-b.score);
  document.getElementById('content').innerHTML=`<div class="card"><div class="ch"><h3>All wards</h3><span class="r">click to open the ward officer view</span></div>
    <table><thead><tr><th></th><th>Ward</th><th>Area</th><th>Health</th><th>Open</th><th>High sev</th><th>Fixed</th><th>Contractor</th></tr></thead><tbody>
    ${board.map((w,i)=>{const wi=issues.filter(x=>x.ward===w.ward);
      const hs=wi.filter(x=>OPEN.has(x.status)&&x.severity>=4).length; const fx=wi.filter(x=>x.status==='verified_fixed').length;
      const contractor=WARD_CREW[w.ward]&&crewById(WARD_CREW[w.ward]);
      return `<tr class="clk" data-w="${w.ward}"><td class="rank">${i+1}</td><td><b>${w.ward}</b></td><td>${w.area}</td>
      <td><span class="scorepill" style="background:${scoreColor(w.score)}">${w.score}</span></td><td>${w.open}</td>
      <td style="color:var(--pothole);font-weight:700">${hs}</td><td style="color:var(--good);font-weight:700">${fx}</td>
      <td>${contractor?contractor.name:'<span style="color:var(--faint)">—</span>'}</td></tr>`;}).join('')}
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
  const showAssignFilter=session?.role!=='crew';
  const assignable=open.filter(i=>i.type!=='waterlogging');
  const assignedN=assignable.filter(i=>i.crew).length, unassignedN=assignable.length-assignedN;
  const filter=showAssignFilter?(state.assignFilter||'all'):'all';
  const filtered=filter==='assigned'?assignable.filter(i=>i.crew)
    :filter==='unassigned'?assignable.filter(i=>!i.crew)
    :open;
  const c=document.getElementById('content');
  const contractorId=WARD_CREW[w.ward], contractor=contractorId&&crewById(contractorId);
  const canManage=session && (session.role==='admin' || session.role==='ward_officer');
  const streets=DATA.streets.filter(s=>s.wardId===state.ward).map(s=>{
    const li=issues.filter(i=>i.streetId===s.id); const sOpen=li.filter(i=>OPEN.has(i.status));
    return {...s,total:li.length,open:sOpen.length,load:sOpen.reduce((a,i)=>a+SEVW[i.severity],0)};
  }).sort((a,b)=>b.load-a.load);
  c.innerHTML = kpiStrip(list) + `
    <div class="card"><div class="ch"><h3>Ward contractor</h3><span class="r">one crew responsible for every repairable issue in Ward ${w.ward}</span></div>
      <div class="cb" style="display:flex;align-items:center;gap:14px;padding:12px 16px">
        ${contractor?`<span class="badge assigned">${contractor.name} · ${contractor.id}</span>`:'<span class="badge unassigned">No ward contractor</span>'}
        ${canManage?`<button class="btn primary sm" id="wardAssignBtn">${contractor?'Change contractor':'Assign contractor'}</button>${contractor?'<button class="btn sm danger" id="wardUnassignBtn">Remove</button>':''}`:''}
      </div>
    </div>
    <div class="card"><div class="ch"><h3>Streets & corridors in Ward ${w.ward}</h3><span class="r">click a corridor for its full issue list</span></div>
      <table><thead><tr><th>Corridor</th><th>Open</th><th>Load</th></tr></thead>
      <tbody>${streets.slice(0,3).map(streetRow).join('')}</tbody>
      <tbody id="streetsMore" style="display:none">${streets.slice(3).map(streetRow).join('')}</tbody>
      </table>
      ${streets.length>3?`<div style="padding:10px 16px"><button class="btn sm" id="streetsToggle">View ${streets.length-3} more corridors</button></div>`:''}
    </div>
    <div class="row map-side">
      <div class="card"><div class="ch"><h3>Resolution queue</h3><span class="r">${filtered.length} of ${open.length} open · severity × persistence</span></div>
        ${showAssignFilter?`<div style="display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid var(--line)">
          <button class="btn sm ${filter==='all'?'primary':''}" data-filter="all">All (${open.length})</button>
          <button class="btn sm ${filter==='assigned'?'primary':''}" data-filter="assigned">Assigned (${assignedN})</button>
          <button class="btn sm ${filter==='unassigned'?'primary':''}" data-filter="unassigned">Unassigned (${unassignedN})</button>
        </div>`:''}
        <div style="max-height:452px;overflow-y:auto" id="queue"></div></div>
      <div class="card"><div class="ch"><h3>Ward ${w.ward}</h3><span class="r">health ${w.score}</span></div><div id="wardmap"></div></div>
    </div>`;
  const q=c.querySelector('#queue');
  if(!filtered.length) q.innerHTML=`<div class="hint">${open.length?'No issues match this filter.':'No open issues in this ward. All clear.'}</div>`;
  filtered.forEach(i=>q.appendChild(qItem(i)));
  if(showAssignFilter) c.querySelectorAll('button[data-filter]').forEach(btn=>btn.onclick=()=>{state.assignFilter=btn.dataset.filter;render();});
  c.querySelectorAll('tr[data-s]').forEach(tr=>tr.onclick=()=>{state.street=tr.dataset.s;state.view='street';render();});
  const streetsToggle=document.getElementById('streetsToggle');
  if(streetsToggle) streetsToggle.onclick=()=>{
    const more=document.getElementById('streetsMore'); const hidden=more.style.display==='none';
    more.style.display=hidden?'':'none';
    streetsToggle.textContent=hidden?'Show fewer corridors':`View ${streets.length-3} more corridors`;
  };
  const wm=L.map('wardmap',{zoomControl:true,attributionControl:false});
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{subdomains:'abcd'}).addTo(wm);
  const wl=drawWards(wm,{only:state.ward}); wm.fitBounds(wl.getBounds(),{padding:[20,20]});
  plot(wm,list);
  if(canManage){
    document.getElementById('wardAssignBtn').onclick=()=>openAssignWardCrew(w.ward);
    const ub=document.getElementById('wardUnassignBtn');
    if(ub)ub.onclick=()=>{ if(confirm(`Remove ${contractor.name} as contractor for Ward ${w.ward}? Existing assignments stay as-is; new issues fall back to per-type assignment.`)){ unassignWardCrew(w.ward); render(); } };
  }
}
function openAssignWardCrew(ward){
  const w=SCORES[ward];
  const m=document.getElementById('crewModal'), s=document.getElementById('scrim');
  m.innerHTML=`<div class="mh"><div><b style="font-size:15px">Assign ward contractor</b>
      <div style="font-size:12px;color:var(--faint)">Ward ${ward} · ${w.area} — every repairable issue in the ward goes to this crew</div></div>
      <button class="x" id="cx">×</button></div>
    <div class="mb" style="padding:6px 0">
      <table><thead><tr><th>Crew ID</th><th>Name</th><th>Specialism</th><th>Open load</th><th></th></tr></thead><tbody>
        ${CREW.map(cm=>{
          const open=crewOpenCount(cm.id);
          const current=WARD_CREW[ward]===cm.id;
          return `<tr><td>${cm.id}</td><td>${cm.name}</td><td>${TYPE[cm.type].label}</td>
            <td><span class="scorepill" style="background:${open>=CREW_CAPACITY?'#d32f2f':open?'#e56a00':'#2e7d32'}">${open}/${CREW_CAPACITY}</span></td>
            <td><button class="btn ${current?'good':'primary'} sm" data-assign="${cm.id}">${current?'Assigned ✓':'Assign'}</button></td></tr>`;
        }).join('')}
      </tbody></table>
    </div>`;
  document.getElementById('cx').onclick=closeDrawer; s.onclick=closeDrawer;
  m.querySelectorAll('button[data-assign]').forEach(btn=>btn.onclick=()=>{
    assignWardToCrew(ward,btn.dataset.assign);
    closeDrawer(); render();
  });
  m.classList.add('on');
}

function streetRow(s){
  return `<tr class="clk" data-s="${s.id}"><td><b>${s.name}</b></td><td>${s.open}</td>
    <td><span class="scorepill" style="background:${s.load>18?'#d32f2f':s.load>10?'#e56a00':'#c98a12'}">${s.load.toFixed(0)}</span></td></tr>`;
}

function qItem(i,opts={}){
  const el=document.createElement('div'); el.className='qitem';
  const buses=tripBusesFor(i);
  const busTxt=buses.length>1?`${buses.length} trips: ${buses.map(busShort).join(', ')}`:(i.bus||buses[0]||'');
  el.innerHTML=`<span class="tdot" style="background:${TYPE[i.type].c}"></span>
    <div class="meta"><div class="t1">${TYPE[i.type].label}
      <span class="sev" style="background:${SEVC[i.severity]}">SEV ${i.severity}</span>
      <span class="badge ${i.status}">${i.status.replace('_',' ')}</span>
      ${(i.type!=='waterlogging'&&getSession()?.role!=='crew')?`<span class="badge ${i.crew?'assigned':'unassigned'}">${i.crew?'Assigned':'Unassigned'}</span>`:''}</div>
      <div class="t2">${i.street} · ${i.id} · ${i.passes} passes · ${Math.round(i.confidence*100)}% conf · ${i.route} · ${busTxt}</div></div>
    <div class="pri">P ${priority(i).toFixed(1)}</div>`;
  el.onclick=()=>openIssue(i.id,opts); return el;
}

function viewStreet(){
  state.street=state.street||null;
  const scopedWard=state.ward;
  const allStreets=scopedWard?DATA.streets.filter(s=>s.wardId===scopedWard):DATA.streets;
  document.getElementById('h-title').textContent='Streets & corridors';
  document.getElementById('h-sub').textContent=scopedWard
    ?`${allStreets.length} corridors in Ward ${scopedWard} — issues aggregated along each road segment.`
    :`${allStreets.length} corridors across ${wardsFC.features.length} wards — issues aggregated along each road segment.`;
  crumb(scopedWard
    ?[{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Ward '+scopedWard,go:()=>{state.view='ward';render();}},{t:'Streets'}]
    :[{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Streets'}]);
  const streets=allStreets.map(s=>{
    const li=issues.filter(i=>i.streetId===s.id); const open=li.filter(i=>OPEN.has(i.status));
    return {...s,total:li.length,open:open.length,load:open.reduce((a,i)=>a+SEVW[i.severity],0)};
  }).sort((a,b)=>b.load-a.load);
  const sel=streets.find(s=>s.id===state.street) || streets[0];
  const list=issues.filter(i=>i.streetId===sel.id);
  const c=document.getElementById('content');
  c.innerHTML=`<div class="row map-side">
    <div class="card"><div class="ch"><h3>${sel.name} <span style="font-weight:600;color:var(--muted);font-size:15px">· Ward ${sel.wardId}</span></h3><span class="r">${list.length} detections along corridor</span></div>
      <div id="streetmap"></div>
      <div class="legend">${Object.entries(TYPE).map(([k,v])=>`<span class="it"><span class="sw" style="background:${v.c}"></span>${v.label}</span>`).join('')}</div></div>
    <div class="card"><div class="ch"><h3>Corridors by open load</h3><span class="r">worst first</span></div>
      <div style="max-height:512px;overflow-y:auto"><table><thead><tr><th>Street</th><th>Ward</th><th>Open</th><th>Load</th></tr></thead><tbody>
      ${streets.map(x=>`<tr class="clk ${x.id===sel.id?'sel':''}" data-s="${x.id}"><td><b>${x.name}</b></td><td>${x.wardId}</td><td>${x.open}</td>
        <td><span class="scorepill" style="background:${x.load>18?'#d32f2f':x.load>10?'#e56a00':'#c98a12'}">${x.load.toFixed(0)}</span></td></tr>`).join('')}
      </tbody></table></div></div>
  </div>
  <div class="card"><div class="ch"><h3>All issues on ${sel.name}</h3><span class="r">${list.length} total · every status</span></div>
    <div style="max-height:452px;overflow-y:auto" id="streetQueue"></div></div>
  <div class="card"><div class="ch"><h3>Fleet coverage</h3><span class="r">buses that have surveyed this corridor — click a trip to replay it</span></div>
    ${(()=>{const trips=tripsForStreet(sel.id); return trips.length
      ?`<table><thead><tr><th>Bus</th><th>Trip date</th><th>Detections here</th></tr></thead><tbody>
        ${trips.map(t=>`<tr class="clk" data-bus="${t.bus}" data-trip="${t.id}"><td><b>${t.bus}</b></td><td>${fmtDate(t.date)}</td><td>${t.detections}</td></tr>`).join('')}
        </tbody></table>`
      :'<div class="hint" style="padding:12px 16px">No fleet passes logged on this corridor yet.</div>';})()}
  </div>`;
  const sm=L.map('streetmap',{zoomControl:true,attributionControl:false});
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{subdomains:'abcd'}).addTo(sm);
  plot(sm,list);
  if(list.length){const g=L.featureGroup(list.map(i=>L.marker([i.lat,i.lon]))); sm.fitBounds(g.getBounds().pad(0.3));}
  const sq=c.querySelector('#streetQueue');
  if(!list.length) sq.innerHTML='<div class="hint">No issues detected on this corridor yet.</div>';
  list.slice().sort((a,b)=>priority(b)-priority(a)).forEach(i=>sq.appendChild(qItem(i)));
  c.querySelectorAll('tr[data-s]').forEach(tr=>tr.onclick=()=>{state.street=tr.dataset.s;render();});
  c.querySelectorAll('tr[data-bus]').forEach(tr=>tr.onclick=()=>{
    state.view='fleet'; state.bus=tr.dataset.bus; state.trip=tr.dataset.trip; render();
  });
}
function tripsForStreet(streetId){ // which bus+trip pairs actually detected something on this corridor — the corridor-to-fleet link
  const byKey={};                  // id must be a real run id so clicking through opens the matching Fleet replay (viewTripReplay looks up tripsForBus by run id)
  issues.filter(i=>i.streetId===streetId).forEach(i=>{
    (i.history||[]).forEach(h=>{
      const date=h.t.slice(0,10);
      const run=liveRuns().find(r=>r.bus===h.bus && r.date===date);
      if(!run) return; // no logged trip to replay for this pass
      const key=run.id;
      (byKey[key]=byKey[key]||{bus:run.bus,date:run.date,id:run.id,issueIds:new Set()}).issueIds.add(i.id);
    });
  });
  return Object.values(byKey).map(x=>({bus:x.bus,date:x.date,id:x.id,detections:x.issueIds.size}))
    .sort((a,b)=>b.date.localeCompare(a.date));
}

function contractorName(i){ return i.crew?crewById(i.crew).name:'Unassigned'; }
function crewPerformanceNote(i){          // per-issue callout — recognize fast fixes, flag stale backlog, say nothing in between
  if(i.type==='waterlogging') return '';
  if(i.status==='resolved'||i.status==='verified_fixed'){
    const days=resolutionDays(i);
    if(days<=3) return `<div class="hint" style="background:var(--good-bg);color:var(--good);border-radius:10px;padding:10px 14px;margin:14px 0;font-weight:700">🎉 Fixed in ${days<=0?'under a day':days+'d'} by ${contractorName(i)} — fast turnaround, nice work.</div>`;
    return '';
  }
  if(OPEN.has(i.status) && daysOpen(i)>7){
    return `<div class="hint" style="background:var(--bad-bg);color:var(--pothole);border-radius:10px;padding:10px 14px;margin:14px 0;font-weight:700">⏳ Open ${daysOpen(i)} days, unresolved — logged as a miss for ${contractorName(i)}.</div>`;
  }
  return '';
}
function viewPerformance(){
  state.ward=state.street=state.type=null;
  document.getElementById('h-title').textContent='Performance';
  document.getElementById('h-sub').textContent='Fast fixes worth recognizing, and issues that have sat open too long — same confirmed-issue set, both sides of the story.';
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Performance'}]);
  const repairable=issues.filter(i=>i.type!=='waterlogging');
  const praise=repairable.filter(i=>(i.status==='resolved'||i.status==='verified_fixed')&&resolutionDays(i)<=3)
    .sort((a,b)=>resolutionDays(a)-resolutionDays(b));
  const misses=repairable.filter(i=>OPEN.has(i.status)&&daysOpen(i)>7)
    .sort((a,b)=>daysOpen(b)-daysOpen(a));
  const c=document.getElementById('content');
  c.innerHTML=`<div class="row" style="grid-template-columns:1fr 1fr">
    <div class="card">
      <div class="ch"><h3>🎉 Praise</h3><span class="r">${praise.length} fixed in ≤3 days</span></div>
      ${praise.length?`<table><thead><tr><th>Location</th><th>Ward</th><th>Fixed in</th><th>Contractor</th></tr></thead><tbody>
        ${praise.slice(0,25).map(i=>`<tr class="clk" data-open="${i.id}"><td><span class="tdot" style="background:${TYPE[i.type].c};margin-right:6px"></span>${i.street} · ${i.id}</td>
          <td>${i.ward}</td><td>${resolutionDays(i)<=0?'<1d':resolutionDays(i)+'d'}</td><td><span class="badge assigned">${contractorName(i)}</span></td></tr>`).join('')}
        </tbody></table>${praise.length>25?`<div class="hint">+${praise.length-25} more fast fixes</div>`:''}`
        :`<div class="cb"><div class="hint" style="padding:4px">No fast fixes yet on this run.</div></div>`}
    </div>
    <div class="card">
      <div class="ch"><h3>⏳ Misses</h3><span class="r">${misses.length} open 7+ days</span></div>
      ${misses.length?`<table><thead><tr><th>Location</th><th>Ward</th><th>Days open</th><th>Contractor</th></tr></thead><tbody>
        ${misses.slice(0,25).map(i=>`<tr class="clk" data-open="${i.id}"><td><span class="tdot" style="background:${TYPE[i.type].c};margin-right:6px"></span>${i.street} · ${i.id}</td>
          <td>${i.ward}</td><td>${daysOpen(i)}d</td><td><span class="badge shame">${contractorName(i)}</span></td></tr>`).join('')}
        </tbody></table>${misses.length>25?`<div class="hint">+${misses.length-25} more overdue</div>`:''}`
        :`<div class="cb"><div class="hint" style="padding:4px">Nothing has gone unresolved for more than a week — clean sweep.</div></div>`}
    </div>
  </div>`;
  c.querySelectorAll('tr[data-open]').forEach(tr=>tr.onclick=()=>openIssue(tr.dataset.open));
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
    <table><thead><tr><th></th><th>Crew ID</th><th>Name</th><th>Specialism</th><th>Ward</th><th>Assigned</th><th>Completed</th><th></th></tr></thead><tbody>
    ${rows.map((cm,i)=>`<tr class="clk" data-crew="${cm.id}"><td class="rank">${i+1}</td>
      <td><b>${cm.id}</b></td><td>${cm.name}</td>
      <td><span class="tdot" style="background:${TYPE[cm.type].c};display:inline-block;margin-right:6px;vertical-align:middle"></span>${TYPE[cm.type].label}</td>
      <td>${cm.ward?'Ward '+cm.ward:'—'}</td>
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
  if(!open.length) q.innerHTML='<div class="hint">No issue assigned.</div>';
  open.forEach(i=>q.appendChild(qItem(i,{hideAssign:true})));
  const dq=m.querySelector('#crewDone');
  if(dq) done.forEach(i=>dq.appendChild(qItem(i,{hideAssign:true})));
  document.getElementById('cx').onclick=closeDrawer; s.onclick=closeDrawer;
  s.classList.add('on'); m.classList.add('on');
}
function viewMyWork(){
  state.ward=state.street=state.type=null;
  const session=getSession();
  const cm=session&&crewById(session.crewId);
  document.getElementById('h-title').textContent='My work';
  crumb([{t:'My work'}]);
  const c=document.getElementById('content');
  if(!cm){
    document.getElementById('h-sub').textContent='Your account isn\'t linked to a crew record.';
    c.innerHTML='<div class="card cb"><div class="hint" style="padding:4px">No matching crew record — ask an admin to check your account.</div></div>';
    return;
  }
  document.getElementById('h-sub').textContent=`${cm.name} · ${TYPE[cm.type].label} specialist${cm.ward?' · Ward '+cm.ward:''} · your resolution queue and history.`;
  const mine=issues.filter(i=>i.crew===cm.id);
  const open=mine.filter(i=>OPEN.has(i.status)).sort((a,b)=>priority(b)-priority(a));
  const done=mine.filter(i=>!OPEN.has(i.status));
  c.innerHTML=`<div class="card"><div class="ch"><h3>${cm.name}</h3><span class="r">${cm.id} · ${TYPE[cm.type].label} specialist${cm.ward?' · Ward '+cm.ward:''}</span></div>
    <div class="section-t" style="margin:14px 16px 6px">Assigned to you — ${open.length}/${CREW_CAPACITY} open${open.length>=CREW_CAPACITY?' <span class="badge confirmed" style="text-transform:none;letter-spacing:0">worklist full</span>':''}</div>
    <div id="myQueue"></div>
    ${done.length?`<div class="section-t" style="margin:18px 16px 6px">Completed — ${done.length}</div><div id="myDone"></div>`:''}
  </div>`;
  const q=c.querySelector('#myQueue');
  if(!open.length) q.innerHTML='<div class="hint">No issue assigned.</div>';
  open.forEach(i=>q.appendChild(qItem(i,{hideAssign:true})));
  const dq=c.querySelector('#myDone');
  if(dq) done.forEach(i=>dq.appendChild(qItem(i,{hideAssign:true})));
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
function tripsForBus(busId){ // one detector run assigned to this bus = one trip (manifest-driven)
  return liveRuns().filter(r=>r.bus===busId).map(r=>{
    const stops=issues.filter(i=>(i.runIds||[i.runId]).includes(r.id));
    return {id:r.id, date:r.date, label:r.label, run:r, stops,
      wards:[...new Set(stops.map(i=>i.ward))],
      detections:(r.feed||[]).length};
  }).sort((a,b)=>b.date.localeCompare(a.date));
}

// Detector runs injected by js/live.js -> window.CITYLENS_LIVE.runs. Each run is one Fleet
// trip: {id,label,bus,date,distance_km,video,motion,feed}. Its de-duplicated pins live in
// DATA.issues (tagged with runId); its feed/motion/video drive that trip's replay.
function liveRuns(){ return (window.CITYLENS_LIVE && window.CITYLENS_LIVE.runs) || []; }
function runById(id){ return liveRuns().find(r=>r.id===id) || null; }
function busShort(b){ return b ? String(b).replace(/^.*-/,'') : ''; }   // "MH01-BST-1423" -> "1423"
// Every distinct bus/trip that detected this spot — passes is the count of these, so listing
// them makes "4 passes" visibly "4 trips: 1423, 5106, …" instead of looking single-trip.
// Falls back to the single bus for seed pins (no runIds).
function tripBusesFor(i){
  const ids=(i.runIds&&i.runIds.length)?i.runIds:(i.runId?[i.runId]:[]);
  const seen=new Set(), out=[];
  ids.forEach(rid=>{ const r=runById(rid), b=r&&r.bus; if(b&&!seen.has(b)){seen.add(b);out.push(b);} });
  return out.length?out:(i.bus?[i.bus]:[]);
}

function viewFleet(){
  if(state.bus && state.trip) return viewTripReplay();
  viewFleetList();
}
function viewFleetList(){
  document.getElementById('h-title').textContent='Fleet & route replay';
  document.getElementById('h-sub').textContent = liveRuns().length
    ? 'Live detections from the on-bus model — open a trip below to watch the synced replay.'
    : 'Per-bus contribution — expand a bus to see its logged trips.';
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Fleet'}]);
  const perBus=DATA.buses.map(b=>{const li=issues.filter(i=>i.bus===b);
    return {b,total:li.length,open:li.filter(i=>OPEN.has(i.status)).length,trips:tripsForBus(b)};}).sort((a,b)=>b.total-a.total);
  const c=document.getElementById('content');
  c.innerHTML=`<div class="card"><div class="ch"><h3>Fleet contribution</h3><span class="r">${DATA.buses.length} buses · click a bus to expand its trip log</span></div>
    <table><thead><tr><th></th><th>Bus</th><th>Detections</th><th>Open</th><th>Trips</th></tr></thead>
    ${perBus.map(x=>`<tbody>
      <tr class="clk" data-toggle="${x.b}"><td class="chev" id="chev-${x.b}">▸</td><td><b>${x.b}</b></td><td>${x.total}</td><td>${x.open}</td><td>${x.trips.length}</td></tr>
      <tr id="trips-${x.b}" style="display:none"><td colspan="5" style="padding:10px 0;background:#f0f1f4">
        ${x.trips.length?`<table><thead><tr><th>Date</th><th>Ward</th><th>Detections</th><th>Stops</th></tr></thead><tbody>
          ${x.trips.map(t=>`<tr class="clk" data-bus="${x.b}" data-t="${t.id}"><td><b>${fmtDate(t.date)}</b></td><td>${t.wards.join(', ')}</td><td>${t.detections}</td><td>${t.stops.length}</td></tr>`).join('')}
          </tbody></table>`:'<div class="hint" style="padding:12px 16px">No logged trips for this bus.</div>'}
      </td></tr>
    </tbody>`).join('')}
    </table></div>`;
  c.querySelectorAll('tr[data-toggle]').forEach(tr=>tr.onclick=()=>{
    const b=tr.dataset.toggle, row=document.getElementById('trips-'+b), chev=document.getElementById('chev-'+b);
    const hidden=row.style.display==='none';
    row.style.display=hidden?'':'none'; chev.textContent=hidden?'▾':'▸';
  });
  c.querySelectorAll('tr[data-t]').forEach(tr=>tr.onclick=(e)=>{
    e.stopPropagation(); state.bus=tr.dataset.bus; state.trip=tr.dataset.t; render();
  });
}
function viewTripReplay(){
  const trip=tripsForBus(state.bus).find(t=>t.id===state.trip);
  if(!trip){ state.bus=null; state.trip=null; return viewFleetList(); }
  document.getElementById('h-title').textContent=state.bus;
  document.getElementById('h-sub').textContent=`Trip on ${fmtDate(trip.date)} — dashcam replay with detections dropping in sync.`;
  crumb([{t:'Mumbai',go:()=>{state.view='city';render();}},{t:'Fleet',go:()=>{state.bus=null;state.trip=null;render();}},
    {t:state.bus,go:()=>{state.bus=null;state.trip=null;render();}},{t:fmtDate(trip.date)}]);
  const c=document.getElementById('content');
  const run=trip.run;                              // detector run backing this trip
  const live=(run&&run.feed)?run.feed:[];          // timed detections for the replay feed
  c.innerHTML=`<div class="row map-side">
    <div class="card">
      <div class="ch"><h3>Trip replay — ${fmtDate(trip.date)}</h3><span class="r">bus ${state.bus}</span></div>
      <div class="videoslot" id="videoslot">
        ${(run&&run.video)?`<video id="replayVideo" src="${run.video}" muted playsinline style="width:100%;height:100%;object-fit:cover;display:block"></video>`:''}
        <div class="rd"><span class="d"></span>DASHCAM</div>
        <div id="videoFallback" style="${(run&&run.video)?'display:none':''}">No clip bundled for this trip — map pins still sync to the route timeline below.</div>
      </div>
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
      <div class="ch" style="border-top:1px solid var(--line)"><h3>Trip stops</h3></div>
      <div style="max-height:220px;overflow-y:auto"><table><thead><tr><th>Issue</th><th>Street</th><th>Sev</th></tr></thead><tbody>
      ${trip.stops.map(i=>`<tr class="clk" data-open="${i.id}"><td><b>${i.id}</b></td>
        <td><a data-goto-street="${i.streetId}" data-goto-ward="${i.ward}" style="color:var(--chalo-d);text-decoration:underline;cursor:pointer">${i.street}</a></td>
        <td>${i.severity}</td></tr>`).join('')}
      </tbody></table></div>
    </div></div>`;
  c.querySelectorAll('tr[data-open]').forEach(tr=>tr.onclick=()=>openIssue(tr.dataset.open));
  c.querySelectorAll('a[data-goto-street]').forEach(a=>a.onclick=(e)=>{
    e.stopPropagation();
    state.view='street'; state.ward=a.dataset.gotoWard; state.street=a.dataset.gotoStreet; render();
  });

  stopReplay(); replay.t=0; replay.df=0; replay.seen.clear();
  const fm=L.map('fleetmap',{zoomControl:true,attributionControl:false});
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{subdomains:'abcd'}).addTo(fm);
  const route=DATA.routes['A-71']; // same fixed, real road-following route used everywhere — identical mechanics to the original single demo
  const poly=addRouteOverlay(fm);
  fm.fitBounds(poly.getBounds().pad(0.25));
  const busMarker=L.circleMarker(route[0],{radius:8,fillColor:'#f57c00',color:'#fff',weight:2,fillOpacity:1}).addTo(fm);
  // Real motion pacing from the backend pipeline (window.CITYLENS_LIVE.motion): the true
  // distance the clip covers + a cumulative-distance curve, so the km readout and marker
  // follow the video's actual speed (crawl, stops) instead of a fixed 8.6 km linear sweep.
  // Falls back to the old behaviour when the motion payload is absent.
  const __M=(run&&run.motion)||null;               // this run's real motion pacing
  const totalKm=(__M&&__M.distance_km)?__M.distance_km:((run&&run.distance_km)||8.6);
  function cumFrac(sec,dur){ // video time -> distance fraction (0..1) along the real motion curve
    if(!__M||!__M.cum||!__M.cum.length) return dur?Math.min(1,sec/dur):0;
    const c=__M.cum;
    if(sec<=c[0][0]) return c[0][1];
    if(sec>=c[c.length-1][0]) return c[c.length-1][1];
    let lo=0,hi=c.length-1;
    while(lo<hi){const md=(lo+hi)>>1; if(c[md][0]<sec)lo=md+1; else hi=md;}
    const a=c[Math.max(1,lo)-1], b=c[Math.max(1,lo)];
    return b[0]<=a[0]?a[1]:a[1]+(b[1]-a[1])*(sec-a[0])/(b[0]-a[0]);
  }

  function posAt(t){ // t in 0..1 -> [lat,lon] along the fixed route
    const n=route.length-1, x=t*n, idx=Math.min(n-1,Math.floor(x)), f=x-idx;
    const a=route[idx],b=route[idx+1];
    return [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f];
  }
  function fmtClock(sec){ const m=Math.floor(sec/60), s=Math.floor(sec%60); return `${m}:${String(s).padStart(2,'0')}`; }
  function markerForLive(i){ // no GPS from the detector — drop the pin at the bus's position (km along route) when it fired
    const km=(replay.df*totalKm).toFixed(1);
    return L.circleMarker(posAt(replay.df),{radius:3+i.severity*1.4,fillColor:TYPE[i.type].c,color:'#fff',weight:1.4,fillOpacity:.9})
      .bindPopup(`<b>${TYPE[i.type].label}</b> · ${Math.round(i.confidence*100)}% confidence<br>${fmtClock(i.t)} into clip · ${km} km along route`);
  }
  function addFeedLive(i){
    const feed=document.getElementById('feed');
    if(replay.seen.size===1)feed.innerHTML='';
    const km=(replay.df*totalKm).toFixed(1);
    const el=document.createElement('div');el.className='feeditem';
    el.innerHTML=`<span class="tdot" style="background:${TYPE[i.type].c}"></span>
      ${i.crop?`<img src="${i.crop}" style="width:36px;height:36px;object-fit:cover;border-radius:4px;flex:0 0 36px" onerror="this.remove()">`:''}
      <div class="meta"><div class="t1">${TYPE[i.type].label} <span class="sev" style="background:${SEVC[i.severity]}">SEV ${i.severity}</span></div>
      <div class="t2">${fmtClock(i.t)} into clip · ${km} km · ${Math.round(i.confidence*100)}% · ${i.id}</div></div>`;
    feed.prepend(el);
    document.getElementById('feedn').textContent=replay.seen.size;
  }

  // real detector output (video + timestamped detections) takes over the replay when present;
  // otherwise it falls back to our simulated trip timeline built from this bus's actual stops
  const video=document.getElementById('replayVideo');
  if(video){
    video.onerror=()=>{
      // this run's clip isn't available here (e.g. the deployed site) — simulated timeline
      video.remove();
      const fb=document.getElementById('videoFallback'); if(fb)fb.style.display='';
      wireSimulated();
    };
    video.onloadedmetadata=wireVideoDriven;
  } else {
    wireSimulated();
  }

  function wireVideoDriven(){
    video.ontimeupdate=()=>{
      replay.t=video.duration?video.currentTime/video.duration:0;
      replay.df=cumFrac(video.currentTime,video.duration);   // distance fraction from real motion
      busMarker.setLatLng(posAt(replay.df));
      document.getElementById('fill').style.width=(replay.t*100)+'%';
      document.getElementById('clock').textContent=(replay.df*totalKm).toFixed(1)+' km';
      live.forEach(i=>{
        if(video.currentTime>=i.t && !replay.seen.has(i.id)){
          replay.seen.add(i.id); markerForLive(i).addTo(fm); addFeedLive(i);
        }
      });
    };
    video.onended=stopReplay;
    document.getElementById('track').onclick=(e)=>{
      const r=e.currentTarget.getBoundingClientRect();
      video.currentTime=((e.clientX-r.left)/r.width)*(video.duration||0);
    };
    document.getElementById('play').onclick=()=>{
      const b=document.getElementById('play');
      if(video.paused){video.play();b.textContent='❚❚ Pause';} else {video.pause();b.textContent='▶ Play';}
    };
    document.getElementById('reset').onclick=()=>{
      stopReplay();replay.t=0;replay.seen.clear();render();
    };
  }

  function wireSimulated(){
    // this bus's real trip stops — evenly spaced along the fixed demo route and dropped exactly where
    // the bus currently is, since the issues' own real coordinates sit far from this decorative path
    const routeIssues=trip.stops;
    function step(){
      replay.t=Math.min(1,replay.t+0.006);
      const p=posAt(replay.t);
      busMarker.setLatLng(p);
      document.getElementById('fill').style.width=(replay.t*100)+'%';
      document.getElementById('clock').textContent=(replay.t*totalKm).toFixed(1)+' km';
      routeIssues.forEach((i,stopIdx)=>{ const at=(stopIdx+1)/(routeIssues.length+1);
        if(replay.t>=at && !replay.seen.has(i.id)){ replay.seen.add(i.id);
          markerAt(i,p).addTo(fm); addFeed(i); }});
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
    document.getElementById('reset').onclick=()=>{stopReplay();replay.t=0;replay.seen.clear();render();};
  }
}
function toggleReplay(){ const b=document.getElementById('play');
  if(replay.timer){stopReplay();} else {b.textContent='❚❚ Pause';replay.timer=setInterval(()=>window._replayStep(),90);} }
function stopReplay(){
  if(replay.timer){clearInterval(replay.timer);replay.timer=null;}
  const v=document.getElementById('replayVideo'); if(v && !v.paused)v.pause();
  const b=document.getElementById('play'); if(b)b.textContent= replay.t>=1?'▶ Replay':'▶ Play';
}

/* ---------- issue detail drawer ---------- */
let issueCtx={};
function openIssue(id,opts){
  const i=issues.find(x=>x.id===id); if(!i)return;
  issueCtx=opts||{};                     // remember how this drawer was opened (e.g. from crew flow) across resolve/verify refreshes
  document.getElementById('crewModal').classList.remove('on');
  const d=document.getElementById('drawer'), s=document.getElementById('scrim');
  const hist=(i.history&&i.history.length)?i.history:[{t:i.first_seen,bus:i.bus,detected:true},{t:i.last_seen,bus:i.bus,detected:i.status!=='verified_fixed'}];
  const buses=tripBusesFor(i);            // every trip/bus that detected this spot (passes = count of these)
  d.innerHTML=`<div class="dh"><span class="tdot" style="background:${TYPE[i.type].c};width:14px;height:14px"></span>
      <div><b style="font-size:15px">${TYPE[i.type].label}</b>
      <div style="font-size:12px;color:var(--faint)">${i.id} · Ward ${i.ward}</div></div>
      <button class="x" id="dx">×</button></div>
    <div class="db">
      <div class="evidence">${evidenceHTML(i)}</div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <span class="sev" style="background:${SEVC[i.severity]};padding:4px 9px">SEVERITY ${i.severity}</span>
        <span class="badge ${i.status}" style="padding:4px 11px">${i.status.replace('_',' ')}</span>
        <span class="badge" style="background:#f0f1f4;color:var(--muted);padding:4px 11px">${Math.round(i.confidence*100)}% confidence</span>
      </div>
      <dl class="dl">
        <dt>Location</dt><dd>${i.street}, Ward ${i.ward}</dd>
        <dt>GPS</dt><dd>${i.lat.toFixed(5)}, ${i.lon.toFixed(5)}</dd>
        <dt>Route / ${buses.length>1?'buses':'bus'}</dt><dd>${i.route} · ${buses.length>1?buses.join(', '):i.bus}</dd>
        <dt>First seen</dt><dd>${fmtDT(i.first_seen)}</dd>
        <dt>Independent passes</dt><dd>${i.passes}${buses.length>1?` · ${buses.length} trips (${buses.map(busShort).join(', ')})`:''} ${i.passes>=3?'✓ confirmed':(i.passes===2?'· reported':'· awaiting gate')}</dd>
        ${i.type!=='waterlogging'?`<dt>Assigned crew</dt><dd>${i.crew? crewById(i.crew).name+' · '+i.crew : 'Unassigned · backlog'}</dd>`:''}
      </dl>
      ${crewPerformanceNote(i)}
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

const EVIDENCE_PHOTOS={
  pothole:[
    'https://res.cloudinary.com/dk1uns1nz/image/upload/v1783174326/AI_lu8g4o.png',
    'https://res.cloudinary.com/dk1uns1nz/image/upload/v1783174325/pothhole-detection-500x500_n3moul.webp'
  ],
  garbage_pile:[
    'https://res.cloudinary.com/dk1uns1nz/image/upload/v1783175036/images_3_garjvs.jpg',
    'https://res.cloudinary.com/dk1uns1nz/image/upload/v1783175036/images_2_btrf63.jpg'
  ]
};
function pickEvidencePhoto(type,id){    // deterministic per issue — same photo on every view, not reshuffled each render
  const photos=EVIDENCE_PHOTOS[type]; if(!photos) return null;
  let hash=0; for(const ch of id) hash=(hash*31+ch.charCodeAt(0))>>>0;
  return photos[hash%photos.length];
}
// Real detector evidence (annotated frame / crop) when the pipeline provides it (issue.photo),
// falling back to the curated stock photo / schematic below when it's absent or fails to load.
function evidenceHTML(i){
  if(i.photo){
    return `<img src="${i.photo}" alt="${TYPE[i.type].label} detection" class="evimg"
      onerror="this.outerHTML=window.__evSVG('${i.id}')">
      <span class="evtag">detected frame · ${Math.round(i.confidence*100)}% · ${i.id}</span>`;
  }
  return evidenceSVG(i);
}
window.__evSVG=function(id){ const i=issues.find(x=>x.id===id); return i?evidenceSVG(i):''; };
function evidenceSVG(i){
  const c=TYPE[i.type].c;
  const photo=pickEvidencePhoto(i.type,i.id);
  if(photo){
    return `<div style="position:relative;width:100%;height:100%">
      <img src="${photo}" alt="${TYPE[i.type].label} evidence" style="width:100%;height:100%;object-fit:cover;display:block">
      <span style="position:absolute;left:10px;top:10px;background:${c};color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:3px;font-family:'Noto Sans',sans-serif">${TYPE[i.type].label} ${Math.round(i.confidence*100)}%</span>
      <span style="position:absolute;left:10px;bottom:8px;color:#fff;font-size:9px;font-family:'Noto Sans',sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.8)">dashcam frame · ${i.id}</span>
    </div>`;
  }
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
  if(state.view==='street'){state.street=null;state.ward=null;}
  if(state.view==='fleet'){state.bus=null;state.trip=null;}
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
  document.body.classList.remove('role-admin','role-ward_officer','role-user','role-crew');
  document.body.classList.add('role-'+session.role);
  if(session.role==='ward_officer'){ state.view='ward'; state.ward=session.ward; }
  if(session.role==='crew'){ state.view='mywork'; }
}

/* ---------- live processing feed ----------
   Polls js/live.json (regenerated by the backend pipeline as the detector processes the
   video) and updates the dashboard IN PLACE — new, de-duplicated detections appear on the
   map and lists without a page reload. No-ops on static hosting where live.json is absent. */
let __liveRev=null;
async function pollLive(){
  try{
    const r=await fetch('js/live.json?_='+Date.now(),{cache:'no-store'});
    if(!r.ok) return;
    const p=await r.json();
    if(!p||!Array.isArray(p.issues)||p.rev===__liveRev) return;
    const first=__liveRev===null;
    __liveRev=p.rev;
    const prevLive=issues.filter(i=>i.runId).length;
    const seed=issues.filter(i=>!i.runId);         // keep seed + officer edits (no runId)
    issues.length=0; issues.push(...seed, ...p.issues);             // mutate the shared array in place
    if(Array.isArray(p.replay)) DATA.replay_ids=p.replay;
    Object.assign(SCORES, wardScores());
    if(first){ counts(); return; }                                  // silent sync at startup
    liveToast(p.issues.length, p.issues.length-prevLive, p.partial);
    // Refresh the view behind the user only when they aren't mid-interaction.
    const busy=document.getElementById('drawer').classList.contains('on')
      || document.getElementById('crewModal').classList.contains('on')
      || state.view==='fleet';
    if(busy) counts(); else render();
  }catch(e){/* live.json not served (static host) — ignore */}
}
function liveToast(total, added, partial){
  let el=document.getElementById('liveToast');
  if(!el){ el=document.createElement('div'); el.id='liveToast'; el.className='livetoast'; document.body.appendChild(el); }
  el.innerHTML=`<span class="dot"></span> ${partial?'Processing video':'Processing complete'} · <b>${total}</b> detections${added>0?` · <span style="color:#8fd39a">+${added} new</span>`:''}`;
  el.classList.add('show');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'), 4200);
}
if(getSession()){ pollLive(); setInterval(pollLive, 8000); }
