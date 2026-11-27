const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Upper bound for all daily log files together. Each file is also capped at
// 20 MB and kept 14 days (errors 30), but a runaway loop could still write
// many 20 MB files in one day, so the oldest are deleted past this total.
const MAX_LOG_DIR_BYTES = 100 * 1024 * 1024;
const DAILY_LOG_RE = /^(application|error)-\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/;

/**
 * Delete the oldest daily log files in `dir` until they total at most
 * `maxBytes`. The newest file of each kind is the one being written and is
 * always kept. Other files are never touched. Returns the removed names.
 */
function pruneLogDir(dir, maxBytes = MAX_LOG_DIR_BYTES) {
  const removed = [];
  let files;
  try {
    files = fs.readdirSync(dir)
      .map((name) => {
        const match = name.match(DAILY_LOG_RE);
        if (!match) return null;
        try {
          const stat = fs.statSync(path.join(dir, name));
          return stat.isFile() ? { name, kind: match[1], size: stat.size, mtime: stat.mtimeMs } : null;
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime);
  } catch (_) {
    return removed;
  }
  const newest = new Map();
  for (const file of files) newest.set(file.kind, file.name);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (total <= maxBytes) break;
    if (newest.get(file.kind) === file.name) continue;
    try {
      fs.unlinkSync(path.join(dir, file.name));
      total -= file.size;
      removed.push(file.name);
    } catch (_) { /* in use or already gone */ }
  }
  return removed;
}

class Logger {
  constructor() {
    this.logDir = path.join(os.homedir(), '.Cuewell', 'logs');
    this.ensurePrivateLogDir();
    this.setupLogger();
    pruneLogDir(this.logDir);
  }

  // Logs describe the user's session, so only the current user may read
  // them. mkdirSync's mode only applies to folders it creates; an existing
  // folder is tightened with chmod. Never block startup on this.
  ensurePrivateLogDir() {
    try {
      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.logDir, 0o700);
    } catch (_) { /* best effort */ }
  }

  setupLogger() {
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, stack, service, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        const serviceStr = service ? `[${service}]` : '';
        const stackStr = stack ? `\n${stack}` : '';
        return `${timestamp} ${level.toUpperCase()} ${serviceStr} ${message}${stackStr}${metaStr ? `\n${metaStr}` : ''}`;
      })
    );

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: logFormat,
      defaultMeta: { pid: process.pid },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            logFormat
          ),
          stderrLevels: ['error', 'warn']
        }),
        this.dailyFile({
          filename: path.join(this.logDir, 'application-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '14d',
          level: 'info'
        }),
        this.dailyFile({
          filename: path.join(this.logDir, 'error-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '30d',
          level: 'error'
        })
      ],
      // main.js keeps the app running after an uncaught exception or
      // rejection; winston's default (exitOnError: true) would quit it
      // right after writing the log line.
      exitOnError: false,
      // At most 5 MB per file and 2 files each.
      exceptionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'exceptions.log'),
          maxsize: 5 * 1024 * 1024,
          maxFiles: 2,
          tailable: true
        })
      ],
      rejectionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'rejections.log'),
          maxsize: 5 * 1024 * 1024,
          maxFiles: 2,
          tailable: true
        })
      ]
    });
  }

  /** A daily rotating file that also enforces MAX_LOG_DIR_BYTES on each rotation. */
  dailyFile(options) {
    const transport = new DailyRotateFile(options);
    transport.on('rotate', () => pruneLogDir(this.logDir));
    return transport;
  }

  createServiceLogger(serviceName) {
    return {
      debug: (message, meta = {}) => this.logger.debug(message, { service: serviceName, ...meta }),
      info: (message, meta = {}) => this.logger.info(message, { service: serviceName, ...meta }),
      warn: (message, meta = {}) => this.logger.warn(message, { service: serviceName, ...meta }),
      error: (message, meta = {}) => this.logger.error(message, { service: serviceName, ...meta }),
      logPerformance: (operation, startTime, metadata = {}) => this.logPerformance(operation, startTime, { service: serviceName, ...metadata })
    };
  }

  getSystemMetrics() {
    return {
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      platform: process.platform,
      nodeVersion: process.version
    };
  }

  logPerformance(operation, startTime, metadata = {}) {
    const duration = Date.now() - startTime;
    this.logger.info(`Performance: ${operation} completed`, {
      service: 'PERFORMANCE',
      duration: `${duration}ms`,
      ...metadata
    });
    return duration;
  }
}

const instance = new Logger();
instance.pruneLogDir = pruneLogDir;
module.exports = instance;