import serial
import serial.tools.list_ports
import requests
import json
import time
import os
import logging
from datetime import datetime
from collections import deque
from pathlib import Path

# List of possible serial ports
# Try common baud rates if initial connection doesn't yield data
# Default to 115200 which is commonly used by Arduino/XBee setups.
# Allow overriding via environment variable `XBEE_BAUD` for flexibility.
BAUD_RATE = int(os.getenv('XBEE_BAUD', '115200'))
COMMON_BAUD_RATES = [115200, 57600, 38400, 19200, 9600]
BAUD_CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'instance', 'xbee_baud.json')
# Keep a small recent raw buffer for diagnostics
recent_raw = deque(maxlen=32)
FLASK_API_URL = "http://127.0.0.1:5000/api/data"
QUEUE_PATH = os.path.join(os.path.dirname(__file__), 'instance', 'xbee_queue.jsonl')
# Flush/POST timeouts and retry policy (configurable via env vars)
FLUSH_REQUEST_TIMEOUT = float(os.getenv('XBEE_FLUSH_TIMEOUT', '10'))
FLUSH_ATTEMPTS = int(os.getenv('XBEE_FLUSH_ATTEMPTS', '3'))

# Ensure instance dir exists for queue file
try:
    Path(os.path.dirname(QUEUE_PATH)).mkdir(parents=True, exist_ok=True)
except Exception:
    pass

# module logger: quiet by default, enable verbose by setting XBEE_VERBOSE or XBEE_DEBUG
logger = logging.getLogger(__name__)
if os.getenv("XBEE_VERBOSE") or os.getenv("XBEE_DEBUG"):
    logger.setLevel(logging.DEBUG)
else:
    logger.setLevel(logging.WARNING)

# If debug is requested, ensure there's a console handler so messages appear
if (os.getenv("XBEE_VERBOSE") or os.getenv("XBEE_DEBUG")) and not logger.handlers:
    ch = logging.StreamHandler()
    ch.setLevel(logging.DEBUG)
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
    ch.setFormatter(fmt)
    logger.addHandler(ch)

def find_xbee_port():
    """Finds the FT231X USB UART device, which is likely an XBee."""
    available_ports = list(serial.tools.list_ports.comports())
    # Prefer known FTDI / XBee descriptors or USB tty devices
    preferred_keywords = ["FT231X", "FTDI", "XBee", "Digi", "USB Serial", "USB-Serial"]
    usb_devices = []

    for port in available_ports:
        logger.debug("Checking port: %s (%s) vid=%s pid=%s", port.device, port.description, getattr(port, 'vid', None), getattr(port, 'pid', None))
        desc = (port.description or "").lower()
        for kw in preferred_keywords:
            if kw.lower() in desc:
                logger.info("Possible XBee detected on %s (%s)", port.device, port.description)
                return port.device

        # collect generic USB-serial devices as fallback
        if port.device and (port.device.startswith('/dev/ttyUSB') or port.device.startswith('/dev/ttyACM') or 'usb' in desc):
            usb_devices.append(port.device)

    if usb_devices:
        logger.debug("Falling back to first USB serial device: %s", usb_devices[0])
        return usb_devices[0]

    logger.debug("No XBee/USB serial module detected.")
    return None


def verify_xbee(port):
    """Verifies if the device on the given port is an XBee by sending an '+++' command."""
    try:
        # Non-intrusive verification: do NOT send '+++' (it may change device mode).
        # Instead, open the port and attempt a short read to confirm the device is responsive.
        with serial.Serial(port, BAUD_RATE, timeout=1) as ser_conn:
            try:
                ser_conn.reset_input_buffer()
            except Exception:
                pass
            # Wait briefly for any startup/banner data
            time.sleep(0.2)
            try:
                resp = ser_conn.read(128)
                response = resp.decode('utf-8', errors='replace').strip()
            except Exception as re:
                logger.debug("Error reading while verifying %s: %s", port, re)
                response = ''

            if response:
                logger.debug("Non-intrusive verification read from %s: %r", port, response)
                # Heuristic: presence of printable characters or braces suggests a serial sensor
                return True
            else:
                logger.debug("No readable data on %s during verification.", port)
                return False
    except Exception as e:
        logger.warning("Error verifying XBee on %s: %s", port, e)
        return False


# Serial object and internal port tracker
ser = None
_port = None
_buffer = ""  # accumulate incoming serial data

