#include <DHT.h>
#include <math.h>
#include <avr/pgmspace.h>
#ifndef ENABLE_XBEE
#define ENABLE_XBEE 1
#endif

// When JSON_ONLY is 1 the sketch will output ONLY the single-line JSON payload
// per measurement loop (still printed to Serial and XBee if ENABLE_XBEE).
// Set to 0 to keep human-readable debug prints as well.
#define JSON_ONLY 1

#if ENABLE_XBEE
#include <SoftwareSerial.h>
#endif
// SoftwareSerial XBee(2, 3); // RX, TX for XBee communication (commented out for now)

#define MQ2_PIN 0
#define MQ7_PIN 1
#define MQ4_PIN 4
#define MQ9_PIN 2
#define MQ135_PIN 3
#define MQ8_PIN 5
#define RL_VALUE 10
#define DHT_PIN 8
#define DHT_TYPE DHT11

DHT dht(DHT_PIN, DHT_TYPE);

// XBee on SoftwareSerial (RX, TX)
#if ENABLE_XBEE
SoftwareSerial XBee(2, 3);
#endif

#define CALIBARAION_SAMPLE_TIMES 50
#define CALIBRATION_SAMPLE_INTERVAL 500
#define READ_SAMPLE_TIMES 5
#define READ_SAMPLE_INTERVAL 50
// Filtering / smoothing settings
#define ANALOG_READ_RETRIES 5
#define EMA_ALPHA 0.25 // Exponential moving average factor (0..1)

const float MQ2Curve[3] PROGMEM = {1.291, 0.21, -0.47}; // LPG, Smoke
const float COCurve[3] PROGMEM = {1.502, 0.72, -0.34}; // CO (MQ-2)
const float SmokeCurve[3] PROGMEM = {1.657, 0.53, -0.49}; // Smoke
const float MQ7Curve[3] PROGMEM = {1.224, 0.35, -0.38}; // CO (MQ-7)
const float MQ4Curve[3] PROGMEM = {0.858, 0.26, -0.26}; // CH4
const float MQ9Curve[3] PROGMEM = {1.5, 0.55, -0.45}; // CO (MQ-9)
const float CO2Curve[3] PROGMEM = {2.3, 0.72, -0.34};    // CO2
const float NH3Curve[3] PROGMEM = {1.9, 0.85, -0.44};    // NH3
const float NOxCurve[3] PROGMEM = {1.8, 0.80, -0.41};    // NOx
const float AlcoholCurve[3] PROGMEM = {1.7, 0.78, -0.35}; // Alcohol
const float BenzeneCurve[3] PROGMEM = {1.8, 0.82, -0.40}; // Benzene
const float MQ8Curve[3] PROGMEM = {1.0, 0.30, -0.45}; // H2 (MQ-8)
const float AirCurve[3] PROGMEM = {1.5, 0.28, -0.44}; // Air (hypothetical MQ-8)

float Ro_MQ2 = 10;
float Ro_MQ7 = 10;
float Ro_MQ4 = 10;
float Ro_MQ9 = 10;
float Ro_MQ135 = 10;
float Ro_MQ8 = 10;

// Smoothed sensor RS values (for EMA)
float SmoothedRS_MQ2 = 0;
float SmoothedRS_MQ7 = 0;
float SmoothedRS_MQ4 = 0;
float SmoothedRS_MQ9 = 0;
float SmoothedRS_MQ135 = 0;
float SmoothedRS_MQ8 = 0;

const float MAX_CO2_THRESHOLD = 500.0;    // ppm
const float MAX_CO_THRESHOLD = 15.0;     // ppm
const float MAX_OIL_THRESHOLD = 0.5;     // mg/m³
const float MAX_NOX_THRESHOLD = 2.0;     // ppm
const float MAX_HYDROCARBONS_THRESHOLD = 1.0; // ppm
const float MAX_MOISTURE_THRESHOLD = 60.0; // Percentage relative humidity

