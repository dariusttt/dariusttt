"""Tests for backend/server.py — run from the repo root with:

    python3 -m unittest discover -s backend/tests
"""

import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import server  # noqa: E402

# Freeze "today" so the fixed dates below stay inside the staff edit window
TODAY = "2026-10-15"
server.today = lambda: TODAY

SAMPLE = {
    "report_date": "2026-10-14",
    "station": "Ngeria Branch",
    "petrol_open": 1000, "petrol_close": 1100, "petrol_price": 189.5, "petrol_cost": 174,
    "diesel_open": 500, "diesel_close": 550, "diesel_price": 172, "diesel_cost": 157,
    "mpesa_amount": 20000, "cash_amount": 7550,
    "exp_wages": 1000,
    "misc_items": [{"name": "Tip", "amount": 200}],
    "gas_items": [{"name": "6kg LPG", "category": "Gas", "qty": 2, "price": 1000}],
}
PASSWORD = "correct-horse"


class Client:
    """Tiny HTTP client that keeps its own session cookie."""

    def __init__(self, base):
        self.base = base
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))

    def req(self, method, path, body=None, ctype="application/json"):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": ctype} if data is not None else {}
        r = Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(r) as resp:
                raw = resp.read()
                is_json = "json" in resp.headers.get("Content-Type", "")
                return resp.status, (json.loads(raw) if is_json else raw.decode(errors="replace")), resp.headers
        except HTTPError as e:
            return e.code, json.loads(e.read()), e.headers

    def login(self, username, password=PASSWORD):
        status, body, _ = self.req("POST", "/api/login", {"username": username, "password": password})
        assert status == 200, body
        return self


