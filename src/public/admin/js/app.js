// State Management
const state = {
    playlists: [], // Legacy, keep for now or remove if safe (server serves empty list)
    recordings: [],
    settings: {},
    channels: [],
    currentOverrideChannel: null,
    metadataConfig: { api_key_configured: false, enabled: false },
    expandedChannelId: null,
    completedPhases: {}
};

// UI Elements Cache
const UI = {
    pages: {
        dashboard: document.getElementById('view-dashboard'),
        channels: document.getElementById('view-channels'),
        recordings: document.getElementById('view-recordings'),
        settings: document.getElementById('view-settings')    // Placeholder for future
    },
    overlay: document.getElementById('loadingOverlay'),
    statusPanel: document.getElementById('statusPanel'),
    loginOverlay: document.getElementById('login-overlay')
};

// --- AUTHENTICATION ---

const _originalFetch = window.fetch;
window.fetch = function (url, options = {}) {
    const token = sessionStorage.getItem('admin_token');
    if (token && typeof url === 'string' && url.startsWith('/api/')) {
        options.headers = options.headers || {};
        if (typeof options.headers === 'object' && !Array.isArray(options.headers)) {
            options.headers['Authorization'] = 'Bearer ' + token;
        }
    }
    return _originalFetch.call(window, url, options).then(res => {
        if (res.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/api/auth')) {
            sessionStorage.removeItem('admin_token');
            if (UI.loginOverlay) UI.loginOverlay.style.display = 'flex';
        }
        return res;
    });
};

async function attemptLogin() {
    const pw = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    try {
        const res = await _originalFetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
        });
        if (res.ok) {
            const data = await res.json();
            sessionStorage.setItem('admin_token', data.token);
            document.getElementById('login-overlay').style.display = 'none';
            errEl.style.display = 'none';
            init();
        } else {
            errEl.style.display = 'block';
            errEl.textContent = 'Invalid password';
        }
    } catch {
        errEl.textContent = 'Connection failed';
        errEl.style.display = 'block';
    }
}

function logout() {
    const token = sessionStorage.getItem('admin_token');
    if (token) {
        _originalFetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token }
        });
    }
    sessionStorage.removeItem('admin_token');
    window.location.reload();
}

// --- INITIALIZATION ---

// ... existing code ...

async function init() {
    console.log("Initializing Admin UI...");
    try {
        await loadRecordings();
        await loadPlaylists();   // populate playlist dropdown
        await loadConfig();      // then select the active one
        await loadMetadataConfig();
        await checkJobStatus();  // start SSE if job already running
        await loadMapping();     // load channels + update dashboard stats

        // Setup Event Listeners
        setupEventListeners();

        // Default View
        showView('dashboard');
    } catch (e) {
        console.error("Initialization failed:", e);
    }
}

// ... existing code ...

function getVisibleChannels() {
    const filterEl = document.getElementById('filterInput');
    const matchEl = document.getElementById('matchFilter');
    const statusEl = document.getElementById('statusFilter');
    const catEl = document.getElementById('categoryFilter');

    if (!filterEl || !matchEl || !statusEl || !catEl) {
        console.warn("One or more filter elements not found. Returning all channels (or empty).");
        return state.channels || [];
    }

    const filter = (filterEl.value || '').toLowerCase();
    const matchFilter = matchEl.value;
    const statusFilter = statusEl.value;
    const catFilter = catEl.value;

    return state.channels.filter(c => {
        const nameMatch = (c.name || '').toLowerCase().includes(filter);
        const catMatch = (c.group_title || '').toLowerCase().includes(filter);
        const searchMatch = nameMatch || catMatch;

        let matchStatusMatch = true;
        if (matchFilter === 'matched') matchStatusMatch = !!(c.matched_epg_id || c.override_epg_id);
        else if (matchFilter === 'unmatched') matchStatusMatch = !(c.matched_epg_id || c.override_epg_id);

        let enabledMatch = true;
        if (statusFilter === 'enabled') enabledMatch = c.enabled === 1;
        else if (statusFilter === 'disabled') enabledMatch = c.enabled === 0;

        let specificCatMatch = true;
        if (catFilter !== 'all') specificCatMatch = c.group_title === catFilter;

        return searchMatch && matchStatusMatch && enabledMatch && specificCatMatch;
    });
}

function setupEventListeners() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const view = e.currentTarget.dataset.view;
            if (view) showView(view);
        });
    });

    // Login
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) loginBtn.addEventListener('click', attemptLogin);

    const pwInput = document.getElementById('login-password');
    if (pwInput) pwInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') attemptLogin();
    });

    // Status Panel Toggle
    const statusHeader = document.querySelector('.status-header');
    if (statusHeader) statusHeader.addEventListener('click', () => toggleStatusPanel());
}

