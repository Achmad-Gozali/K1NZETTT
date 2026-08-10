// ============================================================
// K1NZETTT — logika antarmuka
// Alur: kirim pemicu ke workflow lewat Worker -> polling status ->
// ambil results/latest.json asli dari GitHub -> tampilkan hasil.
// ============================================================

const WORKER_URL = "https://k1nzettproxy.achmadgozali.workers.dev";
const REPO_OWNER = "Achmad-Gozali";
const REPO_NAME = "K1NZETTT";
const REPO_BRANCH = "main";
const RESULTS_RAW_URL =
  `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/results/latest.json`;

const POLL_INTERVAL_MS = 5000;
// Proses tanpa batas tidak boleh terkena timeout polling antarmuka —
// batas waktu job GitHub sendiri yang jadi batas atas (lihat
// timeout-minutes di loadtest.yml).
const POLL_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 jam

// ---- elemen ----
const form = document.getElementById('test-form');
const urlInput = document.getElementById('target-url');
const urlError = document.getElementById('url-error');
const userCount = document.getElementById('user-count');
const spawnRate = document.getElementById('spawn-rate');
const duration = document.getElementById('duration');
const durationUnlimited = document.getElementById('duration-unlimited');
const submitBtn = document.getElementById('submit-btn');
const triggerError = document.getElementById('trigger-error');

// status bar (Host / Status / RPS / Gagal)
const statusHost = document.getElementById('status-host');
const statusState = document.getElementById('status-state');
const statusRps = document.getElementById('status-rps');
const statusFailures = document.getElementById('status-failures');
const headerDot = document.getElementById('header-dot');

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
let currentRunId = null; // dipakai tombol Hentikan, diisi dari respons /status
let isUnlimitedRun = false; // dipakai untuk teks progres saat proses tanpa batas waktu

// ---- alihkan input durasi saat "tanpa batas" dicentang ----
durationUnlimited.addEventListener('change', () => {
  duration.disabled = durationUnlimited.checked;
});

// ---- validasi dasar url ----
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
  // Mendukung banyak host dipisah koma, masing-masing dinormalisasi.
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

// ---- pengiriman form ----
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
  stopBtn.textContent = 'Hentikan';
  resultsSection.classList.add('hidden');
  formCard.classList.remove('hidden');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Mulai';
  urlInput.value = '';
  urlInput.focus();
  setStatusBar({ host: '—', state: 'IDLE', rps: '—', failures: '—' });
});

// ---- hentikan proses ----
stopBtn.addEventListener('click', async () => {
  if (!currentRunId) {
    stopMessage.textContent = 'Belum ada proses yang bisa dihentikan.';
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

    stopMessage.textContent = 'Permintaan berhenti terkirim, menunggu runner berhenti…';
    stopMessage.classList.remove('hidden');
    setStatusBar({ state: 'BERHENTI…' });
    // polling yang sudah berjalan akan otomatis menangkap status selesai/dibatalkan
  } catch (err) {
    stopMessage.textContent = err.message || 'Gagal menghentikan proses.';
    stopMessage.classList.remove('hidden');
    stopBtn.disabled = false;
    stopBtn.textContent = 'Hentikan';
  }
});

// ---- pembantu status bar ----
function setStatusBar({ host, state, rps, failures }) {
  if (host !== undefined) statusHost.textContent = host;
  if (state !== undefined) {
    statusState.textContent = state;
    statusState.className = 'text-xs font-mono font-semibold ' + stateColorClass(state);
    updateHeaderDot(state);
  }
  if (rps !== undefined) statusRps.textContent = rps;
  if (failures !== undefined) statusFailures.textContent = failures;
}

function stateColorClass(state) {
  switch (state) {
    case 'BERJALAN': return 'text-signal-go';
    case 'ANTRE': return 'text-signal-warn';
    case 'SELESAI': return 'text-signal-go';
    case 'GAGAL': return 'text-signal-stop';
    case 'BERHENTI…': return 'text-signal-warn';
    case 'DIHENTIKAN': return 'text-signal-stop';
    default: return 'text-ink-500';
  }
}

