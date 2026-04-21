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

// --- DATABASE ---
mongoose.connect(process.env.MONGO_URI);
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

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// --- ADVANCED MARKET STATE CLASS ---
class MarketState {
    constructor() {
        this.price = 0;
        this.candles = [];      // 1m candles
        this.deltaWindow = [];   // Rolling CVD (10 min)
        this.currentMinuteDelta = 0;
        this.volumeSMA = 0;
        this.atr = 0;           // Volatility Filter
        this.ema8 = 0;          // Fast EMA for Timing
        this.ema21 = 0;         // Slow EMA for Value Area
        this.swings = { high: null, low: null };
        this.depth = { bids: 0, asks: 0 };
        this.setupFound = null; // Храним найденный сетап для ожидания отката
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

        let trs = [];
        for (let i = 1; i < this.candles.length; i++) {
            const c = this.candles[i];
            const p = this.candles[i-1];
            trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
        }
        this.atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
        
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

// --- СПИСОК 20 ТОПОВЫХ МОНЕТ ---
const symbols = [
    'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'dogeusdt', 'xrpusdt', 
    'adausdt', 'maticusdt', 'dotusdt', 'ltcusdt', 'shibusdt', 'trxusdt', 
    'avaxusdt', 'linkusdt', 'atomusdt', 'uniusdt', 'etcusdt', 'bchusdt', 
    'nearusdt', 'filusdt'
];

let market = {};
// Инициализируем состояние для каждой монеты заранее
symbols.forEach(s => {
    market[s] = new MarketState();
});

// --- INSTITUTIONAL ENGINE (SCORING + VOLATILITY + TIMING) ---
async function analyzeMarket(s) {
    const d = market[s];
    if (!d || d.candles.length < 5 || !d.depth.bids) return;

    let score = 0;
    let reasons = [];
    const cvd = d.rollingCVD;

    // --- ОТПРАВКА ДАННЫХ В МАТРИЦУ (ДЛЯ ХАКЕРСКОГО ВИДА) ---
    io.emit('matrix_update', {
        s: s.toUpperCase(),
        p: d.price,
        d: cvd.toFixed(2),
        sc: score // Временно отправляем промежуточный, финальный будет ниже
    });

    // Фильтр волатильности (нужно минимум 21 свеча для работы фильтра)
    if (d.candles.length >= 21) {
        const relativeVolatility = d.atr / d.price;
        if (relativeVolatility < 0.0005 || relativeVolatility > 0.015) return;
    }

    // SCORING LOGIC
    const last = d.candles[d.candles.length - 1];
    if (last && last.volume > d.volumeSMA * 2.5 && Math.abs(last.close - last.open) < (last.high - last.low) * 0.3) {
        score += 35;
        reasons.push("Institutional Absorption");
    }

    if (d.swings.high && d.price > d.swings.high && cvd < 0) {
        score += 30; reasons.push("Liquidity Grab (Top)");
    } else if (d.swings.low && d.price < d.swings.low && cvd > 0) {
        score += 30; reasons.push("Liquidity Grab (Bottom)");
    }

    const imb = (d.depth.bids - d.depth.asks) / (d.depth.bids + d.depth.asks);
    if (Math.abs(imb) > 0.5) {
        score += 15; reasons.push("OB Imbalance");
    }

    if (Math.abs(cvd) > d.volumeSMA * 0.7) {
        score += 20; reasons.push("Heavy CVD Pressure");
    }

    // Обновляем скоринг в матрице после полных расчетов
    io.emit('matrix_update', { s: s.toUpperCase(), p: d.price, d: cvd.toFixed(2), sc: score });

    // ENTRY TIMING (PULLBACK)
    if (score >= 80) {
        const type = cvd > 0 ? "LONG" : "SHORT";
        
        if (d.ema8 > 0) { // Если индикаторы уже рассчитаны
            const distanceFromEMA = Math.abs(d.price - d.ema8) / d.price;
            if (distanceFromEMA > 0.002) {
                d.setupFound = { type, score, reason: reasons.join(" | "), timestamp: Date.now() };
                return;
            }
        } else {
            // Если индикаторов еще нет (мало свечей), входим по маркету для теста
            const signalData = {
                symbol: s.toUpperCase(), type, entry: d.price,
                sl: d.price * (type === "LONG" ? 0.997 : 1.003),
                tp: d.price * (type === "LONG" ? 1.012 : 0.988),
                score, reason: reasons.join(" | ") + " (Fast Entry)"
            };
            const saved = await Signal.create(signalData);
            io.emit('new_signal', saved);
            return;
        }
    }

    if (d.setupFound) {
        if (Date.now() - d.setupFound.timestamp > 300000) { d.setupFound = null; return; }
        const sF = d.setupFound;
        let confirmed = false;
        if (sF.type === "LONG" && d.price <= d.ema8 && d.price >= d.ema21 * 0.999) confirmed = true;
        if (sF.type === "SHORT" && d.price >= d.ema8 && d.price <= d.ema21 * 1.001) confirmed = true;

        if (confirmed) {
            const lastSig = await Signal.findOne({ symbol: s.toUpperCase() }).sort({ timestamp: -1 });
            if (lastSig && (Date.now() - lastSig.timestamp < 60000)) { d.setupFound = null; return; }

            const signalData = {
                symbol: s.toUpperCase(), type: sF.type, entry: d.price,
                sl: d.price * (sF.type === "LONG" ? 0.997 : 1.003),
                tp: d.price * (sF.type === "LONG" ? 1.012 : 0.988),
                score: sF.score, reason: sF.reason + " + Pullback Confirmed"
            };
            const saved = await Signal.create(signalData);
            io.emit('new_signal', saved);
            d.setupFound = null;
        }
    }
}

// --- BINANCE WS (20 SYMBOLS) ---
const streams = symbols.map(s => `${s}@aggTrade/${s}@depth20@100ms/${s}@kline_1m`).join('/');
const ws = new WebSocket(`wss://fstream.binance.com/ws/${streams}`);

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const s = (msg.s || "").toLowerCase();
    if (!s || !market[s]) return;

    const st = market[s];

    if (msg.e === 'aggTrade') {
        st.price = parseFloat(msg.p);
        st.currentMinuteDelta += msg.m ? -parseFloat(msg.q) : parseFloat(msg.q);
        st.updateSwings(st.price);
    } else if (msg.e === 'kline') {
        if (msg.k.x) {
            st.candles.push({ 
                close: parseFloat(msg.k.c), open: parseFloat(msg.k.o), 
                high: parseFloat(msg.k.h), low: parseFloat(msg.k.l), volume: parseFloat(msg.k.v) 
            });
            if (st.candles.length > 100) st.candles.shift();
            st.deltaWindow.push(st.currentMinuteDelta);
            if (st.deltaWindow.length > 10) st.deltaWindow.shift();
            st.currentMinuteDelta = 0;
            st.updateIndicators();
        }
    } else if (msg.b) {
        st.depth.bids = msg.b.slice(0, 5).reduce((a, b) => a + parseFloat(b[1]), 0);
        st.depth.asks = msg.a.slice(0, 5).reduce((a, b) => a + parseFloat(b[1]), 0);
    }

    analyzeMarket(s);
});

app.post('/api/auth', (req, res) => {
    if (req.body.code === ACCESS_CODE) res.json({ ok: true });
    else res.status(401).json({ ok: false });
});

server.listen(PORT, () => console.log(`Institutional Hacker Terminal V3.2 Running on ${PORT}`));