class ServerCase(unittest.TestCase):
    """Starts one test server per test class; each test begins with an empty database."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.httpd = server.make_server("127.0.0.1", 0, os.path.join(cls.tmp.name, "t.sqlite3"),
                                       bootstrap=False)
        cls.httpd.RequestHandlerClass.log_message = lambda *args: None
        cls.port = cls.httpd.server_address[1]
        cls.base = "http://127.0.0.1:%d" % cls.port
        auth = cls.httpd.RequestHandlerClass.auth
        for name in ("Ngeria Branch", "Himaki Branch", "Moiben Branch"):
            cls.httpd.RequestHandlerClass.store.add_station(name, "test")
        auth.create("boss", PASSWORD, "admin")
        auth.create("kisumu", PASSWORD, "staff", "Moiben Branch")
        auth.create("roamer", PASSWORD, "staff")
        auth.create("kmanager", PASSWORD, "manager", "Moiben Branch")
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.httpd.RequestHandlerClass.store.conn.close()
        cls.tmp.cleanup()

    def setUp(self):
        self.httpd.RequestHandlerClass.auth.fails.clear()
        self.httpd.RequestHandlerClass.auth.account_fails.clear()
        conn = self.httpd.RequestHandlerClass.store.conn
        for table in ("records", "record_versions", "prices", "alerts", "alert_reads", "customers",
                      "credit_payments", "settings"):
            conn.execute("DELETE FROM %s" % table)
        conn.commit()
        self.admin = Client(self.base).login("boss")

    def raw_get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("GET", path)
        resp = conn.getresponse()
        resp.read()
        conn.close()
        return resp.status


class ServerTest(ServerCase):
    # ── App files ──
    def test_serves_frontend_files(self):
        anon = Client(self.base)
        status, html, _ = anon.req("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn('href="manifest.webmanifest"', html)
        self.assertIn('src="js/app.js?v=', html)
        for path, ctype in [("/css/styles.css", "text/css"), ("/js/app.js", "javascript"),
                            ("/sw.js", "javascript"), ("/manifest.webmanifest", "manifest+json"),
                            ("/icons/icon-192.png", "image/png")]:
            r = anon.opener.open(self.base + path)
            self.assertEqual(r.status, 200, path)
            self.assertIn(ctype, r.headers["Content-Type"], path)
        js = anon.opener.open(self.base + "/js/app.js?v=2")
        self.assertEqual(js.headers["Cache-Control"], "no-cache")   # updates must reach browsers
        self.assertEqual(self.raw_get("/nope.html"), 404)
        self.assertEqual(self.raw_get("/../backend/server.py"), 404)
        self.assertEqual(self.raw_get("/%2e%2e/backend/server.py"), 404)

    # ── Sign-in ──
    def test_api_requires_login(self):
        anon = Client(self.base)
        self.assertEqual(anon.req("GET", "/api/health")[0], 200)
        self.assertEqual(anon.req("GET", "/api/records")[0], 401)
        self.assertEqual(anon.req("POST", "/api/compute", SAMPLE)[0], 401)

    def test_login_logout_and_cookie_flags(self):
        c = Client(self.base)
        status, body, headers = c.req("POST", "/api/login", {"username": "BOSS", "password": PASSWORD})
        self.assertEqual(status, 200)
        self.assertEqual(body["user"]["role"], "admin")
        cookie = headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        self.assertNotIn("pw_hash", json.dumps(body))
        self.assertEqual(c.req("GET", "/api/me")[1]["user"]["username"], "boss")
        c.req("POST", "/api/logout", {})
        self.assertEqual(c.req("GET", "/api/me")[0], 401)

    def test_wrong_password_and_throttle(self):
        c = Client(self.base)
        for _ in range(server.LOGIN_MAX_FAILS):
            self.assertEqual(c.req("POST", "/api/login", {"username": "boss", "password": "nope"})[0], 401)
        self.assertEqual(c.req("POST", "/api/login", {"username": "boss", "password": PASSWORD})[0], 429)

    def test_change_own_password(self):
        auth = self.httpd.RequestHandlerClass.auth
        auth.create("temp", PASSWORD, "staff")
        c = Client(self.base).login("temp")
        status, body, _ = c.req("POST", "/api/me/password",
                                {"current_password": "wrong", "new_password": "new-password-1"})
        self.assertEqual(status, 400)
        status, _, _ = c.req("POST", "/api/me/password",
                             {"current_password": PASSWORD, "new_password": "new-password-1"})
        self.assertEqual(status, 200)
        self.assertEqual(c.req("GET", "/api/me")[0], 200)  # re-issued session still works
        Client(self.base).login("temp", "new-password-1")
        auth.delete(auth.find("temp")["id"])

    def test_requires_json_content_type(self):
        status, _, _ = self.admin.req("POST", "/api/records", SAMPLE, ctype="text/plain")
        self.assertEqual(status, 415)

    # ── Records ──
    def test_compute_matches_dashboard_formulas(self):
        status, c, _ = self.admin.req("POST", "/api/compute", SAMPLE)
        self.assertEqual(status, 200)
        self.assertEqual(c["petrol_litres"], 100)
        self.assertEqual(c["diesel_litres"], 50)
        self.assertEqual(c["gas_lube_revenue"], 2000)
        self.assertEqual(c["gross_revenue"], 18950 + 8600 + 2000)
        self.assertEqual(c["total_expenses"], 1200)            # wages + misc items
        self.assertEqual(c["net_profit"], 29550 - (17400 + 7850) - 1200)
        self.assertEqual(c["output_vat"], round(29550 - round(29550 / 1.16, 2), 2))
        self.assertEqual(c["total_excise"], round(100 * 21.95 + 50 * 7.21, 2))
        self.assertEqual(c["collection_variance"], 29550 - 27550)

    def test_create_upsert_get_delete(self):
        status, res, _ = self.admin.req("POST", "/api/records", SAMPLE)
        self.assertEqual(status, 201)
        rid = res["record"]["id"]
        self.assertEqual(res["record"]["net_profit"], 3100)
        self.assertEqual(res["record"]["saved_by"], "boss")

        status, res, _ = self.admin.req("POST", "/api/records", {**SAMPLE, "exp_wages": 2000})
        self.assertEqual(status, 200)
        self.assertFalse(res["created"])
        self.assertEqual(res["record"]["id"], rid)
        self.assertEqual(res["record"]["net_profit"], 2100)

        self.assertEqual(self.admin.req("GET", "/api/records")[1]["count"], 1)
        self.assertEqual(self.admin.req("GET", "/api/records/%d" % rid)[0], 200)
        self.assertEqual(self.admin.req("DELETE", "/api/records/%d" % rid)[0], 200)
        self.assertEqual(self.admin.req("GET", "/api/records/%d" % rid)[0], 404)

    def test_filters_analytics_and_export(self):
        self.admin.req("POST", "/api/records", SAMPLE)
        self.admin.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-10-13"})
        self.admin.req("POST", "/api/records", {**SAMPLE, "station": "Moiben Branch"})

        self.assertEqual(self.admin.req("GET", "/api/records?station=Moiben%20Branch")[1]["count"], 1)
        self.assertEqual(self.admin.req("GET", "/api/records?date=2026-10-14")[1]["count"], 2)
        a = self.admin.req("GET", "/api/analytics?station=Ngeria%20Branch")[1]
        self.assertEqual(a["totals"]["days"], 2)
        self.assertEqual([d["report_date"] for d in a["last_7"]], ["2026-10-13", "2026-10-14"])
        status, csv_text, _ = self.admin.req("GET", "/api/export.csv")
        self.assertEqual(status, 200)
        self.assertEqual(len(csv_text.strip().splitlines()), 4)
        self.assertEqual(self.admin.req("DELETE", "/api/records?station=Moiben%20Branch")[1]["deleted"], 1)

    def test_csv_export_neutralises_formulas(self):
        self.admin.req("POST", "/api/records", {**SAMPLE, "kra_business": "=HYPERLINK(\"http://x\")"})
        csv_text = self.admin.req("GET", "/api/export.csv")[1]
        self.assertIn("'=HYPERLINK", csv_text)
        self.assertNotIn(",=HYPERLINK", csv_text)

    def test_operator_is_the_signed_in_users_name(self):
        auth = self.httpd.RequestHandlerClass.auth
        auth.create("mary", PASSWORD, "staff", full_name="  Mary   Wanjiku ")
        mary = Client(self.base).login("mary")
        me = mary.req("GET", "/api/me")[1]["user"]
        self.assertEqual((me["full_name"], me["display_name"]), ("Mary Wanjiku", "Mary Wanjiku"))

        rec = mary.req("POST", "/api/records", {**SAMPLE, "operator": "Someone Else"})[1]["record"]
        self.assertEqual(rec["operator"], "Mary Wanjiku")   # typed value is ignored

        # Someone else correcting the day keeps Mary as that day's operator
        fixed = self.admin.req("POST", "/api/records", {**SAMPLE, "exp_wages": 1500})[1]["record"]
        self.assertEqual((fixed["operator"], fixed["last_edited_by"]), ("Mary Wanjiku", "boss"))
        put = self.admin.req("PUT", "/api/records/%d" % rec["id"], SAMPLE)[1]["record"]
        self.assertEqual(put["operator"], "Mary Wanjiku")
        # A new day is recorded under whoever saves it first
        other = self.admin.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-10-15"})[1]["record"]
        self.assertEqual(other["operator"], "boss")
        self.assertIn(",Mary Wanjiku,", self.admin.req("GET", "/api/export.csv")[1])

        updated = mary.req("POST", "/api/me/name", {"full_name": "Mary W. Kamau"})[1]["user"]
        self.assertEqual(updated["display_name"], "Mary W. Kamau")
        self.assertEqual(mary.req("POST", "/api/me/name", {"full_name": "x" * 61})[0], 400)
        cleared = mary.req("POST", "/api/me/name", {"full_name": ""})[1]["user"]
        self.assertEqual(cleared["display_name"], "mary")   # falls back to the username
        auth.delete(auth.find("mary")["id"])

    def test_put_conflict(self):
        a = self.admin.req("POST", "/api/records", SAMPLE)[1]
        self.admin.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-10-13"})
        status, err, _ = self.admin.req("PUT", "/api/records/%d" % a["record"]["id"],
                                        {**SAMPLE, "report_date": "2026-10-13"})
        self.assertEqual(status, 409)

    def test_validation_and_item_cleaning(self):
        self.assertEqual(self.admin.req("POST", "/api/records", {"station": "X"})[0], 400)
        self.assertEqual(self.admin.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-13-40"})[0], 400)
        self.assertEqual(self.admin.req("POST", "/api/records", {**SAMPLE, "gas_items": "nope"})[0], 400)
        body = {**SAMPLE, "invoices": [{"id": "1); alert(1", "customer": "<b>x</b>", "amount": "50"}]}
        inv = self.admin.req("POST", "/api/records", body)[1]["record"]["invoices"][0]
        self.assertEqual(inv["id"], 0)          # non-numeric id cannot reach an onclick handler
        self.assertEqual(inv["amount"], 50)
        self.assertEqual(inv["customer"], "<b>x</b>")  # stored as text; the page escapes it

    # ── Permissions ──
    def test_branch_staff_are_limited_to_their_branch(self):
        self.admin.req("POST", "/api/records", SAMPLE)
        other_id = self.admin.req("GET", "/api/records")[1]["records"][0]["id"]
        staff = Client(self.base).login("kisumu")

        self.assertEqual(staff.req("GET", "/api/records")[1]["count"], 0)
        self.assertEqual(staff.req("GET", "/api/records?station=Ngeria%20Branch")[0], 403)
        self.assertEqual(staff.req("POST", "/api/records", SAMPLE)[0], 403)
        self.assertEqual(staff.req("GET", "/api/records/%d" % other_id)[0], 404)
        self.assertEqual(staff.req("DELETE", "/api/records/%d" % other_id)[0], 404)
        self.assertEqual(staff.req("PUT", "/api/records/%d" % other_id,
                                   {**SAMPLE, "station": "Moiben Branch"})[0], 404)

        status, res, _ = staff.req("POST", "/api/records", {**SAMPLE, "station": "Moiben Branch"})
        self.assertEqual(status, 201)
        self.assertEqual(staff.req("GET", "/api/records")[1]["count"], 1)
        self.assertEqual(staff.req("GET", "/api/stations")[1]["stations"], ["Moiben Branch"])
        self.assertEqual(staff.req("DELETE", "/api/records/%d" % res["record"]["id"])[0], 200)
        self.assertEqual(staff.req("DELETE", "/api/records")[0], 403)
        self.assertEqual(staff.req("GET", "/api/users")[0], 403)

    def test_unassigned_staff_see_all_branches_but_cannot_bulk_delete(self):
        self.admin.req("POST", "/api/records", SAMPLE)
        roamer = Client(self.base).login("roamer")
        self.assertEqual(roamer.req("GET", "/api/records")[1]["count"], 1)
        self.assertEqual(roamer.req("POST", "/api/records", {**SAMPLE, "station": "Himaki Branch"})[0], 201)
        self.assertEqual(roamer.req("DELETE", "/api/records")[0], 403)

    def test_admin_user_management(self):
        status, res, _ = self.admin.req("POST", "/api/users", {
            "username": "nakuru", "password": PASSWORD, "role": "staff", "station": "Himaki Branch"})
        self.assertEqual(status, 201)
        uid = res["user"]["id"]
        self.assertEqual(self.admin.req("POST", "/api/users", {"username": "nakuru", "password": PASSWORD})[0], 409)
        self.assertEqual(self.admin.req("POST", "/api/users", {"username": "x", "password": PASSWORD})[0], 400)
        self.assertEqual(self.admin.req("POST", "/api/users", {"username": "shorty", "password": "short"})[0], 400)
        self.assertEqual(self.admin.req("POST", "/api/users",
                                        {"username": "badbranch", "password": PASSWORD, "station": "Moon"})[0], 400)
        names = [u["username"] for u in self.admin.req("GET", "/api/users")[1]["users"]]
        self.assertIn("nakuru", names)

        self.assertEqual(self.admin.req("POST", "/api/users/%d/password" % uid, {"password": "brand-new-pw"})[0], 200)
        Client(self.base).login("nakuru", "brand-new-pw")
        self.assertEqual(self.admin.req("DELETE", "/api/users/%d" % uid)[0], 200)
        me = self.admin.req("GET", "/api/me")[1]["user"]["id"]
        self.assertEqual(self.admin.req("DELETE", "/api/users/%d" % me)[0], 400)


class SecurityTest(ServerCase):
    """Login limits, sessions, passwords, change history, the bin and edit locks."""

    def test_faked_forwarded_address_does_not_dodge_the_login_limit(self):
        def attempt(fake_ip):
            conn = http.client.HTTPConnection("127.0.0.1", self.port)
            conn.request("POST", "/api/login", json.dumps({"username": "boss", "password": "nope"}),
                         {"Content-Type": "application/json", "X-Forwarded-For": fake_ip})
            return conn.getresponse().status
        codes = [attempt("10.0.0.%d" % i) for i in range(server.LOGIN_MAX_FAILS + 2)]
        self.assertEqual(codes[-1], 429)

    def test_account_pauses_after_wrong_passwords_from_many_devices(self):
        auth = self.httpd.RequestHandlerClass.auth
        for i in range(server.ACCOUNT_MAX_FAILS):
            with self.assertRaises(server.ApiError):
                auth.login("roamer", "wrong-guess", "10.1.0.%d" % i)
        with self.assertRaises(server.ApiError) as err:
            auth.login("roamer", PASSWORD, "10.2.0.1")       # right password, new device
        self.assertEqual(err.exception.status, 429)

    def test_idle_and_expired_sessions_end(self):
        c = Client(self.base).login("roamer")
        conn = self.httpd.RequestHandlerClass.store.conn
        conn.execute("UPDATE sessions SET last_seen = ?", (server.time.time() - server.IDLE_HOURS * 3600 - 5,))
        conn.commit()
        self.assertEqual(c.req("GET", "/api/me")[0], 401)
        c = Client(self.base).login("roamer")
        conn.execute("UPDATE sessions SET expires_at = ?", (server.time.time() - 1,))
        conn.commit()
        self.assertEqual(c.req("GET", "/api/me")[0], 401)

    def test_sign_out_everywhere(self):
        phone, laptop = Client(self.base).login("roamer"), Client(self.base).login("roamer")
        self.assertEqual(phone.req("POST", "/api/me/logout-all", {})[1]["signed_out"], 1)
        self.assertEqual(phone.req("GET", "/api/me")[0], 200)     # this device stays signed in
        self.assertEqual(laptop.req("GET", "/api/me")[0], 401)
        uid = phone.req("GET", "/api/me")[1]["user"]["id"]
        self.assertEqual(self.admin.req("POST", "/api/users/%d/logout" % uid, {})[0], 200)
        self.assertEqual(phone.req("GET", "/api/me")[0], 401)
        self.assertEqual(self.admin.req("POST", "/api/users/99999/logout", {})[0], 404)

    def test_weak_passwords_are_refused(self):
        for pw in ("password123", "12345678", "aaaaaaaa", "Safaricom", "xx-weakuser-1"):
            status, body, _ = self.admin.req("POST", "/api/users",
                                             {"username": "weakuser", "password": pw})
            self.assertEqual(status, 400, pw)
        self.assertEqual(self.admin.req("POST", "/api/users",
                                        {"username": "stronguser", "password": "Mango-Tree-42"})[0], 201)

    def test_hsts_only_over_https(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("GET", "/api/health", headers={"X-Forwarded-Proto": "https"})
        self.assertIn("max-age", conn.getresponse().getheader("Strict-Transport-Security") or "")
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("GET", "/api/health")
        self.assertIsNone(conn.getresponse().getheader("Strict-Transport-Security"))

    def test_every_change_is_kept_in_history(self):
        rid = self.admin.req("POST", "/api/records", SAMPLE)[1]["record"]["id"]
        self.admin.req("POST", "/api/records", {**SAMPLE, "cash_amount": 5000})
        hist = self.admin.req("GET", "/api/records/%d/history" % rid)[1]["history"]
        self.assertEqual([h["action"] for h in hist], ["create", "update"])
        self.assertEqual(hist[1]["by"], "boss")
        self.assertEqual(hist[1]["changes"], [{"field": "cash_amount", "before": 7550, "after": 5000}])

    def test_delete_moves_to_bin_and_admin_can_restore_or_purge(self):
        rid = self.admin.req("POST", "/api/records", SAMPLE)[1]["record"]["id"]
        roamer = Client(self.base).login("roamer")
        self.assertEqual(roamer.req("DELETE", "/api/records/%d" % rid)[0], 200)
        self.assertEqual(self.admin.req("GET", "/api/records")[1]["count"], 0)
        self.assertEqual(roamer.req("GET", "/api/bin")[0], 403)
        binned = self.admin.req("GET", "/api/bin")[1]["records"]
        self.assertEqual([(r["id"], r["deleted_by"]) for r in binned], [(rid, "roamer")])

        self.assertEqual(self.admin.req("POST", "/api/bin/%d/restore" % rid, {})[0], 200)
        self.assertEqual(self.admin.req("GET", "/api/records")[1]["count"], 1)

        self.admin.req("DELETE", "/api/records/%d" % rid)
        self.assertEqual(self.admin.req("DELETE", "/api/bin/%d" % rid)[0], 200)
        self.assertEqual(self.admin.req("GET", "/api/bin")[1]["count"], 0)
        hist = self.admin.req("GET", "/api/records/%d/history" % rid)
        self.assertEqual(hist[0], 404)          # record is gone, but the versions table keeps it
        actions = [r["action"] for r in self.httpd.RequestHandlerClass.store.conn.execute(
            "SELECT action FROM record_versions WHERE record_id = ? ORDER BY id", (rid,))]
        self.assertEqual(actions, ["create", "delete", "restore", "delete", "purge"])

    def test_saving_a_binned_day_brings_it_back(self):
        rid = self.admin.req("POST", "/api/records", SAMPLE)[1]["record"]["id"]
        self.admin.req("DELETE", "/api/records/%d" % rid)
        status, res, _ = self.admin.req("POST", "/api/records", SAMPLE)
        self.assertEqual((status, res["record"]["id"]), (201, rid))
        self.assertEqual(self.admin.req("GET", "/api/bin")[1]["count"], 0)

    def test_staff_can_only_change_today_and_yesterday(self):
        old = {**SAMPLE, "station": "Moiben Branch", "report_date": "2026-10-13"}
        staff = Client(self.base).login("kisumu")
        self.assertEqual(staff.req("POST", "/api/records", old)[0], 403)
        rid = self.admin.req("POST", "/api/records", old)[1]["record"]["id"]   # admins can
        self.assertEqual(staff.req("PUT", "/api/records/%d" % rid, {**old, "report_date": TODAY})[0], 403)
        self.assertEqual(staff.req("DELETE", "/api/records/%d" % rid)[0], 403)
        self.assertEqual(staff.req("POST", "/api/records", {**old, "report_date": "2026-10-14"})[0], 201)
        self.assertEqual(self.admin.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-10-16"})[0], 400)


class WorkflowTest(ServerCase):
    """Branch managers, day approval, owner-set prices, opening checks and deliveries."""
    KISUMU = {**SAMPLE, "station": "Moiben Branch"}

    def test_manager_needs_a_branch_and_is_limited_to_it(self):
        self.assertEqual(self.admin.req("POST", "/api/users", {"username": "nobranch", "password": "Mango-Tree-42",
                                                               "role": "manager"})[0], 400)
        mgr = Client(self.base).login("kmanager")
        self.assertEqual(mgr.req("POST", "/api/records", SAMPLE)[0], 403)               # Ngeria
        old = {**self.KISUMU, "report_date": "2026-10-01"}
        self.assertEqual(mgr.req("POST", "/api/records", old)[0], 201)                  # older days OK
        self.assertEqual(mgr.req("GET", "/api/users")[0], 403)

    def test_pumps_add_up_and_their_openings_are_checked(self):
        mgr = Client(self.base).login("kmanager")
        day = {"report_date": "2026-10-13", "station": "Moiben Branch", "petrol_price": 200, "diesel_price": 170,
               "pump_p1_open": 1000, "pump_p1_close": 1100, "pump_p1_sales_open": 5000, "pump_p1_sales_close": 25000,
               "pump_p2_open": 2000, "pump_p2_close": 2050, "pump_p2_sales_open": 100, "pump_p2_sales_close": 10100,
               "pump_p3_open": 300,                            # closing not read yet: counts as nothing sold
               "pump_d1_open": 10, "pump_d1_close": 40}
        rec = mgr.req("POST", "/api/records", day)[1]["record"]
        self.assertEqual((rec["petrol_litres"], rec["diesel_litres"], rec["kero_litres"]), (150, 30, 0))
        self.assertEqual(rec["petrol_pump_sales"], 30000)
        self.assertEqual(rec["petrol_revenue"], 30000)
        self.assertEqual((rec["petrol_open"], rec["petrol_close"]), (3300, 3150))   # totals kept for reports
        nxt = {**day, "report_date": "2026-10-14", "pump_p1_open": 1100, "pump_p1_close": 1200,
               "pump_p1_sales_open": 25000, "pump_p1_sales_close": 45000,
               "pump_p2_open": 2049, "pump_p2_close": 2100, "pump_d1_open": 40, "pump_d1_close": 45}
        mism = mgr.req("POST", "/api/records", nxt)[1]["record"]["opening_mismatches"]
        self.assertEqual([(m["field"], m["expected"]) for m in mism],
                         [("pump_p2_open", 2050), ("pump_p2_sales_open", 10100)])

    def test_staff_never_see_cost_margin_or_profit(self):
        staff, mgr = Client(self.base).login("kisumu"), Client(self.base).login("kmanager")
        day1 = {**self.KISUMU, "report_date": "2026-10-14"}
        rid = mgr.req("POST", "/api/records", day1)[1]["record"]["id"]
        hidden = ("petrol_cost", "diesel_cost", "petrol_margin", "total_fuel_cost", "total_cost",
                  "net_profit", "profit_margin", "profit_per_litre")
        rec = staff.req("GET", "/api/records/%d" % rid)[1]
        self.assertTrue(rec["gross_revenue"] > 0)
        self.assertFalse([k for k in hidden if k in rec])
        self.assertIn("net_profit", mgr.req("GET", "/api/records/%d" % rid)[1])
        # Staff save today's day without cost prices: the previous day's costs carry on,
        # so the owner's profit figures stay right
        status, res, _ = staff.req("POST", "/api/records", {**self.KISUMU, "report_date": "2026-10-15",
                                                            "petrol_cost": 1, "diesel_cost": 1})
        self.assertEqual(status, 201)
        self.assertNotIn("petrol_cost", res["record"])
        full = mgr.req("GET", "/api/records/%d" % res["record"]["id"])[1]
        self.assertEqual((full["petrol_cost"], full["diesel_cost"]), (174, 157))
        self.assertNotIn("net_profit", staff.req("GET", "/api/records")[1]["records"][0])
        self.assertNotIn("net_profit", staff.req("GET", "/api/analytics")[1]["totals"])
        report = staff.req("GET", "/api/reports/monthly?month=2026-10")[1]
        self.assertNotIn("net_profit", [f["key"] for f in report["fields"]])
        self.assertNotIn("net_profit", report["totals"])
        self.assertNotIn("net_profit", staff.req("GET", "/api/export.csv")[1].splitlines()[0])
        self.assertNotIn("net_profit", staff.req("GET", "/api/reports/monthly.csv?month=2026-10")[1])
        self.admin.req("POST", "/api/prices", {"stations": ["Moiben Branch"], "effective_from": "2026-10-01",
                                               "petrol_sell": 190, "petrol_cost": 175})
        prices = staff.req("GET", "/api/prices?station=Moiben+Branch")[1]["prices"]
        self.assertEqual(prices["petrol"].get("sell"), 190)
        self.assertNotIn("cost", prices["petrol"])
        self.assertFalse(any("cost" in p for p in staff.req("GET", "/api/prices/history")[1]["prices"]))
        mgr.req("POST", "/api/records", {**day1, "exp_wages": 5})
        changes = [c["field"] for h in staff.req("GET", "/api/records/%d/history" % rid)[1]["history"]
                   for c in h["changes"]]
        self.assertIn("exp_wages", changes)
        self.assertFalse([c for c in changes if c in hidden])

    def test_approved_day_is_locked_until_an_admin_reopens_it(self):
        staff, mgr = Client(self.base).login("kisumu"), Client(self.base).login("kmanager")
        rid = staff.req("POST", "/api/records", self.KISUMU)[1]["record"]["id"]
        self.assertEqual(staff.req("POST", "/api/records/%d/approve" % rid, {})[0], 403)
        status, res, _ = mgr.req("POST", "/api/records/%d/approve" % rid, {})
        self.assertEqual((status, res["record"]["approved_by"]), (200, "kmanager"))
        self.assertEqual(mgr.req("POST", "/api/records/%d/approve" % rid, {})[0], 409)
        for client in (staff, mgr, self.admin):                                         # nobody edits it
            self.assertEqual(client.req("POST", "/api/records", {**self.KISUMU, "cash_amount": 1})[0], 409)
        self.assertEqual(staff.req("DELETE", "/api/records/%d" % rid)[0], 409)
        self.assertEqual(mgr.req("POST", "/api/records/%d/reopen" % rid, {})[0], 403)
        self.assertEqual(self.admin.req("POST", "/api/records/%d/reopen" % rid, {})[0], 200)
        self.assertEqual(staff.req("POST", "/api/records", {**self.KISUMU, "cash_amount": 1})[0], 200)
        actions = [h["action"] for h in self.admin.req("GET", "/api/records/%d/history" % rid)[1]["history"]]
        self.assertEqual(actions, ["create", "approve", "reopen", "update"])
        other = self.admin.req("POST", "/api/records", SAMPLE)[1]["record"]["id"]
        self.assertEqual(mgr.req("POST", "/api/records/%d/approve" % other, {})[0], 404)  # other branch

    def test_binned_approved_day_cannot_be_overwritten(self):
        mgr, staff = Client(self.base).login("kmanager"), Client(self.base).login("kisumu")
        rid = staff.req("POST", "/api/records", self.KISUMU)[1]["record"]["id"]
        mgr.req("POST", "/api/records/%d/approve" % rid, {})
        self.assertEqual(self.admin.req("DELETE", "/api/records?station=Moiben%20Branch")[1]["deleted"], 1)
        self.assertEqual(staff.req("POST", "/api/records", {**self.KISUMU, "cash_amount": 1})[0], 409)
        self.assertEqual(self.admin.req("POST", "/api/bin/%d/restore" % rid, {})[0], 200)
        self.assertEqual(self.admin.req("GET", "/api/records/%d" % rid)[1]["cash_amount"], 7550)

    def test_owner_prices_override_typed_prices(self):
        staff = Client(self.base).login("kisumu")
        body = {"stations": ["Moiben Branch", "Himaki Branch"], "effective_from": "2026-10-14",
                "petrol_sell": 190.5, "petrol_cost": 175}
        self.assertEqual(staff.req("POST", "/api/prices", body)[0], 403)
        self.assertEqual(self.admin.req("POST", "/api/prices", body)[1]["saved"], 2)
        self.assertEqual(self.admin.req("POST", "/api/prices", {**body, "petrol_cost": 999})[0], 400)
        self.assertEqual(self.admin.req("POST", "/api/prices", {**body, "stations": ["Moon"]})[0], 400)
        prices = staff.req("GET", "/api/prices?date=2026-10-14")[1]["prices"]
        self.assertEqual(prices["petrol"]["sell"], 190.5)
        self.assertNotIn("diesel", prices)                    # diesel left blank, not set
        self.assertEqual(staff.req("GET", "/api/prices?date=2026-10-13")[1]["prices"], {})
        rec = staff.req("POST", "/api/records", {**self.KISUMU, "petrol_price": 100})[1]["record"]
        self.assertEqual(rec["petrol_price"], 190.5)
        self.assertEqual(self.admin.req("GET", "/api/records/%d" % rec["id"])[1]["petrol_cost"], 175)
        self.assertEqual(rec["diesel_price"], 172)            # typed price kept where none is set
        self.assertEqual(rec["prices_set_by_owner"], ["petrol"])
        self.assertEqual(rec["gross_revenue"], round(100 * 190.5 + 50 * 172 + 2000, 2))

    def test_openings_are_checked_against_the_previous_day(self):
        yday = {**SAMPLE, "report_date": "2026-10-13", "petrol_dip_close": 5000}
        self.admin.req("POST", "/api/records", yday)
        prev = self.admin.req("GET", "/api/records/previous?station=Ngeria%20Branch&date=2026-10-14")[1]
        self.assertEqual(prev["record"]["report_date"], "2026-10-13")
        good = {**SAMPLE, "petrol_open": 1100, "petrol_close": 1200, "diesel_open": 550, "diesel_close": 600,
                "petrol_dip_open": 5000}
        self.assertEqual(self.admin.req("POST", "/api/records", good)[1]["record"]["opening_mismatches"], [])
        bad = {**good, "petrol_open": 1080}
        mism = self.admin.req("POST", "/api/records", bad)[1]["record"]["opening_mismatches"]
        self.assertEqual(mism, [{"field": "petrol_open", "expected": 1100, "entered": 1080,
                                 "from_date": "2026-10-13"}])

    def test_deliveries_set_received_litres(self):
        body = {**SAMPLE, "petrol_delivered": 1,  "deliveries": [
            {"fuel": "petrol", "supplier": "Vivo", "note_no": "DN-1", "truck_reg": "KCA 111A",
             "litres_ordered": 10000, "litres_received": 9950, "dip_before": 2000, "dip_after": 11940},
            {"fuel": "petrol", "litres_ordered": 5000, "litres_received": 5000},
            {"fuel": "jetfuel", "litres_received": 99}]}
        rec = self.admin.req("POST", "/api/records", body)[1]["record"]
        self.assertEqual(rec["petrol_delivered"], 14950)
        self.assertEqual(rec["diesel_delivered"], 0)
        self.assertEqual(len(rec["deliveries"]), 2)            # unknown fuel dropped
        self.assertEqual(rec["delivery_shortfall_litres"], 50)

    def test_old_databases_gain_the_manager_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "old.sqlite3")
            import sqlite3
            conn = sqlite3.connect(path)
            conn.executescript("""
                CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    pw_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'staff')), station TEXT,
                    created_at TEXT NOT NULL, full_name TEXT);
                INSERT INTO users VALUES (7, 'mary', 'x', 'staff', 'Moiben Branch', '2026-01-01', 'Mary W');
            """)
            conn.close()
            store = server.Store(path)
            auth = server.Auth(store)
            self.assertEqual(auth.get(7)["display_name"], "Mary W")
            self.assertEqual(auth.create("boss2", "Mango-Tree-42", "manager", "Moiben Branch")["role"], "manager")
            store.conn.close()


class FakeMailer:
    configured = True

    def __init__(self):
        self.sent = []

    def send(self, to, subject, body):
        if to:
            self.sent.append((to, subject, body))
        return bool(to)

    def send_now(self, to, subject, body, attachments=()):
        self.send(to, subject, body)
        self.attachments = list(attachments)


class BusinessTest(ServerCase):
    """Cash per attendant, alerts, credit accounts and the monthly report."""

    def setUp(self):
        super().setUp()
        self.mail = FakeMailer()
        handler = self.httpd.RequestHandlerClass
        handler.mailer = self.mail
        handler.alerts.mailer = self.mail

    def test_attendant_shortages_are_totalled(self):
        body = {**SAMPLE, "attendants": [
            {"name": "Otieno", "expected": 10000, "cash": 4000, "mpesa": 5200},   # short 800
            {"name": "Wanjiru", "expected": 8000, "cash": 3000, "mpesa": 5100}]}  # over 100
        rec = self.admin.req("POST", "/api/records", body)[1]["record"]
        self.assertEqual((rec["attendant_shortage_total"], rec["attendant_excess_total"]), (800, 100))

    def test_alerts_are_raised_scoped_emailed_and_cleared(self):
        self.admin.req("PUT", "/api/settings", {"alert_emails": "owner@example.com, boss@example.com"})
        bad = {**SAMPLE, "station": "Moiben Branch", "petrol_dip_open": 5000, "petrol_dip_close": 2000,
               "cash_amount": 0, "attendants": [{"name": "Otieno", "expected": 9000, "cash": 1000}]}
        rid = self.admin.req("POST", "/api/records", bad)[1]["record"]["id"]
        self.admin.req("POST", "/api/records", {**SAMPLE, "cash_amount": 0})          # Ngeria: cash short
        alerts = self.admin.req("GET", "/api/alerts")[1]
        kinds = sorted((a["station"][:7], a["kind"]) for a in alerts["alerts"])
        self.assertEqual(kinds, [("Moiben ", "attendant_shortage"), ("Moiben ", "cash_shortage"),
                                 ("Moiben ", "dip_shortage"), ("Moiben ", "low_stock"),
                                 ("Ngeria ", "cash_shortage")])
        self.assertEqual(alerts["unread"], 5)
        self.assertEqual(len(self.mail.sent), 2)                                     # one email per save
        self.assertEqual(self.mail.sent[0][0], ["owner@example.com", "boss@example.com"])
        self.assertIn("Moiben Branch", self.mail.sent[0][1])

        mgr = Client(self.base).login("kmanager")
        self.assertEqual({a["station"] for a in mgr.req("GET", "/api/alerts")[1]["alerts"]}, {"Moiben Branch"})
        self.assertEqual(Client(self.base).login("kisumu").req("GET", "/api/alerts")[0], 403)
        self.assertEqual(mgr.req("POST", "/api/alerts/read", {"all": True})[1]["marked"], 4)
        self.assertEqual(mgr.req("GET", "/api/alerts")[1]["unread"], 0)
        self.assertEqual(self.admin.req("GET", "/api/alerts")[1]["unread"], 5)      # read is per person

        fixed = {**bad, "petrol_dip_close": 4900, "cash_amount": 9550, "attendants": []}   # sales fully collected
        self.admin.req("POST", "/api/records", fixed)                                # same day, corrected
        left = [a["kind"] for a in self.admin.req("GET", "/api/alerts")[1]["alerts"] if a["record_id"] == rid]
        self.assertEqual(left, [])
        self.assertEqual(len(self.mail.sent), 2)                                     # clearing sends nothing
        everything = self.admin.req("GET", "/api/alerts?all=1")[1]["alerts"]
        self.assertTrue(all(a["cleared_at"] for a in everything if a["record_id"] == rid))

    def test_alert_settings_are_admin_only_and_validated(self):
        self.assertEqual(Client(self.base).login("kmanager").req("GET", "/api/settings")[0], 403)
        self.assertEqual(self.admin.req("PUT", "/api/settings", {"alert_emails": "not an email"})[0], 400)
        self.assertEqual(self.admin.req("PUT", "/api/settings", {"low_stock_kero": -5})[0], 400)
        res = self.admin.req("PUT", "/api/settings", {"low_stock_kero": 500, "unknown": 1})[1]
        self.assertEqual(res["settings"]["low_stock_kero"], 500)
        rec = {**SAMPLE, "kero_dip_open": 900, "kero_dip_close": 800}
        self.admin.req("POST", "/api/records", rec)
        self.assertEqual([a for a in self.admin.req("GET", "/api/alerts")[1]["alerts"] if a["kind"] == "low_stock"], [])
        self.assertEqual(self.admin.req("POST", "/api/settings/test-email", {})[0], 400)  # no addresses yet

    def test_credit_accounts_balance_from_invoices_and_payments(self):
        staff = Client(self.base).login("kisumu")
        cust = staff.req("POST", "/api/customers", {"name": "Peter Otieno", "company": "Matatu Sacco",
                                                   "credit_limit": 50000})[1]["customer"]
        self.assertEqual(cust["credit_limit"], 0)                       # staff can't set a limit
        self.assertEqual(staff.req("PUT", "/api/customers/%d" % cust["id"], {"credit_limit": 1})[0], 403)
        self.assertEqual(self.admin.req("PUT", "/api/customers/%d" % cust["id"],
                                        {"credit_limit": 15000})[1]["customer"]["credit_limit"], 15000)
        self.assertEqual(staff.req("POST", "/api/customers", {"name": "  "})[0], 400)
        self.assertEqual(self.admin.req("PUT", "/api/customers/%d" % cust["id"], {"name": ""})[0], 400)
        self.assertEqual(staff.req("POST", "/api/customers/%d/payments" % cust["id"],
                                   {"amount": 1, "paid_on": "2026-13-99"})[0], 400)
        inv = lambda amt, no: {"customer": "Peter Otieno", "customer_id": cust["id"], "amount": amt,
                               "invoiceNo": no, "fuelType": "Diesel", "carReg": "KDA 123X"}
        day1 = {**SAMPLE, "station": "Moiben Branch", "report_date": "2026-10-14", "invoices": [inv(9000, "INV-1")]}
        day2 = {**day1, "report_date": "2026-10-15", "invoices": [inv(8000, "INV-2"), {"customer": "walk-in", "amount": 50}]}
        staff.req("POST", "/api/records", day1)
        rid2 = staff.req("POST", "/api/records", day2)[1]["record"]["id"]
        c = [x for x in staff.req("GET", "/api/customers")[1]["customers"] if x["id"] == cust["id"]][0]
        self.assertEqual((c["invoiced"], c["balance"], c["over_limit"]), (17000, 17000, True))

        self.assertEqual(staff.req("POST", "/api/customers/%d/payments" % cust["id"], {"amount": 0})[0], 400)
        self.assertEqual(staff.req("POST", "/api/customers/%d/payments" % cust["id"],
                                   {"amount": 1, "paid_on": "2026-12-01"})[0], 400)   # future date
        res = staff.req("POST", "/api/customers/%d/payments" % cust["id"],
                        {"amount": 10000, "method": "M-Pesa", "reference": "RGK7ABC", "paid_on": "2026-10-15"})[1]
        self.assertEqual(res["customer"]["balance"], 7000)
        self.assertEqual([(e["type"], e["balance"]) for e in res["entries"]],
                         [("invoice", 9000), ("invoice", 17000), ("payment", 7000)])
        pid = res["payment_id"]
        self.assertEqual(staff.req("POST", "/api/payments/%d/void" % pid, {})[0], 403)
        self.assertEqual(self.admin.req("POST", "/api/payments/%d/void" % pid, {})[0], 200)
        self.admin.req("DELETE", "/api/records/%d" % rid2)                      # binned day's invoice drops out
        stmt = self.admin.req("GET", "/api/customers/%d/statement" % cust["id"])[1]
        self.assertEqual((stmt["customer"]["balance"], len(stmt["entries"])), (9000, 1))
        self.assertEqual(self.admin.req("GET", "/api/customers/999/statement")[0], 404)

    def test_monthly_report(self):
        self.admin.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-10-01"})
        self.admin.req("POST", "/api/records", SAMPLE)
        k = self.admin.req("POST", "/api/records", {**SAMPLE, "station": "Moiben Branch"})[1]["record"]["id"]
        self.admin.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-09-30"})   # other month
        Client(self.base).login("kmanager").req("POST", "/api/records/%d/approve" % k, {})
        rep = self.admin.req("GET", "/api/reports/monthly?month=2026-10")[1]
        by = {b["station"]: b for b in rep["branches"]}
        self.assertEqual((by["Ngeria Branch"]["days"], by["Moiben Branch"]["approved_days"]), (2, 1))
        self.assertEqual(by["Ngeria Branch"]["petrol_litres"], 200)
        self.assertEqual(rep["totals"]["days"], 3)
        self.assertEqual(rep["totals"]["net_profit"], 3 * 3100)
        mgr = Client(self.base).login("kmanager").req("GET", "/api/reports/monthly?month=2026-10")[1]
        self.assertEqual([b["station"] for b in mgr["branches"]], ["Moiben Branch"])
        self.assertEqual(self.admin.req("GET", "/api/reports/monthly?month=Oct")[0], 400)
        status, csv_text, headers = self.admin.req("GET", "/api/reports/monthly.csv?month=2026-10")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertEqual(len(csv_text.strip().splitlines()), 4)     # header, 2 branches, totals


class UploadTest(ServerCase):
    JPEG = b"\xff\xd8\xff\xe0" + b"0" * 200
    PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 50

    def upload(self, client, data, station="Moiben Branch"):
        import base64
        return client.req("POST", "/api/uploads", {"data": base64.b64encode(data).decode(), "station": station})

    def test_photos_are_checked_and_kept_to_their_branch(self):
        staff = Client(self.base).login("kisumu")
        status, up, _ = self.upload(staff, self.JPEG)
        self.assertEqual((status, up["mime"]), (201, "image/jpeg"))
        self.assertEqual(self.upload(staff, b"<svg onload=alert(1)>")[0], 400)          # not a photo
        self.assertEqual(self.upload(staff, self.PNG, station="Ngeria Branch")[0], 403)
        self.assertEqual(self.upload(staff, b"\xff\xd8\xff" + b"0" * (3 * 1024 * 1024))[0], 413)

        r = staff.opener.open(self.base + "/api/uploads/" + up["id"])
        self.assertEqual((r.status, r.headers["Content-Type"], r.read()[:3]), (200, "image/jpeg", b"\xff\xd8\xff"))
        self.assertEqual(self.admin.req("GET", "/api/uploads/" + up["id"])[0], 200)
        other = Client(self.base).login("roamer")                                      # no branch: all
        self.assertEqual(other.req("GET", "/api/uploads/" + up["id"])[0], 200)
        west = self.upload(self.admin, self.PNG, station="Ngeria Branch")[1]
        self.assertEqual(staff.req("GET", "/api/uploads/" + west["id"])[0], 404)
        self.assertEqual(staff.req("GET", "/api/uploads/" + "0" * 32)[0], 404)
        self.assertEqual(Client(self.base).req("GET", "/api/uploads/" + up["id"])[0], 401)

        rec = staff.req("POST", "/api/records", {**SAMPLE, "station": "Moiben Branch", "receipts": [
            {"id": 1, "label": "Electricity token", "amount": 1500, "upload_id": up["id"]},
            {"id": 2, "label": "Westlands photo", "upload_id": west["id"]},
            {"id": 3, "label": "Made up", "upload_id": "f" * 32}]})[1]["record"]
        self.assertEqual([(x["label"], x["upload_id"]) for x in rec["receipts"]], [("Electricity token", up["id"])])


class BootstrapTest(unittest.TestCase):
    def test_first_start_creates_one_admin(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = server.Store(os.path.join(tmp, "b.sqlite3"))
            auth = server.Auth(store)
            server.bootstrap_admin(auth)
            server.bootstrap_admin(auth)
            users = auth.list()
            self.assertEqual([(u["username"], u["role"]) for u in users], [("admin", "admin")])
            store.conn.close()


if __name__ == "__main__":
    unittest.main()


class BackupTest(ServerCase):
    """Backups: made by admins or the nightly schedule, kept 14 deep, emailed, and restorable."""

    def setUp(self):
        super().setUp()
        self.backups = self.httpd.RequestHandlerClass.backups
        for b in self.backups.list():
            os.remove(os.path.join(self.backups.folder, b["name"]))

    def test_only_admins_back_up_and_download(self):
        import io
        import zipfile
        self.admin.req("POST", "/api/records", SAMPLE)
        staff = Client(self.base).login("kisumu")
        self.assertEqual(staff.req("POST", "/api/backups", {})[0], 403)
        self.assertEqual(staff.req("GET", "/api/backups")[0], 403)
        status, res, _ = self.admin.req("POST", "/api/backups", {})
        self.assertEqual(status, 201)
        name = res["backup"]["name"]
        self.assertEqual([b["name"] for b in self.admin.req("GET", "/api/backups")[1]["backups"]], [name])
        self.assertEqual(staff.req("GET", "/api/backups/" + name)[0], 403)
        self.assertEqual(self.admin.req("GET", "/api/backups/../t.sqlite3")[0], 404)
        self.assertEqual(self.admin.req("GET", "/api/backups/nope.zip")[0], 404)
        r = self.admin.opener.open(self.base + "/api/backups/" + name)
        self.assertEqual(r.headers["Content-Type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(r.read())) as z:
            self.assertIn("petrokenya.sqlite3", z.namelist())

    def test_only_the_latest_fourteen_are_kept_and_the_schedule_waits_a_day(self):
        for _ in range(16):
            self.backups.create()
        self.assertEqual(len(self.backups.list()), 14)
        self.assertFalse(self.backups.due())
        self.assertFalse(self.backups.run_due())
        old = (datetime.now() - timedelta(hours=25)).timestamp()
        for b in self.backups.list():
            os.utime(os.path.join(self.backups.folder, b["name"]), (old, old))
        self.assertTrue(self.backups.due())

    def test_backup_email_carries_the_database(self):
        import io
        import zipfile
        handler = self.httpd.RequestHandlerClass
        real, handler.backups.mailer = handler.backups.mailer, FakeMailer()
        try:
            self.assertEqual(self.admin.req("POST", "/api/backups/email", {})[0], 400)   # no address yet
            self.assertEqual(self.admin.req("PUT", "/api/settings", {"backup_emails": "not-an-email"})[0], 400)
            self.admin.req("PUT", "/api/settings", {"backup_emails": "owner@example.com"})
            status, res, _ = self.admin.req("POST", "/api/backups/email", {})
            self.assertEqual((status, res["sent_to"]), (200, ["owner@example.com"]))
            filename, data = handler.backups.mailer.attachments[0]
            self.assertTrue(filename.startswith("petrokenya-db-"))
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                self.assertEqual(z.namelist(), ["petrokenya.sqlite3"])
            self.assertTrue(self.admin.req("GET", "/api/backups")[1]["last_email"]["ok"])
        finally:
            handler.backups.mailer = real

    def test_restore_brings_a_backup_back_and_keeps_the_replaced_database(self):
        import business
        self.admin.req("POST", "/api/records", SAMPLE)
        made = self.backups.create()
        zip_path = os.path.join(self.backups.folder, made["name"])
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "live.sqlite3")
            with open(target, "w") as f:
                f.write("this will be replaced")
            done = business.restore(zip_path, target, os.path.join(tmp, "up"), os.path.join(tmp, "bk"))
            self.assertEqual(done["days"], 1)
            with open(done["saved_current_as"]) as f:                 # a damaged file is kept as it was
                self.assertEqual(f.read(), "this will be replaced")
            restored = server.Store(target)
            self.assertEqual(restored.list()[0]["report_date"], SAMPLE["report_date"])
            restored.conn.close()
            again = business.restore(zip_path, target, os.path.join(tmp, "up"), os.path.join(tmp, "bk"))
            self.assertTrue(os.path.exists(again["saved_current_as"]))
            bad = os.path.join(tmp, "bad.zip")
            with open(bad, "wb") as f:
                f.write(b"not a zip")
            with self.assertRaises(business.Error):
                business.restore(bad, target, os.path.join(tmp, "up"), os.path.join(tmp, "bk"))


class StationTest(ServerCase):
    """Branches are added by the admin; nothing can be saved to a branch that doesn't exist."""

    def test_admin_adds_and_removes_branches(self):
        staff = Client(self.base).login("kisumu")
        self.assertEqual(staff.req("POST", "/api/stations", {"name": "Eldoret Branch"})[0], 403)
        self.assertEqual(self.admin.req("POST", "/api/records", {**SAMPLE, "station": "Eldoret Branch"})[0], 400)
        self.assertEqual(self.admin.req("POST", "/api/stations", {"name": "x"})[0], 400)
        self.assertEqual(self.admin.req("POST", "/api/stations", {"name": "<b>Bad</b>"})[0], 400)
        status, res, _ = self.admin.req("POST", "/api/stations", {"name": "  Eldoret   Branch "})
        self.assertEqual((status, res["station"]), (201, "Eldoret Branch"))
        self.assertEqual(res["stations"][-1], "Eldoret Branch")
        self.assertEqual(self.admin.req("POST", "/api/stations", {"name": "eldoret branch"})[0], 409)
        self.assertEqual(staff.req("GET", "/api/stations")[1]["stations"], ["Moiben Branch"])   # own branch only
        self.assertEqual(self.admin.req("POST", "/api/records", {**SAMPLE, "station": "Eldoret Branch"})[0], 201)
        self.assertEqual(self.admin.req("DELETE", "/api/stations/Eldoret%20Branch")[0], 409)    # has a saved day
        self.admin.req("POST", "/api/stations", {"name": "Spare Branch"})
        self.assertEqual(staff.req("DELETE", "/api/stations/Spare%20Branch")[0], 403)
        status, res, _ = self.admin.req("DELETE", "/api/stations/Spare%20Branch")
        self.assertEqual(status, 200)
        self.assertNotIn("Spare Branch", res["stations"])
        self.assertEqual(self.admin.req("DELETE", "/api/stations/Nowhere")[0], 404)
        self.assertEqual(self.admin.req("POST", "/api/users", {"username": "newbie", "password": "Mango-Tree-42",
                                                               "role": "staff", "station": "Nowhere"})[0], 400)
        store = self.httpd.RequestHandlerClass.store
        store.conn.execute("DELETE FROM records WHERE station = 'Eldoret Branch'")
        store.conn.execute("DELETE FROM stations WHERE name = 'Eldoret Branch'")
        store.conn.commit()

    def test_a_new_database_starts_without_branches_and_old_ones_keep_theirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            fresh = server.Store(os.path.join(tmp, "new.sqlite3"))
            self.assertEqual(fresh.stations(), [])
            fresh.conn.close()
            import sqlite3
            old_path = os.path.join(tmp, "old.sqlite3")
            old = server.Store(old_path)
            old.save({**server.clean_input({**SAMPLE, "station": "Old Town Branch"})}, by="t")
            old.conn.execute("DROP TABLE stations")          # as it was before branches were managed
            old.conn.commit()
            old.conn.close()
            again = server.Store(old_path)
            self.assertEqual(again.stations(), ["Old Town Branch"])
            again.conn.close()


