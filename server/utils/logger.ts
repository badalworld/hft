import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LogEntry, LogLevel } from '../types.js';

type LogSubscriber = (entry: LogEntry) => void;

class HftLogger {
  private entries: LogEntry[] = [];
  private readonly maxEntries = 1500;
  private subscribers = new Set<LogSubscriber>();
  private logDir = path.resolve(process.cwd(), 'data', 'logs');

  constructor() {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch {
      // ignore mkdir errors if read-only fs
    }
  }

  public subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  public log(
    level: LogLevel,
    module: LogEntry['module'],
    message: string,
    meta?: Record<string, unknown>
  ): LogEntry {
    const now = Date.now();
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      level,
      module,
      message,
      meta,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    // Persist asynchronously to daily log file
    const day = entry.isoTime.slice(0, 10);
    const logFile = path.join(this.logDir, `hft-${day}.log`);
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    const line = `[${entry.isoTime}] [${level}] [${module}] ${message}${metaStr}\n`;
    fs.promises.appendFile(logFile, line, 'utf8').catch(() => {});

    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch {
        // ignore subscriber errors
      }
    }

    return entry;
  }

  public info(module: LogEntry['module'], message: string, meta?: Record<string, unknown>) {
    return this.log('INFO', module, message, meta);
  }

  public success(module: LogEntry['module'], message: string, meta?: Record<string, unknown>) {
    return this.log('SUCCESS', module, message, meta);
  }

  public warn(module: LogEntry['module'], message: string, meta?: Record<string, unknown>) {
    return this.log('WARN', module, message, meta);
  }

  public error(module: LogEntry['module'], message: string, meta?: Record<string, unknown>) {
    return this.log('ERROR', module, message, meta);
  }

  public exec(module: LogEntry['module'], message: string, meta?: Record<string, unknown>) {
    return this.log('EXEC', module, message, meta);
  }

  public ai(module: LogEntry['module'], message: string, meta?: Record<string, unknown>) {
    return this.log('AI', module, message, meta);
  }

  public getLogs(limit = 500, levelFilter?: string, moduleFilter?: string): LogEntry[] {
    let list = this.entries;
    if (levelFilter && levelFilter !== 'ALL') {
      list = list.filter((e) => e.level === levelFilter);
    }
    if (moduleFilter && moduleFilter !== 'ALL') {
      list = list.filter((e) => e.module === moduleFilter);
    }
    return list.slice(-limit).reverse();
  }

  public clearMemoryLogs() {
    this.entries = [];
    this.info('ENGINE', 'In-memory log buffer cleared by operator.');
  }

  public exportPlainText(): string {
    return this.entries
      .map(
        (e) =>
          `[${e.isoTime}] [${e.level.padEnd(7)}] [${e.module.padEnd(11)}] ${e.message}${
            e.meta ? ' ' + JSON.stringify(e.meta) : ''
          }`
      )
      .join('\n');
  }
}

export const logger = new HftLogger();
