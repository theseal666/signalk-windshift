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
                { path: "environment.wind.windshift.*" }
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
    if (path === "environment.wind.directionTrue") {
        latestRaw = value;
        updateChart(timestamp);
        document.querySelector("#current-twd .value").innerText = (value * 180 / Math.PI).toFixed(0) + "°";
    } else if (path === "environment.wind.windshift.avg") {
        latestSmooth = value;
        // In shore-station mode there is no raw TWD on self, so the averaged
        // value has to drive the chart updates and the TWD readout instead
        if (latestRaw === null) {
            document.querySelector("#current-twd .value").innerText = (value * 180 / Math.PI).toFixed(0) + "°";
            updateChart(timestamp);
        }
    } else if (path === "environment.wind.windshift.max") {
        latestMax = value;
    } else if (path === "environment.wind.windshift.min") {
        latestMin = value;
    } else if (path === "environment.wind.windshift.delta") {
        document.querySelector("#delta-twd .value").innerText = (value * 180 / Math.PI).toFixed(1) + "°";
    } else if (path === "environment.wind.windshift.trend") {
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
    } else if (path === "environment.wind.windshift.cyclePeriod") {
        document.querySelector("#cycle-period .value").innerText = (value / 60).toFixed(1) + "m";
    } else if (path === "environment.wind.windshift.certainty") {
        document.querySelector(".gauge-bar").style.width = (value * 100) + "%";
    } else if (path === "environment.wind.windshift.timeToNextShift") {
        const mins = Math.floor(value / 60);
        const secs = Math.floor(value % 60);
        document.querySelector("#next-shift .value").innerText = `${mins}:${secs.toString().padStart(2, '0')}`;
    }
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

initChart();
connectSK();
