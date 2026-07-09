const SK_WS_PROTO = window.location.protocol === "https:" ? "wss" : "ws";
const SK_WS_URL = `${SK_WS_PROTO}://${window.location.hostname}:${window.location.port}/signalk/v1/stream?subscribe=none`;

let uplot;
let chartData = [
    [], // time
    [], // raw TWD
    [], // smooth TWD
    [], // min TWD
    [], // max TWD
    [], // boat average (reference line on station views)
    [], // wind speed (kn)
    [], // gust (kn)
];

// Which source the dashboard is looking at: "boat" or a ViVa station slug.
// All sources are analyzed server-side the whole time; this only selects
// which one is displayed.
let currentSource = "boat";

const windshiftPrefix = (src) =>
    src === "boat" ? "environment.wind.windshift." : `environment.observations.viva.${src}.windshift.`;
const rawPath = (src) =>
    src === "boat" ? "environment.wind.directionTrue" : `environment.observations.viva.${src}.wind.directionTrue`;

// Speed/gust paths are normally computable from the source id, but when the
// boat's TWD source is a shore station the server tells us the real paths.
let sourcePaths = new Map(); // id -> { speedPath, gustPath }
const speedPath = (src) =>
    (sourcePaths.get(src) || {}).speedPath ||
    (src === "boat" ? "environment.wind.speedTrue" : `environment.observations.viva.${src}.wind.averageSpeed`);
const gustPath = (src) =>
    (sourcePaths.get(src) || {}).gustPath ||
    (src === "boat" ? "environment.wind.gust" : `environment.observations.viva.${src}.wind.gust`);

const MS_TO_KN = 1.94384;

// Chart data is stored unwrapped (may drift outside 0-360), so fold the
// cursor readout back into compass degrees
const degreeValue = (u, v) => v == null ? "--" : (((v * 180 / Math.PI) % 360 + 360) % 360).toFixed(1) + "°";

function initChart() {
    const container = document.getElementById('chart-container');
    const opts = {
        title: "Wind Direction (TWD)",
        width: container.offsetWidth,
        height: container.offsetHeight - 50,
        scales: {
            x: { time: true },
            y: { range: (self, min, max) => [min - 0.1, max + 0.1] },
            speed: { range: (self, min, max) => [0, Math.max(max * 1.2, 20 / MS_TO_KN)] }
        },
        series: [
            {
                label: "Time",
                value: (u, v) => v == null ? "--" : ((Date.now() / 1000 - v) / 60).toFixed(1) + " min ago",
            },
            {
                label: "Raw",
                stroke: "rgba(100, 100, 100, 0.5)",
                width: 1,
                value: degreeValue,
            },
            {
                label: "Average",
                stroke: "#4caf50",
                width: 3,
                value: degreeValue,
                spanGaps: true,
            },
            {
                label: "Min",
                stroke: "#ff9800",
                dash: [5, 5],
                width: 2,
                value: degreeValue,
                spanGaps: true,
            },
            {
                label: "Max",
                stroke: "#2196f3",
                dash: [5, 5],
                width: 2,
                value: degreeValue,
                spanGaps: true,
            },
            {
                label: "Boat avg",
                stroke: "#ba68c8",
                width: 2,
                value: degreeValue,
                spanGaps: true,
                show: false, // only shown on station views
            },
            {
                label: "Wind",
                scale: "speed",
                stroke: "#00bcd4",
                width: 2,
                value: (u, v) => v == null ? "--" : (v * MS_TO_KN).toFixed(1) + " kn",
                spanGaps: true,
            },
            {
                label: "Gust",
                scale: "speed",
                stroke: "#ff5722",
                width: 2,
                dash: [4, 4],
                value: (u, v) => v == null ? "--" : (v * MS_TO_KN).toFixed(1) + " kn",
                spanGaps: true,
            },
        ],
        axes: [
            {},
            {
                grid: { show: true, stroke: "#333" },
                ticks: { stroke: "#333" },
                values: (self, ticks) => ticks.map(v => {
                    const deg = ((v * 180 / Math.PI) % 360 + 360) % 360;
                    return deg.toFixed(0) + "°";
                })
            },
            {
                scale: "speed",
                side: 1,
                grid: { show: false },
                ticks: { stroke: "#555" },
                values: (self, ticks) => ticks.map(v => (v * MS_TO_KN).toFixed(0) + " kn"),
            }
        ],
        cursor: {
            drag: { x: true, y: false }
        },
        hooks: {
            setScale: [
                (u, key) => {
                    if (key !== "x") return;
                    const xData = u.data[0];
                    if (!xData || xData.length < 2) return;
                    const zoomed = u.scales.x.min > xData[0] + 1 ||
                                   u.scales.x.max < xData[xData.length - 1] - 1;
                    document.getElementById("reset-zoom").style.display = zoomed ? "block" : "none";
                }
            ]
        }
    };

    uplot = new uPlot(opts, chartData, container);

    document.getElementById("chart-container").addEventListener("dblclick", resetZoom);

    window.addEventListener("resize", () => {
        uplot.setSize({
            width: container.offsetWidth,
            height: container.offsetHeight - 50,
        });
    });
}

