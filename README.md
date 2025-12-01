Scuba Diving Air Quality Monitoring System – IoT Hydra

Overview
This project monitors air quality using a combination of MQ gas sensors and a GP2Y1014AU dust sensor to detect potential contamination in diving tanks filled from compressors. By calculating a standard Air Quality Index (AQI) and a specialized Scuba Diving Air Quality Index (SD-AQI), the system identifies harmful gases that could pose risks to divers. IoT Hydra, an IoT-based dashboard built using Flask, provides real-time graphing, monitoring, and sensor data analysis.

System Architecture
The project comprises hardware sensors, communication modules, data processing, and a web-based IoT dashboard for visualization.

Hardware Components
Gas Sensors:
# IoT Hydra — Scuba Diving Air Quality Monitoring

A compact, local IoT platform for monitoring air quality in scuba diving compressors and cylinders. The system combines multiple MOS (MQ) gas sensors, a particulate (dust) sensor, and environmental sensors. Data is collected on Arduino-based devices and sent to a Flask backend for storage, visualization and evaluation (SD-AQI).

This README documents the API, database behavior, example payloads, and Arduino code snippets for each sensor so you can get devices sending data and the server storing "everything" safely (we store a `raw_payload` column containing the original JSON for forensic/debugging use).

---

## Table of Contents

- Overview
- Quick start (run server)
- API Reference
  - POST `/api/data`
  - GET `/api/data`
  - GET `/api/mq-data`
  - GET `/api/evaluation-data`
  - Debug endpoints
- Database schema (important columns)
- Example payloads
- Arduino / Device examples
  - Hardware notes
  - MQ sensors (analog reads)
  - GP2Y1014 Dust sensor (analog)
  - DHT11 (temperature + humidity)
  - Packaging JSON and sending via WiFi (HTTP POST)
  - Packaging JSON and sending via Serial/XBee
- Troubleshooting & Verification
- Security & Production notes

---

## Overview

- Backend: Flask + SQLAlchemy + SQLite (local `instance/iot_data.db`).
- Frontend: Chart.js + DataTables, hosted by Flask templates.
- Ingestion: Devices can post JSON to `/api/data` (HTTP) or send via XBee/Serial to the collector which persists into DB.
- Durability: The server stores both parsed fields and a `raw_payload` text column containing the full incoming JSON payload.

---

## Quick start (run server locally)

From project root:

```bash
# create and activate your virtualenv (recommended)
python3 -m venv myenv
source myenv/bin/activate
pip install -r requirements-flask.txt

# run the server
python3 app.py
# or using flask runner
# export FLASK_APP=app.py
# flask run --host=0.0.0.0 --port=5000
```

Notes:
- On first run the app attempts a best-effort migration to add expected columns (including `raw_payload`).
- If you see a port conflict on `5000` identify/stop the process using that port before starting.

---

## API Reference

All endpoints are JSON except where noted.

### POST /api/data

Accepts JSON payloads produced by devices. The endpoint will attempt to parse a timestamp (ISO string or epoch ms/s) and persist values into the `sensor_data` and `mq_sensor_data` tables when relevant. The entire incoming JSON is also stored in the `raw_payload` field when available.

- Rate limited to protect the server.
- Returns 200 on success.

Example request (HTTP):

```http
POST /api/data HTTP/1.1
Host: 192.168.1.50:5000
Content-Type: application/json

{
  "timestamp": "2025-12-01T19:00:00Z",
  "LPG": 0.002,
  "CO": 0.003,
  "Smoke": 0.026,
  "CO2": 9.444,
  "NH3": 14.725,
  "NOx": 7.755,
  "Alcohol": 3.748,
  "Benzene": 8.183,
  "H2": 0.0,
  "Air": null,
  "temperature": 22.3,
  "humidity": 45.1,
  "extra_field": "any additional metadata"
}
```

Response:

```json
{ "status": "success", "message": "Data saved" }
```

Behavior:
- The server stores mapped fields (if the DB column exists) and always tries to save the `raw_payload` JSON text.
- The server clamps timestamps far in the future (> now + 5 minutes).

### GET /api/data

Returns paginated general sensor data and MQ data (legacy combined endpoint). Query parameters:
- `page` (default 1)
- `per_page` (default 50)

