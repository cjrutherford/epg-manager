/* ===========================================
   IPTV Watch — Application Logic
   =========================================== */

(function () {
    'use strict';

    // ── Category Icon Map ──────────────────────
    const CATEGORY_ICONS = {
        'news': '📰', 'News': '📰',
        'sports': '⚽', 'Sports': '⚽',
        'entertainment': '🎭', 'Entertainment': '🎭',
        'movies': '🎬', 'Movies': '🎬',
        'music': '🎵', 'Music': '🎵',
        'kids': '🧒', 'Kids': '🧒',
        'education': '📚', 'Education': '📚',
        'documentary': '🎥', 'Documentary': '🎥',
        'science': '🔬', 'Science': '🔬',
        'travel': '✈️', 'Travel': '✈️',
        'food': '🍳', 'Food': '🍳',
        'cooking': '🍳', 'Cooking': '🍳',
        'comedy': '😂', 'Comedy': '😂',
        'drama': '🎭', 'Drama': '🎭',
        'lifestyle': '🏠', 'Lifestyle': '🏠',
        'weather': '🌤️', 'Weather': '🌤️',
        'business': '💼', 'Business': '💼',
        'religious': '🙏', 'Religious': '🙏',
        'classic': '📺', 'Classic': '📺',
        'animation': '✨', 'Animation': '✨',
        'general': '📡', 'General': '📡',
        'culture': '🎨', 'Culture': '🎨',
        'family': '👨‍👩‍👧‍👦', 'Family': '👨‍👩‍👧‍👦',
        'outdoor': '🏕️', 'Outdoor': '🏕️',
        'auto': '🏎️', 'Auto': '🏎️',
        'shop': '🛍️', 'Shop': '🛍️',
        'shopping': '🛍️', 'Shopping': '🛍️',
        'gaming': '🎮', 'Gaming': '🎮',
        'xxx': '🔞', 'XXX': '🔞',
        'adult': '🔞', 'Adult': '🔞',
    };

    function getCategoryIcon(name) {
        if (!name) return '📁';
        // Try exact match first, then case-insensitive partial match
        if (CATEGORY_ICONS[name]) return CATEGORY_ICONS[name];
        const lower = name.toLowerCase();
        for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
            if (lower.includes(key.toLowerCase())) return icon;
        }
        return '📁';
    }

    // ── State ──────────────────────────────────
    const state = {
        channels: [],
        categories: [],
        currentChannelIndex: -1,
        // Search & filtering
        searchQuery: '',
        selectedCategories: new Set(), // empty = all
        // Favorites
        favorites: new Set(), // channel IDs
        // Hidden channels (per-user, localStorage)
        hiddenChannels: new Set(), // channel IDs
        // Guide
        guideOpen: false,
        guideStart: null, // Date
        guideHours: 3,
        hls: null,
        overlayTimer: null,
        osdTimer: null,
        infoUpdateTimer: null,
        searchDebounceTimer: null,
        // Volume
        volume: 0.8,
        muted: false,
        // Recordings
        recordings: [],
        recordingsOpen: false,
        recordingsWorker: null,
        // Cast
        castSession: null,
        isCasting: false,
        // Context menu
        contextProgram: null,
        contextChannelIndex: -1,
        // Resize
        isResizing: false,
        guideHeightPx: 320,
        threePane: false,
    };

    // ── DOM refs ───────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {
        video: $('#video-player'),
        playerArea: $('#player-area'),
        contentArea: $('#content-area'),
        loading: $('#player-loading'),
        error: $('#player-error'),
        errorMsg: $('#error-message'),
        // OSD
        osd: $('#channel-osd'),
        osdNumber: $('#osd-number'),
        osdName: $('#osd-name'),
        // Info overlay (floating, two-pane)
        infoOverlay: $('#info-overlay'),
        infoLogo: $('#info-logo'),
        infoChannelName: $('#info-channel-name'),
        infoProgramTitle: $('#info-program-title'),
        infoProgramSubtitle: $('#info-program-subtitle'),
        infoProgramDesc: $('#info-program-desc'),
        infoTime: $('#info-time'),
        infoCategory: $('#info-category'),
        infoEpisode: $('#info-episode'),
        infoProgress: $('#info-progress'),
        // Info pane (sidebar, three-pane)
        infoPane: $('#info-pane'),
        paneLogo: $('#pane-logo'),
        paneChannelName: $('#pane-channel-name'),
        paneProgramTitle: $('#pane-program-title'),
        paneProgramSubtitle: $('#pane-program-subtitle'),
        paneProgramDesc: $('#pane-program-desc'),
        paneTime: $('#pane-time'),
        paneCategory: $('#pane-category'),
        paneEpisode: $('#pane-episode'),
        paneProgress: $('#pane-progress'),
        // Top bar
        topBar: $('#top-bar'),
        npChannel: $('#np-channel'),
        npProgram: $('#np-program'),
        guideToggle: $('#btn-guide-toggle'),
        recordingsToggle: $('#btn-recordings-toggle'),
        // Resize handle
        resizeHandle: $('#guide-resize-handle'),
        // Guide
        guidePanel: $('#guide-panel'),
        guideTimeline: $('#guide-timeline'),
        guideRows: $('#guide-rows'),
        guideLoading: $('#guide-loading'),
        guideEmpty: $('#guide-empty'),
        guideTimeLabel: $('#guide-time-label'),
        guidePrev: $('#guide-prev'),
        guideNext: $('#guide-next'),
        guideNow: $('#guide-now'),
        categoryTabs: $('#category-tabs'),
        // Search
        searchInput: $('#search-input'),
        searchClear: $('#search-clear'),
        // Volume
        volumeBar: $('#volume-bar'),
        btnMute: $('#btn-mute'),
        volIconOn: $('#vol-icon-on'),
        volIconOff: $('#vol-icon-off'),
        volumeSlider: $('#volume-slider'),
        volumePct: $('#volume-pct'),
        // Channel controls
        channelControls: $('#channel-controls'),
        btnChUp: $('#btn-ch-up'),
        btnChDown: $('#btn-ch-down'),
        // Recordings
        recordingsPanel: $('#recordings-panel'),
        recPanelClose: $('#rec-panel-close'),
        recList: $('#rec-list'),
        // Context menu
        contextMenu: $('#program-context-menu'),
        ctxRecord: $('#ctx-record'),
        ctxTune: $('#ctx-tune'),
        ctxFavorite: $('#ctx-favorite'),
        ctxFavoriteLabel: $('#ctx-favorite-label'),
        ctxHide: $('#ctx-hide'),
    };

    // ── Helpers ─────────────────────────────────

    /** Parse EPG time string (20231225143000 +0000) to Date */
    function parseEpgTime(str) {
        if (!str) return null;
        const clean = str.replace(/\s.+$/, '');
        const y = clean.slice(0, 4), mo = clean.slice(4, 6), d = clean.slice(6, 8);
        const h = clean.slice(8, 10), mi = clean.slice(10, 12), s = clean.slice(12, 14);
        return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    }

    /** Format time as h:mm AM/PM */
    function fmtTime(date) {
        if (!date) return '';
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    /** Format time range */
    function fmtTimeRange(start, stop) {
        const s = parseEpgTime(start);
        const e = parseEpgTime(stop);
        if (!s || !e) return '';
        return `${fmtTime(s)} – ${fmtTime(e)}`;
    }

    /** Duration in minutes between two EPG time strings */
    function durationMinutes(start, stop) {
        const s = parseEpgTime(start);
        const e = parseEpgTime(stop);
        if (!s || !e) return 30;
        return Math.max(10, (e - s) / 60000);
    }

    /** Calculate progress % for a program */
    function programProgress(start, stop) {
        const s = parseEpgTime(start);
        const e = parseEpgTime(stop);
        if (!s || !e) return 0;
        const now = Date.now();
        if (now < s.getTime()) return 0;
        if (now > e.getTime()) return 100;
        return ((now - s.getTime()) / (e.getTime() - s.getTime())) * 100;
    }

    // ── Favorites Persistence ────────────────────

    function loadFavorites() {
        try {
            const saved = localStorage.getItem('iptv_favorites');
            if (saved) {
                const arr = JSON.parse(saved);
                state.favorites = new Set(arr);
            }
        } catch (_) { }
    }

    function saveFavorites() {
        localStorage.setItem('iptv_favorites', JSON.stringify([...state.favorites]));
    }

    function toggleFavorite(channelId) {
        if (state.favorites.has(channelId)) {
            state.favorites.delete(channelId);
        } else {
            state.favorites.add(channelId);
        }
        saveFavorites();
        // Re-render guide to re-sort
        renderFilteredGuide();
    }

    // ── Hidden Channels Persistence ──────────────

    function loadHiddenChannels() {
        try {
            const saved = localStorage.getItem('iptv_hidden_channels');
            if (saved) {
                const arr = JSON.parse(saved);
                state.hiddenChannels = new Set(arr);
            }
        } catch (_) { }
    }

    function saveHiddenChannels() {
        localStorage.setItem('iptv_hidden_channels', JSON.stringify([...state.hiddenChannels]));
    }

    function toggleHidden(channelId) {
        if (state.hiddenChannels.has(channelId)) {
            state.hiddenChannels.delete(channelId);
        } else {
            state.hiddenChannels.add(channelId);
        }
    }

    // ── API ─────────────────────────────────────

    async function fetchGuide(categories = [], start = null, hours = 3) {
        const params = new URLSearchParams({ hours: String(hours) });
        // Multi-category support: pass comma-separated
        if (categories.length > 0) {
            params.set('categories', categories.join(','));
        }
        if (start) params.set('start', start);
        const res = await fetch(`/api/guide?${params}`);
        if (!res.ok) throw new Error('Failed to load guide');
        return res.json();
    }

    async function fetchCategories() {
        const res = await fetch('/api/categories');
        if (!res.ok) throw new Error('Failed to load categories');
        return res.json();
    }

    async function fetchRecordings() {
        try {
            const res = await fetch('/api/recordings');
            if (!res.ok) return [];
            return res.json();
        } catch (_) { return []; }
    }

    async function scheduleRecording(data) {
        const res = await fetch('/api/recordings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('Failed to schedule recording');
        return res.json();
    }

    async function cancelRecording(id) {
        const res = await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to cancel recording');
        return res.json();
    }

    // ── Volume ──────────────────────────────────

    function initVolume() {
        const saved = localStorage.getItem('iptv_volume');
        const savedMuted = localStorage.getItem('iptv_muted');
        if (saved !== null) state.volume = parseFloat(saved);
        if (savedMuted !== null) state.muted = savedMuted === 'true';

        dom.video.volume = state.volume;
        dom.video.muted = state.muted;
        dom.volumeSlider.value = Math.round(state.volume * 100);
        dom.volumePct.textContent = `${Math.round(state.volume * 100)}%`;
        updateMuteIcon();
    }

    function setVolume(val) {
        val = Math.max(0, Math.min(1, val));
        state.volume = val;
        state.muted = false;
        dom.video.volume = val;
        dom.video.muted = false;
        dom.volumeSlider.value = Math.round(val * 100);
        dom.volumePct.textContent = `${Math.round(val * 100)}%`;
        updateMuteIcon();
        localStorage.setItem('iptv_volume', val);
        localStorage.setItem('iptv_muted', 'false');
    }

    function toggleMute() {
        state.muted = !state.muted;
        dom.video.muted = state.muted;
        updateMuteIcon();
        localStorage.setItem('iptv_muted', String(state.muted));
    }

    function updateMuteIcon() {
        const off = state.muted || state.volume === 0;
        dom.volIconOn.classList.toggle('hidden', off);
        dom.volIconOff.classList.toggle('hidden', !off);
    }

    // ── HLS Player ──────────────────────────────

    function playStream(url) {
        dom.loading.classList.remove('hidden');
        dom.error.classList.add('hidden');

        if (state.hls) {
            state.hls.destroy();
            state.hls = null;
        }

        if (!url) {
            showError('No stream URL');
            return;
        }

        if (state.isCasting && state.castSession) {
            castLoadMedia(url);
            dom.loading.classList.add('hidden');
            return;
        }

        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                startFragPrefetch: true,
            });

            hls.loadSource(url);
            hls.attachMedia(dom.video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                dom.loading.classList.add('hidden');
                dom.video.play().catch(() => { });
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.warn('HLS network error, attempting recovery...');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.warn('HLS media error, attempting recovery...');
                            hls.recoverMediaError();
                            break;
                        default:
                            showError('Stream playback failed');
                            hls.destroy();
                            break;
                    }
                }
            });

            state.hls = hls;
        } else if (dom.video.canPlayType('application/vnd.apple.mpegurl')) {
            dom.video.src = url;
            dom.video.addEventListener('loadedmetadata', () => {
                dom.loading.classList.add('hidden');
                dom.video.play().catch(() => { });
            }, { once: true });
            dom.video.addEventListener('error', () => {
                showError('Stream playback failed');
            }, { once: true });
        } else {
            showError('HLS not supported in this browser');
        }
    }

    function showError(msg) {
        dom.loading.classList.add('hidden');
        dom.error.classList.remove('hidden');
        dom.errorMsg.textContent = msg;
    }

    // ── Channel Switching ───────────────────────

    function tuneToChannel(index) {
        if (index < 0 || index >= state.channels.length) return;

        const prevIndex = state.currentChannelIndex;
        state.currentChannelIndex = index;
        const ch = state.channels[index];

        playStream(ch.stream_url);
        showOSD(ch);
        showInfoOverlay(ch);
        updateNowPlaying(ch);
        updateActiveGuideRow(index, prevIndex);
        startInfoUpdateTimer();

        // Persist last channel
        try { localStorage.setItem('iptv_last_channel', String(ch.id)); } catch (_) { }
    }

    function channelUp() {
        if (state.currentChannelIndex > 0) {
            tuneToChannel(state.currentChannelIndex - 1);
        }
    }

    function channelDown() {
        if (state.currentChannelIndex < state.channels.length - 1) {
            tuneToChannel(state.currentChannelIndex + 1);
        }
    }

    // ── OSD (animated) ─────────────────────────

    function showOSD(channel) {
        clearTimeout(state.osdTimer);

        dom.osdNumber.textContent = channel.channel_number || '';
        dom.osdName.textContent = channel.name || '';

        dom.osd.classList.remove('osd-enter', 'osd-exit');
        void dom.osd.offsetWidth;
        dom.osd.classList.add('osd-enter');

        state.osdTimer = setTimeout(() => {
            dom.osd.classList.remove('osd-enter');
            dom.osd.classList.add('osd-exit');
        }, 3000);
    }

    function showInfoOverlay(channel) {
        clearTimeout(state.overlayTimer);

        const prog = channel.current_program;

        if (channel.logo) {
            dom.infoLogo.src = channel.logo;
            dom.infoLogo.style.display = '';
        } else {
            dom.infoLogo.style.display = 'none';
        }

        dom.infoChannelName.textContent = channel.name || '';
        dom.infoProgramTitle.textContent = prog?.title || 'No Program Info';
        dom.infoProgramSubtitle.textContent = prog?.sub_title || '';
        dom.infoProgramDesc.textContent = prog?.description || '';
        dom.infoTime.textContent = prog ? fmtTimeRange(prog.start, prog.stop) : '';
        dom.infoCategory.textContent = prog?.category || channel.group_title || '';
        dom.infoEpisode.textContent = prog?.episode_num || '';
        dom.infoProgress.style.width = prog ? `${programProgress(prog.start, prog.stop)}%` : '0%';

        dom.infoOverlay.classList.remove('hidden');

        // Also sync the info-pane sidebar (three-pane mode)
        syncInfoPane(channel, prog);

        if (!state.guideOpen) {
            state.overlayTimer = setTimeout(() => {
                dom.infoOverlay.classList.add('hidden');
            }, 5000);
        }
    }

    /** Sync the three-pane info sidebar */
    function syncInfoPane(channel, prog) {
        if (channel.logo) {
            dom.paneLogo.src = channel.logo;
            dom.paneLogo.style.display = '';
        } else {
            dom.paneLogo.style.display = 'none';
        }
        dom.paneChannelName.textContent = channel.name || '';
        dom.paneProgramTitle.textContent = prog?.title || 'No Program Info';
        dom.paneProgramSubtitle.textContent = prog?.sub_title || '';
        dom.paneProgramDesc.textContent = prog?.description || '';
        dom.paneTime.textContent = prog ? fmtTimeRange(prog.start, prog.stop) : '';
        dom.paneCategory.textContent = prog?.category || channel.group_title || '';
        dom.paneEpisode.textContent = prog?.episode_num || '';
        dom.paneProgress.style.width = prog ? `${programProgress(prog.start, prog.stop)}%` : '0%';
    }

    function updateNowPlaying(channel) {
        dom.npChannel.textContent = channel.name || '';
        const prog = channel.current_program;
        dom.npProgram.textContent = prog ? `• ${prog.title}` : '';
    }

    function startInfoUpdateTimer() {
        clearInterval(state.infoUpdateTimer);
        state.infoUpdateTimer = setInterval(() => {
            if (state.currentChannelIndex < 0) return;
            const ch = state.channels[state.currentChannelIndex];
            const prog = ch.current_program;
            if (prog) {
                const pct = `${programProgress(prog.start, prog.stop)}%`;
                dom.infoProgress.style.width = pct;
                dom.paneProgress.style.width = pct;
            }
        }, 10000);
    }

    function updateActiveGuideRow(newIdx, oldIdx) {
        if (oldIdx >= 0) {
            const old = dom.guideRows.querySelector(`[data-channel-idx="${oldIdx}"]`);
            if (old) old.classList.remove('active');
        }
        const row = dom.guideRows.querySelector(`[data-channel-idx="${newIdx}"]`);
        if (row) {
            row.classList.add('active');
            row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    // ── Search ──────────────────────────────────

    function handleSearchInput() {
        clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = setTimeout(() => {
            state.searchQuery = dom.searchInput.value.trim().toLowerCase();
            dom.searchClear.classList.toggle('hidden', state.searchQuery === '');
            renderFilteredGuide();
        }, 200); // 200ms debounce
    }

    function clearSearch() {
        dom.searchInput.value = '';
        state.searchQuery = '';
        dom.searchClear.classList.add('hidden');
        renderFilteredGuide();
    }

    /** Filter channels based on search query, selected categories, and hidden channels */
    function getFilteredChannels() {
        let channels = state.channels;

        // Filter out hidden channels
        if (state.hiddenChannels.size > 0) {
            channels = channels.filter(ch => !state.hiddenChannels.has(ch.id));
        }

        // Filter by selected categories (multi-select)
        if (state.selectedCategories.size > 0) {
            channels = channels.filter(ch =>
                ch.group_title && state.selectedCategories.has(ch.group_title)
            );
        }

        // Filter by search query
        if (state.searchQuery) {
            const q = state.searchQuery;
            channels = channels.filter(ch => {
                // Match channel name
                if (ch.name && ch.name.toLowerCase().includes(q)) return true;
                // Match current program title
                if (ch.current_program?.title && ch.current_program.title.toLowerCase().includes(q)) return true;
                // Match any program title in the window
                if (ch.programs?.some(p => p.title && p.title.toLowerCase().includes(q))) return true;
                return false;
            });
        }

        return channels;
    }

    // ── Guide ───────────────────────────────────

    async function loadGuide() {
        dom.guideLoading.classList.remove('hidden');
        dom.guideEmpty.classList.add('hidden');
        dom.guideRows.innerHTML = '';
        dom.guideTimeline.innerHTML = '';

        try {
            const startDate = state.guideStart || new Date();
            // Pass empty categories array (we filter client-side for multi-select)
            const data = await fetchGuide(
                [],
                startDate.toISOString(),
                state.guideHours
            );

            state.channels = data.channels;

            if (state.channels.length === 0) {
                dom.guideLoading.classList.add('hidden');
                dom.guideEmpty.classList.remove('hidden');
                return;
            }

            // Store guide time window for rendering
            state._guideStartMs = new Date(data.start).getTime();
            state._guideEndMs = new Date(data.end).getTime();

            // Update time label
            const startD = new Date(data.start);
            const endD = new Date(data.end);
            dom.guideTimeLabel.textContent = `${fmtTime(startD)} — ${fmtTime(endD)}`;

            // Build timeline header
            renderTimeline(state._guideStartMs, state._guideEndMs);

            // Render channels (with filter)
            renderFilteredGuide();

            dom.guideLoading.classList.add('hidden');

            // Auto-select last channel or first channel if none selected
            if (state.currentChannelIndex < 0 && state.channels.length > 0) {
                let restoreIdx = 0;
                try {
                    const lastChId = localStorage.getItem('iptv_last_channel');
                    if (lastChId) {
                        const found = state.channels.findIndex(ch => String(ch.id) === lastChId);
                        if (found >= 0) restoreIdx = found;
                    }
                } catch (_) { }
                tuneToChannel(restoreIdx);
            }
        } catch (e) {
            console.error('Failed to load guide:', e);
            dom.guideLoading.classList.add('hidden');
            dom.guideEmpty.textContent = 'Failed to load guide data';
            dom.guideEmpty.classList.remove('hidden');
        }
    }

    /** Re-render guide rows based on current search/category/favorites filters */
    function renderFilteredGuide() {
        dom.guideRows.innerHTML = '';

        if (!state._guideStartMs || !state._guideEndMs) return;

        const filtered = getFilteredChannels();

        if (filtered.length === 0) {
            dom.guideEmpty.classList.remove('hidden');
            dom.guideEmpty.textContent = state.searchQuery
                ? `No channels matching "${state.searchQuery}"`
                : 'No channels available';
            return;
        }
        dom.guideEmpty.classList.add('hidden');

        const now = Date.now();

        // Split into favorites and non-favorites
        const favChannels = filtered.filter(ch => state.favorites.has(ch.id));
        const otherChannels = filtered.filter(ch => !state.favorites.has(ch.id));

        const frag = document.createDocumentFragment();

        // Render favorites section
        if (favChannels.length > 0) {
            // Divider
            const divider = document.createElement('div');
            divider.className = 'guide-section-divider';
            divider.innerHTML = '<span class="divider-label">★ Favorites</span><span class="divider-line"></span>';
            frag.appendChild(divider);

            favChannels.forEach(ch => {
                const origIdx = state.channels.indexOf(ch);
                frag.appendChild(createGuideRow(ch, origIdx, now));
            });
        }

        // Render other channels section
        if (otherChannels.length > 0 && favChannels.length > 0) {
            const divider = document.createElement('div');
            divider.className = 'guide-section-divider';
            divider.innerHTML = '<span class="divider-label">All Channels</span><span class="divider-line"></span>';
            frag.appendChild(divider);
        }

        otherChannels.forEach(ch => {
            const origIdx = state.channels.indexOf(ch);
            frag.appendChild(createGuideRow(ch, origIdx, now));
        });

        dom.guideRows.appendChild(frag);

        // Re-highlight active channel
        if (state.currentChannelIndex >= 0) {
            const row = dom.guideRows.querySelector(`[data-channel-idx="${state.currentChannelIndex}"]`);
            if (row) row.classList.add('active');
        }
    }

    /** Create a single guide row element */
    function createGuideRow(ch, idx, now) {
        const guideStartMs = state._guideStartMs;
        const guideEndMs = state._guideEndMs;
        const totalMinutes = (guideEndMs - guideStartMs) / 60000;
        const pixelsPerMinute = 200 / 30;

        const row = document.createElement('div');
        row.className = 'guide-row';
        row.dataset.channelIdx = idx;

        // Channel column
        const chCol = document.createElement('div');
        chCol.className = 'guide-channel';
        chCol.onclick = () => tuneToChannel(idx);

        // Favorite star button
        const star = document.createElement('button');
        star.className = 'fav-star' + (state.favorites.has(ch.id) ? ' is-fav' : '');
        star.innerHTML = state.favorites.has(ch.id) ? '★' : '☆';
        star.title = state.favorites.has(ch.id) ? 'Remove from favorites' : 'Add to favorites';
        star.onclick = (e) => {
            e.stopPropagation();
            toggleFavorite(ch.id);
        };
        chCol.appendChild(star);

        if (ch.logo) {
            const img = document.createElement('img');
            img.className = 'guide-channel-logo';
            img.src = ch.logo;
            img.alt = '';
            img.loading = 'lazy';
            img.onerror = () => { img.style.display = 'none'; };
            chCol.appendChild(img);
        }

        const info = document.createElement('div');
        info.className = 'guide-channel-info';

        if (ch.channel_number) {
            const num = document.createElement('div');
            num.className = 'guide-channel-number';
            num.textContent = ch.channel_number;
            info.appendChild(num);
        }

        const name = document.createElement('div');
        name.className = 'guide-channel-name';
        name.textContent = ch.name;
        name.title = ch.name;
        info.appendChild(name);

        chCol.appendChild(info);
        row.appendChild(chCol);

        // Programs
        const progsContainer = document.createElement('div');
        progsContainer.className = 'guide-programs';
        progsContainer.style.minWidth = `${totalMinutes * pixelsPerMinute}px`;

        if (ch.programs && ch.programs.length > 0) {
            ch.programs.forEach(p => {
                const pStart = parseEpgTime(p.start);
                const pStop = parseEpgTime(p.stop);
                if (!pStart || !pStop) return;

                const visStart = Math.max(pStart.getTime(), guideStartMs);
                const visEnd = Math.min(pStop.getTime(), guideEndMs);
                const durationMin = (visEnd - visStart) / 60000;
                if (durationMin <= 0) return;

                const offsetMin = (visStart - guideStartMs) / 60000;

                const cell = document.createElement('div');
                cell.className = 'guide-program';
                cell.style.left = `${offsetMin * pixelsPerMinute}px`;
                cell.style.width = `${durationMin * pixelsPerMinute}px`;
                cell.style.minWidth = `${Math.max(durationMin * pixelsPerMinute, 40)}px`;
                // Data attributes for delegated context menu
                cell.dataset.programTitle = p.title || '';
                cell.dataset.programStart = p.start || '';
                cell.dataset.programStop = p.stop || '';

                if (now >= pStart.getTime() && now < pStop.getTime()) {
                    cell.classList.add('current');
                }

                // Check if has recording scheduled
                const hasRec = state.recordings.some(r =>
                    r.channel_id === ch.id && r.program_title === p.title &&
                    r.status !== 'cancelled' && r.status !== 'failed'
                );
                if (hasRec) cell.classList.add('has-recording');

                // Highlight matching search terms in title
                const titleDiv = document.createElement('div');
                titleDiv.className = 'guide-program-title';
                titleDiv.textContent = p.title || 'Untitled';
                titleDiv.title = p.title || '';
                cell.appendChild(titleDiv);

                const timeDiv = document.createElement('div');
                timeDiv.className = 'guide-program-time';
                timeDiv.textContent = `${fmtTime(pStart)} – ${fmtTime(pStop)}`;
                cell.appendChild(timeDiv);

                cell.onclick = () => tuneToChannel(idx);

                progsContainer.appendChild(cell);
            });
        } else {
            const empty = document.createElement('div');
            empty.className = 'guide-program empty';
            empty.style.left = '0px';
            empty.style.width = `${totalMinutes * pixelsPerMinute}px`;
            const emptyTitle = document.createElement('div');
            emptyTitle.className = 'guide-program-title';
            emptyTitle.textContent = 'No program data';
            empty.appendChild(emptyTitle);
            empty.onclick = () => tuneToChannel(idx);
            progsContainer.appendChild(empty);
        }

        row.appendChild(progsContainer);
        return row;
    }

    function renderTimeline(startMs, endMs) {
        const frag = document.createDocumentFragment();

        const spacer = document.createElement('div');
        spacer.className = 'timeline-channel-spacer';
        spacer.textContent = 'Channel';
        frag.appendChild(spacer);

        const slotMs = 30 * 60 * 1000;
        const now = Date.now();
        let t = startMs;
        while (t < endMs) {
            const div = document.createElement('div');
            div.className = 'timeline-block';
            if (now >= t && now < t + slotMs) {
                div.classList.add('now');
            }
            div.textContent = fmtTime(new Date(t));
            frag.appendChild(div);
            t += slotMs;
        }

        dom.guideTimeline.appendChild(frag);
    }

    // ── Context Menu ────────────────────────────

    function showContextMenu(x, y, channelIndex, program) {
        state.contextChannelIndex = channelIndex;
        state.contextProgram = program;

        // Update favorite label
        const ch = state.channels[channelIndex];
        const isFav = ch && state.favorites.has(ch.id);
        dom.ctxFavoriteLabel.textContent = isFav ? '☆ Unfavorite' : '★ Favorite';

        dom.contextMenu.classList.remove('hidden');
        dom.contextMenu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
        dom.contextMenu.style.top = `${Math.min(y, window.innerHeight - 130)}px`;
    }

    function hideContextMenu() {
        dom.contextMenu.classList.add('hidden');
        state.contextProgram = null;
        state.contextChannelIndex = -1;
    }

    async function handleRecordFromContext() {
        hideContextMenu();
        const ch = state.channels[state.contextChannelIndex];
        const p = state.contextProgram;
        if (!ch || !p) return;

        try {
            await scheduleRecording({
                channel_id: ch.id,
                channel_name: ch.name,
                program_title: p.title || 'Unknown',
                start_time: p.start,
                end_time: p.stop,
                stream_url: ch.stream_url,
            });
            await loadRecordings();
            renderFilteredGuide();
        } catch (e) {
            console.error('Failed to schedule recording:', e);
        }
    }

    function handleTuneFromContext() {
        const idx = state.contextChannelIndex;
        hideContextMenu();
        if (idx >= 0) tuneToChannel(idx);
    }

    function handleFavoriteFromContext() {
        const ch = state.channels[state.contextChannelIndex];
        hideContextMenu();
        if (ch) toggleFavorite(ch.id);
    }

    function handleHideFromContext() {
        const ch = state.channels[state.contextChannelIndex];
        hideContextMenu();
        if (ch) {
            toggleHidden(ch.id);
            saveHiddenChannels();
            renderFilteredGuide();
        }
    }

    // ── Recordings ──────────────────────────────

    async function loadRecordings() {
        state.recordings = await fetchRecordings();
        renderRecordings();
    }

    function renderRecordings() {
        const recs = state.recordings;
        if (recs.length === 0) {
            dom.recList.innerHTML = '<div class="rec-empty">No recordings scheduled</div>';
            return;
        }

        dom.recList.innerHTML = '';
        recs.forEach(rec => {
            const item = document.createElement('div');
            item.className = 'rec-item';

            const header = document.createElement('div');
            header.className = 'rec-item-header';

            const title = document.createElement('div');
            title.className = 'rec-item-title';
            title.textContent = rec.program_title || 'Unknown';
            title.title = rec.program_title || '';
            header.appendChild(title);

            const badge = document.createElement('span');
            badge.className = `rec-status ${rec.status}`;
            badge.textContent = rec.status;
            header.appendChild(badge);

            item.appendChild(header);

            const meta = document.createElement('div');
            meta.className = 'rec-item-meta';
            const startTime = rec.start_time ? new Date(rec.start_time).toLocaleString() : '';
            meta.textContent = `${rec.channel_name || ''} • ${startTime}`;
            item.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'rec-item-actions';

            if (rec.status === 'completed' && rec.filename) {
                const dlBtn = document.createElement('button');
                dlBtn.className = 'rec-action-btn download';
                dlBtn.textContent = '⬇ Download';
                dlBtn.onclick = () => {
                    window.open(`/api/recordings/${rec.id}/download`, '_blank');
                };
                actions.appendChild(dlBtn);
            }

            if (rec.status === 'scheduled' || rec.status === 'recording') {
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'rec-action-btn cancel';
                cancelBtn.textContent = '✕ Cancel';
                cancelBtn.onclick = async () => {
                    try {
                        await cancelRecording(rec.id);
                        await loadRecordings();
                        renderFilteredGuide();
                    } catch (e) {
                        console.error('Cancel failed:', e);
                    }
                };
                actions.appendChild(cancelBtn);
            }

            if (rec.status === 'completed' || rec.status === 'failed' || rec.status === 'cancelled') {
                const delBtn = document.createElement('button');
                delBtn.className = 'rec-action-btn cancel';
                delBtn.textContent = '🗑 Delete';
                delBtn.onclick = async () => {
                    try {
                        await cancelRecording(rec.id);
                        await loadRecordings();
                    } catch (e) {
                        console.error('Delete failed:', e);
                    }
                };
                actions.appendChild(delBtn);
            }

            item.appendChild(actions);
            dom.recList.appendChild(item);
        });
    }

    function toggleRecordingsPanel() {
        state.recordingsOpen = !state.recordingsOpen;
        dom.recordingsPanel.classList.toggle('open', state.recordingsOpen);
        dom.recordingsToggle.classList.toggle('active', state.recordingsOpen);
        if (state.recordingsOpen) loadRecordings();
    }

    // ── Recordings Web Worker ───────────────────

    function initRecorderWorker() {
        if (typeof Worker === 'undefined') return;
        try {
            state.recordingsWorker = new Worker('recorder-worker.js');
            state.recordingsWorker.onmessage = (e) => {
                const msg = e.data;
                if (msg.type === 'recordings-update') {
                    state.recordings = msg.recordings;
                    renderRecordings();
                }
            };
            state.recordingsWorker.postMessage({ type: 'start' });
        } catch (_) {
            setInterval(async () => {
                if (state.recordingsOpen) {
                    await loadRecordings();
                }
            }, 15000);
        }
    }

    // ── Categories (multi-select with icons) ────

    async function loadCategories() {
        try {
            const cats = await fetchCategories();
            state.categories = cats;

            dom.categoryTabs.innerHTML = '';

            // "All" tab — active when nothing selected
            const allTab = document.createElement('button');
            allTab.className = 'cat-tab' + (state.selectedCategories.size === 0 ? ' active' : '');
            allTab.dataset.category = 'all';
            allTab.innerHTML = '<span class="cat-icon">📺</span> All';
            allTab.onclick = () => {
                // Clear all selections (show everything)
                state.selectedCategories.clear();
                updateCategoryTabUI();
                renderFilteredGuide();
            };
            dom.categoryTabs.appendChild(allTab);

            // "★ Favorites" tab
            if (state.favorites.size > 0) {
                const favTab = document.createElement('button');
                favTab.className = 'cat-tab';
                favTab.dataset.category = '__favorites__';
                favTab.innerHTML = '<span class="cat-icon">⭐</span> Favorites';
                favTab.onclick = () => {
                    // Special: filter to only favorited channels
                    state.selectedCategories.clear();
                    state.selectedCategories.add('__favorites__');
                    updateCategoryTabUI();
                    renderFilteredGuide();
                };
                dom.categoryTabs.appendChild(favTab);
            }

            cats.forEach(cat => {
                const tab = document.createElement('button');
                tab.className = 'cat-tab' + (state.selectedCategories.has(cat.group_title) ? ' active' : '');
                tab.dataset.category = cat.group_title;

                const icon = getCategoryIcon(cat.group_title);
                tab.innerHTML = `<span class="cat-icon">${icon}</span> ${cat.group_title} <span class="cat-count">(${cat.count})</span>`;

                tab.onclick = () => toggleCategory(cat.group_title);
                dom.categoryTabs.appendChild(tab);
            });
        } catch (e) {
            console.error('Failed to load categories:', e);
        }
    }

    function toggleCategory(category) {
        // Remove special __favorites__ if toggling real categories
        state.selectedCategories.delete('__favorites__');

        if (state.selectedCategories.has(category)) {
            state.selectedCategories.delete(category);
        } else {
            state.selectedCategories.add(category);
        }

        updateCategoryTabUI();
        renderFilteredGuide();
    }

    function updateCategoryTabUI() {
        $$('.cat-tab').forEach(t => {
            const cat = t.dataset.category;
            if (cat === 'all') {
                t.classList.toggle('active', state.selectedCategories.size === 0);
            } else {
                t.classList.toggle('active', state.selectedCategories.has(cat));
            }
        });
    }

    /** Override getFilteredChannels to handle __favorites__ pseudo-category */
    function getFilteredChannelsInternal() {
        let channels = state.channels;

        // Special: favorites-only filter
        if (state.selectedCategories.has('__favorites__')) {
            channels = channels.filter(ch => state.favorites.has(ch.id));
        }
        // Filter by selected categories (multi-select)
        else if (state.selectedCategories.size > 0) {
            channels = channels.filter(ch =>
                ch.group_title && state.selectedCategories.has(ch.group_title)
            );
        }

        // Filter by search query
        if (state.searchQuery) {
            const q = state.searchQuery;
            channels = channels.filter(ch => {
                if (ch.name && ch.name.toLowerCase().includes(q)) return true;
                if (ch.current_program?.title && ch.current_program.title.toLowerCase().includes(q)) return true;
                if (ch.programs?.some(p => p.title && p.title.toLowerCase().includes(q))) return true;
                return false;
            });
        }

        return channels;
    }

    // ── Guide Controls ──────────────────────────

    function toggleGuide() {
        state.guideOpen = !state.guideOpen;
        document.body.classList.toggle('guide-visible', state.guideOpen);
        dom.guideToggle.classList.toggle('active', state.guideOpen);

        if (state.guideOpen) {
            // Apply saved guide height
            document.documentElement.style.setProperty('--guide-height', state.guideHeightPx + 'px');
            updateLayoutMode();
            if (state.currentChannelIndex >= 0) {
                showInfoOverlay(state.channels[state.currentChannelIndex]);
            }
        } else {
            document.body.classList.remove('layout-three-pane');
            state.threePane = false;
        }
    }

    function navigateGuideTime(direction) {
        const shiftMs = 30 * 60 * 1000;
        if (!state.guideStart) state.guideStart = new Date();
        state.guideStart = new Date(state.guideStart.getTime() + direction * shiftMs);
        loadGuide();
    }

    function jumpToNow() {
        state.guideStart = new Date();
        loadGuide();
    }

    // ── Resize Logic ────────────────────────────

    /** Check if guide is >50% of viewport and toggle three-pane mode */
    function updateLayoutMode() {
        const vh = window.innerHeight;
        const isThreePane = state.guideHeightPx > (vh * 0.5);
        if (isThreePane !== state.threePane) {
            state.threePane = isThreePane;
            document.body.classList.toggle('layout-three-pane', isThreePane);
        }
    }

    function initGuideResize() {
        // Load saved height
        const saved = localStorage.getItem('iptv_guide_height');
        if (saved) {
            const h = parseInt(saved, 10);
            if (h > 100 && h < window.innerHeight - 80) {
                state.guideHeightPx = h;
            }
        }

        dom.resizeHandle.addEventListener('mousedown', onResizeStart);
        dom.resizeHandle.addEventListener('touchstart', onResizeTouchStart, { passive: false });
    }

    function onResizeStart(e) {
        e.preventDefault();
        state.isResizing = true;
        document.body.classList.add('resizing');
        dom.resizeHandle.classList.add('dragging');

        const onMove = (ev) => {
            if (!state.isResizing) return;
            const vh = window.innerHeight;
            const topBarH = dom.topBar.offsetHeight;
            // Guide height = distance from bottom of viewport to mouse Y
            const newHeight = Math.max(120, Math.min(vh - topBarH - 60, vh - ev.clientY));
            state.guideHeightPx = newHeight;
            document.documentElement.style.setProperty('--guide-height', newHeight + 'px');
            updateLayoutMode();
        };

        const onUp = () => {
            state.isResizing = false;
            document.body.classList.remove('resizing');
            dom.resizeHandle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            localStorage.setItem('iptv_guide_height', String(state.guideHeightPx));
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function onResizeTouchStart(e) {
        e.preventDefault();
        state.isResizing = true;
        document.body.classList.add('resizing');
        dom.resizeHandle.classList.add('dragging');

        const onMove = (ev) => {
            if (!state.isResizing) return;
            const touch = ev.touches[0];
            const vh = window.innerHeight;
            const topBarH = dom.topBar.offsetHeight;
            const newHeight = Math.max(120, Math.min(vh - topBarH - 60, vh - touch.clientY));
            state.guideHeightPx = newHeight;
            document.documentElement.style.setProperty('--guide-height', newHeight + 'px');
            updateLayoutMode();
        };

        const onUp = () => {
            state.isResizing = false;
            document.body.classList.remove('resizing');
            dom.resizeHandle.classList.remove('dragging');
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            localStorage.setItem('iptv_guide_height', String(state.guideHeightPx));
        };

        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    // ── Google Cast ─────────────────────────────

    function initCast() {
        window['__onGCastApiAvailable'] = function (isAvailable) {
            if (!isAvailable) return;

            const context = cast.framework.CastContext.getInstance();
            context.setOptions({
                receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
            });

            context.addEventListener(
                cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
                (event) => {
                    switch (event.sessionState) {
                        case cast.framework.SessionState.SESSION_STARTED:
                        case cast.framework.SessionState.SESSION_RESUMED:
                            onCastConnected(context.getCurrentSession());
                            break;
                        case cast.framework.SessionState.SESSION_ENDED:
                            onCastDisconnected();
                            break;
                    }
                }
            );
        };
    }

    function onCastConnected(session) {
        state.castSession = session;
        state.isCasting = true;
        dom.video.muted = true;
        if (state.currentChannelIndex >= 0) {
            const ch = state.channels[state.currentChannelIndex];
            if (ch.stream_url) castLoadMedia(ch.stream_url);
        }
    }

    function onCastDisconnected() {
        state.castSession = null;
        state.isCasting = false;
        dom.video.muted = state.muted;
    }

    function castLoadMedia(url) {
        if (!state.castSession) return;
        const mediaInfo = new chrome.cast.media.MediaInfo(url, 'application/x-mpegURL');
        const request = new chrome.cast.media.LoadRequest(mediaInfo);
        request.autoplay = true;
        state.castSession.loadMedia(request).then(
            () => console.log('Cast: media loaded'),
            (err) => console.warn('Cast: failed to load media', err)
        );
    }

    // ── Keyboard Navigation ─────────────────────

    function handleKeyboard(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'ArrowUp':
                e.preventDefault();
                channelUp();
                break;
            case 'ArrowDown':
                e.preventDefault();
                channelDown();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                navigateGuideTime(-1);
                break;
            case 'ArrowRight':
                e.preventDefault();
                navigateGuideTime(1);
                break;
            case 'g': case 'G':
                e.preventDefault();
                toggleGuide();
                break;
            case 'r': case 'R':
                e.preventDefault();
                toggleRecordingsPanel();
                break;
            case 'f': case 'F':
                e.preventDefault();
                // Focus search
                if (state.guideOpen) {
                    dom.searchInput.focus();
                }
                break;
            case 'Escape':
                e.preventDefault();
                hideContextMenu();
                if (document.activeElement === dom.searchInput) {
                    clearSearch();
                    dom.searchInput.blur();
                } else if (state.recordingsOpen) {
                    toggleRecordingsPanel();
                } else if (state.guideOpen) {
                    toggleGuide();
                } else {
                    dom.infoOverlay.classList.toggle('hidden');
                }
                break;
            case 'i': case 'I':
                e.preventDefault();
                if (state.currentChannelIndex >= 0) {
                    showInfoOverlay(state.channels[state.currentChannelIndex]);
                }
                break;
            case ' ':
                e.preventDefault();
                if (dom.video.paused) dom.video.play().catch(() => { });
                else dom.video.pause();
                break;
            case 'm': case 'M':
                e.preventDefault();
                toggleMute();
                break;
            case '+': case '=':
                e.preventDefault();
                setVolume(state.volume + 0.05);
                break;
            case '-': case '_':
                e.preventDefault();
                setVolume(state.volume - 0.05);
                break;
        }
    }

    // ── Mouse auto-hide ─────────────────────────

    // ── Mouse auto-hide ─────────────────────────

    let mouseIdleTimer = null;

    function handleMouseMove() {
        document.body.classList.remove('user-idle');
        dom.topBar.classList.remove('auto-hide');
        dom.volumeBar.classList.add('visible');
        dom.channelControls.classList.add('visible');

        clearTimeout(mouseIdleTimer);
        mouseIdleTimer = setTimeout(() => {
            if (!state.guideOpen) {
                document.body.classList.add('user-idle');
                dom.topBar.classList.add('auto-hide');
                dom.volumeBar.classList.remove('visible');
                dom.channelControls.classList.remove('visible');
            }
        }, 3000); // Reduced to 3s for snappier feel
    }

    // ── Init ────────────────────────────────────

    // Override the getFilteredChannels with the internal version
    // that handles the __favorites__ pseudo-category
    const _origGetFilteredChannels = getFilteredChannels;

    async function init() {
        // Load favorites and hidden channels from localStorage
        loadFavorites();
        loadHiddenChannels();

        // Init volume
        initVolume();

        // Init guide resize
        initGuideResize();

        // Bind volume events
        dom.btnMute.addEventListener('click', toggleMute);
        dom.volumeSlider.addEventListener('input', (e) => {
            setVolume(parseInt(e.target.value) / 100);
        });

        // Bind channel buttons
        dom.btnChUp.addEventListener('click', channelUp);
        dom.btnChDown.addEventListener('click', channelDown);

        // Bind guide events
        dom.guideToggle.addEventListener('click', toggleGuide);
        dom.guidePrev.addEventListener('click', () => navigateGuideTime(-1));
        dom.guideNext.addEventListener('click', () => navigateGuideTime(1));
        dom.guideNow.addEventListener('click', jumpToNow);

        // Bind search
        dom.searchInput.addEventListener('input', handleSearchInput);
        dom.searchClear.addEventListener('click', clearSearch);

        // Bind recordings events
        dom.recordingsToggle.addEventListener('click', toggleRecordingsPanel);
        dom.recPanelClose.addEventListener('click', toggleRecordingsPanel);

        // Bind context menu actions
        dom.ctxRecord.addEventListener('click', handleRecordFromContext);

        // Sync guide scrolling
        dom.guideRows.addEventListener('scroll', () => {
            dom.guideTimeline.scrollLeft = dom.guideRows.scrollLeft;
        });
        dom.ctxTune.addEventListener('click', handleTuneFromContext);
        dom.ctxFavorite.addEventListener('click', handleFavoriteFromContext);
        dom.ctxHide.addEventListener('click', handleHideFromContext);
        document.addEventListener('click', hideContextMenu);

        // Delegated context menu on guide panel — prevents browser default
        dom.guidePanel.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            // Find the closest guide row to identify the channel
            const row = e.target.closest('.guide-row');
            if (!row) return;
            const idx = parseInt(row.dataset.channelIdx, 10);
            if (isNaN(idx)) return;

            // Check if we clicked on a specific program cell
            const cell = e.target.closest('.guide-program');
            let prog = null;
            if (cell && cell.dataset.programTitle) {
                prog = {
                    title: cell.dataset.programTitle || '',
                    start: cell.dataset.programStart || '',
                    stop: cell.dataset.programStop || '',
                };
            }
            showContextMenu(e.clientX, e.clientY, idx, prog);
        });

        // Keyboard & mouse
        document.addEventListener('keydown', handleKeyboard);
        document.addEventListener('mousemove', handleMouseMove);

        // Show info on click on player area
        dom.playerArea.addEventListener('click', (e) => {
            if (e.target === dom.video || e.target === dom.playerArea) {
                if (state.currentChannelIndex >= 0) {
                    showInfoOverlay(state.channels[state.currentChannelIndex]);
                }
            }
        });

        // OSD animation end
        dom.osd.addEventListener('animationend', (e) => {
            if (e.animationName === 'osdSlideOut') {
                dom.osd.classList.remove('osd-exit');
            }
        });

        // Update layout mode on window resize
        window.addEventListener('resize', () => {
            if (state.guideOpen) updateLayoutMode();
        });

        // Initialize guide time
        state.guideStart = new Date();

        // Init Google Cast
        initCast();

        // Init recordings worker
        initRecorderWorker();

        // Load data
        await loadCategories();
        await loadGuide();
        await loadRecordings();

        // Open guide by default
        toggleGuide();
    }

    init();
})();

