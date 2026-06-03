/// <reference lib="webworker" />

type WorkerStartMessage = {
    type: 'start';
    recording: {
        id: string;
        streamUrl: string;
        endTime: string;
    };
};

type WorkerCancelMessage = { type: 'cancel'; id: string };

const active = new Map<string, boolean>();

function absoluteUrl(base: string, candidate: string): string {
    return new URL(candidate, base).toString();
}

function parseSegments(manifest: string, manifestUrl: string): string[] {
    return manifest
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => absoluteUrl(manifestUrl, line));
}

async function resolveManifestUrl(streamUrl: string): Promise<string> {
    const response = await fetch(streamUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Stream failed: ${response.status}`);
    await response.text();
    return response.url || streamUrl;
}

async function recordHls(recording: WorkerStartMessage['recording']): Promise<void> {
    active.set(recording.id, true);
    let sequence = 0;
    const seen = new Set<string>();
    const endTime = new Date(recording.endTime).getTime();
    const manifestUrl = await resolveManifestUrl(recording.streamUrl);

    while (active.get(recording.id) && Date.now() < endTime) {
        const manifestResponse = await fetch(manifestUrl, { cache: 'no-store' });
        if (!manifestResponse.ok) throw new Error(`Manifest failed: ${manifestResponse.status}`);
        const manifest = await manifestResponse.text();
        const segments = parseSegments(manifest, manifestUrl);

        for (const segmentUrl of segments) {
            if (!active.get(recording.id) || Date.now() >= endTime) break;
            if (seen.has(segmentUrl)) continue;
            seen.add(segmentUrl);

            const segmentResponse = await fetch(segmentUrl, { cache: 'no-store' });
            if (!segmentResponse.ok) continue;
            const data = await segmentResponse.arrayBuffer();
            postMessage({ type: 'segment', id: recording.id, sequence, data }, [data]);
            sequence++;
        }

        await new Promise(resolve => setTimeout(resolve, 3500));
    }

    if (active.get(recording.id)) {
        postMessage({ type: 'complete', id: recording.id });
    }
    active.delete(recording.id);
}

addEventListener('message', ({ data }: MessageEvent<WorkerStartMessage | WorkerCancelMessage>) => {
    if (data.type === 'cancel') {
        active.delete(data.id);
        postMessage({ type: 'cancelled', id: data.id });
        return;
    }

    if (data.type === 'start' && !active.get(data.recording.id)) {
        recordHls(data.recording).catch(error => {
            active.delete(data.recording.id);
            postMessage({ type: 'failed', id: data.recording.id, error: error instanceof Error ? error.message : String(error) });
        });
    }
});