function showView(viewName) {
    // Hide all views
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));

    // Show selected
    const selected = document.getElementById(`view-${viewName}`);
    if (selected) selected.classList.remove('hidden');

    // Update Sidebar
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-view="${viewName}"]`);
    if (navItem) navItem.classList.add('active');

    // View specific logic
    if (viewName === 'channels') loadMapping();
}

// --- CONFIGURATION & DATA ---

async function loadConfig() {
    try {
        const config = await (await fetch('/api/config')).json();
        state.settings = config;

        // Populate settings inputs
        if (config.playlist_url) {
            const plSel = document.getElementById('playlistSelect');
            if (plSel) {
                // Select the active playlist in the dropdown
                plSel.value = config.playlist_url;
                // If the option doesn't exist yet, add it as a fallback
                if (plSel.value !== config.playlist_url) {
                    const opt = document.createElement('option');
                    opt.value = config.playlist_url;
                    opt.textContent = config.playlist_url;
                    plSel.appendChild(opt);
                    plSel.value = config.playlist_url;
                }
            }
        }
        if (config.preferred_lang) {
            const el = document.getElementById('prefLangInput');
            if (el) el.value = config.preferred_lang;
        }
        if (config.epg_days) {
            const el = document.getElementById('epgDaysInput');
            if (el) el.value = config.epg_days;
        }

        updateDashboardSummary(config);
    } catch (e) { console.error('Load config error:', e); }
}

function updateDashboardSummary(config) {
    const container = document.getElementById('configSummary');
    if (!container) return;

    const pl = state.playlists.find(p => (p.url || p.id) === config.playlist_url);
    const plName = pl ? pl.name : (config.playlist_url || 'None');

    container.innerHTML = `
        <div style="margin-bottom: 5px;"><strong>Playlist:</strong> ${config.playlist_url ? 'Configured' : 'None'}</div>
        <div style="margin-bottom: 5px;"><strong>Language:</strong> ${config.preferred_lang || 'Any'}</div>
        <div><strong>EPG Days:</strong> ${config.epg_days || 2}</div>
    `;

    // Update new dashboard stats
    setText('statTotalChannels', state.channels.length);
    setText('statMatchedChannels', state.channels.filter(c => c.matched_epg_id || c.override_epg_id).length);
    // setText('statPlaylistsCount', state.playlists.length); // Removed

    // Uptime (approximate)
    setText('statUptime', 'Active');
}

async function loadPlaylists() {
    try {
        const data = await (await fetch('/api/playlists')).json();
        state.playlists = data;

        // Populate the dropdown in the settings view
        const sel = document.getElementById('playlistSelect');
        if (sel) {
            const prevValue = sel.value;
            sel.innerHTML = '<option value="">-- Select Playlist --</option>';
            data.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.url;
                opt.textContent = p.name + (p.count ? ` (${p.count} ch)` : '') + (p.active ? ' ✓' : '');
                sel.appendChild(opt);
            });
            // Restore selection if still valid
            if (prevValue) sel.value = prevValue;
        }

        // Populate the playlists table (settings view)
        const tbody = document.getElementById('playlistsBody');
        if (tbody) {
            tbody.innerHTML = '';
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:var(--text-secondary)">No playlists configured. Add one below.</td></tr>';
            } else {
                data.forEach(p => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>
                            <div style="font-weight:500">${p.name || 'Unnamed'} ${p.active ? '<span class="badge badge-primary">Active</span>' : ''}</div>
                            <div style="font-size:0.8em; color:var(--text-secondary); max-width:400px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${p.url}">${p.url}</div>
                        </td>
                        <td>${p.count || 0}</td>
                        <td>
                            <button class="btn btn-secondary" style="color:var(--color-danger); padding:4px 8px; font-size:12px;" onclick="removePlaylist('${p.url}')">Remove</button>
                        </td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }
    } catch (e) { console.error('Load playlists failed:', e); }
}

async function saveConfig() {
    const playlistSel = document.getElementById('playlistSelect');
    const playlist_url = playlistSel ? playlistSel.value : '';
    const preferred_lang = document.getElementById('prefLangInput')?.value.trim() || null;
    const epg_days = document.getElementById('epgDaysInput')?.value;

    if (!playlist_url) { alert("Please select a playlist URL."); return; }

    showLoading("Saving Configuration...");

    try {
        await fetch('/api/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlist_url, preferred_lang, epg_days })
        });
        await loadConfig();
        // Flash success
        const btn = document.getElementById('saveConfigBtn');
        if (btn) {
            const original = btn.textContent;
            btn.textContent = '✓ Saved!';
            btn.style.background = 'var(--color-success)';
            setTimeout(() => { btn.textContent = original; btn.style.background = ''; }, 2000);
        }
    } catch (e) {
        alert("Error saving config: " + e.message);
    } finally {
        hideLoading();
    }
}

async function addPlaylist() {
    const input = document.getElementById('newPlaylistUrl');
    const url = input ? input.value.trim() : '';
    if (!url) { alert('Please enter a playlist URL.'); return; }

    showLoading('Adding playlist...');
    try {
        await fetch('/api/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlist_url: url })
        });
        if (input) input.value = '';
        await loadPlaylists();
        await loadConfig();
    } catch (e) {
        alert('Failed to add playlist: ' + e.message);
    } finally {
        hideLoading();
    }
}

async function removePlaylist(url) {
    if (!confirm('Remove this playlist?')) return;
    // Get current list and filter out the URL
    const current = state.playlists.map(p => p.url).filter(u => u !== url);
    showLoading('Removing playlist...');
    try {
        await fetch('/api/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlist_urls: current })
        });
        await loadPlaylists();
        await loadConfig();
    } catch (e) {
        alert('Failed to remove playlist: ' + e.message);
    } finally {
        hideLoading();
    }
}

// Reload playlist channels only — does NOT run matching/grab/enrich
async function syncPlaylist() {
    showLoading('Reloading playlist channels...');
    setActivityIndicator('active', 'Loading playlist...');
    startSse();
    try {
        const res = await (await fetch('/api/sync-playlist', { method: 'POST' })).json();
        if (res.success) {
            addLog(`Playlist reloaded: ${res.count} channels imported.`, 'success');
            await loadMapping();
            await loadConfig();
            // Flash the Reload button
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Reload Playlist'));
            if (btn) {
                const orig = btn.textContent;
                btn.textContent = '✓ Loaded!';
                setTimeout(() => { btn.textContent = orig; }, 2500);
            }
        } else {
            addLog(res.error || 'Playlist reload failed', 'error');
            alert('Reload failed: ' + (res.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Playlist reload failed: ' + e.message);
    } finally {
        hideLoading();
        setActivityIndicator('idle', 'Idle');
    }
}

// --- DVR MANAGEMENT ---

async function loadRecordings() {
    try {
        const data = await (await fetch('/api/recordings')).json();
        state.recordings = data;
        renderRecordingsTable(data);
    } catch (e) { console.error("Load recordings failed", e); }
}

function renderRecordingsTable(recordings) {
    const activeBody = document.getElementById('activeRecordingsBody');
    const historyBody = document.getElementById('historyRecordingsBody');
    if (!activeBody || !historyBody) return;

    activeBody.innerHTML = '';
    historyBody.innerHTML = '';

    const active = recordings.filter(r => ['scheduled', 'recording'].includes(r.status));
    const history = recordings.filter(r => !['scheduled', 'recording'].includes(r.status));

    // Active
    if (active.length === 0) {
        activeBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:15px; color:#666">No active or upcoming recordings.</td></tr>';
    } else {
        active.forEach(r => {
            const tr = document.createElement('tr');
            const isRecording = r.status === 'recording';
            tr.innerHTML = `
                <td>
                    <div style="font-weight:500">${r.program_title}</div>
                    <div style="font-size:0.8em; color:var(--text-secondary)">${r.channel_name || 'Channel ' + r.channel_id}</div>
                </td>
                <td>${r.channel_name || r.channel_id}</td>
                <td>
                    ${new Date(r.start_time).toLocaleString()}
                    <div style="font-size:0.8em; color:var(--text-secondary)">${(new Date(r.end_time) - new Date(r.start_time)) / 60000} mins</div>
                </td>
                <td>
                    <span class="badge ${isRecording ? 'badge-danger' : 'badge-primary'}">${r.status.toUpperCase()}</span>
                </td>
                <td>
                    ${isRecording ?
                    `<button class="btn btn-secondary" style="color:var(--color-danger)" onclick="stopRecording(${r.id})">Stop</button>` :
                    `<button class="btn btn-secondary" style="color:var(--color-danger)" onclick="deleteRecording(${r.id})">Cancel</button>`
                }
                </td>
            `;
            activeBody.appendChild(tr);
        });
    }

    // History
    if (history.length === 0) {
        historyBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:15px; color:#666">No history.</td></tr>';
    } else {
        history.forEach(r => {
            const tr = document.createElement('tr');
            const isError = r.status === 'failed';
            const size = r.file_size ? (r.file_size / 1024 / 1024).toFixed(1) + ' MB' : '-';
            tr.innerHTML = `
                <td>
                    <div style="font-weight:500">${r.program_title}</div>
                    ${r.error_message ? `<div style="font-size:0.8em; color:var(--color-danger)">${r.error_message}</div>` : ''}
                </td>
                <td>${new Date(r.start_time).toLocaleDateString()}</td>
                <td>${(new Date(r.end_time) - new Date(r.start_time)) / 60000}m</td>
                <td>
                     <span class="badge ${isError ? 'badge-danger' : 'badge-success'}">${r.status}</span>
                </td>
                <td>
                    ${r.filename ? `<a href="/files/recordings/${r.filename}" target="_blank" style="color:var(--color-primary)">Download (${size})</a>` : '-'}
                </td>
            `;
            historyBody.appendChild(tr);
        });
    }
}

function showScheduleModal() {
    const modal = document.getElementById('scheduleModal');
    if (modal) {
        modal.classList.add('visible');
        modal.style.display = 'flex';

        // Populate channels
        const sel = document.getElementById('recChannelSelect');
        sel.innerHTML = '<option value="">Select Channel...</option>';
        state.channels
            .filter(c => c.enabled)
            .sort((a, b) => (a.channel_number || 9999) - (b.channel_number || 9999))
            .forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = `${c.channel_number ? c.channel_number + '. ' : ''}${c.name}`;
                // Store url in dataset if needed, but we'll fetch from state
                sel.appendChild(opt);
            });

        // Set defaults
        document.getElementById('recStartTime').value = new Date().toISOString().slice(0, 16);
        // Default 1 hour
        const end = new Date(Date.now() + 60 * 60 * 1000);
        document.getElementById('recEndTime').value = end.toISOString().slice(0, 16);
    }
}

function closeScheduleModal() {
    const modal = document.getElementById('scheduleModal');
    if (modal) {
        modal.classList.remove('visible');
        modal.style.display = 'none';
    }
}

async function submitSchedule() {
    const channelId = document.getElementById('recChannelSelect').value;
    const title = document.getElementById('recTitleInput').value.trim();
    const start = document.getElementById('recStartTime').value;
    const end = document.getElementById('recEndTime').value;

    if (!channelId || !title || !start || !end) {
        alert("All fields are required.");
        return;
    }

    const channel = state.channels.find(c => c.id === channelId);
    if (!channel || !channel.url) {
        alert("Invalid channel or no stream URL.");
        return;
    }

    showLoading("Scheduling...");
    try {
        await fetch('/api/dvr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channel_id: channelId,
                program_title: title,
                start_time: new Date(start).toISOString(),
                end_time: new Date(end).toISOString(),
                stream_url: channel.url
            })
        });
        closeScheduleModal();
        await loadRecordings();
        alert("Recording scheduled!");
    } catch (e) {
        alert("Failed to schedule: " + e.message);
    } finally {
        hideLoading();
    }
}

async function stopRecording(id) {
    if (!confirm("Stop this recording immediately?")) return;
    try {
        await fetch(`/api/dvr/stop/${id}`, { method: 'POST' });
        await loadRecordings();
    } catch (e) { alert(e.message); }
}

async function deleteRecording(id) {
    if (!confirm("Delete this schedule?")) return;
    try {
        await fetch(`/api/dvr/${id}`, { method: 'DELETE' });
        await loadRecordings();
    } catch (e) { alert(e.message); }
}

// --- OPERATIONS (Grab, Rebuild, Metadata) ---

async function startProcessing() {
    // Show & reset Status Panel
    const panel = document.getElementById('statusPanel');
    if (panel) { panel.classList.remove('hidden'); panel.classList.add('expanded'); }

    updateProgressBar('match', 0, 'Waiting...');
    updateProgressBar('grab', 0, 'Waiting...');
    updateProgressBar('enrich', 0, 'Waiting...');

    state.completedPhases = {};
    setActivityIndicator('active', 'Starting full pipeline...');
    addLog('Starting pipeline: Playlist → Match → Grab → Enrich → Rebuild', 'info');
    startSse();

    try {
        const res = await (await fetch('/api/sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        })).json();
        if (!res.success) {
            addLog(res.message || 'Sync could not start', 'warning');
        }
    } catch (e) { console.error(e); }
}

async function rebuildFiles() {
    if (!confirm('Rebuild M3U/XML from database?')) return;
    showLoading('Regenerating Files...');
    try {
        const res = await (await fetch('/api/rebuild-files', { method: 'POST' })).json();
        if (res.success) {
            alert(`Files rebuilt! ${res.stats?.playlistCount || 0} channels exported.`);
        }
    } catch (e) { alert('Rebuild failed: ' + e.message); }
    finally { hideLoading(); }
}

async function grabMissing() {
    showLoading('Starting EPG grab for unmatched channels...');
    setActivityIndicator('active', 'Grabbing EPG data...');
    startSse();
    try {
        const res = await (await fetch('/api/grab', { method: 'POST' })).json();
        if (res.success) {
            addLog(`EPG grab started for ${res.count || 0} channels`, 'info');
        }
    } catch (e) { alert('Grab failed: ' + e.message); }
    finally { hideLoading(); }
}

async function triggerManualEnrich() {
    showLoading('Starting metadata enrichment...');
    setActivityIndicator('active', 'Enriching metadata...');
    startSse();
    try {
        const res = await (await fetch('/api/metadata/enrich', { method: 'POST' })).json();
        addLog(res.message || 'Enrichment started', 'info');
    } catch (e) { alert('Enrichment failed: ' + e.message); }
    finally { hideLoading(); }
}

async function refreshImdbData() {
    if (!confirm('Refresh IMDb dataset? This downloads a large file.')) return;
    showLoading('Refreshing IMDb data...');
    setActivityIndicator('active', 'Downloading IMDb data...');
    startSse();
    try {
        const res = await (await fetch('/api/metadata/refresh-data', { method: 'POST' })).json();
        addLog(res.message || 'IMDb refresh started', 'info');
    } catch (e) { alert('IMDb refresh failed: ' + e.message); }
    finally { hideLoading(); }
}

async function clearMetadataCache() {
    if (!confirm('Clear all cached metadata? This cannot be undone.')) return;
    showLoading('Clearing metadata cache...');
    try {
        await fetch('/api/metadata/clear-cache', { method: 'POST' });
        alert('Metadata cache cleared.');
        await updateMetadataStats();
    } catch (e) { alert('Clear failed: ' + e.message); }
    finally { hideLoading(); }
}

// --- METADATA ---

async function loadMetadataConfig() {
    try {
        const config = await (await fetch('/api/metadata/config')).json();
        state.metadataConfig = config;

        const cb = document.getElementById('metadataEnabled');
        if (cb) cb.checked = config.enabled;

        toggleMetadataUI(config.enabled);

        if (config.enabled) updateMetadataStats();
    } catch (e) { console.error(e); }
}

function toggleMetadataUI(enabled) {
    const section = document.getElementById('metadataConfigSection');
    if (section) section.style.display = enabled ? 'block' : 'none';
}

async function saveMetadataConfig() {
    const enabled = document.getElementById('metadataEnabled').checked;
    await fetch('/api/metadata/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
    });
    toggleMetadataUI(enabled);
    if (enabled) updateMetadataStats();
}

async function updateMetadataStats() {
    const stats = await (await fetch('/api/metadata/stats')).json();
    setText('statImdbDataAge', stats.imdbDataAge || 'None');
    setText('statCachedShows', stats.cachedShows);
    setText('statEnrichedPrograms', stats.enrichedPrograms);
}

// --- CHANNEL MAPPING ---

async function loadMapping() {
    try {
        const res = await (await fetch('/api/channels-with-programs')).json();
        if (Array.isArray(res)) {
            state.channels = res;
        } else {
            console.error("Failed to load mapping. Server returned:", res);
            state.channels = [];
        }
        updateCategoryFilter();
        renderMappingTable();
    } catch (e) {
        console.error("Load mapping failed", e);
        state.channels = [];
        updateCategoryFilter();
        renderMappingTable();
    }
}

function updateCategoryFilter() {
    const categories = [...new Set(state.channels.map(c => c.group_title))].filter(Boolean).sort();
    const select = document.getElementById('categoryFilter');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="all">All Categories</option>';
    categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        select.appendChild(opt);
    });
    if (categories.includes(current)) select.value = current;
}

function getVisibleChannels() {
    const filter = (document.getElementById('filterInput').value || '').toLowerCase();
    const matchFilter = document.getElementById('matchFilter').value;
    const statusFilter = document.getElementById('statusFilter').value;
    const catFilter = document.getElementById('categoryFilter').value;

    return state.channels.filter(c => {
        const nameMatch = (c.name || '').toLowerCase().includes(filter);
        const catMatch = (c.group_title || '').toLowerCase().includes(filter);
        const searchMatch = nameMatch || catMatch;

        let matchStatusMatch = true;
        if (matchFilter === 'matched') matchStatusMatch = !!(c.matched_epg_id || c.override_epg_id);
        else if (matchFilter === 'unmatched') matchStatusMatch = !(c.matched_epg_id || c.override_epg_id);

        let enabledMatch = true;
        if (statusFilter === 'enabled') enabledMatch = c.enabled === 1;
        else if (statusFilter === 'disabled') enabledMatch = c.enabled === 0;

        let specificCatMatch = true;
        if (catFilter !== 'all') specificCatMatch = c.group_title === catFilter;

        return searchMatch && matchStatusMatch && enabledMatch && specificCatMatch;
    });
}

// ... existing code ...

// --- GRAB HISTORY & LOGS ---

async function showGrabHistory() {
    const modal = document.getElementById('historyModal');
    const tbody = document.getElementById('historyBody');
    if (!modal || !tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading history...</td></tr>';
    modal.classList.add('visible');
    modal.style.display = 'flex'; // Ensure flex display

    try {
        const logs = await (await fetch('/api/grab-logs')).json();
        tbody.innerHTML = '';
        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No grab history found.</td></tr>';
            return;
        }
        logs.forEach(log => {
            const date = new Date(log.timestamp).toLocaleString();
            const statusClass = log.success ? 'log-success' : 'log-error';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${date}</td>
                <td><strong>${log.xmltv_id}</strong></td>
                <td>${log.site}</td>
                <td class="${statusClass}">${log.success ? 'Success' : 'Failed'}</td>
                <td>${log.program_count || 0}</td>
                <td>${(log.duration_ms / 1000).toFixed(1)}s</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:red;">Failed to load history.</td></tr>';
    }
}

function closeHistory() {
    const modal = document.getElementById('historyModal');
    if (modal) {
        modal.classList.remove('visible');
        modal.style.display = 'none';
    }
}

function clearLogs() {
    const container = document.getElementById('logContainer');
    if (container) container.innerHTML = '';
}

// --- BULK OPERATIONS ---

async function bulkAction(enable) {
    const visibleIds = getVisibleChannels().map(c => c.id);
    if (visibleIds.length === 0) return;

    if (!confirm(`${enable ? 'Enable' : 'Disable'} ${visibleIds.length} visible channels?`)) return;

    try {
        await fetch('/api/channels/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: visibleIds, enabled: enable })
        });

        // Update local state and UI
        state.channels.forEach(c => {
            if (visibleIds.includes(c.id)) c.enabled = enable ? 1 : 0;
        });
        renderMappingTable();
    } catch (e) { alert("Bulk action failed: " + e.message); }
}

function toggleAllVisible(checked) {
    bulkAction(checked); // Optional: Trigger bulk action immediately or just select checkboxes (simpler to just trigger)
    // Alternatively, just select the checkboxes in UI:
    // document.querySelectorAll('#mappingBody input[type="checkbox"]').forEach(cb => cb.checked = checked);
}

// --- UTILS ---

function copyUrl(path) {
    const url = window.location.origin + path;
    navigator.clipboard.writeText(url).then(() => {
        alert('Copied: ' + url);
    }).catch(err => {
        alert('Failed to copy: ' + err);
    });
}

// Update renderMappingTable to include Grab Status and Program Details
function renderMappingTable() {
    const tbody = document.getElementById('mappingBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const rows = getVisibleChannels();
    setText('statVisibleCount', rows.length);
    setText('statMatchedCount', rows.filter(c => c.matched_epg_id || c.override_epg_id).length);

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px;">No channels found.</td></tr>';
        return;
    }

    rows.slice(0, 500).forEach(c => {
        const tr = document.createElement('tr');
        tr.id = `row-${c.id}`;
        if (c.enabled === 0) tr.style.opacity = '0.5';

        // Match Logic
        let badgeClass = 'badge-danger';
        let confText = 'Unmatched';
        let matchId = c.matched_epg_id;

        if (c.is_overridden) {
            badgeClass = 'badge-success';
            confText = 'Override';
            matchId = c.override_epg_id;
        } else if (matchId) {
            if (c.match_type === 'Exact ID Match' || c.match_type === 'Exact Name Match') {
                badgeClass = 'badge-success';
                confText = 'Exact';
            } else if (c.match_type && c.match_type.includes('Fuzzy')) {
                badgeClass = 'badge-warning';
                confText = 'Fuzzy';
            } else {
                badgeClass = 'badge-warning';
                confText = 'Match';
            }
        }

        // Grab Status
        const grab = c.last_grab;
        let grabHtml = '<span style="color:var(--text-secondary); font-size:0.8em;">No Data</span>';
        if (grab) {
            const color = grab.success ? 'var(--color-success)' : 'var(--color-danger)';
            const icon = grab.success ? '✓' : '✗';
            const timeStr = new Date(grab.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            grabHtml = `<div style="color:${color}; font-size:11px;" title="${grab.message || ''}">
                <strong>${icon}</strong> ${timeStr}
            </div>`;
        }

        tr.innerHTML = `
            <td><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="toggleChannel('${c.id}', this.checked)"></td>
            <td>
                <img src="${c.tvg_logo || ''}" style="width:24px; height:24px; object-fit:contain; background:#333; border-radius:4px;" onerror="this.style.display='none'">
                <span style="margin-left:8px; font-weight:500;">${c.name}</span>
                <div style="font-size:0.8em; color:var(--text-secondary); margin-left:36px;">${c.group_title || 'Uncategorized'}</div>
            </td>
            <td>
                ${c.current_program_title ? `
                    <div>
                        <div style="font-weight:500;">${c.current_program_title}</div>
                        ${c.current_program_subtitle ? `<div style="font-size:0.8em; color:var(--text-secondary);">${c.current_program_subtitle}</div>` : ''}
                    </div>
                ` : '<span style="color:var(--text-secondary)">No Info</span>'}
            </td>
            <td>${grabHtml}</td>
            <td onclick="toggleExpand('${c.id}')" style="cursor:pointer;">
                <span class="badge ${badgeClass}">${confText}</span>
                <div style="font-size:0.75em; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100px;">${matchId || '-'}</div>
            </td>
            <td>
                <button class="btn btn-secondary" onclick="toggleExpand('${c.id}')" style="padding:4px 8px; font-size:12px;">Edit</button>
            </td>
        `;
        tbody.appendChild(tr);

        if (state.expandedChannelId === c.id) {
            renderExpandedRow(c.id);
        }
    });

    if (rows.length > 500) {
        const more = document.createElement('tr');
        more.innerHTML = `<td colspan="7" style="text-align:center; color:var(--text-secondary); padding:10px;">Showing first 500 channels. Filter to see more.</td>`;
        tbody.appendChild(more);
    }
}

// ... rest of code ...

async function toggleChannel(id, enabled) {
    await fetch('/api/channels/toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], enabled })
    });
    const c = state.channels.find(x => x.id === id);
    if (c) c.enabled = enabled ? 1 : 0;
}

async function saveChannelSettings(channelId) {
    const name = document.getElementById(`edit-chan-name-${channelId}`)?.value;
    const url = document.getElementById(`edit-chan-url-${channelId}`)?.value;
    const channel_number = document.getElementById(`edit-chan-number-${channelId}`)?.value;
    const tvg_id = document.getElementById(`edit-chan-tvgid-${channelId}`)?.value;
    const group_title = document.getElementById(`edit-chan-group-${channelId}`)?.value;
    const tvg_logo = document.getElementById(`edit-chan-logo-${channelId}`)?.value;

    const statusEl = document.getElementById(`save-status-${channelId}`);
    if (statusEl) {
        statusEl.textContent = 'Saving...';
        statusEl.style.color = 'var(--text-secondary)';
    }

    try {
        const res = await fetch(`/api/channels/${channelId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                url,
                channel_number: channel_number ? parseInt(channel_number) : null,
                tvg_id: tvg_id || null,
                group_title: group_title || null,
                tvg_logo: tvg_logo || null
            })
        });

        if (!res.ok) throw new Error('Failed to save');

        // Update local state
        const channel = state.channels.find(c => c.id === channelId);
        if (channel) {
            channel.name = name;
            channel.url = url;
            channel.channel_number = channel_number ? parseInt(channel_number) : null;
            channel.tvg_id = tvg_id;
            channel.group_title = group_title;
            channel.tvg_logo = tvg_logo;
        }

        // Re-render the table to show updated values
        renderMappingTable();

        // Re-expand the same channel
        state.expandedChannelId = channelId;
        setTimeout(() => renderExpandedRow(channelId), 50);

        if (statusEl) {
            statusEl.textContent = 'Saved!';
            statusEl.style.color = 'var(--color-success)';
            setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
        }
    } catch (e) {
        console.error('Failed to save channel:', e);
        if (statusEl) {
            statusEl.textContent = 'Error: ' + e.message;
            statusEl.style.color = 'var(--color-danger)';
        }
    }
}