def connect_xbee(retries=3, delay=2):
    """Attempt to find, verify and connect to an XBee device.

    Returns True if connected, False otherwise. Does not exit the process on failure.
    """
    global ser, _port
    def load_saved_baud():
        try:
            if os.path.exists(BAUD_CONFIG_PATH):
                with open(BAUD_CONFIG_PATH, 'r') as fh:
                    j = json.load(fh)
                    b = j.get('baud')
                    try:
                        return int(b)
                    except Exception:
                        return None
        except Exception:
            return None

    def save_baud(b):
        try:
            os.makedirs(os.path.dirname(BAUD_CONFIG_PATH), exist_ok=True)
            with open(BAUD_CONFIG_PATH, 'w') as fh:
                json.dump({'baud': int(b)}, fh)
        except Exception:
            # non-fatal
            pass
        else:
            logger.info("Saved XBee baud %s to %s", b, BAUD_CONFIG_PATH)

    for attempt in range(1, retries + 1):
        PORT = find_xbee_port()
        if not PORT:
            logger.debug("No serial port found for XBee on attempt %d", attempt)
        else:
            verified = verify_xbee(PORT)
            # Try saved baud first (if any), then the preferred BAUD_RATE, then fall back
            saved = load_saved_baud()
            tried_bauds = []
            if saved:
                tried_bauds.append(saved)
            if BAUD_RATE not in tried_bauds:
                tried_bauds.append(BAUD_RATE)
            for b in COMMON_BAUD_RATES:
                if b not in tried_bauds:
                    tried_bauds.append(b)
            for baud in tried_bauds:
                if verified:
                    try:
                        ser = serial.Serial(PORT, baud, timeout=1)
                        _port = PORT
                        logger.info("Connected to XBee on %s at %d baud (verified).", PORT, baud)
                        try:
                            # persist selected baud if it's not the saved value
                            if baud != saved:
                                save_baud(baud)
                        except Exception:
                            pass
                        return True
                    except Exception as e:
                        logger.warning("Error connecting to verified XBee on %s at %d: %s", PORT, baud, e)
                else:
                    # Verification didn't detect streaming data; still try to open at different baud rates.
                    try:
                        # Try opening the port and do a short read probe to auto-detect the best baud
                        probe_baud, sample = auto_baud_probe(PORT, tried_bauds)
                        if probe_baud:
                            ser = serial.Serial(PORT, probe_baud, timeout=1)
                            _port = PORT
                            logger.warning("Connected to serial port %s at %d (auto-detected); proceeding to listen.", PORT, probe_baud)
                            # stash sample into recent_raw for diagnostics
                            try:
                                recent_raw.appendleft(sample.decode('utf-8', errors='replace'))
                            except Exception:
                                pass
                            try:
                                save_baud(probe_baud)
                            except Exception:
                                pass
                            return True
                        else:
                            # Fall back to trying the baud explicitly
                            ser = serial.Serial(PORT, baud, timeout=1)
                            _port = PORT
                            logger.warning("Connected to serial port %s at %d but verification failed; proceeding to listen.", PORT, baud)
                            try:
                                if baud != saved:
                                    save_baud(baud)
                            except Exception:
                                pass
                            return True
                    except Exception as e:
                        logger.debug("Error opening serial port %s at %d: %s", PORT, baud, e)

        if attempt < retries:
            time.sleep(delay)

    logger.debug("Could not connect to XBee after retries. Continuing without serial connection.")
    ser = None
    return False

# Do not attempt an automatic connection at import time; let the caller
# control when to start the listener/connect. Some environments import
# this module without intending to immediately open serial ports.
# connect_xbee(retries=1, delay=1)


def send_to_flask(data):
    try:
        response = requests.post(FLASK_API_URL, json=data, timeout=FLUSH_REQUEST_TIMEOUT)
        if response.status_code == 200:
            logger.debug("Data successfully sent to Flask: %s", data)
        else:
            logger.warning("Error sending data to Flask: %s %s", response.status_code, response.text)
    except Exception as e:
        logger.warning("Error communicating with Flask: %s", e)
        # Persist the failed payload to a local queue for retry
        try:
            with open(QUEUE_PATH, 'a') as qf:
                qf.write(json.dumps(data, default=str) + "\n")
            logger.info("Queued payload to %s for later retry", QUEUE_PATH)
        except Exception as qe:
            logger.error("Failed to write payload to queue: %s", qe)
    finally:
        try:
            logger.info("Posted data to Flask endpoint; payload keys: %s", list(data.keys()) if isinstance(data, dict) else str(type(data)))
        except Exception:
            logger.info("Posted data to Flask endpoint; payload type: %s", type(data))


