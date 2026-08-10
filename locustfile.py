"""
LOCUST + PLAYWRIGHT - Auto-crawl & capture API endpoints (FIXED v5)

Perubahan dari v4:
16. NEW: TIMELINE SNAPSHOT UNTUK CHART REALTIME-LOOKING
    Ditambahkan greenlet background (mirip pola crawl_background) yang
    mengambil snapshot ringan dari environment.stats.total tiap
    SNAPSHOT_INTERVAL_S detik SELAMA test berjalan, dan menyimpannya
    di memory (list TIMELINE_SNAPSHOTS) - bukan ditulis ke file
    berkali-kali. Snapshot ini baru ditulis ke JSON SEKALI, bareng
    hasil akhir lainnya, di listener test_stop yang sudah ada (v4).

    Kenapa begini (bukan commit ke git tiap interval): commit/push
    berkala dari GitHub Actions runner rawan race condition & rate
    limit kalau dilakukan terlalu sering. Snapshot disimpan di memory
    proses Locust dulu (murah, tidak ada I/O network), baru di-flush
    ke results/latest.json satu kali di akhir sebagai array
    "timeline". Frontend yang tanggung jawab menganimasikan array ini
    supaya chart terasa "hidup" saat ditampilkan.

    Tidak ada logic crawl/validasi/load test yang diubah - snapshot
    murni membaca environment.stats.total (agregat real-time yang
    memang sudah disediakan Locust secara internal), sama seperti
    listener test_stop v4 membaca stats.entries di akhir.

--- (komentar v1-v4 sebelumnya tetap berlaku di bawah) ---
15. NEW: JSON RESULT EXPORT
    Ditambahkan listener test_stop yang mengumpulkan semua statistik
    per event_type dari environment.stats (termasuk request_type custom
    seperti SOFT_BLOCKED, EDGE_DOWN, AUTH_EXPIRED, dll) dan menulisnya
    ke results/latest.json. Ini SATU-SATUNYA perubahan dari v3 - tidak
    ada logic crawl/validasi/load test yang diubah sama sekali.

    Kenapa perlu: supaya hasil test bisa dibaca oleh frontend (web UI)
    setelah test selesai, tanpa perlu parsing HTML report Locust atau
    akses ke proses Locust yang sudah mati.

12. FIX METHOD_ERROR (405) FALSE POSITIVE:
    Root cause: Playwright kadang nangkep method request yang TIDAK
    mencerminkan method resmi endpoint tersebut. Contoh nyata:
      - Prefetch/speculative request browser modern kadang pakai method
        yang tidak standar untuk endpoint itu
      - Request yang di-cancel/redirect di tengah jalan tapi method awal
        sempat ke-capture on_request sebelum browser ganti approach
      - SPA framework kadang fire request "preflight-like" tanpa OPTIONS
        header lengkap, sehingga browser kirim GET padahal nanti yang
        asli POST (atau sebaliknya)
    Ini bukan salah server - ini salah asumsi di sisi crawler.

    FIX: Setiap endpoint yang berhasil di-capture divalidasi ulang lewat
    satu request "dry-run" pakai method yang sama, SEBELUM dimasukkan ke
    ALL_ENDPOINTS. Kalau dry-run balikin 405, endpoint itu di-downgrade
    otomatis ke GET (method paling universal & paling jarang ditolak) dan
    divalidasi ulang sekali lagi. Kalau GET juga gagal -> endpoint di-skip
    total, bukan dipaksa masuk pool tembak dengan method yang jelas-jelas
    salah.

13. NEW: Endpoint yang di-downgrade dicatat di SKIPPED_ENDPOINTS dengan
    reason field, supaya kelihatan di log berapa banyak yang kena
    auto-correct vs yang di-skip total. Statistik crawl jadi lebih jujur.

14. NEW: dry-run pakai httpx (sync, ringan) bukan lewat Locust client,
    supaya validasi ini terjadi SEKALI di fase crawl (bukan di fase load
    test), jadi tidak menambah noise ke statistik Locust sama sekali.

1. Simpan request body (POST/PUT/PATCH) hasil crawl asli -> tidak lagi kirim body kosong
2. Simpan header penting (Authorization, Cookie, X-CSRF-Token, dll) -> tidak lagi 400/401
   karena auth hilang
3. Deteksi & skip endpoint yang butuh auth tapi auth-nya tidak berhasil ditangkap
4. Pisahkan statistik: endpoint "valid" vs "skipped"
5. Retry HANYA untuk transient status & error koneksi, bukan untuk 4xx definitif
6. Header per-request memakai kombinasi header asli (auth) + header default
7. Retry terakhir yang masih gagal selalu dicatat sebagai failure resmi (resp.failure())
8. 500 dipisah kategorinya dari 502/503/504 (bug aplikasi vs overload/unavailable)
9. Status code granular per event_type (401/403/400/404/405/409/422/451, dst)
10. 408 dipindah ke TRANSIENT (ikut retry), semantiknya sama seperti 504
11. Kategorisasi real-time dari resp.status_code asli, tidak ada hardcode/prediksi
"""

