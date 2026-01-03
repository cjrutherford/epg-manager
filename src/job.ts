export interface JobStatus {
    running: boolean;
    startTime: number | null;
    endTime: number | null;
    stats: {
        channelsProcessed: number;
        programsProcessed: number;
        channelsMatched: number;
        totalChannels: number;
        filesGenerated: string[];
        customGrabCount: number;
    } | null;
}

export const currentJob: JobStatus = {
    running: false,
    startTime: null,
    endTime: null,
    stats: null
};

export function startJob() {
    currentJob.running = true;
    currentJob.startTime = Date.now();
    currentJob.endTime = null;
    currentJob.stats = null;
}

export function completeJob(stats: JobStatus['stats']) {
    currentJob.running = false;
    currentJob.endTime = Date.now();
    currentJob.stats = stats;
}

export function getJobStatus(): JobStatus {
    return { ...currentJob };
}
