import { Component, OnInit, OnDestroy, ViewChild, ElementRef, HostListener, CUSTOM_ELEMENTS_SCHEMA, Inject, PLATFORM_ID, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService } from '../services/api.service';
import { StorageService } from '../services/storage.service';
import { CastService } from '../services/cast.service';
import { ThemeService, Theme } from '../services/theme.service';
import { LucideAngularModule } from 'lucide-angular';
import { ToastService } from '../services/toast.service';
import { ClientRecordingService } from '../services/client-recording.service';
import { DvrService } from '../services/dvr.service';
import { ClientRecording, SystemRecording } from '../services/client-recording.types';

interface Channel {
    id: string;
    name: string;
    group_title: string;
    channel_number: number;
    logo: string;
    stream_url: string;
    epg_id: string;
    enabled: number;
    current_program: any;
    programs: any[];
}

@Component({
    selector: 'app-watch',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterLink, LucideAngularModule],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
    changeDetection: ChangeDetectionStrategy.OnPush,
    templateUrl: './watch.component.html',
    styleUrl: './watch.component.css'
})
export class WatchComponent implements OnInit, OnDestroy {
    @ViewChild('videoPlayer', { static: false }) videoRef!: ElementRef<HTMLVideoElement>;
    @ViewChild('guideRows') guideRowsRef?: ElementRef<HTMLElement>;

    channels: Channel[] = [];
    filteredChannels: Channel[] = [];
    cachedFavChannels: Channel[] = [];
    cachedOtherChannels: Channel[] = [];
    timelineSlots: string[] = [];

    // Virtual Scroll State
    visibleOtherChannels: Channel[] = [];
    virtualPaddingTop = 0;
    virtualPaddingBottom = 0;
    currentScrollTop = 0;
    rowHeight = 44;

    // Server settings state
    serverSettingsOpen = false;
    serverUrl = '';
    discovering = false;
    discoveryMessage = '';
    discoveryError = false;

    categories: any[] = [];
    currentChannelIndex = -1;
    searchQuery = '';
    selectedCategories = new Set<string>();
    favorites = new Set<string>();
    hiddenChannels = new Set<string>();

    guideOpen = false;

    // UI auto-hide idle state
    userActive = true;
    private idleTimer: any = null;
    private readonly IDLE_TIMEOUT = 3000;
    dvrOpen = false;
    showWatchScheduleModal = false;
    watchSchedulePrograms: any[] = [];
    watchScheduleSelectedProgram: any = null;
    watchScheduleSearch = '';
    watchScheduleRecordSeries = false;
    watchSchedule = { channelId: '', title: '', startTime: '', endTime: '' };
    guideStart: Date | null = null;
    guideHours = 3;
    guideTimeLabel = '';
    guideStartMs = 0;
    guideEndMs = 0;
    guideHeight = 280;
    guideLayout: 'overlay' | 'side' | 'guide-only' = 'overlay';

    // Drag resize state
    private isDraggingGuide = false;
    private dragStartY = 0;
    private dragStartX = 0;
    private dragStartHeight = 0;
    private boundDragMove: any;
    private boundDragEnd: any;
    private boundOnUserActivity: any;

    volume = 0.8;
    muted = false;

    loading = false;
    error = '';
    isDocumentHidden = false;
    showInfoOverlay = false;
    showOsd = false;
    osdChannel: Channel | null = null;
    dataState: { hasChannels: boolean; hasPrograms: boolean; hasPlaylist: boolean; isEmpty: boolean } | null = null;

    // Cached active program — updated on channel switch & 10s timer
    activeProgram: any | null = null;

    toggleDiagnostics(): void {
        this.diagnosticsOpen = !this.diagnosticsOpen;
    }

    toggleThemePicker(event: MouseEvent): void {
        event.stopPropagation();
        this.themePickerOpen = !this.themePickerOpen;
    }

    selectTheme(key: string): void {
        this.themeService.setTheme(key);
        this.currentThemeKey = key;
        this.themePickerOpen = false;
    }

    get guideLayoutIcon(): string {
        return this.guideLayout === 'overlay' ? 'columns-2' : this.guideLayout === 'side' ? 'square-menu' : 'grip-horizontal';
    }

    cycleGuideLayout(): void {
        const modes: Array<'overlay' | 'side' | 'guide-only'> = ['overlay', 'side', 'guide-only'];
        const idx = modes.indexOf(this.guideLayout);
        this.guideLayout = modes[(idx + 1) % modes.length];
    }

    get isEmpty(): boolean {
        return !this.loading && this.channels.length === 0 && this.dataState?.isEmpty === true;
    }

    private hls: any = null;
    private Hls: any = null;
    private overlayTimer: any;
    private osdTimer: any;
    private infoTimer: any;
    private watchdogInterval: any = null;
    private keepAliveInterval: any = null;
    reconnecting = false;
    reconnectAttempt = 0;
    maxReconnectAttempts = 3;

    // Responsive
    isMobile = false;

    // Popout standalone video mode
    isPopoutMode = false;

    // Server Sync / Standby state
    isSyncing = false;
    serverStandby = false;
    syncMessageMinimized = false;

    // Cast State
    isCasting = false;
    castAvailable = false;

    // Current-time indicator
    currentTimeMs = 0;
    private currentTimeInterval: any = null;

    // Program tooltip state
    tooltip = {
        visible: false,
        x: 0,
        y: 0,
        program: null as any,
        channel: null as any
    };

    // Context Menu State
    contextMenu = {
        visible: false,
        x: 0,
        y: 0,
        channel: null as any,
        program: null as any
    };

    // DVR recordings — local watch recordings + read-only system DVR
    recordings: any[] = [];
    localRecordings: ClientRecording[] = [];
    systemRecordings: SystemRecording[] = [];
    recordingsByChannel: Map<string, any[]> = new Map();
    recordingsTab: 'my' | 'system' = 'my';

    get isRecordingCurrentChannel(): boolean {
        const ch = this.channels[this.currentChannelIndex];
        return ch ? this.recordingsByChannel.has(ch.id) : false;
    }

    get currentRecording(): any | null {
        if (this.currentChannelIndex < 0) return null;
        const ch = this.channels[this.currentChannelIndex];
        if (!ch) return null;
        const recs = this.recordingsByChannel.get(ch.id);
        if (!recs) return null;
        const now = Date.now();
        return recs.find(r => {
            const start = new Date(r.start_time).getTime();
            const end = new Date(r.end_time).getTime();
            return start <= now && end > now && r.status === 'recording';
        }) || null;
    }

    themes: Theme[] = [];
    currentThemeKey = 'cinematic-noir';
    themePickerOpen = false;

    diagnosticsOpen = false;
    diagnosticsData = {
        resolution: 'Unknown',
        bufferLength: 0,
        droppedFrames: 0,
        totalFrames: 0,
        bandwidth: '0 Mbps',
        latency: 0,
        codec: 'Unknown',
        playerType: 'Native / HLS.js'
    };
    private diagnosticsInterval: any = null;
    private castSub: Subscription | null = null;
    private recordingsSub: Subscription | null = null;
    private jobStatusSub: Subscription | null = null;
    private streamGeneration = 0;

    private isBrowser: boolean;

    constructor(
        private api: ApiService,
        private storage: StorageService,
        public castService: CastService,
        private themeService: ThemeService,
        private toast: ToastService,
        private clientRecordings: ClientRecordingService,
        private dvr: DvrService,
        @Inject(PLATFORM_ID) platformId: Object,
        private cdr: ChangeDetectorRef
    ) {
        this.isBrowser = isPlatformBrowser(platformId);
    }

