import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { buildStory, fetchServerStory, formatShotTime, ORDERINGS } from '../utils/story.js';
import { blog } from '../utils/debugLog.js';

const API_URL = import.meta.env.VITE_API_URL || '';
const PALETTE = ['#d6a85c', '#4ade80', '#60a5fa', '#f472b6', '#a78bfa', '#fbbf24', '#2dd4bf', '#fb7185'];
const colorFor = (c) => PALETTE[c % PALETTE.length];
const SLIDE_MS = 2500;

function placeholderFor(name = '?') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const initial = (name.split('/').pop()?.[0] ?? '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="hsl(${hue},30%,22%)"/><text x="50%" y="54%" font-family="sans-serif" font-size="96" font-weight="700" fill="hsl(${hue},60%,75%)" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function ThumbImg({ src, alt, className }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [src]);
  return <img src={err || !src ? placeholderFor(alt) : src} alt={alt} loading="lazy" onError={() => setErr(true)} className={className} />;
}

/** Re-label Opener / Beats / Finale after a manual reorder. */
function recaption(shots) {
  return shots.map((s, i) => ({
    ...s,
    position: i + 1,
    caption: `${shots.length <= 1 ? 'Single highlight' : i === 0 ? 'Opener' : i === shots.length - 1 ? 'Finale' : `Beat ${i + 1}`} — Moment ${s.cluster + 1} · match ${s.centrality?.toFixed(2) ?? 'n/a'}`,
  }));
}

