import {
  DUPLICATE_WINDOW_MS,
  selectSchedulableEpisodes,
  titlesMatch,
  toIsoTime,
  type EpisodeCandidate
} from '../series-rules';

const NOW = Date.parse('2026-08-14T12:00:00Z');

const episode = (over: Partial<EpisodeCandidate> = {}): EpisodeCandidate => ({
  title: 'The Show',
  start: '20260814200000 +0000',
  stop: '20260814210000 +0000',
  ...over
});

describe('toIsoTime', () => {
  it('converts XMLTV timestamps', () => {
    expect(toIsoTime('20260814200000 +0000')).toBe('2026-08-14T20:00:00.000Z');
  });

  it('applies a non-zero offset', () => {
    expect(toIsoTime('20260814200000 +0200')).toBe('2026-08-14T18:00:00.000Z');
  });

  it('passes ISO values through', () => {
    expect(toIsoTime('2026-08-14T20:00:00Z')).toBe('2026-08-14T20:00:00.000Z');
  });

  it('returns null for junk', () => {
    expect(toIsoTime('sometime')).toBeNull();
    expect(toIsoTime('')).toBeNull();
    expect(toIsoTime(null)).toBeNull();
  });
});

describe('titlesMatch', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(titlesMatch('  the show ', 'The Show')).toBe(true);
    expect(titlesMatch('The Show', 'The Show Two')).toBe(false);
  });
});

describe('selectSchedulableEpisodes', () => {
  it('books an upcoming episode', () => {
    const chosen = selectSchedulableEpisodes([episode()], [], NOW);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].startTimeIso).toBe('2026-08-14T20:00:00.000Z');
    expect(chosen[0].endTimeIso).toBe('2026-08-14T21:00:00.000Z');
  });

  it('skips episodes that have already started', () => {
    const chosen = selectSchedulableEpisodes([
      episode({ start: '20260814080000 +0000', stop: '20260814090000 +0000' })
    ], [], NOW);
    expect(chosen).toEqual([]);
  });

  it('never double-books one already on the schedule', () => {
    const chosen = selectSchedulableEpisodes(
      [episode()],
      [{ programTitle: 'The Show', startTimeIso: '2026-08-14T20:00:00.000Z' }],
      NOW
    );
    expect(chosen).toEqual([]);
  });

  it('matches an existing booking regardless of title casing', () => {
    const chosen = selectSchedulableEpisodes(
      [episode()],
      [{ programTitle: 'the show', startTimeIso: '2026-08-14T20:00:00.000Z' }],
      NOW
    );
    expect(chosen).toEqual([]);
  });

  it('treats a booking written in another format as the same episode', () => {
    // What the DVR endpoint stores when a client posts its own timestamp.
    const chosen = selectSchedulableEpisodes(
      [episode()],
      [{ programTitle: 'The Show', startTimeIso: '2026-08-14T20:00:04.706413+00:00' }],
      NOW
    );
    expect(chosen).toEqual([]);
  });

  it('treats a start time a few seconds off as the same showing', () => {
    const chosen = selectSchedulableEpisodes(
      [episode()],
      [{ programTitle: 'The Show', startTimeIso: '2026-08-14T20:00:08.000Z' }],
      NOW
    );
    expect(chosen).toEqual([]);
  });

  it('still books a showing outside the duplicate window', () => {
    const startIso = new Date(Date.parse('2026-08-14T20:00:00Z') - DUPLICATE_WINDOW_MS - 1000).toISOString();
    const chosen = selectSchedulableEpisodes(
      [episode()],
      [{ programTitle: 'The Show', startTimeIso: startIso }],
      NOW
    );
    expect(chosen).toHaveLength(1);
  });

  it('does not confuse a different show at the same time', () => {
    const chosen = selectSchedulableEpisodes(
      [episode()],
      [{ programTitle: 'Another Show', startTimeIso: '2026-08-14T20:00:00.000Z' }],
      NOW
    );
    expect(chosen).toHaveLength(1);
  });

  it('collapses duplicates inside one guide', () => {
    const chosen = selectSchedulableEpisodes([episode(), episode()], [], NOW);
    expect(chosen).toHaveLength(1);
  });

  it('books several distinct showings', () => {
    const chosen = selectSchedulableEpisodes([
      episode({ start: '20260814200000 +0000', stop: '20260814210000 +0000' }),
      episode({ start: '20260815200000 +0000', stop: '20260815210000 +0000' }),
      episode({ start: '20260816200000 +0000', stop: '20260816210000 +0000' })
    ], [], NOW);
    expect(chosen.map(e => e.startTimeIso)).toEqual([
      '2026-08-14T20:00:00.000Z',
      '2026-08-15T20:00:00.000Z',
      '2026-08-16T20:00:00.000Z'
    ]);
  });

  it('drops episodes whose times will not parse', () => {
    expect(selectSchedulableEpisodes([episode({ start: 'later' })], [], NOW)).toEqual([]);
    expect(selectSchedulableEpisodes([episode({ stop: '' })], [], NOW)).toEqual([]);
  });

  it('carries episode metadata through', () => {
    const chosen = selectSchedulableEpisodes([
      episode({ subTitle: 'Pilot', episodeNum: 'S01E01', category: 'Drama' })
    ], [], NOW);
    expect(chosen[0]).toMatchObject({ subTitle: 'Pilot', episodeNum: 'S01E01', category: 'Drama' });
  });

  it('re-running the pass adds nothing the second time', () => {
    const candidates = [
      episode({ start: '20260814200000 +0000', stop: '20260814210000 +0000' }),
      episode({ start: '20260815200000 +0000', stop: '20260815210000 +0000' })
    ];

    const first = selectSchedulableEpisodes(candidates, [], NOW);
    const booked = first.map(e => ({ programTitle: e.title, startTimeIso: e.startTimeIso }));
    const second = selectSchedulableEpisodes(candidates, booked, NOW);

    expect(first).toHaveLength(2);
    expect(second).toEqual([]);
  });
});
