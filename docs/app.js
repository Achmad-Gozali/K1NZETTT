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
// Unlimited run tidak boleh kena timeout polling frontend — job GitHub
// sendiri yang jadi batas atas (lihat timeout-minutes di loadtest.yml).
const POLL_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 jam

// ---- elements ----
const form = document.getElementById('test-form');
const urlInput = document.getElementById('target-url');
const urlError = document.getElementById('url-error');
const userCount = document.getElementById('user-count');
const spawnRate = document.getElementById('spawn-rate');
const duration = document.getElementById('duration');
const durationUnlimited = document.getElementById('duration-unlimited');
const submitBtn = document.getElementById('submit-btn');
const triggerError = document.getElementById('trigger-error');

// status bar (ala Locust: Host / Status / RPS / Failures)
const statusHost = document.getElementById('status-host');
const statusState = document.getElementById('status-state');
const statusRps = document.getElementById('status-rps');
const statusFailures = document.getElementById('status-failures');

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
const stopBtn = document.getElementById('stop-btn');
const stopMessage = document.getElementById('stop-message');

const resultTarget = document.getElementById('result-target');
const resultMeta = document.getElementById('result-meta');
const resultGeneratedAt = document.getElementById('result-generated-at');
const chartCard = document.getElementById('chart-card');
const statusChipsCard = document.getElementById('status-chips-card');
const statusChipsWrap = document.getElementById('status-chips');
const breakdownFilter = document.getElementById('breakdown-filter');

let chartInstance = null;
let pollTimer = null;
let lastBreakdownRows = []; // dipakai ulang saat filter berubah
let currentRunId = null; // dipakai tombol STOP, diisi dari response /status
let isUnlimitedRun = false; // dipakai buat teks progress saat run tanpa batas waktu

// ---- toggle input durasi saat "unlimited" dicentang ----
durationUnlimited.addEventListener('change', () => {
  duration.disabled = durationUnlimited.checked;
});

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
  const rate = Math.max(1, parseInt(spawnRate.value, 10) || 5);
  const dur = durationUnlimited.checked ? 0 : Math.max(1, parseInt(duration.value, 10) || 3);

  startRun(hosts, users, rate, dur);
});

resetBtn.addEventListener('click', () => {
  if (pollTimer) clearTimeout(pollTimer);
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  lastBreakdownRows = [];
  currentRunId = null;
  isUnlimitedRun = false;
  stopMessage.classList.add('hidden');
  stopBtn.disabled = false;
  stopBtn.textContent = 'STOP';
  resultsSection.classList.add('hidden');
  formCard.classList.remove('hidden');
  submitBtn.disabled = false;
  submitBtn.textContent = 'START';
  urlInput.value = '';
  urlInput.focus();
  setStatusBar({ host: '—', state: 'IDLE', rps: '—', failures: '—' });
});

// ---- stop run ----
stopBtn.addEventListener('click', async () => {
  if (!currentRunId) {
    stopMessage.textContent = 'Belum ada run yang bisa dihentikan.';
    stopMessage.classList.remove('hidden');
    return;
  }

  stopBtn.disabled = true;
  stopBtn.textContent = 'Menghentikan…';
  stopMessage.classList.add('hidden');

  try {
    const res = await fetch(`${WORKER_URL}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: currentRunId }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Gagal menghentikan (status ${res.status})`);
    }

    stopMessage.textContent = 'Permintaan stop terkirim, menunggu runner berhenti…';
    stopMessage.classList.remove('hidden');
    setStatusBar({ state: 'STOPPING' });
    // polling yang sudah berjalan akan otomatis menangkap status "completed/cancelled"
  } catch (err) {
    stopMessage.textContent = err.message || 'Gagal menghentikan run.';
    stopMessage.classList.remove('hidden');
    stopBtn.disabled = false;
    stopBtn.textContent = 'STOP';
  }
});

// ---- status bar helper ----
function setStatusBar({ host, state, rps, failures }) {
  if (host !== undefined) statusHost.textContent = host;
  if (state !== undefined) {
    statusState.textContent = state;
    statusState.className = 'text-xs font-mono font-semibold ' + stateColorClass(state);
  }
  if (rps !== undefined) statusRps.textContent = rps;
  if (failures !== undefined) statusFailures.textContent = failures;
}

