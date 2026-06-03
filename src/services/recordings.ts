export interface SystemRecording {
  id: number;
  source: 'system';
  channel_id: string;
  channel_name: string;
  program_title: string;
  start_time: string;
  end_time: string;
  status: string;
  filename: string | null;
  file_size: number | null;
  url: string | null;
  thumbnail: string | null;
  sub_title: string | null;
  episode_num: string | null;
  description: string | null;
  rating: string | null;
  category: string | null;
  error_message: string | null;
  created_at: number | null;
}

function value(row: Record<string, unknown>, key: string): string {
  const raw = row[key];
  return raw === null || raw === undefined ? '' : String(raw);
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const raw = value(row, key).trim();
  return raw ? raw : null;
}

function nullableNumber(row: Record<string, unknown>, key: string): number | null {
  const raw = row[key];
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapSystemRecordingRow(row: Record<string, unknown>): SystemRecording {
  const filename = nullableString(row, 'filename');
  const channelName = nullableString(row, 'channel_name') || nullableString(row, 'channel_fallback_name') || value(row, 'channel_id');
  const thumbnail = nullableString(row, 'thumbnail') || nullableString(row, 'program_icon') || nullableString(row, 'channel_logo');

  return {
    id: Number(row.id),
    source: 'system',
    channel_id: value(row, 'channel_id'),
    channel_name: channelName,
    program_title: value(row, 'program_title'),
    start_time: value(row, 'start_time'),
    end_time: value(row, 'end_time'),
    status: value(row, 'status') || 'scheduled',
    filename,
    file_size: nullableNumber(row, 'file_size'),
    url: filename ? `/files/recordings/${filename}` : null,
    thumbnail,
    sub_title: nullableString(row, 'sub_title'),
    episode_num: nullableString(row, 'episode_num'),
    description: nullableString(row, 'description'),
    rating: nullableString(row, 'rating'),
    category: nullableString(row, 'category'),
    error_message: nullableString(row, 'error_message'),
    created_at: nullableNumber(row, 'created_at'),
  };
}
