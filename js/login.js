// CityLens — login page (login.html). Requires js/data.js and js/auth.js first.

// Already signed in? Skip straight to the dashboard.
if (getSession()) {
  location.href = 'index.html';
}

function populateWardSelect(sel){ sel.innerHTML=WARD_CODES.map(w=>`<option value="${w}">Ward ${w}</option>`).join(''); }
populateWardSelect(document.getElementById('su-ward'));

document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('loginForm').style.display= t.dataset.tab==='login'?'flex':'none';
  document.getElementById('signupForm').style.display= t.dataset.tab==='signup'?'flex':'none';
  document.getElementById('forgotForm').style.display='none';
});
document.getElementById('gotoForgot').onclick=e=>{ e.preventDefault();
  document.getElementById('loginForm').style.display='none';
  document.getElementById('signupForm').style.display='none';
  document.getElementById('forgotForm').style.display='flex';
  document.getElementById('fg-codebox').style.display='none';
};
document.getElementById('backToLogin').onclick=e=>{ e.preventDefault();
  document.getElementById('forgotForm').style.display='none';
  document.getElementById('loginForm').style.display='flex';
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab==='login'));
};
document.getElementById('su-role').onchange=e=>{
  document.getElementById('su-wardfield').style.display= e.target.value==='ward_officer'?'flex':'none';
};

document.getElementById('loginForm').onsubmit=async e=>{
  e.preventDefault(); const err=document.getElementById('li-err'); err.textContent='';
  try{
    await login(document.getElementById('li-user').value, document.getElementById('li-pass').value);
    location.href='index.html';
  }catch(ex){ err.textContent=ex.message; }
};
document.getElementById('signupForm').onsubmit=async e=>{
  e.preventDefault(); const err=document.getElementById('su-err'); err.textContent='';
  const pass=document.getElementById('su-pass').value, pass2=document.getElementById('su-pass2').value;
  if(pass!==pass2){ err.textContent='Passwords do not match.'; return; }
  try{
    await signUp({
      username:document.getElementById('su-user').value,
      mobile:document.getElementById('su-mobile').value,
      password:pass,
      role:document.getElementById('su-role').value,
      ward:document.getElementById('su-ward').value
    });
    await login(document.getElementById('su-user').value, pass);
    location.href='index.html';
  }catch(ex){ err.textContent=ex.message; }
};
document.getElementById('fg-send').onclick=()=>{
  const err=document.getElementById('fg-err'); err.style.color='';
  try{
    const code=requestReset(document.getElementById('fg-user').value);
    document.getElementById('fg-codebox').style.display='flex';
    err.style.color='var(--good)';
    err.textContent='Demo reset code: '+code+' (shown here since no SMS/email is wired up)';
  }catch(ex){ err.style.color=''; err.textContent=ex.message; }
};
document.getElementById('forgotForm').onsubmit=async e=>{
  e.preventDefault(); const err=document.getElementById('fg-err');
  try{
    await resetPassword(document.getElementById('fg-code').value, document.getElementById('fg-newpass').value);
    err.style.color='var(--good)'; err.textContent='Password reset. You can log in now.';
    setTimeout(()=>document.getElementById('backToLogin').click(),1200);
  }catch(ex){ err.style.color=''; err.textContent=ex.message; }
};
