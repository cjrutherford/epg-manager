import { eventBus, LogMessage, ProgressUpdate } from '../events';

/**
 * Simple TUI manager for Docker and terminal environments
 * Logs appear first, progress bar updates below
 * Completed phases are preserved and shown with a checkmark
 */
class TuiManager {
    private progressBars: Record<string, { 
        current: number, 
        total: number, 
        message: string, 
        completed: boolean,
        completedAt?: number 
    }> = {};
    private lastUpdate: number = 0;
    private isInitialized = false;

    init() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        eventBus.on('log', (log: LogMessage) => {
            this.handleLog(log);
        });

        eventBus.on('progress', (progress: ProgressUpdate) => {
            const existing = this.progressBars[progress.phase];
            const isComplete = progress.completed || (progress.total > 0 && progress.current >= progress.total);
            
            this.progressBars[progress.phase] = {
                current: progress.current,
                total: progress.total,
                message: progress.message,
                completed: isComplete,
                completedAt: isComplete ? Date.now() : existing?.completedAt
            };
            this.printProgress();
        });
    }

    private handleLog(log: LogMessage) {
        const time = new Date(log.timestamp).toLocaleTimeString([], { hour12: false });
        const prefix = `[${time}] [${log.type.toUpperCase().padEnd(7)}]`;
        console.log(`${prefix} ${log.message}`);
    }

    private printProgress() {
        const now = Date.now();
        // Throttle updates to every 300ms
        if (now - this.lastUpdate < 300) return;
        this.lastUpdate = now;

        // Get all phases, prioritizing active (non-completed) ones
        const phases = Object.entries(this.progressBars);
        if (phases.length === 0) return;
        
        // Sort: active phases first, then completed phases by completion time
        phases.sort((a, b) => {
            if (a[1].completed && !b[1].completed) return 1;
            if (!a[1].completed && b[1].completed) return -1;
            if (a[1].completed && b[1].completed) {
                return (b[1].completedAt || 0) - (a[1].completedAt || 0);
            }
            return 0;
        });
        
        // Show the most recent active phase, or the most recent completed phase
        const [phase, data] = phases[0];
        
        const label = phase.charAt(0).toUpperCase() + phase.slice(1);
        const percentage = data.total > 0 ? (data.current / data.total) : (data.completed ? 1 : 0);
        const barWidth = 40;
        const filledWidth = Math.floor(barWidth * percentage);
        
        const bar = '█'.repeat(filledWidth) + '░'.repeat(barWidth - filledWidth);
        const pct = Math.round(percentage * 100).toString().padStart(3);
        const checkmark = data.completed ? ' ✓' : '';
        
        // Format current/total display
        const countDisplay = data.total > 0 ? `${data.current}/${data.total}` : (data.completed ? 'Done' : '...');
        
        console.log(`${label.padEnd(8)} | ${bar} | ${pct}% | ${countDisplay.padEnd(10)} | ${data.message.substring(0, 45)}${checkmark}`);
    }
}

export const tui = new TuiManager();

