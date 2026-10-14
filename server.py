#!/usr/bin/env python3
"""PetroKenya backend API.

Serves the station dashboard (index.html) and a JSON REST API backed by SQLite,
on its own localhost server. Uses only the Python standard library.

    python3 server.py                 # http://localhost:8000
    PORT=9000 python3 server.py       # custom port
    PK_DB=/path/to/db.sqlite3 python3 server.py

Endpoints
---------
GET    /                         dashboard UI
GET    /api/health               service status
GET    /api/stations             list of branches
POST   /api/compute              compute figures from raw inputs (no save)
GET    /api/records              list records   (?station=&date=&from=&to=&limit=)
GET    /api/records/<id>         one record
POST   /api/records              save record (upserts on report_date + station)
PUT    /api/records/<id>         replace record
DELETE /api/records/<id>         delete one record
DELETE /api/records              delete all records (?station= to limit to one branch)
GET    /api/analytics            last-7-day series + all-time totals (?station=)
GET    /api/export.csv           CSV export (?station=)
"""

import csv
import io
import json
import os
import re
import sqlite3
import sys
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_FILE = os.path.join(BASE_DIR, "index.html")
DB_PATH = os.environ.get("PK_DB", os.path.join(BASE_DIR, "petrokenya.sqlite3"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 2 * 1024 * 1024

STATIONS = [
    "Westlands Branch", "Himaki Branch", "Ngeria Branch", "Nairobi West Branch",
    "Mombasa Road Branch", "Kisumu Branch", "Nakuru Branch",
]

# ── Statutory rates (same constants as the dashboard) ─────────────────────────
VAT = 0.16
EX_P, EX_D, EX_K = 21.95, 7.21, 7.19   # excise per litre
RL_P, RL_D = 18.00, 13.19              # road levy per litre

# Raw numeric inputs accepted from clients
NUM_FIELDS = [
    "petrol_open", "petrol_close", "petrol_price", "petrol_cost",
    "petrol_sales_open", "petrol_sales_close",
    "diesel_open", "diesel_close", "diesel_price", "diesel_cost",
    "diesel_sales_open", "diesel_sales_close",
    "kero_open", "kero_close", "kero_price", "kero_cost",
    "kero_sales_open", "kero_sales_close",
    "petrol_dip_open", "petrol_delivered", "petrol_dip_close",
    "diesel_dip_open", "diesel_delivered", "diesel_dip_close",
    "kero_dip_open", "kero_delivered", "kero_dip_close",
    "mpesa_amount", "mpesa_txns", "cash_amount", "credit_amount", "card_amount",
    "float_amount", "banked_amount",
    "exp_wages", "exp_elec", "exp_water", "exp_maint", "exp_lubes", "exp_misc",
]
TEXT_FIELDS = [
    "operator", "shift", "mpesa_till", "mpesa_ref", "credit_customer",
    "kra_pin", "kra_business", "kra_period", "kra_branch", "kra_etr",
    "kra_return_type", "kra_remarks",
]
LIST_FIELDS = ["misc_items", "gas_items", "invoices"]

CSV_COLS = [
    "report_date", "station",
    "petrol_litres", "diesel_litres", "kero_litres", "total_litres",
    "gross_revenue", "mpesa_amount", "cash_amount", "credit_amount", "card_amount",
    "total_expenses", "net_profit", "profit_margin",
    "output_vat", "total_excise", "total_tax",
    "kra_pin", "kra_business", "kra_period", "kra_return_type",
    "created_at",
]

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def r2(v):
    return round(v + 0.0, 2)


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f == f and f not in (float("inf"), float("-inf")) else 0.0


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── Computation engine — mirrors compute() in index.html ──────────────────────
def compute(raw):
    g = lambda k: num(raw.get(k))
    gas_items = raw.get("gas_items") or []
    misc_items = raw.get("misc_items") or []

    line = lambda i: num(i.get("qty")) * num(i.get("price"))
    gas_lube_rev = r2(sum(line(i) for i in gas_items))
    gas_rev_only = r2(sum(line(i) for i in gas_items if i.get("category") == "Gas"))
    lube_rev_only = r2(sum(line(i) for i in gas_items if i.get("category") == "Lubricant"))

    pL = max(0.0, g("petrol_close") - g("petrol_open"))
    dL = max(0.0, g("diesel_close") - g("diesel_open"))
    kL = max(0.0, g("kero_close") - g("kero_open"))
    pRev, dRev, kRev = r2(pL * g("petrol_price")), r2(dL * g("diesel_price")), r2(kL * g("kero_price"))
    pFC, dFC, kFC = r2(pL * g("petrol_cost")), r2(dL * g("diesel_cost")), r2(kL * g("kero_cost"))
    totalL = r2(pL + dL + kL)
    grossRev = r2(pRev + dRev + kRev + gas_lube_rev)
    totalFC = r2(pFC + dFC + kFC)

    pump = {}
    for prefix, rev in (("petrol", pRev), ("diesel", dRev), ("kero", kRev)):
        sales = max(0.0, r2(g(prefix + "_sales_close") - g(prefix + "_sales_open")))
        pump[prefix + "_pump_sales"] = sales
        pump[prefix + "_pump_variance"] = r2(rev - sales)

    dips = {}
    for prefix, sold in (("petrol", pL), ("diesel", dL), ("kero", kL)):
        expected = r2(g(prefix + "_dip_open") + g(prefix + "_delivered") - sold)
        dips[prefix + "_expected_stock"] = expected
        dips[prefix + "_dip_variance"] = r2(g(prefix + "_dip_close") - expected)

    mpesa, cash = g("mpesa_amount"), g("cash_amount")
    credit, card = g("credit_amount"), g("card_amount")
    collected = r2(mpesa + cash + credit + card)

    misc_total = r2(sum(num(i.get("amount")) for i in misc_items))
    exp_misc = misc_total if misc_items else g("exp_misc")
    totalExp = r2(g("exp_wages") + g("exp_elec") + g("exp_water") + g("exp_maint")
                  + g("exp_lubes") + exp_misc)

    totalCost = r2(totalFC + totalExp)
    netProfit = r2(grossRev - totalCost)

    exVat = r2(grossRev / (1 + VAT))
    outputVAT = r2(grossRev - exVat)
    excP, excD, excK = r2(pL * EX_P), r2(dL * EX_D), r2(kL * EX_K)
    totalExcise = r2(excP + excD + excK)

    return {
        "petrol_litres": r2(pL), "diesel_litres": r2(dL), "kero_litres": r2(kL),
        "total_litres": totalL,
        "petrol_revenue": pRev, "diesel_revenue": dRev, "kero_revenue": kRev,
        "petrol_margin": r2(pRev - pFC), "diesel_margin": r2(dRev - dFC), "kero_margin": r2(kRev - kFC),
        "gas_lube_revenue": gas_lube_rev, "gas_revenue": gas_rev_only, "lube_revenue": lube_rev_only,
        **pump,
        "total_pump_sales": r2(pump["petrol_pump_sales"] + pump["diesel_pump_sales"] + pump["kero_pump_sales"]),
        **dips,
        "gross_revenue": grossRev,
        "total_fuel_cost": totalFC,
        "exp_misc": exp_misc,
        "total_expenses": totalExp,
        "total_cost": totalCost,
        "net_profit": netProfit,
        "profit_margin": r2(netProfit / grossRev * 100) if grossRev > 0 else 0,
        "revenue_per_litre": r2(grossRev / totalL) if totalL > 0 else 0,
        "profit_per_litre": r2(netProfit / totalL) if totalL > 0 else 0,
        "collected": collected,
        "collection_variance": r2(grossRev - collected),
        "till_balance": r2(cash + g("float_amount") - g("banked_amount")),
        "taxable_sales": exVat,
        "output_vat": outputVAT,
        "excise_petrol": excP, "excise_diesel": excD, "excise_kero": excK,
        "total_excise": totalExcise,
        "road_levy_petrol": r2(pL * RL_P), "road_levy_diesel": r2(dL * RL_D),
        "total_tax": r2(outputVAT + totalExcise),
    }


def clean_input(body):
    """Validate and normalise a record payload from a client."""
    if not isinstance(body, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object")

    date = str(body.get("report_date") or "").strip()
    if not DATE_RE.match(date):
        raise ApiError(HTTPStatus.BAD_REQUEST, "report_date is required (YYYY-MM-DD)")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise ApiError(HTTPStatus.BAD_REQUEST, "report_date is not a valid date")

    station = str(body.get("station") or "").strip()
    if not station:
        raise ApiError(HTTPStatus.BAD_REQUEST, "station is required")

    rec = {"report_date": date, "station": station[:120]}
    for k in NUM_FIELDS:
        rec[k] = num(body.get(k))
    for k in TEXT_FIELDS:
        v = body.get(k)
        rec[k] = "" if v is None else str(v)[:2000]
    for k in LIST_FIELDS:
        v = body.get(k)
        if v is None:
            v = []
        if not isinstance(v, list) or not all(isinstance(i, dict) for i in v):
            raise ApiError(HTTPStatus.BAD_REQUEST, f"{k} must be a list of objects")
        rec[k] = v[:500]
    return rec


# ── Storage ───────────────────────────────────────────────────────────────────
class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS records (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                report_date    TEXT NOT NULL,
                station        TEXT NOT NULL,
                gross_revenue  REAL NOT NULL DEFAULT 0,
                total_litres   REAL NOT NULL DEFAULT 0,
                net_profit     REAL NOT NULL DEFAULT 0,
                total_tax      REAL NOT NULL DEFAULT 0,
                data           TEXT NOT NULL,
                created_at     TEXT NOT NULL,
                updated_at     TEXT NOT NULL,
                UNIQUE (report_date, station)
            );
            CREATE INDEX IF NOT EXISTS idx_records_date ON records (report_date);
        """)
        self.conn.commit()

    @staticmethod
    def _row(row):
        rec = json.loads(row["data"])
        rec["id"] = row["id"]
        rec["uid"] = "rec_" + str(row["id"])
        rec["created_at"] = row["created_at"]
        rec["updated_at"] = row["updated_at"]
        return rec

    def list(self, station=None, date=None, date_from=None, date_to=None, limit=None):
        sql, args = "SELECT * FROM records WHERE 1=1", []
        if station:
            sql += " AND station = ?"; args.append(station)
        if date:
            sql += " AND report_date = ?"; args.append(date)
        if date_from:
            sql += " AND report_date >= ?"; args.append(date_from)
        if date_to:
            sql += " AND report_date <= ?"; args.append(date_to)
        sql += " ORDER BY report_date DESC, id DESC"
        if limit:
            sql += " LIMIT ?"; args.append(limit)
        with self.lock:
            return [self._row(r) for r in self.conn.execute(sql, args).fetchall()]

    def get(self, rec_id):
        with self.lock:
            row = self.conn.execute("SELECT * FROM records WHERE id = ?", (rec_id,)).fetchone()
        return self._row(row) if row else None

    def save(self, rec, rec_id=None):
        """Insert, or update the existing row for the same date+station (or id)."""
        rec = {**rec, **compute(rec)}
        ts = now_iso()
        data = json.dumps(rec)
        cols = (rec["report_date"], rec["station"], rec["gross_revenue"],
                rec["total_litres"], rec["net_profit"], rec["total_tax"], data)
        with self.lock:
            if rec_id is not None:
                if not self.conn.execute("SELECT 1 FROM records WHERE id = ?", (rec_id,)).fetchone():
                    raise ApiError(HTTPStatus.NOT_FOUND, "Record not found")
                clash = self.conn.execute(
                    "SELECT id FROM records WHERE report_date = ? AND station = ? AND id != ?",
                    (rec["report_date"], rec["station"], rec_id)).fetchone()
                if clash:
                    raise ApiError(HTTPStatus.CONFLICT,
                                   "Another record already exists for this date and station")
                existing_id, created = rec_id, False
            else:
                row = self.conn.execute(
                    "SELECT id FROM records WHERE report_date = ? AND station = ?",
                    (rec["report_date"], rec["station"])).fetchone()
                existing_id, created = (row["id"], False) if row else (None, True)

            if existing_id is None:
                cur = self.conn.execute(
                    """INSERT INTO records (report_date, station, gross_revenue, total_litres,
                       net_profit, total_tax, data, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", cols + (ts, ts))
                new_id = cur.lastrowid
            else:
                self.conn.execute(
                    """UPDATE records SET report_date = ?, station = ?, gross_revenue = ?,
                       total_litres = ?, net_profit = ?, total_tax = ?, data = ?, updated_at = ?
                       WHERE id = ?""", cols + (ts, existing_id))
                new_id = existing_id
            self.conn.commit()
        return self.get(new_id), created

    def delete(self, rec_id):
        with self.lock:
            cur = self.conn.execute("DELETE FROM records WHERE id = ?", (rec_id,))
            self.conn.commit()
        return cur.rowcount

    def delete_all(self, station=None):
        with self.lock:
            if station:
                cur = self.conn.execute("DELETE FROM records WHERE station = ?", (station,))
            else:
                cur = self.conn.execute("DELETE FROM records")
            self.conn.commit()
        return cur.rowcount


def analytics(records):
    week = sorted(records, key=lambda r: r.get("report_date") or "", reverse=True)[:7][::-1]
    totals = {"days": len(records), "revenue": 0.0, "litres": 0.0, "net_profit": 0.0,
              "tax": 0.0, "mpesa": 0.0, "cash": 0.0}
    for r in records:
        totals["revenue"] += num(r.get("gross_revenue"))
        totals["litres"] += num(r.get("total_litres"))
        totals["net_profit"] += num(r.get("net_profit"))
        totals["tax"] += num(r.get("total_tax"))
        totals["mpesa"] += num(r.get("mpesa_amount"))
        totals["cash"] += num(r.get("cash_amount"))
    totals = {k: (r2(v) if isinstance(v, float) else v) for k, v in totals.items()}
    totals["avg_daily_profit"] = r2(totals["net_profit"] / totals["days"]) if totals["days"] else 0
    return {
        "last_7": [{"report_date": r["report_date"], "station": r["station"],
                    "gross_revenue": r.get("gross_revenue", 0),
                    "net_profit": r.get("net_profit", 0),
                    "total_litres": r.get("total_litres", 0)} for r in week],
        "totals": totals,
    }


def to_csv(records):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(CSV_COLS)
    for r in records:
        w.writerow(["" if r.get(c) is None else r.get(c) for c in CSV_COLS])
    return buf.getvalue()


# ── HTTP layer ────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "PetroKenyaAPI/1.0"
    store = None  # set in make_server()

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # Responses
    def _send(self, status, body=b"", ctype="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, json.dumps(payload).encode("utf-8"))

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body too large")
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid JSON body")

    def _dispatch(self):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        m = self.command
        try:
            if m == "OPTIONS":
                return self._send(HTTPStatus.NO_CONTENT)
            if path in ("/", "/index.html") and m in ("GET", "HEAD"):
                with open(INDEX_FILE, "rb") as f:
                    return self._send(HTTPStatus.OK, f.read(), "text/html; charset=utf-8")
            if not path.startswith("/api"):
                raise ApiError(HTTPStatus.NOT_FOUND, "Not found")

            if path == "/api/health" and m == "GET":
                return self._json(HTTPStatus.OK, {"status": "ok", "time": now_iso(),
                                                  "db": os.path.basename(self.store.path)})
            if path == "/api/stations" and m == "GET":
                return self._json(HTTPStatus.OK, {"stations": STATIONS})
            if path == "/api/compute" and m == "POST":
                body = self._body()
                if not isinstance(body, dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object")
                return self._json(HTTPStatus.OK, compute(body))
            if path == "/api/analytics" and m == "GET":
                return self._json(HTTPStatus.OK, analytics(self.store.list(station=q.get("station"))))
            if path == "/api/export.csv" and m == "GET":
                station = q.get("station")
                name = "PetroKenya_%s_%s.csv" % (
                    (station or "All-Branches").replace(" ", "-"), datetime.now().strftime("%Y-%m-%d"))
                return self._send(HTTPStatus.OK, to_csv(self.store.list(station=station)).encode("utf-8"),
                                  "text/csv; charset=utf-8",
                                  {"Content-Disposition": 'attachment; filename="%s"' % name})

            if path == "/api/records":
                if m == "GET":
                    limit = q.get("limit")
                    limit = int(limit) if limit and limit.isdigit() else None
                    recs = self.store.list(q.get("station"), q.get("date"),
                                           q.get("from"), q.get("to"), limit)
                    return self._json(HTTPStatus.OK, {"count": len(recs), "records": recs})
                if m == "POST":
                    rec, created = self.store.save(clean_input(self._body()))
                    return self._json(HTTPStatus.CREATED if created else HTTPStatus.OK,
                                      {"created": created, "record": rec})
                if m == "DELETE":
                    n = self.store.delete_all(q.get("station"))
                    return self._json(HTTPStatus.OK, {"deleted": n})

            mm = re.fullmatch(r"/api/records/(\d+)", path)
            if mm:
                rec_id = int(mm.group(1))
                if m == "GET":
                    rec = self.store.get(rec_id)
                    if not rec:
                        raise ApiError(HTTPStatus.NOT_FOUND, "Record not found")
                    return self._json(HTTPStatus.OK, rec)
                if m == "PUT":
                    rec, _ = self.store.save(clean_input(self._body()), rec_id=rec_id)
                    return self._json(HTTPStatus.OK, {"created": False, "record": rec})
                if m == "DELETE":
                    if not self.store.delete(rec_id):
                        raise ApiError(HTTPStatus.NOT_FOUND, "Record not found")
                    return self._json(HTTPStatus.OK, {"deleted": 1})

            raise ApiError(HTTPStatus.NOT_FOUND if m in ("GET", "HEAD") else HTTPStatus.METHOD_NOT_ALLOWED,
                           "No route for %s %s" % (m, path))
        except ApiError as e:
            self._json(e.status, {"error": e.message})
        except Exception as e:  # pragma: no cover - last-resort guard
            self.log_message("Unhandled error: %r", e)
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Internal server error"})

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = do_HEAD = _dispatch


def make_server(host=HOST, port=PORT, db_path=DB_PATH):
    handler = type("BoundHandler", (Handler,), {"store": Store(db_path)})
    return ThreadingHTTPServer((host, port), handler)


def main():
    httpd = make_server()
    host, port = httpd.server_address[:2]
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    print(f"⛽ PetroKenya running at http://{shown}:{port}")
    print(f"   API:      http://{shown}:{port}/api/health")
    print(f"   Database: {httpd.RequestHandlerClass.store.path}")
    print("   Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
