import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { SystemRecording } from './client-recording.types';

export interface SourceRecord {
    key: string;
    kind: string | null;
    label: string;
    provider: string;
    site: string;
    provides: ('channels' | 'guide')[];
    enabled: boolean;
    priority: number;
    importedRows: number;
    channelCountEstimate: number | null;
    lastSyncAt: number | null;
    lastSyncStatus: string | null;
    lastError: string | null;
    hasCredentials: boolean;
    url: string | null;
    notes: string;
}

export interface ProbeResult {
    ok: boolean;
    provides: string[];
    detectedKind?: string;
    sample: { channels?: { name: string }[]; programmes?: unknown[] };
    counts: { channels?: number; programmes?: number; days?: number };
    warnings: string[];
    error?: { code: string; message: string };
}

export interface BuiltInPresetDto {
    id: string;
    kind: string;
    label: string;
    provides: string[];
    category: string;
    host: string;
    url: string;
    channelCountEstimate: number | null;
    added: boolean;
}

/** A standing "record every episode of this show on this channel" instruction. */
export interface SeriesRule {
    id: number;
    channel_id: string;
    series_title: string;
    channel_name?: string | null;
    created_at?: number | string | null;
    /** Episodes this rule currently has booked and still to come. */
    upcoming_count?: number;
}

export type ResetScope = 'guide' | 'user' | 'collection' | 'all';

export interface ResetPreview {
    scope: ResetScope;
    summary: string;
    totalRows: number;
    totalBytes: number;
    tables: { table: string; rows: number }[];
    paths: { name: string; bytes: number }[];
}

export interface DvrStorage {
    /** Volume usage, not just the recordings folder. */
    usedBytes: number;
    totalBytes: number;
    freeBytes: number;
    recordingsBytes: number;
    retention: { mode: string; maxAgeDays: number; minFreeBytes: number };
}

@Injectable({ providedIn: 'root' })
export class ApiService {
    // The auth interceptor attaches the admin token; no method sets headers by hand.
    constructor(private http: HttpClient) { }

    getGuide(params: { hours?: number; start?: string; categories?: string } = {}): Observable<any> {
        const query = new URLSearchParams();
        if (params.hours) query.set('hours', String(params.hours));
        if (params.start) query.set('start', params.start);
        if (params.categories) query.set('categories', params.categories);
        return this.http.get(`/api/guide?${query}`);
    }

    getCategories(): Observable<any[]> {
        return this.http.get<any[]>('/api/categories');
    }

    getStats(): Observable<any> {
        return this.http.get('/api/stats');
    }

    getHealth(): Observable<any> {
        return this.http.get('/api/health');
    }

    getHasData(): Observable<{ hasChannels: boolean; hasPrograms: boolean; hasPlaylist: boolean; isEmpty: boolean }> {
        return this.http.get<any>('/api/has-data');
    }

    getJobStatus(): Observable<any> {
        return this.http.get('/api/job-status');
    }

    getChannelPrograms(channelId: string): Observable<any> {
        return this.http.get(`/api/channel/${channelId}/programs`);
    }

    getChannelStream(channelId: string): Observable<any> {
        return this.http.get(`/api/channel/${channelId}/stream`);
    }

    pingStreamKeepAlive(streamId: string): Observable<any> {
        return this.http.get(`/api/stream/keepalive/${streamId}`);
    }

    getRecordings(status?: string): Observable<any[]> {
        const url = status ? `/api/recordings?status=${status}` : '/api/recordings';
        return this.http.get<any[]>(url);
    }

    getActiveRecordings(): Observable<any[]> {
        return this.http.get<any[]>('/api/recordings/active');
    }

    getSystemRecordings(): Observable<SystemRecording[]> {
        return this.http.get<SystemRecording[]>('/api/recordings/system');
    }

    scheduleRecording(data: any): Observable<any> {
        return this.http.post('/api/dvr', data);
    }

    cancelRecording(id: number): Observable<any> {
        return this.http.delete(`/api/dvr/${id}`);
    }

    getSeriesRules(): Observable<SeriesRule[]> {
        return this.http.get<SeriesRule[]>('/api/dvr/series-rules');
    }

    deleteSeriesRule(id: number, cancelUpcoming = false): Observable<any> {
        const query = cancelUpcoming ? '?cancelUpcoming=1' : '';
        return this.http.delete(`/api/dvr/series-rules/${id}${query}`);
    }

    runSeriesRules(): Observable<{ success: boolean; scheduled: number }> {
        return this.http.post<{ success: boolean; scheduled: number }>('/api/dvr/series-rules/run', {});
    }

    getConfig(): Observable<any> {
        return this.http.get('/api/config');
    }

    saveConfig(config: any): Observable<any> {
        return this.http.post('/api/config', config);
    }

    getSettings(): Observable<any> {
        return this.http.get('/api/settings');
    }

    getMapping(): Observable<any[]> {
        return this.http.get<any[]>('/api/mapping');
    }

    getChannels(): Observable<any[]> {
        return this.http.get<any[]>('/api/channels');
    }

    toggleChannels(ids: string[], enabled: boolean): Observable<any> {
        return this.http.post('/api/channels/toggle', { ids, enabled });
    }

    updateChannel(id: string, data: any): Observable<any> {
        return this.http.put(`/api/channels/${id}`, data);
    }

    setOverride(channelId: string, epgId: string | null): Observable<any> {
        return this.http.post('/api/override', { channel_id: channelId, epg_id: epgId });
    }

    searchEpg(query: string): Observable<any[]> {
        return this.http.get<any[]>(`/api/search-epg?q=${encodeURIComponent(query)}`);
    }