float MQResistanceCalculation(int raw_adc) {
  if (raw_adc == 0) {
    Serial.println(F("Error: Invalid ADC value (0)"));
    return NAN;
  }
  return ((float)RL_VALUE * (1023 - raw_adc) / raw_adc);
}

// Read analog input with simple retries to avoid transient zero/invalid values
int analogReadWithRetries(int pin) {
  int val;
  for (int i = 0; i < ANALOG_READ_RETRIES; i++) {
    val = analogRead(pin);
    if (val > 0 && val < 1023) return val;
    delay(5);
  }
  return val; // return last attempt (may be 0 or 1023)
}

// Read a trimmed mean from ADC: take READ_SAMPLE_TIMES samples, drop min and max, return mean
int readAnalogFilteredRaw(int pin) {
  int samples[READ_SAMPLE_TIMES];
  for (int i = 0; i < READ_SAMPLE_TIMES; i++) {
    samples[i] = analogReadWithRetries(pin);
    delay(READ_SAMPLE_INTERVAL);
  }
  // simple trim: find min and max, sum others
  int minv = 1024, maxv = -1;
  long sum = 0;
  for (int i = 0; i < READ_SAMPLE_TIMES; i++) {
    if (samples[i] < minv) minv = samples[i];
    if (samples[i] > maxv) maxv = samples[i];
    sum += samples[i];
  }
  if (READ_SAMPLE_TIMES > 2) {
    sum -= minv;
    sum -= maxv;
    return (int)(sum / (READ_SAMPLE_TIMES - 2));
  }
  return (int)(sum / READ_SAMPLE_TIMES);
}

float MQCalibration(int mq_pin, float clean_air_factor) {
  int i;
  float val = 0;
  for (i = 0; i < CALIBARAION_SAMPLE_TIMES; i++) {
    int raw = readAnalogFilteredRaw(mq_pin);
    float resistance = MQResistanceCalculation(raw);
    if (isnan(resistance) || isinf(resistance)) {
      Serial.println(F("Warning: Invalid resistance during calibration sample, skipping sample."));
      // don't abort calibration on single bad sample; reduce effective sample count
      continue;
    }
    val += resistance;
    delay(CALIBRATION_SAMPLE_INTERVAL);
  }
  // If we skipped many samples val may be 0
  if (val <= 0) {
    Serial.println(F("Calibration failed: no valid samples. Using default Ro=10."));
    return 10.0;
  }
  val = val / CALIBARAION_SAMPLE_TIMES;
  return val / clean_air_factor;
}

float MQRead(int mq_pin, float Ro) {
  // Use trimmed mean of analog readings then compute resistance
  int raw = readAnalogFilteredRaw(mq_pin);
  float rs = MQResistanceCalculation(raw);
  if (isnan(rs) || isinf(rs)) return NAN;

  // Apply exponential moving average smoothing on a per-pin basis
  if (mq_pin == MQ2_PIN) {
    if (SmoothedRS_MQ2 <= 0) SmoothedRS_MQ2 = rs; else SmoothedRS_MQ2 = (EMA_ALPHA * rs) + ((1 - EMA_ALPHA) * SmoothedRS_MQ2);
    return SmoothedRS_MQ2;
  } else if (mq_pin == MQ7_PIN) {
    if (SmoothedRS_MQ7 <= 0) SmoothedRS_MQ7 = rs; else SmoothedRS_MQ7 = (EMA_ALPHA * rs) + ((1 - EMA_ALPHA) * SmoothedRS_MQ7);
    return SmoothedRS_MQ7;
  } else if (mq_pin == MQ4_PIN) {
    if (SmoothedRS_MQ4 <= 0) SmoothedRS_MQ4 = rs; else SmoothedRS_MQ4 = (EMA_ALPHA * rs) + ((1 - EMA_ALPHA) * SmoothedRS_MQ4);
    return SmoothedRS_MQ4;
  } else if (mq_pin == MQ9_PIN) {
    if (SmoothedRS_MQ9 <= 0) SmoothedRS_MQ9 = rs; else SmoothedRS_MQ9 = (EMA_ALPHA * rs) + ((1 - EMA_ALPHA) * SmoothedRS_MQ9);
    return SmoothedRS_MQ9;
  } else if (mq_pin == MQ135_PIN) {
    if (SmoothedRS_MQ135 <= 0) SmoothedRS_MQ135 = rs; else SmoothedRS_MQ135 = (EMA_ALPHA * rs) + ((1 - EMA_ALPHA) * SmoothedRS_MQ135);
    return SmoothedRS_MQ135;
  } else if (mq_pin == MQ8_PIN) {
    if (SmoothedRS_MQ8 <= 0) SmoothedRS_MQ8 = rs; else SmoothedRS_MQ8 = (EMA_ALPHA * rs) + ((1 - EMA_ALPHA) * SmoothedRS_MQ8);
    return SmoothedRS_MQ8;
  }
  return rs;
}

