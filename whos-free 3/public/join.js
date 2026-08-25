// The join screen. Server-rendered HTML (so the WhatsApp unfurl works), with
// just enough script to pick a name, optionally set a PIN, and POST.

const main = document.querySelector('.join');
const slug = main.dataset.slug;
const dialog = document.getElementById('pinDialog');
const pinInput = document.getElementById('pinInput');
const pinError = document.getElementById('pinError');
const pinTitle = document.getElementById('pinTitle');
const pinHint = document.getElementById('pinHint');
const addHint = document.getElementById('addHint');
let chosen = null;

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// The cookie is set and the redirect happens HERE, on the POST - never on the
// GET, or the link preview breaks.
async function attempt(pin) {
  const { ok, data } = await post('/api/join', { slug, personId: chosen.id, pin });
  if (ok) {
    // A first-timer goes to the typical-week screen, never to a month grid.
    window.location.href = data.hasPattern ? '/' : '/setup';
    return;
  }
  if (data.error === 'PIN_REQUIRED') {
    pinTitle.textContent = `Enter ${chosen.name}'s PIN`;
    pinHint.textContent = 'This name is protected by a PIN.';
    document.getElementById('pinSkip').hidden = true;
    pinError.textContent = '';
    if (!dialog.open) dialog.showModal();
    pinInput.focus();
    return;
  }
  pinError.textContent = data.retryAfterSeconds
    ? `${data.message} (${Math.ceil(data.retryAfterSeconds / 60)} min)`
    : (data.triesLeft != null ? `${data.message} ${data.triesLeft} tries left.` : (data.message || 'That did not work.'));
  if (!dialog.open) dialog.showModal();
}

// The roster grid only exists once somebody is on the roster. Without this
// guard the whole module throws here on a first visit, which silently kills the
// "Add me" handler below - the one thing a first visitor needs.
const grid = document.querySelector('.who-grid');
if (grid) grid.addEventListener('click', (e) => {
  const btn = e.target.closest('.who');
  if (!btn) return;
  chosen = { id: btn.dataset.id, name: btn.querySelector('.who-name').textContent };
  if (btn.dataset.pin === '1') {
    attempt(undefined);
  } else {
    pinTitle.textContent = `You're ${chosen.name}`;
    pinHint.textContent = 'Set a 4+ digit PIN so nobody edits your row by accident (optional - skip it). 6 digits is better.';
    document.getElementById('pinSkip').hidden = false;
    pinError.textContent = '';
    pinInput.value = '';
    dialog.showModal();
    pinInput.focus();
  }
});

document.getElementById('pinSkip').addEventListener('click', () => attempt(undefined));
document.getElementById('pinGo').addEventListener('click', () => {
  const pin = pinInput.value.trim();
  if (pin && !/^\d{4,12}$/.test(pin)) {
    pinError.textContent = 'A PIN is 4 or more digits, numbers only.';
    return;
  }
  attempt(pin || undefined);
});
pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('pinGo').click(); }
});

document.querySelector('.add-person').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('newName');
  const name = input.value.trim();
  if (!name) return;
  addHint.textContent = 'Adding...';
  const { ok, data } = await post('/api/person', { slug, name, opId: crypto.randomUUID() });
  if (!ok) { addHint.textContent = data.message || 'Could not add that name.'; return; }
  addHint.textContent = `${data.person.name} added. Tap their name to carry on.`;
  input.value = '';
  window.location.reload();
});
