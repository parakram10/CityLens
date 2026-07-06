// CityLens — shared auth core (ported 1:1 from js/auth.js).
//
// Prototype only — no backend exists. Accounts, password hashes, and sessions live
// entirely in this browser's localStorage/sessionStorage. There is no server-side
// verification, no transport security, and nothing stops a user from editing
// localStorage directly. A real deployment needs a proper backend with server-side
// password hashing (bcrypt/argon2), HTTPS, and session tokens before it can hold
// real credentials.
import { DATA } from './data.js';
import { CREW, CREW_TYPES, nextCrewId, saveCrewExtra } from './data.js';

const USERS_KEY = 'citylens_users_v1';
const SESSION_KEY = 'citylens_session_v1';
export const WARD_CODES = DATA.wards.features.map(f => f.properties.ward).sort();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function loadUsers() { try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; } catch { return []; } }
function saveUsers(list) { localStorage.setItem(USERS_KEY, JSON.stringify(list)); }
export function findUser(handle) {
  const h = (handle || '').trim();
  if (!h) return null;
  return loadUsers().find(u => u.username.toLowerCase() === h.toLowerCase() || u.mobile === h);
}
export async function signUp({ username, mobile, password, role, ward, specialism }) {
  username = (username || '').trim(); mobile = (mobile || '').trim();
  if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) throw new Error('Username must be 3–24 characters (letters, numbers, _ or .).');
  if (!/^[0-9]{10}$/.test(mobile)) throw new Error('Enter a valid 10-digit mobile number.');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
  if (!['admin', 'ward_officer', 'user', 'crew'].includes(role)) throw new Error('Select a valid role.');
  const users = loadUsers();
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw new Error('That username is already taken.');
  if (users.some(u => u.mobile === mobile)) throw new Error('That mobile number is already registered.');
  if ((role === 'ward_officer' || role === 'crew') && !WARD_CODES.includes(ward)) throw new Error('Select your ward.');
  if (role === 'crew' && !CREW_TYPES.includes(specialism)) throw new Error('Select your specialism.');
  let crewId = null;
  if (role === 'crew') {
    crewId = nextCrewId();
    const member = { id: crewId, name: username, type: specialism, ward };
    CREW.push(member); // joins the same roster admins manage
    saveCrewExtra(member); // persisted so it's still there once we land on the dashboard
  }
  const passHash = await sha256Hex(password);
  users.push({ username, mobile, passHash, role, ward: (role === 'ward_officer' || role === 'crew') ? ward : null, crewId, createdAt: new Date().toISOString() });
  saveUsers(users);
}
export async function login(handle, password) {
  const u = findUser(handle);
  if (!u) throw new Error('No account found with that username or mobile.');
  const passHash = await sha256Hex(password || '');
  if (passHash !== u.passHash) throw new Error('Incorrect password.');
  const session = { username: u.username, role: u.role, ward: u.ward, crewId: u.crewId || null };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}
export function getSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } }
export function logout() { sessionStorage.removeItem(SESSION_KEY); location.reload(); }

let resetState = null; // { username, code } — demo-only, in-memory reset flow (no SMS/email backend)
export function requestReset(handle) {
  const u = findUser(handle);
  if (!u) throw new Error('No account found with that username or mobile.');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetState = { username: u.username, code };
  return code;
}
export async function resetPassword(code, newPassword) {
  if (!resetState) throw new Error('Request a reset code first.');
  if ((code || '').trim() !== resetState.code) throw new Error('Incorrect reset code.');
  if (!newPassword || newPassword.length < 6) throw new Error('Password must be at least 6 characters.');
  const users = loadUsers();
  const u = users.find(x => x.username === resetState.username);
  if (!u) throw new Error('Account not found.');
  u.passHash = await sha256Hex(newPassword);
  saveUsers(users);
  resetState = null;
}