def flush_queue():
    """Attempt to resend queued payloads stored in QUEUE_PATH.
    On success, remove items from the queue. Failures remain for later retry.
    """
    if not os.path.exists(QUEUE_PATH):
        return
    try:
        with open(QUEUE_PATH, 'r') as qf:
            lines = [l.strip() for l in qf if l.strip()]
    except Exception as e:
        logger.debug("Could not read queue file %s: %s", QUEUE_PATH, e)
        return

    if not lines:
        try:
            os.remove(QUEUE_PATH)
        except Exception:
            pass
        return

    remaining = []
    logger.info("Flushing %d queued payload(s) to Flask", len(lines))
    for ln in lines:
        try:
            payload = json.loads(ln)
        except Exception:
            # corrupted line — skip
            logger.debug("Skipping malformed queued line")
            continue

        success = False
        attempt = 0
        # Attempt multiple times with exponential backoff between attempts
        while attempt < FLUSH_ATTEMPTS and not success:
            attempt += 1
            try:
                timeout = FLUSH_REQUEST_TIMEOUT * (1 + (attempt - 1) * 0.5)
                resp = requests.post(FLASK_API_URL, json=payload, timeout=timeout)
                if resp.status_code == 200:
                    logger.info("Flushed queued payload successfully (attempt %d)", attempt)
                    success = True
                    break
                else:
                    logger.warning("Flush attempt %d: server returned %s; will retry", attempt, resp.status_code)
            except Exception as e:
                logger.warning("Flush attempt %d: error communicating with Flask: %s", attempt, e)

            # Backoff before next attempt (capped)
            if not success and attempt < FLUSH_ATTEMPTS:
                backoff = min(2 ** attempt, 8)
                time.sleep(backoff)

        if not success:
            logger.info("Flush: requeueing payload after %d attempts", FLUSH_ATTEMPTS)
            remaining.append(ln)

    # write remaining back
    try:
        if remaining:
            with open(QUEUE_PATH, 'w') as qf:
                qf.write('\n'.join(remaining) + '\n')
        else:
            try:
                os.remove(QUEUE_PATH)
            except Exception:
                pass
    except Exception as e:
        logger.debug("Could not update queue file: %s", e)


def parse_xbee_data(raw_data):
    try:
        # Assuming the XBee sends data in JSON format
        data = json.loads(raw_data)
        logger.debug("Received raw data from XBee: %s", data)

        # Normalize keys to the format expected by the Flask app (/api/data)
        # Accept either lowercase or mixed-case incoming keys
        key_map = {
            'lpg': 'LPG', 'co': 'CO', 'smoke': 'Smoke', 'co_mq7': 'CO_MQ7', 'ch4': 'CH4', 'co_mq9': 'CO_MQ9',
            'co2': 'CO2', 'nh3': 'NH3', 'nox': 'NOx', 'alcohol': 'Alcohol', 'benzene': 'Benzene',
            'h2': 'H2', 'air': 'Air', 'temperature': 'Temperature', 'humidity': 'Humidity',
            'sd_aqi': 'SD_AQI', 'sd_aqi_level': 'SD_AQI_level', 'timestamp_ms': 'timestamp_ms'
        }

        normalized = {}
        for k, v in data.items():
            if not isinstance(k, str):
                continue
            lk = k.lower()
            if lk in key_map:
                normalized[key_map[lk]] = v
            else:
                # Preserve unknown keys as-is
                normalized[k] = v

        # Coerce numeric fields to numbers where possible
        numeric_keys = ['LPG','CO','Smoke','CO_MQ7','CH4','CO_MQ9','CO2','NH3','NOx','Alcohol','Benzene','H2','Air','Temperature','Humidity','SD_AQI','timestamp']
        for nk in numeric_keys:
            if nk in normalized:
                try:
                    # ensure floats for numeric fields
                    normalized[nk] = float(normalized[nk])
                except Exception:
                    # leave as-is if coercion fails
                    pass

        # Preserve any device-provided timestamp (seconds or milliseconds) and
        # attach a server receive time separately for diagnostics. Do NOT
        # overwrite a device timestamp with server time — that breaks client-side
        # ordering when devices include real epochs.
        try:
            normalized['_received_at'] = datetime.utcnow().isoformat()
        except Exception:
            pass

        logger.debug("Normalized data to send to Flask: %s", normalized)
        return normalized
    except json.JSONDecodeError:
        logger.debug("Invalid data format. Skipping: %s", raw_data)
        return None


def _extract_json_from_buffer(buf):
    """Extract the first complete JSON object from buf if present.
    Returns (json_str, remaining_buf) where json_str is None if no complete
    JSON object was found.
    """
    # find first opening brace
    start = buf.find('{')
    if start == -1:
        # no JSON start yet, discard any leading garbage
        return None, buf

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(buf)):
        ch = buf[i]
        if in_string:
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == '"':
                in_string = False
            # otherwise remain in string
            continue
        else:
            if ch == '"':
                in_string = True
                continue
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    # found a complete JSON object from start..i
                    return buf[start:i+1], buf[i+1:]
    # no complete object yet
    return None, buf


