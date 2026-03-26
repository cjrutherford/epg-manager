
import { processEpg } from '../epg';
import { db } from '../../db';

jest.mock('../../db');
jest.mock('../../events'); // Mock events to avoid console noise
jest.mock('../../job');    // Mock job tracking

describe('processEpg Matching', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('matches channels correctly using tiered logic', async () => {
        // Mock DB responses
        const mockExecute = db.execute as jest.Mock;

        // 1. epg_channels (The available EPG data)
        const epgChannels = [
            { _id: 'bbc.one', 'display-name': 'BBC One' },
            { _id: 'cnn.us', 'display-name': 'CNN' },
            { _id: 'sky.sports.1', 'display-name': 'Sky Sports 1' },
            { _id: 'discovery', 'display-name': 'Discovery Channel' },
            { _id: 'my.channel', 'display-name': 'My Channel' }
        ];

        // 2. channels (The local channels to be matched)
        const dbChannels = [
            // Confirmed Match
            { id: 1, name: "BBC One", matched_epg_id: "bbc.one", match_type: "User Confirm" },
            // Manual Override
            { id: 2, name: "Random Name", matched_epg_id: null },
            // Exact ID Match
            { id: 3, name: "CNN News", tvg_id: "cnn.us" },
            // Strict Clean Match (Separator handling test)
            { id: 4, name: "Sky-Sports-1", tvg_id: "" },
            // Fuzzy Match
            { id: 5, name: "Discovery Chnl", tvg_id: "" }, // "Discovery Chnl" vs "Discovery Channel"
            // No Match
            { id: 6, name: "Unknown Channel", tvg_id: "" }
        ];

        // 3. Manual Overrides
        const manualOverrides = [
            { channel_id: 2, epg_id: "my.channel" } // Override for channel 2
        ];

        // Mock Sequence
        mockExecute
            // ... Grabbing loop skipped because epgUrls is empty ...

            // Start of matching logic
            .mockResolvedValueOnce({ rows: epgChannels }) // SELECT FROM epg_channels
            .mockResolvedValueOnce({ rows: dbChannels })  // SELECT FROM channels
            .mockResolvedValueOnce({ rows: manualOverrides }) // SELECT FROM manual_overrides
            // ... Updates ...
            .mockResolvedValue({ rows: [], rowsAffected: 1 }); // UPDATE statements

        await processEpg([], { skipIptvUpdate: true });

        // Verify Updates
        // We expect 6 updates (one for each channel)
        // Filter calls to db.execute that start with "UPDATE"
        const updateCalls = mockExecute.mock.calls.filter(call => call[0].sql && call[0].sql.startsWith("UPDATE"));

        expect(updateCalls.length).toBe(6);

        // 1. BBC One -> Confirmed Match
        expect(updateCalls[0][0].args).toEqual(['bbc.one', 'User Confirm (Confirmed)', 1]);

        // 2. Random Name -> Manual Override (my.channel)
        expect(updateCalls[1][0].args).toEqual(['my.channel', 'Manual Override', 2]);

        // 3. CNN News -> ID (Exact) (cnn.us)
        expect(updateCalls[2][0].args).toEqual(['cnn.us', 'ID (Exact)', 3]);

        // 4. Sky-Sports-1 -> Strict Clean (sky.sports.1) (Clean: "Sky Sports 1")
        expect(updateCalls[3][0].args).toEqual(['sky.sports.1', 'Strict Clean', 4]);

        // 5. Discovery Chnl -> Fuzzy (discovery)
        // Note: Fuse score might vary, just checking it matched
        expect(updateCalls[4][0].args[0]).toBe('discovery');
        expect(updateCalls[4][0].args[1]).toContain('Fuzzy');
        expect(updateCalls[4][0].args[2]).toBe(5);

        // 6. Unknown Channel -> NULL
        expect(updateCalls[5][0].args).toEqual([6]);

    });
});
