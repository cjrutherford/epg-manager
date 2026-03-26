import { Component, OnInit, OnDestroy, ViewChild, ElementRef, HostListener, CUSTOM_ELEMENTS_SCHEMA, Inject, PLATFORM_ID, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../services/api.service';
import { StorageService } from '../services/storage.service';
import { CastService } from '../services/cast.service';

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
    imports: [CommonModule, FormsModule, RouterLink],
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
    rowHeight = 50;

    categories: any[] = [];
    currentChannelIndex = -1;
    searchQuery = '';
    selectedCategories = new Set<string>();
    favorites = new Set<string>();
    hiddenChannels = new Set<string>();

    guideOpen = false;
    guideStart: Date | null = null;
    guideHours = 3;
    guideTimeLabel = '';
    guideStartMs = 0;
    guideEndMs = 0;
    guideHeight = 340;

    // Drag resize state
    private isDraggingGuide = false;
    private dragStartY = 0;
    private dragStartHeight = 0;
    private boundDragMove: any;
    private boundDragEnd: any;

    volume = 0.8;
    muted = false;

    loading = false;
    error = '';
    showInfoOverlay = false;
    showOsd = false;
    osdChannel: Channel | null = null;

    private hls: any = null;
    private Hls: any = null;
    private overlayTimer: any;
    private osdTimer: any;
    private infoTimer: any;

    // Responsive
    isMobile = false;

    // Cast State
    isCasting = false;
    castAvailable = false;

    // Context Menu State
    contextMenu = {
        visible: false,
        x: 0,
        y: 0,
        channel: null as any,
        program: null as any
    };

    private isBrowser: boolean;

    constructor(
        private api: ApiService,
        private storage: StorageService,
        public castService: CastService,
        @Inject(PLATFORM_ID) platformId: Object,
        private cdr: ChangeDetectorRef
    ) {
        this.isBrowser = isPlatformBrowser(platformId);
    }

    ngOnInit(): void {
        if (this.isBrowser) {
            this.isMobile = window.innerWidth < 768;

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
        }
        
        // Initialize storage with backend sync
        this.storage.init().then(() => {
            this.favorites = this.storage.getFavorites();
            this.hiddenChannels = this.storage.getHiddenChannels();
        });
        
        this.volume = this.storage.getVolume();
        this.muted = this.storage.getMuted();

        this.castService.castState$.subscribe(state => {
            this.isCasting = state.isCasting;
            this.castAvailable = state.isAvailable;

            // If we just connected and have a channel playing, move it to the TV
            if (this.isCasting && this.currentChannelIndex >= 0) {
                this.playStream(this.channels[this.currentChannelIndex].stream_url, true);
            }
        });

        this.updateGuideHours();

        if (this.isBrowser) {
            // Bind drag handlers once
            this.boundDragMove = this.onGuideDragMove.bind(this);
            this.boundDragEnd = this.onGuideDragEnd.bind(this);
        }

        this.loadCategories();
        this.loadGuide();
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
        clearTimeout(this.overlayTimer);
        clearTimeout(this.osdTimer);
        clearInterval(this.infoTimer);
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
            this.cdr.markForCheck();
        } catch (e) {
            console.error('Failed to load guide', e);
        } finally {
            this.loading = false;
            this.cdr.markForCheck();
        }
    }

    async loadCategories(): Promise<void> {
        try {
            this.categories = await this.api.getCategories().toPromise() || [];
            this.cdr.markForCheck();
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
        this.playStream(ch.stream_url);
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
        this.loading = !!url && !this.isCasting;
        this.error = '';

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        if (this.videoRef?.nativeElement) {
            this.videoRef.nativeElement.pause();
            this.videoRef.nativeElement.removeAttribute('src');
            this.videoRef.nativeElement.load();
        }

        if (!url) {
            this.error = 'No stream URL';
            this.loading = false;
            return;
        }

        if (this.isCasting || forceCast) {
            const ch = this.currentChannel;
            if (ch) {
                this.castService.loadMedia(
                    url,
                    ch.name,
                    ch.current_program?.title || ch.group_title,
                    ch.logo
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
                this.setupHlsPlayback(url, video);
            }).catch(() => {
                this.error = 'HLS player not available';
                this.loading = false;
            });
        } else {
            this.setupHlsPlayback(url, video);
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
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.loading = false;
                video.play().catch(() => { });
            });
            hls.on(Hls.Events.ERROR, (_: any, data: any) => {
                if (data.fatal) {
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        hls.startLoad();
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        hls.recoverMediaError();
                    } else {
                        this.error = 'Stream playback failed';
                        this.loading = false;
                        hls.destroy();
                    }
                }
            });
            this.hls = hls;
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.addEventListener('loadedmetadata', () => { this.loading = false; video.play().catch(() => { }); }, { once: true });
            video.addEventListener('error', () => { this.error = 'Playback failed'; this.loading = false; }, { once: true });
        } else {
            this.error = 'HLS not supported';
            this.loading = false;
        }
    }

    // ── Volume ──────────────────────────────────
    setVolume(val: number): void {
        this.volume = Math.max(0, Math.min(1, val));
        this.muted = false;
        this.videoRef.nativeElement.volume = this.volume;
        this.videoRef.nativeElement.muted = false;
        this.storage.setVolume(this.volume);
        this.storage.setMuted(false);
    }

    onVolumeSlider(event: Event): void {
        const val = parseInt((event.target as HTMLInputElement).value) / 100;
        this.setVolume(val);
    }

    toggleMute(): void {
        this.muted = !this.muted;
        this.videoRef.nativeElement.muted = this.muted;
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
            news: '📰', sports: '⚽', entertainment: '🎭', movies: '🎬',
            music: '🎵', kids: '🧒', education: '📚', documentary: '🎥',
            science: '🔬', travel: '✈️', food: '🍳', comedy: '😂',
            drama: '🎭', lifestyle: '🏠', weather: '🌤️', business: '💼',
            religious: '🙏', animation: '✨', general: '📡', family: '👨‍👩‍👧‍👦',
            gaming: '🎮'
        };
        if (!name) return '📁';
        return icons[name.toLowerCase()] || '📁';
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
        this.dragStartHeight = this.guideHeight;
        document.addEventListener('mousemove', this.boundDragMove);
        document.addEventListener('mouseup', this.boundDragEnd);
        document.addEventListener('touchmove', this.boundDragMove);
        document.addEventListener('touchend', this.boundDragEnd);
    }

    private onGuideDragMove(event: MouseEvent | TouchEvent): void {
        if (!this.isDraggingGuide || !this.isBrowser) return;
        const clientY = 'touches' in event ? (event as TouchEvent).touches[0].clientY : (event as MouseEvent).clientY;
        const delta = this.dragStartY - clientY; // dragging up = increase height
        const newHeight = Math.max(200, Math.min(window.innerHeight * 0.8, this.dragStartHeight + delta));
        this.guideHeight = newHeight;
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
            const data = {
                channel_id: channel.id,
                channel_name: channel.name,
                program_title: program.title,
                start_time: program.start,
                end_time: program.stop,
                stream_url: channel.stream_url
            };
            await this.api.scheduleRecording(data).toPromise();
            // Optional: Show a toast/notification here
            console.log(`Scheduled recording for ${program.title} on ${channel.name}`);
        } catch (e) {
            console.error('Failed to schedule recording', e);
        }
    }
}
