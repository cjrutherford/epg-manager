import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ClientRecordingService } from './client-recording.service';
import {
    describeDestination,
    failureReason,
    formatBytes,
    isSeriesCandidate,
    parseEpgTime,
    schedulability,
    statusClass,
    statusLabel,
    type ProgrammeLike,
    type RecordingDestination
} from './dvr-format';

export type { ProgrammeLike, RecordingDestination } from './dvr-format';

/**
 * The one place that decides how a programme gets recorded.
 *
 * There are two recorders: the server's, which keeps running when the browser
 * is closed, and the browser's, which is all an anonymous viewer has. Both the
 * admin DVR screen and the Watch overlay used to carry their own copy of the
 * scheduling logic, the time parsing and the status vocabulary — and they had
 * drifted, so the same programme could produce different results depending on
 * which screen you asked from.
 */

export interface ChannelLike {
    id: string;
    name?: string;
    logo?: string | null;
    tvg_logo?: string | null;
    stream_url?: string | null;
    url?: string | null;
}

export interface ScheduleRequest {
    channel: ChannelLike;
    programme: ProgrammeLike;
    /** Record every future showing, not just this one. */
    series?: boolean;
    /** Override the automatic choice of recorder. */
    destination?: RecordingDestination;
}

export interface ScheduleOutcome {
    destination: RecordingDestination;
    /** Episodes booked beyond this one, when a series rule was created. */
    seriesEpisodesScheduled: number;
    /** Ready to show the user. */
    message: string;
}

/** A programme window that could not be read is not schedulable. */
export class DvrScheduleError extends Error { }

@Injectable({ providedIn: 'root' })
export class DvrService {
    constructor(
        private api: ApiService,
        private auth: AuthService,
        private clientRecordings: ClientRecordingService
    ) { }

    // ── Shared vocabulary ───────────────────────
    // Delegated to a framework-free module so the same logic is unit tested
    // rather than only exercised through a component.

    parseEpgTime(value: string | null | undefined): Date | null {
        return parseEpgTime(value);
    }

    isSeriesCandidate(programme: ProgrammeLike | null, programmes: ProgrammeLike[] = []): boolean {
        return isSeriesCandidate(programme, programmes);
    }

    formatBytes(bytes: number): string {
        return formatBytes(bytes);
    }

    statusLabel(status: string): string {
        return statusLabel(status);
    }

    statusClass(status: string): string {
        return statusClass(status);
    }

    failureReason(recording: any): string | null {
        return failureReason(recording);
    }

    // ── Scheduling ──────────────────────────────

    /**
     * Where a recording will go if the caller does not say.
     *
     * The server recorder needs an admin session; without one the browser is
     * the only option. Signed in, the server wins — it keeps recording after
     * the tab closes.
     */
    preferredDestination(): RecordingDestination {
        return this.auth.isAuthenticatedSync ? 'server' : 'browser';
    }

    describeDestination(destination: RecordingDestination): string {
        return describeDestination(destination);
    }

    private streamUrlFor(channel: ChannelLike): string {
        return channel.stream_url || channel.url || '';
    }

    private logoFor(channel: ChannelLike): string | null {
        return channel.logo || channel.tvg_logo || null;
    }

    /**
     * Schedule one programme, or a standing series rule.
     *
     * Both surfaces route through here, so a programme scheduled from Watch and
     * the same programme scheduled from the DVR screen produce the same rows,
     * the same dedupe and the same series behaviour.
     */
    async schedule(request: ScheduleRequest): Promise<ScheduleOutcome> {
        const { channel, programme } = request;
        const window = schedulability(programme, Date.now());
        if (!window.ok) {
            throw new DvrScheduleError(window.reason);
        }
        const { start, stop } = window;

        const streamUrl = this.streamUrlFor(channel);
        if (!streamUrl) {
            throw new DvrScheduleError('That channel has no stream to record');
        }

        const destination = request.destination || this.preferredDestination();
        const description = programme.description ?? programme.desc ?? null;

        if (destination === 'browser') {
            if (request.series) {
                // The browser recorder has no rule engine — nothing runs when
                // the tab is closed — so a series here can only mean the
                // showings currently in the guide. Said plainly rather than
                // implied.
                throw new DvrScheduleError(
                    'Recording a whole series needs the server recorder. Sign in to schedule it, or record this episode in the browser.'
                );
            }

            await this.clientRecordings.schedule({
                channelId: channel.id,
                channelName: channel.name || channel.id,
                channelLogo: this.logoFor(channel),
                programTitle: programme.title,
                subTitle: programme.sub_title ?? null,
                episodeNum: programme.episode_num ?? null,
                description,
                thumbnail: programme.icon || this.logoFor(channel),
                category: programme.category ?? null,
                rating: programme.rating ?? null,
                startTime: start.toISOString(),
                endTime: stop.toISOString(),
                streamUrl
            });

            return {
                destination,
                seriesEpisodesScheduled: 0,
                message: `Recording '${programme.title}' ${this.describeDestination(destination)}`
            };
        }

        const result: any = await firstValueFrom(this.api.scheduleRecording({
            channel_id: channel.id,
            channel_name: channel.name,
            program_title: programme.title,
            start_time: start.toISOString(),
            end_time: stop.toISOString(),
            stream_url: streamUrl,
            thumbnail: programme.icon || this.logoFor(channel),
            sub_title: programme.sub_title ?? null,
            episode_num: programme.episode_num ?? null,
            description,
            rating: programme.rating ?? null,
            category: programme.category ?? null,
            record_series: !!request.series
        }));

        const extra = Number(result?.seriesEpisodesScheduled) || 0;

        if (request.series) {
            return {
                destination,
                seriesEpisodesScheduled: extra,
                message: extra > 0
                    ? `Recording '${programme.title}' — ${extra} further episode(s) scheduled, and new ones as the guide updates`
                    : `Recording every episode of '${programme.title}' as the guide updates`
            };
        }

        return {
            destination,
            seriesEpisodesScheduled: 0,
            message: `Recording '${programme.title}' ${this.describeDestination(destination)}`
        };
    }

    /**
     * Turn an API or scheduling error into something worth showing.
     * The status codes the DVR endpoint uses are all meaningful.
     */
    describeError(error: any, fallback = 'Could not schedule that recording'): string {
        if (error instanceof DvrScheduleError) return error.message;

        const status = error?.status;
        if (status === 401 || status === 403) {
            return 'Your session has expired — sign in again to schedule recordings';
        }
        if (status === 507) {
            return error?.error?.error || 'Not enough free disk space to record';
        }
        if (status === 409) {
            return error?.error?.error || 'That recording is already scheduled';
        }
        return error?.error?.error || error?.message || fallback;
    }
}
