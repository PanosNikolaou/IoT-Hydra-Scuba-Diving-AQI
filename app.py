import time
import threading
import os
from datetime import datetime, timezone, timedelta
try:
    # Python 3.9+: zoneinfo is preferred
    from zoneinfo import ZoneInfo
    _ATHENS_TZ = ZoneInfo('Europe/Athens')
except Exception:
    # Fallback: try dateutil (commonly installed via pandas)
    try:
        from dateutil import tz as _dz
        _ATHENS_TZ = _dz.gettz('Europe/Athens')
    except Exception:
        # Last-resort: fixed offset of +02:00 (works for winter; DST not handled)
        _ATHENS_TZ = timezone(timedelta(hours=2))
        # (no per-branch to_athens_iso here; define a single helper below)
        pass

# Module-level helper to convert datetimes to Europe/Athens ISO strings.
def to_athens_iso(dt):
    """Convert a datetime (naive or aware) to an ISO string in Europe/Athens timezone.

    Returns None if dt is falsy or cannot be converted.
    """
    if not dt:
        return None
    try:
        # If dt has no tzinfo, assume it is UTC (existing DB rows are stored as naive UTC)
        if getattr(dt, 'tzinfo', None) is None:
            aware = dt.replace(tzinfo=timezone.utc)
        else:
            # Normalize to UTC first to avoid issues
            aware = dt.astimezone(timezone.utc)
        return aware.astimezone(_ATHENS_TZ).isoformat()
    except Exception:
        try:
            return dt.isoformat()
        except Exception:
            return None
from uuid import uuid4
import traceback

from flask import Flask, request, jsonify, render_template
import json
from flask_sqlalchemy import SQLAlchemy
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import NullPool
from sqlalchemy import text

import xbreemw

app = Flask(__name__)

# Database configuration
# Use the `instance` folder DB to avoid updating the wrong file during migrations/tests
# Ensure an absolute path so Flask/SQLAlchemy do not resolve relative paths inconsistently
DB_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), 'instance', 'iot_data.db'))
try:
    # Ensure the instance directory exists so SQLite can create/open the DB file
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
except Exception:
    # non-fatal: if we can't create it here we'll let SQLAlchemy report the error
    pass
app.config['SQLALCHEMY_DATABASE_URI'] = f"sqlite:///{DB_FILE}"
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Improve SQLite concurrency: increase low-level timeout and avoid connection pooling
# so concurrent short-lived connections don't compete for the same file handle.
# Also set these engine options before SQLAlchemy() is constructed.
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'connect_args': {'timeout': 30},
    'poolclass': NullPool,
}

db = SQLAlchemy(app)

# Helper to commit with retries when SQLite reports the database is locked.
def safe_commit(session, retries=5, initial_delay=0.1):
    import sqlite3
    delay = initial_delay
    for attempt in range(1, retries + 1):
        try:
            session.commit()
            return True
        except OperationalError as oe:
            # SQLAlchemy wraps sqlite errors; inspect the inner exception
            msg = str(oe)
            if 'database is locked' in msg or isinstance(getattr(oe, 'orig', None), sqlite3.OperationalError):
                try:
                    session.rollback()
                except Exception:
                    pass
                if attempt == retries:
                    raise
                time.sleep(delay)
                delay = min(delay * 2, 2.0)
                continue
            else:
                # Not a locking error — re-raise
                raise
        except Exception:
            try:
                session.rollback()
            except Exception:
                pass
            raise

# Initialize rate limiter
limiter = Limiter(key_func=get_remote_address)
limiter.init_app(app)

# Database model for general sensor data
class SensorData(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    dust = db.Column(db.Float, nullable=True)
    pm2_5 = db.Column(db.Float, nullable=True)
    pm10 = db.Column(db.Float, nullable=True)
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())
    uuid = db.Column(db.String(36), nullable=True)
    raw_payload = db.Column(db.Text, nullable=True)

# Database model for MQ sensor data
class MQSensorData(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    lpg = db.Column(db.Float, nullable=True)
    co = db.Column(db.Float, nullable=True)
    smoke = db.Column(db.Float, nullable=True)
    co_mq7 = db.Column(db.Float, nullable=True)
    ch4 = db.Column(db.Float, nullable=True)
    co_mq9 = db.Column(db.Float, nullable=True)
    co2 = db.Column(db.Float, nullable=True)
    nh3 = db.Column(db.Float, nullable=True)
    nox = db.Column(db.Float, nullable=True)
    alcohol = db.Column(db.Float, nullable=True)
    benzene = db.Column(db.Float, nullable=True)
    h2 = db.Column(db.Float, nullable=True)
    air = db.Column(db.Float, nullable=True)
    temperature = db.Column(db.Float, nullable=True)
    humidity = db.Column(db.Float, nullable=True)
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())
    uuid = db.Column(db.String(36), nullable=True)
    sd_aqi = db.Column(db.Float, nullable=True)
    sd_aqi_level = db.Column(db.String(64), nullable=True)
    raw_payload = db.Column(db.Text, nullable=True)