function updateHeaderDot(state) {
  headerDot.classList.remove('bg-signal-go', 'bg-signal-warn', 'bg-signal-stop', 'bg-ink-500', 'animate-pulse-dot');
  if (state === 'BERJALAN' || state === 'ANTRE' || state === 'BERHENTI…') {
    headerDot.classList.add('bg-signal-warn', 'animate-pulse-dot');
  } else if (state === 'SELESAI') {
    headerDot.classList.add('bg-signal-go');
  } else if (state === 'GAGAL' || state === 'DIHENTIKAN') {
    headerDot.classList.add('bg-signal-stop');
  } else {
    headerDot.classList.add('bg-ink-500');
  }
}

// ---- alur proses ----
async function startRun(hosts, users, rate, dur) {
  formCard.classList.add('hidden');
  runningCard.classList.remove('hidden');
  resultsSection.classList.add('hidden');
  runningLogLink.classList.add('hidden');

  isUnlimitedRun = dur === 0;
  const targetLabel = hosts.join(', ');
  const durLabel = isUnlimitedRun ? 'tanpa batas' : `${dur} menit`;
  runningTarget.textContent = `${targetLabel} · ${users} pengguna · laju ${rate}/dtk · ${durLabel}`;
  setRunningStage('trigger');
  setStatusBar({ host: targetLabel, state: 'ANTRE', rps: '—', failures: '—' });
  currentRunId = null;
  stopBtn.disabled = false;
  stopBtn.textContent = 'Hentikan';
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
      throw new Error(data.error || `Gagal memicu (status ${res.status})`);
    }

    setRunningStage('queued');
    pollStatus(targetLabel, users, dur);
  } catch (err) {
    setStatusBar({ state: 'GAGAL' });
    showTriggerError(err.message || 'Gagal menghubungi Worker.');
  }
}

function showTriggerError(message) {
  runningCard.classList.add('hidden');
  formCard.classList.remove('hidden');
  triggerError.textContent = `Gagal memulai pengujian: ${message}`;
  triggerError.classList.remove('hidden');
}

function setRunningStage(stage) {
  const stages = {
    trigger: { pct: 4, title: 'Mengirim permintaan…', detail: 'Mengirim permintaan ke GitHub Actions melalui Worker.' },
    queued: { pct: 12, title: 'Menunggu antrean…', detail: 'Proses sudah terdaftar, menunggu runner GitHub tersedia.' },
    in_progress: {
      pct: 55,
      title: 'Pengujian sedang berjalan…',
      detail: isUnlimitedRun
        ? 'Menjelajahi endpoint dan mengirim beban tanpa batas waktu. Tekan Hentikan untuk menghentikan proses.'
        : 'Menjelajahi endpoint dan mengirim beban di GitHub Actions runner.',
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
      showTriggerError('Batas waktu menunggu hasil terlampaui. Periksa langsung di GitHub Actions.');
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
            setStatusBar({ state: 'SELESAI' });
            await fetchAndShowResults(targetLabel, users, dur);
          } else if (data.conclusion === 'cancelled') {
            // Proses dihentikan lewat tombol Hentikan: locustfile.py tetap
            // menulis hasil parsial lewat signal handler, jadi tetap coba
            // tampilkan hasil daripada langsung dianggap gagal.
            setStatusBar({ state: 'DIHENTIKAN' });
            await fetchAndShowResults(targetLabel, users, dur, { stopped: true });
          } else {
            setStatusBar({ state: 'GAGAL' });
            showTriggerError(`Proses selesai dengan status "${data.conclusion}". Periksa log untuk detail.`);
          }
          return; // hentikan polling
        }

        const stage = data.status === 'queued' ? 'queued' : 'in_progress';
        setRunningStage(stage);
        setStatusBar({ state: stage === 'queued' ? 'ANTRE' : 'BERJALAN' });
      }
    } catch (err) {
      // Kegagalan jaringan sesaat: jangan hentikan polling, coba lagi.
    }

    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  tick();
}