Response format (abridged):

```json
{
  "general_data": [ ... ],
  "mq_data": [ ... ],
  "server_now": "2025-12-01T19:20:05+00:00",
  "general_total": 10,
  "mq_total": 1234,
  "page": 1,
  "per_page": 50,
  "pages": 25
}
```

### GET /api/mq-data

Returns recent MQ sensor records (used by the JS dashboard). The server returns objects with keys like `LPG`, `CO`, `Smoke`, `CO2`, `NH3`, `NOx`, `Alcohol`, `Benzene`, `H2`, `Air`, `temperature`, `humidity`, `sd_aqi`, `sd_aqi_level`, `timestamp`, `uuid` and optionally `raw_payload` (if present in DB).

Response example (abridged):

```json
{
  "mq_data": [ { "timestamp": "2025-12-01T19:06:00", "LPG": 0.002, "CO": 0.003, "raw_payload": "{...}" }, ... ],
  "server_now": "2025-12-01T19:20:05+00:00"
}
```

### GET /api/evaluation-data

Returns latest combined values used for evaluation (temperature, humidity, pm2_5, pm10, lpg, co, etc.) for the evaluation page.

### Debug endpoints
- `GET /_debug/db-info` — returns DB path and columns present for `sensor_data` and `mq_sensor_data`.
- `GET /_debug/xbee-status` — returns serial port, baud, and recent raw buffers from `xbreemw` collector.

---

## Database schema (important columns)

Key tables/columns (SQLAlchemy models in `app.py`):

- `sensor_data`
  - `id`, `dust`, `pm2_5`, `pm10`, `timestamp`, `uuid`, `raw_payload`
- `mq_sensor_data`
  - `id`, `lpg`, `co`, `smoke`, `co_mq7`, `ch4`, `co_mq9`, `co2`, `nh3`, `nox`, `alcohol`, `benzene`, `h2`, `air`, `temperature`, `humidity`, `timestamp`, `uuid`, `sd_aqi`, `sd_aqi_level`, `raw_payload`

The server will attempt to create missing columns at startup using `ALTER TABLE` (best-effort for SQLite).

---

## Example payloads

Minimal MQ-only payload:

```json
{ "timestamp":"2025-12-01T19:00:00Z", "LPG":0.002, "CO":0.003 }
```

Full payload with extra metadata:

```json
{
  "timestamp": 1700000000000,
  "LPG": 0.002,
  "CO": 0.003,
  "Smoke": 0.026,
  "CO2": 9.444,
  "NH3": 14.725,
  "NOx": 7.755,
  "Alcohol": 3.748,
  "Benzene": 8.183,
  "H2": 0.0,
  "Air": "n/a",
  "temperature": 22.3,
  "humidity": 45.1,
  "device_id": "arduino-01"
}
```

---

## Arduino / Device Examples

Two typical ways to send data:
- Device has WiFi (ESP8266, ESP32, or Arduino+WiFi) → send HTTP POST to `/api/data`.
- Device has XBee/radio → send JSON over serial to the collector (the collector script `xbreemw.py` listens on serial and forwards data to DB).

### Hardware notes

- MQ sensors are analog-output gas sensors. They require breakout boards, heating time, and calibration. Read them via an ADC pin and convert to concentration using your calibration curve.
- GP2Y1014 dust sensor outputs analog voltage proportional to dust density; use the recommended driving/capacitor circuit and sample it according to datasheet.
- DHT11 requires a digital pin and a library to read temperature/humidity (note: DHT22 is more accurate if available).

### Example Arduino (ESP8266/ESP32) — WiFi + HTTP POST

This example shows how to read analog MQ sensors and DHT11 and POST JSON to the Flask server.

> This sketch is illustrative. Use proper calibration for MQ sensors and ensure sensor heater circuits and power are correct.