import json
import os
import random
import re
import time
from urllib.parse import urlparse

import gevent
import httpx
from locust import HttpUser, task, events
from playwright.sync_api import sync_playwright, Browser, Page

# ================== KONFIGURASI ==================

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
CRAWL_TIMEOUT = 30
MAX_RETRIES = 3

VALIDATION_TIMEOUT = 10

SKIP_EXT = (
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
    ".css", ".js", ".woff", ".woff2", ".ttf", ".eot",
    ".pdf", ".zip", ".rar", ".mp4", ".mp3",
)

DYNAMIC_PARAMS = ["session", "token", "ts", "timestamp", "random", "cache", "_", "nonce", "signature", "auth"]

AUTH_HEADER_KEYS = {
    "authorization",
    "cookie",
    "x-csrf-token",
    "x-xsrf-token",
    "x-api-key",
}

TRANSIENT_STATUS_CODES = (408, 500, 502, 503, 504)

DEFINITIVE_STATUS_MAP = {
    400: ("BAD_REQUEST", "BAD_REQUEST", "body/request hasil crawl kemungkinan tidak valid"),
    401: ("AUTH_EXPIRED", "AUTH_EXPIRED", "token/cookie hasil crawl sudah kadaluarsa"),
    403: ("FORBIDDEN", "WAF_BLOCKED", "ditolak origin (permission) / diblokir edge-WAF"),
    404: ("NOT_FOUND", "NOT_FOUND", "endpoint hasil crawl sudah tidak ada"),
    405: ("METHOD_ERROR", "METHOD_ERROR", "method yang ter-capture saat crawl salah"),
    409: ("CONFLICT", "CONFLICT", "race condition, umum saat POST/PUT dihit paralel"),
    422: ("VALIDATION_ERROR", "VALIDATION_ERROR", "body tidak valid untuk state saat ini"),
    451: ("LEGAL_BLOCKED", "LEGAL_BLOCKED", "diblokir karena alasan legal/region"),
}

CF_INDICATOR_HEADERS = ("cf-ray", "cf-cache-status", "cf-mitigated")

SOFT_BLOCK_BODY_SIGNATURES = (
    "just a moment",
    "attention required",
    "checking your browser",
    "cf-browser-verification",
    "cf-error-details",
    "please verify you are human",
    "captcha",
    "recaptcha",
    "hcaptcha",
    "access denied",
    "request blocked",
    "ddos protection by",
    "sucuri website firewall",
    "incapsula incident id",
    "perimeterx",
    "__cf_chl_",
)

SOFT_BLOCK_CHECK_MAX_BYTES = 20_000

# Path output JSON hasil test - dibaca oleh frontend setelah test selesai.
# Bisa dioverride lewat env var RESULTS_PATH (dipakai di workflow Actions).
RESULTS_PATH = os.environ.get("RESULTS_PATH", "results/latest.json")

# Interval snapshot timeline (detik). Dipakai buat chart di frontend -
# semakin kecil semakin "halus" grafiknya, tapi jangan terlalu kecil
# karena tetap jalan di greenlet yang sama dengan load test.
SNAPSHOT_INTERVAL_S = float(os.environ.get("SNAPSHOT_INTERVAL_S", "10"))


def detect_soft_block(resp) -> str | None:
    """
    Cek apakah response yang status-nya 2xx-3xx sebenarnya halaman
    challenge/captcha/block dari WAF, bukan response asli endpoint.
    """
    try:
        content_type = ""
        if resp.headers:
            content_type = str(resp.headers.get("Content-Type", "")).lower()

        if "application/json" in content_type:
            return None

        body = resp.content
        if not body:
            return None

        snippet = body[:SOFT_BLOCK_CHECK_MAX_BYTES]
        try:
            text = snippet.decode("utf-8", errors="ignore").lower()
        except Exception:
            return None

        for signature in SOFT_BLOCK_BODY_SIGNATURES:
            if signature in text:
                return signature

        return None
    except Exception:
        return None

