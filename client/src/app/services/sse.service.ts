import { Injectable, NgZone } from '@angular/core';
import { Subject, Observable, BehaviorSubject } from 'rxjs';

export interface SseLogEvent {
    message: string;
    level: string;
}

export interface SseProgressEvent {
    phase: string;
    message: string;
    current: number;
    total: number;
    label?: string;
    completed?: boolean;
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

@Injectable({ providedIn: 'root' })
export class SseService {
    private eventSource: EventSource | null = null;
    private logs$ = new Subject<SseLogEvent>();
    private progress$ = new Subject<SseProgressEvent>();
    private report$ = new Subject<any>();
    private connectionStatus$ = new BehaviorSubject<ConnectionStatus>('disconnected');
    private reconnectAttempt = 0;
    private reconnectTimer: any = null;

    constructor(private zone: NgZone) { }

    get logEvents(): Observable<SseLogEvent> { return this.logs$.asObservable(); }
    get progressEvents(): Observable<SseProgressEvent> { return this.progress$.asObservable(); }
    get reportEvents(): Observable<any> { return this.report$.asObservable(); }
    get status(): Observable<ConnectionStatus> { return this.connectionStatus$.asObservable(); }

    connect(): void {
        if (this.eventSource) return;

        this.zone.runOutsideAngular(() => {
            const EventSourceImpl = (typeof window !== 'undefined' && (window as any)['__zone_symbol__EventSource']) || EventSource;
            const es = new EventSourceImpl('/api/progress');
            this.eventSource = es;

            es.onopen = () => {
                this.zone.run(() => {
                    this.reconnectAttempt = 0;
                    this.connectionStatus$.next('connected');
                });
            };

            es.addEventListener('log', (event: any) => {
                this.zone.run(() => {
                    if (this.connectionStatus$.value !== 'connected') {
                        this.connectionStatus$.next('connected');
                    }
                    try { this.logs$.next(JSON.parse(event.data)); } catch { }
                });
            });

            es.addEventListener('progress', (event: any) => {
                this.zone.run(() => {
                    if (this.connectionStatus$.value !== 'connected') {
                        this.connectionStatus$.next('connected');
                    }
                    try { this.progress$.next(JSON.parse(event.data)); } catch { }
                });
            });

            es.addEventListener('report', (event: any) => {
                this.zone.run(() => {
                    try { this.report$.next(JSON.parse(event.data)); } catch { }
                });
            });

            es.onerror = () => {
                this.zone.run(() => {
                    this.disconnect();
                    this.connectionStatus$.next('reconnecting');
                    this.reconnectAttempt++;
                    const backoffMs = Math.min(30000, Math.pow(2, Math.min(this.reconnectAttempt, 5)) * 1000 + Math.floor(Math.random() * 500));
                    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = setTimeout(() => this.connect(), backoffMs);
                });
            };
        });
    }

    disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        this.connectionStatus$.next('disconnected');
    }
}

