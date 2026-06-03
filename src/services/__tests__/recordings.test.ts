import { mapSystemRecordingRow } from '../recordings';

describe('recordings service', () => {
  it('maps scheduled recording rows into card-ready system recordings', () => {
    const mapped = mapSystemRecordingRow({
      id: 42,
      channel_id: 'abc',
      channel_name: '',
      channel_fallback_name: 'W Test',
      program_title: 'Sample Show',
      start_time: '2026-05-31T20:00:00.000Z',
      end_time: '2026-05-31T21:00:00.000Z',
      status: 'completed',
      filename: 'Sample_Show.mp4',
      file_size: 1024,
      thumbnail: '',
      program_icon: 'https://example.test/program.jpg',
      sub_title: 'Pilot',
      episode_num: 'S01E01',
      description: 'Episode description',
      rating: 'TV-PG',
      category: 'Drama',
      error_message: null,
      created_at: 123,
    });

    expect(mapped).toEqual({
      id: 42,
      source: 'system',
      channel_id: 'abc',
      channel_name: 'W Test',
      program_title: 'Sample Show',
      start_time: '2026-05-31T20:00:00.000Z',
      end_time: '2026-05-31T21:00:00.000Z',
      status: 'completed',
      filename: 'Sample_Show.mp4',
      file_size: 1024,
      url: '/files/recordings/Sample_Show.mp4',
      thumbnail: 'https://example.test/program.jpg',
      sub_title: 'Pilot',
      episode_num: 'S01E01',
      description: 'Episode description',
      rating: 'TV-PG',
      category: 'Drama',
      error_message: null,
      created_at: 123,
    });
  });
});
