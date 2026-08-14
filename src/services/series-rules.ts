/**
 * Series pass policy — which upcoming episodes a rule should schedule.
 *
 * Kept pure so the "which episodes, and not twice" decision can be tested
 * without a database. The recorder supplies the programmes, the existing
 * schedule and the clock.
 */

export interface EpisodeCandidate {
    title: string;
    /** XMLTV (`20260814120000 +0000`) or ISO. */
    start: string;
    stop: string;
    subTitle?: string | null;
    episodeNum?: string | null;
    description?: string | null;
    rating?: string | null;
    category?: string | null;
    icon?: string | null;
}

export interface ScheduledEpisode extends EpisodeCandidate {
    startTimeIso: string;
    endTimeIso: string;
}

export interface ExistingBooking {
    programTitle: string;
    startTimeIso: string;
}

/**
 * Convert an XMLTV timestamp to ISO. Values already in ISO pass through, so a
 * mixed table (scraped rows and direct-feed rows) is handled either way.
 */
export function toIsoTime(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;

    // Already ISO-ish
    if (trimmed.includes('-') && trimmed.includes(':')) {
        const parsed = Date.parse(trimmed);
        return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
    }

    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(trimmed);
    if (!match) return null;

    const [, year, month, day, hour, minute, second, offset] = match;
    const zone = offset ? `${offset.slice(0, 3)}:${offset.slice(3)}` : 'Z';
    const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second || '00'}${zone}`);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Case- and whitespace-insensitive title match, as a rule is stored by title. */
export function titlesMatch(left: string, right: string): boolean {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * How far two start times can drift and still be the same showing.
 *
 * Bookings do not all arrive by the same route: one may be written from the
 * guide row, another from a client that rounded the time, another from a feed
 * that shifted the listing by a minute on refresh. Comparing timestamps exactly
 * books the same episode twice, so the same title on the same channel within
 * this window is treated as already scheduled.
 */
export const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

interface Booked {
    title: string;
    startMs: number;
}

function isAlreadyBooked(booked: Booked[], title: string, startMs: number): boolean {
    const normalized = title.trim().toLowerCase();
    return booked.some(entry =>
        entry.title === normalized && Math.abs(entry.startMs - startMs) <= DUPLICATE_WINDOW_MS
    );
}

/**
 * Pick the episodes a rule should book.
 *
 * Three things are excluded: episodes that have already started (booking those
 * produces a recording that can only fail), episodes already on the schedule,
 * and anything whose times will not parse. Duplicates within the incoming set
 * are collapsed too, so a guide listing the same showing twice books once.
 */
export function selectSchedulableEpisodes(
    candidates: EpisodeCandidate[],
    existing: ExistingBooking[],
    now: number
): ScheduledEpisode[] {
    // Existing rows are normalised through the same parser: the schedule holds
    // a mix of formats depending on which path wrote the row.
    const booked: Booked[] = [];
    for (const booking of existing) {
        const iso = toIsoTime(booking.startTimeIso);
        if (!iso) continue;
        booked.push({ title: booking.programTitle.trim().toLowerCase(), startMs: Date.parse(iso) });
    }

    const chosen: ScheduledEpisode[] = [];

    for (const candidate of candidates) {
        const startTimeIso = toIsoTime(candidate.start);
        const endTimeIso = toIsoTime(candidate.stop);
        if (!startTimeIso || !endTimeIso) continue;

        // Already begun — the DVR cannot record the start of it.
        const startMs = Date.parse(startTimeIso);
        if (startMs <= now) continue;

        if (isAlreadyBooked(booked, candidate.title, startMs)) continue;
        booked.push({ title: candidate.title.trim().toLowerCase(), startMs });

        chosen.push({ ...candidate, startTimeIso, endTimeIso });
    }

    return chosen;
}
