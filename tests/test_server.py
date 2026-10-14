"""API tests for server.py — run with:  python3 -m unittest discover -s tests"""

import json
import os
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import server  # noqa: E402

SAMPLE = {
    "report_date": "2026-10-14",
    "station": "Westlands Branch",
    "petrol_open": 1000, "petrol_close": 1100, "petrol_price": 189.5, "petrol_cost": 174,
    "diesel_open": 500, "diesel_close": 550, "diesel_price": 172, "diesel_cost": 157,
    "mpesa_amount": 20000, "cash_amount": 7550,
    "exp_wages": 1000,
    "misc_items": [{"name": "Tip", "amount": 200}],
    "gas_items": [{"name": "6kg LPG", "category": "Gas", "qty": 2, "price": 1000}],
}


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.httpd = server.make_server("127.0.0.1", 0, os.path.join(cls.tmp.name, "t.sqlite3"))
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.httpd.RequestHandlerClass.store.conn.close()
        cls.tmp.cleanup()

    def setUp(self):
        self.req("DELETE", "/api/records")

    def req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        r = Request(self.base + path, data=data, method=method,
                    headers={"Content-Type": "application/json"} if data else {})
        try:
            with urlopen(r) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                return resp.status, (json.loads(raw) if "json" in ctype else raw.decode())
        except HTTPError as e:
            return e.code, json.loads(e.read())

    def test_serves_dashboard_and_health(self):
        status, html = self.req("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("PetroKenya", html)
        status, body = self.req("GET", "/api/health")
        self.assertEqual((status, body["status"]), (200, "ok"))

    def test_compute_matches_dashboard_formulas(self):
        status, c = self.req("POST", "/api/compute", SAMPLE)
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
        status, res = self.req("POST", "/api/records", SAMPLE)
        self.assertEqual(status, 201)
        rid = res["record"]["id"]
        self.assertEqual(res["record"]["net_profit"], 3100)

        # Same date + station updates in place
        status, res = self.req("POST", "/api/records", {**SAMPLE, "exp_wages": 2000})
        self.assertEqual(status, 200)
        self.assertFalse(res["created"])
        self.assertEqual(res["record"]["id"], rid)
        self.assertEqual(res["record"]["net_profit"], 2100)

        _, lst = self.req("GET", "/api/records")
        self.assertEqual(lst["count"], 1)
        status, rec = self.req("GET", "/api/records/%d" % rid)
        self.assertEqual((status, rec["station"]), (200, "Westlands Branch"))

        self.assertEqual(self.req("DELETE", "/api/records/%d" % rid)[0], 200)
        self.assertEqual(self.req("GET", "/api/records/%d" % rid)[0], 404)
        self.assertEqual(self.req("DELETE", "/api/records/%d" % rid)[0], 404)

    def test_filters_analytics_and_bulk_delete(self):
        self.req("POST", "/api/records", SAMPLE)
        self.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-10-13"})
        self.req("POST", "/api/records", {**SAMPLE, "station": "Kisumu Branch"})

        _, lst = self.req("GET", "/api/records?station=Kisumu%20Branch")
        self.assertEqual(lst["count"], 1)
        _, lst = self.req("GET", "/api/records?date=2026-10-14")
        self.assertEqual(lst["count"], 2)

        _, a = self.req("GET", "/api/analytics?station=Westlands%20Branch")
        self.assertEqual(a["totals"]["days"], 2)
        self.assertEqual([d["report_date"] for d in a["last_7"]], ["2026-10-13", "2026-10-14"])

        status, csv_text = self.req("GET", "/api/export.csv")
        self.assertEqual(status, 200)
        self.assertEqual(len(csv_text.strip().splitlines()), 4)

        _, d = self.req("DELETE", "/api/records?station=Kisumu%20Branch")
        self.assertEqual(d["deleted"], 1)
        _, lst = self.req("GET", "/api/records")
        self.assertEqual(lst["count"], 2)

    def test_put_conflict(self):
        _, a = self.req("POST", "/api/records", SAMPLE)
        self.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-10-13"})
        status, err = self.req("PUT", "/api/records/%d" % a["record"]["id"],
                               {**SAMPLE, "report_date": "2026-10-13"})
        self.assertEqual(status, 409)
        self.assertIn("error", err)

    def test_validation(self):
        self.assertEqual(self.req("POST", "/api/records", {"station": "X"})[0], 400)
        self.assertEqual(self.req("POST", "/api/records", {**SAMPLE, "report_date": "2026-13-40"})[0], 400)
        self.assertEqual(self.req("POST", "/api/records", {**SAMPLE, "gas_items": "nope"})[0], 400)
        self.assertEqual(self.req("GET", "/api/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
