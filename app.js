/* ── app.js ──────────────────────────────────────────────────────────────────
   Leads Management — Maruf Ahmed
   Auth  : Firebase Google Sign-In
   Storage : Firestore  /users/{uid}/leads/{companyName}
             Falls back to localStorage if Firebase isn't configured yet.
────────────────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 50;

/* ── Firebase handles ───────────────────────────────────────────────────────── */
let auth = null;
let db = null;
let currentUser = null;

// Detect whether firebase-config.js has real values
function firebaseReady() {
    try {
        return firebase.apps.length > 0
            && firebase.app().options.apiKey !== 'PASTE_YOUR_API_KEY';
    } catch { return false; }
}

/* ── State ─────────────────────────────────────────────────────────────────── */
let allLeads = [];   // raw from leads.json
let userData = {};   // { [name]: { status, contactName, contactEmail, notes, updatedAt } }
let filtered = [];   // currently visible (after filter + sort)
let page = 1;
let activeLeadId = null;
let saveTimer = null; // debounce Firestore writes

let filters = {
    status: 'all',
    industries: new Set(),
    funding: new Set(),
    search: '',
    sort: 'rank_asc',
};

/* ── Bootstrap ─────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    if (firebaseReady()) {
        auth = firebase.auth();
        db = firebase.firestore();
        initFirebaseAuth();
    } else {
        // Firebase not configured — run in local-only mode
        console.warn('Firebase not configured. Running in localStorage-only mode.');
        showApp(null);
        loadUserDataLocal();
        bootApp();
    }
});

/* ── Firebase Auth ──────────────────────────────────────────────────────────── */
function initFirebaseAuth() {
    // Show the login screen while we wait for auth state
    document.getElementById('loginScreen').classList.remove('hidden');

    auth.onAuthStateChanged(async user => {
        if (user) {
            currentUser = user;
            showApp(user);
            await loadUserDataFirestore();
            bootApp();
        } else {
            currentUser = null;
            showLoginScreen();
        }
    });

    document.getElementById('googleSignInBtn').addEventListener('click', () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider).catch(err => {
            console.error('Sign-in error', err);
            alert('Sign-in failed: ' + err.message);
        });
    });

    document.getElementById('signOutBtn').addEventListener('click', () => {
        auth.signOut();
    });
}

function showLoginScreen() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('userChip').classList.add('hidden');
}

function showApp(user) {
    document.getElementById('loginScreen').classList.add('hidden');
    if (user) {
        document.getElementById('userChip').classList.remove('hidden');
        const avatar = document.getElementById('userAvatar');
        if (user.photoURL) {
            avatar.src = user.photoURL;
            avatar.style.display = 'block';
        } else {
            avatar.style.display = 'none';
        }
        document.getElementById('userName').textContent = user.displayName || user.email;
    } else {
        document.getElementById('userChip').classList.add('hidden');
    }
}

/* ── Boot (after auth + data load) ─────────────────────────────────────────── */
async function bootApp() {
    await loadLeads();
    buildSidebarFilters();
    attachEventListeners();
    applyFilters();
}

/* ── Load leads.json ───────────────────────────────────────────────────────── */
async function loadLeads() {
    try {
        const res = await fetch('leads.json');
        const data = await res.json();
        allLeads = data.companies || [];
    } catch (e) {
        console.error('Could not load leads.json', e);
        const el = document.getElementById('emptyState');
        el.textContent = '⚠ Could not load leads.json. Make sure the file is in the same folder.';
        el.classList.remove('hidden');
    }
}

/* ── Firestore helpers ──────────────────────────────────────────────────────── */
async function loadUserDataFirestore() {
    if (!db || !currentUser) return;
    try {
        const col = db.collection('users').doc(currentUser.uid).collection('leads');
        const snap = await col.get();
        userData = {};
        snap.forEach(doc => { userData[doc.id] = doc.data(); });
    } catch (e) {
        console.error('Firestore load error', e);
        // Fall back to localStorage so the user isn't blocked
        loadUserDataLocal();
    }
}

function saveToFirestore(name, data) {
    if (!db || !currentUser) { saveUserDataLocal(); return; }
    db.collection('users').doc(currentUser.uid)
        .collection('leads').doc(name)
        .set(data, { merge: true })
        .catch(e => console.error('Firestore save error', e));
}