class RenameStationTest(ServerCase):
    def test_renaming_a_branch_carries_everything_with_it(self):
        store = self.httpd.RequestHandlerClass.store
        self.admin.req("POST", "/api/stations", {"name": "Old Name Branch"})
        self.admin.req("POST", "/api/users", {"username": "olduser", "password": "Mango-Tree-42",
                                              "role": "staff", "station": "Old Name Branch"})
        rid = self.admin.req("POST", "/api/records", {**SAMPLE, "station": "Old Name Branch", "cash_amount": 0})[1]["record"]["id"]
        self.admin.req("POST", "/api/records", {**SAMPLE, "station": "Old Name Branch", "cash_amount": 5})
        self.admin.req("POST", "/api/prices", {"stations": ["Old Name Branch"], "effective_from": "2026-10-01",
                                               "petrol_sell": 190, "petrol_cost": 175})
        staff = Client(self.base).login("kisumu")
        self.assertEqual(staff.req("PUT", "/api/stations/Old%20Name%20Branch", {"name": "X Branch"})[0], 403)
        self.assertEqual(self.admin.req("PUT", "/api/stations/Old%20Name%20Branch", {"name": "ngeria branch"})[0], 409)
        self.assertEqual(self.admin.req("PUT", "/api/stations/Old%20Name%20Branch", {"name": "!"})[0], 400)
        self.assertEqual(self.admin.req("PUT", "/api/stations/Nowhere", {"name": "Somewhere"})[0], 404)
        status, res, _ = self.admin.req("PUT", "/api/stations/Old%20Name%20Branch", {"name": "New  Name Branch "})
        self.assertEqual((status, res["station"]), (200, "New Name Branch"))
        self.assertNotIn("Old Name Branch", res["stations"])
        rec = self.admin.req("GET", "/api/records/%d" % rid)[1]
        self.assertEqual(rec["station"], "New Name Branch")
        self.assertEqual(len(self.admin.req("GET", "/api/records?station=New%20Name%20Branch")[1]["records"]), 1)
        changes = [c["field"] for h in self.admin.req("GET", "/api/records/%d/history" % rid)[1]["history"]
                   for c in h["changes"]]
        self.assertNotIn("station", changes)                      # a rename isn't shown as an edit
        moved = Client(self.base).login("olduser", "Mango-Tree-42")
        self.assertEqual(moved.req("GET", "/api/me")[1]["user"]["station"], "New Name Branch")
        self.assertEqual(moved.req("GET", "/api/prices?station=New+Name+Branch")[1]["prices"]["petrol"]["sell"], 190)
        self.assertTrue(all(a["station"] == "New Name Branch" and "Old Name" not in a["message"]
                            for a in self.admin.req("GET", "/api/alerts")[1]["alerts"]))
        self.assertEqual(self.admin.req("PUT", "/api/stations/New%20Name%20Branch", {"name": "new name branch"})[0], 200)
        store.conn.execute("DELETE FROM records WHERE station = 'new name branch'")
        store.conn.execute("DELETE FROM users WHERE username = 'olduser'")
        store.conn.execute("DELETE FROM stations WHERE name = 'new name branch'")
        store.conn.commit()


