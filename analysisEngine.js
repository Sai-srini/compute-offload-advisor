/**
 * analysisEngine.js
 * ─────────────────────────────────────────────────────────────
 * Rule-based static analysis engine for CPU→GPU offload scoring.
 * Deterministic heuristics only — no AI inference.
 * ─────────────────────────────────────────────────────────────
 */

// ── Hardware Constants (transparent, editable) ───────────────
export const HW = {
  CPU_CORES:         8,
  CPU_CLOCK_GHZ:     3.5,
  GPU_THREADS:       2048,
  EFFICIENCY_FACTOR: 0.65,
  TRANSFER_OVERHEAD: 0.12,   // 12 % of cpu_time
  CPU_TDP_W:         95,     // typical desktop CPU TDP
  GPU_TDP_W:         150,    // typical AMD Radeon workload TDP
  BASE_CPU_TIME_MS:  1000,   // baseline for 10^5 element workload
};

// ── Pattern Definitions ──────────────────────────────────────
// Each pattern: { id, label, weight, level: 'high'|'medium'|'low', description }
export const PATTERNS = [
  {
    id:          'large_for_loop',
    label:       'Large Iteration Loop (n > 100,000)',
    weight:      2.5,
    level:       'high',
    description: 'Loop iterating over a large data set — embarrassingly parallel candidate.',
  },
  {
    id:          'nested_loop',
    label:       'Nested Loop Structure (2+ levels)',
    weight:      2.0,
    level:       'high',
    description: 'Nested loops imply O(n²)+ complexity — high parallelisation payoff.',
  },
  {
    id:          'matrix_operation',
    label:       'Matrix / 2-D Array Operation',
    weight:      1.8,
    level:       'high',
    description: 'Matrix multiply / transpose maps directly to GPU SIMD execution units.',
  },
  {
    id:          'elementwise_mul',
    label:       'Element-wise Multiplication',
    weight:      1.5,
    level:       'high',
    description: 'Vectorisable arithmetic — ideal for GPU compute shaders.',
  },
  {
    id:          'image_processing',
    label:       'Image / Pixel Processing',
    weight:      1.8,
    level:       'high',
    description: 'Pixel-level operations trivially parallelise across GPU thread blocks.',
  },
  {
    id:          'reduction_op',
    label:       'Reduction Operation (sum / max / min)',
    weight:      1.2,
    level:       'medium',
    description: 'Parallel reductions are well-optimised in ROCm / HIP primitives.',
  },
  {
    id:          'sort_op',
    label:       'Sorting Algorithm',
    weight:      1.0,
    level:       'medium',
    description: 'Parallel sort (e.g., Radix) achievable on GPU with ROCThrust.',
  },
  {
    id:          'fft_pattern',
    label:       'FFT / Frequency Domain Pattern',
    weight:      1.5,
    level:       'medium',
    description: 'Fourier transforms are GPU-native; rocFFT provides drop-in acceleration.',
  },
  {
    id:          'nn_pattern',
    label:       'Neural Network / Tensor Op Pattern',
    weight:      2.0,
    level:       'high',
    description: 'GEMM-heavy workloads directly accelerated by AMD ROCm / MIOpen.',
  },
  {
    id:          'data_transfer',
    label:       'Frequent Memory Copy / Alloc',
    weight:      -0.5,
    level:       'low',
    description: 'Frequent host-device transfers can negate GPU benefit — refactor needed.',
  },
  {
    id:          'branch_heavy',
    label:       'Branch-Heavy / Control-Flow',
    weight:      -0.8,
    level:       'low',
    description: 'Divergent branches cause GPU warp inefficiency — low offload benefit.',
  },
  {
    id:          'recursion',
    label:       'Recursive Call Pattern',
    weight:      -0.5,
    level:       'low',
    description: 'Recursion maps poorly to GPU execution model without stack-flattening.',
  },
];

