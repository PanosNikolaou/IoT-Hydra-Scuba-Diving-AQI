// Custom plugin for gradient background
const backgroundPlugin = {
    id: 'customBackground',
    beforeDraw: (chart) => {
        const { ctx, chartArea } = chart;
        if (!chartArea) {
            // Skip if chartArea is not yet defined
            return;
        }
        ctx.save();
        // Create a vertical gradient background
        const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        gradient.addColorStop(0, '#e0f7fa'); // Light blue
        gradient.addColorStop(1, '#ffffff'); // White

        // Draw the gradient background
        ctx.fillStyle = gradient;
        ctx.fillRect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
        ctx.restore();
    },
};

const mqCtx = document.getElementById('mqChart').getContext('2d');
const mqChart = new Chart(mqCtx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            { label: 'Temperature', data: [], borderColor: 'rgba(255, 99, 132, 1)', backgroundColor: 'rgba(255, 99, 132, 0.2)', fill: true },
            { label: 'Humidity', data: [], borderColor: 'rgba(54, 162, 235, 1)', backgroundColor: 'rgba(54, 162, 235, 0.2)', fill: true },
            { label: 'LPG', data: [], borderColor: 'rgba(75, 192, 192, 1)', backgroundColor: 'rgba(75, 192, 192, 0.2)', fill: true },
            { label: 'CO', data: [], borderColor: 'rgba(153, 102, 255, 1)', backgroundColor: 'rgba(153, 102, 255, 0.2)', fill: true },
            { label: 'Smoke', data: [], borderColor: 'rgba(255, 206, 86, 1)', backgroundColor: 'rgba(255, 206, 86, 0.2)', fill: true },
            { label: 'CO_MQ7', data: [], borderColor: 'rgba(75, 0, 130, 1)', backgroundColor: 'rgba(75, 0, 130, 0.2)', fill: true },
            { label: 'CH4', data: [], borderColor: 'rgba(255, 127, 80, 1)', backgroundColor: 'rgba(255, 127, 80, 0.2)', fill: true },
            { label: 'CO_MQ9', data: [], borderColor: 'rgba(34, 139, 34, 1)', backgroundColor: 'rgba(34, 139, 34, 0.2)', fill: true },
            { label: 'CO2', data: [], borderColor: 'rgba(128, 0, 128, 1)', backgroundColor: 'rgba(128, 0, 128, 0.2)', fill: true },
            { label: 'NH3', data: [], borderColor: 'rgba(255, 165, 0, 1)', backgroundColor: 'rgba(255, 165, 0, 0.2)', fill: true },
            { label: 'NOx', data: [], borderColor: 'rgba(0, 128, 128, 1)', backgroundColor: 'rgba(0, 128, 128, 0.2)', fill: true },
            { label: 'Alcohol', data: [], borderColor: 'rgba(128, 128, 0, 1)', backgroundColor: 'rgba(128, 128, 0, 0.2)', fill: true },
            { label: 'Benzene', data: [], borderColor: 'rgba(255, 20, 147, 1)', backgroundColor: 'rgba(255, 20, 147, 0.2)', fill: true },
            { label: 'H2', data: [], borderColor: 'rgba(70, 130, 180, 1)', backgroundColor: 'rgba(70, 130, 180, 0.2)', fill: true },
            { label: 'Air', data: [], borderColor: 'rgba(220, 20, 60, 1)', backgroundColor: 'rgba(220, 20, 60, 0.2)', fill: true },
        ],
    },
    options: {
        responsive: true,
        scales: {
            x: { type: 'time', time: { unit: 'second' }, title: { display: true, text: 'Time' } },
            y: { title: { display: true, text: 'Value' } },
        },
    },
});

let mqCurrentPage = 1;
const mqRecordsPerPage = 10;
let activeFilter = '24hours'; // Default filter
let mqDataTable = null;
let lastFilteredData = [];
let pollIntervalMs = 1000;
let pollTimerId = null;
let isPolling = true;
// Track the latest server 'now' reported by the API and when we received it so
// we can display a live ticking server clock even between fetches.
let lastServerNowIso = null;
let lastServerNowFetchAt = null; // ms since epoch when we received lastServerNowIso

document.getElementById('timeFilter').addEventListener('change', (event) => {
    activeFilter = event.target.value;
    document.getElementById('customDateRange').style.display = activeFilter === 'custom' ? 'block' : 'none';
});

// Chart-specific filter controls
const chartTimeFilterEl = document.getElementById('chartTimeFilter');
if (chartTimeFilterEl) {
    chartTimeFilterEl.addEventListener('change', (e) => {
        const v = e.target.value;
        document.getElementById('chartCustomDateRange').style.display = v === 'custom' ? 'block' : 'none';
    });
}

document.getElementById('applyFilter').addEventListener('click', () => {
    fetchMqData(); // Re-fetch data with the selected filter
});

let mqData = []; // Global variable to store MQ sensor data
let lastServerTimestamp = null;

function updateServerTimestampDisplay(ts) {
    try {
        const el = document.getElementById('server-latest-ts');
        if (!el) return;
        // Format ts to local string if it's a parseable date
        let disp = ts;
        try {
            const d = parseServerTimestamp(ts);
            if (!isNaN(d.getTime())) disp = d.toLocaleString();
        } catch (e) {}
        el.innerText = `Server: ${disp}`;
        // flash highlight when changed
        el.classList.add('bg-success');
        el.classList.add('text-white');
        setTimeout(() => {
            el.classList.remove('bg-success');
            el.classList.remove('text-white');
        }, 900);
    } catch (e) {
        console.warn('updateServerTimestampDisplay error', e);
    }
}

// Parse server timestamp consistently. Many servers emit naive ISO strings
// (e.g. "2025-12-01T20:50:30") without a timezone. Different browsers
// sometimes interpret these as local or UTC inconsistently. To make
// ordering and display consistent, treat naive ISO timestamps as UTC by
// appending a 'Z' when no timezone is present.
function parseServerTimestamp(ts) {
    if (!ts) return null;
    try {
        // Normalize microsecond precision (trim to milliseconds) because
        // `Date` parsing in browsers expects at most 3 fractional digits.
        // Example: "2025-12-01T21:19:18.484161+00:00" -> trim to .484
        let s = String(ts);
        s = s.replace(/\.(\d{3})\d+/, '.$1');

        // If already contains timezone info (Z or +/-) leave as-is
        if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) {
            return new Date(s);
        }
        // If it looks like an ISO datetime without timezone, append 'Z' to
        // force UTC parsing and avoid inconsistent local interpretation.
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
            return new Date(s + 'Z');
        }
        // fallback
        return new Date(s);
    } catch (e) {
        return new Date(ts);
    }
}