// --- EXPANDED ROW ---
function toggleExpand(channelId) {
    const existing = document.getElementById('expanded-row-container');

    if (state.expandedChannelId === channelId) {
        if (existing) existing.remove();
        state.expandedChannelId = null;
        return;
    }

    if (existing) existing.remove();
    state.expandedChannelId = channelId;
    renderExpandedRow(channelId);
}

function renderExpandedRow(channelId) {
    const row = document.getElementById(`row-${channelId}`);
    if (!row) return;

    const channel = state.channels.find(c => c.id === channelId);
    if (!channel) return;

    const expandedTr = document.createElement('tr');
    expandedTr.id = 'expanded-row-container';
    expandedTr.className = 'expanded-row';

    expandedTr.innerHTML = `
        <td colspan="6" style="padding:20px;">
            <div style="display: flex; gap: 20px;">
                <div style="flex: 1;">
                    <h4 style="margin-bottom:10px;">Channel Settings</h4>
                    
                    <div style="display:flex; gap:10px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:10px; margin-bottom:15px;">
                        <button class="btn btn-secondary" id="tab-chan-${channelId}" onclick="switchExplainTab('${channelId}', 'chan')" style="background:rgba(255,255,255,0.1)">Channel</button>
                        <button class="btn btn-secondary" id="tab-epg-${channelId}" onclick="switchExplainTab('${channelId}', 'epg')">EPG Map</button>
                        <button class="btn btn-secondary" id="tab-meta-${channelId}" onclick="switchExplainTab('${channelId}', 'meta')">Metadata</button>
                    </div>

                    <!-- CHANNEL TAB -->
                    <div id="content-chan-${channelId}">
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
                            <div>
                                <label style="display:block; font-size:0.8em; color:var(--text-secondary); margin-bottom:5px;">Channel Name</label>
                                <input type="text" id="edit-chan-name-${channelId}" class="themed-input w-full" value="${(channel.name || '').replace(/"/g, '&quot;')}">
                            </div>
                            <div>
                                <label style="display:block; font-size:0.8em; color:var(--text-secondary); margin-bottom:5px;">Channel Number</label>
                                <input type="number" id="edit-chan-number-${channelId}" class="themed-input w-full" value="${channel.channel_number || ''}">
                            </div>
                            <div style="grid-column: 1 / -1;">
                                <label style="display:block; font-size:0.8em; color:var(--text-secondary); margin-bottom:5px;">Stream URL</label>
                                <input type="text" id="edit-chan-url-${channelId}" class="themed-input w-full" value="${(channel.url || '').replace(/"/g, '&quot;')}">
                            </div>
                            <div>
                                <label style="display:block; font-size:0.8em; color:var(--text-secondary); margin-bottom:5px;">TVG ID</label>
                                <input type="text" id="edit-chan-tvgid-${channelId}" class="themed-input w-full" value="${(channel.tvg_id || '').replace(/"/g, '&quot;')}">
                            </div>
                            <div>
                                <label style="display:block; font-size:0.8em; color:var(--text-secondary); margin-bottom:5px;">Category</label>
                                <input type="text" id="edit-chan-group-${channelId}" class="themed-input w-full" value="${(channel.group_title || '').replace(/"/g, '&quot;')}">
                            </div>
                            <div>
                                <label style="display:block; font-size:0.8em; color:var(--text-secondary); margin-bottom:5px;">Logo URL</label>
                                <input type="text" id="edit-chan-logo-${channelId}" class="themed-input w-full" value="${(channel.tvg_logo || '').replace(/"/g, '&quot;')}">
                            </div>
                        </div>
                        <div style="margin-top:15px; display:flex; gap:10px; align-items:center;">
                            <button class="btn btn-primary" onclick="saveChannelSettings('${channelId}')">Save Changes</button>
                            <span id="save-status-${channelId}" style="font-size:0.85em; color:var(--color-success);"></span>
                        </div>
                    </div>

                    <!-- EPG TAB -->
                    <div id="content-epg-${channelId}" style="display:none;">
                        <input type="text" placeholder="Search EPG..." onkeyup="searchEpg(this.value)" style="width:100%; margin-bottom:10px;">
                        <div id="searchResults" class="search-results"></div>
                        <div style="margin-top:10px; font-size:0.8em; color:var(--text-secondary)">
                            Select a channel above to force an EPG mapping.
                        </div>
                    </div>

                    <!-- METADATA TAB -->
                    <div id="content-meta-${channelId}" style="display:none;">
                         <input type="text" placeholder="Search Series (TVMaze)..." onkeyup="searchTVMazeUI(this.value, '${channelId}')" style="width:100%; margin-bottom:10px;">
                         <div id="metaSearchResults-${channelId}" class="tvmaze-results"></div>
                    </div>

                </div>
                <div style="width: 250px; background: rgba(0,0,0,0.2); padding:15px; border-radius:8px; align-self:flex-start;">
                     <div style="font-size:0.8em; text-transform:uppercase; color:var(--text-secondary)">Current EPG Match</div>
                     <div style="font-weight:bold; color:var(--color-primary); margin:5px 0 15px;">
                        ${channel.override_epg_id || channel.matched_epg_id || 'None'}
                     </div>
                     <button class="btn btn-secondary" style="width:100%; color:var(--color-danger); margin-bottom:15px;" onclick="clearOverride('${channelId}')">Clear EPG Match</button>
                      
                      <hr style="border:0; border-top:1px solid rgba(255,255,255,0.1); margin:10px 0;">
                      
                      <div style="font-size:0.8em; text-transform:uppercase; color:var(--text-secondary)">Metadata Override</div>
                       <div style="font-weight:bold; color:var(--color-success); margin:5px 0 15px;">
                         ${state.metadataOverrides?.[channel.current_program_title] || 'Auto'}
                      </div>
                </div>
            </div>
        </td>
    `;

    row.parentNode.insertBefore(expandedTr, row.nextSibling);
}