function stateColorClass(state) {
  switch (state) {
    case 'RUNNING': return 'text-signal-go';
    case 'QUEUED': return 'text-signal-warn';
    case 'DONE': return 'text-signal-go';
    case 'FAILED': return 'text-signal-stop';
    case 'STOPPING': return 'text-signal-warn';
    case 'STOPPED': return 'text-signal-stop';
    default: return 'text-ink-500';
  }
}

// ---- run flow ----
async function startRun(hosts, users, rate, dur) {
  formCard.classList.add('hidden');
  runningCard.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  runningLogLink.classList.add('hidden');

  isUnlimitedRun = dur === 0;
  const targetLabel = hosts.join(', ');
  const durLabel = isUnlimitedRun ? 'unlimited' : `${dur} menit`;
  runningTarget.textContent = `${targetLabel} · ${users} user · ramp ${rate}/s · ${durLabel}`;
  setRunningStage('trigger');
  setStatusBar({ host: targetLabel, state: 'QUEUED', rps: '—', failures: '—' });
  currentRunId = null;
  stopBtn.disabled = false;
  stopBtn.textContent = 'STOP';
  stopMessage.classList.add('hidden');

  try {
    const res = await fetch(`${WORKER_URL}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_hosts: hosts.join(','),
        users,
        spawn_rate: rate,
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
    setStatusBar({ state: 'FAILED' });
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
    in_progress: {
      pct: isUnlimitedRun ? 55 : 55,
      title: 'Test sedang berjalan…',
      detail: isUnlimitedRun
        ? 'Crawling endpoint dan menembak beban tanpa batas waktu. Tekan STOP untuk menghentikan.'
        : 'Crawling endpoint dan menembak beban di GitHub Actions runner.',
    },
    completed: { pct: 100, title: 'Selesai.', detail: 'Mengambil hasil akhir…' },
  };
  const s = stages[stage] || stages.trigger;
  progressBar.style.width = s.pct + '%';
  runningPct.textContent = isUnlimitedRun && stage === 'in_progress' ? '—' : s.pct + '%';
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
        currentRunId = data.run_id;

        if (data.html_url) {
          runningLogLink.href = data.html_url;
          runningLogLink.classList.remove('hidden');
        }

        if (data.status === 'completed') {
          setRunningStage('completed');
          if (data.conclusion === 'success') {
            setStatusBar({ state: 'DONE' });
            await fetchAndShowResults(targetLabel, users, dur);
          } else if (data.conclusion === 'cancelled') {
            // Run dihentikan lewat STOP: locustfile.py tetap menulis hasil
            // parsial lewat signal handler, jadi tetap coba tampilkan hasil
            // daripada langsung dianggap gagal.
            setStatusBar({ state: 'STOPPED' });
            await fetchAndShowResults(targetLabel, users, dur, { stopped: true });
          } else {
            setStatusBar({ state: 'FAILED' });
            showTriggerError(`Run selesai dengan status "${data.conclusion}". Cek log run untuk detail.`);
          }
          return; // stop polling
        }

        const stage = data.status === 'queued' ? 'queued' : 'in_progress';
        setRunningStage(stage);
        setStatusBar({ state: stage === 'queued' ? 'QUEUED' : 'RUNNING' });
      }
    } catch (err) {
      // Kegagalan jaringan sesaat: jangan hentikan polling, coba lagi.
    }

    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  tick();
}

// ---- fetch hasil asli dari GitHub ----
async function fetchAndShowResults(targetLabel, users, dur, { stopped = false } = {}) {
  try {
    const res = await fetch(`${RESULTS_RAW_URL}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`Gagal fetch hasil (status ${res.status})`);
    const data = await res.json();

    if (!data.generated_at) {
      throw new Error('results/latest.json belum berisi hasil test.');
    }

    showResults(data, targetLabel, { stopped });
  } catch (err) {
    if (stopped) {
      // Run di-stop tapi hasil belum sempat ke-commit (mis. signal handler
      // sempat menulis file tapi commit step belum jalan). Beri tahu jelas
      // daripada menampilkan pesan generik "gagal trigger".
      showTriggerError(
        'Test dihentikan, tapi hasil belum sempat tersimpan ke repo. ' +
        'Cek log run — hasil parsial biasanya tetap ada di artifact.'
      );
      return;
    }
    showTriggerError(err.message || 'Gagal mengambil hasil test.');
  }
}