def auto_baud_probe(port, bauds=None, timeout_per_baud=0.4):
    """Try a list of baud rates and return (baud, sample_bytes) for the first
    baud that returns readable data. Returns (None, b'') if none found.
    This is non-destructive: it opens the port briefly and closes it.
    """
    if bauds is None:
        bauds = COMMON_BAUD_RATES
    for baud in bauds:
        try:
            s = serial.Serial(port, baud, timeout=timeout_per_baud)
            try:
                # flush input, wait a short time, then read
                try:
                    s.reset_input_buffer()
                except Exception:
                    pass
                time.sleep(0.05)
                data = s.read(256)
                if data and len(data) > 0:
                    logger.debug("auto_baud_probe: port %s baud %d returned %d bytes", port, baud, len(data))
                    try:
                        s.close()
                    except Exception:
                        pass
                    return baud, data
            finally:
                try:
                    s.close()
                except Exception:
                    pass
        except Exception as e:
            logger.debug("auto_baud_probe: cannot open %s at %d: %s", port, baud, e)
            continue
    return None, b''


def main():
    # modify module-level `ser` and `_buffer`
    global ser, _buffer
    # interval (seconds) to attempt flushing the on-disk queue
    FLUSH_INTERVAL = float(os.getenv('XBEE_FLUSH_INTERVAL', '5'))
    last_flush = time.time()

    while True:
        try:
            if ser is None:
                # Try to reconnect if serial is not available
                connect_xbee(retries=1, delay=1)
                time.sleep(1)
                continue

            # Periodically attempt to flush queued payloads to Flask
            try:
                if time.time() - last_flush >= FLUSH_INTERVAL:
                    flush_queue()
                    last_flush = time.time()
            except Exception:
                # protect main loop from flush errors
                logger.debug("flush_queue() failed, will retry later")

            if ser.in_waiting > 0:
                # Read available bytes with small retries — sometimes the port
                # reports available data but read() returns empty due to transient
                # device state or concurrent access. If empty reads persist,
                # close and reconnect the serial port to recover.
                try:
                    to_read = ser.in_waiting
                    chunk_bytes = b''
                    attempts = 0
                    # Try a few quick retries to allow device to flush data
                    while attempts < 3 and len(chunk_bytes) == 0:
                        # read at most `to_read` bytes, fallback to 1 if 0
                        read_len = to_read if to_read and to_read > 0 else 1
                        chunk_bytes = ser.read(read_len)
                        attempts += 1
                        if len(chunk_bytes) == 0:
                            time.sleep(0.05)

                    if len(chunk_bytes) == 0:
                        # Persistent empty read despite reported data — likely
                        # device disconnect or concurrent access. Reopen port.
                        logger.debug("Serial reported %s bytes but read returned empty; reopening port", to_read)
                        try:
                            port_name = getattr(ser, 'port', None)
                            ser.close()
                        except Exception:
                            pass
                        ser = None
                        # short backoff before reconnecting
                        time.sleep(1.0)
                        continue

                    # decode and append
                    chunk = chunk_bytes.decode('utf-8', errors='replace')
                    # Debug: show raw bytes and decoded chunk when debugging is enabled
                    logger.debug("Serial chunk bytes (len=%d): %r", len(chunk_bytes), chunk_bytes)
                    logger.debug("Decoded chunk: %r", chunk)
                except serial.SerialException as e:
                    logger.warning("SerialException reading serial chunk: %s", e)
                    try:
                        ser.close()
                    except Exception:
                        pass
                    ser = None
                    time.sleep(1.0)
                    continue
                except OSError as e:
                    logger.warning("OSError reading serial chunk: %s", e)
                    try:
                        ser.close()
                    except Exception:
                        pass
                    ser = None
                    time.sleep(1.0)
                    continue
                except Exception as e:
                    logger.warning("Error reading serial chunk: %s", e)
                    chunk = ''

                _buffer += chunk
                # record raw chunk for diagnostics
                try:
                    recent_raw.appendleft(chunk)
                except Exception:
                    pass

                # Try extracting any complete JSON objects from the buffer
                while True:
                    json_str, _buffer = _extract_json_from_buffer(_buffer)
                    if json_str is None:
                        break
                    json_str = json_str.strip()
                    logger.debug("Extracted JSON string: %s", json_str)
                    parsed_data = parse_xbee_data(json_str)
                    if parsed_data:
                        # Record the complete JSON string for frontend debugging (newest-first)
                        try:
                            recent_raw.appendleft(json_str)
                        except Exception:
                            pass
                        send_to_flask(parsed_data)
                    else:
                        logger.debug("parse_xbee_data returned None for extracted json: %s", json_str)
            else:
                # avoid busy spin
                time.sleep(0.05)
        except Exception as e:
            logger.warning("Error reading from XBee: %s", e)


if __name__ == "__main__":
    main()
