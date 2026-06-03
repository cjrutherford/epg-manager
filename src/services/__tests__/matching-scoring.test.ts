import { calculateMatchScore } from '../epg';

describe('calculateMatchScore', () => {
    it('should assign a high score for exact ID matches', () => {
        const ch = { name: 'HBO HD', tvg_id: 'hbo.us' };
        const candidate = { xmltv_id: 'hbo.us', name: 'HBO', lang: 'en' };
        const res = calculateMatchScore(ch, candidate, 'exact_id');
        expect(res.score).toBeGreaterThanOrEqual(0.9);
        expect(res.reason).toContain('Exact ID Match');
    });

    it('should apply country match boost for matching country tags', () => {
        const ch = { name: 'US: HBO HD', group_title: 'US Movies' };
        const candidate = { xmltv_id: 'HBO.us', name: 'HBO US', lang: 'en' };
        const res = calculateMatchScore(ch, candidate, 'exact_name');
        // Base score for exact_name is 0.8. Since country matches, it gets +0.25 = 1.05
        expect(res.score).toBeCloseTo(1.05);
        expect(res.reason).toContain('Country Match');
    });

    it('should apply country mismatch penalty for mismatching country tags', () => {
        const ch = { name: 'US: Sky Sports', group_title: 'US Sports' };
        const candidate = { xmltv_id: 'SkySports.uk', name: 'Sky Sports', lang: 'en' };
        const res = calculateMatchScore(ch, candidate, 'exact_name');
        // Base score for exact_name is 0.8. Since country mismatches (US vs UK), it gets -0.40 = 0.40
        expect(res.score).toBeCloseTo(0.40);
        expect(res.reason).toContain('Country Mismatch');
    });

    it('should calculate fuzzy match score based on fuse similarity', () => {
        const ch = { name: 'Discovery Channel' };
        const candidate = { xmltv_id: 'discovery', name: 'Discovery', lang: 'en' };
        const res = calculateMatchScore(ch, candidate, 'fuzzy', 0.20);
        // Base score for fuzzy is 0.50 * (1 - 0.20) = 0.40
        expect(res.score).toBeCloseTo(0.40);
        expect(res.reason).toContain('Fuzzy Name Match');
    });
});
