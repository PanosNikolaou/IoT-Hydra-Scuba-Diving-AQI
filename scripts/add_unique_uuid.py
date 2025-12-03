#!/usr/bin/env python3
"""
Add UNIQUE constraint on `uuid` column of `mq_sensor_data` by recreating the table.
This script will:
 - Back up the DB to <db>.unique_uuid.bak
 - Create a new table `mq_sensor_data_new` with `uuid TEXT UNIQUE`
 - Copy one row per uuid (keeping the newest row by id) into the new table
 - Drop the old table and rename the new one
 - Preserve other columns defined in EXPECTED mapping

Usage:
    python3 scripts/add_unique_uuid.py --db instance/iot_data.db --yes

Be cautious: this modifies the database schema. A backup is created automatically.
"""
import sqlite3
import shutil
import argparse
import os
import sys

EXPECTED_MQ = [
    ( 'id', 'INTEGER PRIMARY KEY' ),
    ( 'lpg', 'REAL' ),
    ( 'co', 'REAL' ),
    ( 'smoke', 'REAL' ),
    ( 'co_mq7', 'REAL' ),
    ( 'ch4', 'REAL' ),
    ( 'co_mq9', 'REAL' ),
    ( 'co2', 'REAL' ),
    ( 'nh3', 'REAL' ),
    ( 'nox', 'REAL' ),
    ( 'alcohol', 'REAL' ),
    ( 'benzene', 'REAL' ),
    ( 'h2', 'REAL' ),
    ( 'air', 'REAL' ),
    ( 'temperature', 'REAL' ),
    ( 'humidity', 'REAL' ),
    ( 'timestamp', 'TEXT' ),
    ( 'uuid', 'TEXT' ),
    ( 'sd_aqi', 'REAL' ),
    ( 'sd_aqi_level', 'TEXT' ),
    ( 'raw_payload', 'TEXT' )
]


def backup_db(db_path):
    bak = db_path + '.unique_uuid.bak'
    print(f'Backing up {db_path} -> {bak}')
    shutil.copy2(db_path, bak)
    return bak


def table_has_unique_uuid(conn):
    # Check whether any index enforces uniqueness on uuid
    cur = conn.execute("PRAGMA index_list('mq_sensor_data');")
    for row in cur.fetchall():
        name = row[1]
        is_unique = bool(row[2])
        if is_unique:
            # inspect index columns
            cur2 = conn.execute(f"PRAGMA index_info('{name}');")
            cols = [r[2] for r in cur2.fetchall()]
            if 'uuid' in cols:
                return True
    return False


def run(db_path, auto_yes=False):
    if not os.path.exists(db_path):
        print('DB does not exist:', db_path)
        return 1
    bak = backup_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.isolation_level = None
    try:
        if table_has_unique_uuid(conn):
            print('mq_sensor_data already has UNIQUE(uuid). Nothing to do.')
            return 0

        # Build column list and create new table SQL
        cols_sql = ', '.join([f"{name} {typ}" if name != 'uuid' else "uuid TEXT UNIQUE" for name, typ in EXPECTED_MQ])
        create_sql = f"CREATE TABLE mq_sensor_data_new ({cols_sql});"
        print('Creating new table with UNIQUE uuid:')
        print(create_sql)
        conn.execute('BEGIN')
        conn.execute(create_sql)

        # Determine columns present in existing table to copy
        cur = conn.execute("PRAGMA table_info('mq_sensor_data')")
        existing_cols = [r[1] for r in cur.fetchall()]
        # Filter EXPECTED_MQ to those present
        copy_cols = [name for name, _ in EXPECTED_MQ if name in existing_cols]
        if not copy_cols:
            print('No overlapping columns found to copy. Aborting.')
            conn.execute('ROLLBACK')
            return 1
        copy_cols_sql = ', '.join(copy_cols)

        # Insert one row per uuid (keeping newest by id). For rows with NULL uuid
        # we include them as-is (SQLite allows multiple NULLs in UNIQUE column).
        # Approach: select the MAX(id) per uuid where uuid IS NOT NULL, plus all rows
        # where uuid IS NULL, union them, then insert.
        select_sql = (
            f"SELECT {copy_cols_sql} FROM mq_sensor_data WHERE id IN ("
            f"SELECT MAX(id) FROM mq_sensor_data WHERE uuid IS NOT NULL GROUP BY uuid)"
            f" UNION ALL"
            f" SELECT {copy_cols_sql} FROM mq_sensor_data WHERE uuid IS NULL"
        )
        insert_sql = f"INSERT INTO mq_sensor_data_new ({copy_cols_sql}) {select_sql};"
        print('Copying data into new table...')
        conn.execute(insert_sql)

        # Drop old table and rename
        conn.execute('DROP TABLE mq_sensor_data;')
        conn.execute('ALTER TABLE mq_sensor_data_new RENAME TO mq_sensor_data;')
        conn.execute('COMMIT')
        print('Recreated mq_sensor_data with UNIQUE(uuid).')
        return 0
    except Exception as e:
        try:
            conn.execute('ROLLBACK')
        except Exception:
            pass
        print('Error during migration:', e)
        return 2
    finally:
        conn.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    default_db = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'instance', 'iot_data.db'))
    p.add_argument('--db', default=default_db)
    p.add_argument('--yes', action='store_true')
    args = p.parse_args()
    if not args.yes:
        print('This will recreate the mq_sensor_data table with UNIQUE(uuid). A backup will be created.')
        resp = input('Continue? [y/N]: ').strip().lower()
        if resp not in ('y','yes'):
            print('Aborted')
            sys.exit(1)
    rc = run(args.db, auto_yes=args.yes)
    sys.exit(rc)
