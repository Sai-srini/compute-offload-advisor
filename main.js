/**
 * main.js
 * ─────────────────────────────────────────────────────────────
 * Entry point. Wires the analysis engine to the UI.
 * ─────────────────────────────────────────────────────────────
 */

import { analyzeCode, SAMPLES } from './analysisEngine.js';
import {
    highlight,
    updateLineNumbers,
    updateStatusBar,
    renderResults,
    initTransparencyToggle,
    exportReport,
} from './ui.js';

// ── State ──────────────────────────────────────────────────────
let currentLang = 'python';
let lastResult = null;
let lastCode = '';

// ── DOM Refs ───────────────────────────────────────────────────
const codeInput = document.getElementById('code-input');
const syntaxOverlay = document.getElementById('syntax-overlay');
const lineNumbers = document.getElementById('line-numbers');
const langSelect = document.getElementById('lang-select');
const btnAnalyze = document.getElementById('btn-analyze');
const btnSample = document.getElementById('btn-sample');
const btnExport = document.getElementById('btn-export');

// ── Initial Setup ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    initTransparencyToggle();
    syncEditorOverlay('');
    updateStatusBar('', currentLang);

    // Pre-load Python sample on init so the editor isn't empty
    loadSample();
});

// ── Lang Select ────────────────────────────────────────────────
langSelect?.addEventListener('change', () => {
    currentLang = langSelect.value;
    loadSample();
    updateStatusBar(codeInput?.value ?? '', currentLang);
});

// ── Load Sample ────────────────────────────────────────────────
btnSample?.addEventListener('click', () => {
    loadSample();
});

function loadSample() {
    const code = SAMPLES[currentLang] ?? '';
    if (codeInput) {
        codeInput.value = code;
        syncEditorOverlay(code);
        updateLineNumbers(code, lineNumbers);
        updateStatusBar(code, currentLang);
    }
}

// ── Live Editor Sync ───────────────────────────────────────────
codeInput?.addEventListener('input', () => {
    const code = codeInput.value;
    syncEditorOverlay(code);
    updateLineNumbers(code, lineNumbers);
    updateStatusBar(code, currentLang);
});

// Keep syntax overlay scrolled in sync with textarea
codeInput?.addEventListener('scroll', () => {
    if (syntaxOverlay) {
        syntaxOverlay.scrollTop = codeInput.scrollTop;
        syntaxOverlay.scrollLeft = codeInput.scrollLeft;
    }
    if (lineNumbers) {
        lineNumbers.scrollTop = codeInput.scrollTop;
    }
});

// Handle Tab key in editor
codeInput?.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
        e.preventDefault();
        const start = codeInput.selectionStart;
        const end = codeInput.selectionEnd;
        codeInput.value =
            codeInput.value.substring(0, start) + '    ' + codeInput.value.substring(end);
        codeInput.selectionStart = codeInput.selectionEnd = start + 4;
        syncEditorOverlay(codeInput.value);
    }
});

function syncEditorOverlay(code) {
    if (syntaxOverlay) {
        syntaxOverlay.innerHTML = highlight(code, currentLang) + '\n'; // trailing \n prevents scroll jump
    }
}

// ── Analyze ────────────────────────────────────────────────────
btnAnalyze?.addEventListener('click', () => {
    const code = codeInput?.value?.trim() ?? '';

    if (!code) {
        showAnalyzeError('Please paste or load sample code before analyzing.');
        return;
    }

    btnAnalyze.textContent = 'Analyzing…';
    btnAnalyze.disabled = true;

    // Small timeout so browser can repaint the button state
    setTimeout(() => {
        try {
            lastCode = code;
            lastResult = analyzeCode(code, currentLang);
            renderResults(lastResult);
        } catch (err) {
            console.error('Analysis error:', err);
            showAnalyzeError('Analysis failed: ' + err.message);
        } finally {
            btnAnalyze.textContent = 'Analyze Code';
            btnAnalyze.disabled = false;
        }
    }, 30);
});

// ── Export ─────────────────────────────────────────────────────
btnExport?.addEventListener('click', () => {
    if (!lastResult) return;
    exportReport(lastResult, lastCode, currentLang);
});

// ── Error helper ───────────────────────────────────────────────
function showAnalyzeError(msg) {
    const placeholder = document.getElementById('results-placeholder');
    if (placeholder) {
        placeholder.classList.remove('hidden');
        const p = placeholder.querySelector('.placeholder-text');
        if (p) p.innerHTML = `<span style="color:var(--accent)">${msg}</span>`;
    }
    const content = document.getElementById('results-content');
    if (content) content.classList.add('hidden');

    btnAnalyze.textContent = 'Analyze Code';
    btnAnalyze.disabled = false;
}