# ================== GLOBAL STATE ==================

ALL_ENDPOINTS: list[dict] = []
SKIPPED_ENDPOINTS: list[dict] = []
CRAWL_FINISHED = False
TEST_START_TIME: float | None = None

# v5: snapshot timeline untuk chart. Diisi oleh greenlet snapshot_background,
# dibaca sekali oleh on_test_stop untuk ditulis ke JSON.
TIMELINE_SNAPSHOTS: list[dict] = []
SNAPSHOT_RUNNING = False


# ================== FILTER URL ==================

def is_valid_endpoint(url: str) -> bool:
    parsed = urlparse(url)
    query = parsed.query

    if query:
        for param in DYNAMIC_PARAMS:
            if param in query.lower():
                return False
        for part in query.split("&"):
            if "=" in part:
                _, value = part.split("=", 1)
                if re.search(r"\d{8,}", value):
                    return False

    if re.search(r"/\d{8,}", url):
        return False
    if re.search(r"/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", url, re.IGNORECASE):
        return False

    return True


def needs_auth(headers: dict) -> bool:
    lower_keys = {k.lower() for k in headers.keys()}
    return bool(lower_keys & AUTH_HEADER_KEYS)


def extract_auth_headers(headers: dict) -> dict:
    return {k: v for k, v in headers.items() if k.lower() in AUTH_HEADER_KEYS}


def classify_response_origin(resp) -> str:
    try:
        headers = resp.headers
        if not headers:
            return "unknown"

        lower_headers = {k.lower(): v.lower() if isinstance(v, str) else v
                          for k, v in headers.items()}
        server_header = str(lower_headers.get("server", ""))
        via_header = str(lower_headers.get("via", ""))
        combined = f"{server_header} {via_header}"

        if "cf-ray" in lower_headers or "cloudflare" in combined:
            return "cloudflare"
        if "vercel" in combined or "x-vercel-id" in lower_headers:
            return "vercel"
        if "fastly" in combined:
            return "fastly"
        if "cloudfront" in combined or "x-amz-cf-id" in lower_headers:
            return "cloudfront"
        if "akamai" in combined:
            return "akamai"
        if "azurefd" in combined or "x-azure-ref" in lower_headers:
            return "azure-fd"
        if "gws" in combined or "google frontend" in combined:
            return "google-cloud-lb"

        if server_header:
            return "origin"

        return "unknown"
    except Exception:
        return "unknown"


# ================== VALIDASI METHOD (FIX 405 FALSE POSITIVE) ==================

def validate_endpoint_method(ep: dict, http_client: httpx.Client) -> dict | None:
    method = ep.get("method", "GET")
    url = ep.get("url")
    auth_headers = ep.get("auth_headers") or {}

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        **auth_headers,
    }

    def try_request(m: str) -> int | None:
        try:
            resp = http_client.request(
                m, url, headers=headers, timeout=VALIDATION_TIMEOUT
            )
            return resp.status_code
        except Exception:
            return None

    status = try_request(method)

    if status is not None and status != 405:
        return ep

    if method.upper() != "GET":
        status_get = try_request("GET")
        if status_get is not None and status_get != 405:
            downgraded = dict(ep)
            downgraded["method"] = "GET"
            downgraded["post_data"] = None
            downgraded["_downgraded_from"] = method
            return downgraded

    return None


def validate_all_endpoints(endpoints: list[dict]) -> tuple[list[dict], list[dict]]:
    validated: list[dict] = []
    rejected: list[dict] = []

    with httpx.Client(verify=True, follow_redirects=True) as http_client:
        for ep in endpoints:
            result = validate_endpoint_method(ep, http_client)
            if result is None:
                rejected_ep = dict(ep)
                rejected_ep["reason"] = "method_invalid_after_validation"
                rejected.append(rejected_ep)
                print(f"[validate] SKIP (method tidak valid, GET pun gagal): "
                      f"{ep.get('method')} {ep.get('url')}")
                continue

            if result.get("_downgraded_from"):
                print(f"[validate] DOWNGRADE {result['_downgraded_from']} -> GET: "
                      f"{result.get('url')}")

            validated.append(result)

    return validated, rejected