async function fetchMqData() {
    try {
        // --- Debug toggle init (persistent) ---
        if (window.__mqDebugInit !== true) {
            window.mqDebugEnabled = (localStorage.getItem('mq_debug') === 'true');
            const existingToggle = document.getElementById('mq-debug-toggle');
            if (existingToggle) {
                existingToggle.checked = window.mqDebugEnabled;
                existingToggle.addEventListener('change', (e) => {
                    window.mqDebugEnabled = !!e.target.checked;
                    try { localStorage.setItem('mq_debug', window.mqDebugEnabled ? 'true' : 'false'); } catch (err) {}
                    const dbgEl = document.getElementById('debug-strip');
                    if (dbgEl) dbgEl.style.background = window.mqDebugEnabled ? '#fff3cd' : '';
                });
            } else {
                // create a small non-intrusive toggle in the top-right if none exists
                try {
                    const t = document.createElement('label');
                    t.style.position = 'fixed';
                    t.style.top = '8px';
                    t.style.right = '8px';
                    t.style.zIndex = 3000;
                    t.style.fontSize = '12px';
                    t.style.background = 'rgba(255,255,255,0.9)';
                    t.style.padding = '4px 8px';
                    t.style.borderRadius = '6px';
                    t.style.boxShadow = '0 1px 4px rgba(0,0,0,0.12)';
                    t.innerHTML = `<input id="mq-debug-toggle" type="checkbox" style="margin-right:6px"> Debug`;
                    document.body.appendChild(t);
                    const cb = document.getElementById('mq-debug-toggle');
                    cb.checked = window.mqDebugEnabled;
                    cb.addEventListener('change', (e) => {
                        window.mqDebugEnabled = !!e.target.checked;
                        try { localStorage.setItem('mq_debug', window.mqDebugEnabled ? 'true' : 'false'); } catch (err) {}
                        const dbgEl = document.getElementById('debug-strip');
                        if (dbgEl) dbgEl.style.background = window.mqDebugEnabled ? '#fff3cd' : '';
                    });
                } catch (e) {
                    // ignore DOM insertion failures
                }
            }
            window.__mqDebugInit = true;
        }

        const debug = !!window.mqDebugEnabled;

        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (debug) console.debug('[MQ DEBUG] fetch /api/mq-data start', { time: new Date().toISOString() });

        const response = await fetch('/api/mq-data');
        const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const tookMs = Math.round(t1 - t0);

        if (!response.ok) {
            const msg = `HTTP ${response.status} ${response.statusText}`;
            if (debug) console.debug('[MQ DEBUG] fetch failed', { status: response.status, statusText: response.statusText, tookMs });
            throw new Error(msg);
        }

        let result;
        try {
            result = await response.json();
            // Normalize API formats: some endpoints return { mq_data: ... }
            // while others may return the record directly. Accept both.
            if (result && !result.mq_data && (result.timestamp || result.uuid || result.LPG || result.temperature)) {
                if (debug) console.warn('[MQ DEBUG] Normalizing unwrapped API record to {mq_data:...}', { hint: result && (result.uuid || result.timestamp) });
                else console.warn('Normalizing unwrapped API record to {mq_data:...} — enable MQ debug for details');

                // Show a one-time in-UI dismissible banner so the user notices
                try {
                    const seenKey = 'mq_normalization_shown_v1';
                    if (!sessionStorage.getItem(seenKey)) {
                        const banner = document.createElement('div');
                        banner.className = 'alert alert-warning alert-dismissible';
                        banner.style.position = 'fixed';
                        banner.style.top = '8px';
                        banner.style.left = '50%';
                        banner.style.transform = 'translateX(-50%)';
                        banner.style.zIndex = 4000;
                        banner.style.maxWidth = '920px';
                        banner.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)';
                        banner.innerHTML = `<div style="display:flex;align-items:center;gap:12px"><div style="flex:1"><strong>Note:</strong> API returned an unwrapped record; the frontend normalized it to the expected shape. Consider making the API return { mq_data: ... } consistently.</div><button type="button" aria-label="Close" style="background:none;border:none;padding:6px;cursor:pointer;font-size:16px">✕</button></div>`;
                        const btn = banner.querySelector('button');
                        btn.addEventListener('click', () => { banner.remove(); });
                        document.body.appendChild(banner);
                        sessionStorage.setItem(seenKey, '1');
                    }
                } catch (e) { if (debug) console.debug('[MQ DEBUG] failed to show normalization banner', e); }

                result = { mq_data: result, server_now: result.server_now };
            }
            if (debug) console.debug('[MQ DEBUG] parsed JSON result', { tookMs, size: (result && JSON.stringify(result).length) || 0, result });
        } catch (err) {
            if (debug) console.error('[MQ DEBUG] JSON parse error', err);
            throw err;
        }

        // Store result in the global mqData so other controls can use it
        // The API may return either a single latest record (object) or an array.
        // If a single object is returned, merge it into the client's history (`mqData`).
        try {
            if (!result || !result.mq_data) {
                if (debug) console.debug('[MQ DEBUG] result.mq_data missing or falsy — leaving mqData untouched');
                mqData = mqData || [];
            } else if (Array.isArray(result.mq_data)) {
                if (debug) console.debug('[MQ DEBUG] result.mq_data is array — replacing mqData with array of length', result.mq_data.length);
                mqData = result.mq_data.slice();
            } else {
                // Single object received; merge into existing mqData history
                const rec = result.mq_data;
                mqData = mqData || [];
                // Avoid duplicates by uuid or timestamp
                let exists = false;
                if (rec && rec.uuid) {
                    exists = mqData.some(r => r && r.uuid && r.uuid === rec.uuid);
                }
                if (!exists && rec && rec.timestamp) {
                    exists = mqData.some(r => r && r.timestamp && r.timestamp === rec.timestamp);
                }
                if (debug) console.debug('[MQ DEBUG] merging single record into mqData', { rec, exists });
                if (exists) {
                    // replace existing matching entry
                    mqData = mqData.map(r => ((r && r.uuid && rec.uuid && r.uuid === rec.uuid) || (r && r.timestamp && r.timestamp === rec.timestamp)) ? rec : r);
                } else {
                    // append new record
                    mqData.push(rec);
                    // cap history to reasonable size
                    if (mqData.length > 500) mqData = mqData.slice(-500);
                }
            }
        } catch (e) {
            if (debug) console.error('[MQ DEBUG] error while storing result into mqData', e);
            mqData = result && result.mq_data ? (Array.isArray(result.mq_data) ? result.mq_data.slice() : [result.mq_data]) : (mqData || []);
        }

        // Note: render summary after filtering so the "previous" value for deltas is available
        // (use fallback logic below if filter yields no results)

        if (!mqData || mqData.length === 0) {
            // Clear structured fields when no data
            const ids = ['lpg','co','smoke','co-mq7','ch4','co-mq9','co2','nh3','nox','alcohol','benzene','h2','air','temp','hum'];
            ids.forEach(id => {
                const el = document.getElementById(id + '-val');
                if (el) el.innerText = '—';
            });
            const badge = document.getElementById('sd-aqi-badge');
            if (badge) { badge.innerText = '—'; badge.style.backgroundColor = ''; badge.style.color = ''; }
        }

        // Filter data based on selected criteria
        const filteredMqData = filterDataByCriteria(mqData || []);
        // If the filter produced no results (e.g. latest data is older than the time window),
        // fall back to using the most recent available records so the UI isn't empty.
        let usedData = filteredMqData;
        if ((!usedData || usedData.length === 0) && mqData && mqData.length > 0) {
            usedData = mqData.slice();
        }

        // Indicate if we're using fallback (filtered result empty -> using latest available)
        const usingFallback = ((!filteredMqData || filteredMqData.length === 0) && mqData && mqData.length > 0);

        // Update fallback hint UI
        const fallbackEl = document.getElementById('fallback-hint');
        if (fallbackEl) {
            if (usingFallback) {
                // Compute the latest record by timestamp instead of assuming mqData[0]
                let latestRec = null;
                if (mqData && mqData.length > 0) {
                    latestRec = mqData.slice().sort((a, b) => parseServerTimestamp(b.timestamp) - parseServerTimestamp(a.timestamp))[0];
                }
                const latestTs = latestRec && latestRec.timestamp ? parseServerTimestamp(latestRec.timestamp).toLocaleString() : '(unknown)';
                fallbackEl.style.display = 'block';
                fallbackEl.innerHTML = `<div class="alert alert-warning p-1 m-0">Showing latest available data (latest record: ${latestTs}), which is older than the selected filter.</div>`;
                // Ensure the visible summary (recorded-at and summary cards) also reflect
                // the latest available record when we're falling back, so the UI isn't
                // left showing stale or empty values.
                try {
                    if (latestRec) {
                        const prevRec = null;
                        renderMqSummary(latestRec, prevRec);
                    }
                } catch (e) { if (debug) console.warn('[MQ DEBUG] fallback render summary failed', e); }
            } else {
                fallbackEl.style.display = 'none';
                fallbackEl.innerHTML = '';
            }
        }

        // Debug helper: log what the API returned and whether we used a fallback.
        try {
            const dbg = { server_now: result && result.server_now, filtered_count: (filteredMqData||[]).length, total_count: (mqData||[]).length, usingFallback, tookMs };
            if (debug) console.debug('[MQ DEBUG] fetch result summary', dbg);
            // Also display the debug info in the visible debug strip for users
            const dbgEl = document.getElementById('debug-strip');
            if (dbgEl) {
                const latestRec = (mqData && mqData.length > 0) ? mqData.slice().sort((a,b)=>parseServerTimestamp(b.timestamp)-parseServerTimestamp(a.timestamp))[0] : null;
                const latestTs = latestRec && latestRec.timestamp ? parseServerTimestamp(latestRec.timestamp).toLocaleString() : '(none)';
                const serverNow = result && result.server_now ? parseServerTimestamp(result.server_now).toLocaleString() : '(none)';
                dbgEl.innerText = `Debug: server_now=${serverNow} • latest=${latestTs} • fallback=${usingFallback} • req=${tookMs}ms`;
                // When full debug is enabled, append pretty JSON
                if (debug) {
                    try {
                        const pretty = JSON.stringify(result, null, 2);
                        dbgEl.innerText += '\n\n' + pretty;
                        dbgEl.style.whiteSpace = 'pre-wrap';
                        dbgEl.style.background = '#fff3cd';
                        dbgEl.style.padding = '8px';
                    } catch (e) {
                        dbgEl.innerText += '\n\n(unable to stringify result)';
                    }
                } else {
                    // reset styling if debug disabled
                    dbgEl.style.background = '';
                }
                // Update the visible "last received" raw payload panel for quick debugging
                try {
                    const latestForUI = (mqData && mqData.length > 0) ? mqData.slice().sort((a,b)=>parseServerTimestamp(b.timestamp)-parseServerTimestamp(a.timestamp))[0] : null;
                    updateLastReceivedUI(latestForUI, result && result.server_now, usingFallback);
                } catch (e) { if (debug) console.debug('[MQ DEBUG] updateLastReceivedUI failed', e); }
            }
        } catch (e) { if (debug) console.debug('[MQ DEBUG] debug strip update failed', e); }

        // Sort usedData newest-first for chart/table/analysis and save for row click lookup
        const sortedFiltered = usedData.slice().sort((a, b) => parseServerTimestamp(b.timestamp) - parseServerTimestamp(a.timestamp));
        lastFilteredData = sortedFiltered.slice();

        // Render summary now that we have the sorted dataset (pass previous record for deltas)
        if (sortedFiltered.length > 0) {
            const latest = sortedFiltered[0];
            const prev = sortedFiltered.length > 1 ? sortedFiltered[1] : null;
            // Notify when new data arrives (server saved to DB)
            try {
                if (lastServerTimestamp) {
                    const lastMs = parseServerTimestamp(lastServerTimestamp) ? parseServerTimestamp(lastServerTimestamp).getTime() : 0;
                    const latestMs = parseServerTimestamp(latest.timestamp) ? parseServerTimestamp(latest.timestamp).getTime() : 0;
                    if (latestMs > lastMs) {
                        showToast(`New data received: ${parseServerTimestamp(latest.timestamp).toLocaleString()}`, 'success');
                        showToast('Record saved in database', 'info');
                    }
                }
            } catch (e) { /* ignore toast failures */ }

            renderMqSummary(latest, prev);
            // Update visible server timestamp indicator and flash if new
            try {
                const serverNowIso = result.server_now;
                const latestTs = latest.timestamp;
                const el = document.getElementById('server-latest-ts');
                if (serverNowIso) {
                    lastServerNowIso = serverNowIso;
                    lastServerNowFetchAt = Date.now();
                }
                if (el) {
                    let serverNowDisp = null;
                    if (lastServerNowIso) {
                        try {
                            const base = parseServerTimestamp(lastServerNowIso);
                            if (!isNaN(base.getTime()) && lastServerNowFetchAt) {
                                const advanced = new Date(base.getTime() + (Date.now() - lastServerNowFetchAt));
                                serverNowDisp = advanced.toLocaleString();
                            } else if (!isNaN(base.getTime())) {
                                serverNowDisp = base.toLocaleString();
                            }
                        } catch (e) { serverNowDisp = parseServerTimestamp(lastServerNowIso).toLocaleString(); }
                    }
                    const latestDisp = latestTs ? parseServerTimestamp(latestTs).toLocaleString() : null;
                    const localDisp = new Date().toLocaleString();
                    const tzOpts = { timeZone: 'Europe/Athens', timeZoneName: 'short' };
                    const serverNowPretty = serverNowDisp ? new Date(serverNowDisp).toLocaleString(undefined, tzOpts) : null;
                    const latestPretty = latestDisp ? new Date(latestDisp).toLocaleString(undefined, tzOpts) : null;
                    const localPretty = new Date().toLocaleString(undefined, tzOpts);
                    if (serverNowPretty && latestPretty) el.innerText = `Server: ${serverNowPretty} (latest data: ${latestPretty}) | Local: ${localPretty}`;
                    else if (serverNowPretty) el.innerText = `Server: ${serverNowPretty} | Local: ${localPretty}`;
                    else if (latestPretty) el.innerText = `Server: ${latestPretty} | Local: ${localPretty}`;
                    else el.innerText = `Local: ${localPretty}`;
                    el.classList.add('bg-success');
                    el.classList.add('text-white');
                    setTimeout(() => { el.classList.remove('bg-success'); el.classList.remove('text-white'); }, 900);
                }

                if (latest.timestamp) {
                    if (latest.timestamp !== lastServerTimestamp) {
                        lastServerTimestamp = latest.timestamp;
                    }
                    if (typeof window.__updateLastUpdated === 'function') {
                        window.__updateLastUpdated(new Date().toLocaleString());
                    }
                }
            } catch (e) { if (debug) console.warn('[MQ DEBUG] server timestamp update error', e); }
        }

        // Update the chart (chart update function will handle internal ordering/limiting)
        updateMqChart(sortedFiltered);

        // Update DataTable with latest filtered (or fallback) data
        updateMqDataTable(sortedFiltered);

        // Compute and render analysis cards
        computeAndRenderAnalysis(sortedFiltered);

        // Update last-updated timestamp only if server timestamp not available
        if (typeof window.__updateLastUpdated === 'function') {
            window.__updateLastUpdated(new Date().toLocaleString());
        }

        if (debug) console.debug('[MQ DEBUG] fetch /api/mq-data complete', { total: (mqData||[]).length, filtered: (filteredMqData||[]).length, used: (sortedFiltered||[]).length, tookMs });

    } catch (error) {
        // Surface rich debug info when enabled
        if (window && window.mqDebugEnabled) {
            console.error('[MQ DEBUG] Error fetching MQ data:', error);
            try {
                const dbgEl = document.getElementById('debug-strip');
                if (dbgEl) {
                    dbgEl.innerText = 'Error fetching /api/mq-data: ' + (error && error.message ? error.message : String(error)) + '\n\n' + (error && error.stack ? error.stack : '');
                    dbgEl.style.background = '#f8d7da';
                    dbgEl.style.whiteSpace = 'pre-wrap';
                    dbgEl.style.padding = '8px';
                }
            } catch (e) { /* ignore UI update failures */ }
        } else {
            console.error('Error fetching MQ data:', error);
        }
    }
}