// ── Regex Pattern Registry ────────────────────────────────────
// Python regexes
const PY_REGEXES = {
  large_for_loop:   [
    /for\s+\w+\s+in\s+range\s*\(\s*(\d{6,})/,
    /for\s+\w+\s+in\s+range\s*\(\s*\w+\s*,\s*(\d{6,})/,
    /for\s+\w+\s+in\s+range\s*\(\s*(\d+)\s*\*\s*(\d+)/,
    /np\.(zeros|ones|empty|linspace|arange)\s*\(\s*\d{5,}/,
    /\.reshape\s*\(.*\d{5,}/,
  ],
  nested_loop:      [/for\s+\w+[\s\S]{0,60}for\s+\w+/],
  matrix_operation: [/np\.(dot|matmul|linalg|cross|tensordot|kron)|@\s*\w|matrix_multiply|gemm/i],
  elementwise_mul:  [/\*=|np\.(multiply|add|subtract|divide)\s*\(|element.?wise/i],
  image_processing: [/cv2\.|PIL\.|skimage\.|Image\.open|imread|imshow|pixel|rgb2gray|BGR2/i],
  reduction_op:     [/np\.(sum|max|min|mean|std|var|cumsum)\s*\(|reduce\s*\(/i],
  sort_op:          [/sorted\s*\(|\.sort\s*\(|np\.sort\s*\(|argsort/i],
  fft_pattern:      [/np\.fft\.|scipy\.fft\.|fftfreq|rfft|ifft/i],
  nn_pattern:       [/torch\.|tensorflow\.|keras\.|Dense\s*\(|Conv2D|lstm|nn\.Module/i],
  data_transfer:    [/ctypes|mmap|memcpy|np\.frombuffer|np\.copy\s*\(/i],
  branch_heavy:     [/if\s+.*else.*if\s+.*else.*if|elif.*elif.*elif/],
  recursion:        [/def\s+(\w+)[\s\S]{0,400}\1\s*\(/],
};

// C++ regexes
const CPP_REGEXES = {
  large_for_loop:   [
    /for\s*\(.*?[<>]\s*(\d{6,})/,
    /for\s*\(.*?;\s*\w+\s*[<>]\s*n\s*;/,
    /std::vector.*\{\s*\d{5,}/,
  ],
  nested_loop:      [/for\s*\([\s\S]{0,80}for\s*\(/],
  matrix_operation: [/cblas_|BLAS_|#include\s*[<"]cblas|mkl_|__global__|cudaMalloc|hipMalloc|gemm/i],
  elementwise_mul:  [/\*=\s*\w|simd|__m256|_mm256_|vfmadd|std::transform/i],
  image_processing: [/#include.*opencv|Mat\s+\w+|imread|imshow|IplImage|cvtColor/i],
  reduction_op:     [/std::accumulate|std::reduce|std::partial_sum|tbb::parallel_reduce/i],
  sort_op:          [/std::sort\s*\(|std::stable_sort|std::nth_element|tbb::parallel_sort/i],
  fft_pattern:      [/fftw_plan|fftw_execute|#include.*fftw|rocfft|cufft/i],
  nn_pattern:       [/#include.*dnn|onnxruntime|MIOpen|cudnn|at::Tensor|torch::Tensor/i],
  data_transfer:    [/memcpy\s*\(|memmove\s*\(|hipMemcpy|cudaMemcpy/i],
  branch_heavy:     [/if\s*\([^)]+\)\s*\{[\s\S]{0,20}\}\s*else\s*if[\s\S]{0,20}else\s*if/],
  recursion:        [],  // handled by function self-reference check
};

// ─────────────────────────────────────────────────────────────
// Main Analysis Function
// ─────────────────────────────────────────────────────────────
/**
 * @param {string} code     — Raw source code
 * @param {string} lang     — 'python' | 'cpp'
 * @returns {AnalysisResult}
 */
export function analyzeCode(code, lang) {
  const regexMap = lang === 'python' ? PY_REGEXES : CPP_REGEXES;
  const log      = [];
  const detected = [];

  log.push({ type: 'info', msg: `Language: ${lang === 'python' ? 'Python' : 'C++'}` });
  log.push({ type: 'info', msg: `Source size: ${code.length} chars, ${code.split('\n').length} lines` });

  // ── 1. Run pattern detection ──
  for (const pattern of PATTERNS) {
    const regexes = regexMap[pattern.id];
    if (!regexes) continue;

    const matched = regexes.some(rx => rx.test(code));
    if (matched) {
      detected.push(pattern);
      log.push({
        type: 'step',
        msg:  `Pattern detected: "${pattern.label}" [weight ${pattern.weight > 0 ? '+' : ''}${pattern.weight}]`,
      });
    }
  }

  // ── Extra: C++ recursion via name tracking ──
  if (lang === 'cpp') {
    const fnMatch = code.match(/\b(\w+)\s*\([^)]*\)\s*\{[\s\S]{0,800}\1\s*\(/);
    if (fnMatch) {
      const rec = PATTERNS.find(p => p.id === 'recursion');
      if (rec && !detected.includes(rec)) {
        detected.push(rec);
        log.push({ type: 'warn', msg: 'Recursive function detected — GPU offload limited.' });
      }
    }
  }

  if (detected.length === 0) {
    log.push({ type: 'warn', msg: 'No significant parallelism patterns found in submitted code.' });
  }

  // ── 2. Compute parallelism score ──
  const rawScore = detected.reduce((sum, p) => sum + p.weight, 0);
  const parallelismScore = Math.max(0, Math.min(10, parseFloat(rawScore.toFixed(1))));

  log.push({ type: 'step', msg: `Raw score sum: ${rawScore.toFixed(2)} → clamped score: ${parallelismScore}` });

  // ── 3. Estimate complexity factor from patterns ──
  const loopDepth = detected.some(p => p.id === 'nested_loop') ? 2 : 1;
  const loopSize  = extractLoopSize(code, lang);
  const opWeight  = Math.max(0.5, parallelismScore / 10);

  // CPU time estimate (ms)
  const cpuTimeFactor  = (loopSize / 1e5) * loopDepth * opWeight;
  const cpuTimeMs      = Math.max(1, HW.BASE_CPU_TIME_MS * cpuTimeFactor);

  log.push({
    type: 'info',
    msg:  `Loop size estimate: ~${loopSize.toLocaleString()} · Depth: ${loopDepth} · Op weight: ${opWeight.toFixed(2)}`,
  });
  log.push({ type: 'info', msg: `CPU time estimate: ${formatTime(cpuTimeMs)}` });

  // ── 4. GPU time estimate ──
  const parallelFactor = Math.min(HW.GPU_THREADS / HW.CPU_CORES, loopSize / HW.CPU_CORES);
  const effectiveFactor = Math.max(1, parallelFactor * HW.EFFICIENCY_FACTOR);
  const xferOverheadMs  = cpuTimeMs * HW.TRANSFER_OVERHEAD;
  const gpuTimeMs       = (cpuTimeMs / effectiveFactor) + xferOverheadMs;

  log.push({ type: 'step', msg: `Parallel factor: ${parallelFactor.toFixed(1)} × efficiency ${HW.EFFICIENCY_FACTOR} = ${effectiveFactor.toFixed(1)}` });
  log.push({ type: 'info', msg: `Transfer overhead: ${formatTime(xferOverheadMs)} (12%)` });
  log.push({ type: 'step', msg: `GPU time estimate: ${formatTime(gpuTimeMs)}` });

  // ── 5. Derived metrics ──
  const speedup   = Math.max(1, parseFloat((cpuTimeMs / gpuTimeMs).toFixed(2)));
  const ppwGain   = parseFloat((speedup * (HW.CPU_TDP_W / HW.GPU_TDP_W)).toFixed(2));

  log.push({ type: 'step', msg: `Speedup: ${speedup}× · Perf-per-watt gain: ${ppwGain}×` });

  // ── 6. Suitability label ──
  const suitability = getSuitability(parallelismScore);

  // ── 7. AMD recommendations ──
  const amdRecs = buildAmdRecs(detected, parallelismScore);

  return {
    parallelismScore,
    suitability,
    detectedPatterns: detected,
    cpuTimeMs,
    gpuTimeMs,
    speedup,
    ppwGain,
    xferOverheadMs,
    amdRecs,
    log,
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function extractLoopSize(code, lang) {
  // Try to pull the largest numeric literal that looks like an iteration bound
  const numbers = [];
  const rx = /\b(\d{4,})\b/g;
  let m;
  while ((m = rx.exec(code)) !== null) {
    numbers.push(parseInt(m[1], 10));
  }
  if (numbers.length === 0) return 1e4; // default fallback
  return Math.min(Math.max(...numbers), 1e9); // cap at 1B to avoid absurd estimates
}

function formatTime(ms) {
  if (ms < 1)      return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000)   return `${ms.toFixed(1)} ms`;
  if (ms < 60000)  return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60000).toFixed(2)} min`;
}

function getSuitability(score) {
  if (score >= 7)  return { label: 'Highly Recommended',   level: 'high'   };
  if (score >= 4)  return { label: 'Moderately Beneficial', level: 'medium' };
  if (score >= 1)  return { label: 'Low Expected Benefit',  level: 'low'    };
  return                   { label: 'Not Recommended',      level: 'none'   };
}

function buildAmdRecs(detected, score) {
  const recs = [];

  const highPatterns = detected.filter(p => p.level === 'high');

  if (score >= 4) {
    recs.push({
      tag:   'ROCm',
      title: 'AMD ROCm Open Compute Platform',
      desc:  'ROCm provides a complete GPU compute stack (driver, runtime, math libraries). ' +
             'Deploy directly on AMD Radeon / Instinct GPUs with no vendor lock-in.',
    });
    recs.push({
      tag:   'HIP',
      title: 'HIP Parallel Programming Model',
      desc:  'HIP is a C++ runtime API for GPU programming compatible with AMD and NVIDIA. ' +
             'Refactor your compute loops to hip<<<grid, block>>>() kernel launches.',
    });
  }

  if (highPatterns.some(p => p.id === 'matrix_operation' || p.id === 'nn_pattern')) {
    recs.push({
      tag:   'rocBLAS',
      title: 'rocBLAS / MIOpen Acceleration',
      desc:  'Matrix and tensor operations should use rocBLAS (GEMM) or MIOpen (DNN layers) ' +
             'for peak throughput on AMD hardware.',
    });
  }

  if (highPatterns.some(p => p.id === 'image_processing')) {
    recs.push({
      tag:   'OpenCL',
      title: 'OpenCL Image Processing Pipeline',
      desc:  'Pixel-level operations can be expressed as OpenCL kernels using cl::Image2D ' +
             'objects, allowing fine-grained control over tile access patterns.',
    });
  }

  if (detected.some(p => p.id === 'fft_pattern')) {
    recs.push({
      tag:   'rocFFT',
      title: 'rocFFT — AMD Optimised FFT Library',
      desc:  'Drop-in replacement for FFTW on AMD GPUs. Supports 1D/2D/3D transforms, ' +
             'real-to-complex, and batch execution.',
    });
  }

  if (score < 2) {
    recs.push({
      tag:   'NOTE',
      title: 'Low Parallelism — CPU Preferable',
      desc:  'The detected workload has insufficient parallelism to benefit from GPU offload. ' +
             'Focus on CPU-level optimisations: vectorisation (AVX2), cache locality, OpenMP.',
    });
  }

  return recs;
}

// ─────────────────────────────────────────────────────────────
// Sample Code Snippets
// ─────────────────────────────────────────────────────────────
export const SAMPLES = {
  python: `import numpy as np

# Matrix multiplication benchmark
# Typical in ML training loops

N = 1024  # matrix dimension
iterations = 500000

# Initialize matrices
A = np.random.randn(N, N).astype(np.float32)
B = np.random.randn(N, N).astype(np.float32)

results = []

for i in range(iterations):
    # Element-wise multiply then matrix dot
    C = np.multiply(A, B)
    D = np.dot(C, A)
    
    # Reduction operations
    row_sums = np.sum(D, axis=1)
    results.append(np.mean(row_sums))

# Image processing pass
import cv2
img = cv2.imread('input.png')
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

for y in range(img.shape[0]):
    for x in range(img.shape[1]):
        img[y, x] = img[y, x] * 0.8 + gray[y, x] * 0.2

print(f"Done. Mean result: {np.mean(results):.4f}")
`,

  cpp: `#include <vector>
#include <numeric>
#include <algorithm>
#include <cmath>

// Parallel matrix-vector multiplication kernel
// Candidate for GPU offloading via HIP

void matmul(const std::vector<float>& A,
            const std::vector<float>& B,
                  std::vector<float>& C,
            int N) {
    for (int i = 0; i < N; ++i) {
        for (int j = 0; j < N; ++j) {
            float acc = 0.0f;
            for (int k = 0; k < N; ++k) {
                acc += A[i * N + k] * B[k * N + j];
            }
            C[i * N + j] = acc;
        }
    }
}

int main() {
    const int N = 4096;
    std::vector<float> A(N * N, 1.0f);
    std::vector<float> B(N * N, 0.5f);
    std::vector<float> C(N * N, 0.0f);

    // Run 10 iterations
    for (int iter = 0; iter < 10; ++iter) {
        matmul(A, B, C, N);
    }

    // Reduction: total sum
    float total = std::accumulate(C.begin(), C.end(), 0.0f);

    // Sort result vector for quantile extraction
    std::sort(C.begin(), C.end());

    return 0;
}
`,
};