    ngOnInit(): void {
        this.themes = this.themeService.getThemes();
        this.currentThemeKey = this.themeService.getCurrentThemeKey();

        if (!this.isBrowser) {
            this.loading = false;
            return;
        }

        const urlParams = new URLSearchParams(window.location.search);
        this.isPopoutMode = urlParams.get('popout') === 'true';

        // Idle detection: hide UI controls after inactivity
        this.boundOnUserActivity = this.onUserActivity.bind(this);
        document.addEventListener('mousemove', this.boundOnUserActivity);
        document.addEventListener('click', this.boundOnUserActivity);
        this.resetIdleTimer();

        this.isMobile = window.innerWidth < 768;
        this.serverUrl = this.getServerUrl();

        // Dynamic import of browser-only SpatialNavigation
        // @ts-ignore
        import('spatial-navigation-js').then((mod: any) => {
            const SpatialNavigation = mod.default || mod;
            SpatialNavigation.init();
            SpatialNavigation.add({
                selector: 'button, .guide-channel, .guide-program, .ch-btn, .vol-btn'
            });
            SpatialNavigation.makeFocusable();
        }).catch(() => {
            // Spatial navigation not available, skip gracefully
        });
        
        // Initialize storage with backend sync
        this.storage.init().then(() => {
            this.favorites = this.storage.getFavorites();
            this.hiddenChannels = this.storage.getHiddenChannels();
            this.applyFilters();
            this.cdr.detectChanges();
        });
        
        this.volume = this.storage.getVolume();
        this.muted = this.storage.getMuted();

        this.currentTimeMs = Date.now();
        this.updateActiveProgram();
        this.currentTimeInterval = setInterval(() => {
            this.currentTimeMs = Date.now();
            this.updateActiveProgram();
            this.cdr.markForCheck();
        }, 10000);

        this.jobStatusSub = this.api.getJobStatus().subscribe(status => {
            this.isSyncing = !!status?.running;
            if (this.isSyncing && this.channels.length === 0) {
                this.serverStandby = true;
            } else {
                this.serverStandby = false;
            }
            this.cdr.markForCheck();
        });

        this.castSub = this.castService.castState$.subscribe(state => {
            this.isCasting = state.isCasting;
            this.castAvailable = state.isAvailable;

            // If we just connected and have a channel playing, move it to the TV
            if (this.isCasting && this.currentChannelIndex >= 0) {
                this.playStream(this.channels[this.currentChannelIndex].stream_url, true);
            }
            this.cdr.detectChanges();
        });

        this.recordingsSub = this.clientRecordings.recordings$.subscribe(recordings => {
            this.localRecordings = recordings;
            this.rebuildRecordingMarkers();
            this.cdr.markForCheck();
        });

        this.updateGuideHours();

        // Bind drag handlers once
        this.boundDragMove = this.onGuideDragMove.bind(this);
        this.boundDragEnd = this.onGuideDragEnd.bind(this);

        this.loadCategories();
        this.loadGuide();
        this.loadRecordings();
    }

    updateGuideHours(): void {
        if (!this.isBrowser) return;
        // ensure guide timeline covers total screen width (1 hour = 400px, channel info = 220px)
        const minHours = Math.max(3, Math.ceil((window.innerWidth - 220) / 400) + 1);
        if (minHours !== this.guideHours) {
            this.guideHours = minHours;
            if (this.guideStart) { // Only reload if we've already initialized
                this.loadGuide();
            }
        }
    }

    ngOnDestroy(): void {
        if (this.hls) { this.hls.destroy(); this.hls = null; }
        if (this.castSub) { this.castSub.unsubscribe(); this.castSub = null; }
        if (this.recordingsSub) { this.recordingsSub.unsubscribe(); this.recordingsSub = null; }
        if (this.jobStatusSub) { this.jobStatusSub.unsubscribe(); this.jobStatusSub = null; }
        clearTimeout(this.overlayTimer);
        clearTimeout(this.osdTimer);
        clearTimeout(this.idleTimer);
        clearInterval(this.infoTimer);
        clearInterval(this.currentTimeInterval);
        clearInterval(this.diagnosticsInterval);
        clearInterval(this.watchdogInterval);
        if (this.isBrowser) {
            document.removeEventListener('mousemove', this.boundDragMove);
            document.removeEventListener('mouseup', this.boundDragEnd);
            document.removeEventListener('touchmove', this.boundDragMove);
            document.removeEventListener('touchend', this.boundDragEnd);
            document.removeEventListener('mousemove', this.boundOnUserActivity);
            document.removeEventListener('click', this.boundOnUserActivity);
        }
    }

    @HostListener('window:resize')
    onResize(): void {
        if (!this.isBrowser) return;
        this.isMobile = window.innerWidth < 768;
        this.updateGuideHours();
    }

    private wasPlayingBeforeHidden = false;

    @HostListener('document:visibilitychange')
    onVisibilityChange(): void {
        if (!this.isBrowser) return;
        this.isDocumentHidden = document.hidden;

        // On standard web browsers, tab visibility change is ineffective (audio/video continues playing).
        // Only run auto-pause on native Capacitor mobile apps when sent to background without PiP.
        const isCapacitor = !!(window as any).Capacitor?.isNativePlatform?.() || (window.location.origin && (window.location.origin.startsWith('capacitor:') || window.location.origin.startsWith('file:')));

        if (isCapacitor) {
            if (document.hidden) {
                const isPipActive = !!(document.pictureInPictureElement);
                if (!isPipActive && this.videoRef?.nativeElement) {
                    const video = this.videoRef.nativeElement;
                    if (!video.paused) {
                        this.wasPlayingBeforeHidden = true;
                        video.pause();
                    }
                }
            } else {
                if (this.wasPlayingBeforeHidden && this.videoRef?.nativeElement) {
                    this.wasPlayingBeforeHidden = false;
                    const video = this.videoRef.nativeElement;
                    video.play().catch(() => {});
                }
            }
        }

        this.cdr.markForCheck();
    }

    @HostListener('window:keydown', ['$event'])
    onKeydown(event: KeyboardEvent): void {
        if (!this.isBrowser) return;
        if ((event.target as HTMLElement).tagName === 'INPUT') return;

        switch (event.key) {
            case ' ':
            case 'k':
            case 'K':
                if (this.videoRef?.nativeElement) {
                    const video = this.videoRef.nativeElement;
                    if (video.paused) video.play().catch(() => {});
                    else video.pause();
                    event.preventDefault();
                }
                break;
            case 'PageUp': case 'ChannelUp':
                this.channelUp();
                event.preventDefault();
                break;
            case 'PageDown': case 'ChannelDown':
                this.channelDown();
                event.preventDefault();
                break;
            case '+': case '=':
                this.setVolume(Math.min(1, this.volume + 0.1));
                event.preventDefault();
                break;
            case '-': case '_':
                this.setVolume(Math.max(0, this.volume - 0.1));
                event.preventDefault();
                break;
            case 'g': case 'G': this.toggleGuide(); break;
            case 'm': case 'M': this.toggleMute(); break;
            case 'f': case 'F': this.toggleFullscreen(); break;
            case 'p': case 'P': this.togglePictureInPicture(); break;
            case 'Escape':
                if (this.serverSettingsOpen) this.serverSettingsOpen = false;
                else if (this.dvrOpen) this.dvrOpen = false;
                else if (this.guideOpen) this.toggleGuide();
                break;
            case 'Enter':
                if (!this.guideOpen && document.activeElement === document.body) {
                    this.toggleGuide();
                }
                break;
        }
    }

    // ── Guide ───────────────────────────────────
    async loadGuide(): Promise<void> {
        this.loading = true;
        try {
            const startDate = this.guideStart || new Date();
            const data = await this.api.getGuide({
                hours: this.guideHours,
                start: startDate.toISOString()
            }).toPromise();

            // Normalize all channel IDs to strings and filter enabled-only
            const rawChannels: Channel[] = (data.channels || []).map((ch: any) => ({
                ...ch,
                id: String(ch.id)
            }));
            this.channels = rawChannels.filter(ch => ch.enabled !== 0);

            this.guideStartMs = new Date(data.start).getTime();
            this.guideEndMs = new Date(data.end).getTime();

            const startD = new Date(data.start);
            const endD = new Date(data.end);
            this.guideTimeLabel = `${this.fmtTime(startD)} — ${this.fmtTime(endD)}`;

            this.applyFilters();

            // Auto-tune to popout channel, last channel, or first
            if (this.currentChannelIndex < 0 && this.channels.length > 0) {
                const urlParams = new URLSearchParams(window.location.search);
                const popoutChannelId = urlParams.get('channel');
                let idx = -1;
                if (popoutChannelId) {
                    idx = this.channels.findIndex(ch => String(ch.id) === String(popoutChannelId));
                }
                if (idx < 0) {
                    const lastId = this.storage.getLastChannel();
                    idx = lastId ? this.channels.findIndex(ch => String(ch.id) === String(lastId)) : -1;
                }
                this.tuneToChannel(idx >= 0 ? idx : 0);
            }
            this.cdr.detectChanges();
        } catch (e) {
            console.error('Failed to load guide', e);
        } finally {
            this.loading = false;
            this.cdr.detectChanges();
        }
    }

