# Snapshot: "Assign crew" feature from origin/main (commit 977f344)

Source commit: `977f344` "Add crew assignment flow: assign, unassign, and assigned/unassigned indicator"
(on top of `41a0bbe`, merged into `origin/main` via `e5ead60`)

This is the feature that completes the "Assign crew" button stub already ported into
`@login-system` (which just relabels the button — see `js/app.js` `drawerActions()`).

## What it adds

1. **CSS** — two new badge styles (goes in `css/app.css` near `.badge.verified_fixed`):
```css
.badge.assigned{background:var(--good-bg);color:var(--good)}
.badge.unassigned{background:#f0f1f4;color:var(--faint)}
```

2. **`qItem(i, opts={})`** — add an Assigned/Unassigned badge next to the status badge:
```js
<span class="badge ${i.status}">${i.status.replace('_',' ')}</span>
<span class="badge ${i.crew?'assigned':'unassigned'}">${i.crew?'Assigned':'Unassigned'}</span></div>
```

3. **`drawerActions(i)`** — replace the current stub:
```js
// current stub in @login-system:
df.innerHTML='<button class="btn primary" id="resolve">Mark resolved</button>'
  +(issueCtx.hideAssign?'':'<button class="btn" id="assign">Assign crew</button>');
df.querySelector('#resolve').onclick=()=>{i.status='resolved';i.last_seen=new Date().toISOString();afterAction(i);};
if(!issueCtx.hideAssign) df.querySelector('#assign').onclick=()=>{df.querySelector('#assign').textContent='Assigned ✓';df.querySelector('#assign').disabled=true;};

// replace with:
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
```
Note: `.btn.good` and `.btn.danger` classes — `.btn.danger` already exists (ported with crew modal CSS);
`.btn.good` needs to be checked/added (green "confirmed" style button) if not already present in css/app.css.

4. **New function `openAssignCrew(id)`** (add after `drawerActions`, before `afterAction`):
```js
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
```

## Integration notes for @login-system (modular structure)

- `qItem`, `drawerActions`, `openAssignCrew`, `afterAction` all live in `js/app.js` (already there from the
  crew-info port done last turn — confirm exact current line numbers before patching, they may have shifted).
- CSS badges go in `css/app.css`.
- Reuses `CREW`, `CREW_CAPACITY` (in `js/data.js`) and `crewOpenCount`, `openCrew`, `closeDrawer`, `afterAction`,
  `wardScores` (already in `js/app.js` from the crew-info port).
- No changes needed to `js/data.js` beyond what's already ported — this commit only touches `index.html`
  (view/behavior layer) upstream, nothing in data/seed.
- Should double check `issueCtx` / `hideAssign` plumbing still matches (ported last turn from 41a0bbe;
  977f344 builds directly on top of that same mechanism, so it should slot in cleanly).

## Branch/repo state at time of writing this snapshot

- `origin/main` @ e5ead60 (has this feature)
- local `main` @ e5ead60 (up to date, fast-forwarded)
- `@login-system` @ e1b0a8d (merge of main@41a0bbe — does NOT have this 977f344 commit yet)
- Working directory was switched to `main` by GitHub Desktop; uncommitted crew-info-port edits from
  the previous turn were auto-stashed as `stash@{0}` ("!!GitHub_Desktop<@login-system>") — must restore
  before continuing work on @login-system.