// Render a human-readable summary and compute a simple SD-AQI
// Compute and render structured summary including SD-AQI badge
function renderMqSummary(record, prev) {
    if (!record) return;

    // Fill pollutant values into table cells
    const map = {
        'lpg-val': record.LPG,
        'co-val': record.CO,
        'smoke-val': record.Smoke,
        'co-mq7-val': record.CO_MQ7,
        'ch4-val': record.CH4,
        'co-mq9-val': record.CO_MQ9,
        'co2-val': record.CO2,
        'nh3-val': record.NH3,
        'nox-val': record.NOx,
        'alcohol-val': record.Alcohol,
        'benzene-val': record.Benzene,
        'h2-val': record.H2,
        'air-val': record.Air,
        'temp-val': record.temperature,
        'hum-val': record.humidity
    };
    Object.keys(map).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const v = map[id];
        const formatted = (v === null || v === undefined || isNaN(v)) ? 'N/A' : Number(v).toFixed(3);
        // determine corresponding key in record for delta comparison
        let key = id.replace('-val','');
        // mapping for temp/hum
        if (key === 'temp') key = 'temperature';
        if (key === 'hum') key = 'humidity';
        let prevVal = null;
        if (prev) {
            // tolerate different casings on the previous record
            if (prev[key] !== undefined) prevVal = prev[key];
            else if (prev[key.toLowerCase()] !== undefined) prevVal = prev[key.toLowerCase()];
            else if (prev[key.toUpperCase()] !== undefined) prevVal = prev[key.toUpperCase()];
            else prevVal = null;
        }
        // If immediate previous record didn't provide a value, search the
        // rest of the loaded dataset for the most recent non-null value
        // so we can still compute a delta arrow.
        if ((prevVal === null || prevVal === undefined || isNaN(prevVal)) && Array.isArray(lastFilteredData)) {
            for (let i = 1; i < lastFilteredData.length; i++) {
                const r = lastFilteredData[i];
                let cand = undefined;
                if (r[key] !== undefined) cand = r[key];
                else if (r[key.toLowerCase()] !== undefined) cand = r[key.toLowerCase()];
                else if (r[key.toUpperCase()] !== undefined) cand = r[key.toUpperCase()];
                if (cand !== undefined && cand !== null && !isNaN(cand)) { prevVal = cand; break; }
            }
        }
        el.innerHTML = formatted + ' ' + deltaHtml(v, prevVal);
        // description cells removed from the template — nothing to populate here.
    });

    // Show server-saved timestamp if present
    const recordedEl = document.getElementById('recorded-at');
    if (recordedEl) {
        if (record.timestamp) {
            try {
                recordedEl.innerText = parseServerTimestamp(record.timestamp).toLocaleString();
            } catch (e) {
                recordedEl.innerText = String(record.timestamp);
            }
        } else if (record.timestamp_ms) {
            // fallback to showing millis value if only timestamp_ms available
            recordedEl.innerText = 'device_millis:' + record.timestamp_ms;
        } else {
            recordedEl.innerText = '—';
        }
    }

    // If device provided SD-AQI, prefer that; otherwise compute SD-AQI using configurable scales and multiplier
    let sdAqiNum = null;
    if (record.sd_aqi !== undefined && record.sd_aqi !== null && !isNaN(record.sd_aqi)) {
        sdAqiNum = Number(record.sd_aqi);
    }
    // also check common alternative casings
    if (sdAqiNum === null && record.SD_AQI !== undefined && record.SD_AQI !== null && !isNaN(record.SD_AQI)) {
        sdAqiNum = Number(record.SD_AQI);
    }

    // Compute only if not provided by device
    const scales = {
        LPG: 0.01, CO: 0.01, Smoke: 0.05, CO_MQ7: 0.01, CH4: 0.01, CO_MQ9: 0.01,
        CO2: 10, NH3: 10, NOx: 10, Alcohol: 2, Benzene: 5, H2: 0.01, Air: 0.01
    };
    const keys = Object.keys(scales);
    if (sdAqiNum === null) {
        const normalized = [];
        keys.forEach(k => {
            const v = record[k];
            if (v !== null && v !== undefined && !isNaN(v) && Number(v) > 0) {
                normalized.push(Number(v) / scales[k]);
            }
        });

        let sdAqi = 0;
        if (normalized.length > 0) {
            const avg = normalized.reduce((s, x) => s + x, 0) / normalized.length;
            sdAqi = avg * 6; // multiplier tuned for small-range index; adjust if you have real formula
        }
        sdAqiNum = Number(sdAqi);
    }
    const sdAqiStr = (sdAqiNum !== null && sdAqiNum !== undefined) ? Number(sdAqiNum).toFixed(2) : '—';

    // Category and color thresholds (tune as needed)
    // Category and color thresholds (tune as needed) — allow device-provided level
    let category = 'Unknown';
    let color = '#6c757d'; // gray
    const providedLevel = record.sd_aqi_level || record.SD_AQI_level || record.sdAqiLevel;
    if (providedLevel) {
        category = providedLevel;
        // map some common names to colors
        if (/excellent/i.test(providedLevel)) color = '#28a745';
        else if (/good/i.test(providedLevel)) color = '#8bc34a';
        else if (/moderate/i.test(providedLevel)) color = '#ffc107';
        else if (/poor/i.test(providedLevel)) color = '#ff9800';
        else if (/hazardous/i.test(providedLevel)) color = '#dc3545';
    } else if (sdAqiNum !== null && !isNaN(sdAqiNum)) {
        if (sdAqiNum <= 3) { category = 'Excellent'; color = '#28a745'; }
        else if (sdAqiNum <= 6) { category = 'Good'; color = '#8bc34a'; }
        else if (sdAqiNum <= 9) { category = 'Moderate'; color = '#ffc107'; }
        else if (sdAqiNum <= 12) { category = 'Poor'; color = '#ff9800'; }
        else { category = 'Hazardous'; color = '#dc3545'; }
    }

    // Update badge
    const badge = document.getElementById('sd-aqi-badge');
    if (badge) {
        badge.innerText = `SD-AQI: ${sdAqiStr} — ${category}`;
        badge.style.backgroundColor = color;
        badge.style.color = '#ffffff';
    }
}

