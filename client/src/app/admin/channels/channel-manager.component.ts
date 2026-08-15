import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { ConfirmService } from '../../services/confirm.service';
import { ModalFocusDirective } from '../../services/modal-focus.directive';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { computeWindow } from './channel-window';

@Component({
    selector: 'app-channel-manager',
    standalone: true,
    imports: [CommonModule, FormsModule, ModalFocusDirective],
    templateUrl: './channel-manager.component.html',
    styleUrl: './channel-manager.component.css'
})
export class ChannelManagerComponent implements OnInit, OnDestroy {
    channels: any[] = [];
    filteredChannels: any[] = [];
    loading = true;

    filterInput = '';
    matchFilter = 'all';
    statusFilter = 'all';
    categoryFilter = 'all';
    categories: string[] = [];

    sortKey: string | null = null;
    sortDir: 'asc' | 'desc' = 'asc';

    expandedChannelId: string | null = null;
    selectedChannelIds = new Set<string>();

    // Search results belong to the row that asked for them. A single shared
    // array meant an expanded row could show the candidates fetched for a
    // different channel.
    epgSearchResults: any[] = [];
    epgSearchLoading = false;
    epgSearchForChannelId: string | null = null;
    epgSearchQuery = '';
    private epgSearchTimer: any = null;
    /** Incremented per request so a slow reply cannot overwrite a newer one. */
    private epgSearchToken = 0;

    // ── Virtual scrolling ───────────────────────
    // The list used to render `filteredChannels.slice(0, 500)`; past that,
    // channels were simply unreachable.
    readonly rowHeight = 48;
    readonly expandedExtraHeight = 300;
    visibleChannels: any[] = [];
    windowStartIndex = 0;
    paddingTop = 0;
    paddingBottom = 0;
    viewportHeight = 640;

    showAutoNumberModal = false;
    autoNumberMode: 'list' | 'auto-group' | 'custom-ranges' = 'list';
    autoNumberStartNum = 700;
    customRangesStr = '{}';

    constructor(private api: ApiService, private toast: ToastService, private cdr: ChangeDetectorRef,
        private confirm: ConfirmService) { }

    ngOnInit(): void {
        this.loadChannels();
    }

    ngOnDestroy(): void {
        if (this.epgSearchTimer) clearTimeout(this.epgSearchTimer);
    }

    // ── Virtual scrolling ───────────────────────
    onListScroll(event: Event): void {
        const target = event.target as HTMLElement;
        this.viewportHeight = target.clientHeight || this.viewportHeight;
        this.updateWindow(target.scrollTop);
    }

    private lastScrollTop = 0;

    updateWindow(scrollTop = this.lastScrollTop): void {
        this.lastScrollTop = scrollTop;
        const expandedIndex = this.expandedChannelId
            ? this.filteredChannels.findIndex(c => c.id === this.expandedChannelId)
            : -1;

        const result = computeWindow({
            totalRows: this.filteredChannels.length,
            rowHeight: this.rowHeight,
            scrollTop,
            viewportHeight: this.viewportHeight,
            expandedIndex: expandedIndex >= 0 ? expandedIndex : null,
            expandedExtraHeight: this.expandedExtraHeight
        });

        this.windowStartIndex = result.startIndex;
        this.visibleChannels = this.filteredChannels.slice(result.startIndex, result.endIndex);
        this.paddingTop = result.paddingTop;
        this.paddingBottom = result.paddingBottom;
        this.cdr.detectChanges();
    }

    async loadChannels(): Promise<void> {
        this.loading = true;
        try {
            const [channels, categories] = await Promise.all([
                this.api.getMapping().toPromise(),
                this.api.getCategories().toPromise()
            ]);
            // The badge was recomputed for every row on every change detection
            // pass, and again for every comparison during a sort. It only
            // changes when the data does, so it is computed once here.
            this.channels = (Array.isArray(channels) ? channels : []).map(c => ({
                ...c,
                _badge: this.computeMatchBadge(c)
            }));
            this.categories = (categories || []).map((c: any) => c.group_title);
            this.applyFilters();
        } catch (e) {
            console.error('Load channels failed', e);
            this.channels = [];
        } finally {
            this.loading = false;
            this.cdr.detectChanges();
        }
    }

