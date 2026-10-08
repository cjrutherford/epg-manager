import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ChannelEventsService {
  private updated$ = new Subject<void>();

  get updates(): Observable<void> {
    return this.updated$.asObservable();
  }

  notifyUpdated(): void {
    this.updated$.next();
    // cross-tab via storage event
    try {
      localStorage.setItem('tuner_daemon_channels_updated', String(Date.now()));
    } catch {}
  }
}
