require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || "JSculptor2026";

app.use(express.static('public'));
app.use(express.json());

// Хранилище данных рынка
let market = {}; 
const symbols = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt'];

// --- SCORING ENGINE (INSTITUTIONAL LOGIC) ---
function runScoring(s) {
    const d = market[s];
    if (!d || !d.depth) return;

    let score = 0;
    let reasons = [];

    // 1. Delta Momentum (CVD)
    const cvdPower = Math.abs(d.cvd) / (d.avgVolume || 1);
    if (cvdPower > 1.5) {
        score += 25;
        reasons.push(d.cvd > 0 ? "Bullish Delta" : "Bearish Delta");
    }

    // 2. Orderbook Imbalance (Top 10 levels)
    const bids = d.depth.b.slice(0, 10).reduce((a, b) => a + parseFloat(b[1]), 0);
    const asks = d.depth.a.slice(0, 10).reduce((a, b) => a + parseFloat(b[1]), 0);
    const imbalance = (bids - asks) / (bids + asks);
    if (Math.abs(imbalance) > 0.4) {
        score += 20;
        reasons.push("OB Imbalance");
    }

    // 3. Liquidity Sweep (Снятие ликвидности)
    if (d.price > d.high24h * 0.999 || d.price < d.low24h * 1.001) {
        score += 15;
        reasons.push("Liquidity Sweep");
    }

    // 4. Absorption (Поглощение)
    if (d.lastQty > d.avgVolume * 3) {
        score += 20;
        reasons.push("Absorption Detected");
    }

    // 5. Volatility Breakout
    const move = Math.abs(d.price - d.prevPrice) / d.prevPrice;
    if (move > 0.002) {
        score += 20;
        reasons.push("Volatility Spike");
    }

    // ГЕНЕРАЦИЯ СИГНАЛА
    if (score >= 80) {
        const side = (d.cvd > 0 || imbalance > 0) ? "LONG" : "SHORT";
        const signal = {
            symbol: s.toUpperCase(),
            type: side,
            entry: d.price,
            sl: d.price * (side === "LONG" ? 0.997 : 1.003),
            tp: d.price * (side === "LONG" ? 1.01 : 0.99),
            rr: "1:3",
            score: score,
            reason: reasons.join(" + ")
        };
        io.emit('new_signal', signal);
    }
}

// --- BINANCE WEBSOCKET ---
const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbols.map(s => `${s}@aggTrade/${s}@depth20@100ms`).join('/')}`);

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const s = msg.s ? msg.s.toLowerCase() : null;
    if (!s) return;

    if (!market[s]) market[s] = { cvd: 0, price: 0, prevPrice: 0, avgVolume: 0 };

    if (msg.e === 'aggTrade') {
        market[s].prevPrice = market[s].price;
        market[s].price = parseFloat(msg.p);
        market[s].lastQty = parseFloat(msg.q);
        market[s].cvd += msg.m ? -parseFloat(msg.q) : parseFloat(msg.q);
        // Считаем средний объем (упрощенно)
        market[s].avgVolume = (market[s].avgVolume * 99 + market[s].lastQty) / 100;
    } else if (msg.b) {
        market[s].depth = { b: msg.b, a: msg.a };
    }

    runScoring(s);
});

// Роут проверки пароля
app.post('/api/auth', (req, res) => {
    if (req.body.code === ACCESS_CODE) res.json({ ok: true });
    else res.status(401).json({ ok: false });
});

server.listen(PORT, () => console.log(`JSculptor Terminal Running on ${PORT}`));