function formatVal(v) {
    if (v === null || v === undefined) return 'N/A';
    if (typeof v === 'string' && v.trim() === '') return 'N/A';
    if (isNaN(Number(v))) return 'N/A';
    return Number(v).toFixed(3);
}

function deltaHtml(curr, prev) {
    // curr and prev expected numeric
    if (curr === null || curr === undefined) return '<span style="color:#6c757d">—</span>';
    if (typeof curr === 'string' && curr.trim() === '') return '<span style="color:#6c757d">—</span>';
    if (isNaN(Number(curr))) return '<span style="color:#6c757d">—</span>';
    if (prev === null || prev === undefined) return '<span style="color:#6c757d">—</span>';
    if (typeof prev === 'string' && prev.trim() === '') return '<span style="color:#6c757d">—</span>';
    if (isNaN(Number(prev))) return '<span style="color:#6c757d">—</span>';
    const c = Number(curr);
    const p = Number(prev);
    if (c > p) return '<span style="color:#28a745;margin-left:6px">▲</span>';
    if (c < p) return '<span style="color:#dc3545;margin-left:6px">▼</span>';
    return '<span style="color:#6c757d;margin-left:6px">—</span>';
}

// Return a very short description for a metric based on current and previous values.
// Values: 'Rising', 'Falling', 'Stable', 'N/A' or '—' when unknown.
function getShortDesc(curr, prev) {
    if (curr === null || curr === undefined || isNaN(Number(curr))) return 'N/A';
    if (prev === null || prev === undefined || isNaN(Number(prev))) return '—';
    const c = Number(curr);
    const p = Number(prev);
    if (c > p) return 'Rising';
    if (c < p) return 'Falling';
    return 'Stable';
}

// Adjust the table container height so it fits the number of displayed rows.
// displayedRows: number of rows currently visible (e.g. page size or filtered results)
function adjustTableHeight(displayedRows) {
    try {
        const container = document.querySelector('.table-container');
        const table = document.getElementById('mq-data-table');
        if (!container || !table) return;

        // Minimal/defaults
        const minHeight = 80; // px
        const maxHeight = 900; // px cap to avoid extremely tall pages

        // Try to measure a real row height if present
        const tbody = table.querySelector('tbody');
        let rowHeight = 36; // sensible default
        if (tbody && tbody.firstElementChild) {
            const r = tbody.firstElementChild.getBoundingClientRect();
            if (r && r.height > 8) rowHeight = r.height;
        }

        // Header height (thead)
        let headerHeight = 0;
        const thead = table.querySelector('thead');
        if (thead) {
            const h = thead.getBoundingClientRect();
            if (h && h.height > 0) headerHeight = h.height;
        }

        const total = Math.max(minHeight, Math.min(maxHeight, Math.ceil(displayedRows) * rowHeight + headerHeight + 8));
        container.style.maxHeight = total + 'px';
        // When we set exact height, allow the page to scroll instead of inner box
        container.style.overflowY = 'auto';
    } catch (e) {
        // Ignore measurement failures
        console.warn('adjustTableHeight failed', e);
    }
}

// Filter Data Based on User Selection
function filterDataByCriteria(data) {
    const now = new Date();
    let filteredData = data;

    if (activeFilter === '1hour') {
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        filteredData = data.filter(record => parseServerTimestamp(record.timestamp) >= oneHourAgo);
    } else if (activeFilter === '24hours') {
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        filteredData = data.filter(record => parseServerTimestamp(record.timestamp) >= oneDayAgo);
    } else if (activeFilter === '7days') {
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        filteredData = data.filter(record => parseServerTimestamp(record.timestamp) >= sevenDaysAgo);
    } else if (activeFilter === 'custom') {
        const startDate = new Date(document.getElementById('startDate').value);
        const endDate = new Date(document.getElementById('endDate').value);
        filteredData = data.filter(record => {
            const recordDate = parseServerTimestamp(record.timestamp);
            return recordDate >= startDate && recordDate <= endDate;
        });
    }

    return filteredData;
}