```cpp
// Example for ESP8266 (NodeMCU) or ESP32
#include <Arduino.h>
#include <ESP8266WiFi.h>       // or #include <WiFi.h> for ESP32
#include <ESP8266HTTPClient.h> // or <HTTPClient.h>
#include <ArduinoJson.h>
#include "DHT.h"

#define DHTPIN D4
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

// Analog pins for MQ sensors (assign your wiring)
#define MQ2_PIN A0
// If you have more analog channels use ADC multiplexer or different board

const char* ssid = "YOUR_SSID";
const char* password = "YOUR_PSK";
const char* server = "http://192.168.1.100:5000/api/data"; // change to your server IP

void setup() {
  Serial.begin(115200);
  dht.begin();
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("WiFi connected");
}

float readMQ2() {
  int raw = analogRead(MQ2_PIN);
  // Convert raw ADC value to voltage (depending on board ADC reference)
  float voltage = (raw / 1023.0) * 3.3; // for 10-bit ADC and 3.3V ref
  // Convert to some concentration using calibration — placeholder
  return voltage; // store voltage or apply calibration
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(1000);
    return;
  }

  float mq2 = readMQ2();
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  StaticJsonDocument<512> doc;
  doc["timestamp"] = millis(); // device epoch ms, server will parse
  doc["LPG"] = mq2;
  doc["CO"] = 0; // read more channels if available
  doc["temperature"] = temp;
  doc["humidity"] = hum;
  doc["device_id"] = "esp01-1";

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.begin(server);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(payload);
  if (code > 0) {
    String resp = http.getString();
    Serial.println(code);
    Serial.println(resp);
  } else {
    Serial.println("POST failed");
  }
  http.end();

  delay(5000);
}
```

Notes:
- Use `timestamp` as ISO string or epoch ms. The server supports both and will store a UTC timestamp.
- If you have multiple MQ sensors, add additional analog reads and keys (e.g., `"CH4": value`).

### Arduino (Uno / XBee) — Serial JSON (for XBee collector)

If you have a radio/XBee network, you can send newline-delimited JSON over serial. The `xbreemw.py` listener will attempt to parse lines as JSON and forward them to DB.

Simple Arduino sketch to print JSON to Serial (XBee attached to TX/RX):

```cpp
#include <Arduino.h>
#include <DHT.h>
#define DHTPIN 2
#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(9600);
  dht.begin();
}

void loop() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  float mq2 = analogRead(A0) / 1023.0; // normalized

  // Build a compact JSON string
  String json = "{";
  json += "\"timestamp\":\"" + String("2025-12-01T19:00:00Z") + "\","; // or device millis
  json += "\"LPG\":" + String(mq2, 4) + ",";
  json += "\"temperature\":" + String(t, 2) + ",";
  json += "\"humidity\":" + String(h, 2);
  json += "}";

  Serial.println(json);
  delay(2000);
}
```

The collector should receive the JSON line and persist it.

---

## Troubleshooting & Verification

- Confirm DB columns present:

```bash
curl -sS http://127.0.0.1:5000/_debug/db-info | jq .
```

- Check latest MQ rows and raw payload:

```bash
sqlite3 instance/iot_data.db "SELECT id, timestamp, raw_payload FROM mq_sensor_data ORDER BY id DESC LIMIT 5;"
```

- Test POST locally with `curl`:

```bash
curl -X POST http://127.0.0.1:5000/api/data -H 'Content-Type: application/json' -d '{"LPG":0.005, "CO":0.001, "timestamp":"2025-12-01T19:00:00Z"}'
```

- If you see clock issues in the UI, confirm server time:

```bash
date --iso-8601=seconds
timedatectl
```

- If the Flask server fails to start due to port in use, find and kill the process listening on 5000:

```bash
sudo ss -ltnp | grep ':5000'
sudo lsof -iTCP:5000 -sTCP:LISTEN -Pn
sudo kill <PID>
```

---

## Security & Production Notes

- The included development server is not production-ready. For production, run behind a WSGI server (gunicorn/uWSGI) and a reverse proxy.
- Consider HTTPS and authentication for devices posting to `/api/data` (API keys, mutual TLS, or a simple token header).
- Add size limits and validation for incoming payloads if devices may be untrusted.

---

## Backfilling / Admin

Because we store `raw_payload`, it is possible to write an admin script that reads `raw_payload` for historical rows and populates new explicit DB columns if you later add more fields to the model.

If you want, I can add a small admin endpoint to do a dry-run scan of `raw_payload` and show candidate keys to backfill.

---

If anything in this README should be expanded (example code for additional MQ models, calibration guidance, or a backfill script), tell me which parts to expand and I will add them.

