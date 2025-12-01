#!/usr/bin/env python3
"""
Simple SQLite migration script for IoT-Hydra-Scuba-Diving-AQI

This script will:
- Back up the existing `iot_data.db` to `iot_data.db.bak` (only if the DB exists)
- Ensure `sensor_data` and `mq_sensor_data` tables exist with all expected columns
- For existing tables, add any missing columns via `ALTER TABLE ADD COLUMN`

Usage:
    python3 scripts/migrate_db.py --db iot_data.db

Be cautious: ALTERs are best-effort and SQLite has limitations (no DROP COLUMN, etc.).
"""

import sqlite3
import shutil
import argparse
import os
import sys

EXPECTED = {
    'sensor_data': [
        ( 'id', 'INTEGER PRIMARY KEY' ),
        ( 'dust', 'REAL' ),
        ( 'pm2_5', 'REAL' ),
        ( 'pm10', 'REAL' ),
        ( 'timestamp', 'TEXT' ),
        ( 'uuid', 'TEXT' )
    ],
    'mq_sensor_data': [
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
        ( 'sd_aqi_level', 'TEXT' )
    ]
}


def table_exists(conn, table):
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?;", (table,))
    return cur.fetchone() is not None


def get_columns(conn, table):
    cur = conn.execute(f"PRAGMA table_info('{table}');")
    return [row[1] for row in cur.fetchall()]


def create_table(conn, table, cols):
    # cols is list of tuples (name, type)
    cols_sql = ', '.join([f"{name} {typ}" for name, typ in cols])
    sql = f"CREATE TABLE IF NOT EXISTS {table} ({cols_sql});"
    print(f"Creating table {table} -> {sql}")
    conn.execute(sql)
    conn.commit()


def add_column(conn, table, name, typ):
    sql = f"ALTER TABLE {table} ADD COLUMN {name} {typ};"
    print(f"Adding column to {table}: {name} {typ}")
    conn.execute(sql)
    conn.commit()


def backup_db(db_path):
    bak = db_path + '.bak'
    print(f"Backing up {db_path} -> {bak}")
    shutil.copy2(db_path, bak)


def migrate(db_path, auto_yes=False):
    if not os.path.exists(db_path):
        print(f"Database file {db_path} does not exist. A new DB will be created with expected tables.")
    else:
        backup_db(db_path)

    conn = sqlite3.connect(db_path)

    try:
        for table, cols in EXPECTED.items():
            if not table_exists(conn, table):
                print(f"Table '{table}' does not exist. Creating with expected schema.")
                create_table(conn, table, cols)
                continue

            existing = get_columns(conn, table)
            print(f"Table '{table}' exists. Columns: {existing}")
            for name, typ in cols:
                if name in existing:
                    continue
                # For primary key column addition to existing tables we cannot add PK in sqlite
                if 'PRIMARY KEY' in typ and existing:
                    print(f"Skipping addition of PRIMARY KEY column '{name}' on existing table '{table}'. Consider manual migration if needed.")
                    continue
                add_column(conn, table, name, typ)

        print("Migration complete.")
    finally:
        conn.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    default_db = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'instance', 'iot_data.db'))
    p.add_argument('--db', default=default_db, help=f'Path to sqlite DB file (default: {default_db})')
    p.add_argument('--yes', action='store_true', help='Auto-confirm destructive or altering actions')
    args = p.parse_args()

    if not args.yes:
        print("This script will modify the sqlite database by adding columns.")
        print("A backup will be created as <db>.bak before changes are applied.")
        resp = input('Continue? [y/N]: ').strip().lower()
        if resp not in ('y', 'yes'):
            print('Aborted by user')
            sys.exit(1)

    migrate(args.db, auto_yes=args.yes)