# Run DB migration script (best-effort) before creating tables so the
# on-disk SQLite schema matches the SQLAlchemy models. Only run the
# migration in the reloader child (WERKZEUG_RUN_MAIN='true') or when
# not running in debug mode to avoid doing it twice and creating
# repeated backups during watchdog restarts.
try:
    do_migrate = (not app.debug) or os.environ.get("WERKZEUG_RUN_MAIN") == "true"
    if do_migrate:
        import subprocess, sys
        migrate_script = os.path.join(os.path.dirname(__file__), 'scripts', 'migrate_db.py')
        marker = os.path.join(os.path.dirname(__file__), '.migration_done')

        # If we've already run migration in this workspace, do a quick verification
        # that the expected columns exist. If they don't, run migration again.
        def _needs_migration(marker_path, db_path):
            # If no marker, definitely need migration
            if not os.path.exists(marker_path):
                return True
            # marker exists — verify DB actually has the expected columns
            try:
                import sqlite3
                conn = sqlite3.connect(db_path)
                cur = conn.cursor()
                def has_col(tbl, col):
                    cur.execute(f"PRAGMA table_info('{tbl}')")
                    return any(r[1] == col for r in cur.fetchall())
                ok = (
                    has_col('sensor_data', 'uuid') and has_col('sensor_data', 'raw_payload')
                    and has_col('mq_sensor_data', 'uuid') and has_col('mq_sensor_data', 'sd_aqi')
                    and has_col('mq_sensor_data', 'sd_aqi_level') and has_col('mq_sensor_data', 'raw_payload')
                )
                try:
                    cur.close()
                    conn.close()
                except Exception:
                    pass
                return not ok
            except Exception:
                # If we can't verify, be conservative and run migration
                return True

        db_path = DB_FILE
        if _needs_migration(marker, db_path):
            if os.path.exists(migrate_script):
                subprocess.check_call([sys.executable, migrate_script, '--db', db_path, '--yes'])
                try:
                    # create or update the marker file to avoid repeating the migration
                    with open(marker, 'w') as f:
                        f.write('migrated\n')
                except Exception:
                    pass
        else:
            print('Migration marker present; skipping migration')
    else:
        # In the reloader parent process, skip migration to avoid duplicate backups/logs
        print('Skipping DB migration in reloader parent process')
except Exception:
    # Non-fatal: log and continue; create_all() will still try to create missing tables
    print('Migration script failed or not run:')
    print(traceback.format_exc())