# ================== PLAYWRIGHT CRAWLER ==================

def capture_endpoints_with_playwright(host: str) -> tuple[list[dict], list[dict]]:
    captured: dict[str, dict] = {}
    valid_responses: set[str] = set()

    with sync_playwright() as p:
        browser: Browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1280, "height": 720},
        )
        page: Page = context.new_page()

        def on_response(response):
            url = response.url
            if urlparse(url).netloc != urlparse(host).netloc:
                return
            if any(url.lower().endswith(ext) for ext in SKIP_EXT):
                return
            if response.status == 200:
                valid_responses.add(url)

        def on_request(request):
            if request.method not in ("GET", "POST", "PUT", "DELETE", "PATCH"):
                return
            url = request.url

            if not is_valid_endpoint(url):
                return
            if urlparse(url).netloc != urlparse(host).netloc:
                return
            if any(url.lower().endswith(ext) for ext in SKIP_EXT):
                return

            key = f"{request.method}|{url}"
            if key in captured:
                return

            post_data = None
            try:
                post_data = request.post_data
            except Exception:
                pass

            try:
                req_headers = dict(request.headers)
            except Exception:
                req_headers = {}

            captured[key] = {
                "method": request.method,
                "url": url,
                "host": host,
                "post_data": post_data,
                "auth_headers": extract_auth_headers(req_headers),
                "requires_auth": needs_auth(req_headers),
            }

        page.on("request", on_request)
        page.on("response", on_response)

        try:
            print(f"[playwright] Buka: {host}")
            page.goto(host, timeout=CRAWL_TIMEOUT * 1000)
            page.wait_for_load_state("networkidle", timeout=CRAWL_TIMEOUT * 1000)

            links = page.query_selector_all("a[href]")
            clicked = 0
            for link in links[:15]:
                try:
                    href = link.get_attribute("href")
                    if not href or href.startswith(("#", "javascript:", "mailto:")):
                        continue
                    link.click()
                    page.wait_for_load_state("networkidle", timeout=5000)
                    clicked += 1
                except Exception:
                    continue
                if clicked >= 10:
                    break

            for _ in range(5):
                page.mouse.wheel(0, 500)
                page.wait_for_timeout(1000)

        except Exception as e:
            print(f"[playwright] Error saat crawl {host}: {e}")

        finally:
            browser.close()

    endpoints_valid = []
    endpoints_skipped = []

    for ep in captured.values():
        if ep["url"] not in valid_responses:
            print(f"[filter] Skip (bukan 200): {ep['method']} {ep['url']}")
            continue

        if ep["requires_auth"] and not ep["auth_headers"]:
            endpoints_skipped.append(ep)
            continue

        endpoints_valid.append(ep)

    print(f"[playwright] {host} -> total captured: {len(captured)}")
    print(f"[playwright] {host} -> valid (siap validasi method): {len(endpoints_valid)}")
    print(f"[playwright] {host} -> skipped (auth tidak lengkap): {len(endpoints_skipped)}")

    return endpoints_valid, endpoints_skipped


def collect_endpoints(hosts: list[str]) -> tuple[list[dict], list[dict]]:
    all_valid, all_skipped = [], []
    for host in hosts:
        print(f"[crawl] Mulai capture endpoint dari: {host}")
        try:
            valid, skipped = capture_endpoints_with_playwright(host)
        except Exception as e:
            print(f"[crawl] ERROR fatal saat crawl {host}: {e}")
            valid, skipped = [], []

        if not valid:
            print(f"[crawl] {host} -> 0 endpoint valid, fallback ke homepage GET")
            valid = [{
                "method": "GET",
                "url": host,
                "host": host,
                "post_data": None,
                "auth_headers": {},
                "requires_auth": False,
            }]

        print(f"[crawl] {host} -> validasi method untuk {len(valid)} endpoint...")
        validated, method_rejected = validate_all_endpoints(valid)
        print(f"[crawl] {host} -> lolos validasi: {len(validated)}, "
              f"ditolak (method invalid): {len(method_rejected)}")

        all_valid.extend(validated)
        all_skipped.extend(skipped)
        all_skipped.extend(method_rejected)

    return all_valid, all_skipped


# ================== LOCUST LISTENER ==================

@events.init_command_line_parser.add_listener
def add_custom_args(parser):
    parser.add_argument(
        "--target-hosts",
        type=str,
        env_var="TARGET_HOSTS",
        default="",
        help="Daftar host, dipisah koma. Contoh: https://a.com,https://b.com",
        include_in_web_ui=True,
    )


