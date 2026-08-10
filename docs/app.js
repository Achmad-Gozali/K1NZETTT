// ============================================================
// matchastress — frontend logic
// NOTE: Bagian "runTest()" saat ini pakai simulasi (mock).
// Nanti diganti manggil Cloudflare Worker -> GitHub Actions
// yang menjalankan locustfile.py beneran, lalu fetch hasil JSON-nya.
// ============================================================

const form = document.getElementById('test-form');
const urlInput = document.getElementById('target-url');
const urlError = document.getElementById('url-error');
const userCount = document.getElementById('user-count');
const duration = document.getElementById('duration');
const submitBtn = document.getElementById('submit-btn');

const formCard = document.getElementById('form-card');
const runningCard = document.getElementById('running-card');
const resultsSection = document.getElementById('results');
const resetBtn = document.getElementById('reset-btn');

const progressBar = document.getElementById('progress-bar');
const bowlFill = document.getElementById('bowl-fill');
const runningTitle = document.getElementById('running-title');
const runningDetail = document.getElementById('running-detail');
const runningPct = document.getElementById('running-pct');
const runningTarget = document.getElementById('running-target');

let chartInstance = null;

// ---- basic url validation ----
function normalizeUrl(raw) {
  let v = raw.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    return u.href;
  } catch {
    return null;
  }
}

// ---- form submit ----
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const target = normalizeUrl(urlInput.value);

  if (!target) {
    urlError.classList.remove('hidden');
    urlInput.classList.add('border-clay-500');
    urlInput.focus();
    return;
  }
  urlError.classList.add('hidden');
  urlInput.classList.remove('border-clay-500');

  const users = Math.max(1, parseInt(userCount.value, 10) || 20);
  const dur = Math.max(1, parseInt(duration.value, 10) || 3);

  startRun(target, users, dur);
});

resetBtn.addEventListener('click', () => {
  resultsSection.classList.add('hidden');
  formCard.classList.remove('hidden');
  urlInput.value = '';
  urlInput.focus();
});

// ---- run flow ----
function startRun(target, users, dur) {
  formCard.classList.add('hidden');
  runningCard.classList.remove('hidden');
  resultsSection.classList.add('hidden');

  runningTarget.textContent = `${target} · ${users} user · ${dur} menit`;

  const stages = [
    { pct: 15, title: 'Meracik endpoint…', detail: 'Playwright sedang menjelajahi target untuk menemukan endpoint aktif.' },
    { pct: 45, title: 'Memvalidasi method…', detail: 'Setiap endpoint di-dry-run dulu biar nggak ada false-positive 405.' },
    { pct: 65, title: 'Menyeduh beban…', detail: `Locust menembak endpoint dengan ${users} simulasi user.` },
    { pct: 90, title: 'Menyaring hasil…', detail: 'Mengelompokkan response ke kategori event masing-masing.' },
    { pct: 100, title: 'Selesai diseduh.', detail: 'Hasil siap ditampilkan.' },
  ];

  let i = 0;
  runStage();

  function runStage() {
    if (i >= stages.length) {
      setTimeout(() => showResults(target, users, dur), 400);
      return;
    }
    const s = stages[i];
    progressBar.style.width = s.pct + '%';
    bowlFill.style.setProperty('--fill', s.pct + '%');
    bowlFill.style.height = s.pct + '%';
    runningPct.textContent = s.pct + '%';
    runningTitle.textContent = s.title;
    runningDetail.textContent = s.detail;
    i++;
    const stepDelay = 900 + Math.random() * 700;
    setTimeout(runStage, stepDelay);
  }
}

// ---- mock result generator (replace with real fetch later) ----
function generateMockResult(target, users, dur) {
  const totalRequests = users * dur * (8 + Math.floor(Math.random() * 6));
  const failRate = 0.04 + Math.random() * 0.1;
  const failed = Math.floor(totalRequests * failRate);
  const success = totalRequests - failed;

  const eventPool = [
    { type: 'SUCCESS', weight: success, endpoint: '/api/dashboard' },
    { type: 'AUTH_EXPIRED', weight: Math.floor(failed * 0.25), endpoint: '/api/user/profile' },
    { type: 'EDGE_LIMIT', weight: Math.floor(failed * 0.2), endpoint: '/api/transaksi' },
    { type: 'SERVER_DOWN', weight: Math.floor(failed * 0.15), endpoint: '/api/report/export' },
    { type: 'NOT_FOUND', weight: Math.floor(failed * 0.15), endpoint: '/api/legacy/status' },
    { type: 'SOFT_BLOCKED', weight: Math.floor(failed * 0.1), endpoint: '/api/verify' },
    { type: 'VALIDATION_ERROR', weight: Math.floor(failed * 0.15), endpoint: '/api/transaksi/create' },
  ];

  const breakdown = eventPool
    .filter(e => e.weight > 0)
    .map(e => ({
      type: e.type,
      endpoint: e.endpoint,
      count: e.weight,
      avgMs: Math.floor(80 + Math.random() * 900),
    }));

  const avgResponse = Math.floor(
    breakdown.reduce((sum, b) => sum + b.avgMs * b.count, 0) / totalRequests
  );

  // time series buat chart
  const points = 12;
  const series = Array.from({ length: points }, (_, idx) => ({
    t: idx,
    responseTime: Math.max(50, avgResponse + (Math.random() - 0.5) * avgResponse * 0.6),
    rps: Math.max(1, Math.floor((totalRequests / points) * (0.7 + Math.random() * 0.6))),
  }));

  return {
    target, users, dur,
    total: totalRequests,
    success, failed,
    avgResponse,
    breakdown,
    series,
  };
}

