import { filterNewQueueIds, getGrabBatchSizeForSite, prioritizeGrabSites } from '../pipeline-utils';

describe('filterNewQueueIds', () => {
  it('returns only unseen ids and mutates the seen set once', () => {
    const seen = new Set<string>(['a']);

    const result = filterNewQueueIds(['a', 'b', 'b', 'c', '', '  '], seen);

    expect(result).toEqual(['b', 'c']);
    expect(Array.from(seen)).toEqual(['a', 'b', 'c']);
  });
});

describe('site grab policies', () => {
  it('limits epg.iptvx.one to single-channel batches', () => {
    expect(getGrabBatchSizeForSite('epg.iptvx.one')).toBe(1);
    expect(getGrabBatchSizeForSite('distro.tv')).toBe(10);
  });

  it('moves epg.iptvx.one to the end of site processing', () => {
    expect(prioritizeGrabSites(['epg.iptvx.one', 'bein.com', 'distro.tv'])).toEqual([
      'bein.com',
      'distro.tv',
      'epg.iptvx.one'
    ]);
  });
});