function updateMqChart(filteredMqData) {
    // Chart-specific time filtering (chartTimeFilter overrides UI timeFilter when set)
    const maxDataPoints = parseInt(document.getElementById('maxDataPoints').value, 10) || 50;
    let chartFiltered = filteredMqData.slice();
    const chartFilterEl = document.getElementById('chartTimeFilter');
    const ctf = chartFilterEl ? chartFilterEl.value : 'inherit';
    if (ctf && ctf !== 'inherit') {
        const now = new Date();
        let start = null;
        let end = now;
        if (ctf === 'custom') {
            const s = document.getElementById('chartStartDate').value;
            const e = document.getElementById('chartEndDate').value;
            start = s ? new Date(s) : null;
            end = e ? new Date(e) : now;
        } else if (ctf === '1hour') {
            start = new Date(end.getTime() - 60 * 60 * 1000);
        } else if (ctf === '24hours') {
            start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
        } else if (ctf === '7days') {
            start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        }
        if (start) {
            chartFiltered = chartFiltered.filter(rec => {
                const t = parseServerTimestamp(rec.timestamp);
                return t && !isNaN(t.getTime()) && t >= start && t <= end;
            });
        }
    }

    const sortedData = chartFiltered.sort((a, b) => parseServerTimestamp(b.timestamp) - parseServerTimestamp(a.timestamp));
    const limitedData = sortedData.slice(0, maxDataPoints).reverse(); // Get the latest points in chronological order

    const timestamps = limitedData.map(record => parseServerTimestamp(record.timestamp));
    mqChart.data.labels = timestamps;

    function labelToKey(label) {
        const lower = label.toLowerCase();
        if (lower === 'temperature') return 'temperature';
        if (lower === 'humidity') return 'humidity';
        return label.replace(/ /g, '_');
    }

    mqChart.data.datasets.forEach((dataset) => {
        const key = labelToKey(dataset.label);
        dataset.data = limitedData.map(record => {
            // tolerate different key casings
            if (record[key] !== undefined) return record[key];
            // try lowercase key
            const lk = key.toLowerCase();
            if (record[lk] !== undefined) return record[lk];
            return null;
        });
    });

    // Expose the limited data for quick console inspection in the browser
    // (debug logging removed)

    mqChart.update();
}

// Build parameter toggle controls dynamically from the chart datasets
function buildParameterControls() {
    const container = document.getElementById('param-checkbox-list');
    if (!container) return;
    container.innerHTML = '';

    mqChart.data.datasets.forEach((ds, idx) => {
        const id = `param-toggle-${idx}`;
        const storageKey = `mq_param_${String(ds.label).replace(/\s+/g,'_').toLowerCase()}`;
        const wrapper = document.createElement('div');
        wrapper.className = 'form-check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'form-check-input';
        input.id = id;
        // load saved state from localStorage when available
        try {
            const stored = localStorage.getItem(storageKey);
            if (stored !== null) {
                input.checked = (stored === 'true');
                ds.hidden = !input.checked;
            } else {
                input.checked = !(ds.hidden === true);
            }
        } catch (e) {
            input.checked = !(ds.hidden === true);
        }
        const label = document.createElement('label');
        label.className = 'form-check-label';
        label.htmlFor = id;
        label.innerText = ds.label;

        input.addEventListener('change', () => {
            ds.hidden = !input.checked;
            try { localStorage.setItem(storageKey, String(input.checked)); } catch (e) { /* ignore */ }
            mqChart.update();
        });

        wrapper.appendChild(input);
        wrapper.appendChild(label);
        container.appendChild(wrapper);
    });

    // select / deselect buttons
    const selectAll = document.getElementById('select-all-params');
    const deselectAll = document.getElementById('deselect-all-params');
    if (selectAll) {
        selectAll.addEventListener('click', (e) => {
            e.preventDefault();
            mqChart.data.datasets.forEach((ds, idx) => {
                ds.hidden = false;
                const cb = document.getElementById(`param-toggle-${idx}`);
                if (cb) cb.checked = true;
                try { localStorage.setItem(`mq_param_${String(ds.label).replace(/\s+/g,'_').toLowerCase()}`, 'true'); } catch(e) {}
            });
            mqChart.update();
        });
    }
    if (deselectAll) {
        deselectAll.addEventListener('click', (e) => {
            e.preventDefault();
            mqChart.data.datasets.forEach((ds, idx) => {
                ds.hidden = true;
                const cb = document.getElementById(`param-toggle-${idx}`);
                if (cb) cb.checked = false;
                try { localStorage.setItem(`mq_param_${String(ds.label).replace(/\s+/g,'_').toLowerCase()}`, 'false'); } catch(e) {}
            });
            mqChart.update();
        });
    }
}