    applyFilters(): void {
        const filter = this.filterInput.toLowerCase();
        this.filteredChannels = this.channels.filter(c => {
            const nameMatch = (c.name || '').toLowerCase().includes(filter);
            const catMatch = (c.group_title || '').toLowerCase().includes(filter);
            const searchMatch = nameMatch || catMatch;

            let matchStatus = true;
            const isMatched = !!(c.matched_epg_id || c.override_epg_id);
            const matchType = this.getMatchBadge(c).text.toLowerCase();

            switch (this.matchFilter) {
                case 'exact': matchStatus = matchType === 'exact'; break;
                case 'fuzzy': matchStatus = matchType === 'fuzzy' || matchType === 'match'; break;
                case 'override': matchStatus = matchType === 'override'; break;
                case 'unmatched': matchStatus = !isMatched; break;
                default: matchStatus = true;
            }

            let enabledMatch = true;
            if (this.statusFilter === 'enabled') enabledMatch = c.enabled === 1;
            else if (this.statusFilter === 'disabled') enabledMatch = c.enabled === 0;

            let catFilter = true;
            if (this.categoryFilter !== 'all') catFilter = c.group_title === this.categoryFilter;

            return searchMatch && matchStatus && enabledMatch && catFilter;
        });
        this.sortChannels();
        this.updateWindow(0);
    }