# Create the database tables
with app.app_context():
    # Debug: print DB path and access before creating tables
    try:
        print('DB_FILE =', DB_FILE)
        print('abs path =', os.path.abspath(DB_FILE))
        print('exists =', os.path.exists(DB_FILE))
        print('dir exists =', os.path.exists(os.path.dirname(DB_FILE)), 'dir perms =', oct(os.stat(os.path.dirname(DB_FILE)).st_mode & 0o777))
        print('file perms =', oct(os.stat(DB_FILE).st_mode & 0o777) if os.path.exists(DB_FILE) else 'n/a')
        print('SQLALCHEMY_DATABASE_URI =', app.config.get('SQLALCHEMY_DATABASE_URI'))
        try:
            print('db.engine.url =', db.engine.url)
        except Exception:
            print('db.engine.url: not available yet')
    except Exception as _:
        pass
        print(traceback.format_exc())

    # Ensure the uuid, sd_aqi and sd_aqi_level columns exist in existing SQLite tables; if not, add them.
    # Use a raw sqlite connection for robustness and commit immediately.
    try:
        engine = db.engine
        # table_names() is deprecated in newer SQLAlchemy; use inspector when available
        from sqlalchemy import inspect
        inspector = inspect(engine)
        tables = inspector.get_table_names()

        # open a raw connection for PRAGMA/ALTER statements
        conn = engine.raw_connection()
        cur = conn.cursor()

        def table_columns(table_name):
            cur.execute(f"PRAGMA table_info('{table_name}')")
            return [row[1] for row in cur.fetchall()]

        if 'sensor_data' in tables:
            cols = table_columns('sensor_data')
            if 'uuid' not in cols:
                try:
                    cur.execute("ALTER TABLE sensor_data ADD COLUMN uuid TEXT")
                    conn.commit()
                except Exception:
                    conn.rollback()
            if 'raw_payload' not in cols:
                try:
                    cur.execute("ALTER TABLE sensor_data ADD COLUMN raw_payload TEXT")
                    conn.commit()
                except Exception:
                    conn.rollback()

        if 'mq_sensor_data' in tables:
            cols = table_columns('mq_sensor_data')
            if 'uuid' not in cols:
                try:
                    cur.execute("ALTER TABLE mq_sensor_data ADD COLUMN uuid TEXT")
                    conn.commit()
                except Exception:
                    conn.rollback()
                # refresh cols
                cols = table_columns('mq_sensor_data')
            if 'sd_aqi' not in cols:
                try:
                    cur.execute("ALTER TABLE mq_sensor_data ADD COLUMN sd_aqi REAL")
                    conn.commit()
                except Exception:
                    conn.rollback()
            if 'sd_aqi_level' not in cols:
                try:
                    cur.execute("ALTER TABLE mq_sensor_data ADD COLUMN sd_aqi_level TEXT")
                    conn.commit()
                except Exception:
                    conn.rollback()
            if 'raw_payload' not in cols:
                try:
                    cur.execute("ALTER TABLE mq_sensor_data ADD COLUMN raw_payload TEXT")
                    conn.commit()
                except Exception:
                    conn.rollback()

        try:
            cur.close()
            conn.close()
        except Exception:
            pass
        # Ensure SQLite is configured for WAL journaling to improve concurrent readers/writers.
        try:
            with engine.connect() as _conn:
                try:
                    _conn.execute(text('PRAGMA journal_mode = WAL'))
                except Exception:
                    pass
                try:
                    _conn.execute(text('PRAGMA synchronous = NORMAL'))
                except Exception:
                    pass
        except Exception:
            pass
    except Exception as e:
        # Non-fatal: if this fails (e.g., non-sqlite engine), log and continue; new DBs will include the columns.
        print('Warning ensuring schema columns:')
        print(traceback.format_exc())
    # Determine which columns actually exist in the tables so we can avoid referencing missing columns
    SENSOR_COLUMNS = set()
    MQ_COLUMNS = set()
    try:
        engine = db.engine
        conn = engine.raw_connection()
        cur = conn.cursor()
        def cols(table):
            try:
                cur.execute(f"PRAGMA table_info('{table}')")
                return set([r[1] for r in cur.fetchall()])
            except Exception:
                return set()
        SENSOR_COLUMNS = cols('sensor_data')
        MQ_COLUMNS = cols('mq_sensor_data')
        try:
            cur.close()
            conn.close()
        except Exception:
            pass
    except Exception:
        SENSOR_COLUMNS = set()
        MQ_COLUMNS = set()

    # Backfill uuid for existing rows where it's NULL so frontend can rely on stable ids
    try:
        engine = db.engine
        from sqlalchemy import inspect
        inspector = inspect(engine)
        tables = inspector.get_table_names()

        if 'sensor_data' in tables:
            conn = engine.raw_connection()
            cur = conn.cursor()
            try:
                cur.execute("SELECT id FROM sensor_data WHERE uuid IS NULL OR uuid = ''")
                rows = cur.fetchall()
                for (rid,) in rows:
                    cur.execute("UPDATE sensor_data SET uuid = ? WHERE id = ?", (str(uuid4()), rid))
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
            finally:
                try:
                    cur.close()
                    conn.close()
                except Exception:
                    pass

        if 'mq_sensor_data' in tables:
            conn = engine.raw_connection()
            cur = conn.cursor()
            try:
                cur.execute("SELECT id FROM mq_sensor_data WHERE uuid IS NULL OR uuid = ''")
                rows = cur.fetchall()
                for (rid,) in rows:
                    cur.execute("UPDATE mq_sensor_data SET uuid = ? WHERE id = ?", (str(uuid4()), rid))
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
            finally:
                try:
                    cur.close()
                    conn.close()
                except Exception:
                    pass

    except Exception as e:
        print('Warning backfilling uuids: %r' % (e,))

