// Frontend debug logger for batch flow. Enabled in dev by default.
// Force on/off: localStorage 'fotoflow-debug' = '1' | '0', or VITE_DEBUG=1.
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('fotoflow-debug') : null;
export const DEBUG_ON =
  stored === '1' || (stored !== '0' && (import.meta.env.VITE_DEBUG === '1' || import.meta.env.DEV));

const ts = () => new Date().toISOString().slice(11, 23);

function fmt(data) {
  if (data === undefined) return '';
  try {
    let s = typeof data === 'string' ? data : JSON.stringify(data);
    if (s.length > 1000) s = s.slice(0, 1000) + '…(truncated)';
    return ` ${s}`;
  } catch {
    return ' [unserializable]';
  }
}

export const blog = {
  on: DEBUG_ON,
  log: (msg, data) => { if (DEBUG_ON) console.log(`${ts()} [BATCH-UI] ${msg}${fmt(data)}`); },
  warn: (msg, data) => { if (DEBUG_ON) console.warn(`${ts()} [BATCH-UI] ⚠️ ${msg}${fmt(data)}`); },
  error: (msg, data) => console.error(`${ts()} [BATCH-UI] ❌ ${msg}${fmt(data)}`),
  group: (label, fn) => {
    if (!DEBUG_ON) return fn?.();
    console.groupCollapsed(`${ts()} [BATCH-UI] ${label}`);
    try { return fn?.(); } finally { console.groupEnd(); }
  },
};

// One-liner to paste in DevTools console to toggle: localStorage.setItem('fotoflow-debug','1')
if (typeof window !== 'undefined') window.__fotoflowBatchDebug = (on = true) => {
  localStorage.setItem('fotoflow-debug', on ? '1' : '0');
  console.log(`[BATCH-UI] debug ${on ? 'ON — reload page' : 'OFF — reload page'}`);
};