function switchExplainTab(id, tab) {
    const chanContent = document.getElementById(`content-chan-${id}`);
    const epgContent = document.getElementById(`content-epg-${id}`);
    const metaContent = document.getElementById(`content-meta-${id}`);
    if (chanContent) chanContent.style.display = tab === 'chan' ? 'block' : 'none';
    if (epgContent) epgContent.style.display = tab === 'epg' ? 'block' : 'none';
    if (metaContent) metaContent.style.display = tab === 'meta' ? 'block' : 'none';

    const chanTab = document.getElementById(`tab-chan-${id}`);
    const epgTab = document.getElementById(`tab-epg-${id}`);
    const metaTab = document.getElementById(`tab-meta-${id}`);
    if (chanTab) chanTab.style.background = tab === 'chan' ? 'rgba(255,255,255,0.1)' : '';
    if (epgTab) epgTab.style.background = tab === 'epg' ? 'rgba(255,255,255,0.1)' : '';
    if (metaTab) metaTab.style.background = tab === 'meta' ? 'rgba(255,255,255,0.1)' : '';
}

let searchTimeout;
function searchEpg(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        const div = document.getElementById('searchResults');
        if (!div) return;

        if (query.length < 2) {
            div.innerHTML = '<div style="padding:10px; text-align:center; color:#666">Type to search...</div>';
            return;
        }

        div.innerHTML = '<div style="padding:10px; text-align:center;">Searching...</div>';

        try {
            const res = await (await fetch(`/api/search-epg?q=${encodeURIComponent(query)}`)).json();
            div.innerHTML = '';
            if (res.length === 0) {
                div.innerHTML = '<div style="padding:10px; text-align:center;">No results.</div>';
                return;
            }
            res.forEach(r => {
                const item = document.createElement('div');
                item.className = 'search-item';
                item.innerHTML = `<div>${r.display_name}</div><div style="font-size:0.8em; color:var(--text-secondary)">${r.id}</div>`;
                item.onclick = () => setOverride(state.expandedChannelId, r.id);
                div.appendChild(item);
            });
        } catch (e) {
            div.innerHTML = '<div style="padding:10px; text-align:center; color:var(--color-danger)">Error</div>';
        }
    }, 300);
}

