require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || "JSculptor2026";

// --- КЭШ ДЛЯ БЛОКИРОВКИ ДУБЛЕЙ ---
const signalLock = new Map();

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log(">> [SURGEON_v8.1]: SYSTEM_BOOT_SEQUENCE");
        try {
            const Signal = mongoose.model('Signal');
            await Signal.deleteMany({}); 
            console.log(">> [SYSTEM]: MEMORY_PURGE_COMPLETE");
            warmUpNodes(); // Запуск глубокого параллельного прогрева
        } catch (e) {
            warmUpNodes();
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

app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/api/signals', async (req, res) => {
    try {
        const history = await Signal.find().sort({ timestamp: -1 }).limit(30);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: "HISTORY_FETCH_FAILED" });
    }
});

// --- SURGEON MARKET STATE (SMC + MTF) ---
class MarketState {
    constructor() {
        this.price = 0;
        this.candles1m = [];
        this.candles5m = [];
        this.candles15m = [];
        this.depth = { bids: 0, asks: 0 };
        this.structure15m = { trend: 'RANGE' };
        this.orderBlocks = [];
    }

    // Поиск слома структуры (BOS)
    detectBOS(candles) {
        if (candles.length < 15) return null;
        const last = candles[candles.length - 1];
        const prevHigh = Math.max(...candles.slice(-15, -1).map(c => c.high));
        const prevLow = Math.min(...candles.slice(-15, -1).map(c => c.low));

        if (last.close > prevHigh) return 'BULLISH_BOS';
        if (last.close < prevLow) return 'BEARISH_BOS';
        return null;
    }

    // Поиск имбаланса (FVG)
    detectFVG(candles) {
        if (candles.length < 3) return null;
        const c1 = candles[candles.length - 3];
        const c3 = candles[candles.length - 1];

        if (c1.high < c3.low) return { type: 'BULLISH_FVG', top: c3.low, bottom: c1.high };
        if (c1.low > c3.high) return { type: 'BEARISH_FVG', top: c1.low, bottom: c3.high };
        return null;
    }

    // Поиск паттерна поглощения (Price Action)
    detectEngulfing() {
        const c = this.candles1m;
        if (c.length < 2) return null;
        const prev = c[c.length - 2];
        const curr = c[c.length - 1];

        if (curr.close > prev.open && curr.open < prev.close && curr.close > curr.open) return 'BULL_ENGULF';
        if (curr.close < prev.open && curr.open > prev.close && curr.close < curr.open) return 'BEAR_ENGULF';
        return null;
    }
}

const symbols = [
    'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'dogeusdt', 'xrpusdt', 
    'adausdt', 'maticusdt', 'dotusdt', 'ltcusdt', 'shibusdt', 'trxusdt', 
    'avaxusdt', 'linkusdt', 'atomusdt', 'uniusdt', 'etcusdt', 'bchusdt', 
    'nearusdt', 'filusdt'
];

let market = {};
symbols.forEach(s => { market[s] = new MarketState(); });