@app.route("/api/data", methods=["POST"])
@limiter.limit("10 per second")  # Limit to 10 requests per second
def receive_data():
    try:
        # Parse incoming JSON data
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "No JSON data received"}), 400

        # Lightweight ingestion logging to help diagnose device connectivity
        try:
            app.logger.info('ingest POST received keys=%s', list(data.keys()) if isinstance(data, dict) else str(type(data)))
        except Exception:
            pass

        # Persist a short textual log of incoming POSTs to a file for debugging
        try:
            log_dir = os.path.join(os.path.dirname(__file__), 'instance')
            os.makedirs(log_dir, exist_ok=True)
            log_path = os.path.join(log_dir, 'mq_ingest.log')

            # Rotate when the log grows beyond MAX_BYTES
            try:
                MAX_BYTES = 5 * 1024 * 1024  # 5 MB
                if os.path.exists(log_path) and os.path.getsize(log_path) >= MAX_BYTES:
                    ts = datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
                    archived = os.path.join(log_dir, f'mq_ingest.{ts}.log')
                    try:
                        os.rename(log_path, archived)
                    except Exception:
                        # if rename fails, attempt to truncate instead
                        try:
                            with open(log_path, 'w', encoding='utf-8'):
                                pass
                        except Exception:
                            pass
            except Exception:
                pass

            try:
                with open(log_path, 'a', encoding='utf-8') as lf:
                    entry = {
                        'received_at_utc': datetime.utcnow().isoformat() + 'Z',
                        'remote_addr': request.remote_addr,
                        'keys': list(data.keys()) if isinstance(data, dict) else None,
                        'payload': data
                    }
                    try:
                        lf.write(json.dumps(entry, ensure_ascii=False) + '\n')
                    except Exception:
                        lf.write(f"{datetime.utcnow().isoformat()}Z {request.remote_addr} PAYLOAD_REPR: {repr(data)}\n")
            except Exception:
                try:
                    app.logger.warning('Failed to append to mq_ingest.log')
                except Exception:
                    pass
        except Exception:
            # Non-fatal: do not block ingestion if logging fails
            try:
                app.logger.warning('Failed to write mq_ingest.log outer')
            except Exception:
                pass

        # If the payload includes a 'timestamp' field (ISO string) or epoch ms, try to parse it
        parsed_ts = None
        if isinstance(data, dict):
            ts_val = data.get('timestamp')
            if ts_val is None:
                ts_val = data.get('timestamp_ms') or data.get('ts')
            if ts_val:
                try:
                    # helper to parse various timestamp formats into an aware UTC datetime
                    def _parse_to_utc(val):
                        # numeric epoch (seconds or milliseconds)
                        if isinstance(val, (int, float)):
                            v = float(val)
                            # heuristic: values > 1e12 are milliseconds
                            if v > 1e12:
                                return datetime.fromtimestamp(v / 1000.0, tz=timezone.utc)
                            else:
                                return datetime.fromtimestamp(v, tz=timezone.utc)

                        s = str(val)
                        # strip whitespace
                        s = s.strip()
                        # If it ends with Z (UTC) remove it and parse, then set tzinfo=UTC
                        try:
                            if s.endswith('Z'):
                                no_z = s[:-1]
                                dt = datetime.fromisoformat(no_z)
                                if dt.tzinfo is None:
                                    return dt.replace(tzinfo=timezone.utc)
                                return dt.astimezone(timezone.utc)
                            else:
                                dt = datetime.fromisoformat(s)
                                if dt.tzinfo is None:
                                    return dt.replace(tzinfo=timezone.utc)
                                return dt.astimezone(timezone.utc)
                        except Exception:
                            # best-effort: try parsing common formats
                            try:
                                # fallback to parsing with space-separated date/time
                                dt = datetime.strptime(s, '%Y-%m-%d %H:%M:%S')
                                return dt.replace(tzinfo=timezone.utc)
                            except Exception:
                                return None

                    parsed_dt = _parse_to_utc(ts_val)
                    if parsed_dt is not None:
                        now = datetime.now(timezone.utc)
                        # Clamp timestamps that are far in the future ( > now + 5 minutes )
                        if parsed_dt > now + timedelta(minutes=5):
                            app.logger.warning("Incoming timestamp far in future: %s. Clamping to now.", ts_val)
                            parsed_dt = now
                        # store as naive UTC (consistent with existing DB rows)
                        parsed_ts = parsed_dt.astimezone(timezone.utc).replace(tzinfo=None)
                    try:
                        app.logger.info('ingest parsed_ts=%s', parsed_ts)
                    except Exception:
                        pass
                except Exception:
                    parsed_ts = None

        # Store general sensor data (only include columns that exist)
        sensor_kwargs = {}
        if 'dust' in SENSOR_COLUMNS or True:
            sensor_kwargs['dust'] = data.get('dust_density', 0.0)
        if 'pm2_5' in SENSOR_COLUMNS or True:
            sensor_kwargs['pm2_5'] = data.get('pm2_5', 0.0)
        if 'pm10' in SENSOR_COLUMNS or True:
            sensor_kwargs['pm10'] = data.get('pm10', 0.0)
        if 'timestamp' in SENSOR_COLUMNS:
            # If device did not provide a timestamp, set server UTC now
            sensor_kwargs['timestamp'] = parsed_ts if parsed_ts is not None else datetime.utcnow()
        if 'uuid' in SENSOR_COLUMNS:
            sensor_kwargs['uuid'] = str(uuid4())
        if 'raw_payload' in SENSOR_COLUMNS:
            try:
                sensor_kwargs['raw_payload'] = json.dumps(data, ensure_ascii=False)
            except Exception:
                sensor_kwargs['raw_payload'] = str(data)
        new_sensor_data = SensorData(**sensor_kwargs)
        db.session.add(new_sensor_data)

        # Store MQ sensor data (only include columns that exist in DB)
        mq_kwargs = {}
        def pick_keys(*keys):
            for k in keys:
                if k in data and data[k] is not None:
                    return data[k]
            return None

        field_map = {
            'lpg':'LPG','co':'CO','smoke':'Smoke','co_mq7':'CO_MQ7','ch4':'CH4','co_mq9':'CO_MQ9',
            'co2':'CO2','nh3':'NH3','nox':'NOx','alcohol':'Alcohol','benzene':'Benzene','h2':'H2','air':'Air',
            'temperature':'Temperature','humidity':'Humidity'
        }
        for col, key in field_map.items():
            if col in MQ_COLUMNS:
                mq_kwargs[col] = pick_keys(key, key.lower())

        if 'timestamp' in MQ_COLUMNS:
            # If device did not provide a timestamp, set server UTC now so
            # newly-ingested rows are ordered correctly by time for the UI.
            mq_kwargs['timestamp'] = parsed_ts if parsed_ts is not None else datetime.utcnow()
        if 'uuid' in MQ_COLUMNS:
            mq_kwargs['uuid'] = str(uuid4())
        # sd_aqi fields
        if 'sd_aqi' in MQ_COLUMNS:
            mq_kwargs['sd_aqi'] = pick_keys('sd_aqi', 'SD_AQI', 'sdAqi')
        if 'sd_aqi_level' in MQ_COLUMNS:
            mq_kwargs['sd_aqi_level'] = pick_keys('sd_aqi_level', 'SD_AQI_level', 'sdAqiLevel')
        if 'raw_payload' in MQ_COLUMNS:
            try:
                mq_kwargs['raw_payload'] = json.dumps(data, ensure_ascii=False)
            except Exception:
                mq_kwargs['raw_payload'] = str(data)

        # Idempotency / deduplication: if the incoming payload includes a uuid
        # that already exists in the DB, update that record instead of inserting
        # a duplicate. If no uuid is provided, but a record exists with the
        # same timestamp and a matching subset of sensor values (LPG/CO/Smoke),
        # consider it a duplicate and update the existing row.
        try:
            existing = None
            incoming_uuid = mq_kwargs.get('uuid')
            if incoming_uuid:
                existing = MQSensorData.query.filter_by(uuid=incoming_uuid).first()

            # If no uuid match, try timestamp + sensor-values heuristic
            if existing is None and mq_kwargs.get('timestamp') is not None:
                try:
                    ts = mq_kwargs.get('timestamp')
                    # look for exact timestamp matches
                    existing = MQSensorData.query.filter(MQSensorData.timestamp == ts).first()
                except Exception:
                    existing = None

            if existing:
                # Update fields on the existing record with incoming non-null values
                for k, v in mq_kwargs.items():
                    if v is not None:
                        # map keys that might differ between DB column names and payload keys
                        try:
                            setattr(existing, k, v)
                        except Exception:
                            pass
                db.session.add(existing)
                # use safe commit to reduce chance of 'database is locked' failures
                safe_commit(db.session)
                try:
                    app.logger.info('ingest updated existing mq row id=%s uuid=%s', existing.id, getattr(existing, 'uuid', None))
                except Exception:
                    pass
                return jsonify({"status": "success", "message": "Existing record updated", "uuid": getattr(existing, 'uuid', None)}), 200

        except Exception:
            # Fall back to inserting if anything goes wrong with dedupe logic
            try:
                db.session.rollback()
            except Exception:
                pass

        # Insert a new MQ record when no duplicate found / dedupe failed
        new_mq_data = MQSensorData(**mq_kwargs)
        db.session.add(new_mq_data)
        safe_commit(db.session)
        try:
            app.logger.info('ingest saved mq row uuid=%s id=%s', mq_kwargs.get('uuid'), new_mq_data.id)
        except Exception:
            pass
        return jsonify({"status": "success", "message": "Data saved", "uuid": mq_kwargs.get('uuid')}), 200
    except Exception as e:
        print("Error:", str(e))
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route("/api/data", methods=["GET"])
def get_data():
    def _run_query_once():
        # Pagination parameters
        page = request.args.get("page", 1, type=int)  # Default to page 1
        per_page = request.args.get("per_page", 50, type=int)  # Default to 50 records per page

        # Fetch paginated data for general sensor data
        pagination = SensorData.query.order_by(SensorData.timestamp.desc()).paginate(page=page, per_page=per_page, error_out=False)
        general_records = pagination.items  # Get the items for the current page

        # Fetch paginated data for MQ sensor data
        mq_pagination = MQSensorData.query.order_by(MQSensorData.timestamp.desc()).paginate(page=page, per_page=per_page, error_out=False)
        mq_records = mq_pagination.items

        # Format data for JSON response, skipping records where all values are 0
        # use module-level helper
        _to_athens_iso = to_athens_iso

        general_data = [{
            "timestamp": _to_athens_iso(r.timestamp) if r.timestamp else None,
            "uuid": getattr(r, 'uuid', None) if getattr(r, 'uuid', None) is not None else None,
            "dust": r.dust if r.dust is not None else 0,
            "pm2_5": r.pm2_5 if r.pm2_5 is not None else 0,
            "pm10": r.pm10 if r.pm10 is not None else 0
        } for r in general_records if not (r.dust == 0 and r.pm2_5 == 0 and r.pm10 == 0)]

        mq_data = [{
            "uuid": getattr(r, 'uuid', None) if getattr(r, 'uuid', None) is not None else None,
            "sd_aqi": getattr(r, 'sd_aqi', None),
            "sd_aqi_level": getattr(r, 'sd_aqi_level', None),
            "timestamp": _to_athens_iso(r.timestamp) if r.timestamp else None,
            "LPG": r.lpg if r.lpg is not None else 0,
            "CO": r.co if r.co is not None else 0,
            "Smoke": r.smoke if r.smoke is not None else 0,
            "CO_MQ7": r.co_mq7 if r.co_mq7 is not None else 0,
            "CH4": r.ch4 if r.ch4 is not None else 0,
            "CO_MQ9": r.co_mq9 if r.co_mq9 is not None else 0,
            "CO2": r.co2 if r.co2 is not None else 0,
            "NH3": r.nh3 if r.nh3 is not None else 0,
            "NOx": r.nox if r.nox is not None else 0,
            "Alcohol": r.alcohol if r.alcohol is not None else 0,
            "Benzene": r.benzene if r.benzene is not None else 0,
            "H2": r.h2 if r.h2 is not None else 0,
            "Air": r.air if r.air is not None else 0,
            "temperature": r.temperature if r.temperature is not None else 0,
            "humidity": r.humidity if r.humidity is not None else 0
        } for r in mq_records]

        # Use Athens local time for the server_now so the frontend sees Greek time everywhere
        try:
            server_now = datetime.now(timezone.utc).astimezone(_ATHENS_TZ).isoformat()
        except Exception:
            server_now = datetime.now(timezone.utc).isoformat()
        return jsonify({
            "general_data": general_data,
            "mq_data": mq_data,
            "server_now": server_now,
            "general_total": len(general_data),       # Total valid records for general sensor data
            "mq_total": mq_pagination.total,         # Total records for MQ sensor data
            "page": pagination.page,                 # Current page
            "per_page": pagination.per_page,         # Records per page
            "pages": pagination.pages                # Total pages
        })

    try:
        return _run_query_once()
    except OperationalError as oe:
        # If schema is out of sync at runtime, try running the migration script once and retry
        try:
            import subprocess, sys
            migrate_script = os.path.join(os.path.dirname(__file__), 'scripts', 'migrate_db.py')
            if os.path.exists(migrate_script):
                subprocess.check_call([sys.executable, migrate_script, '--db', db_path, '--yes'])
                # dispose engine and remove session to ensure new schema is seen
                try:
                    db.session.remove()
                except Exception:
                    pass
                try:
                    db.engine.dispose()
                except Exception:
                    pass
                return _run_query_once()
        except Exception:
            pass
        print("Error:", str(oe))
        return jsonify({"status": "error", "message": str(oe)}), 500
    except Exception as e:
        print("Error:", str(e))
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/admin/mq-ingest', methods=['GET'])
def admin_mq_ingest():
    """Return recent lines from the ingest log.

    This endpoint exposes the last N lines from `instance/mq_ingest.log` for
    debugging. It intentionally does not require a token in local/dev setups.
    If you later want to re-enable authentication, reintroduce an env var
    check here.
    """

    try:
        count = int(request.args.get('count', 100))
    except Exception:
        count = 100
    count = max(1, min(1000, count))

    log_path = os.path.join(os.path.dirname(__file__), 'instance', 'mq_ingest.log')
    if not os.path.exists(log_path):
        return jsonify({'entries': []})

    entries = []
    try:
        with open(log_path, 'r', encoding='utf-8') as lf:
            lines = lf.readlines()[-count:]
        for l in lines:
            l = l.strip('\n')
            try:
                entries.append(json.loads(l))
            except Exception:
                entries.append({'raw': l})
    except Exception as e:
        return jsonify({'status': 'error', 'message': f'failed reading log: {e}'}), 500

    return jsonify({'entries': entries})