/* ── localStorage fallback ──────────────────────────────────────────────────── */
const LS_KEY = 'maruf_leads_v1';

function loadUserDataLocal() {
    try { userData = JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
    catch { userData = {}; }
}

function saveUserDataLocal() {
    localStorage.setItem(LS_KEY, JSON.stringify(userData));
}

/* ── Unified save ────────────────────────────────────────────────────────────── */
function persistLead(name, data) {
    userData[name] = data;
    if (firebaseReady() && currentUser) {
        saveToFirestore(name, data);
    } else {
        saveUserDataLocal();
    }
}

function getLeadData(name) {
    return userData[name] || { status: 'new', contactName: '', contactEmail: '', notes: '', updatedAt: null };
}

/* ── Build sidebar dynamic filters ────────────────────────────────────────── */
function buildSidebarFilters() {
    // Funding stages
    const fundingCounts = {};
    allLeads.forEach(l => {
        if (l.funding_stage) fundingCounts[l.funding_stage] = (fundingCounts[l.funding_stage] || 0) + 1;
    });
    const fundingEl = document.getElementById('fundingFilters');
    Object.entries(fundingCounts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([stage, count]) => {
            const lbl = document.createElement('label');
            lbl.innerHTML = `<input type="checkbox" value="${stage}"> ${stage} <span style="margin-left:auto;color:var(--text-muted);font-size:0.75rem">${count}</span>`;
            lbl.querySelector('input').addEventListener('change', e => {
                if (e.target.checked) filters.funding.add(stage);
                else filters.funding.delete(stage);
                lbl.classList.toggle('active', e.target.checked);
                applyFilters();
            });
            fundingEl.appendChild(lbl);
        });

    // Top industries
    const indCounts = {};
    allLeads.forEach(l => (l.industries || []).forEach(i => {
        indCounts[i] = (indCounts[i] || 0) + 1;
    }));
    const topIndustries = Object.entries(indCounts).sort((a, b) => b[1] - a[1]).slice(0, 25);
    const indEl = document.getElementById('industryFilters');
    topIndustries.forEach(([ind, count]) => {
        const lbl = document.createElement('label');
        lbl.innerHTML = `<input type="checkbox" value="${ind}"> ${ind} <span style="margin-left:auto;color:var(--text-muted);font-size:0.75rem">${count}</span>`;
        lbl.querySelector('input').addEventListener('change', e => {
            if (e.target.checked) filters.industries.add(ind);
            else filters.industries.delete(ind);
            lbl.classList.toggle('active', e.target.checked);
            applyFilters();
        });
        indEl.appendChild(lbl);
    });
}

/* ── Filter + Sort ─────────────────────────────────────────────────────────── */
function applyFilters() {
    const q = filters.search.toLowerCase();

    filtered = allLeads.filter(lead => {
        const ld = getLeadData(lead.name);

        if (filters.status !== 'all' && ld.status !== filters.status) return false;
        if (filters.funding.size > 0 && !filters.funding.has(lead.funding_stage)) return false;

        if (filters.industries.size > 0) {
            const inds = new Set(lead.industries || []);
            if (![...filters.industries].some(i => inds.has(i))) return false;
        }

        if (q) {
            const hay = [
                lead.name,
                lead.location || '',
                (lead.industries || []).join(' '),
                lead.description || '',
                ld.contactName || '',
                ld.notes || '',
            ].join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
        }

        return true;
    });

    const STATUS_ORDER = { hot: 0, warm: 1, contacted: 2, new: 3, cold: 4, closed: 5 };
    filtered.sort((a, b) => {
        switch (filters.sort) {
            case 'rank_asc': return a.crunchbase_rank - b.crunchbase_rank;
            case 'rank_desc': return b.crunchbase_rank - a.crunchbase_rank;
            case 'name_asc': return a.name.localeCompare(b.name);
            case 'name_desc': return b.name.localeCompare(a.name);
            case 'status': {
                const sa = STATUS_ORDER[getLeadData(a.name).status] ?? 99;
                const sb = STATUS_ORDER[getLeadData(b.name).status] ?? 99;
                return sa !== sb ? sa - sb : a.crunchbase_rank - b.crunchbase_rank;
            }
            case 'recent': {
                const ta = getLeadData(a.name).updatedAt || 0;
                const tb = getLeadData(b.name).updatedAt || 0;
                return tb - ta;
            }
            default: return 0;
        }
    });

    page = 1;
    updateStats();
    renderLeads();
}

function updateStats() {
    document.getElementById('statTotal').textContent = allLeads.length.toLocaleString();
    document.getElementById('statShowing').textContent = filtered.length.toLocaleString();
    document.getElementById('statTracked').textContent =
        Object.values(userData).filter(d => d.status && d.status !== 'new').length.toLocaleString();
}

/* ── Render lead cards ─────────────────────────────────────────────────────── */
function renderLeads() {
    const container = document.getElementById('leadsContainer');
    const empty = document.getElementById('emptyState');
    const loadMore = document.getElementById('loadMore');
    container.innerHTML = '';

    if (filtered.length === 0) {
        empty.classList.remove('hidden');
        loadMore.classList.add('hidden');
        return;
    }
    empty.classList.add('hidden');

    const slice = filtered.slice(0, page * PAGE_SIZE);
    slice.forEach(lead => container.appendChild(buildCard(lead)));

    loadMore.classList.toggle('hidden', slice.length >= filtered.length);
}

function buildCard(lead) {
    const ld = getLeadData(lead.name);
    const status = ld.status || 'new';

    const card = document.createElement('div');
    card.className = `lead-card status-${status}`;
    card.dataset.name = lead.name;

    const topInds = (lead.industries || []).slice(0, 4);
    const extraInds = (lead.industries || []).length - topInds.length;

    card.innerHTML = `
    <div class="card-left">
      <div class="card-name">${escHtml(lead.name)}</div>
      <div class="card-meta">
        ${lead.location ? `📍 ${escHtml(lead.location)}` : ''}
        ${lead.funding_stage ? ` · <span style="color:var(--accent)">${escHtml(lead.funding_stage)}</span>` : ''}
      </div>
      ${lead.description ? `<div class="card-desc">${escHtml(lead.description)}</div>` : ''}
      <div class="card-tags">
        ${topInds.map(i => `<span class="tag">${escHtml(i)}</span>`).join('')}
        ${extraInds > 0 ? `<span class="tag">+${extraInds}</span>` : ''}
      </div>
    </div>
    <div class="card-right">
      <span class="rank-badge">#${lead.crunchbase_rank.toLocaleString()}</span>
      <span class="status-pill status-${status}">${statusLabel(status)}</span>
    </div>
  `;

    card.addEventListener('click', () => openPanel(lead.name));
    return card;
}

/* ── Detail Panel ──────────────────────────────────────────────────────────── */
function openPanel(name) {
    activeLeadId = name;
    const lead = allLeads.find(l => l.name === name);
    const ld = getLeadData(name);
    if (!lead) return;

    document.getElementById('dpName').textContent = lead.name;
    document.getElementById('dpLocation').textContent = lead.location || '';
    document.getElementById('dpRankBadge').textContent = `#${lead.crunchbase_rank.toLocaleString()}`;
    document.getElementById('dpDescription').textContent = lead.description || '';

    const tagList = document.getElementById('dpIndustries');
    tagList.innerHTML = (lead.industries || []).map(i => `<span class="tag">${escHtml(i)}</span>`).join('');

    const fundingEl = document.getElementById('dpFunding');
    if (lead.funding_stage) {
        fundingEl.textContent = lead.funding_stage;
        fundingEl.classList.remove('hidden');
    } else {
        fundingEl.classList.add('hidden');
    }

    document.getElementById('dpContactName').value = ld.contactName || '';
    document.getElementById('dpContactEmail').value = ld.contactEmail || '';
    document.getElementById('dpNotes').value = ld.notes || '';

    document.querySelectorAll('#statusPicker button').forEach(btn => {
        btn.classList.toggle('active-status', btn.dataset.status === (ld.status || 'new'));
    });

    const updEl = document.getElementById('dpUpdated');
    updEl.textContent = ld.updatedAt
        ? `Last updated: ${new Date(ld.updatedAt).toLocaleString()}`
        : '';

    document.getElementById('detailPanel').classList.remove('hidden');
    document.getElementById('overlay').classList.remove('hidden');
    document.getElementById('dpContactName').focus();
}

function closePanel() {
    document.getElementById('detailPanel').classList.add('hidden');
    document.getElementById('overlay').classList.add('hidden');
    activeLeadId = null;
}

function savePanel() {
    if (!activeLeadId) return;
    const existing = getLeadData(activeLeadId);
    const data = {
        status: existing.status || 'new',
        contactName: document.getElementById('dpContactName').value.trim(),
        contactEmail: document.getElementById('dpContactEmail').value.trim(),
        notes: document.getElementById('dpNotes').value.trim(),
        updatedAt: Date.now(),
    };

    persistLead(activeLeadId, data);

    document.getElementById('dpUpdated').textContent =
        `Last updated: ${new Date().toLocaleString()}`;

    // Update card in-place
    const card = document.querySelector(`.lead-card[data-name="${CSS.escape(activeLeadId)}"]`);
    if (card) {
        const status = data.status;
        card.className = `lead-card status-${status}`;
        card.querySelector('.status-pill').className = `status-pill status-${status}`;
        card.querySelector('.status-pill').textContent = statusLabel(status);
    }

    updateStats();

    const btn = document.getElementById('dpSave');
    btn.textContent = '✓ Saved';
    btn.style.background = 'var(--c-closed)';
    setTimeout(() => { btn.textContent = 'Save'; btn.style.background = ''; }, 1400);
}

/* ── Event Listeners ───────────────────────────────────────────────────────── */
function attachEventListeners() {
    // Search
    let debounceTimer;
    document.getElementById('searchInput').addEventListener('input', e => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            filters.search = e.target.value.trim();
            applyFilters();
        }, 220);
    });

    // Status radio chips
    document.querySelectorAll('.filter-chip input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', e => {
            filters.status = e.target.value;
            document.querySelectorAll('.filter-chip').forEach(c => {
                c.classList.toggle('active', c.querySelector('input').value === filters.status);
            });
            applyFilters();
        });
    });
    document.querySelector('.filter-chip input[value="all"]')
        .closest('.filter-chip').classList.add('active');

    // Sort
    document.getElementById('sortSelect').addEventListener('change', e => {
        filters.sort = e.target.value;
        applyFilters();
    });

    // Load more
    document.getElementById('loadMoreBtn').addEventListener('click', () => {
        page++;
        renderLeads();
    });

    // Panel status buttons
    document.querySelectorAll('#statusPicker button').forEach(btn => {
        btn.addEventListener('click', () => {
            const newStatus = btn.dataset.status;
            if (!activeLeadId) return;
            const ld = getLeadData(activeLeadId);
            const data = { ...ld, status: newStatus, updatedAt: Date.now() };
            persistLead(activeLeadId, data);

            document.querySelectorAll('#statusPicker button').forEach(b =>
                b.classList.toggle('active-status', b.dataset.status === newStatus));

            const card = document.querySelector(`.lead-card[data-name="${CSS.escape(activeLeadId)}"]`);
            if (card) {
                card.className = `lead-card status-${newStatus}`;
                card.querySelector('.status-pill').className = `status-pill status-${newStatus}`;
                card.querySelector('.status-pill').textContent = statusLabel(newStatus);
            }
            updateStats();
        });
    });

    document.getElementById('dpSave').addEventListener('click', savePanel);
    document.getElementById('closePanel').addEventListener('click', closePanel);
    document.getElementById('overlay').addEventListener('click', closePanel);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

    // Theme toggle
    const themeBtn = document.getElementById('themeToggle');
    const savedTheme = localStorage.getItem('maruf_leads_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    themeBtn.textContent = savedTheme === 'dark' ? '☀' : '☾';
    themeBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        themeBtn.textContent = next === 'dark' ? '☀' : '☾';
        localStorage.setItem('maruf_leads_theme', next);
    });

    // Export
    document.getElementById('exportBtn').addEventListener('click', () => {
        const tracked = allLeads
            .filter(l => userData[l.name])
            .map(l => ({ ...l, ...userData[l.name] }));
        const blob = new Blob(
            [JSON.stringify({ total: tracked.length, leads: tracked }, null, 2)],
            { type: 'application/json' }
        );
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), {
            href: url,
            download: `leads-export-${new Date().toISOString().slice(0, 10)}.json`,
        });
        a.click();
        URL.revokeObjectURL(url);
    });
}

/* ── Utilities ─────────────────────────────────────────────────────────────── */
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusLabel(status) {
    return {
        new: 'New', contacted: 'Contacted',
        hot: '🔥 Hot', warm: '🌤 Warm',
        cold: '🧊 Cold', closed: '✓ Closed',
    }[status] || status;
}