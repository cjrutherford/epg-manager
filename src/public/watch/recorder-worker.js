/* ===========================================
   IPTV Watch — Recordings Web Worker
   Polls the server for recording status updates
   and posts them back to the main thread.
   =========================================== */

let polling = false;
let pollInterval = null;

async function fetchRecordings() {
    try {
        const res = await fetch('/api/recordings');
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

async function poll() {
    const recordings = await fetchRecordings();
    if (recordings) {
        self.postMessage({ type: 'recordings-update', recordings });
    }
}

self.onmessage = function (e) {
    const msg = e.data;

    switch (msg.type) {
        case 'start':
            if (!polling) {
                polling = true;
                // Initial fetch
                poll();
                // Poll every 10 seconds
                pollInterval = setInterval(poll, 10000);
            }
            break;

        case 'stop':
            polling = false;
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
            break;

        case 'refresh':
            // Force immediate poll
            poll();
            break;
    }
};
