import { EventEmitter } from 'events';

export const eventBus = new EventEmitter();

export interface LogMessage {
    type: 'info' | 'success' | 'warning' | 'error';
    message: string;
    timestamp: number;
}

export type ProgressPhase = 'playlist' | 'metadata' | 'match' | 'grab' | 'enrich' | 'rebuild';

export interface ProgressUpdate {
    phase: ProgressPhase;
    message: string;
    current: number;
    total: number;
    completed?: boolean;
}

export function emitLog(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info', noConsole = false) {
    eventBus.emit('log', {
        type,
        message,
        timestamp: Date.now()
    } as LogMessage);
    // TUI handles all terminal output via eventBus
}

export function emitProgress(message: string, current: number, total: number, phase: ProgressPhase = 'grab') {
    eventBus.emit('progress', {
        phase,
        message,
        current,
        total,
        completed: false
    } as ProgressUpdate);
}

export function emitProgressComplete(phase: ProgressPhase, message: string, total: number) {
    eventBus.emit('progress', {
        phase,
        message,
        current: total,
        total,
        completed: true
    } as ProgressUpdate);
}
