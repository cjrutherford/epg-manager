import { findBuiltInByUrl, getBuiltInCatalog, getBuiltInSource, getFastSources, getGuideSources } from '../catalog';
import { validateDescriptor } from '../descriptor';

describe('built-in catalogue', () => {
  it('every entry is a valid descriptor', () => {
    for (const source of getBuiltInCatalog()) {
      const result = validateDescriptor(source);
      expect({ id: source.id, errors: result.errors }).toEqual({ id: source.id, errors: [] });
    }
  });

  it('ids are unique', () => {
    const ids = getBuiltInCatalog().map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fetch urls are unique, so no provider is listed twice', () => {
    const urls = getBuiltInCatalog().map(s => s.fetch.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('ships the six FAST platforms as channel sources', () => {
    const fast = getFastSources();
    expect(fast).toHaveLength(6);
    for (const source of fast) {
      expect(source.provides).toEqual(['channels']);
      expect(source.kind).toBe('m3u');
    }
  });

  it('ships the EPGShare feeds as guide sources', () => {
    const guide = getGuideSources();
    expect(guide).toHaveLength(10);
    for (const source of guide) {
      expect(source.provides).toEqual(['guide']);
      expect(source.kind).toBe('xmltv');
      expect(source.fetch.compression).toBe('gzip');
    }
  });

  it('nothing is enabled by default — adding a source stays a deliberate act', () => {
    for (const source of getBuiltInCatalog()) {
      expect(source.enabled).toBe(false);
    }
  });

  it('looks a source up by id and by url', () => {
    expect(getBuiltInSource('fast-plutotv')?.label).toBe('Pluto TV');
    expect(getBuiltInSource('nope')).toBeNull();
    expect(findBuiltInByUrl('https://i.mjh.nz/PlutoTV/all.m3u8')?.id).toBe('fast-plutotv');
    expect(findBuiltInByUrl('HTTPS://I.MJH.NZ/PlutoTV/all.m3u8')?.id).toBe('fast-plutotv');
    expect(findBuiltInByUrl('https://example.com/other.m3u')).toBeNull();
  });

  it('returns copies, so a caller cannot mutate the catalogue', () => {
    const first = getBuiltInCatalog();
    first[0].label = 'MUTATED';
    first[0].provides.push('guide');
    expect(getBuiltInCatalog()[0].label).not.toBe('MUTATED');
    expect(getBuiltInCatalog()[0].provides).toEqual(['channels']);
  });
});
