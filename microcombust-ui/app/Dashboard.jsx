'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronUp, Database,
  Download, ExternalLink, FileText, Flame, Loader2, Play, Send, ShieldCheck,
  Sparkles, Wind, X,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
/* The FastAPI backend binds the first free port (8000 is usually taken by a
   Windows service), so probe a short list instead of hard-coding one. */
const API_CANDIDATES = (
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000,http://localhost:8080'
)
  .split(',')
  .map((base) => base.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// Port that answered on the last successful call, so we skip dead ones after.
let activeApi = null;

const isJson = (res) => String(res.headers.get('content-type') || '').includes('application/json');

/** POST JSON to `path`, trying each configured base until one answers. */
async function apiFetch(path, body) {
  const bases = activeApi
    ? [activeApi, ...API_CANDIDATES.filter((base) => base !== activeApi)]
    : [...API_CANDIDATES];

  let lastError = null;
  let lastResponse = null;

  for (const base of bases) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok && isJson(res)) {
        activeApi = base;
        return res;
      }
      lastResponse = res;
    } catch (err) {
      lastError = err;
    }
  }

  // A real backend error is more useful than "nothing answered".
  return lastResponse ?? Promise.reject(lastError ?? new Error('No backend reachable'));
}

const GRAVITY_MODES = [
  { value: '0g', label: '0g', sub: 'Microgravity' },
  { value: '0.16g', label: '0.16g', sub: 'Lunar gravity' },
  { value: '1g', label: '1g', sub: 'Earth gravity' },
];

const FUELS = ['PMMA (Acrylic)', 'Nomex Fabric', 'Silicone Rubber', 'Kevlar Blend'];

// Short material names used by the matrix and table
const MATERIALS = [
  { id: 'PMMA', label: 'PMMA', base: 0.8, fuel: 'PMMA (Acrylic)' },
  { id: 'Silicone', label: 'Silicone', base: 0.75, fuel: 'Silicone Rubber' },
  { id: 'Cotton', label: 'Cotton', base: 0.55, fuel: null },
  { id: 'Nomex', label: 'Nomex', base: 0.45, fuel: 'Nomex Fabric' },
  { id: 'Kevlar', label: 'Kevlar', base: 0.25, fuel: 'Kevlar Blend' },
];

// `k` feeds the --k custom property that globals.css uses to tint the
// matrix columns, bars and risk badges.
const TIERS = {
  High: { title: 'High risk', hint: 'Sustained spread likely', k: '#fb7185' },
  Medium: { title: 'Medium risk', hint: 'Conditional spread', k: '#fbbf24' },
  Low: { title: 'Low risk', hint: 'Self-extinguishing in most cases', k: '#34d399' },
};

/* ------------------------------------------------------------------ */
/* Demo data. Replace with metrics extracted into ChromaDB.            */
/* Values below are ILLUSTRATIVE placeholders, not verified NASA data. */
/* ------------------------------------------------------------------ */
const SOFIE = 'https://science.nasa.gov/biological-physical/investigations/sofie/';
const SOFIE_GLENN =
  'https://www.nasa.gov/glenn/glenn-expertise-space-exploration/physical-sciences-program/combustion-science/solid-fuel-ignition-and-extinction-sofie/';
const PSI = 'https://science.nasa.gov/physical-sciences-informatics-psi/';
const NTRS = 'https://ntrs.nasa.gov/';

const SEED_RUNS = [
  { id: 1, fuel: 'PMMA', gravity: '0g', o2: 21, airflow: 5, spread: 0.9, risk: 'High', url: SOFIE },
  { id: 2, fuel: 'PMMA', gravity: '0g', o2: 30, airflow: 10, spread: 2.1, risk: 'High', url: SOFIE_GLENN },
  { id: 3, fuel: 'PMMA', gravity: '0.16g', o2: 21, airflow: 10, spread: 1.4, risk: 'High', url: PSI },
  { id: 4, fuel: 'PMMA', gravity: '1g', o2: 21, airflow: 10, spread: 1.1, risk: 'High', url: NTRS },
  { id: 5, fuel: 'Silicone', gravity: '0g', o2: 21, airflow: 15, spread: 1.2, risk: 'High', url: SOFIE },
  { id: 6, fuel: 'Silicone', gravity: '0.16g', o2: 25, airflow: 20, spread: 1.8, risk: 'High', url: PSI },
  { id: 7, fuel: 'Cotton', gravity: '0g', o2: 21, airflow: 10, spread: 0.6, risk: 'Medium', url: SOFIE_GLENN },
  { id: 8, fuel: 'Cotton', gravity: '1g', o2: 21, airflow: 10, spread: 0.8, risk: 'Medium', url: NTRS },
  { id: 9, fuel: 'Nomex', gravity: '0g', o2: 21, airflow: 20, spread: 0.4, risk: 'Medium', url: SOFIE },
  { id: 10, fuel: 'Nomex', gravity: '0.16g', o2: 30, airflow: 15, spread: 0.7, risk: 'Medium', url: PSI },
  { id: 11, fuel: 'Kevlar', gravity: '0g', o2: 21, airflow: 15, spread: 0.0, risk: 'Low', url: SOFIE },
  { id: 12, fuel: 'Kevlar', gravity: '1g', o2: 30, airflow: 20, spread: 0.2, risk: 'Low', url: NTRS },
];

const WELCOME = {
  id: 'welcome',
  role: 'assistant',
  text:
    'I search NASA Physical Sciences Informatics and NTRS records on microgravity combustion, including BASS, SAFFIRE, FLEX and SoFIE. Ask about flame spread, extinction limits or material flammability. Every answer lists its sources and a confidence score.',
  citations: [],
  confidence: null,
};