float MQGetGasPercentage(float rs_ro_ratio, float *pcurve) {
  return pow(10, (((log(rs_ro_ratio) - pcurve[1]) / pcurve[2]) + pcurve[0]));
}

float calculateSDAQI(float co, float co_mq7, float co_mq9, float ch4, float h2, float co2, float nox, float air) {
  return (co * 0.05) + (co_mq7 * 0.1) + (co_mq9 * 0.1) + (ch4 * 0.1) + (h2 * 0.05) + (co2 * 0.5) + (nox * 0.1) + (air * 0.05);
}

void evaluateAirQuality(float co2, float co, float lpg, float nox, float benzene, float humidity) {
  if (co2 > MAX_CO2_THRESHOLD) {
    Serial.println(F("ALERT: Carbon Dioxide (CO2) level exceeds safe threshold!"));
#if ENABLE_XBEE
    XBee.println(F("ALERT: Carbon Dioxide (CO2) level exceeds safe threshold!"));
#endif
    // sendToXBee("ALERT: CO2 level unsafe!\n");
  }
  if (co > MAX_CO_THRESHOLD) {
    Serial.println(F("ALERT: Carbon Monoxide (CO) level exceeds safe threshold!"));
#if ENABLE_XBEE
    XBee.println(F("ALERT: Carbon Monoxide (CO) level exceeds safe threshold!"));
#endif
    // sendToXBee("ALERT: CO level unsafe!\n");
  }
  if (lpg > MAX_HYDROCARBONS_THRESHOLD) {
    Serial.println(F("ALERT: LPG level exceeds safe threshold!"));
#if ENABLE_XBEE
    XBee.println(F("ALERT: LPG level exceeds safe threshold!"));
#endif
    // sendToXBee("ALERT: LPG level unsafe!\n");
  }
  if (nox > MAX_NOX_THRESHOLD) {
    Serial.println(F("ALERT: Nitrogen Oxides (NOx) level exceeds safe threshold!"));
#if ENABLE_XBEE
    XBee.println(F("ALERT: Nitrogen Oxides (NOx) level exceeds safe threshold!"));
#endif
    // sendToXBee("ALERT: NOx level unsafe!\n");
  }
  if (benzene > MAX_HYDROCARBONS_THRESHOLD) {
    Serial.println(F("ALERT: Benzene level exceeds safe threshold!"));
#if ENABLE_XBEE
    XBee.println(F("ALERT: Benzene level exceeds safe threshold!"));
#endif
    // sendToXBee("ALERT: Benzene level unsafe!\n");
  }
  if (humidity > MAX_MOISTURE_THRESHOLD) {
    Serial.println(F("ALERT: Humidity exceeds safe threshold!"));
#if ENABLE_XBEE
    XBee.println(F("ALERT: Humidity exceeds safe threshold!"));
#endif
    // sendToXBee("ALERT: Excessive moisture detected!\n");
  }
}

