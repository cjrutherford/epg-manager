import { Inject, Injectable, OnDestroy, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject } from 'rxjs';
import { ClientRecording, ClientRecordingScheduleInput } from './client-recording.types';

interface StoredSegment {
    id: string;
    recordingId: string;
    sequence: number;
    data: ArrayBuffer;
}

@Injectable({ providedIn: 'root' })
export class ClientRecordingService implements OnDestroy {
    private readonly dbName = 'tuner-daemon-client-recordings';
    private readonly dbVersion = 1;
    private dbPromise: Promise<IDBDatabase> | null = null;
    private worker: Worker | null = null;
    private schedulerInterval: ReturnType<typeof setInterval> | null = null;
    private objectUrls: string[] = [];
    private readonly isBrowser: boolean;
    private readonly recordingsSubject = new BehaviorSubject<ClientRecording[]>([]);
    readonly recordings$ = this.recordingsSubject.asObservable();

    constructor(@Inject(PLATFORM_ID) platformId: Object) {
        this.isBrowser = isPlatformBrowser(platformId);
        if (this.isBrowser) {
            void this.refresh();
            this.schedulerInterval = setInterval(() => void this.startDueRecordings(), 15000);
        }
    }

    ngOnDestroy(): void {
        if (this.schedulerInterval) clearInterval(this.schedulerInterval);
        if (this.worker) this.worker.terminate();
        this.revokeObjectUrls();
    }

    async schedule(input: ClientRecordingScheduleInput): Promise<ClientRecording> {
        const recording: ClientRecording = {
            id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            source: 'local',
            channelId: input.channelId,
            channelName: input.channelName,
            channelLogo: input.channelLogo || null,
            programTitle: input.programTitle,
            subTitle: input.subTitle || null,
            episodeNum: input.episodeNum || null,
            description: input.description || null,
            thumbnail: input.thumbnail || input.channelLogo || null,
            category: input.category || null,
            rating: input.rating || null,
            startTime: input.startTime,
            endTime: input.endTime,
            streamUrl: input.streamUrl,
            status: 'queued',
            sizeBytes: 0,
            segmentCount: 0,
            errorMessage: null,
            createdAt: Date.now(),
            completedAt: null,
        };

        await this.putRecording(recording);
        await this.refresh();
        void this.startDueRecordings();
        return recording;
    }

    async cancel(id: string): Promise<void> {
        const recording = await this.getRecording(id);
        if (!recording) return;
        if (this.worker) this.worker.postMessage({ type: 'cancel', id });
        recording.status = 'cancelled';
        recording.errorMessage = null;
        await this.putRecording(recording);
        await this.refresh();
    }