let metaSearchTimeout;
function searchTVMazeUI(query, channelId) {
    clearTimeout(metaSearchTimeout);
    metaSearchTimeout = setTimeout(async () => {
        const div = document.getElementById(`metaSearchResults-${channelId}`);
        if (!div) return;

        if (query.length < 2) {
            div.innerHTML = '<div style="padding:10px; text-align:center; grid-column:1/-1;">Type to search...</div>';
            return;
        }

        div.innerHTML = '<div style="padding:10px; text-align:center; grid-column:1/-1;">Searching...</div>';

        try {
            const res = await (await fetch('/api/metadata/search-tvmaze', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            })).json();

            div.innerHTML = '';
            if (res.length === 0) {
                div.innerHTML = '<div style="padding:10px; text-align:center; grid-column:1/-1;">No results.</div>';
                return;
            }

            res.forEach(show => {
                const item = document.createElement('div');
                item.className = 'tvmaze-item';
                item.innerHTML = `
                    <div style="pointer-events:none;">
                    <img src="${show.image?.medium || ''}" onerror="this.style.display='none'">
                    <div class="title">${show.name}</div>
                    <div class="year">${show.premiered ? show.premiered.slice(0, 4) : ''}</div>
                    </div>
                `;
                item.onclick = () => saveMetadataOverride(channelId, show);
                div.appendChild(item);
            });

        } catch (e) {
            div.innerHTML = '<div style="padding:10px; text-align:center; grid-column:1/-1; color:var(--color-danger)">Error</div>';
        }
    }, 500);
}

