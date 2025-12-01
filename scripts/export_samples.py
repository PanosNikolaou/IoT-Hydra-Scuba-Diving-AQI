#!/usr/bin/env python3
"""
Export sample rows from the project's SQLite database to CSV.

Usage examples:
  python3 scripts/export_samples.py --table mq_sensor_data --limit 200 --out samples.csv
  python3 scripts/export_samples.py --table mq_sensor_data --random 100 --out random.csv
  python3 scripts/export_samples.py --table mq_sensor_data --start '2025-11-01' --end '2025-11-30' --out nov.csv

This script is safe to run locally and does not require the Flask app to be running.
It reads the DB path from the repository's `app.py` DB_FILE constant location or from --db.
"""
import argparse
import csv
import os
import sqlite3
import sys
from datetime import datetime


def detect_db_path(provided):
    if provided:
        return os.path.abspath(provided)
    # Default to instance/iot_data.db relative to repo root
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    candidate = os.path.join(repo_root, 'instance', 'iot_data.db')
    return os.path.abspath(candidate)


def build_query(table, start, end, columns=None, random=None, limit=None):
    cols = '*'
    if columns:
        cols = ','.join(columns)

    where_clauses = []
    if start:
        where_clauses.append("timestamp >= :start")
    if end:
        where_clauses.append("timestamp <= :end")

    where = ('WHERE ' + ' AND '.join(where_clauses)) if where_clauses else ''

    order_clause = ''
    if random:
        order_clause = f'ORDER BY RANDOM()'
    else:
        order_clause = 'ORDER BY timestamp DESC'

    limit_clause = ''
    if limit:
        limit_clause = f'LIMIT {int(limit)}'

    query = f"SELECT {cols} FROM {table} {where} {order_clause} {limit_clause};"
    return query


def parse_args():
    p = argparse.ArgumentParser(description='Export sample rows from SQLite DB to CSV')
    p.add_argument('--db', help='Path to SQLite DB (defaults to instance/iot_data.db)')
    p.add_argument('--table', choices=['mq_sensor_data', 'sensor_data'], default='mq_sensor_data')
    p.add_argument('--out', help='Output CSV file (defaults to stdout)', default='-')
    p.add_argument('--limit', type=int, help='Limit number of rows (applies when --random not set)')
    p.add_argument('--random', type=int, help='Return N random rows')
    p.add_argument('--start', help="Start timestamp (inclusive). ISO format or 'YYYY-MM-DD'.")
    p.add_argument('--end', help="End timestamp (inclusive). ISO format or 'YYYY-MM-DD'.")
    p.add_argument('--cols', help='Comma-separated list of columns to export (default=all)')
    return p.parse_args()


def main():
    args = parse_args()
    db_path = detect_db_path(args.db)
    if not os.path.exists(db_path):
        print(f"Database not found: {db_path}", file=sys.stderr)
        sys.exit(2)

    columns = None
    if args.cols:
        columns = [c.strip() for c in args.cols.split(',') if c.strip()]

    query = build_query(args.table, args.start, args.end, columns=columns, random=args.random, limit=args.limit)

    params = {}
    if args.start:
        # Accept partial dates (YYYY-MM-DD) and ISO timestamps
        try:
            dt = datetime.fromisoformat(args.start)
            params['start'] = dt.isoformat()
        except Exception:
            # assume date only
            params['start'] = args.start
    if args.end:
        try:
            dt = datetime.fromisoformat(args.end)
            params['end'] = dt.isoformat()
        except Exception:
            params['end'] = args.end

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    try:
        cur.execute(query, params)
    except Exception as e:
        print('Query failed:', e, file=sys.stderr)
        print('SQL:', query, file=sys.stderr)
        sys.exit(3)

    rows = cur.fetchall()
    if args.out == '-':
        outfh = sys.stdout
    else:
        outfh = open(args.out, 'w', newline='')

    try:
        if len(rows) == 0:
            print('No rows matched the query.', file=sys.stderr)
        # Determine headers
        headers = rows[0].keys() if rows else []
        writer = csv.writer(outfh)
        if headers:
            writer.writerow(headers)
        for r in rows:
            writer.writerow([r[h] for h in headers])
    finally:
        if outfh is not sys.stdout:
            outfh.close()
        cur.close()
        conn.close()


if __name__ == '__main__':
    main()
