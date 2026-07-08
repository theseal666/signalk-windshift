const SK_WS_URL = `ws://${window.location.hostname}:${window.location.port}/signalk/v1/stream?subscribe=none`;

let uplot;
let chartData = [
    [], // time
    [], // raw
    [], // smooth
    [], // min
    []  // max
];

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
            {},
            {
                label: "Raw",
                stroke: "rgba(100, 100, 100, 0.5)",
                width: 1,
            },
            {
                label: "Average",
                stroke: "#4caf50",
                width: 3,
            },
            {
                label: "Min",
                stroke: "#ff9800",
                dash: [5, 5],
                width: 2,
            },
            {
                label: "Max",
                stroke: "#2196f3",
                dash: [5, 5],
                width: 2,
            }
        ],
        axes: [
            {},
            {
                grid: { show: true, stroke: "#333" },
                ticks: { stroke: "#333" },
                values: (self, ticks) => ticks.map(v => (v * 180 / Math.PI).toFixed(0) + "°")
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

function updateChart(timestamp) {
    // We update chart roughly every 2 seconds to keep it smooth but not too heavy
    const lastTime = chartData[0][chartData[0].length - 1];
    if (lastTime && timestamp - lastTime < 1) return;

    chartData[0].push(timestamp);
    chartData[1].push(latestRaw);
    chartData[2].push(latestSmooth);
    chartData[3].push(latestMin);
    chartData[4].push(latestMax);

    // Keep last 1 hour of data
    if (chartData[0].length > 1800) {
        chartData.forEach(arr => arr.shift());
    }

    if (uplot) uplot.setData(chartData);
}

initChart();
connectSK();