// Always-available starting point. These stay on screen until the first
// response produces a more specific, context-aware follow-up set.
const DEFAULT_SUGGESTIONS = [
  'What drives flame spread in microgravity?',
  'Which materials self-extinguish in microgravity?',
  'How does oxygen concentration affect combustion limits?',
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const tierOf = (s) => (s >= 0.6 ? 'High' : s >= 0.35 ? 'Medium' : 'Low');
const fuelToId = (fuel) => MATERIALS.find((m) => m.fuel === fuel)?.id;

// Offline estimate so the matrix stays usable when the backend is unreachable.
// A rough heuristic for demo purposes only, not a physics model.
function localRank({ oxygen, pressure, airflow, gravity }) {
  const g = gravity === '0g' ? 1.1 : gravity === '0.16g' ? 1.0 : 0.9;
  const fO2 = 0.55 + ((oxygen - 15) / 20) * 0.9;
  const fP = clamp(0.7 + 0.3 * (pressure / 101.3), 0.7, 1.3);
  const fFlow = 0.9 + (airflow / 50) * 0.3;
  return MATERIALS.map((m) => {
    const score = clamp(m.base * fO2 * fP * fFlow * g, 0, 1);
    return { material: m.id, score, tier: tierOf(score) };
  });
}

// Accepts a few reasonable response shapes from /rank-materials
function normalizeRanking(data) {
  const list = Array.isArray(data) ? data : data?.ranking || data?.results || [];
  return list
    .map((r) => {
      const name = String(r.material || r.name || '');
      const id = MATERIALS.find((m) => name.toLowerCase().includes(m.id.toLowerCase()))?.id || name;
      const score = clamp(Number(r.score ?? r.risk_score ?? 0), 0, 1);
      const tier = ['High', 'Medium', 'Low'].find(
        (t) => t.toLowerCase() === String(r.tier || r.risk || r.risk_tier || '').toLowerCase()
      ) || tierOf(score);
      return { material: id, score, tier };
    })
    .filter((r) => r.material);
}

// Accepts the grounded-RAG shape { answer, retrieved_sources, citations, sources }
// and normalises every variant into one numbered citation record per chunk.
function normalizeAnswer(data) {
  const retrieved = Array.isArray(data?.retrieved_sources) ? data.retrieved_sources : [];
  const rawCitations = Array.isArray(data?.citations) ? data.citations : [];
  const rawSources = Array.isArray(data?.sources) ? data.sources : [];
  const list = [];
  const seen = new Set();

  const add = (item, index) => {
    if (!item) return;
    const number = Number(item.number) || index + 1;
    const filename = item.filename || fileNameOf(item.source || '') || fileNameOf(item.title || '');
    const title = item.title || item.filename || item.source || item.name || 'NASA source';
    const page = item.page ?? null;
    const key = `${number}|${filename || title}|${page ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      number,
      title,
      filename,
      source: item.source || filename || title,
      page,
      url: item.url || item.link || null,
      snippet: item.snippet || item.text || '',
      confidence: item.confidence ?? item.score ?? null,
    });
  };

  if (retrieved.length) retrieved.forEach(add);
  else if (rawCitations.length) rawCitations.forEach(add);
  else if (rawSources.length) rawSources.forEach(add);
  else if (data?.citation_url) {
    add({
      number: 1,
      title: data.citation_title || 'NASA source',
      source: data.citation_title || data.citation_url,
      url: data.citation_url,
      page: null,
      snippet: '',
    }, 0);
  }

  // A bare sources list may still carry the passage text the rich records omit.
  if (rawSources.length) {
    rawSources.forEach((src, i) => {
      if (list[i] && !list[i].snippet && src.snippet) list[i].snippet = src.snippet;
    });
  }

  const confidence =
    data?.confidence ??
    (list.length && list.every((c) => c.confidence != null)
      ? list.reduce((a, c) => a + c.confidence, 0) / list.length
      : null);

  // Source pills and the chunks accordion both consume this ordered list, so
  // citation [1] always opens the first retrieved ChromaDB passage.
  const sources = (retrieved.length ? retrieved : list).map((src, i) => ({
    ...src,
    number: Number(src.number) || i + 1,
    filename: src.filename || fileNameOf(src.source || '') || fileNameOf(src.title || ''),
    title: src.title || src.filename || src.source || 'NASA source',
  }));

  return {
    text: data?.answer || data?.response || 'No answer returned.',
    citations: list,
    confidence,
    question: data?.question || null,
    sources,
  };
}

const pct = (c) => (c == null ? null : Math.round((c <= 1 ? c * 100 : c)));

const uniqueStrings = (items) => {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter((item) => {
      if (!item) return false;
      const key = item.toLowerCase().replace(/[?!.]+$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

// Offline/local follow-ups. They keep the pill row populated when the
// /quick-questions endpoint is unavailable and refresh with the latest answer.
function deriveSuggestions({ question, answer, fuel, oxygen, gravity, previous = [] }) {
  const context = `${question || ''} ${answer || ''}`.toLowerCase();
  const pool = [];
  const add = (...items) => pool.push(...items);

  if (/extinct|extinguish|flammability limit/.test(context)) {
    add(
      'What extinction limits were measured in microgravity?',
      'How does airflow velocity change extinction behavior?',
    );
  }
  if (/oxygen|o₂|o2|atmosphere/.test(context)) {
    add(
      'How does oxygen concentration shift the flammability limit?',
      'What oxygen level is required for sustained flame spread?',
    );
  }
  if (/pressure|kpa|atm\b/.test(context)) {
    add('How does ambient pressure affect flame spread?');
  }
  if (/airflow|ventilation|forced flow/.test(context)) {
    add('How does forced airflow suppress or spread a flame?');
  }
  if (/pmma|silicone|cotton|nomex|kevlar|material/.test(context)) {
    add(`What are the fire safety risks of ${fuel}?`);
  }
  if (/smoke|detector|aerosol/.test(context)) {
    add('How do smoke detectors perform in microgravity?');
  }

  add(
    `Compare ${fuel} fire behavior at ${gravity} and 1g.`,
    `How does ${oxygen}% O₂ affect flame spread at ${gravity}?`,
    'Which materials self-extinguish in microgravity?',
    'What do the retrieved NASA papers recommend for spacecraft fire safety?',
    ...DEFAULT_SUGGESTIONS,
  );

  const blocked = new Set(
    uniqueStrings([question, ...previous]).map((q) =>
      q.toLowerCase().replace(/[?!.]+$/, ''),
    ),
  );
  const fresh = uniqueStrings(pool).filter(
    (q) => !blocked.has(q.toLowerCase().replace(/[?!.]+$/, '')),
  );
  return fresh.length >= 3 ? fresh.slice(0, 4) : uniqueStrings([...fresh, ...DEFAULT_SUGGESTIONS]).slice(0, 4);
}

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */
function Panel({ title, icon: Icon, right, children, className = '', a = '#22d3ee', b = '#a78bfa', iconColor }) {
  return (
    <section style={{ '--a': a, '--b': b }} className={`glass ${className}`}>
      <header className="ph">
        <h2>
          {Icon && (
            <span className="ic" style={iconColor ? { '--c': iconColor } : undefined}>
              <Icon aria-hidden />
            </span>
          )}
          {title}
        </h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function Slider({ id, label, unit, value, min, max, step = 1, digits = 0, c1, c2, onChange, onSlide }) {
  const fill = ((value - min) / (max - min)) * 100;
  const handleChange = (e) => {
    const next = Number(e.target.value);
    onChange(next);
    // Lets the fire backdrop flare and shift colour as the value rises.
    onSlide?.((next - min) / (max - min));
  };
  return (
    <div>
      <div className="row">
        <label htmlFor={id} className="lbl">
          {label}
        </label>
        <span className="val" style={{ '--c1': c1 }}>
          {Number(value).toFixed(digits)}
          <i>{unit}</i>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleChange}
        className="range"
        style={{
          '--c1': c1,
          '--c2': c2,
          background: `linear-gradient(to right, ${c1} 0%, ${c2} ${fill}%, rgba(255,255,255,.12) ${fill}%)`,
        }}
      />
      <div className="rng">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function RiskChip({ tier }) {
  const t = TIERS[tier] || TIERS.Low;
  return (
    <span className="badge" style={{ '--k': t.k }}>
      {tier}
    </span>
  );
}

function Citation({ message, onOpenSource }) {
  const [chunksOpen, setChunksOpen] = useState(false);
  // Safely extract confidence, default to 0 if unavailable
  const rawConfidence = message.confidence ?? message.citation_confidence ?? 0;
  const c = pct(rawConfidence);
  // Support multiple possible key names from backend / normalizeAnswer
  // Try citations first, then answer_citations, then sources, then retrieved_sources, then citation_list
  const citations = message.citations
    || message.answer_citations
    || message.sources
    || message.retrieved_sources
    || message.citation_list
    || message.chunks
    || [];
  // Support multiple possible key names from backend / normalizeAnswer.
  const sources = message.sources || message.retrieved_sources || [];
  const count = sources.length > 0 ? sources.length : (citations?.length ?? 0);
  // Support multiple possible key names for source passages.
  const passages = message.sources
    || message.retrieved_sources
    || message.passages
    || message.context
    || message.documents
    || message.chunks
    || [];

  // One badge per numbered ChromaDB chunk. The number is the same [n] tag the
  // assistant cites inline, so the mapping is unambiguous even when two chunks
  // come from different pages of the same PDF.
  // Normalize display numbers and deduplicate sources by (title, page) pair.
  const allSources = sources.length > 0 ? sources : citations;
  const normalized = allSources.map((s, i) => ({
    ...s,
    displayNumber: Number(s.number) || i + 1,
  }));
  // Deduplicate by displayNumber + normalized title + page so that duplicate
  // chunk indexes don't stack or overlap in the pill row.
  const seenKeys = new Set();
  const badges = normalized.filter((s) => {
    const title = String(s.title || s.source || s.filename || '').toLowerCase();
    const page = s.page ?? '';
    const key = `${s.displayNumber}|${title}|${page}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  const findPassage = (source) => {
    const number = Number(source?.number ?? source?.displayNumber);
    if (Number.isFinite(number) && number > 0) {
      const numbered = passages.find((p) => Number(p.number) === number);
      if (numbered) return numbered;
    }
    const name = fileNameOf(source?.title || source?.source || source?.filename || source);
    return (
      passages.find((p) => fileNameOf(p.filename || p.source || '') === name) ||
      passages[0]
    );
  };

  const openPassage = (s) => {
    const passage = findPassage(s);
    onOpenSource?.(passage || { ...s, filename: s.title, snippet: s.snippet });
  };

  return (
    <div className="src">
      {/* Clickable source badges (one per source PDF) */}
      <div className="src-badges" aria-label="Source papers">
        {count === 0 ? (
          <span className="src-empty">No sources were returned for this answer.</span>
        ) : (
          badges.map((s, i) => (
            <button
              key={`badge-${s.displayNumber}-${i}`}
              type="button"
              aria-label={`View source chunk ${s.displayNumber} for ${s.title}`}
              title={`[${s.displayNumber}] Raw ChromaDB chunk for ${s.title}`}
              onClick={() => openPassage(s)}
              className="src-badge"
            >
              <FileText aria-hidden />{' '}
              <span>[{s.displayNumber}] {s.title}</span>
              {s.snippet && <span className="src-badge-hint" aria-hidden>{'…'}</span>}
            </button>
          ))
        )}
      </div>

      {/* "View Source Chunks" accordion – raw ChromaDB context passages */}
      <button
        type="button"
        onClick={() => setChunksOpen((o) => !o)}
        aria-expanded={chunksOpen}
        className="src-toggle"
      >
        <ShieldCheck aria-hidden />
        {count} {count === 1 ? 'source chunk' : 'source chunks'}
        {c != null && <b>{c}% confidence</b>}
        {chunksOpen ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
      </button>
      {chunksOpen && (
        <ul className="src-list">
          {count === 0 && (
            <li className="src-empty">No source chunks were returned for this answer.</li>
          )}
          {passages.map((p, i) => (
            <li key={i}>
              <div className="chunk">
                <div className="chunk-head">
                  <span className="chunk-title">
                    {p.number ? `[${p.number}] ` : ''}
                    {p.filename || fileNameOf(p.source || '') || 'NASA source'}
                  </span>
                  <span className="chunk-page">
                    Page {p.page ?? 'n/a'}{p.source ? `  ·  ${p.source}` : ''}
                  </span>
                </div>
                <p className="chunk-snippet">
                  {p.snippet || p.text || '(no passage text stored)'}
                </p>
                {p.url && (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="chunk-link"
                  >
                    Open full document <ExternalLink aria-hidden />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline citation pills + source viewer                               */
/* ------------------------------------------------------------------ */
// The backend now emits numeric markers such as [1] and [2]. The legacy
// file-name marker is still recognised so older cached answers stay clickable.
const RAW_CITATION_RE = /^\[([^\[\]]+?\.pdf)\s*,?\s*(?:p|page)\.?\s*(\d+|n\/a)\]/i;
const NUM_CITATION_RE = /^\[(\d{1,3})\]$/;

const fileNameOf = (value) =>
  String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase();

// Resolve a marker against the passages ChromaDB returned for this answer.
function findSource(sources, filename, page) {
  if (!sources?.length) return null;
  const name = fileNameOf(filename);
  const matches = sources.filter(
    (s) => fileNameOf(s.filename || s.source) === name
  );
  if (!matches.length) return null;
  return matches.find((s) => String(s.page).toLowerCase() === String(page).toLowerCase()) || matches[0];
}

function findSourceByNumber(sources, number) {
  if (!sources?.length) return null;
  const n = Number(number);
  if (!Number.isFinite(n) || n < 1) return null;
  return sources.find((s) => Number(s.number) === n) || sources[n - 1] || null;
}

// Defensive display cleanup: the API sanitises answers, but this also keeps
// older messages and pasted model output from showing literal HTML/callouts.
function sanitizeForDisplay(text) {
  let cleaned = String(text || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*(?:b|strong)\b[^>]*>/gi, '**')
    .replace(/<\s*\/\s*(?:b|strong)\s*>/gi, '**')
    .replace(/<\s*(?:i|em)\b[^>]*>/gi, '*')
    .replace(/<\s*\/\s*(?:i|em)\s*>/gi, '*')
    // Only strip real tags (a letter after "<"), so comparisons like "< 15%"
    // or "1 > 0" survive as ordinary text.
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\[!(?:NOTE|WARNING|TIP|IMPORTANT|CAUTION)\]/gi, '')
    .replace(/^[ \t]*```[a-zA-Z0-9_-]*[ \t]*$/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*#[ \t]+/gm, '## ')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  // Strip common LLM filler / preamble so the answer starts with substance.
  cleaned = cleaned.replace(/^(here is|here's|the answer is|based on the|according to|in summary|to summarize|certainly|sure|absolutely|of course|i can confirm|it appears|it seems|note that|please note|keep in mind|remember that|let me|i would|i will|here are|the following|below is|above is|additionally|furthermore|moreover|however|therefore|thus|hence|specifically|particularly|especially|notably|importantly|basically|actually|generally|typically|usually|normally|commonly|ordinarily|regularly|frequently|often|sometimes|occasionally|rarely|merely|simply|just|only|exactly|precisely|correctly|properly|rightly|appropriately)\b[ :–—-]*/i, '');

  // Collapse repeated adjacent words (e.g. "the the", "and and and")
  cleaned = cleaned.replace(/\b(\w+)(\s+$1\b)+/gi, '$1');

  // Collapse tripled+ punctuation runs
  cleaned = cleaned.replace(/([!?.,:;])\1{2,}/g, '$1');

  // Remove lingering HTML comment or partial-tag fragments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');

  // Final whitespace tidy
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

function inlineToNodes(str, sources, onOpen) {
  const nodes = [];
  let cursor = 0;
  const tokenRe = /(\[[^\]]+\]\([^)]+\)|\[[^\[\]]+?\.pdf[^\[\]]*\]|\*\*[^*]+\*\*|`[^`]+`|\[\d{1,3}\])/g;
  let m;
  while ((m = tokenRe.exec(str || '')) !== null) {
    const at = m.index;
    if (at > cursor) nodes.push(<span key={cursor}>{String(str).slice(cursor, at)}</span>);
    const whole = m[0];
    const raw = RAW_CITATION_RE.exec(whole);
    const numeric = NUM_CITATION_RE.exec(whole);
    if (raw) {
      const [, filename, page] = raw;
      const source = findSource(sources, filename, page);
      nodes.push(
        <button
          key={at}
          type="button"
          onClick={() => onOpen(source || { filename, page, snippet: null })}
          title={source ? 'Show the passage this claim was drawn from' : 'No stored passage matched this citation'}
          className="cite"
        >
          <FileText aria-hidden />
          <span>{whole.slice(1, -1)}</span>
        </button>
      );
    } else if (numeric) {
      const number = numeric[1];
      const source = findSourceByNumber(sources, number);
      nodes.push(
        <button
          key={at}
          type="button"
          onClick={() => onOpen(source || { number: Number(number), snippet: null })}
          title={source ? `Show source chunk [${number}]` : `No stored passage matched citation [${number}]`}
          className="cite"
        >
          <FileText aria-hidden />
          <span>[{number}]</span>
        </button>
      );
    } else if (whole.startsWith('**') && whole.endsWith('**')) {
      nodes.push(<strong key={at}>{whole.slice(2, -2)}</strong>);
    } else if (whole.startsWith('`') && whole.endsWith('`')) {
      nodes.push(<code key={at}>{whole.slice(1, -1)}</code>);
    } else {
      const lm = whole.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (lm) {
        nodes.push(<a key={at} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>);
      } else {
        nodes.push(<span key={at}>{whole}</span>);
      }
    }
    cursor = at + whole.length;
  }
  if (cursor < String(str || '').length) nodes.push(<span key={cursor}>{String(str).slice(cursor)}</span>);
  return nodes;
}

function markdownToBlocks(text, sources, onOpen) {
  const lines = sanitizeForDisplay(text).split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{2,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      blocks.push({ type: 'heading', level, content: inlineToNodes(line.replace(/^#{2,6}\s*/, ''), sources, onOpen) });
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && /\|\s*$/.test(line)) {
      const rows = [];
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        rows.push(lines[j].replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()));
        j++;
      }
      blocks.push({ type: 'table', rows });
      i = j;
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      const items = [];
      let j = i;
      while (j < lines.length && /^\s*[-*]\s/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*[-*]\s/, ''));
        j++;
      }
      blocks.push({ type: 'list', items: items.map((it) => inlineToNodes(it, sources, onOpen)) });
      i = j;
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    let para = line;
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() !== '' &&
      !/^#{2,6}\s/.test(lines[j]) &&
      !/^\s*\|/.test(lines[j]) &&
      !/^\s*[-*]\s/.test(lines[j])
    ) {
      para += ' ' + lines[j];
      j++;
    }
    blocks.push({ type: 'para', content: inlineToNodes(para, sources, onOpen) });
    i = j;
  }
  return blocks;
}

function MarkdownTable({ rows }) {
  if (!rows || !rows.length) return null;
  return (
    <table className="md-table">
      <thead>
        <tr>
          {rows[0].map((c, j) => (
            <th key={j}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(1).map((row, r) => (
          <tr key={r}>
            {row.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MarkdownBlock({ text, sources, onOpen }) {
  const blocks = markdownToBlocks(text, sources, onOpen);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const Tag = b.level === 2 ? 'h2' : b.level === 3 ? 'h3' : 'h4';
          return <Tag key={i} className="md-h">{b.content}</Tag>;
        }
        if (b.type === 'table') return <MarkdownTable key={i} rows={b.rows} />;
        if (b.type === 'list') {
          return (
            <ul key={i} className="md-list">
              {b.items.map((it, j) => (
                <li key={j}>{it}</li>
              ))}
            </ul>
          );
        }
        return <p key={i} className="md-para">{b.content}</p>;
      })}
    </div>
  );
}

function SourceModal({ source, onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  if (!source) return null;

  const filename = source.filename || fileNameOf(source.source) || 'NASA source';
  const snippet = source.snippet || '';
  const confidence = pct(source.confidence);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Source passage from ${filename}`}
    >
      <div onClick={onClose} aria-hidden className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
      <div className="glass modal-card" style={{ '--a': '#a78bfa', '--b': '#f472b6' }}>
        <header className="ph">
          <div className="flex min-w-0 items-center gap-3">
            <span className="ic" style={{ '--c': '#a78bfa' }}>
              <FileText aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{filename}</p>
              <p className="truncate text-xs" style={{ color: 'var(--m)' }}>
                Page {source.page ?? 'n/a'}
                {source.source ? `  ·  ${source.source}` : ''}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close source viewer" className="icon-btn">
            <X aria-hidden />
          </button>
        </header>

        <div className="modal-body">
          <p className="modal-label">Source text chunk · ChromaDB</p>
          {snippet ? (
            <p className="snippet">{snippet}</p>
          ) : (
            <p className="notice">
              This citation has no stored passage attached, so there is nothing to
              show here. The citations listed under the answer still link to the
              source document.
            </p>
          )}
        </div>

        <footer className="foot modal-foot">
          <span>
            Retrieved from the NASA paper index
            {confidence != null && (
              <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', color: 'var(--em)' }}>
                {confidence}% confidence
              </span>
            )}
          </span>
          {source.url && (
            <a href={source.url} target="_blank" rel="noreferrer" className="btn-ghost">
              Open full document <ExternalLink aria-hidden />
            </a>
          )}
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export summary report                                               */
/* ------------------------------------------------------------------ */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Report uses its own palette: it is a printable document, so it is light.
const TIER_HEX = {
  High: { fg: '#be123c', bg: 'rgba(244,63,94,.12)', bar: '#f43f5e' },
  Medium: { fg: '#b45309', bg: 'rgba(245,158,11,.14)', bar: '#f59e0b' },
  Low: { fg: '#047857', bg: 'rgba(16,185,129,.14)', bar: '#10b981' },
};

const reportStamp = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(
    d.getMinutes()
  ).padStart(2, '0')}`;

const REPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#eef2f7;color:#0f172a;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.sheet{max-width:840px;margin:24px auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 18px 48px -28px rgba(15,23,42,.5);overflow:hidden}
.hero{padding:26px 30px 24px;background:linear-gradient(135deg,#0b1220 0%,#123047 55%,#0e7490 100%);color:#f8fafc}
.brand{font-size:22px;font-weight:800;letter-spacing:.06em}
.sub{margin-top:5px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.8}
.meta{margin-top:16px;display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px;opacity:.8}
.status{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.25)}
.print{margin-top:18px;background:#22d3ee;color:#05202b;border:0;border-radius:9px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer}
.print:hover{background:#67e8f9}
section{padding:24px 30px;border-top:1px solid #e2e8f0}
h2{margin:0 0 14px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#0e7490}
h3{margin:20px 0 8px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#64748b}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #eef2f7;vertical-align:middle}
thead th{background:#f8fafc;color:#475569;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
td.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}
.bar{height:8px;min-width:100px;border-radius:999px;background:#e2e8f0;overflow:hidden}
.bar i{display:block;height:100%;border-radius:999px}
.chip{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
.kv th{width:42%;background:#f8fafc;color:#334155;font-weight:600}
.note{font-size:12px;color:#64748b;margin:0 0 12px}
.q{font-size:13.5px;color:#334155;margin:0 0 10px}
.q b{color:#0f172a}
.answer{white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;font-size:13.5px;line-height:1.7}
ul.src{margin:0;padding-left:18px;font-size:12.5px;color:#334155}
ul.src li{margin:7px 0;word-break:break-word;line-height:1.55}
ul.src a{color:#0e7490}
.empty{color:#94a3b8;font-style:italic;font-size:13.5px}
.foot{padding:18px 30px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11.5px;line-height:1.6;color:#64748b}
@media print{
  body{background:#fff}
  .sheet{margin:0;border:0;border-radius:0;box-shadow:none}
  .print{display:none}
  section,.hero,.foot,tr{break-inside:avoid}
}
`;

function buildSummaryReport(opts) {
  const {
    gravity,
    oxygen,
    pressure,
    airflow,
    fuel,
    ranking,
    rankNote,
    analysis,
    apiOnline,
    aiProvider,
    generatedAt,
  } = opts;

  const mode = GRAVITY_MODES.find((g) => g.value === gravity);
  const stamp = generatedAt instanceof Date ? generatedAt : new Date();
  const rows = [...ranking].sort((a, b) => b.score - a.score);

  const settings = [
    ['Gravity mode', mode ? `${mode.label} - ${mode.sub}` : gravity],
    ['Oxygen concentration', `${oxygen} %`],
    ['Ambient pressure', `${pressure} kPa`],
    ['Forced airflow velocity', `${airflow} cm/s`],
    ['Fuel specimen', fuel],
  ]
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`
    )
    .join('');

  const matrix = rows
    .map((r) => {
      const hex = TIER_HEX[r.tier] || TIER_HEX.Low;
      const score = Math.round(r.score * 100);
      return (
        '<tr>' +
        `<td><b>${escapeHtml(r.material)}</b></td>` +
        `<td><span class="chip" style="background:${hex.bg};color:${hex.fg}">${escapeHtml(r.tier)} risk</span></td>` +
        `<td class="num">${score}</td>` +
        `<td><div class="bar"><i style="width:${score}%;background:${hex.bar}"></i></div></td>` +
        '</tr>'
      );
    })
    .join('');

  let analysisBlock;
  if (!analysis) {
    analysisBlock =
      '<p class="empty">No AI analysis has been produced yet. Ask a question in the ' +
      'AI agent query console, then export again.</p>';
  } else if (analysis.error) {
    analysisBlock =
      `<p class="empty">The latest assistant message was an error, so no analysis ` +
      `was captured: ${escapeHtml(analysis.text)}</p>`;
  } else {
    analysisBlock =
      (analysis.question
        ? `<p class="q"><b>Question:</b> ${escapeHtml(analysis.question)}</p>`
        : '') + `<div class="answer">${escapeHtml(analysis.text)}</div>`;
  }

  const sources = analysis?.sources?.length
    ? analysis.sources
    : analysis?.citations || [];
  const sourcesBlock = sources.length
    ? `<ul class="src">${sources
        .map((s) => {
          const bits = [escapeHtml(s.title || s.filename || 'NASA source')];
          if (s.page != null && s.page !== '') bits.push(`p. ${escapeHtml(s.page)}`);
          if (s.confidence != null) bits.push(`${pct(s.confidence)}% confidence`);
          const label = bits.join(' &middot; ');
          return s.url
            ? `<li>${label} - <a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.url)}</a></li>`
            : `<li>${label}</li>`;
        })
        .join('')}</ul>`
    : '<p class="empty">No sources were attached to this analysis.</p>';

  const meta =
    `<span class="status">Gravity ${escapeHtml(gravity)}</span>` +
    `<span class="status">FastAPI ${apiOnline ? 'connected' : 'offline'}</span>` +
    `<span class="status">AI ${aiProvider ? aiProvider : 'key not set'}</span>` +
    `<span>Generated ${escapeHtml(stamp.toLocaleString())}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flame in Freefall - Summary Report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="sheet">
  <header class="hero">
    <div class="brand">FLAME IN FREEFALL</div>
    <div class="sub">NASA Microgravity Combustion &amp; Fire Safety AI Platform</div>
    <div class="meta">${meta}</div>
    <button class="print" type="button" onclick="window.print()">Print / Save as PDF</button>
  </header>

  <section>
    <h2>1 &middot; Experiment settings</h2>
    <table class="kv"><tbody>${settings}</tbody></table>
  </section>

  <section>
    <h2>2 &middot; Material flammability risk matrix</h2>
    <p class="note">${escapeHtml(rankNote)}</p>
    <table>
      <thead>
        <tr>
          <th>Material</th>
          <th>Risk tier</th>
          <th style="text-align:right">Score</th>
          <th>0 - 100</th>
        </tr>
      </thead>
      <tbody>${matrix}</tbody>
    </table>
  </section>

  <section>
    <h2>3 &middot; Latest AI analysis</h2>
    ${analysisBlock}
    <h3>Retrieved sources</h3>
    ${sourcesBlock}
  </section>

  <div class="foot">
    Scores are 0-100 flammability estimates produced by the dashboard ranking
    heuristic (or the backend ranking when FastAPI is connected). They are
    illustrative, not verified NASA data. The flame behavior index table uses
    demo seed values and is not reproduced in this report.
  </div>
</div>
</body>
</html>`;
}

const DEFAULT_RANK_NOTE = 'Live estimate from the sliders. Run a simulation to query the backend.';

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */
export default function Dashboard() {
  // Global + experiment state
  const [gravity, setGravity] = useState('0g');
  const [oxygen, setOxygen] = useState(21);
  const [pressure, setPressure] = useState(101.3);
  const [airflow, setAirflow] = useState(15);
  const [fuel, setFuel] = useState(FUELS[0]);

  // Backend status and ranking
  const [apiOnline, setApiOnline] = useState(true);
  const [aiProvider, setAiProvider] = useState(null);
  const [running, setRunning] = useState(false);
  const [remoteRank, setRemoteRank] = useState(null);
  const [rankNote, setRankNote] = useState(DEFAULT_RANK_NOTE);
  // Whether the user has explicitly run the simulation. Before the first run,
  // the matrix and backend-results panel stay in an unrun/zeroed state.
  const [hasRun, setHasRun] = useState(false);
  // Last simulation error, shown as a dismissible banner in the controls panel.
  const [simError, setSimError] = useState(null);

  // Chat
  const [messages, setMessages] = useState([WELCOME]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [docCount, setDocCount] = useState(null);
  const [quickQuestions, setQuickQuestions] = useState(DEFAULT_SUGGESTIONS);
  const [chipsLoading, setChipsLoading] = useState(false);
  const [openSource, setOpenSource] = useState(null);
  const endRef = useRef(null);
  // Ignore out-of-order follow-up responses if the user submits again quickly.
  const chipsRequestRef = useRef(0);
  // Header gains its glass bar once the page has scrolled.
  const [scrolled, setScrolled] = useState(false);
  // Backdrop canvases + the handle the effect below exposes (slider flare, gravity).
  const starsRef = useRef(null);
  const fireRef = useRef(null);
  const fxRef = useRef(null);

  // Table
  const [showAllGravity, setShowAllGravity] = useState(false);
  const [riskFilter, setRiskFilter] = useState('All');
  const [sort, setSort] = useState({ key: 'spread', dir: 'desc' });

  const params = { oxygen, pressure, airflow, gravity, fuel };
  const paramsKey = `${oxygen}|${pressure}|${airflow}|${gravity}|${fuel}`;

  // Any parameter change invalidates the last backend ranking. Done while
  // rendering rather than in an effect: same outcome, without the extra
  // cascading render flagged by react-hooks/set-state-in-effect.
  const [rankParams, setRankParams] = useState(paramsKey);
  if (rankParams !== paramsKey) {
    setRankParams(paramsKey);
    setRemoteRank(null);
    setRankNote(DEFAULT_RANK_NOTE);
    setHasRun(false);
  }

  // The status badge should reflect reality, so probe the backend on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const base of API_CANDIDATES) {
        try {
          const res = await fetch(`${base}/`);
          if (res.ok && isJson(res)) {
            activeApi = base;
            if (!cancelled) {
              setApiOnline(true);
              // Health payload tells us which AI provider was picked up, so
              // the header can say if answers will be synthesised or just
              // retrieved passages.
              try {
                const health = await res.json();
                if (health?.groq_configured) setAiProvider('groq');
                else if (health?.openrouter_configured) setAiProvider('openrouter');
                else setAiProvider(null);
                if (health?.doc_count != null) setDocCount(health.doc_count);
              } catch {
                /* unexpected body - leave the badge on "unknown" */
              }
            }
            return;
          }
        } catch {
          /* nothing listening on this port - try the next one */
        }
      }
      if (!cancelled) setApiOnline(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, thinking]);

  /* ---------------------------------------------------------------- */
  /* Space backdrop: twinkling stars + fire particles that follow the  */
  /* pointer. The rAF loop and every listener are removed on cleanup.  */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const starCanvas = starsRef.current;
    const fireCanvas = fireRef.current;
    if (!starCanvas || !fireCanvas) return undefined;
    const sx = starCanvas.getContext('2d');
    const fc = fireCanvas.getContext('2d');
    if (!sx || !fc) return undefined;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const STAR_COLORS = ['#fff', '#cfe3ff', '#ffe7c7', '#e6d4ff'];
    const MAX_PARTICLES = 1200;
    const TAU = Math.PI * 2;

    let W = window.innerWidth;
    let H = window.innerHeight;
    let stars = [];
    let shoot = null;
    let raf = 0;
    let last = performance.now();

    // Mutable animation state. `grav` and `slide` are driven from React.
    const A = {
      grav: 0,
      mx: W / 2, my: H / 2, // pointer
      ex: W / 2, ey: H / 2, // eased follower
      px: W / 2, py: H / 2, // previous pointer, for speed
      hue: 12, th: 12,      // current / target flame hue
      boost: 0, drag: false, speed: 0,
      pts: [],
      slide(n) {
        A.boost = 1;
        A.th = 6 + n * 14;
      },
    };

    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      for (const c of [starCanvas, fireCanvas]) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      sx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fc.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: Math.round((W * H) / 5500) }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.3 + 0.2,
        p: Math.random() * 6.28,
        s: Math.random() * 1.6 + 0.4,
        d: Math.random() * 0.6 + 0.1,
        c: STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0],
      }));
    };

    const onMove = (e) => {
      A.mx = e.clientX;
      A.my = e.clientY;
    };
    const onDown = (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'range') A.drag = true;
    };
    const onUp = () => {
      A.drag = false;
    };

    const frame = (t) => {
      const dt = Math.min((t - last) / 1000, 0.05);
      last = t;

      /* stars: twinkle + slight parallax against the pointer */
      sx.clearRect(0, 0, W, H);
      const ox = (A.mx - W / 2) / W;
      const oy = (A.my - H / 2) / H;
      for (const s of stars) {
        s.p += dt * s.s;
        const a = 0.35 + 0.65 * Math.abs(Math.sin(s.p));
        const x = (s.x - ox * s.d * 40 + W) % W;
        const y = (s.y - oy * s.d * 40 + H) % H;
        sx.globalAlpha = a;
        sx.fillStyle = s.c;
        sx.beginPath();
        sx.arc(x, y, s.r, 0, TAU);
        sx.fill();
      }
      sx.globalAlpha = 1;

      /* occasional shooting star */
      if (!shoot && Math.random() < 0.003) shoot = { x: Math.random() * W, y: Math.random() * H * 0.5, l: 1 };
      if (shoot) {
        const g = sx.createLinearGradient(shoot.x, shoot.y, shoot.x - 90, shoot.y - 40);
        g.addColorStop(0, `rgba(255,255,255,${shoot.l})`);
        g.addColorStop(1, 'transparent');
        sx.strokeStyle = g;
        sx.lineWidth = 1.6;
        sx.beginPath();
        sx.moveTo(shoot.x, shoot.y);
        sx.lineTo(shoot.x - 90, shoot.y - 40);
        sx.stroke();
        shoot.x += 520 * dt;
        shoot.y += 230 * dt;
        shoot.l -= dt * 0.9;
        if (shoot.l <= 0) shoot = null;
      }

      /* smooth followers (frame-rate independent easing) */
      const k1 = 1 - Math.exp(-dt * 5);
      A.speed += (Math.hypot(A.mx - A.px, A.my - A.py) / Math.max(dt, 0.001) / 1600 - A.speed) * (1 - Math.exp(-dt * 8));
      A.px = A.mx;
      A.py = A.my;
      A.ex += (A.mx - A.ex) * k1;
      A.ey += (A.my - A.ey) * k1;
      A.hue += (A.th - A.hue) * (1 - Math.exp(-dt * 3));
      A.boost *= Math.exp(-dt * 2.2);

      /* fire: emit, then draw additively */
      const power = Math.min(1, A.speed * 1.4) * 0.5 + (A.drag ? 1 : 0) + A.boost;
      const n = Math.round(power * 9 + (Math.random() < (power * 3) % 1 ? 1 : 0));
      const buoy = [0.6, 0.8, 1][A.grav === 0 ? 0 : A.grav < 1 ? 1 : 2];
      for (let i = 0; i < n && A.pts.length < MAX_PARTICLES; i++) {
        const ang = Math.random() * TAU;
        const rad = Math.random() * 4;
        A.pts.push({
          x: A.ex + Math.cos(ang) * rad,
          y: A.ey + Math.sin(ang) * rad,
          vx: (Math.random() - 0.5) * 28 + (A.mx - A.ex) * 0.9,
          vy: -(70 + Math.random() * 90) * buoy,
          l: 1,
          dl: 0.9 + Math.random() * 0.7,
          s: 6 + Math.random() * 7 + power * 3,
        });
        if (Math.random() < 0.18) {
          A.pts.push({
            x: A.ex,
            y: A.ey,
            vx: (Math.random() - 0.5) * 70,
            vy: -(110 + Math.random() * 130),
            l: 1,
            dl: 1.5 + Math.random(),
            s: 1.8,
          });
        }
      }

      fc.clearRect(0, 0, W, H);
      fc.globalCompositeOperation = 'lighter';
      for (let i = A.pts.length - 1; i >= 0; i--) {
        const p = A.pts[i];
        p.l -= p.dl * dt;
        if (p.l <= 0) {
          A.pts.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.96;
        p.vy *= 0.99;
        p.vx += Math.sin(t / 160 + p.y * 0.05 + p.s) * 70 * dt;
        const r = p.s * (0.3 + p.l * 0.7);
        const h = A.hue + p.l * p.l * 34;
        const L = 40 + p.l * p.l * 48;
        const al = Math.min(1, p.l * 1.6) * 0.6;
        const g = fc.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.3);
        g.addColorStop(0, `hsla(${h},100%,${L}%,${al})`);
        g.addColorStop(0.5, `hsla(${h - 8},100%,${L - 14}%,${al * 0.6})`);
        g.addColorStop(1, `hsla(${h - 14},100%,30%,0)`);
        fc.fillStyle = g;
        fc.beginPath();
        fc.ellipse(p.x, p.y, r * 0.75, r * 1.3, 0, 0, TAU);
        fc.fill();
      }
      fc.globalCompositeOperation = 'source-over';

      raf = requestAnimationFrame(frame);
    };

    fxRef.current = A;
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      fxRef.current = null;
    };
  }, []);

  // Fire buoyancy follows the selected gravity mode ('0g' -> 0, '0.16g' -> 0.16 ...).
  useEffect(() => {
    if (fxRef.current) fxRef.current.grav = parseFloat(gravity);
  }, [gravity]);

  // Sticky header: show the glass bar behind it once the page scrolls.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Slider -> backdrop: flare the flame and shift its colour.
  const slide = (n) => fxRef.current?.slide(n);

  const ranking = useMemo(
    () => (hasRun ? (remoteRank || localRank(params)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasRun, remoteRank, oxygen, pressure, airflow, gravity]
  );

  const byTier = useMemo(() => {
    const out = { High: [], Medium: [], Low: [] };
    [...ranking].sort((a, b) => b.score - a.score).forEach((r) => out[r.tier]?.push(r));
    return out;
  }, [ranking]);

  // Top-risk result from the latest backend calculation (only when remoteRank is set).
  const topRisk = useMemo(
    () => (ranking.length ? [...ranking].sort((a, b) => b.score - a.score)[0] : null),
    [ranking],
  );

  const selectedId = fuelToId(fuel);

  // Latest assistant reply (excluding the welcome banner) captured in reports.
  const lastAnalysis = useMemo(
    () =>
      [...messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.id !== 'welcome'),
    [messages]
  );

  function exportSummary() {
    const now = new Date();
    const html = buildSummaryReport({
      gravity,
      oxygen,
      pressure,
      airflow,
      fuel,
      ranking,
      rankNote,
      analysis: lastAnalysis,
      apiOnline,
      aiProvider,
      generatedAt: now,
    });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `flame-in-freefall-summary-${reportStamp(now)}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoke once the download has had a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function runSimulation() {
    setRunning(true);
    setSimError(null);
    let res = null;
    try {
      res = await apiFetch('/rank-materials', {
        oxygen_conc: oxygen,
        pressure,
        gravity,
        airflow,
        material: fuel,
      });
      if (!res.ok) {
        let body = '';
        try {
          body = await res.text();
        } catch {
          /* body unreadable - report status only */
        }
        console.error(`Simulation request failed: HTTP ${res.status}`, body);
        throw new Error(
          `HTTP ${res.status}${body ? ` - ${body.slice(0, 300)}` : ''}`,
        );
      }
      const parsed = normalizeRanking(await res.json());
      if (!parsed.length) throw new Error('Empty ranking');
      setRemoteRank(parsed);
      setHasRun(true);
      setSimError(null);
      setApiOnline(true);
      setRankNote(`Ranked by the backend at ${gravity}, ${oxygen}% O₂.`);
    } catch (err) {
      // Log to DevTools so a silent failure is never invisible, then surface
      // a banner in the UI and fall back to the local estimate.
      console.error('Simulation request failed:', err);
      setSimError(err instanceof Error ? err.message : String(err));
      setHasRun(true);
      setRemoteRank(null);
      setApiOnline(false);
      setRankNote(
        'Backend unreachable or simulation failed. Showing the local estimate instead.',
      );
    } finally {
      setRunning(false);
    }
  }

  // Refresh follow-up prompts for the turn that just completed. The explicit
  // question/answer arguments avoid the stale-closure bug where the old
  // messages array was sampled before the new answer existed.
  async function fetchChips({ question: asked, answer: assistantAnswer = '', history: priorHistory = [] } = {}) {
    const lastUser = String(asked || '').trim();
    if (!lastUser) return;
    const requestId = chipsRequestRef.current + 1;
    chipsRequestRef.current = requestId;
    setChipsLoading(true);

    let generated = [];
    try {
      const res = await apiFetch('/quick-questions', {
        question: lastUser,
        answer: assistantAnswer,
        history: priorHistory,
      });
      if (res.ok) {
        const data = await res.json();
        generated = Array.isArray(data.questions) ? data.questions : [];
      }
    } catch {
      /* endpoint unavailable - local suggestions below keep the row populated */
    }

    const fallback = deriveSuggestions({
      question: lastUser,
      answer: assistantAnswer,
      fuel,
      oxygen,
      gravity,
      previous: quickQuestions,
    });
    const merged = uniqueStrings([...generated, ...fallback]);
    if (chipsRequestRef.current !== requestId) return;
    setQuickQuestions(merged.length ? merged.slice(0, 4) : DEFAULT_SUGGESTIONS);
    setChipsLoading(false);
  }

  // One entry point for typed messages and suggestion-pill clicks. Pills call
  // submitQuery directly, which fills the input, submits it and clears it again.
  function submitQuery(value) {
    const query = String(value ?? '').trim();
    if (!query || thinking) return;
    setDraft(query);
    void sendMessage(query);
  }

  async function sendQuery(e) {
    e?.preventDefault();
    submitQuery(draft);
  }

  async function sendMessage(query) {
    if (!query || thinking) return;
    // Prior turns ride along with the request so the backend can replay them to
    // the AI model as conversation history. `messages` still excludes the
    // message being sent, so the new turn is not duplicated in the history.
    const history = messages
      .filter((m) => m.id !== 'welcome' && !m.error && (m.text || '').trim())
      .slice(-40)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', text: m.text }));
    setMessages((m) => [...m, { id: `u${Date.now()}`, role: 'user', text: query }]);
    setDraft('');
    setThinking(true);

    let answerText = '';
    try {
      const res = await apiFetch('/query-agent', {
        query,
        history,
        gravity_filter: gravity,
        oxygen_conc: oxygen,
        pressure,
        airflow,
        fuel,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const a = normalizeAnswer(await res.json());
      answerText = a.text;
      setApiOnline(true);
      setMessages((m) => [...m, { id: `a${Date.now()}`, role: 'assistant', ...a }]);
    } catch {
      setApiOnline(false);
      setMessages((m) => [
        ...m,
        {
          id: `a${Date.now()}`,
          role: 'assistant',
          error: true,
          text: `I could not reach the backend on ${API_CANDIDATES.join(', ')}. Start the FastAPI server and try again.`,
          citations: [],
          confidence: null,
          sources: [],
        },
      ]);
    } finally {
      setThinking(false);
      // Refresh the row in the background; existing pills stay clickable until
      // the new set arrives, so the suggestions never disappear.
      void fetchChips({ question: query, answer: answerText, history });
    }
  }

  const rows = useMemo(() => {
    let r = SEED_RUNS.filter(
      (x) => (showAllGravity || x.gravity === gravity) && (riskFilter === 'All' || x.risk === riskFilter)
    );
    const dir = sort.dir === 'asc' ? 1 : -1;
    r = [...r].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * dir;
    });
    return r;
  }, [gravity, showAllGravity, riskFilter, sort]);

  const columns = [
    { key: 'fuel', label: 'Fuel material' },
    { key: 'gravity', label: 'Gravity' },
    { key: 'o2', label: 'Oxygen %', num: true },
    { key: 'airflow', label: 'Airflow (cm/s)', num: true },
    { key: 'spread', label: 'Spread rate (mm/s)', num: true },
    { key: 'risk', label: 'Risk' },
    { key: null, label: 'Citation' },
  ];

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  return (
    <div className="aethon">
      {/* Backdrop: twinkling stars, then fire particles above them */}
      <canvas ref={starsRef} id="stars" className="fx fx-stars" aria-hidden="true" />
      <canvas ref={fireRef} id="fire" className="fx fx-fire" aria-hidden="true" />

      {/* Sticky header. The bar behind the pill is a sibling layer (not an
          ancestor) so the pill's own backdrop blur keeps working. */}
      <div className="sticky top-0 z-50 px-5 pb-3 pt-[calc(env(safe-area-inset-top,0px)_+_14px)] [@media(max-height:520px)]:static">
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 -z-10 border-b border-white/10 bg-[#0b0f19]/80 backdrop-blur-md transition-opacity duration-300 ${
            scrolled ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <header className="top glass mx-auto max-w-[1460px]">
          <div className="brand">
            <div className="logo">
              <Flame aria-hidden />
            </div>
            <div>
              <h1>AETHON</h1>
              <div className="sub">NASA Microgravity Combustion &amp; Fire Safety AI Platform</div>
            </div>
          </div>

          <div className="bar">
            <span className={`pill ${apiOnline ? 'p-em' : 'p-am'}`}>
              <span className={`dot${apiOnline ? '' : ' off'}`} aria-hidden />
              {apiOnline ? 'FastAPI: Connected' : 'FastAPI: Offline (demo mode)'}
            </span>

            <span className="pill p-cy">
              <Database aria-hidden />
              {docCount != null ? `ChromaDB: ${docCount} Papers` : 'ChromaDB: Indexed'}
            </span>

            <span
              title={
                aiProvider === 'groq'
                  ? 'Answers are synthesised by Groq and grounded in the retrieved papers.'
                  : aiProvider === 'openrouter'
                    ? 'Answers are synthesised by OpenRouter and grounded in the retrieved papers.'
                    : 'Add GROQ_API_KEY or OPENROUTER_API_KEY to .env next to main.py, then restart the backend.'
              }
              className={`pill ${aiProvider ? 'p-vi' : 'p-mu'}`}
            >
              <Sparkles aria-hidden />
              {aiProvider === 'groq' ? 'AI: Groq' : aiProvider === 'openrouter' ? 'AI: OpenRouter' : 'AI: add key to .env'}
            </span>

            <button
              type="button"
              onClick={exportSummary}
              title="Download a report of the current settings, risk matrix scores and latest AI analysis"
              className="btn-ghost"
            >
              <Download aria-hidden />
              Export Summary Report
            </button>

            <div role="group" aria-label="Gravity mode" className="seg">
              {GRAVITY_MODES.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => setGravity(g.value)}
                  aria-pressed={gravity === g.value}
                  className={gravity === g.value ? 'on' : ''}
                >
                  <b>{g.label}</b>
                  <small>{g.sub}</small>
                </button>
              ))}
            </div>
          </div>
        </header>
      </div>

      <div className="wrap pt-2">
        <main className="layout">
          {/* Left column */}
          <div className="left">
            <Panel title="Experiment controls" icon={Wind} a="#22d3ee" b="#a78bfa">
              <div className="pb">
                <Slider id="o2" label="Oxygen concentration" unit="%" value={oxygen} min={15} max={35} c1="#22d3ee" c2="#6366f1" onChange={setOxygen} onSlide={slide} />
                <Slider id="p" label="Ambient pressure" unit="kPa" value={pressure} min={50} max={150} step={0.1} digits={1} c1="#a78bfa" c2="#f472b6" onChange={setPressure} onSlide={slide} />
                <Slider id="v" label="Forced airflow velocity" unit="cm/s" value={airflow} min={0} max={50} c1="#fbbf24" c2="#fb923c" onChange={setAirflow} onSlide={slide} />

                <div>
                  <label htmlFor="fuel" className="lbl mb-2 block">
                    Fuel specimen
                  </label>
                  <select
                    id="fuel"
                    value={fuel}
                    onChange={(e) => setFuel(e.target.value)}
                    className="field"
                  >
                    {FUELS.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </div>

                <button type="button" onClick={runSimulation} disabled={running} className="run">
                  {running ? <Loader2 className="animate-spin" aria-hidden /> : <Play fill="currentColor" aria-hidden />}
                  {running ? 'Calculating Risk…' : 'RUN SIMULATION & RANK RISK'}
                </button>
                {simError && (
                  <div className="sim-error" role="alert">
                    <AlertTriangle aria-hidden />
                    <span>Simulation failed: {simError}</span>
                    <button
                      type="button"
                      onClick={() => setSimError(null)}
                      className="sim-error-dismiss"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            </Panel>

            <Panel
              title="Material flammability risk matrix"
              icon={AlertTriangle}
              a="#fb7185"
              b="#fbbf24"
              iconColor="#fb7185"
              right={<span className="tag">{gravity}</span>}
            >
              <div className="pb flush">
                <div className="cols">
                  {['High', 'Medium', 'Low'].map((tier) => {
                    const t = TIERS[tier];
                    return (
                      <div key={tier} className="col" style={{ '--k': t.k }}>
                        <h3>
                          {t.title}
                          <span>{byTier[tier].length}</span>
                        </h3>
                        <p>{t.hint}</p>
                        <ul>
                          {byTier[tier].length === 0 && <li className="none">None at these settings</li>}
                          {byTier[tier].map((r) => (
                            <li key={r.material} className={r.material === selectedId ? 'sel' : ''}>
                              <div>
                                <span>{r.material}</span>
                                <em>{Math.round(r.score * 100)}</em>
                              </div>
                              <div className="bar2">
                                <span className="fill" style={{ width: `${r.score * 100}%` }} />
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
                <p className="note">
                  <Sparkles aria-hidden />
                  {rankNote}
                </p>
                {remoteRank && topRisk && (
                  <div className="sim-result flush">
                    <div className="sim-insight">
                      <div className="sim-insight-header">
                        <Flame aria-hidden />
                        Backend simulation results
                      </div>
                      <div className="sim-insight-body">
                        <span className="sim-insight-conditions">
                          Calculated at {gravity}, {oxygen}% O₂, {pressure} kPa, {airflow} cm/s airflow, fuel: {fuel}.
                        </span>
                      </div>
                      <div className="sim-insight-result">
                        <span>
                          Highest risk: <span className="material">{topRisk.material}</span> —{' '}
                          <span className="score">{Math.round(topRisk.score * 100)}</span>{' '}
                          <span className="tier">({topRisk.tier})</span>
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Panel>
          </div>

          {/* Right column: chat */}
          <Panel
            title="AI agent query console"
            icon={Sparkles}
            a="#a78bfa"
            b="#f472b6"
            iconColor="#a78bfa"
            className="chat right"
            right={<span className="tag">Searching {gravity} records</span>}
          >
            <div className="msgs" aria-live="polite">
              {messages.map((m) => (
                <div key={m.id} className={`m${m.role === 'user' ? ' u' : ''}`}>
                  <span className="av">{m.role === 'user' ? 'You' : <Sparkles aria-hidden />}</span>
                  <div className={`bub${m.error ? ' err' : ''}`}>
                    <div className="whitespace-pre-wrap">
                      {m.role === 'assistant' ? (
                        <MarkdownBlock
                          text={m.text}
                          sources={m.sources?.length ? m.sources : m.citations}
                          onOpen={setOpenSource}
                        />
                      ) : (
                        m.text
                      )}
                    </div>
                    {m.role === 'assistant' && m.id !== 'welcome' && !m.error && (
                      <Citation message={m} onOpenSource={setOpenSource} />
                    )}
                  </div>
                </div>
              ))}
              {thinking && (
                <div className="thinking">
                  <Loader2 className="animate-spin" aria-hidden /> Overthinking this so you don&apos;t have to…
                </div>
              )}
              <div ref={endRef} />
            </div>
            <div className="chips" aria-label="Suggested follow-up questions" aria-busy={chipsLoading}>
              {(quickQuestions.length ? quickQuestions : DEFAULT_SUGGESTIONS).map((q, i) => (
                <button
                  key={`${q}-${i}`}
                  type="button"
                  onClick={() => submitQuery(q)}
                  disabled={thinking}
                  className="chip chip-suggest"
                  title={`Ask: ${q}`}
                >
                  {q}
                </button>
              ))}
              {chipsLoading && (
                <span className="chip chip-loading" aria-hidden>
                  Refreshing follow-ups…
                </span>
              )}
            </div>

            <form onSubmit={sendQuery} className="composer">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask about flame spread, extinction limits or materials"
                aria-label="Ask the agent"
                autoComplete="off"
                className="field"
              />
              <button type="submit" disabled={!draft.trim() || thinking} className="send">
                <Send aria-hidden />
                Send
              </button>
            </form>
          </Panel>

          {/* Flame behavior index */}
          <Panel
            title="Flame behavior index"
            icon={Activity}
            a="#fbbf24"
            b="#22d3ee"
            iconColor="#fbbf24"
            className="full"
            right={
              <div className="tools">
                <label>
                  <input
                    type="checkbox"
                    checked={showAllGravity}
                    onChange={(e) => setShowAllGravity(e.target.checked)}
                  />
                  All gravity levels
                </label>
                <select
                  value={riskFilter}
                  onChange={(e) => setRiskFilter(e.target.value)}
                  aria-label="Filter by risk"
                  className="field"
                >
                  {['All', 'High', 'Medium', 'Low'].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </div>
            }
          >
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.label} scope="col" className={c.num ? 'r' : ''}>
                        {c.key ? (
                          <button type="button" onClick={() => toggleSort(c.key)}>
                            {c.label}
                            {sort.key === c.key &&
                              (sort.dir === 'asc' ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />)}
                          </button>
                        ) : (
                          c.label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty">
                        No runs match these filters. Try “All gravity levels”.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id} className={r.fuel === selectedId ? 'hl' : ''}>
                      <td style={{ fontWeight: 500 }}>{r.fuel}</td>
                      <td className="mo">{r.gravity}</td>
                      <td className="mo r">{r.o2}</td>
                      <td className="mo r">{r.airflow}</td>
                      <td className="sp r">{r.spread.toFixed(1)}</td>
                      <td>
                        <RiskChip tier={r.risk} />
                      </td>
                      <td>
                        <a href={r.url} target="_blank" rel="noreferrer">
                          Source <ExternalLink aria-hidden />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="foot">
              Demo seed data. Spread rates are placeholders until they are replaced with metrics extracted from the NASA reports.
            </p>
          </Panel>
        </main>
      </div>

      {openSource && (
        <SourceModal source={openSource} onClose={() => setOpenSource(null)} />
      )}
    </div>
  );
}