def snapshot_background(environment):
    """
    v5: Ambil snapshot ringan dari statistik agregat tiap SNAPSHOT_INTERVAL_S
    detik, SELAMA load test berjalan (bukan saat crawling). Disimpan di
    memory saja (TIMELINE_SNAPSHOTS) - tidak ada I/O file/network di sini,
    supaya tidak mengganggu statistik Locust yang sedang berjalan.

    Snapshot berhenti otomatis begitu SNAPSHOT_RUNNING di-set False oleh
    on_test_stop, atau kalau runner sudah tidak lagi "running"/"spawning".
    """
    global TIMELINE_SNAPSHOTS, SNAPSHOT_RUNNING

    # Tunggu crawling selesai dulu supaya snapshot pertama sudah
    # mencerminkan fase load test yang sebenarnya, bukan fase crawl.
    waited = 0
    while not CRAWL_FINISHED and waited < 90:
        gevent.sleep(0.5)
        waited += 0.5

    start = time.time()
    while SNAPSHOT_RUNNING:
        try:
            state = environment.runner.state if environment.runner else "unknown"
            if state not in ("running", "spawning"):
                break

            total = environment.stats.total
            TIMELINE_SNAPSHOTS.append({
                "t": round(time.time() - start, 1),
                "total_requests": total.num_requests + total.num_failures,
                "avg_response_ms": round(total.avg_response_time, 1) if total.num_requests > 0 else 0,
                "rps": round(total.current_rps, 2) if hasattr(total, "current_rps") else 0,
            })
        except Exception as e:
            print(f"[snapshot] gagal ambil snapshot: {e}")

        gevent.sleep(SNAPSHOT_INTERVAL_S)


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    global ALL_ENDPOINTS, SKIPPED_ENDPOINTS, CRAWL_FINISHED, TEST_START_TIME
    global TIMELINE_SNAPSHOTS, SNAPSHOT_RUNNING

    TEST_START_TIME = time.time()
    TIMELINE_SNAPSHOTS = []
    SNAPSHOT_RUNNING = True

    raw = environment.parsed_options.target_hosts.strip()
    if not raw:
        print("[ERROR] Target hosts kosong. Set --target-hosts atau env TARGET_HOSTS.")
        environment.runner.quit()
        return

    hosts = [h.strip() for h in raw.split(",") if h.strip()]
    hosts = [h if h.startswith(("http://", "https://")) else f"https://{h}" for h in hosts]

    def crawl_background():
        global ALL_ENDPOINTS, SKIPPED_ENDPOINTS, CRAWL_FINISHED
        print("[crawl] Memulai Playwright crawler...")
        valid, skipped = collect_endpoints(hosts)
        ALL_ENDPOINTS = valid
        SKIPPED_ENDPOINTS = skipped
        CRAWL_FINISHED = True
        print(f"[crawl] SELESAI. {len(ALL_ENDPOINTS)} endpoint siap ditembak, "
              f"{len(SKIPPED_ENDPOINTS)} endpoint di-skip total.")

    gevent.spawn(crawl_background)
    gevent.spawn(snapshot_background, environment)


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    """
    v4: Mengumpulkan statistik akhir dari environment.stats
    (termasuk semua request_type custom seperti SOFT_BLOCKED, EDGE_DOWN,
    AUTH_EXPIRED, dst) dan menulisnya ke file JSON supaya bisa dibaca
    frontend setelah proses Locust ini selesai/mati.

    v5: Juga menyertakan TIMELINE_SNAPSHOTS (diisi snapshot_background
    selama test berjalan) sebagai field "timeline", supaya frontend bisa
    menganimasikan chart response time/RPS dari waktu ke waktu.

    Tidak menyentuh logic test sama sekali - murni membaca statistik
    yang sudah dikumpulkan Locust secara internal lewat events.request.fire().
    """
    global SNAPSHOT_RUNNING
    SNAPSHOT_RUNNING = False

    try:
        stats = environment.stats
        duration_s = round(time.time() - TEST_START_TIME, 2) if TEST_START_TIME else None

        breakdown = []
        total_requests = 0
        total_failures = 0

        # stats.entries key-nya (name, method) -> StatsEntry
        # method di sini sebenarnya request_type kita (SUCCESS, AUTH_EXPIRED, dst)
        # karena events.request.fire(request_type=...) dipakai sebagai "method"
        for (name, method), entry in stats.entries.items():
            if entry.num_requests == 0 and entry.num_failures == 0:
                continue

            count = entry.num_requests + entry.num_failures
            avg_ms = round(entry.avg_response_time, 1) if entry.num_requests > 0 else 0

            breakdown.append({
                "event_type": method,
                "endpoint": name,
                "count": count,
                "avg_ms": avg_ms,
                "min_ms": round(entry.min_response_time, 1) if entry.min_response_time else 0,
                "max_ms": round(entry.max_response_time, 1) if entry.max_response_time else 0,
            })

            total_requests += count
            if method != "SUCCESS":
                total_failures += count

        total_success = total_requests - total_failures
        avg_response_overall = round(stats.total.avg_response_time, 1) if stats.total.num_requests > 0 else 0

        result = {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "duration_seconds": duration_s,
            "target_hosts": environment.parsed_options.target_hosts if hasattr(environment, "parsed_options") else "",
            "endpoints_tested": len(ALL_ENDPOINTS),
            "endpoints_skipped": len(SKIPPED_ENDPOINTS),
            "total_requests": total_requests,
            "total_success": total_success,
            "total_failures": total_failures,
            "avg_response_ms": avg_response_overall,
            "breakdown": sorted(breakdown, key=lambda x: x["count"], reverse=True),
            # v5: history ringan buat chart di frontend. Kalau kosong
            # (test terlalu singkat / gagal sebelum sempat snapshot),
            # frontend cukup fallback ke tampilan tanpa animasi timeline.
            "timeline": TIMELINE_SNAPSHOTS,
        }

        os.makedirs(os.path.dirname(RESULTS_PATH), exist_ok=True)
        with open(RESULTS_PATH, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        print(f"[export] Hasil test ditulis ke {RESULTS_PATH}")
        print(f"[export] Total: {total_requests}, Sukses: {total_success}, Gagal: {total_failures}")
        print(f"[export] Timeline snapshots: {len(TIMELINE_SNAPSHOTS)}")

    except Exception as e:
        print(f"[export] ERROR gagal menulis hasil JSON: {e}")


# ================== USER BEHAVIOR ==================

class MultiHostUser(HttpUser):
    host = "http://localhost"

    def on_start(self):
        waited = 0
        while not ALL_ENDPOINTS and not CRAWL_FINISHED and waited < 90:
            gevent.sleep(0.5)
            waited += 0.5

        if not ALL_ENDPOINTS:
            print("[WARNING] Tidak ada endpoint valid ditemukan setelah crawling!")

    @task
    def hit_random_endpoint(self):
        if not ALL_ENDPOINTS:
            return

        ep = random.choice(ALL_ENDPOINTS)
        method = ep.get("method", "GET")
        url = ep.get("url")
        host_label = urlparse(url).netloc
        post_data = ep.get("post_data")
        auth_headers = ep.get("auth_headers") or {}

        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            **auth_headers,
        }

        request_kwargs = {
            "method": method,
            "url": url,
            "headers": headers,
            "name": host_label,
            "catch_response": True,
            "timeout": 30,
        }

        if method.upper() in ("POST", "PUT", "PATCH") and post_data:
            headers["Content-Type"] = "application/json"
            try:
                parsed_body = json.loads(post_data)
                request_kwargs["json"] = parsed_body
            except (json.JSONDecodeError, TypeError):
                request_kwargs["data"] = post_data

        had_rate_limit = False
        had_transient_error = False

        for attempt in range(1, MAX_RETRIES + 1):
            is_last_attempt = (attempt == MAX_RETRIES)
            try:
                with self.client.request(**request_kwargs) as resp:
                    status = resp.status_code

                    if 200 <= status < 400:
                        block_signature = detect_soft_block(resp)
                        if block_signature is not None:
                            origin_type = classify_response_origin(resp)
                            events.request.fire(
                                request_type="SOFT_BLOCKED",
                                name=f"{host_label} [{status}/soft-block:{block_signature}]",
                                response_time=resp.elapsed.total_seconds() * 1000,
                                response_length=len(resp.content or b""),
                                exception=None,
                                context={},
                            )
                            resp.failure(
                                f"SOFT_BLOCKED: status={status} tapi body match '{block_signature}' "
                                f"(origin={origin_type}) - kemungkinan WAF challenge/captcha page"
                            )
                            return

                        if had_rate_limit:
                            events.request.fire(
                                request_type="RETRY",
                                name=f"{host_label} [RECOVERED after {attempt}x rate-limit]",
                                response_time=resp.elapsed.total_seconds() * 1000,
                                response_length=len(resp.content or b""),
                                exception=None,
                                context={},
                            )
                        if had_transient_error:
                            events.request.fire(
                                request_type="RETRY",
                                name=f"{host_label} [RECOVERED after {attempt}x down]",
                                response_time=resp.elapsed.total_seconds() * 1000,
                                response_length=len(resp.content or b""),
                                exception=None,
                                context={},
                            )
                        resp.success()
                        return

                    elif status == 429:
                        had_rate_limit = True
                        origin_type = classify_response_origin(resp)
                        event_type = "EDGE_LIMIT" if origin_type not in ("origin", "unknown") else "APP_LIMIT"

                        retry_after = resp.headers.get("Retry-After") if resp.headers else None
                        try:
                            wait_s = float(retry_after) if retry_after else 1.0
                        except ValueError:
                            wait_s = 1.0
                        wait_s = min(wait_s, 10.0)

                        events.request.fire(
                            request_type=event_type,
                            name=f"{host_label} [429/{origin_type} @attempt {attempt}]",
                            response_time=resp.elapsed.total_seconds() * 1000,
                            response_length=len(resp.content or b""),
                            exception=None,
                            context={},
                        )
                        if is_last_attempt:
                            resp.failure(f"{event_type}: 429/{origin_type} after {MAX_RETRIES} attempts")
                            return
                        gevent.sleep(wait_s)
                        continue

                    elif status in TRANSIENT_STATUS_CODES:
                        had_transient_error = True
                        origin_type = classify_response_origin(resp)
                        is_edge = origin_type not in ("origin", "unknown")

                        if status == 408:
                            event_type = "EDGE_TIMEOUT" if is_edge else "SERVER_TIMEOUT"
                        elif status == 500:
                            event_type = "EDGE_ERROR" if is_edge else "SERVER_ERROR"
                        else:
                            event_type = "EDGE_DOWN" if is_edge else "SERVER_DOWN"

                        events.request.fire(
                            request_type=event_type,
                            name=f"{host_label} [{status}/{origin_type} @attempt {attempt}]",
                            response_time=resp.elapsed.total_seconds() * 1000,
                            response_length=len(resp.content or b""),
                            exception=None,
                            context={},
                        )
                        if is_last_attempt:
                            resp.failure(f"{event_type}: {status}/{origin_type} after {MAX_RETRIES} attempts")
                            return
                        gevent.sleep(0.5)
                        continue

                    elif status in DEFINITIVE_STATUS_MAP:
                        origin_type = classify_response_origin(resp)
                        is_edge = origin_type not in ("origin", "unknown")
                        event_type_origin, event_type_edge, desc = DEFINITIVE_STATUS_MAP[status]
                        event_type = event_type_edge if is_edge else event_type_origin

                        events.request.fire(
                            request_type=event_type,
                            name=f"{host_label} [{status}/{origin_type}]",
                            response_time=resp.elapsed.total_seconds() * 1000,
                            response_length=len(resp.content or b""),
                            exception=None,
                            context={},
                        )
                        resp.failure(f"{event_type}: {status}/{origin_type} - {desc}")
                        return

                    else:
                        origin_type = classify_response_origin(resp)
                        event_type = f"CLIENT_ERROR_{status}"
                        events.request.fire(
                            request_type=event_type,
                            name=f"{host_label} [{status}/{origin_type}]",
                            response_time=resp.elapsed.total_seconds() * 1000,
                            response_length=len(resp.content or b""),
                            exception=None,
                            context={},
                        )
                        resp.failure(f"{event_type}: {status}/{origin_type}")
                        return

            except Exception as e:
                had_transient_error = True
                events.request.fire(
                    request_type="CONN_ERROR",
                    name=f"{host_label} [conn_error @attempt {attempt}]",
                    response_time=0,
                    response_length=0,
                    exception=None,
                    context={},
                )
                if is_last_attempt:
                    events.request.fire(
                        request_type=method,
                        name=host_label,
                        response_time=0,
                        response_length=0,
                        exception=e,
                        context={},
                    )
                    print(f"[error] {method} {url} -> {e}")
                    return
                gevent.sleep(0.5)
                continue