    async delete(id: string): Promise<void> {
        const db = await this.db();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['recordings', 'segments'], 'readwrite');
            tx.objectStore('recordings').delete(id);
            const index = tx.objectStore('segments').index('recordingId');
            const request = index.openCursor(IDBKeyRange.only(id));
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        await this.refresh();
    }

    async createPlaybackUrl(id: string): Promise<string | null> {
        const segments = await this.getSegments(id);
        if (segments.length === 0) return null;
        this.revokeObjectUrls();
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0'];
        for (const segment of segments) {
            const url = URL.createObjectURL(new Blob([segment.data], { type: 'video/mp2t' }));
            this.objectUrls.push(url);
            lines.push('#EXTINF:4.000,', url);
        }
        lines.push('#EXT-X-ENDLIST');
        const playlistUrl = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'application/vnd.apple.mpegurl' }));
        this.objectUrls.push(playlistUrl);
        return playlistUrl;
    }

    async download(id: string): Promise<void> {
        const recording = await this.getRecording(id);
        const segments = await this.getSegments(id);
        if (!recording || segments.length === 0) return;
        const blob = new Blob(segments.map(segment => segment.data), { type: 'video/mp2t' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${recording.programTitle || 'recording'}.ts`.replace(/[^\w.-]+/g, '_');
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async refresh(): Promise<void> {
        if (!this.isBrowser) return;
        const db = await this.db();
        const recordings = await new Promise<ClientRecording[]>((resolve, reject) => {
            const request = db.transaction('recordings', 'readonly').objectStore('recordings').getAll();
            request.onsuccess = () => resolve((request.result || []) as ClientRecording[]);
            request.onerror = () => reject(request.error);
        });
        recordings.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
        this.recordingsSubject.next(recordings);
    }

    private async startDueRecordings(): Promise<void> {
        if (!this.isBrowser) return;
        const recordings = await this.getRecordings();
        const now = Date.now();
        for (const recording of recordings) {
            const start = new Date(recording.startTime).getTime();
            const end = new Date(recording.endTime).getTime();
            if (recording.status === 'queued' && start <= now + 5000 && end > now) {
                await this.startRecording(recording);
            } else if (recording.status === 'queued' && end <= now) {
                recording.status = 'failed';
                recording.errorMessage = 'Recording window expired before the app could start it.';
                await this.putRecording(recording);
            }
        }
        await this.refresh();
    }

    private async startRecording(recording: ClientRecording): Promise<void> {
        this.ensureWorker();
        recording.status = 'recording';
        recording.errorMessage = null;
        await this.putRecording(recording);
        this.worker?.postMessage({
            type: 'start',
            recording: {
                id: recording.id,
                streamUrl: recording.streamUrl,
                endTime: recording.endTime,
            },
        });
    }

    private ensureWorker(): void {
        if (this.worker) return;
        this.worker = new Worker(new URL('./client-recorder.worker', import.meta.url), { type: 'module' });
        this.worker.onmessage = event => void this.handleWorkerMessage(event.data);
    }

    private async handleWorkerMessage(message: any): Promise<void> {
        const recording = await this.getRecording(message.id);
        if (!recording) return;

        if (message.type === 'segment') {
            const segment: StoredSegment = {
                id: `${message.id}:${message.sequence}`,
                recordingId: message.id,
                sequence: message.sequence,
                data: message.data,
            };
            await this.putSegment(segment);
            recording.segmentCount += 1;
            recording.sizeBytes += message.data.byteLength || 0;
            await this.putRecording(recording);
        } else if (message.type === 'complete') {
            recording.status = recording.segmentCount > 0 ? 'completed' : 'failed';
            recording.completedAt = Date.now();
            recording.errorMessage = recording.segmentCount > 0 ? null : 'No video segments were captured.';
            await this.putRecording(recording);
        } else if (message.type === 'failed') {
            recording.status = 'failed';
            recording.errorMessage = message.error || 'Recording failed.';
            await this.putRecording(recording);
        }

        await this.refresh();
    }

    private async getRecordings(): Promise<ClientRecording[]> {
        await this.refresh();
        return this.recordingsSubject.value;
    }

    private async getRecording(id: string): Promise<ClientRecording | null> {
        const db = await this.db();
        return new Promise((resolve, reject) => {
            const request = db.transaction('recordings', 'readonly').objectStore('recordings').get(id);
            request.onsuccess = () => resolve((request.result as ClientRecording) || null);
            request.onerror = () => reject(request.error);
        });
    }

    private async putRecording(recording: ClientRecording): Promise<void> {
        const db = await this.db();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('recordings', 'readwrite');
            tx.objectStore('recordings').put(recording);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    private async putSegment(segment: StoredSegment): Promise<void> {
        const db = await this.db();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('segments', 'readwrite');
            tx.objectStore('segments').put(segment);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    private async getSegments(recordingId: string): Promise<StoredSegment[]> {
        const db = await this.db();
        const segments = await new Promise<StoredSegment[]>((resolve, reject) => {
            const request = db.transaction('segments', 'readonly')
                .objectStore('segments')
                .index('recordingId')
                .getAll(recordingId);
            request.onsuccess = () => resolve((request.result || []) as StoredSegment[]);
            request.onerror = () => reject(request.error);
        });
        return segments.sort((a, b) => a.sequence - b.sequence);
    }

    private db(): Promise<IDBDatabase> {
        if (!this.dbPromise) {
            this.dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, this.dbVersion);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('recordings')) {
                        db.createObjectStore('recordings', { keyPath: 'id' });
                    }
                    if (!db.objectStoreNames.contains('segments')) {
                        const store = db.createObjectStore('segments', { keyPath: 'id' });
                        store.createIndex('recordingId', 'recordingId');
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return this.dbPromise;
    }

    private revokeObjectUrls(): void {
        for (const url of this.objectUrls) URL.revokeObjectURL(url);
        this.objectUrls = [];
    }
}