// ---- ambil hasil asli dari GitHub ----
async function fetchAndShowResults(targetLabel, users, dur, { stopped = false } = {}) {
  try {
    const res = await fetch(`${RESULTS_RAW_URL}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`Gagal mengambil hasil (status ${res.status})`);
    const data = await res.json();

    if (!data.generated_at) {
      throw new Error('results/latest.json belum berisi hasil pengujian.');
    }

    showResults(data, targetLabel, { stopped });
  } catch (err) {
    if (stopped) {
      // Proses dihentikan tapi hasil belum sempat tersimpan (mis. signal
      // handler sempat menulis berkas tapi tahap commit belum berjalan).
      showTriggerError(
        'Proses dihentikan, tetapi hasil belum sempat tersimpan ke repositori. ' +
        'Periksa log proses — hasil parsial biasanya tetap tersedia di artifact.'
      );
      return;
    }
    showTriggerError(err.message || 'Gagal mengambil hasil pengujian.');
  }
}

function showResults(data, targetLabel, { stopped = false } = {}) {
  runningCard.classList.add('hidden');
  resultsSection.classList.remove('hidden');

  resultTarget.textContent = data.target_hosts || targetLabel;
  const durText = data.duration_seconds ? `${Math.round(data.duration_seconds)} detik` : '—';
  const stoppedLabel = stopped ? ' · dihentikan manual' : '';
  resultMeta.textContent =
    `${durText} · ${data.endpoints_tested ?? 0} endpoint diuji` +
    (data.endpoints_skipped ? ` · ${data.endpoints_skipped} dilewati` : '') +
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
    return 'Dijalankan ' + d.toLocaleString('id-ID', {
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
    (data.avg_response_ms ?? 0) + ' ms';
  document.getElementById('stat-endpoints-tested').textContent =
    (data.endpoints_tested ?? 0).toLocaleString('id-ID');
  document.getElementById('stat-endpoints-skipped').textContent =
    (data.endpoints_skipped ?? 0).toLocaleString('id-ID');
}

// ---- grafik: animasikan cuplikan linimasa dari locustfile.py ----
function renderTimelineChart(data) {
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  const ctx = document.getElementById('response-chart');

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  if (timeline.length < 2) {
    // Pengujian terlalu singkat untuk punya cuplikan berarti — sembunyikan
    // grafik daripada menampilkan grafik kosong/menyesatkan.
    chartCard.classList.add('hidden');
    return;
  }

  chartCard.classList.remove('hidden');

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: timeline.map(p => `${Math.round(p.t)}dtk`),
      datasets: [
        {
          label: 'Waktu respons (ms)',
          data: [],
          borderColor: '#50E3A4',
          backgroundColor: 'rgba(80,227,164,0.08)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          yAxisID: 'y',
          pointRadius: 0,
        },
        {
          label: 'RPS',
          data: [],
          borderColor: '#F5A623',
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
          labels: { font: { family: 'ui-monospace, monospace', size: 11 }, color: '#888888', usePointStyle: true, boxWidth: 6 },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'ui-monospace, monospace', size: 10 }, color: '#555555' } },
        y: {
          position: 'left',
          grid: { color: '#1F1F1F' },
          ticks: { font: { family: 'ui-monospace, monospace', size: 10 }, color: '#555555' },
          title: { display: true, text: 'ms', font: { family: 'ui-monospace, monospace', size: 10 }, color: '#555555' },
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: { font: { family: 'ui-monospace, monospace', size: 10 }, color: '#555555' },
          title: { display: true, text: 'permintaan/dtk', font: { family: 'ui-monospace, monospace', size: 10 }, color: '#555555' },
        },
      },
    },
  });

  // Progressive reveal: data asli (bukan animasi palsu), hanya ditampilkan
  // bertahap titik demi titik agar grafik terasa "membangun diri" saat
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
  SUCCESS: 'bg-signal-goBg text-signal-go border border-signal-goBorder',
  RETRY: 'bg-signal-goBg text-signal-go border border-signal-goBorder',
  AUTH_EXPIRED: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  EDGE_LIMIT: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  APP_LIMIT: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  SERVER_DOWN: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  EDGE_DOWN: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  SERVER_ERROR: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  EDGE_ERROR: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  SERVER_TIMEOUT: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  EDGE_TIMEOUT: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  NOT_FOUND: 'bg-surface-raised text-ink-700 border border-surface-border',
  FORBIDDEN: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  WAF_BLOCKED: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  CONFLICT: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  BAD_REQUEST: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  LEGAL_BLOCKED: 'bg-surface-raised text-ink-700 border border-surface-border',
  SOFT_BLOCKED: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  VALIDATION_ERROR: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  METHOD_ERROR: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  CONN_ERROR: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  SSL_ERROR: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  CONN_TIMEOUT: 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder',
  CONN_RESET: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  CONN_REFUSED: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  DNS_ERROR: 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder',
  DEFAULT: 'bg-surface-raised text-ink-700 border border-surface-border',
};

function getBadgeClass(eventType) {
  if (EVENT_STYLES[eventType]) return EVENT_STYLES[eventType];
  if (eventType && eventType.startsWith('CLIENT_ERROR_')) return EVENT_STYLES.SERVER_ERROR;
  return EVENT_STYLES.DEFAULT;
}

// ---- penguraian string "name" dari Locust jadi field terpisah ----
// Format asli dari locustfile.py, salah satu dari:
//   "host [status/origin]"            -> mis. "api.contoh.com [403/cloudflare]"
//   "host [status/origin @attempt N]" -> percobaan ulang/transient
//   "host [RECOVERED after Nx ...]"   -> percobaan ulang berhasil
//   "host [conn_error @attempt N]"    -> koneksi gagal total
//   "host"                            -> tanpa kurung sama sekali (exception akhir)
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
    const key = statusCode || row.event_type; // fallback ke event_type kalau tidak ada kode status
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
    let colorClass = 'bg-surface-raised text-ink-700 border border-surface-border';
    if (isNumericStatus) {
      const n = parseInt(code, 10);
      if (n >= 200 && n < 300) colorClass = 'bg-signal-goBg text-signal-go border border-signal-goBorder';
      else if (n === 429 || (n >= 300 && n < 400)) colorClass = 'bg-signal-warnBg text-signal-warn border border-signal-warnBorder';
      else if (n >= 400) colorClass = 'bg-signal-stopBg text-signal-stop border border-signal-stopBorder';
    }
    return `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control text-xs font-mono font-medium ${colorClass}">
      <span>${code}</span>
      <span class="opacity-50">·</span>
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

  breakdownFilter.innerHTML = '<option value="all">Semua peristiwa</option>' +
    eventTypes.map(t => `<option value="${t}">${t}</option>`).join('');

  // pertahankan pilihan filter kalau masih valid, kembalikan ke "semua" jika tidak ada di proses baru
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
    tr.className = 'hover:bg-surface-raised transition-colors';
    const badgeClass = getBadgeClass(row.event_type);

    tr.innerHTML = `
      <td class="px-4 sm:px-6 py-3">
        <span class="inline-block px-2 py-1 rounded-control text-[11px] font-semibold font-mono ${badgeClass}">${row.event_type}</span>
      </td>
      <td class="px-4 sm:px-6 py-3 text-ink-500 font-mono text-xs truncate max-w-[140px] sm:max-w-[180px]" title="${row.endpoint}">${host || row.endpoint}</td>
      <td class="px-4 sm:px-6 py-3 font-mono text-xs text-ink-700">${statusCode ?? '—'}</td>
      <td class="px-4 sm:px-6 py-3 font-mono text-xs text-ink-500">${origin ?? '—'}</td>
      <td class="px-4 sm:px-6 py-3 text-right font-mono">${row.count.toLocaleString('id-ID')}</td>
      <td class="px-4 sm:px-6 py-3 text-right font-mono text-ink-500">${row.avg_ms}</td>
      <td class="px-4 sm:px-6 py-3 text-right font-mono text-ink-300">${row.min_ms ?? '—'}</td>
      <td class="px-4 sm:px-6 py-3 text-right font-mono text-ink-300">${row.max_ms ?? '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}