/**
 * ui.js
 * ─────────────────────────────────────────────────────────────
 * UI rendering, syntax highlighting, line numbers,
 * transparency panel toggle, and export utilities.
 * ─────────────────────────────────────────────────────────────
 */

import { PATTERNS } from './analysisEngine.js';

// ── Syntax Highlighter ─────────────────────────────────────────
const PY_KEYWORDS = /\b(def|class|for|while|if|elif|else|return|import|from|as|with|pass|break|continue|try|except|finally|raise|yield|lambda|and|or|not|in|is|None|True|False|async|await|global|nonlocal)\b/g;
const PY_BUILTINS = /\b(print|len|range|type|int|float|str|list|dict|set|tuple|bool|sum|max|min|sorted|enumerate|zip|map|filter|open|input|abs|round|isinstance|hasattr|getattr|setattr)\b/g;
const CPP_KEYWORDS = /\b(int|float|double|char|bool|void|long|short|unsigned|const|static|inline|struct|class|namespace|template|typename|auto|return|for|while|if|else|do|switch|case|break|continue|new|delete|nullptr|true|false|public|private|protected|virtual|override|include|define|ifdef|endif|using|std)\b/g;
const CPP_BUILTINS = /\b(vector|string|cout|cin|endl|printf|scanf|malloc|free|memcpy|push_back|size|begin|end|sort|accumulate|transform)\b/g;
const NUMBERS_RX = /\b(\d+\.?\d*([eE][+-]?\d+)?)\b/g;
const STRINGS_RX = /(["'`])(?:(?!\1)[^\\]|\\[\s\S])*\1/g;
const PY_COMMENT = /#[^\n]*/g;
const CPP_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

function escape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Applies basic token-level syntax highlighting.
 * Operates on escaped HTML to avoid injection.
 */
export function highlight(code, lang) {
    // We work on segments to avoid overlapping replacements.
    // Strategy: tokenise left-to-right, escape each token, wrap in span.
    const esc = escape(code);

    // Replace comments first (greedy, to avoid matching inside strings)
    const commentRx = lang === 'python' ? PY_COMMENT : CPP_COMMENT;
    let h = esc.replace(commentRx, m => `<span class="syn-comment">${escape(m)}</span>`);

    // Strings
    h = h.replace(STRINGS_RX, m => `<span class="syn-string">${escape(m)}</span>`);

    // Keywords
    const kwRx = lang === 'python' ? PY_KEYWORDS : CPP_KEYWORDS;
    h = h.replace(kwRx, m => `<span class="syn-keyword">${m}</span>`);

    // Builtins
    const biRx = lang === 'python' ? PY_BUILTINS : CPP_BUILTINS;
    h = h.replace(biRx, m => `<span class="syn-builtin">${m}</span>`);

    // Numbers
    h = h.replace(NUMBERS_RX, m => `<span class="syn-number">${m}</span>`);

    return h;
}

// ── Line Numbers ───────────────────────────────────────────────
export function updateLineNumbers(code, container) {
    const count = Math.max(1, code.split('\n').length);
    let html = '';
    for (let i = 1; i <= count; i++) {
        html += i + '\n';
    }
    container.textContent = html;
}

// ── Status Bar ─────────────────────────────────────────────────
export function updateStatusBar(code, lang) {
    const el = {
        chars: document.getElementById('status-chars'),
        lines: document.getElementById('status-lines'),
        lang: document.getElementById('status-lang'),
    };
    if (el.chars) el.chars.textContent = `${code.length.toLocaleString()} chars`;
    if (el.lines) el.lines.textContent = `${code.split('\n').length} lines`;
    if (el.lang) el.lang.textContent = lang === 'python' ? 'Python' : 'C++';
}

// ── Results Renderer ───────────────────────────────────────────
export function renderResults(result) {
    const placeholder = document.getElementById('results-placeholder');
    const content = document.getElementById('results-content');
    if (placeholder) placeholder.classList.add('hidden');
    if (content) content.classList.remove('hidden');

    _renderScores(result);
    _renderPerformance(result);
    _renderPatterns(result.detectedPatterns);
    _renderAmdRecs(result.amdRecs);
    _renderTransparency(result);
}

function _renderScores(r) {
    const scoreEl = document.getElementById('score-parallelism');
    const barEl = document.getElementById('score-bar');
    const suitEl = document.getElementById('score-suitability');
    const patEl = document.getElementById('score-patterns');

    if (scoreEl) scoreEl.textContent = r.parallelismScore.toFixed(1);
    if (patEl) patEl.textContent = `${r.detectedPatterns.length}`;

    if (suitEl) {
        const colours = { high: '#5fb580', medium: '#e6b84a', low: '#8898aa', none: '#556070' };
        suitEl.textContent = r.suitability.label;
        suitEl.style.color = colours[r.suitability.level] || '';
        suitEl.style.fontSize = '14px';
    }

    if (barEl) {
        const pct = (r.parallelismScore / 10) * 100;
        barEl.style.width = `${pct}%`;
        if (r.parallelismScore >= 7) barEl.style.background = 'var(--green)';
        else if (r.parallelismScore >= 4) barEl.style.background = 'var(--blue)';
        else if (r.parallelismScore >= 1) barEl.style.background = 'var(--yellow)';
        else barEl.style.background = 'var(--text-muted)';
    }
}

function _renderPerformance(r) {
    const fmt = _fmtTime;

    _setText('perf-cpu', fmt(r.cpuTimeMs));
    _setText('perf-gpu', fmt(r.gpuTimeMs));
    _setText('speedup-value', `${r.speedup}×`);
    _setText('ppw-value', `${r.ppwGain}×`);
    _setText('transfer-value', `${fmt(r.xferOverheadMs)}`);
}

function _fmtTime(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
    if (ms < 1000) return `${ms.toFixed(1)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
    return `${(ms / 60000).toFixed(2)} min`;
}

function _renderPatterns(detected) {
    const container = document.getElementById('pattern-list');
    if (!container) return;

    if (detected.length === 0) {
        container.innerHTML = `
      <div class="pattern-item">
        <div class="pattern-dot dot-low"></div>
        <span class="pattern-name" style="color:var(--text-muted)">
          No significant parallel patterns detected in submitted code.
        </span>
      </div>`;
        return;
    }

    container.innerHTML = detected.map(p => `
    <div class="pattern-item">
      <div class="pattern-dot dot-${p.level}"></div>
      <span class="pattern-name">${p.label}</span>
      <span class="pattern-weight">${p.weight > 0 ? '+' : ''}${p.weight}</span>
      <span class="pattern-badge">${p.level.toUpperCase()}</span>
    </div>
  `).join('');
}

function _renderAmdRecs(recs) {
    const container = document.getElementById('amd-recs');
    if (!container) return;

    if (!recs || recs.length === 0) {
        container.innerHTML = `<p style="color:var(--text-muted);font-size:12px;">No specific AMD recommendations for this workload.</p>`;
        return;
    }

    container.innerHTML = recs.map(r => `
    <div class="amd-rec-item">
      <div class="amd-rec-tag">${r.tag}</div>
      <div class="amd-rec-content">
        <div class="amd-rec-title">${r.title}</div>
        <div class="amd-rec-desc">${r.desc}</div>
      </div>
    </div>
  `).join('');
}

function _renderTransparency(r) {
    // Weight table
    const tbody = document.getElementById('weight-table-body');
    if (tbody) {
        tbody.innerHTML = PATTERNS.map(p => {
            const active = r.detectedPatterns.includes(p) ? 'style="color:var(--text-primary)"' : '';
            return `<tr ${active}>
        <td>${p.label}</td>
        <td style="color:${p.weight >= 0 ? 'var(--green)' : 'var(--accent)'};font-family:var(--font-mono)">
          ${p.weight > 0 ? '+' : ''}${p.weight}
        </td>
        <td style="color:var(--text-muted)">${p.description}</td>
      </tr>`;
        }).join('');
    }

    // Analysis log
    const logEl = document.getElementById('analysis-log');
    if (logEl) {
        logEl.innerHTML = r.log.map(entry => {
            const cls = entry.type === 'step' ? 'log-step' : entry.type === 'warn' ? 'log-warn' : 'log-info';
            const prefix = entry.type === 'step' ? '✓' : entry.type === 'warn' ? '⚠' : '•';
            return `<span class="${cls}">${prefix} ${entry.msg}</span>\n`;
        }).join('');
    }
}

// ── Transparency Panel Toggle ──────────────────────────────────
export function initTransparencyToggle() {
    const btn = document.getElementById('transparency-toggle');
    const body = document.getElementById('transparency-body');
    const chevron = document.getElementById('toggle-chevron');
    if (!btn || !body) return;

    btn.addEventListener('click', () => {
        const open = body.classList.toggle('hidden');
        btn.setAttribute('aria-expanded', String(!open));
        if (chevron) chevron.classList.toggle('rotated', !open);
    });
    // Start closed
    body.classList.add('hidden');
}

// ── Export Analysis as Text Report ───────────────────────────
export function exportReport(result, code, lang) {
    const lines = [
        '========================================',
        ' Compute Offload Advisor — Analysis Report',
        `  Generated: ${new Date().toLocaleString()}`,
        '========================================',
        '',
        `Language     : ${lang === 'python' ? 'Python' : 'C++'}`,
        `Source lines : ${code.split('\n').length}`,
        '',
        '── Workload Assessment ──────────────────',
        `Parallelism Score  : ${result.parallelismScore} / 10`,
        `GPU Suitability    : ${result.suitability.label}`,
        `Patterns Detected  : ${result.detectedPatterns.length}`,
        '',
        '── Performance Estimates ────────────────',
        `CPU Time Estimate  : ${_fmtTime(result.cpuTimeMs)} (8-core, 3.5 GHz)`,
        `GPU Time Estimate  : ${_fmtTime(result.gpuTimeMs)} (AMD, 2048 threads)`,
        `Estimated Speedup  : ${result.speedup}×`,
        `Perf-per-Watt Gain : ${result.ppwGain}×`,
        `Transfer Overhead  : ${_fmtTime(result.xferOverheadMs)}`,
        '',
        '── Detected Patterns ────────────────────',
        ...result.detectedPatterns.map(p =>
            `  [${p.level.toUpperCase()}] ${p.label} (weight: ${p.weight})`),
        result.detectedPatterns.length === 0 ? '  None detected.' : '',
        '',
        '── AMD Recommendations ──────────────────',
        ...result.amdRecs.map(r =>
            `  [${r.tag}] ${r.title}\n         ${r.desc}`),
        result.amdRecs.length === 0 ? '  No specific recommendations.' : '',
        '',
        '── Analysis Log ─────────────────────────',
        ...result.log.map(e => `  ${e.type.toUpperCase()} ${e.msg}`),
        '',
        '========================================',
        ' Hardware Assumptions',
        '  CPU Cores      : 8',
        '  CPU Clock      : 3.5 GHz',
        '  GPU Threads    : 2,048',
        '  Efficiency     : 0.65',
        '  Transfer OH    : 12%',
        '========================================',
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `offload-analysis-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

// ── Utility ────────────────────────────────────────────────────
function _setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}
