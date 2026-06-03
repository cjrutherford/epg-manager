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

    volume = 0.8;
    muted = false;

    loading = false;
    error = '';
    isDocumentHidden = false;
    showInfoOverlay = false;
    showOsd = false;
    osdChannel: Channel | null = null;
    dataState: { hasChannels: boolean; hasPrograms: boolean; hasPlaylist: boolean; isEmpty: boolean } | null = null;

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
    reconnecting = false;
    reconnectAttempt = 0;
    maxReconnectAttempts = 3;

    // Responsive
    isMobile = false;

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

    private isBrowser: boolean;

    constructor(
        private api: ApiService,
        private storage: StorageService,
        public castService: CastService,
        private themeService: ThemeService,
        private toast: ToastService,
        private clientRecordings: ClientRecordingService,
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
        this.currentTimeInterval = setInterval(() => {
            this.currentTimeMs = Date.now();
            this.cdr.markForCheck();
        }, 60000);

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
        clearTimeout(this.overlayTimer);
        clearTimeout(this.osdTimer);
        clearInterval(this.infoTimer);
        clearInterval(this.currentTimeInterval);
        clearInterval(this.diagnosticsInterval);
        clearInterval(this.watchdogInterval);
        if (this.isBrowser) {
            document.removeEventListener('mousemove', this.boundDragMove);
            document.removeEventListener('mouseup', this.boundDragEnd);
            document.removeEventListener('touchmove', this.boundDragMove);
            document.removeEventListener('touchend', this.boundDragEnd);
        }
    }

    @HostListener('window:resize')
    onResize(): void {
        if (!this.isBrowser) return;
        this.isMobile = window.innerWidth < 768;
        this.updateGuideHours();
    }

    @HostListener('document:visibilitychange')
    onVisibilityChange(): void {
        if (!this.isBrowser) return;
        this.isDocumentHidden = document.hidden;
        this.cdr.markForCheck();
    }

    @HostListener('window:keydown', ['$event'])
    onKeydown(event: KeyboardEvent): void {
        if (!this.isBrowser) return;
        if ((event.target as HTMLElement).tagName === 'INPUT') return;

        switch (event.key) {
            case 'ArrowUp':
                if (!this.guideOpen) {
                    this.channelUp();
                    event.preventDefault();
                }
                break;
            case 'ArrowDown':
                if (!this.guideOpen) {
                    this.channelDown();
                    event.preventDefault();
                }
                break;
            case 'g': case 'G': this.toggleGuide(); break;
            case 'm': case 'M': this.toggleMute(); break;
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

            // Auto-tune to last channel or first
            if (this.currentChannelIndex < 0 && this.channels.length > 0) {
                const lastId = this.storage.getLastChannel();
                const idx = lastId ? this.channels.findIndex(ch => String(ch.id) === String(lastId)) : -1;
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
        const ch = this.channels.find(c => c.id === channelId);
        if (!ch) return;
        this.clientRecordings.schedule({
            channelId,
            channelName: ch.name,
            channelLogo: ch.logo,
            programTitle,
            startTime,
            endTime,
            streamUrl: ch.stream_url
        }).then(() => this.loadRecordings()).catch(() => {});
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

        // Pre-compute program positions to avoid template binding recalcs
        const pxPerMs = 200 / (30 * 60 * 1000);
        for (const ch of this.filteredChannels) {
            if (!ch.programs) continue;
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
        if (!this.Hls) {
            import('hls.js').then((mod) => {
                this.Hls = mod.default;
                this.setupHlsPlayback(resolvedUrl, video);
            }).catch(() => {
                this.error = 'HLS player not available';
                this.loading = false;
            });
        } else {
            this.setupHlsPlayback(resolvedUrl, video);
        }
    }

    private setupHlsPlayback(url: string, video: HTMLVideoElement): void {
        const Hls = this.Hls;
        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                startFragPrefetch: true,
                renderTextTracksNatively: true,
            });
            hls.loadSource(url);
            hls.attachMedia(video);
            
            let networkRetryCount = 0;
            let mediaRetryCount = 0;
            const maxRetries = 3;

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.loading = false;
                this.reconnecting = false;
                this.reconnectAttempt = 0;
                networkRetryCount = 0;
                mediaRetryCount = 0;
                this.cdr.detectChanges();
                video.play().catch(() => { });
            });

            video.onplaying = () => {
                this.loading = false;
                this.reconnecting = false;
                this.reconnectAttempt = 0;
                this.cdr.detectChanges();
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
                                    hls.startLoad();
                                }
                            }, 2000);
                        } else {
                            console.error('Max network retries exceeded. Performing full stream reload...');
                            networkRetryCount = 0;
                            this.reconnectAttempt = 0;
                            this.cdr.detectChanges();
                            setTimeout(() => {
                                if (this.hls === hls) {
                                    hls.loadSource(url);
                                    hls.startLoad();
                                }
                            }, 2000);
                        }
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        mediaRetryCount++;
                        this.reconnectAttempt = mediaRetryCount;
                        this.cdr.detectChanges();

                        if (mediaRetryCount <= 1) {
                            console.log('Attempting to recover media error...');
                            hls.recoverMediaError();
                        } else if (mediaRetryCount === 2) {
                            console.log('Second media recovery attempt - swapping audio codec...');
                            hls.swapAudioCodec();
                            hls.recoverMediaError();
                        } else {
                            console.error('Max media recovery retries exceeded. Reloading stream...');
                            mediaRetryCount = 0;
                            this.reconnectAttempt = 0;
                            this.cdr.detectChanges();
                            setTimeout(() => {
                                if (this.hls === hls) {
                                    hls.loadSource(url);
                                    hls.startLoad();
                                }
                            }, 1000);
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
                if (video.paused || video.ended || this.loading || this.reconnecting) {
                    lastTimeChanged = Date.now();
                    if (video.currentTime !== lastCurrentTime) {
                        lastCurrentTime = video.currentTime;
                    }
                    return;
                }

                if (video.currentTime === lastCurrentTime) {
                    const stallDuration = Date.now() - lastTimeChanged;
                    if (stallDuration > 5000) {
                        console.warn('Playback watchdog: Stalled stream detected!');
                        this.reconnecting = true;
                        this.loading = true;
                        networkRetryCount++;
                        this.reconnectAttempt = networkRetryCount;
                        this.cdr.detectChanges();

                        lastTimeChanged = Date.now();

                        if (networkRetryCount <= maxRetries) {
                            console.log(`Watchdog: Recovering via network reload (${networkRetryCount}/${maxRetries})...`);
                            if (this.hls === hls) {
                                hls.startLoad();
                                hls.recoverMediaError();
                            }
                        } else {
                            console.error('Watchdog: Max retries exceeded. Doing full stream reload...');
                            networkRetryCount = 0;
                            this.reconnectAttempt = 0;
                            this.cdr.detectChanges();
                            if (this.hls === hls) {
                                hls.loadSource(url);
                                hls.startLoad();
                            }
                        }
                    }
                } else {
                    lastCurrentTime = video.currentTime;
                    lastTimeChanged = Date.now();
                }
            }, 1000);

            this.hls = hls;
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
            
            const handleNativeError = () => {
                nativeRetryCount++;
                this.reconnectAttempt = nativeRetryCount;
                this.reconnecting = true;
                this.loading = true;
                this.cdr.detectChanges();

                console.warn(`Native playback error (retry ${nativeRetryCount}/3)`);
                if (nativeRetryCount <= 3) {
                    setTimeout(() => {
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
            video.addEventListener('error', handleNativeError);

            // Native watchdog
            let lastCurrentTime = -1;
            let lastTimeChanged = Date.now();
            this.watchdogInterval = setInterval(() => {
                if (video.paused || video.ended || this.loading || this.reconnecting) {
                    lastTimeChanged = Date.now();
                    if (video.currentTime !== lastCurrentTime) {
                        lastCurrentTime = video.currentTime;
                    }
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
        } else {
            this.error = 'HLS not supported';
            this.loading = false;
        }
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

        try {
            const canRecordSeries = this.isSeriesCandidate(this.watchScheduleSelectedProgram, this.watchSchedulePrograms);
            if (this.watchScheduleRecordSeries && this.watchScheduleSelectedProgram && canRecordSeries) {
                const matchingPrograms = this.watchSchedulePrograms.filter(program => program.title === this.watchScheduleSelectedProgram.title);
                let count = 0;
                for (const program of matchingPrograms) {
                    if (this.getRecordingForProgram(channel.id, program.start, program.stop)) continue;
                    const start = this.parseEpgTime(program.start);
                    const stop = this.parseEpgTime(program.stop);
                    if (!start || !stop || stop.getTime() < Date.now()) continue;
                    await this.clientRecordings.schedule({
                        channelId: channel.id,
                        channelName: channel.name,
                        channelLogo: channel.logo,
                        programTitle: program.title,
                        subTitle: program.sub_title,
                        episodeNum: program.episode_num,
                        description: program.description,
                        thumbnail: program.icon || channel.logo,
                        category: program.category,
                        rating: program.rating,
                        startTime: start.toISOString(),
                        endTime: stop.toISOString(),
                        streamUrl: channel.stream_url
                    });
                    count++;
                }
                this.toast.show(`Scheduled ${count} local recordings`, 'success');
            } else {
                await this.clientRecordings.schedule({
                    channelId: channel.id,
                    channelName: channel.name,
                    channelLogo: channel.logo,
                    programTitle: this.watchSchedule.title,
                    subTitle: this.watchScheduleSelectedProgram?.sub_title,
                    episodeNum: this.watchScheduleSelectedProgram?.episode_num,
                    description: this.watchScheduleSelectedProgram?.description,
                    thumbnail: this.watchScheduleSelectedProgram?.icon || channel.logo,
                    category: this.watchScheduleSelectedProgram?.category,
                    rating: this.watchScheduleSelectedProgram?.rating,
                    startTime: new Date(this.watchSchedule.startTime).toISOString(),
                    endTime: new Date(this.watchSchedule.endTime).toISOString(),
                    streamUrl: channel.stream_url
                });
                this.toast.show('Local recording scheduled', 'success');
            }
            this.showWatchScheduleModal = false;
            await this.loadRecordings();
        } catch (error) {
            console.error('Failed to schedule local recording', error);
            this.toast.show('Failed to schedule local recording', 'error');
        }
    }

    recordingTitle(rec: ClientRecording | SystemRecording): string {
        return 'programTitle' in rec ? rec.programTitle : rec.program_title;
    }

    isSeriesCandidate(program: any, programs: any[] = []): boolean {
        if (!program?.title) return false;
        if (program.episode_num || program.sub_title) return true;

        const category = String(program.category || '').toLowerCase();
        const blockedCategories = ['movie', 'film', 'sports', 'news', 'event', 'special', 'shopping'];
        if (blockedCategories.some(blocked => category.includes(blocked))) return false;

        const showCategories = ['series', 'show', 'entertainment', 'comedy', 'drama', 'animation', 'kids', 'documentary'];
        const title = String(program.title).trim().toLowerCase();
        const repeatCount = programs.filter(candidate => String(candidate?.title || '').trim().toLowerCase() === title).length;
        return repeatCount > 1 && showCategories.some(showCategory => category.includes(showCategory));
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
        if (!bytes) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
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
    parseEpgTime(str: string): Date | null {
        if (!str) return null;
        const clean = str.replace(/\s.+$/, '');
        const y = clean.slice(0, 4), mo = clean.slice(4, 6), d = clean.slice(6, 8);
        const h = clean.slice(8, 10), mi = clean.slice(10, 12), s = clean.slice(12, 14);
        return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
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

        if (this.guideLayout === 'side') {
            const deltaX = this.dragStartX - clientX; // dragging left = increase width
            const startWidth = this.dragStartHeight * 1.6;
            const newWidth = Math.max(200, Math.min(window.innerWidth * 0.8, startWidth + deltaX));
            this.guideHeight = newWidth / 1.6;
        } else {
            const delta = this.dragStartY - clientY; // dragging up = increase height
            const newHeight = Math.max(200, Math.min(window.innerHeight * 0.8, this.dragStartHeight + delta));
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
            const start = this.parseEpgTime(program.start);
            const stop = this.parseEpgTime(program.stop);
            const data = {
                channelId: channel.id,
                channelName: channel.name,
                channelLogo: channel.logo,
                programTitle: program.title,
                subTitle: program.sub_title,
                episodeNum: program.episode_num,
                description: program.description,
                thumbnail: program.icon || channel.logo,
                category: program.category,
                rating: program.rating,
                startTime: start ? start.toISOString() : program.start,
                endTime: stop ? stop.toISOString() : program.stop,
                streamUrl: channel.stream_url
            };
            await this.clientRecordings.schedule(data);
            await this.loadRecordings();
            this.toast.show(`Scheduled recording for '${program.title}'`, 'success');
        } catch (e) {
            console.error('Failed to schedule recording', e);
            this.toast.show('Failed to schedule recording', 'error');
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
            const matchingPrograms = (channel.programs || []).filter((p: any) => p.title === program.title);
            let count = 0;
            for (const p of matchingPrograms) {
                if (this.getRecordingForProgram(channel.id, p.start, p.stop)) {
                    continue;
                }
                const start = this.parseEpgTime(p.start);
                const stop = this.parseEpgTime(p.stop);
                const data = {
                    channelId: channel.id,
                    channelName: channel.name,
                    channelLogo: channel.logo,
                    programTitle: p.title,
                    subTitle: p.sub_title,
                    episodeNum: p.episode_num,
                    description: p.description,
                    thumbnail: p.icon || channel.logo,
                    category: p.category,
                    rating: p.rating,
                    startTime: start ? start.toISOString() : p.start,
                    endTime: stop ? stop.toISOString() : p.stop,
                    streamUrl: channel.stream_url
                };
                await this.clientRecordings.schedule(data);
                count++;
            }
            await this.loadRecordings();
            this.toast.show(`Scheduled series: ${count} episodes of '${program.title}'`, 'success');
        } catch (e) {
            console.error('Failed to schedule series', e);
            this.toast.show('Failed to schedule series', 'error');
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
        return localStorage.getItem('iptv_server_url') || '';
    }

    saveServerUrl(): void {
        if (!this.isBrowser) return;
        let url = this.serverUrl.trim();
        if (url && !/^https?:\/\//i.test(url)) {
            url = 'http://' + url;
        }
        localStorage.setItem('iptv_server_url', url);
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
        this.discoveryMessage = 'Scanning local network for EPG Manager server...';
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
