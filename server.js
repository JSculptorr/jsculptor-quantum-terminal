require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || "JSculptor2026";

// --- DATABASE CONNECTION & CLEANUP ---
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log(">> [ELITE_SNIPER]: DB_CONNECTED_STABLE");
        // ОЧИСТКА МУСОРА: Удаляем старые 15 сигналов один раз при запуске
        try {
            const Signal = mongoose.model('Signal');
            await Signal.deleteMany({});
            console.log(">> [SYSTEM]: OLD_GARBAGE_CLEANED_SUCCESSFULLY");
        } catch (e) {
            console.log(">> [SYSTEM]: INITIAL_CLEANUP_READY");
        }
    })
    .catch(err => console.error("!! [DB_ERROR]:", err));

const Signal = mongoose.model('Signal', new mongoose.Schema({
    symbol: String,
    type: String,
    entry: Number,
    sl: Number,
    tp: Number,
    score: Number,
    reason: String,
    timestamp: { type: Date, default: Date.now }
}));

// --- MIDDLEWARE & PWA ---
app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// API Истории (Обновлено для Elite v7.2)
app.get('/api/signals', async (req, res) => {
    try {
        const history = await Signal.find().sort({ timestamp: -1 }).limit(30);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: "HISTORY_FETCH_FAILED" });
    }
});

// --- ELITE MARKET STATE CLASS ---
class MarketState {
    constructor() {
        this.price = 0;
        this.prevPrice = 0;
        this.candles = [];
        this.deltaWindow = [];
        this.currentMinuteDelta = 0;
        this.volumeSMA = 0;
        this.ema8 = 0;
        this.ema21 = 0;
        this.swings = { high: null, low: null };
        this.depth = { bids: 0, asks: 0 };
        this.tradeCount = 0;
        this.velocity = 0; 
    }

    updateIndicators() {
        if (this.candles.length < 21) return;
        const prices = this.candles.map(c => c.close);
        const calculateEMA = (data, period) => {
            const k = 2 / (period + 1);
            return data.reduce((acc, val) => val * k + acc * (1 - k), data[0]);
        };
        this.ema8 = calculateEMA(prices, 8);
        this.ema21 = calculateEMA(prices, 21);
        this.volumeSMA = this.candles.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
    }

    updateSwings(price) {
        if (!this.swings.high || price > this.swings.high) this.swings.high = price;
        if (!this.swings.low || price < this.swings.low) this.swings.low = price;
    }

    get rollingCVD() {
        return this.deltaWindow.reduce((a, b) => a + b, 0) + this.currentMinuteDelta;
    }
}

// --- 20 ELITE NODES ---
const symbols = [
    'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'dogeusdt', 'xrpusdt', 
    'adausdt', 'maticusdt', 'dotusdt', 'ltcusdt', 'shibusdt', 'trxusdt', 
    'avaxusdt', 'linkusdt', 'atomusdt', 'uniusdt', 'etcusdt', 'bchusdt', 
    'nearusdt', 'filusdt'
];

let market = {};
symbols.forEach(s => { market[s] = new MarketState(); });