@app.route("/")
def index():
    return render_template("index.html")
 
@app.route("/mq-data")
def mq_data():
    return render_template("mq_data.html")


@app.route("/api/mq-data", methods=["GET"])
def get_mq_data():
    try:
        # Default behaviour: return only the latest MQ record (single object)
        # to keep payloads small for frequent polling. If the caller passes
        # `?history=1` the endpoint returns a list of recent records (up to 200)
        # newest-first to preserve backward compatibility.
        history = request.args.get('history', '0') in ('1', 'true', 'yes')

        if history:
            # Return recent MQ sensor records ordered by timestamp (newest first).
            mq_records = MQSensorData.query.order_by(MQSensorData.timestamp.desc()).limit(200).all()

            mq_data = [{
                "uuid": r.uuid if r.uuid is not None else None,
                "sd_aqi": getattr(r, 'sd_aqi', None),
                "sd_aqi_level": getattr(r, 'sd_aqi_level', None),
                "timestamp": to_athens_iso(r.timestamp) if r.timestamp else None,
                "temperature": r.temperature,
                "humidity": r.humidity,
                "LPG": r.lpg,
                "CO": r.co,
                "Smoke": r.smoke,
                "CO_MQ7": r.co_mq7,
                "CH4": r.ch4,
                "CO_MQ9": r.co_mq9,
                "CO2": r.co2,
                "NH3": r.nh3,
                "NOx": r.nox,
                "Alcohol": r.alcohol,
                "Benzene": r.benzene,
                "H2": r.h2,
                "Air": r.air
            } for r in mq_records]

            try:
                server_now = datetime.now(timezone.utc).astimezone(_ATHENS_TZ).isoformat()
            except Exception:
                server_now = datetime.now(timezone.utc).isoformat()
            try:
                app.logger.info('get_mq_data: returning %d records; server_now=%s', len(mq_data) if mq_data else 0, server_now)
            except Exception:
                pass
            return jsonify({"mq_data": mq_data, "server_now": server_now}), 200
        else:
            # Return only the single latest record (object) to reduce payload.
            latest = MQSensorData.query.order_by(MQSensorData.timestamp.desc()).first()
            if latest:
                mq_data = {
                    "uuid": latest.uuid if latest.uuid is not None else None,
                    "sd_aqi": getattr(latest, 'sd_aqi', None),
                    "sd_aqi_level": getattr(latest, 'sd_aqi_level', None),
                    "timestamp": to_athens_iso(latest.timestamp) if latest.timestamp else None,
                    "temperature": latest.temperature,
                    "humidity": latest.humidity,
                    "LPG": latest.lpg,
                    "CO": latest.co,
                    "Smoke": latest.smoke,
                    "CO_MQ7": latest.co_mq7,
                    "CH4": latest.ch4,
                    "CO_MQ9": latest.co_mq9,
                    "CO2": latest.co2,
                    "NH3": latest.nh3,
                    "NOx": latest.nox,
                    "Alcohol": latest.alcohol,
                    "Benzene": latest.benzene,
                    "H2": latest.h2,
                    "Air": latest.air
                }
            else:
                mq_data = None
            try:
                server_now = datetime.now(timezone.utc).astimezone(_ATHENS_TZ).isoformat()
            except Exception:
                server_now = datetime.now(timezone.utc).isoformat()
            try:
                app.logger.info('get_mq_data: returning latest record present=%s; server_now=%s', bool(mq_data), server_now)
            except Exception:
                pass
            return jsonify({"mq_data": mq_data, "server_now": server_now}), 200
    except OperationalError as oe:
        # Try running migration + disposing engine/session and retry once
        try:
            import subprocess, sys
            migrate_script = os.path.join(os.path.dirname(__file__), 'scripts', 'migrate_db.py')
            if os.path.exists(migrate_script):
                subprocess.check_call([sys.executable, migrate_script, '--db', DB_FILE, '--yes'])
                try:
                    db.session.remove()
                except Exception:
                    pass
                try:
                    db.engine.dispose()
                except Exception:
                    pass
                # retry
                mq_records = MQSensorData.query.order_by(MQSensorData.timestamp.desc()).limit(200).all()
                mq_data = [{
                    "uuid": r.uuid if r.uuid is not None else None,
                    "sd_aqi": getattr(r, 'sd_aqi', None),
                    "sd_aqi_level": getattr(r, 'sd_aqi_level', None),
                    "timestamp": to_athens_iso(r.timestamp) if r.timestamp else None,
                    "temperature": r.temperature,
                    "humidity": r.humidity,
                    "LPG": r.lpg,
                    "CO": r.co,
                    "Smoke": r.smoke,
                    "CO_MQ7": r.co_mq7,
                    "CH4": r.ch4,
                    "CO_MQ9": r.co_mq9,
                    "CO2": r.co2,
                    "NH3": r.nh3,
                    "NOx": r.nox,
                    "Alcohol": r.alcohol,
                    "Benzene": r.benzene,
                    "H2": r.h2,
                    "Air": r.air
                } for r in mq_records]
                try:
                    server_now = datetime.now(timezone.utc).astimezone(_ATHENS_TZ).isoformat()
                except Exception:
                    server_now = datetime.now(timezone.utc).isoformat()
                return jsonify({"mq_data": mq_data, "server_now": server_now}), 200
        except Exception:
            pass
        print("Error:", str(oe))
        return jsonify({"status": "error", "message": str(oe)}), 500
    except Exception as e:
        print("Error:", str(e))
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route("/evaluation")
def evaluation():
    return render_template("evaluation.html")