function connectSK() {
    const ws = new WebSocket(SK_WS_URL);

    ws.onopen = () => {
        console.log("Connected to SignalK");
        const subscription = {
            context: "vessels.self",
            subscribe: [
                { path: "environment.wind.directionTrue" },
                { path: "environment.wind.speedTrue" },
                { path: "environment.wind.gust" },
                { path: "environment.wind.windshift.*" },
                { path: "environment.observations.viva.*" }
            ]
        };
        ws.send(JSON.stringify(subscription));
    };

    ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.updates) {
            msg.updates.forEach(update => {
                const timestamp = new Date(update.timestamp).getTime() / 1000;
                update.values.forEach(val => {
                    handleValue(val.path, val.value, timestamp);
                });
            });
        }
    };

    ws.onclose = () => {
        console.log("Disconnected from SignalK, retrying...");
        setTimeout(connectSK, 2000);
    };
}

let latestRaw = null;
let latestSmooth = null;
let latestMin = null;
let latestMax = null;
let latestBoatAvg = null;
let latestSpeed = null; // rolling average of recent wind speeds (m/s)
let latestGust = null;
let speedBuffer = []; // raw samples driving the rolling average (m/s)

function showWind() {
    const spd = latestSpeed != null ? (latestSpeed * MS_TO_KN).toFixed(1) : "--";
    const gust = latestGust != null ? (latestGust * MS_TO_KN).toFixed(1) : "--";
    document.querySelector("#wind .value").innerText = `${spd} / ${gust} kn`;
}

function handleValue(path, value, timestamp) {
    // The boat's smoothed TWD is tracked regardless of the displayed source,
    // so station views can overlay it as a reference line
    if (path === "environment.wind.windshift.avg" && typeof value === "number") {
        latestBoatAvg = value;
    }

    if (path === speedPath(currentSource)) {
        if (typeof value !== "number") return;
        speedBuffer.push(value);
        if (speedBuffer.length > 120) speedBuffer.shift(); // ~2-min rolling window at 1 Hz
        latestSpeed = speedBuffer.reduce((a, b) => a + b, 0) / speedBuffer.length;
        showWind();
        return;
    }
    if (path === gustPath(currentSource)) {
        if (typeof value !== "number") return;
        latestGust = value;
        showWind();
        return;
    }

    if (path === rawPath(currentSource)) {
        if (typeof value !== "number") return;
        latestRaw = value;
        updateChart(timestamp);
        document.querySelector("#current-twd .value").innerText = (value * 180 / Math.PI).toFixed(0) + "°";
        return;
    }

    const prefix = windshiftPrefix(currentSource);
    if (!path.startsWith(prefix)) return;
    const metric = path.slice(prefix.length);

    if (metric === "avg") {
        latestSmooth = value;
        // If the displayed source has no raw TWD stream, the averaged value
        // has to drive the chart updates and the TWD readout instead
        if (latestRaw === null) {
            document.querySelector("#current-twd .value").innerText = (value * 180 / Math.PI).toFixed(0) + "°";
            updateChart(timestamp);
        }
    } else if (metric === "max") {
        latestMax = value;
    } else if (metric === "min") {
        latestMin = value;
    } else if (metric === "delta") {
        showDelta(value);
    } else if (metric === "trend") {
        showTrend(value);
    } else if (metric === "cyclePeriod") {
        showCyclePeriod(value);
    } else if (metric === "certainty") {
        showCertainty(value);
    } else if (metric === "timeToNextShift") {
        showNextShift(value);
    }
}