void printAirQualityReadings(float lpg, float co, float smoke, float co_mq7, float ch4, float co_mq9, float co2, float nh3, float nox, float alcohol, float benzene, float h2, float air) {
  Serial.println(F("================ AIR QUALITY READINGS ================"));
  Serial.print(F("LPG (MQ2): "));
  Serial.println(lpg, 3);
  Serial.print(F("CO (MQ2): "));
  Serial.println(co, 3);
  Serial.print(F("Smoke (MQ2): "));
  Serial.println(smoke, 3);
  Serial.print(F("CO (MQ7): "));
  Serial.println(co_mq7, 3);
  Serial.print(F("CH4 (MQ4): "));
  Serial.println(ch4, 3);
  Serial.print(F("CO (MQ9): "));
  Serial.println(co_mq9, 3);
  Serial.print(F("CO2 (MQ135): "));
  Serial.println(co2, 3);
  Serial.print(F("NH3 (MQ135): "));
  Serial.println(nh3, 3);
  Serial.print(F("NOx (MQ135): "));
  Serial.println(nox, 3);
  Serial.print(F("Alcohol (MQ135): "));
  Serial.println(alcohol, 3);
  Serial.print(F("Benzene (MQ135): "));
  Serial.println(benzene, 3);
  Serial.print(F("H2 (MQ8): "));
  Serial.println(h2, 3);
  Serial.print(F("Air (MQ8): "));
  Serial.println(air, 3);
  // Also forward the same table to XBee
#if ENABLE_XBEE
  XBee.println(F("================ AIR QUALITY READINGS ================"));
  XBee.print(F("LPG (MQ2): ")); XBee.println(lpg, 3);
  XBee.print(F("CO (MQ2): ")); XBee.println(co, 3);
  XBee.print(F("Smoke (MQ2): ")); XBee.println(smoke, 3);
  XBee.print(F("CO (MQ7): ")); XBee.println(co_mq7, 3);
  XBee.print(F("CH4 (MQ4): ")); XBee.println(ch4, 3);
  XBee.print(F("CO (MQ9): ")); XBee.println(co_mq9, 3);
  XBee.print(F("CO2 (MQ135): ")); XBee.println(co2, 3);
  XBee.print(F("NH3 (MQ135): ")); XBee.println(nh3, 3);
  XBee.print(F("NOx (MQ135): ")); XBee.println(nox, 3);
  XBee.print(F("Alcohol (MQ135): ")); XBee.println(alcohol, 3);
  XBee.print(F("Benzene (MQ135): ")); XBee.println(benzene, 3);
  XBee.print(F("H2 (MQ8): ")); XBee.println(h2, 3);
  XBee.print(F("Air (MQ8): ")); XBee.println(air, 3);
#endif
}

void setup() {
  Serial.begin(9600);
  // XBee.begin(9600); // Commented out XBee communication
  dht.begin();

  Serial.println(F("Calibrating MQ-2..."));
  Ro_MQ2 = MQCalibration(MQ2_PIN, 9.83);
  Serial.print(F("Ro for MQ-2: ")); Serial.println(Ro_MQ2);

  Serial.println(F("Calibrating MQ-7..."));
  Ro_MQ7 = MQCalibration(MQ7_PIN, 27.32);
  Serial.print(F("Ro for MQ-7: ")); Serial.println(Ro_MQ7);

  Serial.println(F("Calibrating MQ-4..."));
  Ro_MQ4 = MQCalibration(MQ4_PIN, 4.40);
  Serial.print(F("Ro for MQ-4: ")); Serial.println(Ro_MQ4);

  Serial.println(F("Calibrating MQ-9..."));
  Ro_MQ9 = MQCalibration(MQ9_PIN, 9.80);
  Serial.print(F("Ro for MQ-9: ")); Serial.println(Ro_MQ9);

  Serial.println(F("Calibrating MQ-135..."));
  Ro_MQ135 = MQCalibration(MQ135_PIN, 3.6);
  Serial.print(F("Ro for MQ-135: ")); Serial.println(Ro_MQ135);

  Serial.println(F("Calibrating MQ-8..."));
  Ro_MQ8 = MQCalibration(MQ8_PIN, 9.99);
  Serial.print(F("Ro for MQ-8: ")); Serial.println(Ro_MQ8);
  Serial.println();
  Serial.println(F("Calibration helper available. Send 'C' over Serial to start interactive calibration."));
  // Start XBee serial
#if ENABLE_XBEE
  XBee.begin(9600);
  XBee.println(F("XBee ready"));
#endif
}