async function saveMetadataOverride(channelId, show) {
    // We need the program title to override metadata FOR that title
    const channel = state.channels.find(c => c.id === channelId);
    if (!channel || !channel.current_program_title) {
        alert("No current program title to attach metadata to.");
        return;
    }

    if (!confirm(`Map "${channel.current_program_title}" to "${show.name}"?`)) return;

    try {
        await fetch('/api/metadata/override', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: channel.current_program_title,
                tvmaze_id: show.id,
                show_name: show.name,
                genres: show.genres?.join(', ') || '',
                rating: show.rating?.average ? String(show.rating.average) : null
            })
        });
        alert("Metadata override saved! It will be applied on next enrichment cycle.");
        toggleExpand(channelId); // Close
    } catch (e) {
        alert("Failed to save override: " + e.message);
    }
}

async function setOverride(channelId, epgId) {
    await fetch('/api/override', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId, epg_id: epgId })
    });
    // Reload mapping to reflect changes
    await loadMapping();
    state.expandedChannelId = null; // Close expand
}

async function clearOverride(channelId) {
    await setOverride(channelId, null);
}

// --- SSE & STATUS ---

// Phase display names for the sidebar
const PHASE_LABELS = { match: 'Matching', grab: 'Grabbing EPG', enrich: 'Enriching' };

