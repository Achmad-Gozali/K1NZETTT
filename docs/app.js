// ============================================================
// K1NZETTT — frontend logic
// Alur: trigger workflow via Worker -> polling status run ->
// fetch results/latest.json asli dari GitHub -> render hasil.
// ============================================================

const WORKER_URL = "https://k1nzettproxy.achmadgozali.workers.dev";
const REPO_OWNER = "Achmad-Gozali";
const REPO_NAME = "K1NZETTT";
const REPO_BRANCH = "main";
const RESULTS_RAW_URL =
  `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/results/latest.json`;

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 menit, samain dengan timeout job di loadtest.yml

// ---- elements ----
const form = document.getElementById('test-form');
const urlInput = document.getElementById('target-url');
const urlError = document.getElementById('url-error');
const userCount = document.getElementById('user-count');
const duration = document.getElementById('duration');
const submitBtn = document.getElementById('submit-btn');
const triggerError = document.getElementById('trigger-error');

const formCard = document.getElementById('form-card');
const runningCard = document.getElementById('running-card');
const resultsSection = document.getElementById('results');
const resetBtn = document.getElementById('reset-btn');

const progressBar = document.getElementById('progress-bar');
const runningTitle = document.getElementById('running-title');
const runningDetail = document.getElementById('running-detail');
const runningPct = document.getElementById('running-pct');
const runningTarget = document.getElementById('running-target');
const runningLogLink = document.getElementById('running-log-link');

const resultTarget = document.getElementById('result-target');
const resultMeta = document.getElementById('result-meta');
const chartCard = document.getElementById('chart-card');

let chartInstance = null;
let pollTimer = null;

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

function normalizeHostsInput(raw) {
  // Dukung multi-host dipisah koma, masing-masing dinormalisasi.
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const normalized = [];
  for (const part of parts) {
    const n = normalizeUrl(part);
    if (!n) return null;
    normalized.push(n);
  }
  return normalized;
}

// ---- form submit ----
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const hosts = normalizeHostsInput(urlInput.value);

  if (!hosts) {
    urlError.classList.remove('hidden');
    urlInput.classList.add('focus:ring-signal-stop/30');
    urlInput.focus();
    return;
  }
  urlError.classList.add('hidden');
  triggerError.classList.add('hidden');

  const users = Math.max(1, parseInt(userCount.value, 10) || 20);
  const dur = Math.max(1, parseInt(duration.value, 10) || 3);

  startRun(hosts, users, dur);
});

resetBtn.addEventListener('click', () => {
  if (pollTimer) clearTimeout(pollTimer);
  resultsSection.classList.add('hidden');
  formCard.classList.remove('hidden');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Mulai load test';
  urlInput.value = '';
  urlInput.focus();
});

// ---- run flow ----
async function startRun(hosts, users, dur) {
  formCard.classList.add('hidden');
  runningCard.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  runningLogLink.classList.add('hidden');

  const targetLabel = hosts.join(', ');
  runningTarget.textContent = `${targetLabel} · ${users} user · ${dur} menit`;
  setRunningStage('trigger');

  try {
    const res = await fetch(`${WORKER_URL}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_hosts: hosts.join(','),
        users,
        duration_minutes: dur,
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Gagal trigger (status ${res.status})`);
    }

    setRunningStage('queued');
    pollStatus(targetLabel, users, dur);
  } catch (err) {
    showTriggerError(err.message || 'Gagal menghubungi Worker.');
  }
}

function showTriggerError(message) {
  runningCard.classList.add('hidden');
  formCard.classList.remove('hidden');
  triggerError.textContent = `Gagal memulai test: ${message}`;
  triggerError.classList.remove('hidden');
}

function setRunningStage(stage) {
  const stages = {
    trigger: { pct: 4, title: 'Mengirim trigger…', detail: 'Mengirim permintaan ke GitHub Actions lewat Worker.' },
    queued: { pct: 12, title: 'Menunggu antrean…', detail: 'Run sudah terdaftar, menunggu runner GitHub tersedia.' },
    in_progress: { pct: 55, title: 'Test sedang berjalan…', detail: 'Crawling endpoint dan menembak beban di GitHub Actions runner.' },
    completed: { pct: 100, title: 'Selesai.', detail: 'Mengambil hasil akhir…' },
  };
  const s = stages[stage] || stages.trigger;
  progressBar.style.width = s.pct + '%';
  runningPct.textContent = s.pct + '%';
  runningTitle.textContent = s.title;
  runningDetail.textContent = s.detail;
}

// ---- polling status ke Worker ----
function pollStatus(targetLabel, users, dur) {
  const startedAt = Date.now();

  async function tick() {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      showTriggerError('Timeout menunggu hasil. Cek langsung di GitHub Actions.');
      return;
    }

    try {
      const res = await fetch(`${WORKER_URL}/status`);
      const data = await res.json();

      if (data.state === 'found') {
        if (data.html_url) {
          runningLogLink.href = data.html_url;
          runningLogLink.classList.remove('hidden');
        }

        if (data.status === 'completed') {
          setRunningStage('completed');
          if (data.conclusion === 'success') {
            await fetchAndShowResults(targetLabel, users, dur);
          } else {
            showTriggerError(`Run selesai dengan status "${data.conclusion}". Cek log run untuk detail.`);
          }
          return; // stop polling
        }

        setRunningStage(data.status === 'queued' ? 'queued' : 'in_progress');
      }
    } catch (err) {
      // Kegagalan jaringan sesaat: jangan hentikan polling, coba lagi.
    }

    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  tick();
}

