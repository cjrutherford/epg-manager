import { EventEmitter } from 'events';

export const eventBus = new EventEmitter();

export interface LogMessage {
    type: 'info' | 'success' | 'warning' | 'error';
    message: string;
    timestamp: number;
}

export interface ProgressUpdate {
    phase: 'match' | 'grab' | 'enrich';
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

export function emitProgress(message: string, current: number, total: number, phase: 'match' | 'grab' | 'enrich' = 'grab') {
    eventBus.emit('progress', {
        phase,
        message,
        current,
        total,
        completed: total > 0 && current >= total
    } as ProgressUpdate);
}

export function emitProgressComplete(phase: 'match' | 'grab' | 'enrich', message: string, total: number) {
    eventBus.emit('progress', {
        phase,
        message,
        current: total,
        total,
        completed: true
    } as ProgressUpdate);
}