@app.route('/settings')
def settings():
    """Render the settings page for client-side preferences."""
    return render_template('settings.html')


@app.route("/_debug/db-info")
def _debug_db_info():
    try:
        import sqlite3
        db_path = DB_FILE
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        def cols(table):
            try:
                cur.execute(f"PRAGMA table_info('{table}')")
                return [r[1] for r in cur.fetchall()]
            except Exception:
                return []
        sensor_cols = cols('sensor_data')
        mq_cols = cols('mq_sensor_data')
        try:
            cur.close()
            conn.close()
        except Exception:
            pass
        return jsonify({
            'db_path': os.path.abspath(db_path),
            'sensor_cols': sensor_cols,
            'mq_cols': mq_cols
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/_debug/xbee-status')
def _debug_xbee_status():
    try:
        import xbreemw as xb
        ser = getattr(xb, 'ser', None)
        port = None
        baud = None
        if ser is not None:
            try:
                port = getattr(ser, 'port', None)
                baud = getattr(ser, 'baudrate', None)
            except Exception:
                port = None
                baud = None
        recent = []
        try:
            recent = list(getattr(xb, 'recent_raw', []))
        except Exception:
            recent = []
        # ensure strings
        recent_clean = []
        for item in recent:
            try:
                if isinstance(item, bytes):
                    recent_clean.append(item.decode('utf-8', errors='replace'))
                else:
                    recent_clean.append(str(item))
            except Exception:
                recent_clean.append(repr(item))

        return jsonify({'port': port, 'baud': baud, 'recent_raw': recent_clean}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/api/evaluation-data", methods=["GET"])
def evaluation_data():
    try:
        # Fetch the latest sensor data
        latest_pm_data = SensorData.query.order_by(SensorData.timestamp.desc()).first()
        latest_mq_data = MQSensorData.query.order_by(MQSensorData.timestamp.desc()).first()

        # Combine data for evaluation
        evaluation_data = {
            "temperature": latest_mq_data.temperature if latest_mq_data else None,
            "humidity": latest_mq_data.humidity if latest_mq_data else None,
            "pm2_5": latest_pm_data.pm2_5 if latest_pm_data else None,
            "pm10": latest_pm_data.pm10 if latest_pm_data else None,
            "lpg": latest_mq_data.lpg if latest_mq_data else None,
            "co": latest_mq_data.co if latest_mq_data else None,
        }

        return jsonify(evaluation_data), 200
    except Exception as e:
        print("Error:", str(e))
        return jsonify({"status": "error", "message": str(e)}), 500

# XBee Listener Function
def xbee_listener():
    """Run the XBee reading loop provided by `xbreemw` with backoff.

    Behavior changes to avoid noisy logs when no USB/XBee is plugged in:
    - Check for a serial port first with `find_xbee_port()` and wait longer
      if no port is present.
    - Attempt a small number of connects before sleeping.
    - If `xbreemw.main()` exits, back off briefly before restarting.
    """
    while True:
        try:
            # If there's no physical port, don't spam checks — sleep longer.
            port = xbreemw.find_xbee_port()
            if not port:
                time.sleep(5)
                continue

            # Try to connect (a small number of quick retries).
            if xbreemw.ser is None:
                connected = xbreemw.connect_xbee(retries=2, delay=1)
                if not connected:
                    # Give a longer pause before the next probe to avoid spamming
                    time.sleep(5)
                    continue

            # Run the reader loop. If it returns (disconnect or error), retry with backoff.
            xbreemw.main()
            # If main() ever returns without exception, sleep a bit before retrying
            time.sleep(2)
        except Exception as e:
            print(f"XBee listener encountered error: {e}")
            time.sleep(2)



if __name__ == "__main__":
    # Start the XBee listener in a background daemon thread.
    # When running with the Flask reloader (debug mode), the child process sets
    # WERKZEUG_RUN_MAIN='true'. We only start the thread in the reloader child
    # or when not debugging to avoid double-starting.
    # Allow controlling debug/reloader via env var `FLASK_DEBUG` (set to '1' to enable).
    # Default is production-like single-process mode (no reloader).
    flask_debug = os.environ.get('FLASK_DEBUG', '0') == '1'

    # Only start XBee listener in the reloader child or when not running with reloader.
    if (not flask_debug) or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        t = threading.Thread(target=xbee_listener, daemon=True)
        t.start()

    # Enable threaded mode so concurrent HTTP requests (from the collector flushes
    # and from browser polling) can be served in parallel. Combined with WAL
    # and a larger SQLite timeout this reduces 'database is locked' errors.
    app.run(debug=flask_debug, host="0.0.0.0", port=5000, threaded=True)