document.getElementById('applyFilter').addEventListener('click', () => {
    const timeFilter = document.getElementById('timeFilter').value;
    const maxDataPoints = parseInt(document.getElementById('maxDataPoints').value, 10) || 50;
    let startDate = null;
    let endDate = new Date(); // Default to now

    if (timeFilter === 'custom') {
        startDate = new Date(document.getElementById('startDate').value);
        endDate = new Date(document.getElementById('endDate').value);
    } else if (timeFilter === '1hour') {
        startDate = new Date(endDate.getTime() - 60 * 60 * 1000);
    } else if (timeFilter === '24hours') {
        startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
    } else if (timeFilter === '7days') {
        startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Filter the global mqData variable
    const filteredData = mqData.filter(record => {
            const timestamp = parseServerTimestamp(record.timestamp);
                return (!startDate || timestamp >= startDate) && timestamp <= endDate;
    });

    // Limit the data to maxDataPoints
    const limitedData = filteredData.slice(-maxDataPoints);

    // Update the chart
    updateMqChart(limitedData);

    // Close the modal
    const modal = bootstrap.Modal.getInstance(document.getElementById('filterModal'));
    modal.hide();
});

// Event listener for resetting the filter
document.getElementById('resetFilter').addEventListener('click', () => {
    document.getElementById('timeFilter').value = '24hours';
    document.getElementById('startDate').value = '';
    document.getElementById('endDate').value = '';
    document.getElementById('maxDataPoints').value = 50;

    // Reload the latest 50 data points
    const latestData = mqData.slice(-50);
    updateMqChart(latestData);
});

// Reset filter logic
document.getElementById('resetFilter').addEventListener('click', () => {
    document.getElementById('timeFilter').value = '24hours';
    document.getElementById('startDate').value = '';
    document.getElementById('endDate').value = '';
    document.getElementById('maxDataPoints').value = 50;

    // Reload the latest 50 data points
    const latestData = mqData.slice(-50);
    updateMqChart(latestData);
});


function renderMqTablePage(data, page) {
    // Use DataTables: build rows array and populate table. Data should be sorted newest-first
    if (!mqDataTable) return; // not initialized yet

    const sorted = data.slice().sort((a, b) => parseServerTimestamp(b.timestamp) - parseServerTimestamp(a.timestamp));
    const rows = [];
    for (let i = 0; i < sorted.length; i++) {
        const record = sorted[i];
        const prev = (i + 1 < sorted.length) ? sorted[i + 1] : null; // previous in time
        const cells = [];
        // Timestamp (ISO for lookup, but display localized)
        const ts = parseServerTimestamp(record.timestamp);
        cells.push(ts && !isNaN(ts.getTime()) ? ts.toLocaleString() : (record.timestamp || ''));
        // temperature, humidity
        cells.push((record.temperature !== null && record.temperature !== undefined) ? Number(record.temperature).toFixed(3) + ' ' + deltaHtml(record.temperature, prev ? prev.temperature : null) : 'N/A');
        cells.push((record.humidity !== null && record.humidity !== undefined) ? Number(record.humidity).toFixed(3) + ' ' + deltaHtml(record.humidity, prev ? prev.humidity : null) : 'N/A');
        // MQ sensors
        const keys = ['LPG','CO','Smoke','CO_MQ7','CH4','CO_MQ9','CO2','NH3','NOx','Alcohol','Benzene','H2','Air'];
        keys.forEach(k => {
            const v = (record[k] !== null && record[k] !== undefined) ? Number(record[k]).toFixed(3) : 'N/A';
            const prevV = prev ? (prev[k] !== undefined ? prev[k] : null) : null;
            cells.push((v === 'N/A') ? 'N/A' : (v + ' ' + deltaHtml(record[k], prevV)));
        });
        // append sd_aqi visible column, then uuid as hidden column
            const sdCell = (record.sd_aqi !== undefined && record.sd_aqi !== null) ? Number(record.sd_aqi).toFixed(3) : (record.SD_AQI !== undefined && record.SD_AQI !== null ? Number(record.SD_AQI).toFixed(3) : 'N/A');
            cells.splice(3, 0, sdCell); // insert SD_AQI column after Temperature & Humidity (index 3)
        cells.push(record.uuid || '');
        rows.push(cells);
    }

    // populate datatable
    mqDataTable.clear();
    if (rows.length > 0) mqDataTable.rows.add(rows);
    mqDataTable.draw(false);
    // Adjust container height to fit the visible rows on the current page
    try {
        const visibleRows = Math.min(rows.length, mqRecordsPerPage);
        adjustTableHeight(visibleRows);
    } catch (e) { /* ignore */ }
}

// Update DataTable or fallback to manual table population
function updateMqDataTable(data) {
    // If DataTable is initialized, let renderMqTablePage handle it
    if (mqDataTable) {
        renderMqTablePage(data, 1);
        return;
    }

    // Fallback: populate tbody so the user sees rows before DataTable init
    const tableBody = document.getElementById('mq-data-table-body');
    if (!tableBody) return;
    tableBody.innerHTML = '';
    const sorted = data.slice().sort((a, b) => parseServerTimestamp(b.timestamp) - parseServerTimestamp(a.timestamp));
    sorted.forEach((record, i) => {
        const prev = (i + 1 < sorted.length) ? sorted[i + 1] : null;
        const row = document.createElement('tr');
        const sdCell = (record.sd_aqi !== undefined && record.sd_aqi !== null) ? Number(record.sd_aqi).toFixed(3) : (record.SD_AQI !== undefined && record.SD_AQI !== null ? Number(record.SD_AQI).toFixed(3) : 'N/A');
        const ts = parseServerTimestamp(record.timestamp);
        row.innerHTML = `
            <td>${ts && !isNaN(ts.getTime()) ? ts.toLocaleString() : (record.timestamp || '')}</td>
            <td>${record.temperature !== null && record.temperature !== undefined ? Number(record.temperature).toFixed(3) + ' ' + deltaHtml(record.temperature, prev ? prev.temperature : null) : 'N/A'}</td>
            <td>${record.humidity !== null && record.humidity !== undefined ? Number(record.humidity).toFixed(3) + ' ' + deltaHtml(record.humidity, prev ? prev.humidity : null) : 'N/A'}</td>
            <td>${sdCell}</td>
            <td>${record.LPG !== null && record.LPG !== undefined ? Number(record.LPG).toFixed(3) + ' ' + deltaHtml(record.LPG, prev ? prev.LPG : null) : 'N/A'}</td>
            <td>${record.CO !== null && record.CO !== undefined ? Number(record.CO).toFixed(3) + ' ' + deltaHtml(record.CO, prev ? prev.CO : null) : 'N/A'}</td>
            <td>${record.Smoke !== null && record.Smoke !== undefined ? Number(record.Smoke).toFixed(3) + ' ' + deltaHtml(record.Smoke, prev ? prev.Smoke : null) : 'N/A'}</td>
            <td>${record.CO_MQ7 !== null && record.CO_MQ7 !== undefined ? Number(record.CO_MQ7).toFixed(3) + ' ' + deltaHtml(record.CO_MQ7, prev ? prev.CO_MQ7 : null) : 'N/A'}</td>
            <td>${record.CH4 !== null && record.CH4 !== undefined ? Number(record.CH4).toFixed(3) + ' ' + deltaHtml(record.CH4, prev ? prev.CH4 : null) : 'N/A'}</td>
            <td>${record.CO_MQ9 !== null && record.CO_MQ9 !== undefined ? Number(record.CO_MQ9).toFixed(3) + ' ' + deltaHtml(record.CO_MQ9, prev ? prev.CO_MQ9 : null) : 'N/A'}</td>
            <td>${record.CO2 !== null && record.CO2 !== undefined ? Number(record.CO2).toFixed(3) + ' ' + deltaHtml(record.CO2, prev ? prev.CO2 : null) : 'N/A'}</td>
            <td>${record.NH3 !== null && record.NH3 !== undefined ? Number(record.NH3).toFixed(3) + ' ' + deltaHtml(record.NH3, prev ? prev.NH3 : null) : 'N/A'}</td>
            <td>${record.NOx !== null && record.NOx !== undefined ? Number(record.NOx).toFixed(3) + ' ' + deltaHtml(record.NOx, prev ? prev.NOx : null) : 'N/A'}</td>
            <td>${record.Alcohol !== null && record.Alcohol !== undefined ? Number(record.Alcohol).toFixed(3) + ' ' + deltaHtml(record.Alcohol, prev ? prev.Alcohol : null) : 'N/A'}</td>
            <td>${record.Benzene !== null && record.Benzene !== undefined ? Number(record.Benzene).toFixed(3) + ' ' + deltaHtml(record.Benzene, prev ? prev.Benzene : null) : 'N/A'}</td>
            <td>${record.H2 !== null && record.H2 !== undefined ? Number(record.H2).toFixed(3) + ' ' + deltaHtml(record.H2, prev ? prev.H2 : null) : 'N/A'}</td>
            <td>${record.Air !== null && record.Air !== undefined ? Number(record.Air).toFixed(3) + ' ' + deltaHtml(record.Air, prev ? prev.Air : null) : 'N/A'}</td>
            <td class="d-none">${record.uuid || ''}</td>
        `;
        row.addEventListener('click', () => showDetails(record));
        tableBody.appendChild(row);
    });
    // Adjust container height to fit the number of rows we just populated
    try {
        adjustTableHeight(sorted.length);
    } catch (e) { /* ignore */ }
}

function renderMqPaginationControls(data) {
    const paginationControls = document.getElementById('mq-pagination-controls');
    const totalPages = Math.ceil(data.length / mqRecordsPerPage);

    if (!document.getElementById('mq-prev-button')) {
        const prevButton = document.createElement('button');
        prevButton.id = 'mq-prev-button';
        prevButton.innerText = 'Previous';
        paginationControls.appendChild(prevButton);
    }

    if (!document.getElementById('mq-next-button')) {
        const nextButton = document.createElement('button');
        nextButton.id = 'mq-next-button';
        nextButton.innerText = 'Next';
        paginationControls.appendChild(nextButton);
    }

    // Check if the dropdown already exists
    let pageSelect = document.getElementById('mq-page-select');
    if (!pageSelect) {
        // Create "Previous" button if it doesn't exist
        if (!document.getElementById('mq-prev-button')) {
            const prevButton = document.createElement('button');
            prevButton.id = 'mq-prev-button';
            prevButton.innerText = 'Previous';
            prevButton.classList.add('btn', 'btn-primary', 'me-2');
            prevButton.addEventListener('click', () => {
                if (mqCurrentPage > 1) {
                    mqCurrentPage--;
                    renderMqTablePage(data, mqCurrentPage);
                }
            });
            paginationControls.appendChild(prevButton);
        }

        // Create the dropdown
        pageSelect = document.createElement('select');
        pageSelect.id = 'mq-page-select';
        pageSelect.classList.add('form-select', 'd-inline-block', 'w-auto', 'me-2');
        pageSelect.addEventListener('change', (event) => {
            mqCurrentPage = parseInt(event.target.value, 10);
            renderMqTablePage(data, mqCurrentPage);
        });
        paginationControls.appendChild(pageSelect);

        // Create "Next" button if it doesn't exist
        if (!document.getElementById('mq-next-button')) {
            const nextButton = document.createElement('button');
            nextButton.id = 'mq-next-button';
            nextButton.innerText = 'Next';
            nextButton.classList.add('btn', 'btn-primary');
            nextButton.addEventListener('click', () => {
                if (mqCurrentPage < totalPages) {
                    mqCurrentPage++;
                    renderMqTablePage(data, mqCurrentPage);
                }
            });
            paginationControls.appendChild(nextButton);
        }
    }

    // Update the dropdown options if the total pages have changed
    if (pageSelect.options.length !== totalPages) {
        pageSelect.innerHTML = ''; // Clear existing options
        for (let i = 1; i <= totalPages; i++) {
            const option = document.createElement('option');
            option.value = i;
            option.text = `Page ${i}`;
            if (i === mqCurrentPage) {
                option.selected = true;
            }
            pageSelect.appendChild(option);
        }
    } else {
        // Ensure the current page is selected
        pageSelect.value = mqCurrentPage;
    }
}

function showDetails(record) {
    const modal = new bootstrap.Modal(document.getElementById('detailsModal'));

    // Populate modal details
    document.getElementById('modal-timestamp').innerText = parseServerTimestamp(record.timestamp).toLocaleString();
    document.getElementById('modal-temperature').innerText = record.temperature !== null ? record.temperature.toFixed(3) : 'N/A';
    document.getElementById('modal-humidity').innerText = record.humidity !== null ? record.humidity.toFixed(3) : 'N/A';
    document.getElementById('modal-lpg').innerText = record.LPG !== null ? record.LPG.toFixed(3) : 'N/A';
    document.getElementById('modal-co').innerText = record.CO !== null ? record.CO.toFixed(3) : 'N/A';
    document.getElementById('modal-smoke').innerText = record.Smoke !== null ? record.Smoke.toFixed(3) : 'N/A';
    document.getElementById('modal-co-mq7').innerText = record.CO_MQ7 !== null ? record.CO_MQ7.toFixed(3) : 'N/A';
    document.getElementById('modal-ch4').innerText = record.CH4 !== null ? record.CH4.toFixed(3) : 'N/A';
    document.getElementById('modal-co-mq9').innerText = record.CO_MQ9 !== null ? record.CO_MQ9.toFixed(3) : 'N/A';
    document.getElementById('modal-co2').innerText = record.CO2 !== null ? record.CO2.toFixed(3) : 'N/A';
    document.getElementById('modal-nh3').innerText = record.NH3 !== null ? record.NH3.toFixed(3) : 'N/A';
    document.getElementById('modal-nox').innerText = record.NOx !== null ? record.NOx.toFixed(3) : 'N/A';
    document.getElementById('modal-alcohol').innerText = record.Alcohol !== null ? record.Alcohol.toFixed(3) : 'N/A';
    document.getElementById('modal-benzene').innerText = record.Benzene !== null ? record.Benzene.toFixed(3) : 'N/A';
    document.getElementById('modal-h2').innerText = record.H2 !== null ? record.H2.toFixed(3) : 'N/A';
    document.getElementById('modal-air').innerText = record.Air !== null ? record.Air.toFixed(3) : 'N/A';

    // SD_AQI fields (tolerate different casings)
    const sdVal = (record.sd_aqi !== undefined) ? record.sd_aqi : (record.SD_AQI !== undefined ? record.SD_AQI : null);
    document.getElementById('modal-sd-aqi').innerText = sdVal !== null ? Number(sdVal).toFixed(3) : 'N/A';
    const sdLevel = record.sd_aqi_level || record.SD_AQI_level || record.sdAqiLevel || 'N/A';
    document.getElementById('modal-sd-aqi-level').innerText = sdLevel;

    // Show the modal
    modal.show();
}


// Removed immediate polling startup here. Startup and seeding is
// handled during DOMContentLoaded so we can fetch initial history first.

// Initialize DataTable once DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    try {
        mqDataTable = $('#mq-data-table').DataTable({
            paging: true,
            pageLength: mqRecordsPerPage,
            searching: false,
            info: false,
            order: [[0, 'desc']],
            // 17 visible columns + 1 hidden uuid column
            columns: Array.from({length: 18}, () => ({ searchable: false })),
            columnDefs: [
                { targets: 17, visible: false } // hide the uuid column
            ]
        });

        // Row click handler to show details for selected row using uuid (stable)
        $('#mq-data-table tbody').on('click', 'tr', function () {
            const row = mqDataTable.row(this);
            const rowData = row.data();
            if (!rowData) return;
            const uuid = rowData[17]; // hidden uuid column
            if (!uuid) return;
            const rec = lastFilteredData.find(r => r.uuid === uuid);
            if (rec) showDetails(rec);
        });
    } catch (err) {
        console.warn('DataTable init failed:', err);
    }
    // initialize polling controls
    const pollToggle = document.getElementById('poll-toggle');
    const pollIntervalInput = document.getElementById('poll-interval');
    const lastUpdatedEl = document.getElementById('last-updated');

    function startPolling() {
        stopPolling();
        pollTimerId = setInterval(fetchMqData, pollIntervalMs);
        isPolling = true;
        if (pollToggle) { pollToggle.innerText = 'Pause'; pollToggle.classList.remove('btn-primary'); pollToggle.classList.add('btn-success'); }
    }
    function stopPolling() {
        if (pollTimerId) { clearInterval(pollTimerId); pollTimerId = null; }
        isPolling = false;
        if (pollToggle) { pollToggle.innerText = 'Resume'; pollToggle.classList.remove('btn-success'); pollToggle.classList.add('btn-primary'); }
    }

    if (pollToggle) {
        pollToggle.addEventListener('click', () => {
            if (isPolling) stopPolling(); else startPolling();
        });
    }
    if (pollIntervalInput) {
        pollIntervalInput.addEventListener('change', (e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 200) {
                pollIntervalMs = v;
                if (isPolling) startPolling();
            }
        });
    }

    // Manual refresh/debug button: force immediate fetch
    const refreshBtn = document.getElementById('refresh-now');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async (e) => {
            try {
                refreshBtn.disabled = true;
                const old = refreshBtn.innerText;
                refreshBtn.innerText = 'Refreshing...';
                await fetchMqData();
                // short visual confirmation
                refreshBtn.innerText = 'Done';
                setTimeout(() => { refreshBtn.innerText = old; refreshBtn.disabled = false; }, 800);
            } catch (err) {
                console.warn('Refresh Now failed', err);
                refreshBtn.disabled = false;
                refreshBtn.innerText = 'Refresh Now';
            }
        });
    }

    // Copy last received raw payload to clipboard
    try {
        const copyBtn = document.getElementById('copy-last-mq');
        if (copyBtn) {
            copyBtn.addEventListener('click', async (e) => {
                const pre = document.getElementById('last-mq-recv');
                if (!pre || !pre.innerText || pre.innerText.trim() === '(no data)') {
                    showToast('No last data to copy', 'warning');
                    return;
                }
                try {
                    await navigator.clipboard.writeText(pre.innerText);
                    showToast('Copied last received JSON', 'success');
                } catch (err) {
                    // Fallback for older browsers: textarea + execCommand
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = pre.innerText;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        showToast('Copied last received JSON', 'success');
                    } catch (err2) {
                        showToast('Copy failed', 'danger');
                    }
                }
            });
        }
    } catch (e) { /* ignore copy button wiring failures */ }

    // build dynamic parameter controls for chart datasets
    try { buildParameterControls(); } catch (e) { console.warn('buildParameterControls error', e); }

    // Seed initial history from /api/mq-data?history=1 so the dashboard
    // is driven entirely by the same endpoint used for polling.
    async function seedHistory() {
        try {
            const resp = await fetch('/api/mq-data?history=1');
            const result = await resp.json();
            if (result && Array.isArray(result.mq_data) && result.mq_data.length > 0) {
                // Use the array returned by /api/mq-data?history=1 as the canonical history
                mqData = result.mq_data.slice();
                // set server-now baseline if provided
                if (result.server_now) {
                    lastServerNowIso = result.server_now;
                    lastServerNowFetchAt = Date.now();
                }
                // apply current filter and render UI once
                const filtered = filterDataByCriteria(mqData);
                const used = (filtered && filtered.length > 0) ? filtered : (mqData && mqData.length > 0 ? mqData.slice() : []);
                const sortedFiltered = used.slice().sort((a, b) => parseServerTimestamp(b.timestamp) - parseServerTimestamp(a.timestamp));
                lastFilteredData = sortedFiltered.slice();
                if (sortedFiltered.length > 0) {
                    const latest = sortedFiltered[0];
                    const prev = sortedFiltered.length > 1 ? sortedFiltered[1] : null;
                    renderMqSummary(latest, prev);
                }
                updateMqChart(sortedFiltered);
                updateMqDataTable(sortedFiltered);
                computeAndRenderAnalysis(sortedFiltered);
            }
        } catch (e) {
            console.warn('seedHistory failed', e);
        }
    }

    // start polling according to initial interval
    pollIntervalInput.value = pollIntervalMs;
    await seedHistory();
    startPolling();

    // Start a lightweight ticker to update the server clock display every second
    // This advances the last seen `server_now` reported by the API so the UI
    // shows a live clock even if the API does not return a fresh `server_now`
    // on every fetch.
    setInterval(() => {
        try {
            const el = document.getElementById('server-latest-ts');
            if (!el) return;
            // Advance server time by elapsed ms since we last received it, if available
            let serverNowDisp = null;
            if (lastServerNowIso) {
                try {
                    const base = parseServerTimestamp(lastServerNowIso);
                    if (!isNaN(base.getTime()) && lastServerNowFetchAt) {
                        const advanced = new Date(base.getTime() + (Date.now() - lastServerNowFetchAt));
                        serverNowDisp = advanced.toLocaleString();
                    } else if (!isNaN(base.getTime())) {
                        serverNowDisp = base.toLocaleString();
                    }
                } catch (e) { serverNowDisp = parseServerTimestamp(lastServerNowIso).toLocaleString(); }
            }
            const latestDisp = (lastFilteredData && lastFilteredData.length > 0 && lastFilteredData[0].timestamp) ? parseServerTimestamp(lastFilteredData[0].timestamp).toLocaleString() : null;
            const localDisp = new Date().toLocaleString();
            // show with timezone name
            const tzOpts = { timeZone: 'Europe/Athens', timeZoneName: 'short' };
            const serverPretty = serverNowDisp ? new Date(serverNowDisp).toLocaleString(undefined, tzOpts) : null;
            const latestPretty = latestDisp ? new Date(latestDisp).toLocaleString(undefined, tzOpts) : null;
            const localPretty = new Date().toLocaleString(undefined, tzOpts);
            if (serverPretty && latestPretty) el.innerText = `Server: ${serverPretty} (latest data: ${latestPretty}) | Local: ${localPretty}`;
            else if (serverPretty) el.innerText = `Server: ${serverPretty} | Local: ${localPretty}`;
            else if (latestPretty) el.innerText = `Server: ${latestPretty} | Local: ${localPretty}`;
            else el.innerText = `Local: ${localPretty}`;
        } catch (e) { /* ignore ticker errors */ }
    }, 1000);

    // expose helper to update last-updated stamp
    window.__updateLastUpdated = (ts) => { if (lastUpdatedEl) lastUpdatedEl.innerText = ts; };
});