// ------ Calibration helper (interactive via Serial) ------
// We will ask user to provide two known concentrations (ppm) for a chosen sensor,
// measure averaged Rs/Ro at each concentration, and compute pcurve[] values.
// The MQGetGasPercentage uses: ppm = 10^(((ln(rs_ro) - p1)/p2) + p0)
// Let y = log10(ppm), x = ln(rs_ro). Then y = (x - p1)/p2 + p0 = (1/p2)*x + (p0 - p1/p2)
// From two (x,y) points we get slope m = (y2-y1)/(x2-x1) = 1/p2 -> p2 = 1/m
// We'll choose p1 = 0 (reference ln(rs_ro)=0) to make pcurve[1]=0 and compute p0 accordingly.
// That yields a simple, deterministic fit useful for the sketch; for highest accuracy use
// an external curve-fitting workflow with datasheet points or more calibration points.

void computeTwoPointCurve(float ppm1, float rsro1, float ppm2, float rsro2, float *outCurve) {
  float x1 = log(rsro1);
  float x2 = log(rsro2);
  float y1 = log10(ppm1);
  float y2 = log10(ppm2);
  if (fabs(x2 - x1) < 1e-6) {
    Serial.println(F("Error: Rs/Ro points identical (can't fit curve)"));
    outCurve[0] = outCurve[1] = outCurve[2] = NAN;
    return;
  }
  float m = (y2 - y1) / (x2 - x1); // m = 1/p2
  float p2 = 1.0 / m;
  // choose p1 = 0 for deterministic result
  float p1 = 0.0;
  // then from y = (x - p1)/p2 + p0 => p0 = y - x/p2 + p1/p2
  float p0 = y1 - (x1 / p2) + (p1 / p2);
  outCurve[0] = p0;
  outCurve[1] = p1;
  outCurve[2] = p2;
}

// Read a 3-float curve from PROGMEM into RAM
void readCurveFromProgmem(const float *progCurve, float dest[3]) {
  for (int i = 0; i < 3; i++) {
    dest[i] = pgm_read_float_near(progCurve + i);
  }
}

// Multi-point least-squares fit for y = a*x + b where x = ln(rs/ro), y = log10(ppm)
// Then a = 1/p2, b = p0 - p1/p2. We choose p1 = mean(x) by default to make
// p0 and p2 well-conditioned: p2 = 1/a, p0 = b + p1/p2
bool computeMultiPointCurve(float *ppm, float *rsro, int n, float *outCurve) {
  if (n < 2) return false;
  double sumx = 0, sumy = 0, sumxy = 0, sumx2 = 0;
  for (int i = 0; i < n; i++) {
    if (rsro[i] <= 0 || ppm[i] <= 0) return false;
    double x = log(rsro[i]);
    double y = log10(ppm[i]);
    sumx += x;
    sumy += y;
    sumxy += x * y;
    sumx2 += x * x;
  }
  double denom = (n * sumx2 - sumx * sumx);
  if (fabs(denom) < 1e-12) return false;
  double a = (n * sumxy - sumx * sumy) / denom; // slope
  double b = (sumy - a * sumx) / n; // intercept
  if (fabs(a) < 1e-12) return false;
  double p2 = 1.0 / a;
  double meanx = sumx / n;
  double p1 = meanx; // choose p1 = mean(ln(rs/ro))
  double p0 = b + (p1 / p2);
  outCurve[0] = (float)p0;
  outCurve[1] = (float)p1;
  outCurve[2] = (float)p2;
  return true;
}