function showResults(data, targetLabel, { stopped = false } = {}) {
  runningCard.classList.add('hidden');
  resultsSection.classList.remove('hidden');

  resultTarget.textContent = data.target_hosts || targetLabel;
  const durText = data.duration_seconds ? `${Math.round(data.duration_seconds)}s` : '—';
  const stoppedLabel = stopped ? ' · dihentikan manual' : '';
  resultMeta.textContent =
    `${durText} · ${data.endpoints_tested ?? 0} endpoint diuji` +
    (data.endpoints_skipped ? ` · ${data.endpoints_skipped} di-skip` : '') +
    stoppedLabel;

  resultGeneratedAt.textContent = formatGeneratedAt(data.generated_at);

  renderStats(data);
  renderStatusChips(data);
  renderBreakdown(data);
  renderTimelineChart(data);
}

function formatGeneratedAt(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return 'dijalankan ' + d.toLocaleString('id-ID', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) + ' WIB';
  } catch {
    return '';
  }
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
  document.getElementById('stat-endpoints-tested').textContent =
    (data.endpoints_tested ?? 0).toLocaleString('id-ID');
  document.getElementById('stat-endpoints-skipped').textContent =
    (data.endpoints_skipped ?? 0).toLocaleString('id-ID');
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
  RETRY: 'bg-signal-goBg text-signal-go',
  AUTH_EXPIRED: 'bg-signal-warnBg text-signal-warn',
  EDGE_LIMIT: 'bg-signal-warnBg text-signal-warn',
  APP_LIMIT: 'bg-signal-warnBg text-signal-warn',
  SERVER_DOWN: 'bg-signal-stopBg text-signal-stop',
  EDGE_DOWN: 'bg-signal-stopBg text-signal-stop',
  SERVER_ERROR: 'bg-signal-stopBg text-signal-stop',
  EDGE_ERROR: 'bg-signal-stopBg text-signal-stop',
  SERVER_TIMEOUT: 'bg-signal-warnBg text-signal-warn',
  EDGE_TIMEOUT: 'bg-signal-warnBg text-signal-warn',
  NOT_FOUND: 'bg-ink-100 text-ink-700',
  FORBIDDEN: 'bg-signal-stopBg text-signal-stop',
  WAF_BLOCKED: 'bg-signal-stopBg text-signal-stop',
  CONFLICT: 'bg-signal-warnBg text-signal-warn',
  BAD_REQUEST: 'bg-signal-warnBg text-signal-warn',
  LEGAL_BLOCKED: 'bg-ink-100 text-ink-700',
  SOFT_BLOCKED: 'bg-signal-stopBg text-signal-stop',
  VALIDATION_ERROR: 'bg-signal-warnBg text-signal-warn',
  METHOD_ERROR: 'bg-signal-warnBg text-signal-warn',
  CONN_ERROR: 'bg-signal-stopBg text-signal-stop',
  SSL_ERROR: 'bg-signal-stopBg text-signal-stop',
  CONN_TIMEOUT: 'bg-signal-warnBg text-signal-warn',
  CONN_RESET: 'bg-signal-stopBg text-signal-stop',
  CONN_REFUSED: 'bg-signal-stopBg text-signal-stop',
  DNS_ERROR: 'bg-signal-stopBg text-signal-stop',
  DEFAULT: 'bg-ink-100 text-ink-700',
};

function getBadgeClass(eventType) {
  if (EVENT_STYLES[eventType]) return EVENT_STYLES[eventType];
  if (eventType && eventType.startsWith('CLIENT_ERROR_')) return 'bg-signal-stopBg text-signal-stop';
  return EVENT_STYLES.DEFAULT;
}

// ---- parsing "name" string dari Locust jadi field terpisah ----
// Format asli dari locustfile.py, salah satu dari:
//   "host [status/origin]"            -> mis. "api.example.com [403/cloudflare]"
//   "host [status/origin @attempt N]" -> retry/transient
//   "host [RECOVERED after Nx ...]"   -> retry sukses
//   "host [conn_error @attempt N]"    -> koneksi gagal total
//   "host"                            -> tanpa bracket sama sekali (exception akhir)
function parseEventName(name) {
  if (!name) return { host: '', statusCode: null, origin: null };

  const bracketMatch = name.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
  if (!bracketMatch) {
    return { host: name.trim(), statusCode: null, origin: null };
  }

  const host = bracketMatch[1].trim();
  const inner = bracketMatch[2]; // mis. "403/cloudflare" atau "403/cloudflare @attempt 2"

  const statusMatch = inner.match(/^(\d{3})\/?([a-z-]+)?/i);
  if (statusMatch) {
    return {
      host,
      statusCode: statusMatch[1],
      origin: statusMatch[2] || null,
    };
  }

  // kasus non-status: RECOVERED, conn_error, soft-block, dst — tampilkan apa adanya
  return { host, statusCode: null, origin: inner };
}