function showResults(target, users, dur) {
  runningCard.classList.add('hidden');
  resultsSection.classList.remove('hidden');

  const data = generateMockResult(target, users, dur);
  renderStats(data);
  renderChart(data);
  renderBreakdown(data);
}

function renderStats(data) {
  document.getElementById('stat-total').textContent = data.total.toLocaleString('id-ID');
  document.getElementById('stat-success').textContent = data.success.toLocaleString('id-ID');
  document.getElementById('stat-failed').textContent = data.failed.toLocaleString('id-ID');
  document.getElementById('stat-avg').textContent = data.avgResponse + 'ms';
}

function renderChart(data) {
  const ctx = document.getElementById('response-chart');
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.series.map(p => `${p.t}s`),
      datasets: [
        {
          label: 'Response time (ms)',
          data: data.series.map(p => Math.round(p.responseTime)),
          borderColor: '#5F6E47',
          backgroundColor: 'rgba(122,139,92,0.1)',
          borderWidth: 2,
          tension: 0.35,
          fill: true,
          yAxisID: 'y',
          pointRadius: 0,
        },
        {
          label: 'RPS',
          data: data.series.map(p => p.rps),
          borderColor: '#B5533C',
          borderWidth: 2,
          borderDash: [4, 3],
          tension: 0.35,
          fill: false,
          yAxisID: 'y1',
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { family: 'Space Mono', size: 11 }, color: '#5F6E47', usePointStyle: true, boxWidth: 6 },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Space Mono', size: 10 }, color: '#96A66E' } },
        y: {
          position: 'left',
          grid: { color: '#EFF2E6' },
          ticks: { font: { family: 'Space Mono', size: 10 }, color: '#96A66E' },
          title: { display: true, text: 'ms', font: { family: 'Space Mono', size: 10 }, color: '#96A66E' },
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: { font: { family: 'Space Mono', size: 10 }, color: '#96A66E' },
          title: { display: true, text: 'req/s', font: { family: 'Space Mono', size: 10 }, color: '#96A66E' },
        },
      },
    },
  });
}

const EVENT_STYLES = {
  SUCCESS: 'bg-matcha-100 text-matcha-700',
  AUTH_EXPIRED: 'bg-amber-100 text-amber-700',
  EDGE_LIMIT: 'bg-amber-100 text-amber-700',
  APP_LIMIT: 'bg-amber-100 text-amber-700',
  SERVER_DOWN: 'bg-clay-500/10 text-clay-600',
  EDGE_DOWN: 'bg-clay-500/10 text-clay-600',
  NOT_FOUND: 'bg-matcha-200 text-matcha-700',
  SOFT_BLOCKED: 'bg-clay-500/10 text-clay-600',
  VALIDATION_ERROR: 'bg-amber-100 text-amber-700',
  METHOD_ERROR: 'bg-amber-100 text-amber-700',
  DEFAULT: 'bg-matcha-100 text-matcha-700',
};

function renderBreakdown(data) {
  const tbody = document.getElementById('breakdown-body');
  tbody.innerHTML = '';

  const sorted = [...data.breakdown].sort((a, b) => b.count - a.count);

  for (const row of sorted) {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-matcha-50/60 transition-colors';
    const badgeClass = EVENT_STYLES[row.type] || EVENT_STYLES.DEFAULT;

    tr.innerHTML = `
      <td class="px-6 py-3">
        <span class="inline-block px-2 py-1 rounded-md text-[11px] font-semibold ${badgeClass}">${row.type}</span>
      </td>
      <td class="px-6 py-3 text-matcha-600">${row.endpoint}</td>
      <td class="px-6 py-3 text-right text-matcha-800">${row.count.toLocaleString('id-ID')}</td>
      <td class="px-6 py-3 text-right text-matcha-500">${row.avgMs}</td>
    `;
    tbody.appendChild(tr);
  }
}