    getPlaylists(): Observable<any> {
        return this.http.get<any>('/api/playlists');
    }

    syncPlaylist(): Observable<any> {
        return this.http.post('/api/sync-playlist', {});
    }

    runFullSync(): Observable<any> {
        return this.http.post('/api/sync', {});
    }

    cancelSync(): Observable<any> {
        return this.http.post('/api/sync/cancel', {});
    }

    rebuildFiles(): Observable<any> {
        return this.http.post('/api/rebuild-files', {});
    }

    grabMissing(): Observable<any> {
        return this.http.post('/api/grab', {});
    }

    previewReset(scope: ResetScope): Observable<ResetPreview> {
        return this.http.get<ResetPreview>(`/api/reset/preview?scope=${scope}`);
    }

    resetSystem(scope: ResetScope): Observable<any> {
        return this.http.post('/api/reset', { scope });
    }

    getGrabLogs(): Observable<any[]> {
        return this.http.get<any[]>('/api/grab-logs');
    }

    // ── DVR Scheduler (scheduled recordings) ────
    getDvrSchedules(): Observable<any[]> {
        return this.http.get<any[]>('/api/dvr');
    }

    getDvrStorage(): Observable<DvrStorage> {
        return this.http.get<DvrStorage>('/api/dvr/storage');
    }

    stopDvr(id: number): Observable<any> {
        return this.http.post(`/api/dvr/stop/${id}`, {});
    }

    // ── Metadata ────────────────────────────────
    getMetadataConfig(): Observable<any> {
        return this.http.get('/api/metadata/config');
    }

    saveMetadataConfig(data: any): Observable<any> {
        return this.http.post('/api/metadata/config', data);
    }

    getMetadataStats(): Observable<any> {
        return this.http.get('/api/metadata/stats');
    }

    triggerEnrichment(): Observable<any> {
        return this.http.post('/api/metadata/enrich', {});
    }

    refreshImdbData(): Observable<any> {
        return this.http.post('/api/metadata/refresh-data', {});
    }

    clearMetadataCache(): Observable<any> {
        return this.http.post('/api/metadata/clear-cache', {});
    }

    searchTVMaze(query: string): Observable<any[]> {
        return this.http.post<any[]>('/api/metadata/search-tvmaze', { query });
    }

    saveMetadataOverride(data: any): Observable<any> {
        return this.http.post('/api/metadata/override', data);
    }

    // ── iptv-org Playlists ──────────────────────
    getSources(): Observable<SourceRecord[]> {
        return this.http.get<SourceRecord[]>('/api/sources');
    }

    probeSource(descriptor: unknown): Observable<ProbeResult> {
        return this.http.post<ProbeResult>('/api/sources/probe', { descriptor });
    }

    addSource(descriptor: unknown): Observable<any> {
        return this.http.post('/api/sources', { descriptor });
    }

    toggleSource(key: string, enabled: boolean): Observable<any> {
        return this.http.post(`/api/sources/${encodeURIComponent(key)}/toggle`, { enabled });
    }

    removeSource(key: string): Observable<any> {
        return this.http.delete(`/api/sources/${encodeURIComponent(key)}`);
    }

    exportSources(): Observable<any> {
        return this.http.get('/api/sources/export');
    }

    importSources(payload: unknown): Observable<any> {
        return this.http.post('/api/sources/import', payload);
    }

    getSourceCatalog(): Observable<BuiltInPresetDto[]> {
        return this.http.get<BuiltInPresetDto[]>('/api/sources/catalog');
    }

    getIptvOrgPlaylists(): Observable<any[]> {
        return this.http.get<any[]>('/api/iptv-org/playlists');
    }

    syncIptvOrgPlaylists(): Observable<any> {
        return this.http.post('/api/iptv-org/update-playlists', {});
    }

    // ── Channel Favorites (backend) ──────────────
    getFavorites(): Observable<string[]> {
        return this.http.get<string[]>('/api/channels/favorites');
    }

    addFavorite(channelId: string): Observable<any> {
        return this.http.post('/api/channels/favorites', { channel_id: channelId });
    }

    removeFavorite(channelId: string): Observable<any> {
        return this.http.delete(`/api/channels/favorites/${channelId}`);
    }

    // ── Hidden Channels (backend) ─────────────────
    getHiddenChannels(): Observable<string[]> {
        return this.http.get<string[]>('/api/channels/hidden');
    }

    hideChannel(channelId: string): Observable<any> {
        return this.http.post('/api/channels/hidden', { channel_id: channelId });
    }

    unhideChannel(channelId: string): Observable<any> {
        return this.http.delete(`/api/channels/hidden/${channelId}`);
    }

    // ── Recordings (backend) ─────────────────────
    getRecordingsList(): Observable<any[]> {
        return this.http.get<any[]>('/api/recordings');
    }

    deleteRecording(filename: string): Observable<any> {
        return this.http.delete(`/api/recordings/${filename}`);
    }

    getGrabSources(): Observable<any[]> {
        return this.http.get<any[]>('/api/grab/sources');
    }

    getEpgSources(): Observable<any[]> {
        return this.http.get<any[]>('/api/epg-sources');
    }

    toggleEpgSource(key: string, enabled: boolean): Observable<any> {
        return this.http.post(`/api/epg-sources/${encodeURIComponent(key)}/toggle`, { enabled });
    }

    syncEpgSources(): Observable<any> {
        return this.http.post('/api/epg-sources/sync', {});
    }

    getMatchAnalysis(): Observable<any> {
        return this.http.get<any>('/api/match/analysis');
    }
}
