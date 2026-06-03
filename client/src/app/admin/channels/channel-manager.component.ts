import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

@Component({
    selector: 'app-channel-manager',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './channel-manager.component.html',
    styleUrl: './channel-manager.component.css'
})
export class ChannelManagerComponent implements OnInit {
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

    epgSearchResults: any[] = [];
    epgSearchLoading = false;

    showAutoNumberModal = false;
    autoNumberMode: 'list' | 'auto-group' | 'custom-ranges' = 'list';
    autoNumberStartNum = 700;
    customRangesStr = '{}';

    constructor(private api: ApiService, private toast: ToastService, private cdr: ChangeDetectorRef) { }

    ngOnInit(): void {
        this.loadChannels();
    }

    async loadChannels(): Promise<void> {
        this.loading = true;
        try {
            const [channels, categories] = await Promise.all([
                this.api.getMapping().toPromise(),
                this.api.getCategories().toPromise()
            ]);
            this.channels = Array.isArray(channels) ? channels : [];
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
    }

    sortBy(key: string): void {
        if (this.sortKey === key) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortKey = key;
            this.sortDir = 'asc';
        }
        this.sortChannels();
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
                    const badgeA = this.getMatchBadge(a);
                    const badgeB = this.getMatchBadge(b);
                    va = badgeA.text;
                    vb = badgeB.text;
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
            if (!confirm(`Are you sure you want to perform this action on ${ids.length} channels?`)) return;
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

    async saveChannel(ch: any): Promise<void> {
        try {
            await this.api.updateChannel(ch.id, {
                channel_number: ch.channel_number,
                enabled: ch.enabled
            }).toPromise();
            this.toast.show('Channel saved', 'success');
            this.applyFilters();
        } catch (e) {
            this.toast.show('Failed to save channel', 'error');
        }
    }

    toggleExpand(channelId: string): void {
        this.expandedChannelId = this.expandedChannelId === channelId ? null : channelId;
    }

    async searchEpg(query: string): Promise<void> {
        if (query.length < 2) { this.epgSearchResults = []; return; }
        this.epgSearchLoading = true;
        try {
            this.epgSearchResults = await this.api.searchEpg(query).toPromise() || [];
        } catch { this.epgSearchResults = []; }
        finally { this.epgSearchLoading = false; }
    }

    async setOverride(channelId: string, epgId: string | null): Promise<void> {
        try {
            await this.api.setOverride(channelId, epgId).toPromise();
            await this.loadChannels();
            this.expandedChannelId = null;
            this.toast.show(epgId ? `EPG mapping set to ${epgId}` : 'EPG mapping cleared', 'success');
        } catch { this.toast.show('Override failed', 'error'); }
    }

    getMatchBadge(ch: any): { cls: string; text: string } {
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
