import { Injectable, NgZone } from '@angular/core';
import { Subject, Observable } from 'rxjs';

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

@Injectable({ providedIn: 'root' })
export class SseService {
    private eventSource: EventSource | null = null;
    private logs$ = new Subject<SseLogEvent>();
    private progress$ = new Subject<SseProgressEvent>();
    private report$ = new Subject<any>();

    constructor(private zone: NgZone) { }

    get logEvents(): Observable<SseLogEvent> { return this.logs$.asObservable(); }
    get progressEvents(): Observable<SseProgressEvent> { return this.progress$.asObservable(); }
    get reportEvents(): Observable<any> { return this.report$.asObservable(); }

    connect(): void {
        if (this.eventSource) return;

        this.zone.runOutsideAngular(() => {
            const EventSourceImpl = (typeof window !== 'undefined' && (window as any)['__zone_symbol__EventSource']) || EventSource;
            const es = new EventSourceImpl('/api/progress');
            this.eventSource = es;

            es.addEventListener('log', (event: any) => {
                this.zone.run(() => {
                    try { this.logs$.next(JSON.parse(event.data)); } catch { }
                });
            });

            es.addEventListener('progress', (event: any) => {
                this.zone.run(() => {
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
                    setTimeout(() => this.connect(), 5000);
                });
            };
        });
    }

    disconnect(): void {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }
}
