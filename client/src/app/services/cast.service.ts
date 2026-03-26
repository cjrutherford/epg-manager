/// <reference types="chromecast-caf-sender" />
import { Injectable, NgZone, Inject, PLATFORM_ID } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { isPlatformBrowser } from '@angular/common';

export interface CastState {
    isAvailable: boolean;
    isConnected: boolean;
    isCasting: boolean;
}

@Injectable({
    providedIn: 'root'
})
export class CastService {
    private castState = new BehaviorSubject<CastState>({
        isAvailable: false,
        isConnected: false,
        isCasting: false
    });

    castState$ = this.castState.asObservable();

    private castContext: cast.framework.CastContext | null = null;
    private currentSession: cast.framework.CastSession | null = null;
    private isBrowser: boolean;

    constructor(private ngZone: NgZone, @Inject(PLATFORM_ID) platformId: Object) {
        this.isBrowser = isPlatformBrowser(platformId);
        if (this.isBrowser) {
            this.initializeCastApi();
        }
    }

    private initializeCastApi() {
        (window as any)['__onGCastApiAvailable'] = (isAvailable: boolean) => {
            if (isAvailable) {
                this.ngZone.run(() => {
                    this.castState.next({ ...this.castState.value, isAvailable: true });
                    this.initCastContext();
                });
            }
        };
    }

    private initCastContext() {
        this.castContext = cast.framework.CastContext.getInstance();
        this.castContext.setOptions({
            receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        });

        this.castContext.addEventListener(
            cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
            (event: cast.framework.SessionStateEventData) => {
                this.ngZone.run(() => {
                    const isConnected = event.sessionState === cast.framework.SessionState.SESSION_STARTED ||
                        event.sessionState === cast.framework.SessionState.SESSION_RESUMED;
                    this.currentSession = this.castContext?.getCurrentSession() || null;
                    this.castState.next({
                        ...this.castState.value,
                        isConnected,
                        isCasting: isConnected
                    });
                });
            }
        );
    }

    async loadMedia(url: string, title: string, subtitle?: string, imageUrl?: string) {
        if (!this.currentSession) return;

        const mediaInfo = new chrome.cast.media.MediaInfo(url, 'application/x-mpegurl');
        const metadata = new chrome.cast.media.GenericMediaMetadata();

        metadata.title = title;
        if (subtitle) metadata.subtitle = subtitle;
        if (imageUrl) metadata.images = [new chrome.cast.Image(imageUrl)];

        mediaInfo.metadata = metadata;
        mediaInfo.streamType = chrome.cast.media.StreamType.LIVE;

        const request = new chrome.cast.media.LoadRequest(mediaInfo);

        try {
            await this.currentSession.loadMedia(request);
            console.log('Media loaded successfully to cast receiver');
        } catch (e) {
            console.error('Failed to load media', e);
        }
    }

    stopCasting() {
        if (this.currentSession) {
            this.currentSession.endSession(true);
        }
    }
}