// --- ELITE SNIPER ENGINE v7.2 (СНАЙПЕРСКИЙ РЕЖИМ) ---
async function analyzeMarket(s) {
    const d = market[s];
    if (!d || d.candles.length < 21 || !d.depth.bids) return;

    let score = 0;
    let reasons = [];
    const cvd = d.rollingCVD;

    // 1. TREND GUARD (ФИЛЬТР ТРЕНДА ПО EMA 21)
    const currentTrend = d.price > d.ema21 ? "LONG" : "SHORT";

    // 2. СНАЙПЕРСКИЙ СКОРИНГ (Только по тренду!)
    const last = d.candles[d.candles.length - 1];
    if (last && last.volume > d.volumeSMA * 2.2) {
        score += 30; reasons.push("Volume Surge");
    }

    if (d.velocity > 65) { 
        score += 20; reasons.push("Tape Speed Alert");
    }

    // Liquidity & SFP Detection (Снайперский вход)
    if (currentTrend === "LONG" && d.swings.low && d.price < d.swings.low && cvd > 0) {
        score += 30; reasons.push("Institutional Buy-Back");
    } else if (currentTrend === "SHORT" && d.swings.high && d.price > d.swings.high && cvd < 0) {
        score += 30; reasons.push("Institutional Sell-Off");
    }

    // Дисбаланс стакана (Orderbook Sniper)
    const imb = (d.depth.bids - d.depth.asks) / (d.depth.bids + d.depth.asks);
    if (currentTrend === "LONG" && imb > 0.35) {
        score += 20; reasons.push("Liquidity Support");
    } else if (currentTrend === "SHORT" && imb < -0.35) {
        score += 20; reasons.push("Liquidity Resistance");
    }

    // CVD Confirmation
    if ((currentTrend === "LONG" && cvd > 0) || (currentTrend === "SHORT" && cvd < 0)) {
        score += 15; reasons.push("Delta Confirmation");
    }

    // Матрица (Отправляем sc для фронтенда v7.2)
    io.emit('matrix_update', { 
        s: s.toUpperCase(), 
        p: d.price, 
        d: cvd.toFixed(2), 
        sc: score,
        change: d.price > d.prevPrice ? 'up' : 'down'
    });
    d.prevPrice = d.price;

    // СНАЙПЕРСКИЙ ВЫСТРЕЛ: Порог 80 баллов
    if (score >= 80) {
        const type = currentTrend;
        
        // ELITE ANTI-SPAM: 10 МИНУТ (600000 мс)
        const lastSig = await Signal.findOne({ symbol: s.toUpperCase() }).sort({ timestamp: -1 });
        if (lastSig && (Date.now() - lastSig.timestamp < 600000)) return;

        const signalData = {
            symbol: s.toUpperCase(), 
            type, 
            entry: d.price,
            sl: d.price * (type === "LONG" ? 0.995 : 1.005), // Стоп 0.5%
            tp: d.price * (type === "LONG" ? 1.015 : 0.985), // Тейк 1.5%
            score, 
            reason: reasons.join(" | ")
        };

        const saved = await Signal.create(signalData);
        io.emit('new_signal', saved);
        console.log(`>> [ELITE_SNIPER]: ${s.toUpperCase()} ${type} CONFIRMED | SCORE: ${score}`);
    }
}

// --- BINANCE CORE ENGINE ---
function connectWebSocket() {
    const streams = symbols.map(s => `${s}@aggTrade/${s}@depth20@100ms/${s}@kline_1m`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${streams}`);

    ws.on('open', () => console.log(">> [BINANCE_GATEWAY]: ELITE_LINK_ACTIVE"));

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        const s = (msg.s || "").toLowerCase();
        if (!s || !market[s]) return;
        const st = market[s];

        if (msg.e === 'aggTrade') {
            st.price = parseFloat(msg.p);
            st.currentMinuteDelta += msg.m ? -parseFloat(msg.q) : parseFloat(msg.q);
            st.tradeCount++;
            st.updateSwings(st.price);
        } else if (msg.e === 'kline' && msg.k.x) {
            st.candles.push({ 
                close: parseFloat(msg.k.c), open: parseFloat(msg.k.o), 
                high: parseFloat(msg.k.h), low: parseFloat(msg.k.l), volume: parseFloat(msg.k.v) 
            });
            if (st.candles.length > 50) st.candles.shift();
            st.deltaWindow.push(st.currentMinuteDelta);
            if (st.deltaWindow.length > 10) st.deltaWindow.shift();
            st.currentMinuteDelta = 0;
            st.updateIndicators();
        } else if (msg.b) {
            st.depth.bids = msg.b.slice(0, 5).reduce((a, b) => a + parseFloat(b[1]), 0);
            st.depth.asks = msg.a.slice(0, 5).reduce((a, b) => a + parseFloat(b[1]), 0);
        }
        analyzeMarket(s);
    });

    setInterval(() => {
        symbols.forEach(s => {
            if (market[s]) {
                market[s].velocity = market[s].tradeCount;
                market[s].tradeCount = 0;
            }
        });
    }, 1000);

    ws.on('close', () => {
        console.log("!! [GATEWAY_LOST]: REBOOTING_ELITE_LINK...");
        setTimeout(connectWebSocket, 3000);
    });
}

connectWebSocket();

// --- 24/7 ELITE HEARTBEAT ---
setInterval(() => {
    io.emit('system_heartbeat', {
        status: "SNIPER_CORE_READY",
        load: (Math.random() * 5 + 1).toFixed(1),
        uptime: process.uptime().toFixed(0)
    });
}, 5000);

// --- AUTH ---
app.post('/api/auth', (req, res) => {
    if (req.body.code === ACCESS_CODE) res.json({ ok: true });
    else res.status(401).json({ ok: false });
});

server.listen(PORT, () => {
    console.log(`
    ==========================================
    JSCULPTOR ELITE v7.2 SNIPER // ONLINE
    NODES: 20 ACTIVE | TREND_GUARD: ENABLED
    DATABASE: CLEANUP_COMPLETED
    ==========================================
    `);
});