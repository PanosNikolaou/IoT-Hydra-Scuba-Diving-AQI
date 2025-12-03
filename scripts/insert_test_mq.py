from datetime import datetime, timezone
import os, sys
# Ensure project root is on sys.path so we can import `app` when running from scripts/
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import app, db, MQSensorData

def insert_test():
    with app.app_context():
        # create a recent timestamp (naive UTC as the app expects)
        ts = datetime.now(timezone.utc).replace(tzinfo=None)
        rec = MQSensorData(
            lpg=0.033,
            co=0.066,
            smoke=0.123,
            temperature=23.0,
            humidity=60.0,
            timestamp=ts,
            uuid='script-test-' + str(int(datetime.now().timestamp()))
        )
        db.session.add(rec)
        db.session.commit()
        print('Inserted MQ record id=', rec.id, 'timestamp=', rec.timestamp)

if __name__ == '__main__':
    insert_test()
