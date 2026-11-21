#!/usr/bin/env python3
"""PetroKenya backend.

Serves the installable web app in ../frontend and a JSON REST API backed by
SQLite, with user accounts so several branches can share one online server.
Uses only the Python standard library.

    python3 backend/server.py                       # http://localhost:8000
    python3 backend/server.py create-user NAME --role admin
    python3 backend/server.py create-user NAME --role staff --station "Moiben Branch"
    python3 backend/server.py reset-password NAME

Environment
    PORT, HOST            listen address (default 127.0.0.1:8000; use HOST=0.0.0.0 when hosted)
    PK_DB                 SQLite file (default backend/petrokenya.sqlite3)
    PK_UPLOADS            folder for receipt photos (default: "uploads" next to the database)
    PK_ADMIN_USER/PK_ADMIN_PASSWORD   create this admin on first start if no users exist
    PK_SECURE_COOKIE=1    force the Secure cookie flag (auto-on behind HTTPS proxies)
    PK_SMTP_HOST, PK_SMTP_PORT, PK_SMTP_USER, PK_SMTP_PASSWORD, PK_SMTP_FROM
                          mail account for alert emails (recipients are set in the app)
    PK_TRUST_PROXY=1      read the visitor's address from X-Forwarded-For; set ONLY behind
                          a proxy you control (e.g. Render), never when serving directly

API (all JSON; everything except /api/health and /api/login needs a signed-in session)
    POST   /api/login  /api/logout       GET /api/me     POST /api/me/password
    GET|POST /api/stations   PUT /api/stations/<name> {name} (rename)   DELETE /api/stations/<name> (only unused)   POST /api/compute
    GET    /api/records?station=&date=&from=&to=&limit=
    POST   /api/records                  (upserts on report_date + station)
    GET|PUT|DELETE /api/records/<id>     DELETE /api/records?station=   (admin; moves to bin)
    GET    /api/records/<id>/history     every saved version and what changed
    GET    /api/bin   POST /api/bin/<id>/restore   DELETE /api/bin/<id>   (admin)
    POST   /api/me/logout-all            POST /api/users/<id>/logout   (admin)
    POST   /api/password/forgot {username}    POST /api/password/reset {username, code, new_password}
    POST   /api/me/contact {email, phone}     PUT /api/users/<id>/contact   (admin)
    POST   /api/records/<id>/approve     (manager of the branch, admin)
    POST   /api/records/<id>/reopen      (admin)
    GET    /api/records/previous?station=&date=     latest saved day before a date
    GET    /api/prices?station=&date=    POST /api/prices (admin)   GET /api/prices/history
    GET|POST /api/customers   PUT /api/customers/<id> (manager, admin)
    GET    /api/customers/<id>/statement  POST /api/customers/<id>/payments
    POST   /api/payments/<id>/void       (admin)
    GET    /api/alerts?all=1             POST /api/alerts/read {ids|all}   (manager, admin)
    GET|PUT /api/settings   POST /api/settings/test-email   (admin)
    GET    /api/reports/monthly?month=YYYY-MM&station=   (.csv for a download)
    POST   /api/uploads {data: base64 photo, station}   GET /api/uploads/<id>
    GET|POST /api/backups   POST /api/backups/email   GET /api/backups/<name>   (admin)
    GET    /api/analytics?station=       GET /api/export.csv?station=
    GET|POST /api/users   DELETE /api/users/<id>   POST /api/users/<id>/password   (admin)

Roles: "admin" manages users and all branches. "manager" runs one branch: any
earlier day, and approves days, which locks them until an admin reopens them. "staff" with a station can only
see and edit that branch; staff without a station can use every branch but
cannot bulk-delete or manage users. Staff may only change today's and
yesterday's records. Deleting moves a record to the bin, and every change is
kept in the record's history.
"""