    sortBy(key: string): void {
        if (this.sortKey === key) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortKey = key;
            this.sortDir = 'asc';
        }
        this.sortChannels();
        this.updateWindow(0);
    }

    sortChannels(): void {
        if (!this.sortKey) return;
        const key = this.sortKey;
        const dir = this.sortDir === 'asc' ? 1 : -1;
        this.filteredChannels.sort((a, b) => {
            let va: any, vb: any;
            switch (key) {
                case 'name':
                    va = (a.name || '').toLowerCase();
                    vb = (b.name || '').toLowerCase();
                    break;
                case 'number':
                    va = Number(a.channel_number) || 0;
                    vb = Number(b.channel_number) || 0;
                    break;
                case 'match':
                    va = this.getMatchBadge(a).text;
                    vb = this.getMatchBadge(b).text;
                    break;
                case 'category':
                    va = (a.group_title || '').toLowerCase();
                    vb = (b.group_title || '').toLowerCase();
                    break;
                default:
                    return 0;
            }
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    }

    toggleSelection(id: string, selected: boolean): void {
        if (selected) {
            this.selectedChannelIds.add(id);
        } else {
            this.selectedChannelIds.delete(id);
        }
    }

    selectAll(selected: boolean): void {
        if (selected) {
            this.filteredChannels.forEach(c => this.selectedChannelIds.add(c.id));
        } else {
            this.selectedChannelIds.clear();
        }
    }

    get isAllSelected(): boolean {
        return this.filteredChannels.length > 0 && this.filteredChannels.every(c => this.selectedChannelIds.has(c.id));
    }

    async applyBulkAction(action: 'enable' | 'disable' | 'auto-assign'): Promise<void> {
        const ids = Array.from(this.selectedChannelIds);
        if (ids.length === 0) return;

        if (action === 'enable' || action === 'disable') {
            const enabling = action === 'enable';
            const confirmed = await this.confirm.ask({
                title: `${enabling ? 'Enable' : 'Disable'} ${ids.length} ${ids.length === 1 ? 'channel' : 'channels'}?`,
                message: enabling
                    ? 'They will appear in the guide and the generated playlist.'
                    : 'They will be hidden from the guide and left out of the generated playlist.',
                detail: 'Nothing is deleted; this can be changed back at any time.',
                confirmLabel: enabling ? 'Enable' : 'Disable'
            });
            if (!confirmed) return;
        }

        try {
            if (action === 'enable' || action === 'disable') {
                const enabled = action === 'enable';
                await this.api.toggleChannels(ids, enabled).toPromise();
                this.channels.forEach(c => {
                    if (ids.includes(c.id)) c.enabled = enabled ? 1 : 0;
                });
                this.toast.show(`${ids.length} channels ${enabled ? 'enabled' : 'disabled'}`, 'success');
            } else if (action === 'auto-assign') {
                const config = await this.api.getConfig().toPromise();
                this.autoNumberMode = config?.channel_numbering_mode || 'list';
                this.customRangesStr = config?.custom_channel_ranges || '{}';
                this.autoNumberStartNum = 700;
                this.showAutoNumberModal = true;
            }
            if (action !== 'auto-assign') {
                this.selectedChannelIds.clear();
                this.applyFilters();
            }
        } catch (e) {
            this.toast.show('Bulk action failed', 'error');
        } finally {
            this.cdr.detectChanges();
        }
    }

    async executeAutoNumber(): Promise<void> {
        this.showAutoNumberModal = false;
        const ids = Array.from(this.selectedChannelIds);
        if (ids.length === 0) return;

        try {
            let startNum = this.autoNumberStartNum;
            let categoryNextNumber = new Map<string, number>();
            let nextNumber = 700;
            
            if (this.autoNumberMode === 'auto-group') {
                const selectedChannels = this.channels.filter(c => this.selectedChannelIds.has(c.id));
                const selectedCategories = [...new Set(selectedChannels.map(c => c.group_title || 'Uncategorized'))].sort();
                let currentBlock = 100;
                for (const cat of selectedCategories) {
                    categoryNextNumber.set(cat, currentBlock);
                    currentBlock += 100;
                }
            } else if (this.autoNumberMode === 'custom-ranges') {
                let customRanges: Record<string, number> = {};
                try { customRanges = JSON.parse(this.customRangesStr); } catch (e) {}
                for (const [cat, startNumVal] of Object.entries(customRanges)) {
                    categoryNextNumber.set(cat, Number(startNumVal) || 100);
                }
                
                const currentMax = this.channels.reduce((max: number, ch: any) => {
                    const num = Number(ch.channel_number) || 0;
                    return num >= 700 ? Math.max(max, num) : max;
                }, 0);
                nextNumber = currentMax > 0 ? currentMax + 100 - (currentMax % 100) : 700;
            }
            
            let count = 0;
            for (const ch of this.filteredChannels) {
                if (this.selectedChannelIds.has(ch.id)) {
                    let num = 0;
                    if (this.autoNumberMode === 'list') {
                        num = startNum++;
                    } else {
                        const group = ch.group_title || 'Uncategorized';
                        if (!categoryNextNumber.has(group)) {
                            categoryNextNumber.set(group, nextNumber);
                            nextNumber += 100;
                        }
                        num = categoryNextNumber.get(group)!;
                        categoryNextNumber.set(group, num + 1);
                    }
                    
                    await this.api.updateChannel(ch.id, { channel_number: num }).toPromise();
                    ch.channel_number = num;
                    count++;
                }
            }
            this.toast.show(`Auto-assigned numbers to ${count} channels using '${this.autoNumberMode}' method`, 'success');
            this.selectedChannelIds.clear();
            this.applyFilters();
        } catch (e) {
            this.toast.show('Auto-numbering failed', 'error');
        } finally {
            this.cdr.detectChanges();
        }
    }

    /**
     * The single write path for a channel's own fields. Bulk enable/disable and
     * auto-numbering funnel through the same API, so a row cannot end up saved
     * by one route and stale by another.
     */
    async saveChannel(ch: any): Promise<void> {
        try {
            await this.api.updateChannel(ch.id, {
                channel_number: ch.channel_number,
                enabled: ch.enabled
            }).toPromise();
            ch._badge = this.computeMatchBadge(ch);
            this.toast.show('Channel saved', 'success');
            this.applyFilters();
        } catch (e) {
            this.toast.show('Failed to save channel', 'error');
        }
    }

    toggleExpand(channelId: string): void {
        this.expandedChannelId = this.expandedChannelId === channelId ? null : channelId;
        // Candidates belong to the row that fetched them; opening a different
        // row must not inherit them.
        this.clearEpgSearch();
        this.updateWindow();
    }

    private clearEpgSearch(): void {
        if (this.epgSearchTimer) {
            clearTimeout(this.epgSearchTimer);
            this.epgSearchTimer = null;
        }
        this.epgSearchToken++;
        this.epgSearchResults = [];
        this.epgSearchQuery = '';
        this.epgSearchForChannelId = null;
        this.epgSearchLoading = false;
    }

    /** Results only ever belong to one row, so ask which before showing them. */
    resultsFor(channelId: string): any[] {
        return this.epgSearchForChannelId === channelId ? this.epgSearchResults : [];
    }

    isSearching(channelId: string): boolean {
        return this.epgSearchLoading && this.epgSearchForChannelId === channelId;
    }

    /**
     * Debounced: this fired a request on every keystroke, so typing a
     * ten-character name issued nine requests whose replies could arrive in any
     * order. One request per pause, and only the newest reply is kept.
     */
    onEpgSearchInput(channelId: string, query: string): void {
        this.epgSearchQuery = query;
        this.epgSearchForChannelId = channelId;

        if (this.epgSearchTimer) clearTimeout(this.epgSearchTimer);

        if (query.trim().length < 2) {
            this.epgSearchToken++;
            this.epgSearchResults = [];
            this.epgSearchLoading = false;
            this.cdr.detectChanges();
            return;
        }

        this.epgSearchLoading = true;
        this.cdr.detectChanges();
        this.epgSearchTimer = setTimeout(() => this.runEpgSearch(channelId, query), 300);
    }

    private async runEpgSearch(channelId: string, query: string): Promise<void> {
        const token = ++this.epgSearchToken;
        try {
            const results = await this.api.searchEpg(query).toPromise() || [];
            // A reply that is no longer the newest, or is for a row the user has
            // since collapsed, is discarded rather than displayed.
            if (token !== this.epgSearchToken || this.expandedChannelId !== channelId) return;
            this.epgSearchResults = results;
            this.epgSearchForChannelId = channelId;
        } catch {
            if (token === this.epgSearchToken) this.epgSearchResults = [];
        } finally {
            if (token === this.epgSearchToken) {
                this.epgSearchLoading = false;
                this.cdr.detectChanges();
            }
        }
    }

    async setOverride(channelId: string, epgId: string | null): Promise<void> {
        try {
            await this.api.setOverride(channelId, epgId).toPromise();

            // Update the one row rather than refetching every channel. The
            // reload discarded the scroll position and the filters along with
            // it, which is unnoticeable at 50 channels and painful at 2,000.
            const channel = this.channels.find(c => c.id === channelId);
            if (channel) {
                channel.override_epg_id = epgId;
                channel.is_overridden = !!epgId;
                channel._badge = this.computeMatchBadge(channel);
            }

            this.expandedChannelId = null;
            this.clearEpgSearch();
            this.applyFilters();
            this.toast.show(epgId ? `EPG mapping set to ${epgId}` : 'EPG mapping cleared', 'success');
        } catch { this.toast.show('Override failed', 'error'); }
    }

    /** Cached on the row; recomputed only when the mapping changes. */
    getMatchBadge(ch: any): { cls: string; text: string } {
        return ch._badge || (ch._badge = this.computeMatchBadge(ch));
    }

    private computeMatchBadge(ch: any): { cls: string; text: string } {
        if (ch.is_overridden) return { cls: 'badge-success', text: 'Override' };
        if (ch.matched_epg_id) {
            if (ch.match_type?.includes('Exact')) return { cls: 'badge-success', text: 'Exact' };
            if (ch.match_type?.includes('Fuzzy')) return { cls: 'badge-warning', text: 'Fuzzy' };
            return { cls: 'badge-warning', text: 'Match' };
        }
        return { cls: 'badge-danger', text: 'Unmatched' };
    }

    getEffectiveEpgId(ch: any): string {
        return ch.override_epg_id || ch.matched_epg_id || '-';
    }

    get matchedCount(): number {
        return this.filteredChannels.filter(c => c.matched_epg_id || c.override_epg_id).length;
    }
}
