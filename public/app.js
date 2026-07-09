const SK_WS_PROTO = window.location.protocol === "https:" ? "wss" : "ws";
const SK_WS_URL = `${SK_WS_PROTO}://${window.location.hostname}:${window.location.port}/signalk/v1/stream?subscribe=none`;

let uplot;
let chartData = [
    [], // time
    [], // raw
    [], // smooth
    [], // min
    []  // max
];

// Which source the dashboard is looking at: "boat" or a ViVa station slug.
// All sources are analyzed server-side the whole time; this only selects
// which one is displayed.
let currentSource = "boat";

const windshiftPrefix = (src) =>
    src === "boat" ? "environment.wind.windshift." : `environment.observations.viva.${src}.windshift.`;
const rawPath = (src) =>
    src === "boat" ? "environment.wind.directionTrue" : `environment.observations.viva.${src}.wind.directionTrue`;

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
            y: { range: (self, min, max) => [min - 0.1, max + 0.1] }
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
            },
            {
                label: "Min",
                stroke: "#ff9800",
                dash: [5, 5],
                width: 2,
                value: degreeValue,
            },
            {
                label: "Max",
                stroke: "#2196f3",
                dash: [5, 5],
                width: 2,
                value: degreeValue,
            }
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
            }
        ],
        cursor: {
            drag: { setScale: false }
        }
    };

    uplot = new uPlot(opts, chartData, container);

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

function handleValue(path, value, timestamp) {
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
// doesn't draw full-height vertical spikes
function unwrapForChart(seriesArr, v) {
    const prev = seriesArr.length ? seriesArr[seriesArr.length - 1] : null;
    if (v == null || prev == null) return v;
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

    // Keep roughly the last 30 minutes of data
    if (chartData[0].length > 1800) {
        chartData.forEach(arr => arr.shift());
    }

    if (uplot) uplot.setData(chartData);
}

// Seed the chart from the plugin's server-side history so a page reload
// or a source switch doesn't start from an empty chart
function loadHistory(src) {
    return fetch(`/plugins/windshift/history?source=${encodeURIComponent(src)}`)
        .then(r => (r.ok ? r.json() : []))
        .catch(() => [])
        .then(hist => {
            // The chart caps itself at 1800 points, so seed at most that many
            hist.slice(-1700).forEach(p => {
                chartData[0].push(p.t / 1000);
                chartData[1].push(null); // raw samples are not kept server-side
                chartData[2].push(unwrapForChart(chartData[2], p.avg));
                chartData[3].push(unwrapForChart(chartData[3], p.min));
                chartData[4].push(unwrapForChart(chartData[4], p.max));
            });
            if (uplot) uplot.setData(chartData);
        });
}

function loadSources() {
    return fetch("/plugins/windshift/sources")
        .then(r => (r.ok ? r.json() : [{ id: "boat", label: "Boat", distance: null }]))
        .catch(() => [{ id: "boat", label: "Boat", distance: null }])
        .then(sources => {
            const sel = document.getElementById("source-select");
            sel.innerHTML = "";
            sources.forEach(s => {
                const opt = document.createElement("option");
                opt.value = s.id;
                opt.text = s.distance == null ? s.label : `${s.label} (${(s.distance / 1852).toFixed(1)} nm)`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(o => o.value === currentSource)) {
                sel.value = currentSource;
            }
        });
}

function resetView() {
    chartData = [[], [], [], [], []];
    latestRaw = latestSmooth = latestMin = latestMax = null;
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