// Helper to measure averaged Rs/Ro for a given mq_pin and known Ro
float measureRsOverRo(int mq_pin, float Ro, int samples) {
  long validCount = 0;
  float sumRs = 0;
  for (int i = 0; i < samples; i++) {
    int raw = readAnalogFilteredRaw(mq_pin);
    float rs = MQResistanceCalculation(raw);
    if (isnan(rs) || isinf(rs)) continue;
    sumRs += rs;
    validCount++;
    delay(100);
  }
  if (validCount == 0) return NAN;
  float avgRs = sumRs / validCount;
  return avgRs / Ro;
}

// Non-blocking-ish serial parser for calibration command
void handleSerialCalibration() {
  if (!Serial.available()) return;
  char cmd = Serial.read();
  if (cmd != 'C' && cmd != 'c') return;
  Serial.println(F("Starting calibration (multi-point)."));
  Serial.println(F("Format: <sensor> <N> <ppm1> <ppm2> ... <ppmN>"));
  Serial.println(F("Sensor codes: 2=MQ2,7=MQ7,4=MQ4,9=MQ9,135=MQ135,8=MQ8"));
  Serial.println(F("Example: 2 3 10 50 100  -- will calibrate MQ2 with 3 reference concentrations (10,50,100 ppm)."));
  Serial.println(F("Enter line now:"));
  // wait for input line
  while (!Serial.available()) delay(10);
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) {
    Serial.println(F("No input, aborting."));
    return;
  }
  // Tokenize input
  const int MAX_TOKENS = 16;
  char buf[128];
  line.toCharArray(buf, sizeof(buf));
  char *tok = strtok(buf, " \t");
  if (!tok) { Serial.println(F("Parse error")); return; }
  int sensor = atoi(tok);
  tok = strtok(NULL, " \t");
  if (!tok) { Serial.println(F("Parse error: missing N")); return; }
  int N = atoi(tok);
  if (N < 2 || N > 10) { Serial.println(F("Invalid N: must be between 2 and 10")); return; }
  float ppmList[10];
  for (int i = 0; i < N; i++) {
    tok = strtok(NULL, " \t");
    if (!tok) { Serial.println(F("Parse error: not enough ppm values")); return; }
    ppmList[i] = atof(tok);
    if (ppmList[i] <= 0) { Serial.println(F("Invalid ppm value")); return; }
  }
  int pin = -1;
  float Ro = 10.0;
  if (sensor == 2) { pin = MQ2_PIN; Ro = Ro_MQ2; }
  else if (sensor == 7) { pin = MQ7_PIN; Ro = Ro_MQ7; }
  else if (sensor == 4) { pin = MQ4_PIN; Ro = Ro_MQ4; }
  else if (sensor == 9) { pin = MQ9_PIN; Ro = Ro_MQ9; }
  else if (sensor == 135) { pin = MQ135_PIN; Ro = Ro_MQ135; }
  else if (sensor == 8) { pin = MQ8_PIN; Ro = Ro_MQ8; }
  else {
    Serial.println(F("Unknown sensor code."));
    return;
  }
  // Collect measurements for each supplied ppm value
  float rsroList[10];
  for (int i = 0; i < N; i++) {
    Serial.print(F("Please expose sensor to ppm=")); Serial.println(ppmList[i]);
    Serial.println(F("When ready press Enter in Serial Monitor to measure..."));
    // wait for Enter
    while (!Serial.available()) delay(10);
    // consume the line
    Serial.readStringUntil('\n');
    float measured = measureRsOverRo(pin, Ro, 10);
    rsroList[i] = measured;
    Serial.print(F("Measured Rs/Ro for ")); Serial.print(ppmList[i]); Serial.print(F(" ppm: ")); Serial.println(measured);
    if (isnan(measured) || measured <= 0) {
      Serial.println(F("Invalid measurement detected; aborting calibration."));
      return;
    }
  }

  float newCurve[3];
  if (!computeMultiPointCurve(ppmList, rsroList, N, newCurve)) {
    Serial.println(F("Curve fit failed (degenerate data). Try different points or more spread."));
    return;
  }
  Serial.println(F("Computed pcurve (p0, p1, p2):"));
  Serial.print(newCurve[0], 6); Serial.print(F(", ")); Serial.print(newCurve[1], 6); Serial.print(F(", ")); Serial.println(newCurve[2], 6);
  Serial.println(F("You can copy these values into the sketch for this sensor's curve."));
}