    async loadCategories(): Promise<void> {
        try {
            this.categories = await this.api.getCategories().toPromise() || [];
            this.cdr.detectChanges();
        } catch { }
    }

    guideEarlier(): void {
        const t = this.guideStart || new Date();
        this.guideStart = new Date(t.getTime() - this.guideHours * 60 * 60 * 1000);
        this.loadGuide();
    }

    guideLater(): void {
        const t = this.guideStart || new Date();
        this.guideStart = new Date(t.getTime() + this.guideHours * 60 * 60 * 1000);
        this.loadGuide();
    }

    guideNow(): void {
        this.guideStart = null;
        this.loadGuide();
    }

    toggleGuide(): void {
        this.guideOpen = !this.guideOpen;
    }

    async loadRecordings(): Promise<void> {
        try {
            this.systemRecordings = await this.api.getSystemRecordings().toPromise() || [];
            await this.clientRecordings.refresh();
            this.rebuildRecordingMarkers();
        } catch (e) {
            this.systemRecordings = [];
            this.rebuildRecordingMarkers();
        }
    }

    private rebuildRecordingMarkers(): void {
        const localMarkers = this.localRecordings.map(rec => ({
            ...rec,
            source: 'local',
            channel_id: rec.channelId,
            channel_name: rec.channelName,
            program_title: rec.programTitle,
            start_time: rec.startTime,
            end_time: rec.endTime,
            file_size: rec.sizeBytes,
            thumbnail: rec.thumbnail,
            sub_title: rec.subTitle,
            episode_num: rec.episodeNum,
            error_message: rec.errorMessage
        }));
        const systemMarkers = this.systemRecordings.map(rec => ({
            ...rec,
            source: 'system',
            channelId: rec.channel_id,
            channelName: rec.channel_name,
            programTitle: rec.program_title,
            startTime: rec.start_time,
            endTime: rec.end_time
        }));
        this.recordings = [...localMarkers, ...systemMarkers];
        this.recordingsByChannel.clear();
        for (const rec of this.recordings.filter(r => ['queued', 'scheduled', 'recording', 'completed'].includes(r.status))) {
            const chId = String(rec.channel_id);
            if (!this.recordingsByChannel.has(chId)) {
                this.recordingsByChannel.set(chId, []);
            }
            this.recordingsByChannel.get(chId)!.push(rec);
        }
    }

    hasRecording(channelId: string, programStart?: string, programEnd?: string): boolean {
        const recs = this.recordingsByChannel.get(channelId);
        if (!recs || recs.length === 0) return false;
        if (!programStart || !programEnd) return true;
        return recs.some(r => {
            const rStart = new Date(r.start_time).getTime();
            const rEnd = new Date(r.end_time).getTime();
            const pStart = new Date(programStart).getTime();
            const pEnd = new Date(programEnd).getTime();
            return rStart < pEnd && rEnd > pStart;
        });
    }