// Compute and render analysis cards
function computeAndRenderAnalysis(data) {
    const container = document.getElementById('analysis-container');
    if (!container) return;
    // For a small set of keys produce stats: last, avg, min, max
    const keys = ['Temperature','Humidity','LPG','CO','Smoke','CO2','NH3','NOx','Alcohol','Benzene','SD_AQI'];
    // compute over last N points (default 50)
    const N = Math.min(data.length, 50);
    const recent = data.slice(0, N);
    container.innerHTML = '';
    keys.forEach(k => {
        const values = recent.map(r => {
            // tolerate casing
            if (r[k] !== undefined) return Number(r[k]);
            const lk = k.toLowerCase();
            if (r[lk] !== undefined) return Number(r[lk]);
            return null;
        }).filter(v => v !== null && !isNaN(v));
        let last = values.length ? values[0] : null;
        let avg = values.length ? (values.reduce((s,x)=>s+x,0)/values.length) : null;
        let min = values.length ? Math.min(...values) : null;
        let max = values.length ? Math.max(...values) : null;
        const card = document.createElement('div');
        card.className = 'col-6 col-md-4';
        card.innerHTML = `
            <div class="card small">
                <div class="card-body p-2">
                    <div class="d-flex justify-content-between align-items-center">
                        <div><strong>${k}</strong></div>
                        <div class="text-end"><div class="fw-bold">${last!==null?Number(last).toFixed(3):'—'}</div><div class="small text-muted">last</div></div>
                    </div>
                    <div class="mt-2 small text-muted">Avg: ${avg!==null?Number(avg).toFixed(3):'—'} • Min: ${min!==null?Number(min).toFixed(3):'—'} • Max: ${max!==null?Number(max).toFixed(3):'—'}</div>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

// Minimal toast helper: floating message that auto dismisses
function showToast(message, type) {
    try {
        const toastId = 'mq-toast-' + Date.now();
        const el = document.createElement('div');
        el.id = toastId;
        el.style.position = 'fixed';
        el.style.right = '20px';
        el.style.top = '20px';
        el.style.zIndex = 2000;
        el.style.minWidth = '220px';
        el.style.padding = '10px 14px';
        el.style.borderRadius = '6px';
        el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
        el.style.color = '#fff';
        el.style.fontSize = '13px';
        el.style.opacity = '0';
        el.style.transition = 'opacity 240ms ease, transform 240ms ease';
        if (type === 'success') el.style.background = '#28a745';
        else if (type === 'danger') el.style.background = '#dc3545';
        else if (type === 'warning') el.style.background = '#ffc107';
        else el.style.background = '#007bff';
        el.innerText = message;
        document.body.appendChild(el);
        // animate in
        requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
        // auto remove after 4s
        setTimeout(() => {
            try { el.style.opacity = '0'; el.style.transform = 'translateY(-6px)'; } catch (e) {}
            setTimeout(() => { try { document.body.removeChild(el); } catch (e) {} }, 300);
        }, 4000);
    } catch (e) { console.warn('showToast error', e); }
}

// Update the 'Last received (raw)' UI panel with pretty-printed JSON
function updateLastReceivedUI(latestRec, serverNow, usingFallback) {
    try {
        const el = document.getElementById('last-mq-recv');
        if (!el) return;
        if (!latestRec) {
            el.innerText = '(no data)';
            return;
        }
        // Build a small header with server time / fallback hint then pretty JSON
        const hdr = [];
        if (serverNow) {
            try { hdr.push(`server_now: ${parseServerTimestamp(serverNow).toLocaleString()}`); } catch (e) { hdr.push(`server_now: ${String(serverNow)}`); }
        }
        if (usingFallback) hdr.push('(using fallback latest)');
        const headerLine = hdr.length ? hdr.join(' ') + '\n\n' : '';
        // Pretty-print but tolerate circular structures (unlikely)
        let body = '';
        try { body = JSON.stringify(latestRec, null, 2); } catch (e) { body = String(latestRec); }
        el.innerText = headerLine + body;
    } catch (e) { console.debug('updateLastReceivedUI error', e); }
}

// -------------------------
// XBee debug UI helpers
// -------------------------
let xbeeAutoRefreshTimer = null;
async function fetchXbeeStatus() {
    try {
        const res = await fetch('/_debug/xbee-status');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        // Update port/baud
        try { document.getElementById('xbee-port').innerText = j.port || '-'; } catch (e) {}
        try { document.getElementById('xbee-baud').innerText = j.baud || '-'; } catch (e) {}
        try { document.getElementById('xbee-last-update').innerText = (new Date()).toLocaleString(); } catch (e) {}
        // recent_raw may be an array of strings
        const recent = Array.isArray(j.recent_raw) ? j.recent_raw : [];
        const list = document.getElementById('xbee-recent-list');
        if (!list) return;
        list.innerHTML = '';
        if (recent.length === 0) {
            const li = document.createElement('li');
            li.className = 'list-group-item';
            li.innerText = '(no recent messages)';
            list.appendChild(li);
            return;
        }
        // Show newest-first to be consistent with other UI parts
        for (let i = recent.length - 1; i >= 0; i--) {
            const item = recent[i];
            const li = document.createElement('li');
            li.className = 'list-group-item';
            // sanitize and show as monospace text
            li.innerText = String(item);
            list.appendChild(li);
        }
    } catch (err) {
        console.warn('fetchXbeeStatus failed', err);
        const list = document.getElementById('xbee-recent-list');
        if (list) {
            list.innerHTML = '';
            const li = document.createElement('li');
            li.className = 'list-group-item text-danger';
            li.innerText = 'Failed to contact /_debug/xbee-status: ' + err.message;
            list.appendChild(li);
        }
    }
}

// Wire modal events and buttons when DOM ready
document.addEventListener('DOMContentLoaded', () => {
    try {
        const xbeeModalEl = document.getElementById('xbeeDebugModal');
        if (xbeeModalEl) {
            xbeeModalEl.addEventListener('show.bs.modal', (e) => {
                // fetch once on show
                fetchXbeeStatus();
            });
            xbeeModalEl.addEventListener('shown.bs.modal', (e) => {
                // start auto-refresh if checkbox is checked
                const auto = document.getElementById('xbee-auto-refresh');
                if (auto && auto.checked) {
                    if (xbeeAutoRefreshTimer) clearInterval(xbeeAutoRefreshTimer);
                    xbeeAutoRefreshTimer = setInterval(fetchXbeeStatus, 1500);
                }
            });
            xbeeModalEl.addEventListener('hide.bs.modal', (e) => {
                if (xbeeAutoRefreshTimer) { clearInterval(xbeeAutoRefreshTimer); xbeeAutoRefreshTimer = null; }
            });
        }

        const refreshBtn = document.getElementById('xbee-refresh-btn');
        if (refreshBtn) refreshBtn.addEventListener('click', (e) => { fetchXbeeStatus(); });

        const clearBtn = document.getElementById('xbee-clear-btn');
        if (clearBtn) clearBtn.addEventListener('click', (e) => { const list = document.getElementById('xbee-recent-list'); if (list) list.innerHTML = ''; document.getElementById('xbee-last-update').innerText = '-'; });

        const autoCb = document.getElementById('xbee-auto-refresh');
        if (autoCb) {
            autoCb.addEventListener('change', (e) => {
                if (e.target.checked) {
                    if (xbeeAutoRefreshTimer) clearInterval(xbeeAutoRefreshTimer);
                    xbeeAutoRefreshTimer = setInterval(fetchXbeeStatus, 1500);
                } else {
                    if (xbeeAutoRefreshTimer) { clearInterval(xbeeAutoRefreshTimer); xbeeAutoRefreshTimer = null; }
                }
            });
        }
    } catch (e) { console.warn('xbee debug init failed', e); }
});
