import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class ApiService {
    constructor(private http: HttpClient, private auth: AuthService) { }

    private authHeaders(): HttpHeaders {
        const token = this.auth.getToken();
        let headers = new HttpHeaders({ 'Content-Type': 'application/json' });
        if (token) {
            headers = headers.set('Authorization', `Bearer ${token}`);
        }
        return headers;
    }

    // ── Public endpoints (no auth) ──────────────
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

    getRecordings(status?: string): Observable<any[]> {
        const url = status ? `/api/recordings?status=${status}` : '/api/recordings';
        return this.http.get<any[]>(url);
    }

    getActiveRecordings(): Observable<any[]> {
        return this.http.get<any[]>('/api/recordings/active');
    }

    scheduleRecording(data: any): Observable<any> {
        return this.http.post('/api/dvr', data, { headers: this.authHeaders() });
    }

    cancelRecording(id: number): Observable<any> {
        return this.http.delete(`/api/dvr/${id}`, { headers: this.authHeaders() });
    }

    // ── Auth-protected endpoints ────────────────
    getConfig(): Observable<any> {
        return this.http.get('/api/config', { headers: this.authHeaders() });
    }

    saveConfig(config: any): Observable<any> {
        return this.http.post('/api/config', config, { headers: this.authHeaders() });
    }

    getSettings(): Observable<any> {
        return this.http.get('/api/settings', { headers: this.authHeaders() });
    }

    getMapping(): Observable<any[]> {
        return this.http.get<any[]>('/api/mapping', { headers: this.authHeaders() });
    }

    getChannels(): Observable<any[]> {
        return this.http.get<any[]>('/api/channels', { headers: this.authHeaders() });
    }

    toggleChannels(ids: string[], enabled: boolean): Observable<any> {
        return this.http.post('/api/channels/toggle', { ids, enabled }, { headers: this.authHeaders() });
    }

    updateChannel(id: string, data: any): Observable<any> {
        return this.http.put(`/api/channels/${id}`, data, { headers: this.authHeaders() });
    }

    setOverride(channelId: string, epgId: string | null): Observable<any> {
        return this.http.post('/api/override', { channel_id: channelId, epg_id: epgId }, { headers: this.authHeaders() });
    }

    searchEpg(query: string): Observable<any[]> {
        return this.http.get<any[]>(`/api/search-epg?q=${encodeURIComponent(query)}`, { headers: this.authHeaders() });
    }

    getPlaylists(): Observable<any> {
        return this.http.get<any>('/api/playlists', { headers: this.authHeaders() });
    }

    syncPlaylist(): Observable<any> {
        return this.http.post('/api/sync-playlist', {}, { headers: this.authHeaders() });
    }

    runFullSync(): Observable<any> {
        return this.http.post('/api/sync', {}, { headers: this.authHeaders() });
    }

    cancelSync(): Observable<any> {
        return this.http.post('/api/sync/cancel', {}, { headers: this.authHeaders() });
    }

    rebuildFiles(): Observable<any> {
        return this.http.post('/api/rebuild-files', {}, { headers: this.authHeaders() });
    }

    grabMissing(): Observable<any> {
        return this.http.post('/api/grab', {}, { headers: this.authHeaders() });
    }

    resetSystem(): Observable<any> {
        return this.http.post('/api/reset', {}, { headers: this.authHeaders() });
    }

    getGrabLogs(): Observable<any[]> {
        return this.http.get<any[]>('/api/grab-logs', { headers: this.authHeaders() });
    }

    // ── DVR Scheduler (scheduled recordings) ────
    getDvrSchedules(): Observable<any[]> {
        return this.http.get<any[]>('/api/dvr', { headers: this.authHeaders() });
    }

    getDvrStorage(): Observable<{ usedBytes: number; totalBytes: number }> {
        return this.http.get<{ usedBytes: number; totalBytes: number }>('/api/dvr/storage', { headers: this.authHeaders() });
    }

    stopDvr(id: number): Observable<any> {
        return this.http.post(`/api/dvr/stop/${id}`, {}, { headers: this.authHeaders() });
    }

    // ── Metadata ────────────────────────────────
    getMetadataConfig(): Observable<any> {
        return this.http.get('/api/metadata/config', { headers: this.authHeaders() });
    }

    saveMetadataConfig(data: any): Observable<any> {
        return this.http.post('/api/metadata/config', data, { headers: this.authHeaders() });
    }

    getMetadataStats(): Observable<any> {
        return this.http.get('/api/metadata/stats', { headers: this.authHeaders() });
    }

    triggerEnrichment(): Observable<any> {
        return this.http.post('/api/metadata/enrich', {}, { headers: this.authHeaders() });
    }

    refreshImdbData(): Observable<any> {
        return this.http.post('/api/metadata/refresh-data', {}, { headers: this.authHeaders() });
    }

    clearMetadataCache(): Observable<any> {
        return this.http.post('/api/metadata/clear-cache', {}, { headers: this.authHeaders() });
    }

    searchTVMaze(query: string): Observable<any[]> {
        return this.http.post<any[]>('/api/metadata/search-tvmaze', { query }, { headers: this.authHeaders() });
    }

    saveMetadataOverride(data: any): Observable<any> {
        return this.http.post('/api/metadata/override', data, { headers: this.authHeaders() });
    }

    // ── iptv-org Playlists ──────────────────────
    getIptvOrgPlaylists(): Observable<any[]> {
        return this.http.get<any[]>('/api/iptv-org/playlists', { headers: this.authHeaders() });
    }

    syncIptvOrgPlaylists(): Observable<any> {
        return this.http.post('/api/iptv-org/update-playlists', {}, { headers: this.authHeaders() });
    }

    // ── Channel Favorites (backend) ──────────────
    getFavorites(): Observable<string[]> {
        return this.http.get<string[]>('/api/channels/favorites');
    }

    addFavorite(channelId: string): Observable<any> {
        return this.http.post('/api/channels/favorites', { channel_id: channelId }, { headers: this.authHeaders() });
    }

    removeFavorite(channelId: string): Observable<any> {
        return this.http.delete(`/api/channels/favorites/${channelId}`, { headers: this.authHeaders() });
    }

    // ── Hidden Channels (backend) ─────────────────
    getHiddenChannels(): Observable<string[]> {
        return this.http.get<string[]>('/api/channels/hidden');
    }

    hideChannel(channelId: string): Observable<any> {
        return this.http.post('/api/channels/hidden', { channel_id: channelId }, { headers: this.authHeaders() });
    }

    unhideChannel(channelId: string): Observable<any> {
        return this.http.delete(`/api/channels/hidden/${channelId}`, { headers: this.authHeaders() });
    }

    // ── Recordings (backend) ─────────────────────
    getRecordingsList(): Observable<any[]> {
        return this.http.get<any[]>('/api/recordings', { headers: this.authHeaders() });
    }

    deleteRecording(filename: string): Observable<any> {
        return this.http.delete(`/api/recordings/${filename}`, { headers: this.authHeaders() });
    }
}