    scheduleRecording(channelId: string, programTitle: string, startTime: string, endTime: string): void {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) return;
        this.dvr.schedule({
            channel,
            programme: { title: programTitle, start: startTime, stop: endTime }
        })
            .then(outcome => {
                this.toast.show(outcome.message, 'success');
                return this.loadRecordings();
            })
            .catch(e => this.toast.show(this.dvr.describeError(e), 'error'));
    }

    cancelSchedule(recordingId: string | number): void {
        const rec = this.recordings.find(r => r.id === recordingId);
        if (rec?.source === 'local') {
            this.clientRecordings.cancel(String(recordingId)).then(() => this.loadRecordings()).catch(() => {});
        }
    }

    // ── Filtering ───────────────────────────────
    applyFilters(): void {
        let channels = this.channels;

        // Filter enabled only (safety net)
        channels = channels.filter(ch => ch.enabled !== 0);

        // Filter hidden
        if (this.hiddenChannels.size > 0) {
            channels = channels.filter(ch => !this.hiddenChannels.has(String(ch.id)));
        }

        // Filter categories
        if (this.selectedCategories.size > 0) {
            channels = channels.filter(ch => ch.group_title && this.selectedCategories.has(ch.group_title));
        }

        // Filter search
        if (this.searchQuery) {
            const q = this.searchQuery.toLowerCase();
            channels = channels.filter(ch =>
                ch.name?.toLowerCase().includes(q) ||
                ch.current_program?.title?.toLowerCase().includes(q) ||
                ch.programs?.some((p: any) => p.title?.toLowerCase().includes(q))
            );
        }

        // Sort favorites first
        const favs = channels.filter(ch => this.favorites.has(ch.id));
        const others = channels.filter(ch => !this.favorites.has(ch.id));
        this.filteredChannels = [...favs, ...others];
        this.cachedFavChannels = favs;
        this.cachedOtherChannels = others;
        this.updateVirtualScroll();

        // Pre-compute program positions and fill unguided gaps
        const pxPerMs = 200 / (30 * 60 * 1000);
        for (const ch of this.filteredChannels) {
            ch.programs = this.fillProgramGaps(ch.programs || [], this.guideStartMs, this.guideEndMs);
            for (const prog of ch.programs) {
                const start = this.parseEpgTime(prog.start);
                const stop = this.parseEpgTime(prog.stop);
                if (start && this.guideStartMs) {
                    const offsetMs = Math.max(0, start.getTime() - this.guideStartMs);
                    prog._left = (offsetMs * pxPerMs) + 'px';
                } else {
                    prog._left = '0px';
                }
                if (start && stop && this.guideStartMs && this.guideEndMs) {
                    const clampedStart = Math.max(start.getTime(), this.guideStartMs);
                    const clampedEnd = Math.min(stop.getTime(), this.guideEndMs);
                    prog._width = Math.max(40, (clampedEnd - clampedStart) * pxPerMs) + 'px';
                } else {
                    prog._width = '100px';
                }
            }
        }

        // Cache timeline slots
        this.timelineSlots = this._computeTimelineSlots();
    }

    private fillProgramGaps(programs: any[], guideStartMs: number, guideEndMs: number): any[] {
        if (!guideStartMs || !guideEndMs) return programs || [];
        
        const validProgs = (programs || [])
            .map(p => {
                const s = this.parseEpgTime(p.start);
                const e = this.parseEpgTime(p.stop);
                return {
                    ...p,
                    _startMs: s ? s.getTime() : 0,
                    _stopMs: e ? e.getTime() : 0
                };
            })
            .filter(p => p._startMs && p._stopMs && p._startMs < guideEndMs && p._stopMs > guideStartMs)
            .sort((a, b) => a._startMs - b._startMs);

        const filled: any[] = [];
        let cursor = guideStartMs;

        for (const prog of validProgs) {
            if (prog._startMs - cursor > 60000) {
                filled.push({
                    title: 'No Program Data',
                    sub_title: 'To Be Announced',
                    category: 'No Data',
                    start: new Date(cursor).toISOString(),
                    stop: new Date(prog._startMs).toISOString(),
                    isPlaceholder: true,
                    _startMs: cursor,
                    _stopMs: prog._startMs
                });
            }
            filled.push(prog);
            cursor = Math.max(cursor, prog._stopMs);
        }

        if (guideEndMs - cursor > 60000) {
            filled.push({
                title: 'No Program Data',
                sub_title: 'To Be Announced',
                category: 'No Data',
                start: new Date(cursor).toISOString(),
                stop: new Date(guideEndMs).toISOString(),
                isPlaceholder: true,
                _startMs: cursor,
                _stopMs: guideEndMs
            });
        }

        return filled;
    }

    onGuideScroll(event: Event): void {
        this.currentScrollTop = (event.target as HTMLElement).scrollTop;
        this.updateVirtualScroll();
    }

    updateVirtualScroll(): void {
        if (!this.cachedOtherChannels || this.cachedOtherChannels.length === 0) {
            this.visibleOtherChannels = [];
            this.virtualPaddingTop = 0;
            this.virtualPaddingBottom = 0;
            return;
        }

        // Calculate offset for fav channels section + dividers
        let otherSectionOffset = 0;
        if (this.cachedFavChannels.length > 0) {
            otherSectionOffset += 33 + (this.cachedFavChannels.length * this.rowHeight);
            if (this.cachedOtherChannels.length > 0) {
                otherSectionOffset += 33; // Second divider height
            }
        }

        const relativeScrollTop = Math.max(0, this.currentScrollTop - otherSectionOffset);
        let startIndex = Math.floor(relativeScrollTop / this.rowHeight);

        // 5 row buffer above and below
        const buffer = 5;
        startIndex = Math.max(0, startIndex - buffer);

        // Compute visible area manually (header+timeline take space, so height is rough)
        const visibleRowsCount = Math.ceil((this.guideHeight || 340) / this.rowHeight) + (buffer * 2);
        const endIndex = Math.min(this.cachedOtherChannels.length, startIndex + visibleRowsCount);

        this.visibleOtherChannels = this.cachedOtherChannels.slice(startIndex, endIndex);
        this.virtualPaddingTop = startIndex * this.rowHeight;
        this.virtualPaddingBottom = Math.max(0, (this.cachedOtherChannels.length - endIndex) * this.rowHeight);
        this.cdr.detectChanges();
    }

    onSearchChange(): void {
        this.applyFilters();
    }

    toggleCategory(cat: string): void {
        if (this.selectedCategories.has(cat)) {
            this.selectedCategories.delete(cat);
        } else {
            this.selectedCategories.add(cat);
        }
        this.applyFilters();
    }

    clearCategories(): void {
        this.selectedCategories.clear();
        this.applyFilters();
    }

    isCategoryActive(cat: string): boolean {
        return this.selectedCategories.has(cat);
    }

    // ── Channel Tuning ──────────────────────────
    tuneToChannel(index: number): void {
        if (index < 0 || index >= this.channels.length) return;
        this.currentChannelIndex = index;
        const ch = this.channels[index];
        this.updateActiveProgram();
        if (this.isBrowser) {
            this.playStream(ch.stream_url);
        }
        this.showOsdBriefly(ch);
        this.showInfoBriefly(ch);
        this.storage.setLastChannel(String(ch.id));
    }

    tuneToChannelById(channelId: string): void {
        const idx = this.channels.findIndex(ch => ch.id === channelId);
        if (idx >= 0) this.tuneToChannel(idx);
    }

    channelUp(): void {
        if (this.currentChannelIndex > 0) this.tuneToChannel(this.currentChannelIndex - 1);
    }

    channelDown(): void {
        if (this.currentChannelIndex < this.channels.length - 1) this.tuneToChannel(this.currentChannelIndex + 1);
    }

    get currentChannel(): Channel | null {
        return this.currentChannelIndex >= 0 ? this.channels[this.currentChannelIndex] : null;
    }

    /** Recomputes and caches the active program for the current channel. Call on tune & timer tick. */
    private updateActiveProgram(): void {
        this.activeProgram = this.computeCurrentProgram(this.currentChannel);
    }

    /** Computes the currently-airing program for a given channel (used by guide rows, not cached). */
    getCurrentProgram(ch?: Channel | null): any | null {
        const target = ch !== undefined ? ch : this.currentChannel;
        return this.computeCurrentProgram(target);
    }

    private computeCurrentProgram(target: Channel | null | undefined): any | null {
        if (!target) return null;
        const nowMs = this.currentTimeMs || Date.now();

        if (target.programs && target.programs.length > 0) {
            const active = target.programs.find((p: any) => {
                const startMs = new Date(p.start).getTime();
                const stopMs = new Date(p.stop).getTime();
                return startMs <= nowMs && stopMs > nowMs;
            });
            if (active) return active;
        }

        return target.current_program || null;
    }

    // ── Player ──────────────────────────────────
    private playStream(url: string, forceCast = false): void {
        if (!this.isBrowser) {
            this.loading = false;
            return;
        }

        this.loading = !!url && !this.isCasting;
        this.error = '';
        this.reconnecting = false;
        this.reconnectAttempt = 0;

        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        if (this.videoRef?.nativeElement) {
            this.videoRef.nativeElement.pause();
            this.videoRef.nativeElement.removeAttribute('src');
            this.videoRef.nativeElement.onplaying = null;
            this.videoRef.nativeElement.load();
        }

        if (!url) {
            this.error = 'No stream URL';
            this.loading = false;
            return;
        }

        const resolvedUrl = this.resolveUrl(url);

        if (this.isCasting || forceCast) {
            const ch = this.currentChannel;
            if (ch) {
                this.castService.loadMedia(
                     resolvedUrl,
                     ch.name,
                     ch.current_program?.title || ch.group_title,
                     this.resolveUrl(ch.logo)
                );
            }
            return;
        }

        const video = this.videoRef.nativeElement;
        video.volume = this.volume;
        video.muted = this.muted;

        // Dynamic import of hls.js for SSR compatibility
        // Track generation to guard against race conditions on rapid channel switches
        const gen = ++this.streamGeneration;
        if (!this.Hls) {
            import('hls.js').then((mod) => {
                if (gen !== this.streamGeneration) return; // channel changed while loading
                this.Hls = mod.default;
                this.setupHlsPlayback(resolvedUrl, video);
            }).catch(() => {
                if (gen !== this.streamGeneration) return;
                this.error = 'HLS player not available';
                this.loading = false;
            });
        } else {
            this.setupHlsPlayback(resolvedUrl, video);
        }
        this.startDiagnostics();
    }

    
    private startKeepAlive(url: string): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }

        let streamId = this.currentChannel?.id;
        if (url.includes('/files/streams/')) {
            const parts = url.split('/files/streams/')[1]?.split('/');
            if (parts && parts[0]) streamId = parts[0];
        }

        if (!streamId) return;

        const ping = () => {
            if (!this.isBrowser) return;
            this.api.pingStreamKeepAlive(streamId).toPromise().catch(() => {});
        };

        ping();
        this.keepAliveInterval = setInterval(ping, 10000);
    }

        private setupHlsPlayback(url: string, video: HTMLVideoElement): void {
        this.startKeepAlive(url);

        const Hls = this.Hls;
        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 90,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 10,
                liveDurationInfinity: true,
                manifestLoadingTimeOut: 10000,
                manifestLoadingMaxRetry: 5,
                fragLoadingTimeOut: 10000,
                fragLoadingMaxRetry: 5,
                startFragPrefetch: true,
                renderTextTracksNatively: true,
            });

            this.hls = hls;

            let networkRetryCount = 0;
            let mediaRetryCount = 0;
            const maxRetries = 3;

            hls.loadSource(url);
            hls.attachMedia(video);

            const resetLoadingState = () => {
                this.loading = false;
                this.reconnecting = false;
                this.reconnectAttempt = 0;
                networkRetryCount = 0;
                mediaRetryCount = 0;
                this.cdr.detectChanges();
            };

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                resetLoadingState();
                video.play().catch(() => { });
            });

            hls.on(Hls.Events.FRAG_LOADED, () => {
                if (this.loading || this.reconnecting) {
                    resetLoadingState();
                }
            });

            video.onplaying = () => {
                resetLoadingState();
            };

            hls.on(Hls.Events.ERROR, (_: any, data: any) => {
                if (data.fatal) {
                    console.warn(`HLS fatal error: ${data.type} - ${data.details}`);
                    this.reconnecting = true;
                    this.loading = true;

                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        networkRetryCount++;
                        this.reconnectAttempt = networkRetryCount;
                        this.cdr.detectChanges();

                        if (networkRetryCount <= maxRetries) {
                            console.log(`Retrying network connection (${networkRetryCount}/${maxRetries})...`);
                            setTimeout(() => {
                                if (this.hls === hls) {
                                    hls.startLoad(-1);
                                    video.play().catch(() => {});
                                }
                            }, 1500);
                        } else {
                            console.error('Max network retries exceeded. Full stream re-tune...');
                            networkRetryCount = 0;
                            if (this.currentChannel?.stream_url) {
                                this.playStream(this.currentChannel.stream_url);
                            }
                        }
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        mediaRetryCount++;
                        this.reconnectAttempt = mediaRetryCount;
                        this.cdr.detectChanges();

                        if (mediaRetryCount <= 1) {
                            console.log('Attempting media error recovery...');
                            hls.recoverMediaError();
                            video.play().catch(() => {});
                        } else if (mediaRetryCount === 2) {
                            console.log('Swapping audio codec...');
                            hls.swapAudioCodec();
                            hls.recoverMediaError();
                            video.play().catch(() => {});
                        } else {
                            console.error('Max media recovery retries exceeded. Re-tuning stream...');
                            mediaRetryCount = 0;
                            if (this.currentChannel?.stream_url) {
                                this.playStream(this.currentChannel.stream_url);
                            }
                        }
                    } else {
                        this.error = 'Stream playback failed';
                        this.loading = false;
                        this.reconnecting = false;
                        hls.destroy();
                        this.cdr.detectChanges();
                    }
                }
            });

            // Watchdog Stall Checker
            let lastCurrentTime = -1;
            let lastTimeChanged = Date.now();
            if (this.watchdogInterval) {
                clearInterval(this.watchdogInterval);
            }

            this.watchdogInterval = setInterval(() => {
                if (!this.hls || this.hls !== hls) return;

                if (video.paused || video.ended) {
                    lastTimeChanged = Date.now();
                    lastCurrentTime = video.currentTime;
                    return;
                }

                if (video.currentTime === lastCurrentTime) {
                    const stallDuration = Date.now() - lastTimeChanged;
                    
                    if (stallDuration > 4000) {
                        console.warn(`Playback watchdog: Stalled for ${Math.floor(stallDuration / 1000)}s!`);
                        this.reconnecting = true;
                        this.loading = true;
                        networkRetryCount++;
                        this.reconnectAttempt = networkRetryCount;
                        this.cdr.detectChanges();

                        // Try jump ahead if buffer exists
                        if (video.buffered.length > 0) {
                            const bufEnd = video.buffered.end(video.buffered.length - 1);
                            if (bufEnd > video.currentTime + 1) {
                                console.log('Watchdog: Jumping to buffered position...');
                                video.currentTime = bufEnd - 0.5;
                            }
                        }

                        if (stallDuration > 12000) {
                            console.error('Watchdog: Stall extended beyond 12s. Re-tuning stream...');
                            lastTimeChanged = Date.now();
                            if (this.currentChannel?.stream_url) {
                                this.playStream(this.currentChannel.stream_url);
                            }
                        } else {
                            hls.startLoad(-1);
                            hls.recoverMediaError();
                            video.play().catch(() => {});
                        }
                    }
                } else {
                    lastCurrentTime = video.currentTime;
                    lastTimeChanged = Date.now();
                    if (this.loading || this.reconnecting) {
                        resetLoadingState();
                    }
                }
            }, 1000);

        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            let nativeRetryCount = 0;

            if (this.watchdogInterval) {
                clearInterval(this.watchdogInterval);
            }

            video.addEventListener('loadedmetadata', () => { 
                this.loading = false; 
                this.reconnecting = false;
                this.reconnectAttempt = 0;
                nativeRetryCount = 0;
                this.cdr.detectChanges();
                video.play().catch(() => { }); 
            }, { once: true });
            
            const streamGenAtSetup = this.streamGeneration;
            const handleNativeError = () => {
                if (streamGenAtSetup !== this.streamGeneration) return;
                nativeRetryCount++;
                this.reconnectAttempt = nativeRetryCount;
                this.reconnecting = true;
                this.loading = true;
                this.cdr.detectChanges();

                if (nativeRetryCount <= 3) {
                    setTimeout(() => {
                        if (streamGenAtSetup !== this.streamGeneration) return;
                        video.load();
                        video.play().catch(() => { });
                    }, 2000);
                } else {
                    this.error = 'Playback failed';
                    this.loading = false;
                    this.reconnecting = false;
                    this.cdr.detectChanges();
                }
            };
            video.addEventListener('error', handleNativeError, { once: true });

            let lastCurrentTime = -1;
            let lastTimeChanged = Date.now();
            this.watchdogInterval = setInterval(() => {
                if (video.paused || video.ended) {
                    lastTimeChanged = Date.now();
                    lastCurrentTime = video.currentTime;
                    return;
                }

                if (video.currentTime === lastCurrentTime) {
                    const stallDuration = Date.now() - lastTimeChanged;
                    if (stallDuration > 5000) {
                        console.warn('Native playback watchdog: Stalled stream detected!');
                        this.reconnecting = true;
                        this.loading = true;
                        nativeRetryCount++;
                        this.reconnectAttempt = nativeRetryCount;
                        this.cdr.detectChanges();

                        lastTimeChanged = Date.now();

                        if (nativeRetryCount <= 3) {
                            video.load();
                            video.play().catch(() => { });
                        } else {
                            console.error('Native watchdog: Max retries exceeded.');
                            this.error = 'Playback stalled';
                            this.loading = false;
                            this.reconnecting = false;
                            this.cdr.detectChanges();
                        }
                    }
                } else {
                    lastCurrentTime = video.currentTime;
                    lastTimeChanged = Date.now();
                }
            }, 1000);
        }
    }

    private startDiagnostics(): void {
        if (this.diagnosticsInterval) clearInterval(this.diagnosticsInterval);
        
        this.diagnosticsInterval = setInterval(() => {
            if (!this.diagnosticsOpen) return;
            
            const video = this.videoRef?.nativeElement;
            if (!video) return;

            const data = this.diagnosticsData;
            
            // Basic video element stats
            data.resolution = video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : 'Unknown';
            data.bufferLength = 0;
            
            for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) > video.currentTime) {
                    data.bufferLength = video.buffered.end(i) - video.currentTime;
                    break;
                }
            }

            // HLS.js specific stats
            if (this.hls) {
                data.playerType = 'HLS.js';
                const currentLevelIdx = this.hls.currentLevel === -1 ? this.hls.loadLevel : this.hls.currentLevel;
                const level = this.hls.levels[currentLevelIdx];
                if (level) {
                    data.bandwidth = level.bitrate ? `${(level.bitrate / 1000000).toFixed(2)} Mbps` : 'Unknown';
                    data.codec = level.codec || level.videoCodec || 'Unknown';
                }
                data.latency = this.hls.latency || 0;
            } else {
                data.playerType = 'Native';
                data.bandwidth = 'Native (Unknown)';
                data.codec = 'Native';
                data.latency = 0;
            }
            
            if ((video as any).webkitDroppedFrameCount !== undefined) {
                data.droppedFrames = (video as any).webkitDroppedFrameCount;
                data.totalFrames = (video as any).webkitDecodedFrameCount;
            } else if ((video as any).getVideoPlaybackQuality) {
                const quality = (video as any).getVideoPlaybackQuality();
                data.droppedFrames = quality.droppedVideoFrames;
                data.totalFrames = quality.totalVideoFrames;
            }
            
            this.cdr.detectChanges();
        }, 1000);
    }

    async playLocalRecording(rec: ClientRecording): Promise<void> {
        const url = await this.clientRecordings.createPlaybackUrl(rec.id);
        if (!url) {
            this.toast.show('No captured video segments are available for this recording', 'warning');
            return;
        }
        this.dvrOpen = false;
        this.playStream(url);
    }

    playSystemRecording(rec: SystemRecording): void {
        if (!rec.url || !this.videoRef?.nativeElement) return;
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
        this.dvrOpen = false;
        this.loading = false;
        this.error = '';
        const video = this.videoRef.nativeElement;
        video.pause();
        video.src = this.resolveUrl(rec.url);
        video.volume = this.volume;
        video.muted = this.muted;
        video.load();
        video.play().catch(() => {});
    }

    async downloadLocalRecording(rec: ClientRecording): Promise<void> {
        await this.clientRecordings.download(rec.id);
    }

    async cancelLocalRecording(rec: ClientRecording): Promise<void> {
        await this.clientRecordings.cancel(rec.id);
        await this.loadRecordings();
    }

    async deleteLocalRecording(rec: ClientRecording): Promise<void> {
        if (!confirm(`Delete '${rec.programTitle}' from My Recordings?`)) return;
        await this.clientRecordings.delete(rec.id);
        await this.loadRecordings();
    }

    async openWatchScheduleModal(): Promise<void> {
        const now = new Date();
        const end = new Date(now.getTime() + 60 * 60 * 1000);
        this.watchSchedule = {
            channelId: this.currentChannel?.id || '',
            title: this.currentChannel?.current_program?.title || '',
            startTime: new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16),
            endTime: new Date(end.getTime() - end.getTimezoneOffset() * 60000).toISOString().slice(0, 16),
        };
        this.watchSchedulePrograms = [];
        this.watchScheduleSelectedProgram = null;
        this.watchScheduleSearch = '';
        this.watchScheduleRecordSeries = false;
        this.showWatchScheduleModal = true;
        if (this.watchSchedule.channelId) {
            await this.onWatchScheduleChannelSelect();
        }
        this.cdr.markForCheck();
    }

    async onWatchScheduleChannelSelect(): Promise<void> {
        this.watchSchedulePrograms = [];
        this.watchScheduleSelectedProgram = null;
        this.watchScheduleSearch = '';
        this.watchScheduleRecordSeries = false;
        if (!this.watchSchedule.channelId) return;
        const channel = this.channels.find(ch => ch.id === this.watchSchedule.channelId);
        if (channel?.programs?.length) {
            this.watchSchedulePrograms = channel.programs;
        } else {
            try {
                const response = await this.api.getChannelPrograms(this.watchSchedule.channelId).toPromise();
                this.watchSchedulePrograms = response?.programs || [];
            } catch {
                this.watchSchedulePrograms = [];
            }
        }
        this.cdr.markForCheck();
    }

    get filteredWatchSchedulePrograms(): any[] {
        const query = this.watchScheduleSearch.trim().toLowerCase();
        if (!query) return this.watchSchedulePrograms;
        return this.watchSchedulePrograms.filter(program => (program.title || '').toLowerCase().includes(query));
    }

    selectWatchScheduleProgram(program: any): void {
        this.watchScheduleSelectedProgram = program;
        this.watchScheduleRecordSeries = this.watchScheduleRecordSeries && this.isSeriesCandidate(program, this.watchSchedulePrograms);
        this.watchSchedule.title = program.title || '';
        const start = this.parseEpgTime(program.start);
        const stop = this.parseEpgTime(program.stop);
        if (start && stop) {
            this.watchSchedule.startTime = new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            this.watchSchedule.endTime = new Date(stop.getTime() - stop.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
    }

    async submitWatchSchedule(): Promise<void> {
        const channel = this.channels.find(ch => ch.id === this.watchSchedule.channelId);
        if (!channel || !this.watchSchedule.title || !this.watchSchedule.startTime || !this.watchSchedule.endTime) {
            this.toast.show('Channel, title, start, and end are required', 'warning');
            return;
        }

        const selected = this.watchScheduleSelectedProgram;
        const wantsSeries = this.watchScheduleRecordSeries
            && !!selected
            && this.isSeriesCandidate(selected, this.watchSchedulePrograms);

        // The same request shape the admin screen sends. DvrService decides
        // where it goes: the server when signed in, this browser otherwise.
        const programme = wantsSeries
            ? {
                title: selected.title,
                start: selected.start,
                stop: selected.stop,
                sub_title: selected.sub_title,
                episode_num: selected.episode_num,
                description: selected.description,
                category: selected.category,
                rating: selected.rating,
                icon: selected.icon
            }
            : {
                title: this.watchSchedule.title,
                start: new Date(this.watchSchedule.startTime).toISOString(),
                stop: new Date(this.watchSchedule.endTime).toISOString(),
                sub_title: selected?.sub_title,
                episode_num: selected?.episode_num,
                description: selected?.description,
                category: selected?.category,
                rating: selected?.rating,
                icon: selected?.icon
            };

        try {
            const outcome = await this.dvr.schedule({ channel, programme, series: wantsSeries });
            this.toast.show(outcome.message, 'success');
            this.showWatchScheduleModal = false;
            await this.loadRecordings();
        } catch (error) {
            this.toast.show(this.dvr.describeError(error, 'Failed to schedule that recording'), 'error');
        }
    }

    recordingTitle(rec: ClientRecording | SystemRecording): string {
        return 'programTitle' in rec ? rec.programTitle : rec.program_title;
    }

    // Shared with the admin DVR screen through DvrService — these were
    // separate copies that had already begun to diverge.
    isSeriesCandidate(program: any, programs: any[] = []): boolean {
        return this.dvr.isSeriesCandidate(program, programs);
    }

    /** The reason a recording ended as it did, from either recorder. */
    failureReason(rec: any): string | null {
        return this.dvr.failureReason(rec);
    }

    recordingStatusLabel(status: string): string {
        return this.dvr.statusLabel(status);
    }

    recordingChannel(rec: ClientRecording | SystemRecording): string {
        return 'channelName' in rec ? rec.channelName : rec.channel_name;
    }

    recordingThumbnail(rec: ClientRecording | SystemRecording): string | null {
        return 'thumbnail' in rec ? rec.thumbnail : null;
    }

    recordingStart(rec: ClientRecording | SystemRecording): string {
        return 'startTime' in rec ? rec.startTime : rec.start_time;
    }

    recordingEnd(rec: ClientRecording | SystemRecording): string {
        return 'endTime' in rec ? rec.endTime : rec.end_time;
    }

    recordingEpisode(rec: ClientRecording | SystemRecording): string {
        const subTitle = 'subTitle' in rec ? rec.subTitle : rec.sub_title;
        const episode = 'episodeNum' in rec ? rec.episodeNum : rec.episode_num;
        return [episode, subTitle].filter(Boolean).join(' - ');
    }

    recordingSize(rec: ClientRecording | SystemRecording): number {
        return 'sizeBytes' in rec ? rec.sizeBytes : (rec.file_size || 0);
    }

    fmtRecordingTime(start: string, end: string): string {
        const s = new Date(start);
        const e = new Date(end);
        if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
        return `${s.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${this.fmtTime(s)} - ${this.fmtTime(e)}`;
    }

    fmtBytes(bytes: number): string {
        return this.dvr.formatBytes(bytes);
    }

    // ── Volume ──────────────────────────────────
    setVolume(val: number): void {
        this.volume = Math.max(0, Math.min(1, val));
        this.muted = false;
        if (this.videoRef?.nativeElement) {
            this.videoRef.nativeElement.volume = this.volume;
            this.videoRef.nativeElement.muted = false;
        }
        this.storage.setVolume(this.volume);
        this.storage.setMuted(false);
    }

    onVolumeSlider(event: Event): void {
        const val = parseInt((event.target as HTMLInputElement).value) / 100;
        this.setVolume(val);
    }

    toggleMute(): void {
        this.muted = !this.muted;
        if (this.videoRef?.nativeElement) {
            this.videoRef.nativeElement.muted = this.muted;
        }
        this.storage.setMuted(this.muted);
    }

    // ── Favorites ───────────────────────────────
    async toggleFavorite(channelId: string): Promise<void> {
        this.favorites = await this.storage.toggleFavorite(channelId);
        this.applyFilters();
    }

    isFavorite(channelId: string): boolean {
        return this.favorites.has(channelId);
    }

    // ── Hidden ──────────────────────────────────
    async toggleHidden(channelId: string): Promise<void> {
        this.hiddenChannels = await this.storage.toggleHidden(channelId);
        this.applyFilters();
    }

    // ── OSD & Info ──────────────────────────────
    private showOsdBriefly(ch: Channel): void {
        this.osdChannel = ch;
        this.showOsd = true;
        clearTimeout(this.osdTimer);
        this.osdTimer = setTimeout(() => { this.showOsd = false; }, 3000);
    }

    private showInfoBriefly(ch: Channel): void {
        this.showInfoOverlay = true;
        clearTimeout(this.overlayTimer);
        if (!this.guideOpen) {
            this.overlayTimer = setTimeout(() => { this.showInfoOverlay = false; }, 5000);
        }
    }

    // ── Program Helpers ─────────────────────────
    /**
     * Shared with the DVR screen. This copy used to discard everything after
     * the timestamp — including the `+0200` — and read every programme as UTC,
     * so a non-UTC feed placed shows in the wrong hour here but not there.
     */
    parseEpgTime(str: string): Date | null {
        return this.dvr.parseEpgTime(str);
    }

    fmtTime(date: Date): string {
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    fmtTimeRange(start: string, stop: string): string {
        const s = this.parseEpgTime(start);
        const e = this.parseEpgTime(stop);
        if (!s || !e) return '';
        return `${this.fmtTime(s)} – ${this.fmtTime(e)}`;
    }

    programProgress(start: string, stop: string): number {
        const s = this.parseEpgTime(start);
        const e = this.parseEpgTime(stop);
        if (!s || !e) return 0;
        const now = Date.now();
        if (now < s.getTime()) return 0;
        if (now > e.getTime()) return 100;
        return ((now - s.getTime()) / (e.getTime() - s.getTime())) * 100;
    }

    programLeft(prog: any): string {
        if (!this.guideStartMs) return '0px';
        const start = this.parseEpgTime(prog.start);
        if (!start) return '0px';
        const offsetMs = Math.max(0, start.getTime() - this.guideStartMs);
        const pxPerMs = 200 / (30 * 60 * 1000);
        return (offsetMs * pxPerMs) + 'px';
    }

    programWidth(prog: any): string {
        const start = this.parseEpgTime(prog.start);
        const stop = this.parseEpgTime(prog.stop);
        if (!start || !stop) return '100px';
        const clampedStart = Math.max(start.getTime(), this.guideStartMs);
        const clampedEnd = Math.min(stop.getTime(), this.guideEndMs);
        const durationMs = clampedEnd - clampedStart;
        const pxPerMs = 200 / (30 * 60 * 1000);
        return Math.max(40, durationMs * pxPerMs) + 'px';
    }

    private _computeTimelineSlots(): string[] {
        if (!this.guideStartMs || !this.guideEndMs) return [];
        const slots: string[] = [];
        let t = this.guideStartMs;
        while (t < this.guideEndMs) {
            slots.push(this.fmtTime(new Date(t)));
            t += 30 * 60 * 1000;
        }
        return slots;
    }

    getOriginalIndex(ch: Channel): number {
        return this.channels.indexOf(ch);
    }

    /** O(1) active channel check for guide rows — avoids O(N) indexOf per row per render. */
    isActiveChannel(ch: Channel): boolean {
        return !!this.currentChannel && ch.id === this.currentChannel.id;
    }

    getCategoryIcon(name: string): string {
        const icons: Record<string, string> = {
            news: 'newspaper', sports: 'trophy', entertainment: 'monitor', movies: 'film',
            music: 'music', kids: 'baby', education: 'globe', documentary: 'video',
            science: 'globe', travel: 'globe', food: 'globe', comedy: 'monitor',
            drama: 'monitor', lifestyle: 'heart-pulse', weather: 'globe', business: 'globe',
            religious: 'radio', animation: 'film', general: 'monitor', family: 'heart-pulse',
            gaming: 'radio'
        };
        if (!name) return 'folder-tree';
        return icons[name.toLowerCase()] || 'folder-tree';
    }

    get favChannels(): Channel[] {
        return this.cachedFavChannels;
    }

    get otherChannels(): Channel[] {
        return this.visibleOtherChannels;
    }

    // ── Guide Drag Resize ───────────────────────
    onGuideDragStart(event: MouseEvent | TouchEvent): void {
        if (!this.isBrowser) return;
        event.preventDefault();
        this.isDraggingGuide = true;
        this.dragStartY = 'touches' in event ? event.touches[0].clientY : event.clientY;
        this.dragStartX = 'touches' in event ? event.touches[0].clientX : event.clientX;
        this.dragStartHeight = this.guideHeight;
        document.addEventListener('mousemove', this.boundDragMove);
        document.addEventListener('mouseup', this.boundDragEnd);
        document.addEventListener('touchmove', this.boundDragMove);
        document.addEventListener('touchend', this.boundDragEnd);
    }

    private onGuideDragMove(event: MouseEvent | TouchEvent): void {
        if (!this.isDraggingGuide || !this.isBrowser) return;
        const clientY = 'touches' in event ? (event as TouchEvent).touches[0].clientY : (event as MouseEvent).clientY;
        const clientX = 'touches' in event ? (event as TouchEvent).touches[0].clientX : (event as MouseEvent).clientX;

        if (this.guideLayout === 'guide-only') {
            const deltaY = clientY - this.dragStartY;
            if (deltaY > 30) {
                this.guideLayout = 'overlay';
                this.guideHeight = window.innerHeight * 0.5 - 20;
                this.isDraggingGuide = false; // prevent jitter
            }
        } else if (this.guideLayout === 'side') {
            const deltaX = this.dragStartX - clientX; // dragging left = increase width
            const startWidth = this.dragStartHeight * 1.6;
            const maxSideWidth = window.innerWidth * 0.5; // max 50% of viewport
            const newWidth = Math.max(200, Math.min(maxSideWidth, startWidth + deltaX));
            // If at max width, auto-transition to guide-only layout
            if (newWidth >= maxSideWidth) {
                this.guideLayout = 'guide-only';
            }
            this.guideHeight = newWidth / 1.6;
        } else {
            const delta = this.dragStartY - clientY; // dragging up = increase height
            const maxOverlayHeight = window.innerHeight * 0.5; // max 50% of viewport
            const newHeight = Math.max(200, Math.min(maxOverlayHeight, this.dragStartHeight + delta));
            // If at max height, auto-transition to guide-only layout
            if (newHeight >= maxOverlayHeight) {
                this.guideLayout = 'guide-only';
            }
            this.guideHeight = newHeight;
        }
        this.cdr.detectChanges();
    }

    private onGuideDragEnd(): void {
        this.isDraggingGuide = false;
        if (this.isBrowser) {
            document.removeEventListener('mousemove', this.boundDragMove);
            document.removeEventListener('mouseup', this.boundDragEnd);
            document.removeEventListener('touchmove', this.boundDragMove);
            document.removeEventListener('touchend', this.boundDragEnd);
        }
    }

    // ── UI Idle Auto-Hide ───────────────────────
    onUserActivity(): void {
        if (!this.userActive) {
            this.userActive = true;
            this.cdr.markForCheck();
        }
        this.resetIdleTimer();
    }

    private resetIdleTimer(): void {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            // Only hide if NOT interacting with guide/overlays
            if (!this.guideOpen && !this.dvrOpen && !this.serverSettingsOpen && !this.themePickerOpen && !this.diagnosticsOpen) {
                this.userActive = false;
                this.cdr.markForCheck();
            }
        }, this.IDLE_TIMEOUT);
    }

    // ── Fullscreen & Popout / PiP Controls ──────
    isFullscreen = false;

    toggleFullscreen(): void {
        if (!this.isBrowser) return;
        const playerElem = (this.videoRef?.nativeElement as HTMLElement) || document.querySelector('.player-area');
        if (!playerElem) return;

        if (!document.fullscreenElement) {
            if (playerElem.requestFullscreen) {
                playerElem.requestFullscreen().catch(() => {});
            } else if ((playerElem as any).webkitRequestFullscreen) {
                (playerElem as any).webkitRequestFullscreen();
            }
            this.isFullscreen = true;
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            } else if ((document as any).webkitExitFullscreen) {
                (document as any).webkitExitFullscreen();
            }
            this.isFullscreen = false;
        }
        this.cdr.markForCheck();
    }

    @HostListener('document:fullscreenchange')
    onFullscreenChange(): void {
        if (!this.isBrowser) return;
        this.isFullscreen = !!document.fullscreenElement;
        this.cdr.markForCheck();
    }

    async togglePictureInPicture(): Promise<void> {
        if (!this.isBrowser || !this.videoRef) return;
        const video = this.videoRef.nativeElement;
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && video) {
                await video.requestPictureInPicture();
            } else {
                this.popoutWindow();
            }
        } catch (e) {
            this.popoutWindow();
        }
    }

    popoutWindow(): void {
        if (!this.isBrowser) return;
        const ch = this.channels[this.currentChannelIndex];
        const targetUrl = `/watch?popout=true${ch ? '&channel=' + ch.id : ''}`;

        const isNativeApp = !!(window as any).Capacitor?.isNativePlatform?.() || (window.location.origin && window.location.origin.startsWith('capacitor:'));
        if (this.isMobile || isNativeApp) {
            window.location.href = targetUrl;
            return;
        }

        const pop = window.open(
            targetUrl,
            'TunerDaemon_Popout',
            'width=854,height=480,resizable=yes,status=no,location=no,toolbar=no,menubar=no'
        );
        if (!pop) {
            window.location.href = targetUrl;
        }
    }

    closePopout(): void {
        if (!this.isBrowser) return;
        try {
            window.close();
        } catch (_) {}

        if (this.isPopoutMode) {
            const ch = this.channels[this.currentChannelIndex];
            const targetUrl = `/watch${ch ? '?channel=' + ch.id : ''}`;
            window.location.href = targetUrl;
        }
    }

    toggleSyncMessageMinimization(): void {
        this.syncMessageMinimized = !this.syncMessageMinimized;
        this.cdr.markForCheck();
    }

    onProgramHover(event: MouseEvent, channel: Channel, program: any) {
        this.tooltip = {
            visible: true,
            x: Math.min(event.clientX, window.innerWidth - 320),
            y: Math.min(event.clientY, window.innerHeight - 200),
            program,
            channel
        };
        this.cdr.markForCheck();
    }

    hideProgramTooltip() {
        this.tooltip.visible = false;
        this.cdr.markForCheck();
    }

    // ── Mobile Swipe ────────────────────────────
    private touchStartX = 0;
    private touchStartY = 0;

    onGuideTouchStart(event: TouchEvent) {
        this.touchStartX = event.touches[0].clientX;
        this.touchStartY = event.touches[0].clientY;
    }

    onGuideTouchEnd(event: TouchEvent) {
        const dx = event.changedTouches[0].clientX - this.touchStartX;
        const dy = event.changedTouches[0].clientY - this.touchStartY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
            if (dx > 0) this.guideEarlier();
            else this.guideLater();
        }
    }

    @HostListener('document:click', ['$event'])
    onDocumentClick(event: MouseEvent) {
        if (this.contextMenu.visible) {
            this.contextMenu.visible = false;
            this.cdr.markForCheck();
        }
    }

    onProgramContextMenu(event: MouseEvent, channel: Channel, program: any) {
        event.preventDefault();
        event.stopPropagation();
        this.contextMenu = {
            visible: true,
            x: event.clientX,
            y: event.clientY,
            channel,
            program
        };
        this.cdr.markForCheck();
    }

    async recordProgram(channel: Channel, program: any) {
        this.contextMenu.visible = false;
        this.cdr.markForCheck();
        try {
            const outcome = await this.dvr.schedule({ channel, programme: program });
            await this.loadRecordings();
            this.toast.show(outcome.message, 'success');
        } catch (e) {
            this.toast.show(this.dvr.describeError(e, 'Failed to schedule recording'), 'error');
        }
    }

    async recordSeries(channel: Channel, program: any) {
        this.contextMenu.visible = false;
        this.cdr.markForCheck();

        if (!this.isSeriesCandidate(program, channel.programs || [])) {
            this.toast.show('Series recording is only available for shows with episode metadata', 'warning');
            return;
        }

        try {
            // One request. The server keeps the rule and books episodes as the
            // guide grows; looping the loaded window here only ever caught what
            // was already on screen.
            const outcome = await this.dvr.schedule({ channel, programme: program, series: true });
            this.toast.show(outcome.message, 'success');
            await this.loadRecordings();
        } catch (e) {
            this.toast.show(this.dvr.describeError(e, 'Failed to schedule that series'), 'error');
        }
    }

    getRecordingForProgram(channelId: string | undefined, programStart: string, programEnd: string): any | null {
        if (!channelId) return null;
        const recs = this.recordingsByChannel.get(channelId) || [];
        const pStart = this.parseEpgTime(programStart)?.getTime() || 0;
        const pEnd = this.parseEpgTime(programEnd)?.getTime() || 0;
        if (!pStart || !pEnd) return null;
        return recs.find(r => {
            const rStart = new Date(r.start_time).getTime();
            const rEnd = new Date(r.end_time).getTime();
            return rStart < pEnd && rEnd > pStart;
        }) || null;
    }

    async cancelRecordingFromMenu(channel: Channel, program: any) {
        this.contextMenu.visible = false;
        this.cdr.markForCheck();
        const recs = this.recordingsByChannel.get(channel.id) || [];
        const parsedStart = this.parseEpgTime(program.start);
        const parsedEnd = this.parseEpgTime(program.stop);
        const pStart = parsedStart ? parsedStart.getTime() : new Date(program.start).getTime();
        const pEnd = parsedEnd ? parsedEnd.getTime() : new Date(program.stop).getTime();
        const toCancel = recs.filter(r => {
            const rStart = new Date(r.start_time).getTime();
            const rEnd = new Date(r.end_time).getTime();
            return rStart < pEnd && rEnd > pStart;
        });

        if (toCancel.length > 0) {
            const rec = toCancel[0];
            if (rec.source === 'system') {
                this.toast.show('System recordings are managed from the admin DVR page', 'info');
                return;
            }
            const actionText = (rec.status === 'queued' || rec.status === 'recording') ? 'cancel this recording' : 'delete this recording';
            if (!confirm(`Are you sure you want to ${actionText}?`)) return;

            for (const r of toCancel) {
                try {
                    if (r.status === 'queued' || r.status === 'recording') {
                        await this.clientRecordings.cancel(String(r.id));
                    } else {
                        await this.clientRecordings.delete(String(r.id));
                    }
                } catch (e) {
                    console.error('Failed to cancel recording', e);
                }
            }
            await this.loadRecordings();
            this.toast.show((rec.status === 'queued' || rec.status === 'recording') ? 'Recording cancelled' : 'Recording deleted', 'success');
        }
    }

    resolveUrl(url: string): string {
        if (!url) return '';
        if (url.startsWith('/')) {
            const serverUrl = this.getServerUrl();
            if (serverUrl) {
                return `${serverUrl.replace(/\/+$/, '')}${url}`;
            }
        }
        return url;
    }

    getServerUrl(): string {
        if (!this.isBrowser) return '';
        let serverUrl = localStorage.getItem('tuner_daemon_server_url');
        if (!serverUrl) {
            const origin = window.location.origin || '';
            if (origin.startsWith('capacitor:') || 
                origin === 'http://localhost' || 
                origin === 'https://localhost' || 
                origin.startsWith('file:')) {
                serverUrl = 'https://teevee.christopherrutherford.net';
            } else if (origin.includes(':4200')) {
                serverUrl = 'http://localhost:3000';
            } else {
                serverUrl = origin;
            }
        }
        return serverUrl;
    }

    saveServerUrl(): void {
        if (!this.isBrowser) return;
        let url = this.serverUrl.trim();
        if (url && !/^https?:\/\//i.test(url)) {
            url = 'http://' + url;
        }
        localStorage.setItem('tuner_daemon_server_url', url);
        this.serverSettingsOpen = false;
        this.loadCategories();
        this.loadGuide();
        this.loadRecordings();
    }

    async checkHealth(url: string): Promise<boolean> {
        try {
            const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) {
                const data = await res.json();
                return data && data.status === 'ok';
            }
        } catch { }
        return false;
    }

    async discoverLocalServer(): Promise<void> {
        if (!this.isBrowser) return;
        this.discovering = true;
        this.discoveryError = false;
        this.discoveryMessage = 'Scanning local network for Tuner Daemon server...';
        this.cdr.markForCheck();

        const targets = new Set<string>();
        targets.add('http://localhost:3000');
        if (window.location.origin && !window.location.origin.includes('localhost') && !window.location.origin.startsWith('capacitor:')) {
            targets.add(window.location.origin);
        }

        const subnets = ['192.168.1', '192.168.0', '192.168.2', '10.0.0'];
        const port = 3000;

        for (const subnet of subnets) {
            for (let i = 1; i <= 254; i++) {
                targets.add(`http://${subnet}.${i}:${port}`);
            }
        }

        const targetArray = Array.from(targets);
        this.discoveryMessage = `Scanning ${targetArray.length} potential local endpoints...`;
        this.cdr.markForCheck();

        const batchSize = 50;
        let foundUrl = '';

        for (let i = 0; i < targetArray.length; i += batchSize) {
            if (foundUrl) break;
            const batch = targetArray.slice(i, i + batchSize);
            this.discoveryMessage = `Scanning local network... (${Math.round((i / targetArray.length) * 100)}%)`;
            this.cdr.markForCheck();

            await Promise.all(
                batch.map(async (url) => {
                    if (foundUrl) return;
                    const ok = await this.checkHealth(url);
                    if (ok) {
                        foundUrl = url;
                    }
                })
            );
        }

        if (foundUrl) {
            this.serverUrl = foundUrl;
            this.discoveryError = false;
            this.discoveryMessage = `Success! Found server at ${foundUrl}`;
        } else {
            this.discoveryError = true;
            this.discoveryMessage = 'No server found. Please enter the URL manually.';
        }
        this.discovering = false;
        this.cdr.markForCheck();
    }
}
