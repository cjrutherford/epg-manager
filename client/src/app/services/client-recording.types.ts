export type ClientRecordingStatus = 'queued' | 'recording' | 'completed' | 'failed' | 'cancelled';

export interface ClientRecording {
    id: string;
    source: 'local';
    channelId: string;
    channelName: string;
    channelLogo: string | null;
    programTitle: string;
    subTitle: string | null;
    episodeNum: string | null;
    description: string | null;
    thumbnail: string | null;
    category: string | null;
    rating: string | null;
    startTime: string;
    endTime: string;
    streamUrl: string;
    status: ClientRecordingStatus;
    sizeBytes: number;
    segmentCount: number;
    errorMessage: string | null;
    createdAt: number;
    completedAt: number | null;
}

export interface ClientRecordingScheduleInput {
    channelId: string;
    channelName: string;
    channelLogo?: string | null;
    programTitle: string;
    subTitle?: string | null;
    episodeNum?: string | null;
    description?: string | null;
    thumbnail?: string | null;
    category?: string | null;
    rating?: string | null;
    startTime: string;
    endTime: string;
    streamUrl: string;
}

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