class FakeSms:
    configured = True

    def __init__(self):
        self.sent = []

    def send(self, phone, message):
        self.sent.append((phone, message))
        return True


class PasswordResetTest(ServerCase):
    """Forgotten passwords: a code by email, SMS or via the admin; one use, 15 minutes, 5 tries."""

    def setUp(self):
        super().setUp()
        h = self.httpd.RequestHandlerClass
        self.real = (h.mailer, h.sms)
        h.mailer, h.sms = FakeMailer(), FakeSms()
        h.auth.reset_requests.clear()
        h.store.conn.execute("DELETE FROM password_resets")
        h.store.conn.execute("UPDATE users SET email = NULL, phone = NULL")
        h.store.conn.commit()

    def tearDown(self):
        h = self.httpd.RequestHandlerClass
        h.mailer, h.sms = self.real
        h.auth.set_password(h.auth.find("kisumu")["id"], PASSWORD)

    def code_from(self, text):
        import re
        return re.search(r"\b(\d{6})\b", text).group(1)

    def forgot(self, username):
        return Client(self.base).req("POST", "/api/password/forgot", {"username": username})

    def reset(self, username, code, password="Fresh-Pass-2026"):
        return Client(self.base).req("POST", "/api/password/reset",
                                     {"username": username, "code": code, "new_password": password})

    def test_contact_details_are_checked_and_cleaned(self):
        staff = Client(self.base).login("kisumu")
        self.assertEqual(staff.req("POST", "/api/me/contact", {"phone": "12"})[0], 400)
        self.assertEqual(staff.req("POST", "/api/me/contact", {"email": "nope"})[0], 400)
        res = staff.req("POST", "/api/me/contact", {"phone": "0712 345 678", "email": ""})[1]["user"]
        self.assertEqual((res["phone"], res["email"]), ("+254712345678", None))
        uid = res["id"]
        self.assertEqual(staff.req("PUT", "/api/users/%d/contact" % uid, {"phone": ""})[0], 403)
        res = self.admin.req("PUT", "/api/users/%d/contact" % uid, {"email": "k@example.com", "phone": "254112345678"})
        self.assertEqual((res[1]["user"]["email"], res[1]["user"]["phone"]), ("k@example.com", "+254112345678"))

    def test_code_by_sms_resets_the_password_once(self):
        h = self.httpd.RequestHandlerClass
        staff = Client(self.base).login("kisumu")
        staff.req("POST", "/api/me/contact", {"phone": "0712345678"})
        unknown = self.forgot("nobody-here")
        status, res, _ = self.forgot("kisumu")
        self.assertEqual(status, 200)
        self.assertEqual(unknown[1], res)                          # same answer: usernames stay private
        phone, text = h.sms.sent[-1]
        self.assertEqual(phone, "+254712345678")
        code = self.code_from(text)
        self.assertEqual(self.reset("kisumu", "000000" if code != "000000" else "111111")[0], 400)
        self.assertEqual(self.reset("kisumu", code, "short")[0], 400)         # password rules still apply
        self.assertEqual(self.reset("kisumu", code)[0], 200)
        self.assertEqual(staff.req("GET", "/api/me")[0], 401)                 # old sign-ins ended
        Client(self.base).login("kisumu", "Fresh-Pass-2026")
        self.assertEqual(self.reset("kisumu", code, "Another-Pass-2026")[0], 400)   # works only once

    def test_email_comes_first_and_admins_get_it_when_the_user_has_no_contact(self):
        h = self.httpd.RequestHandlerClass
        Client(self.base).login("kisumu").req("POST", "/api/me/contact", {"email": "k@example.com", "phone": "0712345678"})
        self.forgot("kisumu")
        self.assertEqual(h.mailer.sent[-1][0], ["k@example.com"])
        self.assertEqual(h.sms.sent, [])
        self.admin.req("POST", "/api/me/contact", {"email": "boss@example.com"})
        self.forgot("roamer")                                      # no email or phone of its own
        to, subject, body = h.mailer.sent[-1]
        self.assertEqual(to, ["boss@example.com"])
        self.assertIn("roamer", subject + body)
        self.assertEqual(self.reset("roamer", self.code_from(body))[0], 200)
        h.auth.set_password(h.auth.find("roamer")["id"], PASSWORD)

    def test_codes_stop_after_five_wrong_tries_and_requests_are_limited(self):
        h = self.httpd.RequestHandlerClass
        Client(self.base).login("kisumu").req("POST", "/api/me/contact", {"phone": "0712345678"})
        self.forgot("kisumu")
        code = self.code_from(h.sms.sent[-1][1])
        wrong = "%06d" % ((int(code) + 1) % 1000000)
        for _ in range(4):
            self.assertEqual(self.reset("kisumu", wrong)[0], 400)
        h.auth.fails.clear()                                      # (a different phone keeps trying)
        self.assertEqual(self.reset("kisumu", wrong)[0], 400)
        self.assertEqual(self.reset("kisumu", code)[0], 400)      # five wrong tries: the code is dead
        self.forgot("kisumu"); self.forgot("kisumu")
        self.assertEqual(len(h.sms.sent), 3)                      # three codes per account per 15 minutes
        self.assertEqual(self.forgot("kisumu")[0], 200)
        self.assertEqual(len(h.sms.sent), 3)
        self.forgot("x1"); self.assertEqual(self.forgot("x2")[0], 429)     # five requests per device