function setActivityIndicator(state, message) {
    const dot = document.getElementById('activityDot');
    const text = document.getElementById('activityText');
    const phaseTracker = document.getElementById('phaseTracker');

    if (dot) {
        dot.className = 'activity-dot ' + (state === 'active' ? 'activity-dot--active' : '');
    }
    if (text) text.textContent = message || (state === 'active' ? 'Processing...' : 'Idle');
    if (phaseTracker) phaseTracker.classList.toggle('hidden', state !== 'active');
}

function setActivePhase(phase) {
    // We now have concurrent states, so we don't hide or "complete" previous phases
    // We just ensure the requested phase has 'active' indicators if you still use phase-steps anywhere
    document.querySelectorAll('.phase-step').forEach(el => {
        if (el.dataset.phase === phase) {
            el.classList.add('phase-step--active');
            el.classList.remove('phase-step--done');
        }
    });
}

function startSse() {
    if (window.evtSource) window.evtSource.close();
    window.evtSource = new EventSource('/api/progress');

    window.evtSource.addEventListener('progress', e => {
        const p = JSON.parse(e.data);
        const pct = p.total > 0 ? (p.current / p.total) * 100 : 0;
        updateProgressBar(p.phase || 'grab', pct, p.message);

        // Also update the global activity indicator to the most recent message
        setActivityIndicator('active', p.message.slice(0, 60));
        setActivePhase(p.phase);

        // Show status panel when busy
        const panel = document.getElementById('statusPanel');
        if (panel) { panel.classList.remove('hidden'); }
    });

    window.evtSource.addEventListener('log', e => {
        const log = JSON.parse(e.data);
        addLog(log.message, log.type);
        // Update sidebar text on log events too
        if (log.type !== 'info' || !document.getElementById('activityDot')?.classList.contains('activity-dot--active')) return;
        setActivityIndicator('active', log.message.slice(0, 60));
    });

    window.evtSource.addEventListener('report', e => {
        // Job complete
        setActivityIndicator('idle', 'Last sync complete');
        document.querySelectorAll('.phase-step').forEach(el => el.classList.add('phase-step--done'));
        addLog('Sync complete!', 'success');
        // Refresh data
        loadMapping();
        updateMetadataStats();
    });
}

