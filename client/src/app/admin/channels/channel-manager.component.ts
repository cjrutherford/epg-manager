import { Component, OnInit } from '@angular/core';
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

    constructor(private api: ApiService, private toast: ToastService) { }

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

        if (!confirm(`Are you sure you want to perform this action on ${ids.length} channels?`)) return;

        try {
            if (action === 'enable' || action === 'disable') {
                const enabled = action === 'enable';
                await this.api.toggleChannels(ids, enabled).toPromise();
                this.channels.forEach(c => {
                    if (ids.includes(c.id)) c.enabled = enabled ? 1 : 0;
                });
                this.toast.show(`${ids.length} channels ${enabled ? 'enabled' : 'disabled'}`, 'success');
            } else if (action === 'auto-assign') {
                let currentNum = 1;
                for (const ch of this.filteredChannels) {
                    if (this.selectedChannelIds.has(ch.id)) {
                        await this.api.updateChannel(ch.id, { channel_number: currentNum }).toPromise();
                        ch.channel_number = currentNum;
                        currentNum++;
                    }
                }
                this.toast.show(`Auto-assigned numbers to ${ids.length} channels`, 'success');
            }
            this.selectedChannelIds.clear();
            this.applyFilters();
        } catch (e) {
            this.toast.show('Bulk action failed', 'error');
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