function showDelta(value) {
    document.querySelector("#delta-twd .value").innerText = (value * 180 / Math.PI).toFixed(1) + "°";
}

function showTrend(value) {
    const trendEl = document.querySelector("#trend .value");
    if (value === 1) {
        trendEl.innerText = "Veering ↗";
        trendEl.style.color = "#4caf50";
    } else if (value === -1) {
        trendEl.innerText = "Backing ↘";
        trendEl.style.color = "#f44336";
    } else {
        trendEl.innerText = "Steady";
        trendEl.style.color = "#fff";
    }
}

function showCyclePeriod(value) {
    document.querySelector("#cycle-period .value").innerText = (value / 60).toFixed(1) + "m";
}

function showCertainty(value) {
    document.querySelector(".gauge-bar").style.width = (value * 100) + "%";
}

function showNextShift(value) {
    const mins = Math.floor(value / 60);
    const secs = Math.floor(value % 60);
    document.querySelector("#next-shift .value").innerText = `${mins}:${secs.toString().padStart(2, '0')}`;
}

function resetZoom() {
    if (!uplot || chartData[0].length === 0) return;
    uplot.setScale("x", { min: chartData[0][0], max: chartData[0][chartData[0].length - 1] });
}

document.getElementById("reset-zoom").addEventListener("click", resetZoom);

