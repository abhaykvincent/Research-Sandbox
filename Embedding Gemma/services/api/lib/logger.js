// Tiny structured logger — no deps. Control verbosity with:
//   LOG_LEVEL=debug|info|warn|error   (default: debug when DEBUG=1, else info)
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const envLevel = (process.env.LOG_LEVEL || (process.env.DEBUG ? 'debug' : 'info')).toLowerCase();
const CURRENT = LEVELS[envLevel] ?? LEVELS.info;

const ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

function fmtData(data) {
  if (data === undefined) return '';
  try {
    let s = typeof data === 'string' ? data : JSON.stringify(data);
    if (s.length > 800) s = s.slice(0, 800) + '…(truncated)';
    return ` ${s}`;
  } catch {
    return ' [unserializable]';
  }
}

function log(level, tag, msg, data) {
  if (LEVELS[level] < CURRENT) return;
  const line = `${ts()} [${level.toUpperCase()}] [${tag}] ${msg}${fmtData(data)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  level: Object.keys(LEVELS).find((k) => LEVELS[k] === CURRENT) ?? 'info',
  debug: (tag, msg, data) => log('debug', tag, msg, data),
  info: (tag, msg, data) => log('info', tag, msg, data),
  warn: (tag, msg, data) => log('warn', tag, msg, data),
  error: (tag, msg, data) => log('error', tag, msg, data),
};