function updateProgressBar(phase, pct, msg) {
    const bar = document.getElementById(`${phase}Bar`);
    const text = document.getElementById(`${phase}Text`);
    if (bar) bar.style.width = `${Math.min(pct, 100)}%`;
    if (text) text.innerText = msg;
}

function addLog(msg, type) {
    const container = document.getElementById('logContainer');
    if (container) {
        const div = document.createElement('div');
        div.className = `log-entry log-${type || 'info'}`;
        div.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
}

function toggleStatusPanel() {
    const logs = document.getElementById('logContainer');
    if (logs) logs.classList.toggle('hidden');

    const toggleBtn = document.querySelector('.status-header span:nth-child(2)');
    if (toggleBtn) {
        toggleBtn.innerText = logs && logs.classList.contains('hidden') ? '▼ Show Logs' : '▲ Hide Logs';
    }
}

async function checkJobStatus() {
    try {
        const status = await (await fetch('/api/job-status')).json();
        if (status.running) {
            setActivityIndicator('active', 'Processing...');

            // Rehydrate the progress bars from the current job status record map
            if (status.progress) {
                Object.values(status.progress).forEach(p => {
                    const pct = p.total > 0 ? (p.current / p.total) * 100 : 0;
                    updateProgressBar(p.phase, pct, p.message);
                    setActivePhase(p.phase);
                });
            }

            startSse();
            // Show status panel
            const panel = document.getElementById('statusPanel');
            if (panel) { panel.classList.remove('hidden'); panel.classList.add('expanded'); }
        } else {
            setActivityIndicator('idle', 'Idle');
        }
    } catch (e) { console.error('Job status check failed:', e); }
}

// --- UTILS ---

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function showLoading(msg) {
    const ol = document.getElementById('loadingOverlay');
    const txt = document.getElementById('loadingText');
    if (ol) ol.classList.remove('hidden');
    if (txt) txt.innerText = msg;
}

function hideLoading() {
    const ol = document.getElementById('loadingOverlay');
    if (ol) ol.classList.add('hidden');
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();

    // Check auth token on load
    if (sessionStorage.getItem('admin_token')) {
        init();
    } else {
        if (UI.loginOverlay) {
            UI.loginOverlay.style.display = 'flex';
            const pw = document.getElementById('login-password');
            if (pw) pw.focus();
        }
    }
});