// ---- fetch hasil asli dari GitHub ----
async function fetchAndShowResults(targetLabel, users, dur) {
  try {
    const res = await fetch(`${RESULTS_RAW_URL}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`Gagal fetch hasil (status ${res.status})`);
    const data = await res.json();

    if (!data.generated_at) {
      throw new Error('results/latest.json belum berisi hasil test.');
    }

    showResults(data, targetLabel);
  } catch (err) {
    showTriggerError(err.message || 'Gagal mengambil hasil test.');
  }
}

function showResults(data, targetLabel) {
  runningCard.classList.add('hidden');
  resultsSection.classList.remove('hidden');

  resultTarget.textContent = data.target_hosts || targetLabel;
  const durText = data.duration_seconds ? `${Math.round(data.duration_seconds)}s` : '—';
  resultMeta.textContent =
    `${durText} · ${data.endpoints_tested ?? 0} endpoint diuji` +
    (data.endpoints_skipped ? ` · ${data.endpoints_skipped} di-skip` : '');

  renderStats(data);
  renderBreakdown(data);
  renderTimelineChart(data);
}

function renderStats(data) {
  document.getElementById('stat-total').textContent =
    (data.total_requests ?? 0).toLocaleString('id-ID');
  document.getElementById('stat-success').textContent =
    (data.total_success ?? 0).toLocaleString('id-ID');
  document.getElementById('stat-failed').textContent =
    (data.total_failures ?? 0).toLocaleString('id-ID');
  document.getElementById('stat-avg').textContent =
    (data.avg_response_ms ?? 0) + 'ms';
}

// ---- chart: animasikan timeline snapshot dari locustfile.py ----
function renderTimelineChart(data) {
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  const ctx = document.getElementById('response-chart');

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  if (timeline.length < 2) {
    // Test terlalu singkat untuk punya snapshot berarti — sembunyikan chart
    // daripada menampilkan grafik kosong/menyesatkan.
    chartCard.classList.add('hidden');
    return;
  }

  chartCard.classList.remove('hidden');

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: timeline.map(p => `${Math.round(p.t)}s`),
      datasets: [
        {
          label: 'Response time (ms)',
          data: [],
          borderColor: '#0D9488',
          backgroundColor: 'rgba(13,148,136,0.08)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          yAxisID: 'y',
          pointRadius: 0,
        },
        {
          label: 'RPS',
          data: [],
          borderColor: '#D97706',
          borderWidth: 2,
          borderDash: [4, 3],
          tension: 0.3,
          fill: false,
          yAxisID: 'y1',
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false, // animasi dikendalikan manual lewat progressive reveal di bawah
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { family: 'JetBrains Mono', size: 11 }, color: '#6B7280', usePointStyle: true, boxWidth: 6 },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#9CA3AF' } },
        y: {
          position: 'left',
          grid: { color: '#F3F4F6' },
          ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#9CA3AF' },
          title: { display: true, text: 'ms', font: { family: 'JetBrains Mono', size: 10 }, color: '#9CA3AF' },
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#9CA3AF' },
          title: { display: true, text: 'req/s', font: { family: 'JetBrains Mono', size: 10 }, color: '#9CA3AF' },
        },
      },
    },
  });

  // Progressive reveal: data asli (bukan animasi palsu), cuma ditampilkan
  // bertahap titik demi titik biar chart terasa "membangun diri" saat
  // hasil pertama kali muncul di layar.
  let i = 0;
  const revealStep = () => {
    if (i >= timeline.length) return;
    chartInstance.data.datasets[0].data.push(Math.round(timeline[i].avg_response_ms));
    chartInstance.data.datasets[1].data.push(timeline[i].rps);
    chartInstance.update('none');
    i++;
    setTimeout(revealStep, 90);
  };
  revealStep();
}

const EVENT_STYLES = {
  SUCCESS: 'bg-signal-goBg text-signal-go',
  AUTH_EXPIRED: 'bg-signal-warnBg text-signal-warn',
  EDGE_LIMIT: 'bg-signal-warnBg text-signal-warn',
  APP_LIMIT: 'bg-signal-warnBg text-signal-warn',
  SERVER_DOWN: 'bg-signal-stopBg text-signal-stop',
  EDGE_DOWN: 'bg-signal-stopBg text-signal-stop',
  SERVER_ERROR: 'bg-signal-stopBg text-signal-stop',
  EDGE_ERROR: 'bg-signal-stopBg text-signal-stop',
  NOT_FOUND: 'bg-ink-100 text-ink-700',
  SOFT_BLOCKED: 'bg-signal-stopBg text-signal-stop',
  VALIDATION_ERROR: 'bg-signal-warnBg text-signal-warn',
  METHOD_ERROR: 'bg-signal-warnBg text-signal-warn',
  CONN_ERROR: 'bg-signal-stopBg text-signal-stop',
  DEFAULT: 'bg-ink-100 text-ink-700',
};

function renderBreakdown(data) {
  const tbody = document.getElementById('breakdown-body');
  tbody.innerHTML = '';

  const breakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
  const sorted = [...breakdown].sort((a, b) => b.count - a.count);

  for (const row of sorted) {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-ink-100/40 transition-colors';
    const badgeClass = EVENT_STYLES[row.event_type] || EVENT_STYLES.DEFAULT;

    tr.innerHTML = `
      <td class="px-6 py-3">
        <span class="inline-block px-2 py-1 rounded-md text-[11px] font-semibold font-mono ${badgeClass}">${row.event_type}</span>
      </td>
      <td class="px-6 py-3 text-ink-500 font-mono text-xs truncate max-w-[220px]">${row.endpoint}</td>
      <td class="px-6 py-3 text-right font-mono">${row.count.toLocaleString('id-ID')}</td>
      <td class="px-6 py-3 text-right font-mono text-ink-500">${row.avg_ms}</td>
    `;
    tbody.appendChild(tr);
  }
}