function renderStatusChips(data) {
  const breakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
  const counts = {};

  for (const row of breakdown) {
    const { statusCode } = parseEventName(row.endpoint);
    const key = statusCode || row.event_type; // fallback ke event_type kalau nggak ada status code
    counts[key] = (counts[key] || 0) + row.count;
  }

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    statusChipsCard.classList.add('hidden');
    return;
  }

  statusChipsCard.classList.remove('hidden');
  statusChipsWrap.innerHTML = entries.map(([code, count]) => {
    const isNumericStatus = /^\d{3}$/.test(code);
    let colorClass = 'bg-ink-100 text-ink-700';
    if (isNumericStatus) {
      const n = parseInt(code, 10);
      if (n >= 200 && n < 300) colorClass = 'bg-signal-goBg text-signal-go';
      else if (n === 429 || (n >= 300 && n < 400)) colorClass = 'bg-signal-warnBg text-signal-warn';
      else if (n >= 400) colorClass = 'bg-signal-stopBg text-signal-stop';
    }
    return `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium ${colorClass}">
      <span>${code}</span>
      <span class="opacity-60">·</span>
      <span>${count.toLocaleString('id-ID')}</span>
    </span>`;
  }).join('');
}

function renderBreakdown(data) {
  const breakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
  lastBreakdownRows = [...breakdown].sort((a, b) => b.count - a.count);

  populateBreakdownFilter(lastBreakdownRows);
  applyBreakdownFilter();
}

function populateBreakdownFilter(rows) {
  const eventTypes = [...new Set(rows.map(r => r.event_type))].sort();
  const current = breakdownFilter.value || 'all';

  breakdownFilter.innerHTML = '<option value="all">Semua event</option>' +
    eventTypes.map(t => `<option value="${t}">${t}</option>`).join('');

  // pertahankan pilihan filter kalau masih valid, reset ke "all" kalau nggak ada di run baru
  breakdownFilter.value = eventTypes.includes(current) ? current : 'all';
}

breakdownFilter.addEventListener('change', applyBreakdownFilter);

function applyBreakdownFilter() {
  const filterValue = breakdownFilter.value;
  const rows = filterValue === 'all'
    ? lastBreakdownRows
    : lastBreakdownRows.filter(r => r.event_type === filterValue);

  const tbody = document.getElementById('breakdown-body');
  tbody.innerHTML = '';

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="px-6 py-8 text-center text-ink-500 text-xs">Tidak ada data untuk filter ini.</td></tr>`;
    return;
  }

  for (const row of rows) {
    const { host, statusCode, origin } = parseEventName(row.endpoint);
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-ink-100/40 transition-colors';
    const badgeClass = getBadgeClass(row.event_type);

    tr.innerHTML = `
      <td class="px-6 py-3">
        <span class="inline-block px-2 py-1 rounded-md text-[11px] font-semibold font-mono ${badgeClass}">${row.event_type}</span>
      </td>
      <td class="px-6 py-3 text-ink-500 font-mono text-xs truncate max-w-[180px]" title="${row.endpoint}">${host || row.endpoint}</td>
      <td class="px-6 py-3 font-mono text-xs text-ink-700">${statusCode ?? '—'}</td>
      <td class="px-6 py-3 font-mono text-xs text-ink-500">${origin ?? '—'}</td>
      <td class="px-6 py-3 text-right font-mono">${row.count.toLocaleString('id-ID')}</td>
      <td class="px-6 py-3 text-right font-mono text-ink-500">${row.avg_ms}</td>
      <td class="px-6 py-3 text-right font-mono text-ink-300">${row.min_ms ?? '—'}</td>
      <td class="px-6 py-3 text-right font-mono text-ink-300">${row.max_ms ?? '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}