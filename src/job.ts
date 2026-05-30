import { eventBus } from './events';

export interface JobStatus {
    running: boolean;
    cancelRequested?: boolean;
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
    progress: Record<string, {
        phase: string;
        message: string;
        current: number;
        total: number;
        completed?: boolean;
    }> | null;
}

export const currentJob: JobStatus = {
    running: false,
    cancelRequested: false,
    startTime: null,
    endTime: null,
    stats: null,
    progress: null
};

// Listen for progress events to cache state
eventBus.on('progress', (data) => {
    if (currentJob.running) {
        if (!currentJob.progress) currentJob.progress = {};
        currentJob.progress[data.phase] = data;
    }
});

export function startJob() {
    currentJob.running = true;
    currentJob.cancelRequested = false;
    currentJob.startTime = Date.now();
    currentJob.endTime = null;
    currentJob.stats = null;
    currentJob.progress = null;
}

export function requestJobCancel() {
    if (currentJob.running) {
        currentJob.cancelRequested = true;
    }
}

export function completeJob(stats: JobStatus['stats']) {
    currentJob.running = false;
    currentJob.endTime = Date.now();
    currentJob.stats = stats;
}

export function getJobStatus(): JobStatus {
    return { ...currentJob };
}
