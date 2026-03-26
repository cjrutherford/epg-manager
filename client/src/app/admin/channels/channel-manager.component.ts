import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

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

    expandedChannelId: string | null = null;
    selectedChannelIds = new Set<string>();

    epgSearchResults: any[] = [];
    epgSearchLoading = false;

    constructor(private api: ApiService) { }

    ngOnInit(): void {
        this.loadChannels();
    }

    async loadChannels(): Promise<void> {
        this.loading = true;
        try {
            const res = await this.api.getMapping().toPromise();
            this.channels = Array.isArray(res) ? res : [];
            this.updateCategories();
            this.applyFilters();
        } catch (e) {
            console.error('Load channels failed', e);
            this.channels = [];
        } finally {
            this.loading = false;
        }
    }

    private updateCategories(): void {
        this.categories = [...new Set(this.channels.map(c => c.group_title).filter(Boolean))].sort();
    }

    applyFilters(): void {
        const filter = this.filterInput.toLowerCase();
        this.filteredChannels = this.channels.filter(c => {
            const nameMatch = (c.name || '').toLowerCase().includes(filter);
            const catMatch = (c.group_title || '').toLowerCase().includes(filter);
            const searchMatch = nameMatch || catMatch;

            let matchStatus = true;
            if (this.matchFilter === 'matched') matchStatus = !!(c.matched_epg_id || c.override_epg_id);
            else if (this.matchFilter === 'unmatched') matchStatus = !(c.matched_epg_id || c.override_epg_id);

            let enabledMatch = true;
            if (this.statusFilter === 'enabled') enabledMatch = c.enabled === 1;
            else if (this.statusFilter === 'disabled') enabledMatch = c.enabled === 0;

            let catFilter = true;
            if (this.categoryFilter !== 'all') catFilter = c.group_title === this.categoryFilter;

            return searchMatch && matchStatus && enabledMatch && catFilter;
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
            } else if (action === 'auto-assign') {
                // Assign linearly across the current sorted/filtered view
                let currentNum = 1;
                for (const ch of this.filteredChannels) {
                    if (this.selectedChannelIds.has(ch.id)) {
                        await this.api.updateChannel(ch.id, { channel_number: currentNum }).toPromise();
                        ch.channel_number = currentNum;
                        currentNum++;
                    }
                }
            }
            this.selectedChannelIds.clear();
            this.applyFilters();
        } catch (e) {
            alert('Bulk action failed');
        }
    }

    async saveChannel(ch: any): Promise<void> {
        try {
            await this.api.updateChannel(ch.id, {
                channel_number: ch.channel_number,
                enabled: ch.enabled
            }).toPromise();
            this.applyFilters();
        } catch (e) {
            alert('Failed to save channel details');
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
        } catch { alert('Override failed'); }
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