// Fill the metrics bar from the plugin's latest snapshot so switching
// sources gives a full overview immediately instead of waiting up to a
// minute for the next live update
function loadLatest(src) {
    return fetch(`/plugins/windshift/latest?source=${encodeURIComponent(src)}`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
        .then(m => {
            if (!m) return;
            document.querySelector("#current-twd .value").innerText = (m.avgTWD * 180 / Math.PI).toFixed(0) + "°";
            showDelta(m.delta);
            showTrend(m.trend);
            showCyclePeriod(m.cyclePeriod);
            showCertainty(m.certainty);
            showNextShift(m.timeToNextShift);
        });
}

// Keep each series continuous across the 0/360 wrap so a northerly wind
// doesn't draw full-height vertical spikes. The previous point is the last
// non-null value, since merged series may contain gaps.
function unwrapForChart(seriesArr, v) {
    if (v == null) return v;
    let prev = null;
    for (let i = seriesArr.length - 1; i >= 0; i--) {
        if (seriesArr[i] != null) {
            prev = seriesArr[i];
            break;
        }
    }
    if (prev == null) return v;
    let u = v;
    while (u - prev > Math.PI) u -= 2 * Math.PI;
    while (u - prev < -Math.PI) u += 2 * Math.PI;
    return u;
}

function updateChart(timestamp) {
    // Throttle chart updates to at most one per second
    const lastTime = chartData[0][chartData[0].length - 1];
    if (lastTime && timestamp - lastTime < 1) return;

    chartData[0].push(timestamp);
    chartData[1].push(unwrapForChart(chartData[1], latestRaw));
    chartData[2].push(unwrapForChart(chartData[2], latestSmooth));
    chartData[3].push(unwrapForChart(chartData[3], latestMin));
    chartData[4].push(unwrapForChart(chartData[4], latestMax));
    chartData[5].push(currentSource === "boat" ? null : unwrapForChart(chartData[5], latestBoatAvg));
    chartData[6].push(latestSpeed != null ? latestSpeed : null);
    chartData[7].push(latestGust != null ? latestGust : null);

    // Keep roughly the last 30 minutes of data
    if (chartData[0].length > 1800) {
        chartData.forEach(arr => arr.shift());
    }

    if (uplot) uplot.setData(chartData);
}

function fetchHistory(src) {
    return fetch(`/plugins/windshift/history?source=${encodeURIComponent(src)}`)
        .then(r => (r.ok ? r.json() : []))
        .catch(() => []);
}

// Seed the chart from the plugin's server-side history so a page reload
// or a source switch doesn't start from an empty chart. On station views the
// boat's history is merged in as a reference series; the two histories have
// independent timestamps, so they interleave on a common time axis with
// gaps (spanGaps draws through them).
function loadHistory(src) {
    const fetches = [fetchHistory(src)];
    if (src !== "boat") fetches.push(fetchHistory("boat"));
    return Promise.all(fetches).then(([hist, boatHist]) => {
        const byTime = new Map();
        hist.forEach(p => byTime.set(p.t, {
            avg: p.avg, min: p.min, max: p.max,
            speed: p.speed != null ? p.speed : null,
            gust: p.gust != null ? p.gust : null,
        }));
        (boatHist || []).forEach(p => {
            const e = byTime.get(p.t) || {};
            e.boat = p.avg;
            byTime.set(p.t, e);
        });
        // The chart caps itself at 1800 points, so seed at most that many
        const times = [...byTime.keys()].sort((a, b) => a - b).slice(-1700);
        times.forEach(t => {
            const e = byTime.get(t);
            chartData[0].push(t / 1000);
            chartData[1].push(null); // raw samples are not kept server-side
            chartData[2].push(unwrapForChart(chartData[2], e.avg != null ? e.avg : null));
            chartData[3].push(unwrapForChart(chartData[3], e.min != null ? e.min : null));
            chartData[4].push(unwrapForChart(chartData[4], e.max != null ? e.max : null));
            chartData[5].push(unwrapForChart(chartData[5], e.boat != null ? e.boat : null));
            chartData[6].push(e.speed != null ? e.speed : null);
            chartData[7].push(e.gust != null ? e.gust : null);
        });

        // Seed the header from the most recent history entry that has speed/gust
        // so the display is not "--" until the next live poll arrives
        for (let i = times.length - 1; i >= 0; i--) {
            const e = byTime.get(times[i]);
            if (e.speed != null || e.gust != null) {
                if (e.speed != null) { latestSpeed = e.speed; speedBuffer = [e.speed]; }
                if (e.gust != null) latestGust = e.gust;
                showWind();
                break;
            }
        }

        if (uplot) uplot.setData(chartData);
    });
}

function loadSources() {
    return fetch("/plugins/windshift/sources")
        .then(r => (r.ok ? r.json() : [{ id: "boat", label: "Boat", distance: null }]))
        .catch(() => [{ id: "boat", label: "Boat", distance: null }])
        .then(sources => {
            // Never wipe the dropdown on a bad response — keep what we have
            if (!Array.isArray(sources) || sources.length === 0) return;
            const sel = document.getElementById("source-select");
            sel.innerHTML = "";
            sources.forEach(s => {
                const opt = document.createElement("option");
                opt.value = s.id;
                opt.text = s.distance == null ? s.label : `${s.label} (${(s.distance / 1852).toFixed(1)} nm)`;
                sel.appendChild(opt);
            });
            // Store server-provided speed/gust paths so handleValue can
            // subscribe to the right paths (e.g. ViVa station as boat TWD source)
            sources.forEach(s => {
                if (s.speedPath || s.gustPath) {
                    sourcePaths.set(s.id, { speedPath: s.speedPath, gustPath: s.gustPath });
                }
            });
            if ([...sel.options].some(o => o.value === currentSource)) {
                sel.value = currentSource;
            }
        });
}

function resetView() {
    chartData = [[], [], [], [], [], [], [], []];
    latestRaw = latestSmooth = latestMin = latestMax = null;
    latestSpeed = latestGust = null;
    speedBuffer = [];
    if (uplot) uplot.setData(chartData);
    document.querySelectorAll("#dashboard header .metric .value").forEach(el => {
        el.innerText = "--";
        el.style.color = "#fff";
    });
    document.querySelector(".gauge-bar").style.width = "0%";
}

function switchSource(id) {
    currentSource = id;
    resetView();
    // The boat reference line only makes sense next to something else
    if (uplot) uplot.setSeries(5, { show: id !== "boat" });
    loadHistory(id);
    loadLatest(id);
}

document.getElementById("source-select").addEventListener("change", (e) => switchSource(e.target.value));

initChart();
loadSources()
    .then(() => Promise.all([loadHistory(currentSource), loadLatest(currentSource)]))
    .then(connectSK);
// Stations can appear or drop off as viva discovers them / the boat moves
setInterval(loadSources, 5 * 60 * 1000);