import csv
import getpass
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import business

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.realpath(os.path.join(BACKEND_DIR, "..", "frontend"))
DB_PATH = os.environ.get("PK_DB", os.path.join(BACKEND_DIR, "petrokenya.sqlite3"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 2 * 1024 * 1024
SESSION_DAYS = 7                 # a sign-in lasts at most this long
IDLE_HOURS = 8                   # ...and ends early after this long without use
COOKIE = "pk_session"
PBKDF2_ROUNDS = 240_000
LOGIN_MAX_FAILS, LOGIN_WINDOW = 5, 15 * 60   # wrong passwords per device before a pause
ACCOUNT_MAX_FAILS = 10                       # wrong passwords per account, from any device
RESET_CODE_MINUTES = 15                      # a password reset code works this long
RESET_CODE_TRIES = 5                         # wrong codes before it stops working
RESET_REQUESTS_PER_IP, RESET_REQUESTS_PER_ACCOUNT = 5, 3   # code requests per 15 minutes
STAFF_EDIT_DAYS = 1              # staff may change today's and yesterday's records only
# Only behind a proxy we control (Render etc.) may X-Forwarded-For name the client;
# otherwise anyone could fake it to dodge the login limits
TRUST_PROXY = os.environ.get("PK_TRUST_PROXY") == "1"
KENYA_TZ = timezone(timedelta(hours=3))

# Branch names are added by the admin in the app (Store.add_station); a new install has none.
STATION_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .,'&()/-]{1,59}$")

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")

# ── Statutory rates (same constants as the dashboard) ─────────────────────────
VAT = 0.16
EX_P, EX_D, EX_K = 21.95, 7.21, 7.19   # excise per litre
RL_P, RL_D = 18.00, 13.19              # road levy per litre

# The station's pumps: three petrol, three diesel and one kerosene. Each has its own
# litres meter and sales (KES) meter; a fuel's totals are the sum over its pumps.
PUMPS = [("p1", "petrol"), ("p2", "petrol"), ("p3", "petrol"),
         ("d1", "diesel"), ("d2", "diesel"), ("d3", "diesel"),
         ("k1", "kero")]
PUMP_READINGS = ("open", "close", "sales_open", "sales_close")
PUMP_FIELDS = ["pump_%s_%s" % (pid, x) for pid, _ in PUMPS for x in PUMP_READINGS]

# Raw numeric inputs accepted from clients
NUM_FIELDS = PUMP_FIELDS + [
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
LIST_FIELDS = ["misc_items", "gas_items", "invoices", "deliveries", "attendants", "receipts"]
FUELS = ("petrol", "diesel", "kero")

CSV_COLS = [
    "report_date", "station", "operator",
    "petrol_litres", "diesel_litres", "kero_litres", "total_litres",
    "gross_revenue", "mpesa_amount", "cash_amount", "credit_amount", "card_amount",
    "total_expenses", "net_profit", "profit_margin",
    "output_vat", "total_excise", "total_tax",
    "kra_pin", "kra_business", "kra_period", "kra_return_type",
    "created_at",
]

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Cost, margin and profit figures: only managers and admins see them, never pump staff
PRIVATE_KEYS = frozenset(
    ["cost", "total_fuel_cost", "total_cost", "net_profit", "profit_margin", "profit_per_litre",
     "avg_daily_profit"] + [f + "_cost" for f in FUELS] + [f + "_margin" for f in FUELS])


def hide_private(value):
    """Copy of an API payload with every cost, margin and profit figure taken out.
    Change-history entries and report columns about those fields go too."""
    if isinstance(value, dict):
        return {k: hide_private(v) for k, v in value.items() if k not in PRIVATE_KEYS}
    if isinstance(value, list):
        return [hide_private(v) for v in value
                if not (isinstance(v, dict) and (v.get("field") in PRIVATE_KEYS
                                                 or ("label" in v and v.get("key") in PRIVATE_KEYS)))]
    return value


def sees_private(user):
    return bool(user) and user.get("role") != "staff"

# Fields compared between versions in a record's change history
HISTORY_FIELDS = ["report_date", "station"] + NUM_FIELDS + [
    f for f in TEXT_FIELDS if f != "operator"] + LIST_FIELDS


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


def today():
    """Today's date in Kenya, as YYYY-MM-DD (tests replace this)."""
    return datetime.now(KENYA_TZ).strftime("%Y-%m-%d")


def days_before(date_str, days):
    return (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


# ── Computation engine — mirrors compute() in frontend/js/app.js ──────────────────────
def has_pumps(raw, fuel):
    """True when the record holds per-pump readings for this fuel (older records only have totals)."""
    return any(num(raw.get("pump_%s_%s" % (pid, x))) for pid, f in PUMPS if f == fuel for x in PUMP_READINGS)


def meter_total(raw, fuel, kind):
    """Litres (kind "") or KES (kind "sales_") a fuel's pumps moved: closing − opening per pump.
    A pump whose closing reading isn't in yet counts as nothing sold."""
    if has_pumps(raw, fuel):
        return r2(sum(max(0.0, num(raw.get("pump_%s_%sclose" % (pid, kind))) - num(raw.get("pump_%s_%sopen" % (pid, kind))))
                      for pid, f in PUMPS if f == fuel))
    return r2(max(0.0, num(raw.get(fuel + "_" + kind + "close")) - num(raw.get(fuel + "_" + kind + "open"))))


def roll_up_pumps(rec):
    """Keep each fuel's total meter fields as the sum of its pumps, for reports and older screens."""
    for fuel in FUELS:
        if not has_pumps(rec, fuel):
            continue
        for x in PUMP_READINGS:
            rec["%s_%s" % (fuel, x)] = r2(sum(num(rec.get("pump_%s_%s" % (pid, x))) for pid, f in PUMPS if f == fuel))
    return rec


def compute(raw):
    g = lambda k: num(raw.get(k))
    gas_items = raw.get("gas_items") or []
    misc_items = raw.get("misc_items") or []

    line = lambda i: num(i.get("qty")) * num(i.get("price"))
    gas_lube_rev = r2(sum(line(i) for i in gas_items))
    gas_rev_only = r2(sum(line(i) for i in gas_items if i.get("category") == "Gas"))
    lube_rev_only = r2(sum(line(i) for i in gas_items if i.get("category") == "Lubricant"))

    pL, dL, kL = (meter_total(raw, f, "") for f in FUELS)
    pRev, dRev, kRev = r2(pL * g("petrol_price")), r2(dL * g("diesel_price")), r2(kL * g("kero_price"))
    pFC, dFC, kFC = r2(pL * g("petrol_cost")), r2(dL * g("diesel_cost")), r2(kL * g("kero_cost"))
    totalL = r2(pL + dL + kL)
    grossRev = r2(pRev + dRev + kRev + gas_lube_rev)
    totalFC = r2(pFC + dFC + kFC)

    # Deliveries: litres received per fuel, and how far short of the order they came
    deliveries = raw.get("deliveries") or []
    delivery_short = r2(sum(max(0.0, num(d.get("litres_ordered")) - num(d.get("litres_received")))
                            for d in deliveries))
    # Cash per attendant: what each handed in (cash + M-Pesa) against their pumps' sales
    attendants = raw.get("attendants") or []
    att_gap = [num(a.get("expected")) - num(a.get("cash")) - num(a.get("mpesa")) for a in attendants]

    pump = {}
    for prefix, rev in (("petrol", pRev), ("diesel", dRev), ("kero", kRev)):
        sales = r2(meter_total(raw, prefix, "sales_"))
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
        "delivery_shortfall_litres": delivery_short,
        "attendant_shortage_total": r2(sum(g for g in att_gap if g > 0)),
        "attendant_excess_total": r2(-sum(g for g in att_gap if g < 0)),
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
        rec[k] = [clean_item(i) for i in v[:500]]
    # Logged deliveries decide the litres received; the typed totals are only used without them
    deliveries = [d for d in rec["deliveries"] if d.get("fuel") in FUELS]
    rec["deliveries"] = deliveries
    if deliveries:
        for fuel in FUELS:
            rec[fuel + "_delivered"] = r2(sum(num(d.get("litres_received"))
                                              for d in deliveries if d.get("fuel") == fuel))
    return roll_up_pumps(rec)


# Opening readings that should equal the previous day's closing readings
# (per pump where the previous day has pump readings, else the fuel's totals)
PUMP_OPENING_PAIRS = [("pump_%s_%sopen" % (pid, k), "pump_%s_%sclose" % (pid, k), fuel)
                      for pid, fuel in PUMPS for k in ("", "sales_")]
TOTAL_OPENING_PAIRS = [(f + "_open", f + "_close", f) for f in FUELS] + \
    [(f + "_sales_open", f + "_sales_close", f) for f in FUELS]
DIP_OPENING_PAIRS = [(f + "_dip_open", f + "_dip_close") for f in FUELS]


def opening_mismatches(rec, previous):
    """Openings that differ from the previous saved day's closings (meter tampering or typos)."""
    if not previous:
        return []
    pumped = {f: has_pumps(previous, f) for f in FUELS}
    pairs = [(o, c) for o, c, f in PUMP_OPENING_PAIRS if pumped[f]] + \
        [(o, c) for o, c, f in TOTAL_OPENING_PAIRS if not pumped[f]] + DIP_OPENING_PAIRS
    out = []
    for open_f, close_f in pairs:
        expected, entered = num(previous.get(close_f)), num(rec.get(open_f))
        if expected > 0 and abs(expected - entered) > 0.005:
            out.append({"field": open_f, "expected": expected, "entered": entered,
                        "from_date": previous["report_date"]})
    return out


# Item fields that must be numbers; everything else in an item is kept as short text
ITEM_NUM_FIELDS = {"id", "qty", "price", "amount", "customer_id",
                   "litres_ordered", "litres_received", "dip_before", "dip_after",
                   "expected", "cash", "mpesa"}


def clean_item(item):
    out = {}
    for key, val in list(item.items())[:30]:
        key = str(key)[:40]
        out[key] = num(val) if key in ITEM_NUM_FIELDS else ("" if val is None else str(val)[:300])
    return out


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
            CREATE TABLE IF NOT EXISTS record_versions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id   INTEGER NOT NULL,
                report_date TEXT NOT NULL,
                station     TEXT NOT NULL,
                action      TEXT NOT NULL,
                data        TEXT NOT NULL,
                by_user     TEXT NOT NULL,
                at          TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_versions_record ON record_versions (record_id);
            CREATE TABLE IF NOT EXISTS prices (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                station        TEXT NOT NULL,
                fuel           TEXT NOT NULL,
                sell           REAL NOT NULL,
                cost           REAL NOT NULL,
                effective_from TEXT NOT NULL,
                set_by         TEXT NOT NULL,
                set_at         TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_prices ON prices (station, fuel, effective_from);
        """)
        # Columns added after the first release are added in place on older databases
        cols = [r["name"] for r in self.conn.execute("PRAGMA table_info(records)").fetchall()]
        for col in ("deleted_at", "deleted_by", "approved_at", "approved_by"):
            if col not in cols:
                self.conn.execute("ALTER TABLE records ADD COLUMN %s TEXT" % col)
        # Branches the admin has added. Databases from before this list existed keep the
        # branches already in use by their users and records; a new one starts empty.
        tables = {r["name"] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "stations" not in tables:
            self.conn.execute("""CREATE TABLE stations (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                created_by TEXT NOT NULL, created_at TEXT NOT NULL)""")
            used = [r[0] for r in self.conn.execute("SELECT DISTINCT station FROM records ORDER BY station")]
            if "users" in tables:
                used += [r[0] for r in self.conn.execute(
                    "SELECT DISTINCT station FROM users WHERE station IS NOT NULL ORDER BY station")]
            for name in dict.fromkeys(n for n in used if n):
                self.conn.execute("INSERT OR IGNORE INTO stations (name, created_by, created_at) VALUES (?, ?, ?)",
                                  (name, "system", now_iso()))
        self.conn.commit()

    # ── Branches ──
    def stations(self):
        with self.lock:
            return [r["name"] for r in self.conn.execute("SELECT name FROM stations ORDER BY id")]

    def has_station(self, name):
        return bool(name) and name in self.stations()

    def add_station(self, name, by):
        name = re.sub(r"\s+", " ", str(name or "")).strip()
        if not STATION_NAME_RE.match(name):
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           "Branch name must be 2-60 letters, numbers, spaces or . , ' & ( ) / -")
        try:
            with self.lock:
                self.conn.execute("INSERT INTO stations (name, created_by, created_at) VALUES (?, ?, ?)",
                                  (name, by, now_iso()))
                self.conn.commit()
        except sqlite3.IntegrityError:
            same = next((n for n in self.stations() if n.lower() == name.lower()), name)
            raise ApiError(HTTPStatus.CONFLICT, "There is already a branch called %s" % same)
        return name

    def rename_station(self, old, new):
        """Give a branch a new name everywhere it is stored, all at once: saved days and their
        history, users, prices, alerts, credit payments and receipt photos."""
        new = re.sub(r"\s+", " ", str(new or "")).strip()
        if old not in self.stations():
            raise ApiError(HTTPStatus.NOT_FOUND, "Branch not found")
        if not STATION_NAME_RE.match(new):
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           "Branch name must be 2-60 letters, numbers, spaces or . , ' & ( ) / -")
        if new == old:
            return new
        taken = next((n for n in self.stations() if n.lower() == new.lower() and n != old), None)
        if taken:
            raise ApiError(HTTPStatus.CONFLICT, "There is already a branch called %s" % taken)
        with self.lock:
            c = self.conn
            tables = {r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            try:
                c.execute("UPDATE stations SET name = ? WHERE name = ?", (new, old))
                c.execute("UPDATE records SET station = ?, data = json_set(data, '$.station', ?) WHERE station = ?",
                          (new, new, old))
                c.execute("UPDATE record_versions SET data = json_set(data, '$.station', ?) "
                          "WHERE json_extract(data, '$.station') = ?", (new, old))
                c.execute("UPDATE record_versions SET station = ? WHERE station = ?", (new, old))
                for table in ("users", "prices", "credit_payments", "uploads"):
                    if table in tables:
                        c.execute("UPDATE %s SET station = ? WHERE station = ?" % table, (new, old))
                if "alerts" in tables:
                    c.execute("UPDATE alerts SET station = ?, message = replace(message, ?, ?) WHERE station = ?",
                              (new, old, new, old))
                c.commit()
            except Exception:
                c.rollback()
                raise
        return new

    def remove_station(self, name):
        """Only a branch nothing refers to can go, so no record or user is left without one."""
        if name not in self.stations():
            raise ApiError(HTTPStatus.NOT_FOUND, "Branch not found")
        with self.lock:
            used = self.conn.execute("SELECT COUNT(*) FROM records WHERE station = ?", (name,)).fetchone()[0]
            users = self.conn.execute("SELECT COUNT(*) FROM users WHERE station = ?", (name,)).fetchone()[0]
            if used or users:
                raise ApiError(HTTPStatus.CONFLICT,
                               "%s still has %d saved day(s) and %d user(s) — it can only be removed while unused"
                               % (name, used, users))
            self.conn.execute("DELETE FROM stations WHERE name = ?", (name,))
            self.conn.execute("DELETE FROM prices WHERE station = ?", (name,))
            self.conn.commit()

    @staticmethod
    def _row(row):
        rec = json.loads(row["data"])
        rec["id"] = row["id"]
        rec["uid"] = "rec_" + str(row["id"])
        rec["created_at"] = row["created_at"]
        rec["updated_at"] = row["updated_at"]
        for col in ("deleted_at", "deleted_by", "approved_at", "approved_by"):
            rec[col] = row[col]
        return rec

    def _version(self, rec_id, action, by):
        """Keep a full copy of the record as it stands after every change."""
        row = self.conn.execute("SELECT * FROM records WHERE id = ?", (rec_id,)).fetchone()
        self.conn.execute(
            "INSERT INTO record_versions (record_id, report_date, station, action, data, by_user, at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (rec_id, row["report_date"], row["station"], action, row["data"], by or "system", now_iso()))

    def list(self, station=None, date=None, date_from=None, date_to=None, limit=None, deleted=False):
        sql = "SELECT * FROM records WHERE deleted_at IS %s" % ("NOT NULL" if deleted else "NULL")
        args = []
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

    def get(self, rec_id, deleted=False):
        with self.lock:
            row = self.conn.execute(
                "SELECT * FROM records WHERE id = ? AND deleted_at IS %s" % ("NOT NULL" if deleted else "NULL"),
                (rec_id,)).fetchone()
        return self._row(row) if row else None

    def previous(self, station, report_date):
        """The latest saved record for a branch before a date."""
        with self.lock:
            row = self.conn.execute(
                "SELECT * FROM records WHERE station = ? AND report_date < ? AND deleted_at IS NULL"
                " ORDER BY report_date DESC LIMIT 1", (station, report_date)).fetchone()
        return self._row(row) if row else None

    def set_approval(self, rec_id, by, approve):
        with self.lock:
            if approve:
                cur = self.conn.execute(
                    "UPDATE records SET approved_at = ?, approved_by = ? WHERE id = ? AND approved_at IS NULL"
                    " AND deleted_at IS NULL", (now_iso(), by, rec_id))
            else:
                cur = self.conn.execute(
                    "UPDATE records SET approved_at = NULL, approved_by = NULL WHERE id = ?"
                    " AND approved_at IS NOT NULL AND deleted_at IS NULL", (rec_id,))
            if cur.rowcount:
                self._version(rec_id, "approve" if approve else "reopen", by)
            self.conn.commit()
        return cur.rowcount

    def find_day(self, station, report_date):
        """The record for a branch and day, including one sitting in the bin."""
        with self.lock:
            row = self.conn.execute("SELECT * FROM records WHERE station = ? AND report_date = ?",
                                    (station, report_date)).fetchone()
        return self._row(row) if row else None

    def save(self, rec, rec_id=None, by=None):
        """Insert, or update the existing row for the same date+station (or id).
        A day that was moved to the bin comes back out when it is saved again."""
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
                    "SELECT id, deleted_at FROM records WHERE report_date = ? AND station = ?",
                    (rec["report_date"], rec["station"])).fetchone()
                existing_id = row["id"] if row else None
                created = not row or row["deleted_at"] is not None

            if existing_id is None:
                cur = self.conn.execute(
                    """INSERT INTO records (report_date, station, gross_revenue, total_litres,
                       net_profit, total_tax, data, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", cols + (ts, ts))
                new_id = cur.lastrowid
            else:
                self.conn.execute(
                    """UPDATE records SET report_date = ?, station = ?, gross_revenue = ?,
                       total_litres = ?, net_profit = ?, total_tax = ?, data = ?, updated_at = ?,
                       deleted_at = NULL, deleted_by = NULL
                       WHERE id = ?""", cols + (ts, existing_id))
                new_id = existing_id
            self._version(new_id, "create" if created else "update", by)
            self.conn.commit()
        return self.get(new_id), created

    def delete(self, rec_id, by=None):
        """Move a record to the bin. Nothing is erased; an admin can restore it."""
        with self.lock:
            cur = self.conn.execute(
                "UPDATE records SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL",
                (now_iso(), by, rec_id))
            if cur.rowcount:
                self._version(rec_id, "delete", by)
            self.conn.commit()
        return cur.rowcount

    def delete_all(self, station=None, by=None):
        with self.lock:
            sql, args = "SELECT id FROM records WHERE deleted_at IS NULL", []
            if station:
                sql += " AND station = ?"; args.append(station)
            ids = [r["id"] for r in self.conn.execute(sql, args).fetchall()]
            ts = now_iso()
            for rec_id in ids:
                self.conn.execute("UPDATE records SET deleted_at = ?, deleted_by = ? WHERE id = ?",
                                  (ts, by, rec_id))
                self._version(rec_id, "delete", by)
            self.conn.commit()
        return len(ids)

    def restore(self, rec_id, by=None):
        with self.lock:
            cur = self.conn.execute(
                "UPDATE records SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL",
                (rec_id,))
            if cur.rowcount:
                self._version(rec_id, "restore", by)
            self.conn.commit()
        return cur.rowcount

    def purge(self, rec_id, by=None):
        """Erase a binned record for good. Its history is kept, ending with the purge."""
        with self.lock:
            row = self.conn.execute("SELECT 1 FROM records WHERE id = ? AND deleted_at IS NOT NULL",
                                    (rec_id,)).fetchone()
            if not row:
                return 0
            self._version(rec_id, "purge", by)
            self.conn.execute("DELETE FROM records WHERE id = ?", (rec_id,))
            self.conn.commit()
        return 1

    # ── Fuel prices set by the owner ──
    def effective_prices(self, station, date):
        """Selling and cost price per fuel in force for a branch on a date (latest wins)."""
        out = {}
        with self.lock:
            for fuel in FUELS:
                row = self.conn.execute(
                    "SELECT * FROM prices WHERE station = ? AND fuel = ? AND effective_from <= ?"
                    " ORDER BY effective_from DESC, id DESC LIMIT 1", (station, fuel, date)).fetchone()
                if row:
                    out[fuel] = {"sell": row["sell"], "cost": row["cost"],
                                 "effective_from": row["effective_from"], "set_by": row["set_by"]}
        return out

    def set_price(self, station, fuel, sell, cost, effective_from, by):
        with self.lock:
            self.conn.execute(
                "INSERT INTO prices (station, fuel, sell, cost, effective_from, set_by, set_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)", (station, fuel, sell, cost, effective_from, by, now_iso()))
            self.conn.commit()

    def price_history(self, station=None, limit=200):
        sql, args = "SELECT * FROM prices", []
        if station:
            sql += " WHERE station = ?"; args.append(station)
        sql += " ORDER BY effective_from DESC, id DESC LIMIT ?"; args.append(limit)
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def history(self, rec_id):
        """Every saved version of a record, oldest first, with the fields each one changed."""
        with self.lock:
            rows = self.conn.execute(
                "SELECT * FROM record_versions WHERE record_id = ? ORDER BY id", (rec_id,)).fetchall()
        out, prev = [], None
        for row in rows:
            data = json.loads(row["data"])
            changes = []
            if prev is not None and row["action"] in ("update", "create"):
                for field in HISTORY_FIELDS:
                    before, after = prev.get(field), data.get(field)
                    if json.dumps(before, sort_keys=True) != json.dumps(after, sort_keys=True):
                        changes.append({"field": field, "before": before, "after": after})
            out.append({"version": len(out) + 1, "action": row["action"], "by": row["by_user"],
                        "at": row["at"], "changes": changes})
            prev = data
        return out


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


def to_csv(records, private=True):
    cols = CSV_COLS if private else [c for c in CSV_COLS if c not in PRIVATE_KEYS]
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(cols)
    for r in records:
        w.writerow([csv_cell(r.get(c)) for c in cols])
    return buf.getvalue()


def csv_cell(v):
    """Text that starts like a formula is prefixed with ' so spreadsheet apps show it, not run it."""
    if v is None:
        return ""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v



# ── Accounts & sessions ───────────────────────────────────────────────────────
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{3,32}$")
EMAIL_RE = re.compile(r"^[^@\s<>\"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$")


def clean_email(value):
    email = str(value or "").strip()
    if email and not EMAIL_RE.match(email):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Check the email address")
    return email or None


def clean_phone(value):
    """Kenyan numbers in any usual form (0712 345 678, 254712345678, +254 712…) become +2547…;
    other countries must start with + and their code."""
    raw = str(value or "").strip()
    if not raw:
        return None
    digits = re.sub(r"[\s().-]", "", raw)
    if re.fullmatch(r"0[17]\d{8}", digits):
        digits = "+254" + digits[1:]
    elif re.fullmatch(r"254[17]\d{8}", digits):
        digits = "+" + digits
    elif re.fullmatch(r"[17]\d{8}", digits):
        digits = "+254" + digits
    if not re.fullmatch(r"\+[1-9]\d{7,14}", digits):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Check the phone number (e.g. 0712 345 678)")
    return digits


def mask_contact(value):
    """j•••@gmail.com / +254 7•• ••• 678 — enough to recognise, not enough to copy."""
    if not value:
        return ""
    if "@" in value:
        name, domain = value.split("@", 1)
        return name[:1] + "•••@" + domain
    return value[:5] + "•• ••• " + value[-3:]


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return "pbkdf2$%d$%s$%s" % (PBKDF2_ROUNDS, salt.hex(), dk.hex())


def verify_password(password, stored):
    try:
        _, rounds, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, AttributeError):
        return False


# Passwords that appear at the top of every leaked-password list, plus local favourites
COMMON_PASSWORDS = {
    "password", "password1", "password12", "password123", "passw0rd", "12345678", "123456789",
    "1234567890", "11111111", "00000000", "87654321", "12341234", "12121212", "abcd1234",
    "1234abcd", "1q2w3e4r", "qwerty12", "qwerty123", "qwertyui", "asdfghjk", "zxcvbnm1",
    "iloveyou", "letmein1", "welcome1", "changeme", "football", "sunshine", "princess",
    "admin123", "admin1234", "administrator", "jesus123", "blessed1", "kenya123", "kenya254",
    "nairobi1", "nairobi123", "mombasa1", "safaricom", "mpesa123", "petrokenya", "petrol123",
}


def check_new_password(password, username=None):
    if not isinstance(password, str) or len(password) < 8:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Password must be at least 8 characters")
    low = password.lower()
    if low in COMMON_PASSWORDS or len(set(low)) <= 2:
        raise ApiError(HTTPStatus.BAD_REQUEST, "That password is too easy to guess — choose another")
    if username and username.lower() in low:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Password must not contain the username")
    return password


class Auth:
    """Users and login sessions, stored in the same SQLite database as records."""

    def __init__(self, store):
        self.store = store
        self.fails = {}          # ip -> [count, first_failure_time]
        self.account_fails = {}  # username (lower case) -> [count, first_failure_time]
        store.conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
                pw_hash    TEXT NOT NULL,
                role       TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
                station    TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at REAL NOT NULL
            );
        """)
        # Databases from before the manager role only allow admin/staff; rebuild the table once
        table_sql = store.conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone()[0]
        if "'manager'" not in table_sql:
            old_cols = [r["name"] for r in store.conn.execute("PRAGMA table_info(users)").fetchall()]
            store.conn.executescript("""
                CREATE TABLE users_new (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    pw_hash    TEXT NOT NULL,
                    role       TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
                    station    TEXT,
                    created_at TEXT NOT NULL,
                    full_name  TEXT
                );
                INSERT INTO users_new (id, username, pw_hash, role, station, created_at%s)
                    SELECT id, username, pw_hash, role, station, created_at%s FROM users;
                DROP TABLE users;
                ALTER TABLE users_new RENAME TO users;
            """ % ((", full_name", ", full_name") if "full_name" in old_cols else ("", "")))
        # Databases created before full names existed get the column added in place
        cols = [r["name"] for r in store.conn.execute("PRAGMA table_info(users)").fetchall()]
        if "full_name" not in cols:
            store.conn.execute("ALTER TABLE users ADD COLUMN full_name TEXT")
        for col in ("email", "phone"):                      # contact details, for password resets
            if col not in cols:
                store.conn.execute("ALTER TABLE users ADD COLUMN %s TEXT" % col)
        store.conn.execute("""CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            code_hash TEXT NOT NULL, expires_at REAL NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
            used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)""")
        self.reset_requests = {}   # ip or account -> [count, first_request_time]
        scols = [r["name"] for r in store.conn.execute("PRAGMA table_info(sessions)").fetchall()]
        if "last_seen" not in scols:
            store.conn.execute("ALTER TABLE sessions ADD COLUMN last_seen REAL")
        store.conn.commit()

    @staticmethod
    def public(row):
        full_name = row["full_name"] or None
        return {"id": row["id"], "username": row["username"], "full_name": full_name,
                "display_name": full_name or row["username"], "role": row["role"],
                "station": row["station"] or None, "created_at": row["created_at"],
                "email": row["email"] if "email" in row.keys() else None,
                "phone": row["phone"] if "phone" in row.keys() else None}

    @staticmethod
    def clean_name(full_name):
        name = " ".join(str(full_name or "").split())
        if len(name) > 60:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Full name must be 60 characters or fewer")
        return name or None

    def set_full_name(self, user_id, full_name):
        with self.store.lock:
            self.store.conn.execute("UPDATE users SET full_name = ? WHERE id = ?",
                                    (self.clean_name(full_name), user_id))
            self.store.conn.commit()
        return self.get(user_id)

    def set_contact(self, user_id, email, phone):
        email, phone = clean_email(email), clean_phone(phone)
        with self.store.lock:
            cur = self.store.conn.execute("UPDATE users SET email = ?, phone = ? WHERE id = ?", (email, phone, user_id))
            self.store.conn.commit()
        if not cur.rowcount:
            raise ApiError(HTTPStatus.NOT_FOUND, "User not found")
        return self.get(user_id)

    # ── Forgotten passwords: a 6-digit code, sent by email or SMS, works once for 15 minutes ──
    @staticmethod
    def _code_hash(user_id, code):
        return hashlib.sha256(("%s:%s" % (user_id, code)).encode()).hexdigest()

    def start_reset(self, username, ip):
        """Make a reset code for the account, if it exists. Returns (user_row, code) or (None, None);
        the caller sends the code and always gives the same answer, so nobody can find out which
        usernames exist."""
        account = (username or "").strip().lower()
        if self._over(self.reset_requests, "ip:" + ip, RESET_REQUESTS_PER_IP):
            raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, "Too many requests — try again in 15 minutes")
        self.reset_requests.setdefault("ip:" + ip, [0, time.time()])[0] += 1
        row = self.find(username)
        if not row or self._over(self.reset_requests, "user:" + account, RESET_REQUESTS_PER_ACCOUNT):
            return None, None
        self.reset_requests.setdefault("user:" + account, [0, time.time()])[0] += 1
        code = "%06d" % secrets.randbelow(1000000)
        with self.store.lock:
            self.store.conn.execute("UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0", (row["id"],))
            self.store.conn.execute(
                "INSERT INTO password_resets (user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (row["id"], self._code_hash(row["id"], code), time.time() + RESET_CODE_MINUTES * 60, now_iso()))
            self.store.conn.commit()
        return row, code

    def finish_reset(self, username, code, new_password, ip):
        wrong = ApiError(HTTPStatus.BAD_REQUEST, "That code is wrong or has expired — ask for a new one")
        if self.throttled(ip):
            raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, "Too many failed attempts — try again in 15 minutes")
        row = self.find(username)
        code = re.sub(r"\s", "", str(code or ""))
        reset = None
        if row:
            with self.store.lock:
                reset = self.store.conn.execute(
                    "SELECT * FROM password_resets WHERE user_id = ? AND used = 0 AND expires_at > ? "
                    "ORDER BY id DESC LIMIT 1", (row["id"], time.time())).fetchone()
        if not reset or reset["tries"] >= RESET_CODE_TRIES or \
                not hmac.compare_digest(reset["code_hash"], self._code_hash(row["id"], code)):
            self.fails.setdefault(ip, [0, time.time()])[0] += 1
            if reset:
                with self.store.lock:
                    self.store.conn.execute("UPDATE password_resets SET tries = tries + 1 WHERE id = ?", (reset["id"],))
                    self.store.conn.commit()
            raise wrong
        self.set_password(row["id"], new_password)      # checks the password rules; signs out everywhere
        with self.store.lock:
            self.store.conn.execute("UPDATE password_resets SET used = 1 WHERE user_id = ?", (row["id"],))
            self.store.conn.commit()
        self.fails.pop(ip, None)
        self.account_fails.pop(row["username"].lower(), None)

    def admin_emails(self, except_id=None):
        with self.store.lock:
            rows = self.store.conn.execute(
                "SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND email != '' AND id != ?",
                (except_id or -1,)).fetchall()
        return [r["email"] for r in rows]

    def count(self):
        with self.store.lock:
            return self.store.conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]

    def list(self):
        with self.store.lock:
            rows = self.store.conn.execute("SELECT * FROM users ORDER BY username").fetchall()
        return [self.public(r) for r in rows]

    def create(self, username, password, role="staff", station=None, full_name=None, email=None, phone=None):
        username = (username or "").strip()
        full_name = self.clean_name(full_name)
        email, phone = clean_email(email), clean_phone(phone)
        if not USERNAME_RE.match(username):
            raise ApiError(HTTPStatus.BAD_REQUEST,
                           "Username must be 3-32 letters, numbers, dots, dashes or underscores")
        if role not in ("admin", "manager", "staff"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "role must be 'admin', 'manager' or 'staff'")
        station = (station or "").strip() or None
        if station and not self.store.has_station(station):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Unknown branch — add it under Branches first")
        if role == "manager" and not station:
            raise ApiError(HTTPStatus.BAD_REQUEST, "A branch manager needs a branch")
        check_new_password(password, username)
        try:
            with self.store.lock:
                cur = self.store.conn.execute(
                    "INSERT INTO users (username, pw_hash, role, station, full_name, email, phone, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (username, hash_password(password), role, station, full_name, email, phone, now_iso()))
                self.store.conn.commit()
        except sqlite3.IntegrityError:
            raise ApiError(HTTPStatus.CONFLICT, "That username is already taken")
        return self.get(cur.lastrowid)

    def get(self, user_id):
        with self.store.lock:
            row = self.store.conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self.public(row) if row else None

    def find(self, username):
        with self.store.lock:
            return self.store.conn.execute(
                "SELECT * FROM users WHERE username = ?", ((username or "").strip(),)).fetchone()

    def set_password(self, user_id, password):
        user = self.get(user_id)
        if not user:
            raise ApiError(HTTPStatus.NOT_FOUND, "User not found")
        check_new_password(password, user["username"])
        with self.store.lock:
            cur = self.store.conn.execute("UPDATE users SET pw_hash = ? WHERE id = ?",
                                          (hash_password(password), user_id))
            # Signing out everywhere else is the point of changing a password
            self.store.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            self.store.conn.commit()
        if not cur.rowcount:
            raise ApiError(HTTPStatus.NOT_FOUND, "User not found")

    def delete(self, user_id):
        with self.store.lock:
            row = self.store.conn.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                raise ApiError(HTTPStatus.NOT_FOUND, "User not found")
            if row["role"] == "admin" and self.store.conn.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0] <= 1:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Cannot delete the last admin")
            self.store.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            self.store.conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            self.store.conn.commit()

    # Login throttling: per device (IP) and per account, so neither a fake address nor
    # many devices can keep guessing one password
    @staticmethod
    def _over(table, key, limit):
        entry = table.get(key)
        if entry and time.time() - entry[1] > LOGIN_WINDOW:
            table.pop(key, None)
            return False
        return bool(entry and entry[0] >= limit)

    def throttled(self, ip):
        return self._over(self.fails, ip, LOGIN_MAX_FAILS)

    def login(self, username, password, ip):
        account = (username or "").strip().lower()
        if self.throttled(ip):
            raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, "Too many failed attempts — try again in 15 minutes")
        if self._over(self.account_fails, account, ACCOUNT_MAX_FAILS):
            raise ApiError(HTTPStatus.TOO_MANY_REQUESTS,
                           "This account is paused for 15 minutes after too many wrong passwords")
        row = self.find(username)
        if not row or not verify_password(password or "", row["pw_hash"]):
            for table, key in ((self.fails, ip), (self.account_fails, account)):
                table.setdefault(key, [0, time.time()])[0] += 1
            raise ApiError(HTTPStatus.UNAUTHORIZED, "Wrong username or password")
        self.fails.pop(ip, None)
        self.account_fails.pop(account, None)
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self.store.lock:
            self.store.conn.execute("DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?",
                                    (now, now - IDLE_HOURS * 3600))
            self.store.conn.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at, last_seen) VALUES (?, ?, ?, ?)",
                (hashlib.sha256(token.encode()).hexdigest(), row["id"], now + SESSION_DAYS * 86400, now))
            self.store.conn.commit()
        return token, self.public(row)

    def user_for(self, token):
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        now = time.time()
        with self.store.lock:
            row = self.store.conn.execute(
                """SELECT u.*, s.last_seen AS s_last_seen FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ? AND s.expires_at > ?
                     AND (s.last_seen IS NULL OR s.last_seen > ?)""",
                (token_hash, now, now - IDLE_HOURS * 3600)).fetchone()
            # Note activity at most once a minute, which keeps an active sign-in alive
            if row and (row["s_last_seen"] or 0) < now - 60:
                self.store.conn.execute("UPDATE sessions SET last_seen = ? WHERE token_hash = ?",
                                        (now, token_hash))
                self.store.conn.commit()
        return self.public(row) if row else None

    def logout_everywhere(self, user_id, keep_token=None):
        """End a user's sign-ins on every device, optionally keeping the current one."""
        keep = hashlib.sha256(keep_token.encode()).hexdigest() if keep_token else ""
        with self.store.lock:
            cur = self.store.conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                                          (user_id, keep))
            self.store.conn.commit()
        return cur.rowcount

    def logout(self, token):
        if token:
            with self.store.lock:
                self.store.conn.execute("DELETE FROM sessions WHERE token_hash = ?",
                                        (hashlib.sha256(token.encode()).hexdigest(),))
                self.store.conn.commit()


# ── HTTP layer ────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "PetroKenya/2.0"
    store = None  # set in make_server()
    auth = None
    settings = mailer = alerts = credit = uploads = None

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ── Responses ──
    def _send(self, status, body=b"", ctype="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        if self._https():
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        for k, v in (extra or {}).items():
            if isinstance(v, list):
                for item in v:
                    self.send_header(k, item)
            else:
                self.send_header(k, v)
        if "Cache-Control" not in (extra or {}):
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload, extra=None):
        viewer = getattr(self, "_viewer", None)
        if viewer and not sees_private(viewer):
            payload = hide_private(payload)
        self._send(status, json.dumps(payload).encode("utf-8"), extra=extra)

    def _body(self, max_bytes=MAX_BODY):
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            # Also blocks cross-site form posts, which cannot send this content type
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")
        length = int(self.headers.get("Content-Length") or 0)
        if length > max_bytes:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body too large")
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid JSON body")
        if not isinstance(body, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object")
        return body

    # ── Request context ──
    def _https(self):
        return (os.environ.get("PK_SECURE_COOKIE") == "1"
                or (self.headers.get("X-Forwarded-Proto") or "").lower() == "https")

    def _client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        if TRUST_PROXY and fwd:
            # Rightmost entry is the one added by the proxy directly in front of us
            return fwd.split(",")[-1].strip()
        return self.client_address[0]

    def _token(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return None

    def _cookie(self, token, max_age):
        attrs = ["%s=%s" % (COOKIE, token), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=%d" % max_age]
        if self._https():
            attrs.append("Secure")
        return "; ".join(attrs)

    # ── Static files ──
    def _static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(FRONTEND_DIR, rel))
        if not full.startswith(FRONTEND_DIR + os.sep) or not os.path.isfile(full):
            raise ApiError(HTTPStatus.NOT_FOUND, "Not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("json", "javascript")):
            ctype += "; charset=utf-8"
        # Only icons may be cached; the page, its CSS and JS must always revalidate so an
        # update never pairs new HTML with yesterday's script
        cache = "public, max-age=86400" if rel.startswith("icons/") else "no-cache"
        with open(full, "rb") as f:
            self._send(HTTPStatus.OK, f.read(), ctype, {"Cache-Control": cache})

    # ── Permissions ──
    @staticmethod
    def _station_scope(user, requested):
        """Station a request may touch: staff tied to a branch only get that branch."""
        if user["role"] in ("staff", "manager") and user["station"]:
            if requested and requested != user["station"]:
                raise ApiError(HTTPStatus.FORBIDDEN, "You can only access %s" % user["station"])
            return user["station"]
        return requested or None

    def _known_station(self, station):
        if not self.store.has_station(station):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Unknown branch — the admin adds branches under 👤 Account")

    @staticmethod
    def _require_admin(user):
        if user["role"] != "admin":
            raise ApiError(HTTPStatus.FORBIDDEN, "Admins only")

    @staticmethod
    def _check_editable(user, report_date, existing=None):
        """Nobody saves a future day or changes an approved one; staff may only change
        today's and yesterday's records (managers and admins any earlier day)."""
        if report_date > today():
            raise ApiError(HTTPStatus.BAD_REQUEST, "You can't save a record for a future date")
        if existing and existing.get("approved_at"):
            raise ApiError(HTTPStatus.CONFLICT,
                           "This day is approved and locked — an admin must reopen it first")
        if user["role"] == "staff" and report_date < days_before(today(), STAFF_EDIT_DAYS):
            raise ApiError(HTTPStatus.FORBIDDEN,
                           "Records older than yesterday are locked — ask a manager or admin to change them")

    def _prepare_record(self, rec, existing, user):
        """Server-side rules applied to every save: owner-set prices win over typed ones,
        openings are checked against the previous day, and the operator is stamped."""
        prices = self.store.effective_prices(rec["station"], rec["report_date"])
        if not sees_private(user):
            # Staff never see cost prices, so they can't send them: keep the day's own
            # costs, else carry the previous day's forward (owner prices still win below)
            prev = existing or self.store.previous(rec["station"], rec["report_date"]) or {}
            for fuel in FUELS:
                rec[fuel + "_cost"] = num(prev.get(fuel + "_cost"))
        for fuel, price in prices.items():
            rec[fuel + "_price"], rec[fuel + "_cost"] = price["sell"], price["cost"]
        rec["prices_set_by_owner"] = sorted(prices)
        rec["opening_mismatches"] = opening_mismatches(
            rec, self.store.previous(rec["station"], rec["report_date"]))
        # Receipt photos must be real uploads from the same branch
        receipts = []
        for r in rec.get("receipts") or []:
            up = self.uploads.get(str(r.get("upload_id") or ""))
            if up and up["station"] == rec["station"]:
                receipts.append({"id": r.get("id"), "upload_id": up["id"], "amount": num(r.get("amount")),
                                 "label": str(r.get("label") or "Receipt")[:60]})
        rec["receipts"] = receipts
        stamp_operator(rec, existing, user)

    def _own_record(self, user, rec_id, deleted=False):
        rec = self.store.get(rec_id, deleted=deleted)
        if not rec:
            raise ApiError(HTTPStatus.NOT_FOUND, "Record not found")
        if user["role"] in ("staff", "manager") and user["station"] and rec["station"] != user["station"]:
            raise ApiError(HTTPStatus.NOT_FOUND, "Record not found")
        return rec

    # ── Routing ──
    def _dispatch(self):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        m = self.command
        self._viewer = None
        try:
            if not path.startswith("/api"):
                if m not in ("GET", "HEAD"):
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed")
                return self._static(path)

            if path == "/api/health" and m == "GET":
                return self._json(HTTPStatus.OK, {"status": "ok", "time": now_iso()})

            if path == "/api/login" and m == "POST":
                body = self._body()
                token, user = self.auth.login(body.get("username"), body.get("password"), self._client_ip())
                return self._json(HTTPStatus.OK, {"user": user},
                                  {"Set-Cookie": self._cookie(token, SESSION_DAYS * 86400)})

            if path == "/api/password/forgot" and m == "POST":
                return self._json(HTTPStatus.OK, self._send_reset_code(self._body().get("username")))
            if path == "/api/password/reset" and m == "POST":
                body = self._body()
                self.auth.finish_reset(body.get("username"), body.get("code"), body.get("new_password"),
                                       self._client_ip())
                return self._json(HTTPStatus.OK, {"ok": True})

            if path == "/api/logout" and m == "POST":
                self.auth.logout(self._token())
                return self._json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": self._cookie("", 0)})

            user = self.auth.user_for(self._token())
            if not user:
                raise ApiError(HTTPStatus.UNAUTHORIZED, "Please sign in")
            self._viewer = user
            return self._route(m, path, q, user)
        except (ApiError, business.Error) as e:
            self._json(e.status, {"error": e.message})
        except Exception as e:  # pragma: no cover - last-resort guard
            self.log_message("Unhandled error: %r", e)
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Internal server error"})

    def _send_reset_code(self, username):
        """Send a reset code to the account's own email, else its phone by SMS, else to the admins
        (who can pass it on in person). The answer never says whether the username exists."""
        row, code = self.auth.start_reset(username, self._client_ip())
        if row:
            who = row["full_name"] or row["username"]
            text = ("Your PetroKenya password reset code is %s. It works for %d minutes. "
                    "If you didn't ask for it, ignore this message." % (code, RESET_CODE_MINUTES))
            if row["email"] and self.mailer.configured:
                self.mailer.send([row["email"]], "PetroKenya password reset code", text + "\n")
            elif row["phone"] and self.sms.configured:
                self.sms.send(row["phone"], "PetroKenya code: %s (valid %d min). Don't share it." % (code, RESET_CODE_MINUTES))
            else:
                admins = self.auth.admin_emails(except_id=row["id"])
                if admins and self.mailer.configured:
                    self.mailer.send(admins, "PetroKenya: password reset for %s" % who,
                                     "%s (username %s) asked to reset their password.\n\nTheir code is %s and works "
                                     "for %d minutes. Give it to them only if you know they asked — in person or by "
                                     "phone, not by forwarding this email.\n" % (who, row["username"], code, RESET_CODE_MINUTES))
                else:
                    sys.stderr.write("Password reset for %s could not be sent: no email or SMS set up\n" % row["username"])
        return {"ok": True, "message": "If that username exists, a 6-digit code has been sent to its email or phone "
                                      "— or, if it has neither, to the admin. The code works for %d minutes." % RESET_CODE_MINUTES}

    def _route(self, m, path, q, user):
        if path == "/api/me" and m == "GET":
            return self._json(HTTPStatus.OK, {"user": user})
        if path == "/api/me/password" and m == "POST":
            body = self._body()
            row = self.auth.find(user["username"])
            if not verify_password(body.get("current_password") or "", row["pw_hash"]):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Current password is wrong")
            self.auth.set_password(user["id"], body.get("new_password"))
            token, _ = self.auth.login(user["username"], body.get("new_password"), self._client_ip())
            return self._json(HTTPStatus.OK, {"ok": True},
                              {"Set-Cookie": self._cookie(token, SESSION_DAYS * 86400)})
        if path == "/api/me/logout-all" and m == "POST":
            ended = self.auth.logout_everywhere(user["id"], keep_token=self._token())
            return self._json(HTTPStatus.OK, {"signed_out": ended})
        if path == "/api/me/contact" and m == "POST":
            body = self._body()
            return self._json(HTTPStatus.OK, {"user": self.auth.set_contact(user["id"], body.get("email"), body.get("phone"))})
        if path == "/api/me/name" and m == "POST":
            updated = self.auth.set_full_name(user["id"], self._body().get("full_name"))
            return self._json(HTTPStatus.OK, {"user": updated})
        if path == "/api/stations" and m == "GET":
            scope = self._station_scope(user, None)
            return self._json(HTTPStatus.OK, {"stations": [scope] if scope else self.store.stations()})
        if path == "/api/stations" and m == "POST":
            self._require_admin(user)
            name = self.store.add_station(self._body().get("name"), user["username"])
            return self._json(HTTPStatus.CREATED, {"station": name, "stations": self.store.stations()})
        mm = re.fullmatch(r"/api/stations/([^/]+)", path)
        if mm and m == "PUT":
            self._require_admin(user)
            name = self.store.rename_station(unquote(mm.group(1)), self._body().get("name"))
            return self._json(HTTPStatus.OK, {"station": name, "stations": self.store.stations()})
        if mm and m == "DELETE":
            self._require_admin(user)
            self.store.remove_station(unquote(mm.group(1)))
            return self._json(HTTPStatus.OK, {"stations": self.store.stations()})
        # ── Receipt photos ──
        if path == "/api/uploads" and m == "POST":
            body = self._body(max_bytes=5 * 1024 * 1024)
            station = self._station_scope(user, body.get("station"))
            if not self.store.has_station(station):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Choose the branch the receipt belongs to")
            saved = self.uploads.save(body.get("data"), station, user["username"], now_iso())
            return self._json(HTTPStatus.CREATED, saved)
        mm = re.fullmatch(r"/api/uploads/([0-9a-f]{32})", path)
        if mm and m in ("GET", "HEAD"):
            up = self.uploads.get(mm.group(1))
            if not up or (user["role"] in ("staff", "manager") and user["station"]
                          and up["station"] != user["station"]):
                raise ApiError(HTTPStatus.NOT_FOUND, "Photo not found")
            return self._send(HTTPStatus.OK, self.uploads.read(up["id"]), up["mime"],
                              {"Cache-Control": "private, max-age=86400", "Content-Disposition": "inline",
                               "Content-Security-Policy": "default-src 'none'"})

        if path == "/api/compute" and m == "POST":
            return self._json(HTTPStatus.OK, compute(self._body()))
        if path == "/api/analytics" and m == "GET":
            station = self._station_scope(user, q.get("station"))
            return self._json(HTTPStatus.OK, analytics(self.store.list(station=station)))
        if path == "/api/export.csv" and m == "GET":
            station = self._station_scope(user, q.get("station"))
            name = "PetroKenya_%s_%s.csv" % (
                (station or "All-Branches").replace(" ", "-"), datetime.now().strftime("%Y-%m-%d"))
            return self._send(HTTPStatus.OK, to_csv(self.store.list(station=station), sees_private(user)).encode("utf-8"),
                              "text/csv; charset=utf-8",
                              {"Content-Disposition": 'attachment; filename="%s"' % name})

        if path == "/api/records":
            if m == "GET":
                limit = q.get("limit")
                limit = int(limit) if limit and limit.isdigit() else None
                station = self._station_scope(user, q.get("station"))
                recs = self.store.list(station, q.get("date"), q.get("from"), q.get("to"), limit)
                return self._json(HTTPStatus.OK, {"count": len(recs), "records": recs})
            if m == "POST":
                rec = clean_input(self._body())
                self._station_scope(user, rec["station"])
                self._known_station(rec["station"])
                existing = self.store.list(rec["station"], rec["report_date"])
                existing = existing[0] if existing else None
                # An approved day stays locked even while it sits in the bin
                self._check_editable(user, rec["report_date"],
                                     existing or self.store.find_day(rec["station"], rec["report_date"]))
                self._prepare_record(rec, existing, user)
                saved, created = self.store.save(rec, by=user["username"])
                self.alerts.sync_record(saved, now_iso())
                return self._json(HTTPStatus.CREATED if created else HTTPStatus.OK,
                                  {"created": created, "record": saved})
            if m == "DELETE":
                self._require_admin(user)
                binned = self.store.list(station=q.get("station"))
                count = self.store.delete_all(q.get("station"), by=user["username"])
                for r in binned:
                    self.alerts.clear_record(r["id"], now_iso())
                return self._json(HTTPStatus.OK, {"deleted": count})

        mm = re.fullmatch(r"/api/records/(\d+)", path)
        if mm:
            rec_id = int(mm.group(1))
            if m == "GET":
                return self._json(HTTPStatus.OK, self._own_record(user, rec_id))
            if m == "PUT":
                existing = self._own_record(user, rec_id)
                rec = clean_input(self._body())
                self._station_scope(user, rec["station"])
                self._known_station(rec["station"])
                self._check_editable(user, existing["report_date"], existing)
                self._check_editable(user, rec["report_date"])
                self._prepare_record(rec, existing, user)
                saved, _ = self.store.save(rec, rec_id=rec_id, by=user["username"])
                self.alerts.sync_record(saved, now_iso())
                return self._json(HTTPStatus.OK, {"created": False, "record": saved})
            if m == "DELETE":
                existing = self._own_record(user, rec_id)
                self._check_editable(user, existing["report_date"], existing)
                self.store.delete(rec_id, by=user["username"])
                self.alerts.clear_record(rec_id, now_iso())
                return self._json(HTTPStatus.OK, {"deleted": 1})

        # ── Day approval: managers (own branch) and admins approve; only admins reopen ──
        mm = re.fullmatch(r"/api/records/(\d+)/(approve|reopen)", path)
        if mm and m == "POST":
            rec_id, action = int(mm.group(1)), mm.group(2)
            rec = self._own_record(user, rec_id)
            if action == "approve":
                if user["role"] not in ("manager", "admin"):
                    raise ApiError(HTTPStatus.FORBIDDEN, "Only a branch manager or admin can approve a day")
                if rec["report_date"] > today():
                    raise ApiError(HTTPStatus.BAD_REQUEST, "You can't approve a future day")
                if not self.store.set_approval(rec_id, user["username"], True):
                    raise ApiError(HTTPStatus.CONFLICT, "This day is already approved")
            else:
                self._require_admin(user)
                if not self.store.set_approval(rec_id, user["username"], False):
                    raise ApiError(HTTPStatus.CONFLICT, "This day is not approved")
            return self._json(HTTPStatus.OK, {"record": self.store.get(rec_id)})

        # Previous saved day, used to fill today's opening readings
        if path == "/api/records/previous" and m == "GET":
            station = self._station_scope(user, q.get("station"))
            date = q.get("date") or today()
            if not station or not DATE_RE.match(date):
                raise ApiError(HTTPStatus.BAD_REQUEST, "station and date are required")
            return self._json(HTTPStatus.OK, {"record": self.store.previous(station, date)})

        # ── Fuel prices: everyone reads, only admins set ──
        if path == "/api/prices" and m == "GET":
            station = self._station_scope(user, q.get("station"))
            date = q.get("date") or today()
            if not station or not DATE_RE.match(date):
                raise ApiError(HTTPStatus.BAD_REQUEST, "station and date are required")
            return self._json(HTTPStatus.OK, {"station": station, "date": date,
                                              "prices": self.store.effective_prices(station, date)})
        if path == "/api/prices" and m == "POST":
            self._require_admin(user)
            body = self._body()
            stations = body.get("stations") or []
            if not isinstance(stations, list) or not stations or any(not self.store.has_station(st) for st in stations):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Choose one or more valid branches")
            eff = str(body.get("effective_from") or "")
            if not DATE_RE.match(eff):
                raise ApiError(HTTPStatus.BAD_REQUEST, "effective_from must be a date (YYYY-MM-DD)")
            changed = 0
            for fuel in FUELS:
                sell, cost = num(body.get(fuel + "_sell")), num(body.get(fuel + "_cost"))
                if sell <= 0 and cost <= 0:
                    continue                          # fuel left blank: keep its current price
                if sell <= 0 or cost <= 0 or cost > sell * 2 or sell > 1000:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Check the %s prices" % fuel)
                for st in stations:
                    self.store.set_price(st, fuel, r2(sell), r2(cost), eff, user["username"])
                    changed += 1
            if not changed:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Enter at least one fuel's selling and cost price")
            return self._json(HTTPStatus.CREATED, {"saved": changed})
        if path == "/api/prices/history" and m == "GET":
            station = self._station_scope(user, q.get("station"))
            return self._json(HTTPStatus.OK, {"prices": self.store.price_history(station)})

        mm = re.fullmatch(r"/api/records/(\d+)/history", path)
        if mm and m == "GET":
            rec_id = int(mm.group(1))
            if not self.store.get(rec_id) and user["role"] == "admin":
                self._own_record(user, rec_id, deleted=True)   # admins can read a binned record's history
            else:
                self._own_record(user, rec_id)
            return self._json(HTTPStatus.OK, {"history": self.store.history(rec_id)})

        # ── Bin: deleted records, admin only ──
        if path == "/api/bin" and m == "GET":
            self._require_admin(user)
            recs = self.store.list(station=q.get("station"), deleted=True)
            return self._json(HTTPStatus.OK, {"count": len(recs), "records": recs})
        mm = re.fullmatch(r"/api/bin/(\d+)(/restore)?", path)
        if mm:
            self._require_admin(user)
            rec_id = int(mm.group(1))
            if mm.group(2) and m == "POST":
                if not self.store.restore(rec_id, by=user["username"]):
                    raise ApiError(HTTPStatus.NOT_FOUND, "That record is not in the bin")
                self.alerts.sync_record(self.store.get(rec_id), now_iso())
                return self._json(HTTPStatus.OK, {"record": self.store.get(rec_id)})
            if not mm.group(2) and m == "DELETE":
                if not self.store.purge(rec_id, by=user["username"]):
                    raise ApiError(HTTPStatus.NOT_FOUND, "That record is not in the bin")
                return self._json(HTTPStatus.OK, {"purged": 1})

        # ── Credit customer accounts ──
        if path == "/api/customers":
            if m == "GET":
                return self._json(HTTPStatus.OK, {"customers": self.credit.list()})
            if m == "POST":
                cust = self.credit.create(self._body(), user["username"], now_iso(),
                                          can_set_limit=user["role"] in ("manager", "admin"))
                return self._json(HTTPStatus.CREATED, {"customer": cust})
        mm = re.fullmatch(r"/api/customers/(\d+)(/statement|/payments)?", path)
        if mm:
            cid = int(mm.group(1))
            if not mm.group(2) and m == "PUT":
                if user["role"] not in ("manager", "admin"):
                    raise ApiError(HTTPStatus.FORBIDDEN, "Only a manager or admin can change a customer account")
                return self._json(HTTPStatus.OK, {"customer": self.credit.update(cid, self._body())})
            if mm.group(2) == "/statement" and m == "GET":
                return self._json(HTTPStatus.OK, self.credit.statement(cid))
            if mm.group(2) == "/payments" and m == "POST":
                body = self._body()
                station = self._station_scope(user, body.get("station") or None) or body.get("station") or ""
                if station and not self.store.has_station(station):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Unknown branch")
                pid = self.credit.add_payment(cid, body, user["username"], station, now_iso(), today())
                return self._json(HTTPStatus.CREATED, {"payment_id": pid, **self.credit.statement(cid)})
        mm = re.fullmatch(r"/api/payments/(\d+)/void", path)
        if mm and m == "POST":
            self._require_admin(user)
            self.credit.void_payment(int(mm.group(1)), user["username"], now_iso())
            return self._json(HTTPStatus.OK, {"ok": True})

        # ── Alerts: admins see every branch, managers their own ──
        if path in ("/api/alerts", "/api/alerts/read"):
            if user["role"] not in ("manager", "admin"):
                raise ApiError(HTTPStatus.FORBIDDEN, "Alerts are for managers and admins")
            station = user["station"] if user["role"] == "manager" else q.get("station")
            if path == "/api/alerts" and m == "GET":
                items = self.alerts.list(user, station, include_cleared=q.get("all") == "1")
                return self._json(HTTPStatus.OK, {"alerts": items,
                                                  "unread": sum(1 for a in items if not a["read"] and not a["cleared_at"])})
            if path == "/api/alerts/read" and m == "POST":
                body = self._body()
                visible = {a["id"] for a in self.alerts.list(user, station, include_cleared=True, limit=5000)}
                ids = visible if body.get("all") else {int(num(i)) for i in body.get("ids") or []} & visible
                self.alerts.mark_read(user, ids)
                return self._json(HTTPStatus.OK, {"marked": len(ids)})

        # ── Alert settings (admin) ──
        if path == "/api/settings":
            self._require_admin(user)
            if m == "GET":
                return self._json(HTTPStatus.OK, {"settings": self.settings.all(),
                                                  "email_configured": self.mailer.configured})
            if m == "PUT":
                return self._json(HTTPStatus.OK, {"settings": self.settings.update(self._body()),
                                                  "email_configured": self.mailer.configured})
        if path == "/api/settings/test-email" and m == "POST":
            self._require_admin(user)
            to = [e.strip() for e in self.settings.all()["alert_emails"].split(",") if e.strip()]
            if not self.mailer.configured:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Email isn't set up on the server (PK_SMTP_HOST and friends)")
            if not to:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Add at least one alert email address first")
            try:
                self.mailer.send_now(to, "PetroKenya test alert", "Alert emails from PetroKenya are working.\n")
            except Exception as e:
                raise ApiError(HTTPStatus.BAD_GATEWAY, "The mail server refused: %s" % e)
            return self._json(HTTPStatus.OK, {"sent_to": to})

        # ── Backups (admin): list, make one now, email one now, download ──
        if path == "/api/backups":
            self._require_admin(user)
            if m == "GET":
                return self._json(HTTPStatus.OK, {
                    "backups": self.backups.list(), "email_configured": self.mailer.configured,
                    "backup_emails": self.settings.all()["backup_emails"], "last_email": self.backups.last_email})
            if m == "POST":
                made = self.backups.create(by=user["username"])
                return self._json(HTTPStatus.CREATED, {"backup": made, "backups": self.backups.list()})
        if path == "/api/backups/email" and m == "POST":
            self._require_admin(user)
            return self._json(HTTPStatus.OK, {"sent_to": self.backups.email()})
        mm = re.fullmatch(r"/api/backups/([A-Za-z0-9_.-]+)", path)
        if mm and m == "GET":
            self._require_admin(user)
            full = self.backups.path(mm.group(1))
            with open(full, "rb") as f:
                data = f.read()
            return self._send(HTTPStatus.OK, data, "application/zip",
                              {"Content-Disposition": 'attachment; filename="%s"' % mm.group(1)})

        # ── Monthly report ──
        if path in ("/api/reports/monthly", "/api/reports/monthly.csv") and m == "GET":
            month = q.get("month") or today()[:7]
            if not re.fullmatch(r"\d{4}-\d{2}", month):
                raise ApiError(HTTPStatus.BAD_REQUEST, "month must look like 2026-10")
            station = self._station_scope(user, q.get("station"))
            recs = self.store.list(station, date_from=month + "-01", date_to=month + "-31")
            report = business.monthly_report(recs, month)
            if not sees_private(user):
                report = hide_private(report)
            if path.endswith(".csv"):
                buf = io.StringIO()
                w = csv.writer(buf, lineterminator="\n")
                w.writerow(["Branch", "Days", "Approved days"] + [f["label"] for f in report["fields"]])
                for b in report["branches"] + [report["totals"]]:
                    w.writerow([csv_cell(b["station"]), b["days"], b["approved_days"]]
                               + [b[f["key"]] for f in report["fields"]])
                return self._send(HTTPStatus.OK, buf.getvalue().encode("utf-8"), "text/csv; charset=utf-8",
                                  {"Content-Disposition": 'attachment; filename="PetroKenya_%s_%s.csv"'
                                   % ((station or "All-Branches").replace(" ", "-"), month)})
            return self._json(HTTPStatus.OK, report)

        if path == "/api/users":
            self._require_admin(user)
            if m == "GET":
                return self._json(HTTPStatus.OK, {"users": self.auth.list()})
            if m == "POST":
                body = self._body()
                created = self.auth.create(body.get("username"), body.get("password"),
                                           body.get("role") or "staff", body.get("station"),
                                           body.get("full_name"), body.get("email"), body.get("phone"))
                return self._json(HTTPStatus.CREATED, {"user": created})

        mm = re.fullmatch(r"/api/users/(\d+)(/password|/logout|/contact)?", path)
        if mm:
            self._require_admin(user)
            uid = int(mm.group(1))
            if mm.group(2) == "/contact" and m == "PUT":
                body = self._body()
                return self._json(HTTPStatus.OK, {"user": self.auth.set_contact(uid, body.get("email"), body.get("phone"))})
            if mm.group(2) == "/password" and m == "POST":
                self.auth.set_password(uid, self._body().get("password"))
                return self._json(HTTPStatus.OK, {"ok": True})
            if mm.group(2) == "/logout" and m == "POST":
                if not self.auth.get(uid):
                    raise ApiError(HTTPStatus.NOT_FOUND, "User not found")
                return self._json(HTTPStatus.OK, {"signed_out": self.auth.logout_everywhere(uid)})
            if not mm.group(2) and m == "DELETE":
                if uid == user["id"]:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "You cannot delete your own account")
                self.auth.delete(uid)
                return self._json(HTTPStatus.OK, {"deleted": 1})

        raise ApiError(HTTPStatus.NOT_FOUND if m == "GET" else HTTPStatus.METHOD_NOT_ALLOWED,
                       "No route for %s %s" % (m, path))

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _dispatch


def stamp_operator(rec, existing, user):
    """The day's operator is whoever first saved that day's sales; later saves only note who
    changed it. Names always come from the signed-in account, never from the form."""
    name = user["display_name"]
    if existing and existing.get("operator"):
        rec["operator"] = existing["operator"]
        rec["operator_username"] = existing.get("operator_username") or existing.get("saved_by")
        rec["operator_saved_at"] = existing.get("operator_saved_at") or existing.get("created_at")
    else:
        rec["operator"] = name
        rec["operator_username"] = user["username"]
        rec["operator_saved_at"] = now_iso()
    rec["saved_by"] = user["username"]
    rec["last_edited_by"] = name


def bootstrap_admin(auth):
    """Make sure a fresh database has an admin account to sign in with."""
    if auth.count():
        return
    user = os.environ.get("PK_ADMIN_USER")
    password = os.environ.get("PK_ADMIN_PASSWORD")
    if user and password:
        try:
            auth.create(user, password, "admin")
        except ApiError as e:
            sys.exit("PK_ADMIN_USER / PK_ADMIN_PASSWORD were refused: %s" % e.message)
        print(f"   Created admin '{user}' from PK_ADMIN_USER / PK_ADMIN_PASSWORD.")
        return
    password = secrets.token_urlsafe(9)
    auth.create("admin", password, "admin")
    print("   ┌──────────────────────────────────────────────────────────┐")
    print("   │ First start: created admin account                       │")
    print(f"   │   username: admin   password: {password:<26}│")
    print("   │ Sign in and change it under 👤 Account.                   │")
    print("   └──────────────────────────────────────────────────────────┘")


def data_dirs(db_path):
    """Receipt photos and backups live next to the database unless PK_UPLOADS / PK_BACKUPS say otherwise."""
    here = os.path.dirname(os.path.abspath(db_path))
    return (os.environ.get("PK_UPLOADS") or os.path.join(here, "uploads"),
            os.environ.get("PK_BACKUPS") or os.path.join(here, "backups"))


def make_server(host=HOST, port=PORT, db_path=DB_PATH, bootstrap=True):
    store = Store(db_path)
    auth = Auth(store)
    if bootstrap:
        bootstrap_admin(auth)
    settings = business.Settings(store)
    mailer = business.Mailer()
    uploads_dir, backups_dir = data_dirs(db_path)
    handler = type("BoundHandler", (Handler,), {
        "store": store, "auth": auth, "settings": settings, "mailer": mailer,
        "alerts": business.Alerts(store, settings, mailer), "credit": business.Credit(store),
        "uploads": business.Uploads(store, uploads_dir), "sms": business.Sms(),
        "backups": business.Backups(store, settings, mailer, uploads_dir, backups_dir)})
    return ThreadingHTTPServer((host, port), handler)


def cli(argv):
    """create-user NAME [--role admin|manager|staff] [--station NAME] [--name "Full Name"]
    reset-password NAME
    add-branch "BRANCH NAME"
    backup                 (writes a backup zip into the backups folder now)
    restore BACKUP.zip     (stop the app first; the current database is kept as a copy)"""
    if argv and argv[0] == "restore":
        if len(argv) != 2:
            sys.exit(cli.__doc__)
        uploads_dir, backups_dir = data_dirs(DB_PATH)
        try:
            done = business.restore(argv[1], DB_PATH, uploads_dir, backups_dir)
        except business.Error as e:
            sys.exit("Error: " + e.message)
        print("Restored %d days and %d photos into %s" % (done["days"], done["photos"], DB_PATH))
        if done["saved_current_as"]:
            print("The database it replaced was saved as %s" % done["saved_current_as"])
        return
    if argv and argv[0] == "add-branch":
        if len(argv) != 2:
            sys.exit(cli.__doc__)
        try:
            print("Added branch %s" % Store(DB_PATH).add_station(argv[1], "command line"))
        except ApiError as e:
            sys.exit("Error: " + e.message)
        return
    if argv and argv[0] == "backup":
        httpd = make_server(port=0, bootstrap=False)
        made = httpd.RequestHandlerClass.backups.create(by="command line")
        httpd.server_close()
        print("Backup written: %s (%d KB)" % (os.path.join(data_dirs(DB_PATH)[1], made["name"]), made["size"] // 1024))
        return
    store = Store(DB_PATH)
    auth = Auth(store)
    cmd, name, opts = argv[0], argv[1] if len(argv) > 1 else None, argv[2:]
    if not name:
        sys.exit(cli.__doc__)
    flags = dict(zip(opts[::2], opts[1::2]))
    password = getpass.getpass("Password for %s: " % name)
    try:
        if cmd == "create-user":
            u = auth.create(name, password, flags.get("--role", "staff"), flags.get("--station"),
                            flags.get("--name"))
            print("Created %s (%s%s)" % (u["username"], u["role"], ", " + u["station"] if u["station"] else ""))
        elif cmd == "reset-password":
            row = auth.find(name)
            if not row:
                sys.exit("No such user: %s" % name)
            auth.set_password(row["id"], password)
            print("Password updated for %s" % name)
        else:
            sys.exit(cli.__doc__)
    except ApiError as e:
        sys.exit("Error: " + e.message)


def main():
    if len(sys.argv) > 1:
        return cli(sys.argv[1:])
    httpd = make_server()
    httpd.RequestHandlerClass.backups.start()      # nightly backups (and backup emails)
    host, port = httpd.server_address[:2]
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    print(f"⛽ PetroKenya running at http://{shown}:{port}")
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
