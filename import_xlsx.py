"""Import the Excel workbook into dashboard/data.db (SQLite). Usage: python -I import_xlsx.py <xlsx> <db>"""
import sys, sqlite3, os, openpyxl, datetime

src, dst = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src, data_only=True)
if os.path.exists(dst):
    os.remove(dst)
db = sqlite3.connect(dst)

def ts(v):
    return v.strftime('%Y-%m-%d %H:%M:%S') if isinstance(v, datetime.datetime) else (v or None)
def rows(name):
    return [r for r in wb[name].iter_rows(min_row=2, values_only=True) if any(c is not None for c in r)]
def n(v):
    return None if v is None else float(v)
def i(v):
    return None if v is None else int(v)

db.executescript("""
CREATE TABLE units(unit_id TEXT PRIMARY KEY, unit_name TEXT NOT NULL, district TEXT NOT NULL,
  affiliation TEXT, active TEXT NOT NULL DEFAULT 'Y', note TEXT);
CREATE TABLE transactions(txn_id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(unit_id),
  fiscal_year INTEGER NOT NULL, month_no INTEGER NOT NULL, calendar_year INTEGER, month_name TEXT,
  disbursed_A REAL, stock_B REAL, reserve_C REAL, source TEXT, note TEXT, recorded_at TEXT, updated_at TEXT);
CREATE TABLE insights(id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT, insight TEXT, action TEXT,
  priority TEXT, status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE lessons(id TEXT PRIMARY KEY, unit_id TEXT, fiscal_year INTEGER, month_no INTEGER,
  problem TEXT, obstacle TEXT, solution TEXT, status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE kpi_targets(fiscal_year INTEGER PRIMARY KEY, green_min REAL, green_max REAL, warn_low REAL, warn_high REAL, note TEXT);
CREATE INDEX ix_txn_fy ON transactions(fiscal_year, month_no);
CREATE INDEX ix_txn_unit ON transactions(unit_id);
""")
db.executemany("INSERT INTO units VALUES(?,?,?,?,?,?)", [r[:6] for r in rows('Master_Units')])
db.executemany("INSERT OR REPLACE INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  [(r[0], r[1], i(r[2]), i(r[3]), i(r[4]), r[5], n(r[6]), n(r[7]), n(r[8]), r[9], r[10], ts(r[11]), ts(r[12])) for r in rows('Transactions')])
db.executemany("INSERT INTO insights VALUES(?,?,?,?,?,?,?,?,?)",
  [(*r[:7], ts(r[7]), ts(r[8])) for r in rows('Key_Insights')])
db.executemany("INSERT INTO lessons VALUES(?,?,?,?,?,?,?,?,?,?)",
  [(r[0], r[1], i(r[2]), i(r[3]), r[4], r[5], r[6], r[7], ts(r[8]), ts(r[9])) for r in rows('Lessons_Learned')])
db.executemany("INSERT INTO kpi_targets VALUES(?,?,?,?,?,?)", [(i(r[0]), *map(n, r[1:5]), r[5]) for r in rows('KPI_Targets')])
db.commit()
for t in ['units','transactions','insights','lessons','kpi_targets']:
    print(t, db.execute(f'select count(*) from {t}').fetchone()[0])
print(db.execute("select count(*) from transactions where unit_id not in (select unit_id from units)").fetchone())
print(db.execute("select fiscal_year,month_no,calendar_year,month_name,count(*) from transactions group by 1,2 order by 1,2").fetchall())
print(db.execute("select distinct district from units").fetchall())
print(db.execute("select distinct priority,status from insights").fetchall())
