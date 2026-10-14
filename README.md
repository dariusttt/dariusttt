# PetroKenya — Station Dashboard

Daily fuel station management: pump meters, payments (M-Pesa / cash / credit / card),
gases & lubricants, tank dips, expenses, credit invoices, KRA tax figures, analytics
and records.

## Run it

Requires only Python 3.9+ (no packages to install).

```bash
python3 server.py
```

Then open **http://localhost:8000**. The server hosts the dashboard and its API on the
same localhost port, and stores records in `petrokenya.sqlite3` next to `server.py`.

| Env var | Default                  | Purpose                 |
|---------|--------------------------|-------------------------|
| `PORT`  | `8000`                   | Port to listen on       |
| `HOST`  | `127.0.0.1`              | Use `0.0.0.0` for LAN   |
| `PK_DB` | `./petrokenya.sqlite3`   | SQLite database file    |

Opening `index.html` directly (without the server) still works; records are then kept
in the browser's localStorage instead.

## API

All bodies are JSON. The server recomputes every figure (litres, revenue, profit,
VAT, excise, road levy, dip and pump variances) from the raw inputs on save.

| Method | Path                    | Description                                              |
|--------|-------------------------|----------------------------------------------------------|
| GET    | `/api/health`           | Service status                                           |
| GET    | `/api/stations`         | Branch list                                              |
| POST   | `/api/compute`          | Compute figures from raw inputs without saving           |
| GET    | `/api/records`          | List records — `?station=&date=&from=&to=&limit=`        |
| POST   | `/api/records`          | Save a record (updates the existing date + station row)  |
| GET    | `/api/records/{id}`     | One record                                               |
| PUT    | `/api/records/{id}`     | Replace a record                                         |
| DELETE | `/api/records/{id}`     | Delete a record                                          |
| DELETE | `/api/records`          | Delete all records (`?station=` to limit to one branch)  |
| GET    | `/api/analytics`        | Last-7-day series and all-time totals (`?station=`)      |
| GET    | `/api/export.csv`       | CSV export (`?station=`)                                 |

Example:

```bash
curl -X POST localhost:8000/api/records -H 'Content-Type: application/json' -d '{
  "report_date": "2026-10-14", "station": "Westlands Branch",
  "petrol_open": 1000, "petrol_close": 1100, "petrol_price": 189.5, "petrol_cost": 174,
  "mpesa_amount": 18950
}'
```

## Tests

```bash
python3 -m unittest discover -s tests
```