// --- МНОГОУРОВНЕВЫЙ ПРОГРЕВ ---
async function fetchKlines(symbol, interval, limit = 50) {
    return new Promise((resolve) => {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const k = JSON.parse(data);
                    resolve(k.map(c => ({ open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]) })));
                } catch(e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

// ИСПРАВЛЕННЫЙ БЛОК: Параллельный прогрев и мгновенный триггер
async function warmUpNodes() {
    console.log(">> [SURGEON]: INITIATING_FAST_WARMUP...");
    
    const promises = symbols.map(async (s) => {
        const [k1, k5, k15] = await Promise.all([
            fetchKlines(s, '1m'),
            fetchKlines(s, '5m'),
            fetchKlines(s, '15m')
        ]);
        
        market[s].candles1m = k1;
        market[s].candles5m = k5;
        market[s].candles15m = k15;
        
        if (k1.length > 0) {
            market[s].price = k1[k1.length - 1].close;
        }

        // ВАЖНО: Сразу после загрузки вызываем анализ, чтобы заполнить Market Watch
        analyzeMarket(s);
        console.log(`>> [NODE_READY]: ${s.toUpperCase()}`);
    });

    await Promise.all(promises);
    console.log(">> [SURGEON]: ALL_NODES_LIVE_IN_MEMORY");
}

// --- SURGEON EXECUTION ENGINE v8.1 ---
async function analyzeMarket(s) {
    const d = market[s];
    if (!d || d.candles15m.length < 15 || d.candles1m.length < 2) return;

    let reasons = [];
    
    // 1. КОНТЕКСТ (15 минут)
    const trend = d.candles15m[d.candles15m.length - 1].close > d.candles15m[0].close ? 'LONG' : 'SHORT';

    // 2. ТОЧКА ВХОДА (1 минута + Price Action)
    const engulfing = d.detectEngulfing();
    const bos1m = d.detectBOS(d.candles1m);

    let tradeType = null;

    if (trend === 'LONG' && bos1m === 'BULLISH_BOS' && engulfing === 'BULL_ENGULF') {
        tradeType = 'LONG';
        reasons.push("15m_Trend_Up", "1m_Structure_Break", "Bullish_Engulfing");
    } else if (trend === 'SHORT' && bos1m === 'BEARISH_BOS' && engulfing === 'BEAR_ENGULF') {
        tradeType = 'SHORT';
        reasons.push("15m_Trend_Down", "1m_Structure_Break", "Bearish_Engulfing");
    }

    // МГНОВЕННАЯ ПЕРЕДАЧА В ТАБЛИЦУ (Даже если нет сигнала для входа)
    io.emit('matrix_update', { 
        s: s.toUpperCase(), 
        p: d.price, 
        sc: bos1m ? 95 : 0, // 95 если есть слом структуры, иначе 0 (сканирование)
        change: d.price > (d.candles1m[d.candles1m.length-2]?.close || 0) ? 'up' : 'down' 
    });

    if (tradeType) {
        // Блокировка дублей (15 минут)
        if (signalLock.has(s) && (Date.now() - signalLock.get(s) < 900000)) return;
        signalLock.set(s, Date.now()); 

        const signalData = {
            symbol: s.toUpperCase(),
            type: tradeType,
            entry: d.price,
            sl: d.price * (tradeType === 'LONG' ? 0.994 : 1.006),
            tp: d.price * (tradeType === 'LONG' ? 1.018 : 0.982),
            score: 95,
            reason: reasons.join(" | ")
        };

        const saved = await Signal.create(signalData);
        io.emit('new_signal', saved);
        console.log(`>> [SURGEON_EXECUTION]: ${s.toUpperCase()} ${tradeType}`);
    }
}

// --- BINANCE ENGINE ---
function connectWebSocket() {
    const streams = symbols.map(s => `${s}@aggTrade/${s}@kline_1m/${s}@kline_5m/${s}@kline_15m`).join('/');
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${streams}`);

    ws.on('open', () => console.log(">> [SURGEON_WS_LINK]: STABLE_ESTABLISHED"));

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        const s = (msg.s || "").toLowerCase();
        if (!s || !market[s]) return;
        const st = market[s];

        if (msg.e === 'aggTrade') {
            st.price = parseFloat(msg.p);
        } else if (msg.e === 'kline') {
            const k = { open: parseFloat(msg.k.o), high: parseFloat(msg.k.h), low: parseFloat(msg.k.l), close: parseFloat(msg.k.c), volume: parseFloat(msg.k.v) };
            if (msg.k.i === '1m' && msg.k.x) { st.candles1m.push(k); if(st.candles1m.length > 50) st.candles1m.shift(); }
            if (msg.k.i === '5m' && msg.k.x) { st.candles5m.push(k); if(st.candles5m.length > 50) st.candles5m.shift(); }
            if (msg.k.i === '15m' && msg.k.x) { st.candles15m.push(k); if(st.candles15m.length > 50) st.candles15m.shift(); }
        }
        analyzeMarket(s);
    });

    ws.on('close', () => setTimeout(connectWebSocket, 3000));
}

connectWebSocket();

setInterval(() => {
    io.emit('system_heartbeat', { status: "SURGEON_V8.1_ONLINE", load: (Math.random() * 2).toFixed(1), uptime: process.uptime().toFixed(0) });
}, 5000);

app.post('/api/auth', (req, res) => {
    if (req.body.code === ACCESS_CODE) res.json({ ok: true });
    else res.status(401).json({ ok: false });
});

server.listen(PORT, () => {
    console.log(`
    ==========================================
    SURGEON v8.1 // MATRIX_FIX_EDITION
    MODE: MTF_PARALLEL_SCAN | NO_SPAM: ACTIVE
    ==========================================
    `);
});