void loop() {
  // Check for interactive calibration command from Serial
  handleSerialCalibration();
  float tmpCurve[3];
  readCurveFromProgmem(MQ2Curve, tmpCurve);
  float lpg = MQGetGasPercentage(MQRead(MQ2_PIN, Ro_MQ2)/Ro_MQ2, tmpCurve);
  readCurveFromProgmem(COCurve, tmpCurve);
  float co = MQGetGasPercentage(MQRead(MQ2_PIN, Ro_MQ2)/Ro_MQ2, tmpCurve);
  readCurveFromProgmem(SmokeCurve, tmpCurve);
  float smoke = MQGetGasPercentage(MQRead(MQ2_PIN, Ro_MQ2)/Ro_MQ2, tmpCurve);
  readCurveFromProgmem(MQ7Curve, tmpCurve);
  float co_mq7 = MQGetGasPercentage(MQRead(MQ7_PIN, Ro_MQ7)/Ro_MQ7, tmpCurve);
  readCurveFromProgmem(MQ4Curve, tmpCurve);
  float ch4 = MQGetGasPercentage(MQRead(MQ4_PIN, Ro_MQ4)/Ro_MQ4, tmpCurve);
  readCurveFromProgmem(MQ9Curve, tmpCurve);
  float co_mq9 = MQGetGasPercentage(MQRead(MQ9_PIN, Ro_MQ9)/Ro_MQ9, tmpCurve);
  readCurveFromProgmem(CO2Curve, tmpCurve);
  float co2 = MQGetGasPercentage(MQRead(MQ135_PIN, Ro_MQ135)/Ro_MQ135, tmpCurve);
  readCurveFromProgmem(NH3Curve, tmpCurve);
  float nh3 = MQGetGasPercentage(MQRead(MQ135_PIN, Ro_MQ135)/Ro_MQ135, tmpCurve);
  readCurveFromProgmem(NOxCurve, tmpCurve);
  float nox = MQGetGasPercentage(MQRead(MQ135_PIN, Ro_MQ135)/Ro_MQ135, tmpCurve);
  readCurveFromProgmem(AlcoholCurve, tmpCurve);
  float alcohol = MQGetGasPercentage(MQRead(MQ135_PIN, Ro_MQ135)/Ro_MQ135, tmpCurve);
  readCurveFromProgmem(BenzeneCurve, tmpCurve);
  float benzene = MQGetGasPercentage(MQRead(MQ135_PIN, Ro_MQ135)/Ro_MQ135, tmpCurve);
  readCurveFromProgmem(MQ8Curve, tmpCurve);
  float h2 = MQGetGasPercentage(MQRead(MQ8_PIN, Ro_MQ8)/Ro_MQ8, tmpCurve);
  readCurveFromProgmem(AirCurve, tmpCurve);
  float air = MQGetGasPercentage(MQRead(MQ8_PIN, Ro_MQ8)/Ro_MQ8, tmpCurve);

  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();

  if (!isnan(lpg) && !isnan(co) && !isnan(smoke) && !isnan(co_mq7) && !isnan(ch4) && !isnan(co_mq9) && !isnan(co2) && !isnan(nh3) && !isnan(nox) && !isnan(alcohol) && !isnan(benzene) && !isnan(h2) && !isnan(air) && !isnan(humidity) && !isnan(temperature)) {
    // compute SD-AQI before printing so it's included in JSON
    float SD_AQI = calculateSDAQI(co, co_mq7, co_mq9, ch4, h2, co2, nox, air);
    const char *SD_AQI_level;
    if (SD_AQI <= 50) {
      SD_AQI_level = "Excellent";
    } else if (SD_AQI <= 100) {
      SD_AQI_level = "Good";
    } else if (SD_AQI <= 150) {
      SD_AQI_level = "Moderate";
    } else if (SD_AQI <= 200) {
      SD_AQI_level = "Unhealthy for Sensitive Groups";
    } else if (SD_AQI <= 300) {
      SD_AQI_level = "Unhealthy";
    } else {
      SD_AQI_level = "Hazardous";
    }

    // Optionally keep human-readable prints for debugging
  #if !JSON_ONLY
    printAirQualityReadings(lpg, co, smoke, co_mq7, ch4, co_mq9, co2, nh3, nox, alcohol, benzene, h2, air);
    Serial.print(F("Scuba Diving Air Quality Index (SD-AQI): "));
    Serial.print(SD_AQI, 2);
    Serial.print(F(" - "));
    Serial.println(SD_AQI_level);
    Serial.println(F("---------------- ENVIRONMENTAL DATA ----------------"));
    Serial.print(F("Temperature: "));
    Serial.print(temperature, 2);
    Serial.println(F(" °C"));
    Serial.print(F("Humidity: "));
    Serial.print(humidity, 2);
    Serial.println(F(" %"));
    Serial.println(F("----------------------------------------------------"));
  #if ENABLE_XBEE
    // Forward human-readable messages to XBee as before
    XBee.print(F("Scuba Diving Air Quality Index (SD-AQI): "));
    XBee.print(SD_AQI, 2);
    XBee.print(F(" - "));
    XBee.println(SD_AQI_level);
    XBee.println(F("---------------- ENVIRONMENTAL DATA ----------------"));
    XBee.print(F("Temperature: ")); XBee.print(temperature, 2); XBee.println(F(" °C"));
    XBee.print(F("Humidity: ")); XBee.print(humidity, 2); XBee.println(F(" %"));
    XBee.println(F("----------------------------------------------------"));
  #endif
  #endif

    // Build a JSON object with all values and send over Serial and XBee
    String json = "{";
    json += "\"LPG\":" + String(lpg, 3) + ",";
    json += "\"CO\":" + String(co, 3) + ",";
    json += "\"Smoke\":" + String(smoke, 3) + ",";
    json += "\"CO_MQ7\":" + String(co_mq7, 3) + ",";
    json += "\"CH4\":" + String(ch4, 3) + ",";
    json += "\"CO_MQ9\":" + String(co_mq9, 3) + ",";
    json += "\"CO2\":" + String(co2, 3) + ",";
    json += "\"NH3\":" + String(nh3, 3) + ",";
    json += "\"NOx\":" + String(nox, 3) + ",";
    json += "\"Alcohol\":" + String(alcohol, 3) + ",";
    json += "\"Benzene\":" + String(benzene, 3) + ",";
    json += "\"H2\":" + String(h2, 3) + ",";
    json += "\"Air\":" + String(air, 3) + ",";
    json += "\"Temperature\":" + String(temperature, 2) + ",";
    json += "\"Humidity\":" + String(humidity, 2) + ",";
    json += "\"SD_AQI\":" + String(SD_AQI, 2) + ",";
    json += "\"SD_AQI_level\":\"" + String(SD_AQI_level) + "\"";
    json += "}";

    Serial.println(json);
#if ENABLE_XBEE
    XBee.println(json);
#endif

  } else {
    Serial.println(F("Error: Invalid or missing sensor readings."));
    // sendToXBee("Error: Invalid or missing sensor readings.\n");
  }

  delay(1000); // Delay for 1 second between measurements
}