export default function StorytellingExperiment() {
  const { batchId, batch } = useSelector((s) => s.batch);
  const [items, setItems] = useState([]); // { name, vector, capturedAt, thumbUrl }
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [timeNote, setTimeNote] = useState(null);
  const [k, setK] = useState(3);
  const [targetCount, setTargetCount] = useState(8);
  const [ordering, setOrdering] = useState('chrono');

  // Editable timeline: array of sourceIndex into `items`. Reset whenever the
  // auto-sequence changes (k / length / ordering / source).
  const [timeline, setTimeline] = useState([]);
  const [coverPos, setCoverPos] = useState(0);
  const [previewPos, setPreviewPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [serverCheck, setServerCheck] = useState(null); // parity result string
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  const story = useMemo(() => {
    if (items.length < 2) return null;
    try {
      return buildStory(items, { k, targetCount, ordering });
    } catch (err) {
      return { error: err.message };
    }
  }, [items, k, targetCount, ordering]);

  const storySig = story && !story.error ? story.sequence.map((s) => s.sourceIndex).join(',') + `|${story.ordering}|${story.k}` : null;
  useEffect(() => {
    if (storySig) {
      const order = storySig.split('|')[0].split(',').map(Number);
      setTimeline(order);
      setCoverPos(0);
      setPreviewPos(0);
      setPlaying(false);
      setServerCheck(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storySig]);

  // Slideshow player.
  useEffect(() => {
    if (!playing || timeline.length < 2) return undefined;
    const t = setInterval(() => setPreviewPos((p) => (p + 1) % timeline.length), SLIDE_MS);
    return () => clearInterval(t);
  }, [playing, timeline.length]);

  const loadBatch = async () => {
    if (!batchId) return;
    setStatus('loading');
    setError(null);
    setTimeNote(null);
    setServerCheck(null);
    try {
      blog.log('story loading batch vectors', { batchId: batchId.slice(0, 8) });
      const res = await fetch(`${API_URL}/api/batch-jobs/${batchId}?includeVectors=true`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Fetch failed: ${res.status}`);
      const vec = (data.items ?? [])
        .map((i) => ({
          name: i.fileName,
          vector: i.vector ?? i._vector,
          capturedAt: i.capturedAt ?? null,
          thumbUrl: batchId ? `${API_URL}/api/batch-jobs/${batchId}/thumb?file=${encodeURIComponent(i.fileName)}` : null,
        }))
        .filter((i) => i.vector?.length);
      if (vec.length < 2) throw new Error(`Need ≥2 vectors for a story (got ${vec.length})`);
      if (new Set(vec.map((v) => v.vector.length)).size > 1) throw new Error('Mixed vector dims — re-run batch with one dims setting');
      const withTime = vec.filter((v) => v.capturedAt).length;
      if (withTime === 0) {
        setTimeNote('No capture timestamps in this batch (processed before M6) — chronological order falls back to file names. Re-process the shoot to capture shoot order.');
      } else if (withTime < vec.length) {
        setTimeNote(`Capture time known for ${withTime}/${vec.length} photos — the rest sort by file name.`);
      }
      setItems(vec);
      setK(Math.min(3, vec.length - 1));
      setTargetCount(Math.min(8, vec.length));
      setStatus('ready');
      blog.log('story batch loaded', { n: vec.length, withTime });
    } catch (err) {
      setStatus('failed');
      setError(err.message);
      blog.error('story batch load FAILED', { error: err.message });
    }
  };

  const move = (pos, dir) => {
    const j = pos + dir;
    if (j < 0 || j >= timeline.length) return;
    const next = [...timeline];
    [next[pos], next[j]] = [next[j], next[pos]];
    setTimeline(next);
    setPreviewPos(j);
  };
  const removeAt = (pos) => {
    if (timeline.length <= 1) return;
    const next = timeline.filter((_, i) => i !== pos);
    setTimeline(next);
    setCoverPos((c) => Math.min(c, next.length - 1));
    setPreviewPos((p) => Math.min(p, next.length - 1));
  };
  const addShot = (srcIdx) => {
    if (timeline.includes(srcIdx)) return;
    setTimeline([...timeline, srcIdx]);
  };

  const shots = useMemo(() => {
    if (!story || story.error) return [];
    const bySrc = new Map(story.sequence.map((s) => [s.sourceIndex, s]));
    const base = timeline.map((src) => bySrc.get(src) ?? {
      name: items[src]?.name ?? '?', cluster: 0, centrality: null, capturedAt: items[src]?.capturedAt ?? null, sourceIndex: src,
    });
    return recaption(base);
  }, [timeline, story, items]);

  const chapters = useMemo(() => {
    const out = [];
    for (const s of shots) {
      const last = out[out.length - 1];
      if (last && last.cluster === s.cluster) last.shots.push(s);
      else out.push({ id: out.length, cluster: s.cluster, title: `Chapter ${out.length + 1} — Moment ${s.cluster + 1}`, shots: [s] });
    }
    return out;
  }, [shots]);

  const pool = useMemo(() => {
    const inStory = new Set(timeline);
    return items.map((it, i) => ({ ...it, src: i })).filter((it) => !inStory.has(it.src));
  }, [items, timeline]);

  const cover = shots[Math.min(coverPos, shots.length - 1)];
  const preview = shots[Math.min(previewPos, shots.length - 1)];
  const maxK = items.length >= 3 ? Math.min(8, items.length - 1) : 2;
  const maxLen = Math.min(20, items.length);

  const onServerCheck = async () => {
    if (!batchId || !story || story.error) return;
    setChecking(true);
    setServerCheck(null);
    try {
      const data = await fetchServerStory(API_URL, {
        batchId, k: story.k, targetCount: story.targetCount, ordering: story.ordering,
      });
      const serverNames = (data.sequence ?? []).map((s) => s.name);
      const localNames = story.sequence.map((s) => s.name);
      const match = serverNames.length === localNames.length && serverNames.every((n, i) => n === localNames[i]);
      setServerCheck(match
        ? `Server agrees ✓ — ${serverNames.length}/${localNames.length} shots identical (${data.dims}d, ${story.ordering})`
        : `Server differs — local [${localNames.slice(0, 4).join(', ')}…] vs server [${serverNames.slice(0, 4).join(', ')}…]`);
      blog.log('story server parity', { match, n: serverNames.length });
    } catch (err) {
      setServerCheck(`Server check failed: ${err.message}`);
    }
    setChecking(false);
  };

  const exportJson = () => ({
    milestone: 6,
    batchId: batchId ?? null,
    generatedAt: new Date().toISOString(),
    params: story && !story.error ? { k: story.k, targetCount: story.targetCount, ordering: story.ordering, dims: story.dims } : null,
    scores: story && !story.error ? story.scores : null,
    cover: cover?.name ?? null,
    shots: shots.map((s) => ({
      position: s.position, name: s.name, cluster: s.cluster,
      caption: s.caption, capturedAt: s.capturedAt, centrality: s.centrality,
    })),
    chapters: chapters.map((c) => ({ title: c.title, cluster: c.cluster, shots: c.shots.map((s) => s.name) })),
  });

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportJson(), null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(`Copy failed: ${err.message}`);
    }
  };
  const onDownload = () => {
    const blob = new Blob([JSON.stringify(exportJson(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `highlight-sequence-${(batchId ?? 'local').slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card">
      <h2>Milestone 6 — Storytelling experiment</h2>
      <p className="muted">
        Cluster representatives become a draft highlight reel: one ★ cover, chapters per moment,
        chronological flow. {batchId ? <>Current batch <code>{batchId.slice(0, 8)}</code> ({batch?.completed ?? '?'}/{batch?.total ?? '?'} ok).</> : 'Process a batch first.'}
      </p>

      <div className="row">
        <button disabled={!batchId || status === 'loading'} onClick={loadBatch}>
          {status === 'loading' ? 'Loading…' : items.length ? 'Reload batch vectors' : 'Build story from batch'}
        </button>
        <label>moments (k)
          <select value={k} onChange={(e) => setK(Number(e.target.value))}>
            {Array.from({ length: Math.max(0, maxK - 1) }, (_, i) => i + 2).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>length
          <select value={targetCount} onChange={(e) => setTargetCount(Number(e.target.value))}>
            {Array.from({ length: maxLen }, (_, i) => i + 1).map((v) => <option key={v} value={v}>{v} shots</option>)}
          </select>
        </label>
        <label>flow
          <select value={ordering} onChange={(e) => setOrdering(e.target.value)}>
            {ORDERINGS.map((o) => <option key={o.id} value={o.id} title={o.hint}>{o.label}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="error">Error: {error}</p>}
      {timeNote && <p className="warn">{timeNote}</p>}
      {story?.error && <p className="error">Story error: {story.error}</p>}

      {story && !story.error && shots.length > 0 && (
        <>
          <div className="story-stats">
            <span className="stat"><strong>{story.scores.distinctClusters}/{story.k}</strong> moments covered</span>
            <span className="stat"><strong>{story.scores.flow.toFixed(2)}</strong> flow <span className="muted">(1 − adjacent similarity)</span></span>
            <span className="stat"><strong>~{story.scores.durationSec}s</strong> reel</span>
            <span className="stat"><strong>{chapters.length}</strong> chapters</span>
            <span className="muted">{story.dims}d · {story.ordering}</span>
          </div>

          {preview && (
            <div className="story-player">
              <div className="sp-main">
                <ThumbImg src={items[preview.sourceIndex]?.thumbUrl} alt={preview.name} className="sp-img" />
                <div className="sp-meta">
                  <div className="sp-cap"><strong>{preview.position}/{shots.length}</strong> · {preview.caption}</div>
                  <div className="muted sp-sub">{preview.name}{preview.capturedAt ? ` · ${formatShotTime(preview.capturedAt)}` : ''}</div>
                  <div className="sp-bar"><div className="sp-fill" style={{ width: `${(preview.position / shots.length) * 100}%` }} /></div>
                </div>
              </div>
              <div className="row sp-controls">
                <button onClick={() => { setPlaying(false); setPreviewPos((p) => (p - 1 + shots.length) % shots.length); }}>← Prev</button>
                <button onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚ Pause' : '▶ Play reel'}</button>
                <button onClick={() => { setPlaying(false); setPreviewPos((p) => (p + 1) % shots.length); }}>Next →</button>
                <span className="muted">{playing ? `playing · ${SLIDE_MS / 1000}s per shot` : 'preview the highlight flow'}</span>
              </div>
            </div>
          )}

          <h3>Timeline — drag the story into shape ({shots.length})</h3>
          <div className="story-strip">
            {shots.map((s, pos) => (
              <div key={`${s.sourceIndex}-${pos}`} className={`story-frame ${pos === previewPos ? 'live' : ''}`} style={{ borderTopColor: colorFor(s.cluster) }}>
                <button className="sf-thumb" onClick={() => { setPlaying(false); setPreviewPos(pos); }} title={`${s.name} — click to preview`}>
                  <ThumbImg src={items[s.sourceIndex]?.thumbUrl} alt={s.name} />
                  <span className="sf-num">{s.position}</span>
                  <span className="sf-dot" style={{ background: colorFor(s.cluster) }} />
                  {pos === Math.min(coverPos, shots.length - 1) && <span className="sf-cover">★ cover</span>}
                </button>
                <div className="sf-cap" title={s.caption}>{s.caption}</div>
                <div className="sf-name" title={s.name}>{s.name}</div>
                <div className="sf-btns">
                  <button title="Move earlier" disabled={pos === 0} onClick={() => move(pos, -1)}>↑</button>
                  <button title="Move later" disabled={pos === shots.length - 1} onClick={() => move(pos, 1)}>↓</button>
                  <button title="Make cover" onClick={() => setCoverPos(pos)}>★</button>
                  <button title="Remove from story" disabled={shots.length <= 1} onClick={() => removeAt(pos)}>✕</button>
                </div>
              </div>
            ))}
          </div>

          <div className="story-chapters">
            {chapters.map((c) => (
              <div key={c.id} className="story-chapter" style={{ borderLeftColor: colorFor(c.cluster) }}>
                <strong>{c.title}</strong>
                <span className="muted"> · {c.shots.map((s) => s.position).join(', ') ? `shots ${c.shots.map((s) => s.position).join(', ')}` : ''}</span>
                <div className="muted sc-names">{c.shots.map((s) => s.name).join(' → ')}</div>
              </div>
            ))}
          </div>

          {pool.length > 0 && (
            <>
              <h3>Cutting-room floor ({pool.length})</h3>
              <div className="story-pool">
                {pool.slice(0, 12).map((p) => (
                  <div key={p.src} className="pool-item">
                    <ThumbImg src={p.thumbUrl} alt={p.name} />
                    <span className="sf-name" title={p.name}>{p.name}</span>
                    <button onClick={() => addShot(p.src)}>+ Add</button>
                  </div>
                ))}
                {pool.length > 12 && <span className="muted">+{pool.length - 12} more — lengthen the reel above to include them automatically.</span>}
              </div>
            </>
          )}

          <div className="row story-export">
            <button onClick={() => { setTimeline(story.sequence.map((s) => s.sourceIndex)); setCoverPos(0); }}>Reset to auto</button>
            <button onClick={onCopy}>{copied ? 'Copied ✓' : 'Copy JSON'}</button>
            <button onClick={onDownload}>Download JSON</button>
            <button disabled={!batchId || checking} onClick={onServerCheck} title="POST /api/story-sequence with the same params">
              {checking ? 'Checking…' : 'Verify vs server'}
            </button>
          </div>
          {serverCheck && <p className="muted">{serverCheck}</p>}
          <p className="muted">
            Tip: chronological flow suits full-day galleries · moment-by-moment groups each chapter ·
            max-variety avoids back-to-back lookalikes. The ★ cover + JSON export feed the future share / album step.
          </p>
        </>
      )}

      {status === 'idle' && items.length === 0 && (
        <p className="muted">Load a processed batch to generate the first draft highlight sequence — representatives (★) from M5 become opener → beats → finale.</p>
      )}
    </section>
  );
}
