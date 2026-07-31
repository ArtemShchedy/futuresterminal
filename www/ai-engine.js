// ╔══════════════════════════════════════════════════════════════════╗
// ║  AI-ENGINE.JS — FuturesTerminal AI Analysis Module  v2.2            ║
// ║  17 indicators, 6 short + 3 long-term horizons, reversal        ║
// ║  + Long-term 4h/1d/1w from HTF; stricter thresholds, 1d context ║
// ╚══════════════════════════════════════════════════════════════════╝

var AIEngine = (function () {
    'use strict';

    // Direction memory for hysteresis (prevents rapid flipping)
    var _prevDirection = {}; // symbol -> { direction, timestamp }
    var _prevHorizons = {}; // symbol -> { hz_label: { direction, timestamp } }

    var RSI_PERIOD = 14;
    var RSI_OVERBOUGHT = 70;
    var RSI_OVERSOLD = 30;
    var RSI_MIDLINE = 50;

    var PREDICTION_HORIZONS = [
        { label: '1м', hours: 1 / 60 },
        { label: '5м', hours: 5 / 60 },
        { label: '10м', hours: 10 / 60 },
        { label: '15м', hours: 0.25 },
        { label: '30м', hours: 0.5 },
        { label: '1ч', hours: 1 }
    ];

    // Долгосрочные горизонты (на основе 4h, 1d, 1w данных)
    var LONG_TERM_LABELS = [
        { label: '4ч', tf: '4h' },
        { label: '1д', tf: '1d' }
    ];

    var HIGHER_TF_MAP = {
        '1m': ['5m', '15m'], '3m': ['15m', '1h'], '5m': ['15m', '1h'],
        '15m': ['1h', '4h'], '30m': ['1h', '4h'], '1h': ['4h', '1d'],
        '2h': ['4h', '1d'], '4h': ['1d', '1w'], '6h': ['1d', '1w'],
        '8h': ['1d', '1w'], '12h': ['1d', '1w'], '1d': ['1w', '1M'],
        '3d': ['1w', '1M'], '1w': ['1M'], '1M': []
    };

    function tfToMinutes(tf) {
        var map = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '8h': 480, '12h': 720, '1d': 1440, '3d': 4320, '1w': 10080, '1M': 43200 };
        return map[tf] || 60;
    }

    // --- Core Indicators ---

    function calculateAllRSI(prices, period) {
        if (prices.length < period + 1) return [];
        var rsiValues = [];
        var avgGain = 0, avgLoss = 0;
        for (var i = 1; i <= period; i++) {
            var diff = prices[i] - prices[i - 1];
            if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
        }
        avgGain /= period; avgLoss /= period;
        var rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
        rsiValues.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + rs)));
        for (var i = period + 1; i < prices.length; i++) {
            var diff = prices[i] - prices[i - 1];
            var gain = diff > 0 ? diff : 0;
            var loss = diff < 0 ? Math.abs(diff) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            if (avgLoss === 0) { rsiValues.push(100); continue; }
            rsiValues.push(100 - (100 / (1 + avgGain / avgLoss)));
        }
        return rsiValues;
    }

    function sma(prices, period) {
        if (prices.length < period) return null;
        var sum = 0;
        for (var i = prices.length - period; i < prices.length; i++) sum += prices[i];
        return sum / period;
    }

    function ema(prices, period) {
        if (prices.length < period) return null;
        var k = 2 / (period + 1);
        var emaVal = 0;
        for (var i = 0; i < period; i++) emaVal += prices[i];
        emaVal /= period;
        for (var i = period; i < prices.length; i++) emaVal = prices[i] * k + emaVal * (1 - k);
        return emaVal;
    }

    function calcEmaArray(prices, period) {
        if (prices.length < period) return [];
        var k = 2 / (period + 1);
        var emaVal = 0;
        for (var i = 0; i < period; i++) emaVal += prices[i];
        emaVal /= period;
        var result = new Array(period - 1).fill(null);
        result.push(emaVal);
        for (var i = period; i < prices.length; i++) {
            emaVal = prices[i] * k + emaVal * (1 - k);
            result.push(emaVal);
        }
        return result;
    }

    function calcMACD(closes) {
        var ema12 = calcEmaArray(closes, 12);
        var ema26 = calcEmaArray(closes, 26);
        if (ema26.length < closes.length) return null;
        var macdLine = [];
        for (var i = 0; i < closes.length; i++) {
            if (ema12[i] == null || ema26[i] == null) { macdLine.push(null); continue; }
            macdLine.push(ema12[i] - ema26[i]);
        }
        var validMacd = macdLine.filter(function (v) { return v != null; });
        if (validMacd.length < 9) return null;
        var signalArr = calcEmaArray(validMacd, 9);
        var signal = signalArr.length > 0 ? signalArr[signalArr.length - 1] : 0;
        var macd = validMacd[validMacd.length - 1];
        var histogram = macd - signal;
        var prevMacd = validMacd.length >= 2 ? validMacd[validMacd.length - 2] : macd;
        var prevSignal = signalArr.length >= 2 ? signalArr[signalArr.length - 2] : signal;
        var prevHist = validMacd.length >= 2 && signalArr.length >= 2
            ? validMacd[validMacd.length - 2] - signalArr[signalArr.length - 2] : histogram;
        return {
            macd: macd, signal: signal, histogram: histogram,
            crossover: prevMacd <= prevSignal && macd > signal,
            crossunder: prevMacd >= prevSignal && macd < signal,
            histogramRising: histogram > prevHist,
            histogramFalling: histogram < prevHist
        };
    }

    function calcBollingerBands(closes, period, mult) {
        period = period || 20; mult = mult || 2;
        if (closes.length < period) return null;
        var slice = closes.slice(-period);
        var mean = slice.reduce(function (a, b) { return a + b; }, 0) / period;
        var variance = slice.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / period;
        var stddev = Math.sqrt(variance);
        var upper = mean + mult * stddev, lower = mean - mult * stddev;
        var price = closes[closes.length - 1];
        var width = (upper - lower) / mean * 100;
        var pctB = stddev === 0 ? 0.5 : (price - lower) / (upper - lower);
        return { upper: upper, lower: lower, middle: mean, stddev: stddev, width: width, pctB: pctB, squeeze: width < 3 };
    }

    function calcStochastic(ohlc, kPeriod, dPeriod) {
        kPeriod = kPeriod || 14; dPeriod = dPeriod || 3;
        if (ohlc.length < kPeriod + dPeriod) return null;
        var kValues = [];
        for (var i = kPeriod - 1; i < ohlc.length; i++) {
            var highest = -Infinity, lowest = Infinity;
            for (var j = i - kPeriod + 1; j <= i; j++) {
                if (ohlc[j].high > highest) highest = ohlc[j].high;
                if (ohlc[j].low < lowest) lowest = ohlc[j].low;
            }
            var range = highest - lowest;
            kValues.push(range === 0 ? 50 : ((ohlc[i].close - lowest) / range) * 100);
        }
        var dValues = [];
        for (var i = dPeriod - 1; i < kValues.length; i++) {
            var sum = 0;
            for (var j = i - dPeriod + 1; j <= i; j++) sum += kValues[j];
            dValues.push(sum / dPeriod);
        }
        var k = kValues[kValues.length - 1], d = dValues[dValues.length - 1];
        var prevK = kValues.length >= 2 ? kValues[kValues.length - 2] : k;
        var prevD = dValues.length >= 2 ? dValues[dValues.length - 2] : d;
        return { k: k, d: d, crossover: prevK <= prevD && k > d, crossunder: prevK >= prevD && k < d };
    }

    function calcADX(ohlc, period) {
        period = period || 14;
        if (ohlc.length < period * 2 + 1) return null;
        var prevPlusDM = 0, prevMinusDM = 0, prevTR = 0;
        for (var i = 1; i <= period; i++) {
            var high = ohlc[i].high, low = ohlc[i].low, prevClose = ohlc[i - 1].close;
            var tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            var upMove = high - ohlc[i - 1].high, downMove = ohlc[i - 1].low - low;
            prevPlusDM += (upMove > downMove && upMove > 0) ? upMove : 0;
            prevMinusDM += (downMove > upMove && downMove > 0) ? downMove : 0;
            prevTR += tr;
        }
        var dxValues = [];
        var lastPlusDI = 0, lastMinusDI = 0;
        for (var i = period + 1; i < ohlc.length; i++) {
            var high = ohlc[i].high, low = ohlc[i].low, prevClose = ohlc[i - 1].close;
            var tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            var upMove = high - ohlc[i - 1].high, downMove = ohlc[i - 1].low - low;
            prevTR = prevTR - prevTR / period + tr;
            prevPlusDM = prevPlusDM - prevPlusDM / period + ((upMove > downMove && upMove > 0) ? upMove : 0);
            prevMinusDM = prevMinusDM - prevMinusDM / period + ((downMove > upMove && downMove > 0) ? downMove : 0);
            var plusDI = prevTR === 0 ? 0 : (prevPlusDM / prevTR) * 100;
            var minusDI = prevTR === 0 ? 0 : (prevMinusDM / prevTR) * 100;
            lastPlusDI = plusDI;
            lastMinusDI = minusDI;
            var diSum = plusDI + minusDI;
            dxValues.push(diSum === 0 ? 0 : Math.abs(plusDI - minusDI) / diSum * 100);
        }
        if (dxValues.length < period) return null;
        var adx = 0;
        for (var i = 0; i < period; i++) adx += dxValues[i];
        adx /= period;
        for (var i = period; i < dxValues.length; i++) adx = (adx * (period - 1) + dxValues[i]) / period;
        return {
            adx: adx, trending: adx > 25, strong: adx > 40,
            plusDI: lastPlusDI, minusDI: lastMinusDI,
            bullish: lastPlusDI > lastMinusDI
        };
    }

    function calcOBV(ohlc) {
        if (ohlc.length < 10) return null;
        var obv = 0, obvArr = [0];
        for (var i = 1; i < ohlc.length; i++) {
            var vol = ohlc[i].volume || 1;
            if (ohlc[i].close > ohlc[i - 1].close) obv += vol;
            else if (ohlc[i].close < ohlc[i - 1].close) obv -= vol;
            obvArr.push(obv);
        }
        var recent = obvArr.slice(-10);
        var trend = recent[recent.length - 1] - recent[0];
        var priceTrend = ohlc[ohlc.length - 1].close - ohlc[ohlc.length - 10].close;
        var divergence = (trend > 0 && priceTrend < 0) || (trend < 0 && priceTrend > 0);
        return { obv: obv, trend: trend > 0 ? 'up' : 'down', divergence: divergence };
    }

    function calcIchimoku(ohlc) {
        if (ohlc.length < 52) return null;
        function highLow(arr, period, offset) {
            var slice = arr.slice(offset - period, offset);
            var high = -Infinity, low = Infinity;
            for (var i = 0; i < slice.length; i++) { if (slice[i].high > high) high = slice[i].high; if (slice[i].low < low) low = slice[i].low; }
            return (high + low) / 2;
        }
        var len = ohlc.length;
        var tenkan = highLow(ohlc, 9, len), kijun = highLow(ohlc, 26, len);
        var senkouA = (tenkan + kijun) / 2, senkouB = highLow(ohlc, 52, len);
        var price = ohlc[len - 1].close;

        // Chikou Span: current price vs price 26 periods ago
        var chikouBull = false, chikouBear = false;
        if (len > 26) {
            var price26ago = ohlc[len - 27].close;
            chikouBull = price > price26ago;
            chikouBear = price < price26ago;
        }

        return {
            tenkan: tenkan, kijun: kijun, senkouA: senkouA, senkouB: senkouB,
            aboveCloud: price > Math.max(senkouA, senkouB),
            belowCloud: price < Math.min(senkouA, senkouB),
            tkCross: tenkan > kijun ? 'bull' : tenkan < kijun ? 'bear' : 'flat',
            chikouBull: chikouBull, chikouBear: chikouBear
        };
    }

    function calcVWAP(ohlc) {
        if (ohlc.length < 10) return null;
        var cumVol = 0, cumTP = 0;
        for (var i = 0; i < ohlc.length; i++) {
            var tp = (ohlc[i].high + ohlc[i].low + ohlc[i].close) / 3;
            var vol = ohlc[i].volume || 1;
            cumVol += vol; cumTP += tp * vol;
        }
        var vwap = cumVol === 0 ? ohlc[ohlc.length - 1].close : cumTP / cumVol;
        var price = ohlc[ohlc.length - 1].close;
        return { vwap: vwap, above: price > vwap, deviation: ((price - vwap) / vwap) * 100 };
    }

    function calcVolumeTrend(ohlc, period) {
        period = period || 10;
        if (ohlc.length < period * 2) return null;
        var recent = ohlc.slice(-period), prev = ohlc.slice(-period * 2, -period);
        var recentAvg = recent.reduce(function (s, c) { return s + (c.volume || 0); }, 0) / period;
        var prevAvg = prev.reduce(function (s, c) { return s + (c.volume || 0); }, 0) / period;
        var ratio = prevAvg === 0 ? 1 : recentAvg / prevAvg;
        return { rising: ratio > 1.2, falling: ratio < 0.8, ratio: ratio };
    }

    // --- NEW: RSI Divergence Detection ---
    function detectRSIDivergence(closes, rsiArr, lookback) {
        lookback = lookback || 20;
        if (rsiArr.length < lookback || closes.length < lookback + RSI_PERIOD) return { bullish: false, bearish: false };
        
        // Map RSI values back to closes indices: rsiArr[0] corresponds to closes[RSI_PERIOD]
        var rsiOffset = closes.length - rsiArr.length;
        var recentLen = Math.min(lookback, rsiArr.length);
        var startRSI = rsiArr.length - recentLen;
        
        // Find swing lows and highs in last `lookback` candles
        var priceNow = closes[closes.length - 1];
        var rsiNow = rsiArr[rsiArr.length - 1];
        
        // Find the lowest price low and highest price high in lookback window
        var lowestPrice = Infinity, lowestRSI = Infinity, lowestIdx = -1;
        var highestPrice = -Infinity, highestRSI = -Infinity, highestIdx = -1;
        
        // Scan for swing lows (bullish divergence) and swing highs (bearish divergence)
        for (var i = startRSI; i < rsiArr.length - 3; i++) {
            var ci = i + rsiOffset;
            if (ci < 0 || ci >= closes.length) continue;
            var price = closes[ci];
            var rsi = rsiArr[i];
            if (price < lowestPrice) { lowestPrice = price; lowestRSI = rsi; lowestIdx = ci; }
            if (price > highestPrice) { highestPrice = price; highestRSI = rsi; highestIdx = ci; }
        }
        
        // Bullish divergence: price makes lower low, RSI makes higher low
        var bullishDiv = false;
        if (lowestIdx > -1 && priceNow <= lowestPrice * 1.005 && rsiNow > lowestRSI + 3 && rsiNow < 45) {
            bullishDiv = true;
        }
        
        // Bearish divergence: price makes higher high, RSI makes lower high
        var bearishDiv = false;
        if (highestIdx > -1 && priceNow >= highestPrice * 0.995 && rsiNow < highestRSI - 3 && rsiNow > 55) {
            bearishDiv = true;
        }
        
        return { bullish: bullishDiv, bearish: bearishDiv };
    }

    // --- NEW: Rate of Change (ROC) acceleration ---
    function calcROC(closes, period) {
        if (closes.length < period + 1) return null;
        var prev = closes[closes.length - period - 1];
        if (prev === 0) return null;
        return ((closes[closes.length - 1] - prev) / prev) * 100;
    }

    // --- NEW: ATR with Wilder's smoothing ---
    function calcATR(ohlc, period) {
        period = period || 14;
        if (ohlc.length < period + 1) return 0;
        // First ATR = SMA of TR
        var trSum = 0;
        for (var i = 1; i <= period; i++) {
            var h = ohlc[i].high, l = ohlc[i].low, pc = ohlc[i - 1].close;
            trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        var atr = trSum / period;
        // Wilder's smoothing for remaining data
        for (var i = period + 1; i < ohlc.length; i++) {
            var h = ohlc[i].high, l = ohlc[i].low, pc = ohlc[i - 1].close;
            var tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
            atr = (atr * (period - 1) + tr) / period;
        }
        return atr;
    }

    // --- Smart Money Concepts v3 (OB / Breaker / FVG / Liquidity / Structure / Order Flow) ---

    function isBullish(c) { return c.close >= c.open; }
    function candleBody(c) { return Math.abs(c.close - c.open); }
    function candleRange(c) { return Math.max(1e-12, c.high - c.low); }

    function avgVolume(ohlc, from, to) {
        var s = 0, n = 0;
        for (var i = from; i <= to; i++) {
            if (i >= 0 && i < ohlc.length) { s += (ohlc[i].volume || 0); n++; }
        }
        return n ? s / n : 0;
    }

    function findSwingPoints(ohlc, left, right) {
        left = left || 3; right = right || 3;
        var swings = { highs: [], lows: [] };
        for (var i = left; i < ohlc.length - right; i++) {
            var isHigh = true, isLow = true;
            for (var j = 1; j <= left; j++) {
                if (ohlc[i].high <= ohlc[i - j].high) isHigh = false;
                if (ohlc[i].low >= ohlc[i - j].low) isLow = false;
            }
            for (var k = 1; k <= right; k++) {
                if (ohlc[i].high <= ohlc[i + k].high) isHigh = false;
                if (ohlc[i].low >= ohlc[i + k].low) isLow = false;
            }
            if (isHigh) swings.highs.push({ price: ohlc[i].high, index: i });
            if (isLow) swings.lows.push({ price: ohlc[i].low, index: i });
        }
        return swings;
    }

    function detectMarketStructure(ohlc) {
        var swings = findSwingPoints(ohlc.slice(-100), 3, 3);
        var price = ohlc[ohlc.length - 1].close;
        var last = ohlc[ohlc.length - 1];
        var highs = swings.highs, lows = swings.lows;
        var structure = 'range';
        var event = null;
        var lastHigh = highs.length ? highs[highs.length - 1] : null;
        var prevHigh = highs.length > 1 ? highs[highs.length - 2] : null;
        var lastLow = lows.length ? lows[lows.length - 1] : null;
        var prevLow = lows.length > 1 ? lows[lows.length - 2] : null;

        if (lastHigh && prevHigh && lastLow && prevLow) {
            var hh = lastHigh.price > prevHigh.price;
            var hl = lastLow.price > prevLow.price;
            var lh = lastHigh.price < prevHigh.price;
            var ll = lastLow.price < prevLow.price;
            if (hh && hl) structure = 'bullish';
            else if (lh && ll) structure = 'bearish';
        }

        // BOS / CHoCH on last candle close through recent swing
        if (lastHigh && last.close > lastHigh.price) {
            event = structure === 'bearish' ? 'choch_bull' : 'bos_bull';
            structure = 'bullish';
        } else if (lastLow && last.close < lastLow.price) {
            event = structure === 'bullish' ? 'choch_bear' : 'bos_bear';
            structure = 'bearish';
        }

        var swingHigh = lastHigh ? lastHigh.price : price + (price * 0.01);
        var swingLow = lastLow ? lastLow.price : price - (price * 0.01);
        if (swingHigh <= swingLow) {
            swingHigh = price + Math.abs(price) * 0.01;
            swingLow = price - Math.abs(price) * 0.01;
        }
        var equilibrium = (swingHigh + swingLow) / 2;
        var zone = price >= equilibrium ? 'premium' : 'discount';
        var posInRange = (price - swingLow) / (swingHigh - swingLow);

        return {
            structure: structure,
            event: event,
            swingHigh: swingHigh,
            swingLow: swingLow,
            equilibrium: equilibrium,
            zone: zone,
            posInRange: posInRange,
            lastHigh: lastHigh,
            lastLow: lastLow
        };
    }

    function detectFVGs(ohlc, lookback) {
        lookback = lookback || 80;
        var start = Math.max(2, ohlc.length - lookback);
        var price = ohlc[ohlc.length - 1].close;
        var fvgs = [];
        for (var i = start; i < ohlc.length; i++) {
            var c0 = ohlc[i - 2], c1 = ohlc[i - 1], c2 = ohlc[i];
            var impulse = candleBody(c1) / candleRange(c1);
            // Bullish FVG: gap between candle 0 high and candle 2 low
            if (c2.low > c0.high) {
                var top = c2.low, bottom = c0.high, mid = (top + bottom) / 2;
                var size = top - bottom;
                var mitigated = false, fillPct = 0;
                for (var m = i + 1; m < ohlc.length; m++) {
                    if (ohlc[m].low <= bottom) { mitigated = true; fillPct = 1; break; }
                    if (ohlc[m].low < top) fillPct = Math.max(fillPct, (top - ohlc[m].low) / size);
                }
                if (!mitigated && price < top && price >= bottom) fillPct = Math.max(fillPct, (top - price) / size);
                fvgs.push({
                    type: 'bull', top: top, bottom: bottom, mid: mid, ce: mid,
                    index: i, active: !mitigated, filled: fillPct >= 0.5,
                    fillPct: fillPct, quality: impulse * size, fresh: ohlc.length - i
                });
            }
            // Bearish FVG
            if (c2.high < c0.low) {
                var top2 = c0.low, bottom2 = c2.high, mid2 = (top2 + bottom2) / 2;
                var size2 = top2 - bottom2;
                var mitigated2 = false, fillPct2 = 0;
                for (var n = i + 1; n < ohlc.length; n++) {
                    if (ohlc[n].high >= top2) { mitigated2 = true; fillPct2 = 1; break; }
                    if (ohlc[n].high > bottom2) fillPct2 = Math.max(fillPct2, (ohlc[n].high - bottom2) / size2);
                }
                if (!mitigated2 && price > bottom2 && price <= top2) fillPct2 = Math.max(fillPct2, (price - bottom2) / size2);
                fvgs.push({
                    type: 'bear', top: top2, bottom: bottom2, mid: mid2, ce: mid2,
                    index: i, active: !mitigated2, filled: fillPct2 >= 0.5,
                    fillPct: fillPct2, quality: impulse * size2, fresh: ohlc.length - i
                });
            }
        }
        fvgs = fvgs.filter(function (f) { return f.active; });
        fvgs.sort(function (a, b) {
            var da = Math.min(Math.abs(price - a.top), Math.abs(price - a.bottom), Math.abs(price - a.mid));
            var db = Math.min(Math.abs(price - b.top), Math.abs(price - b.bottom), Math.abs(price - b.mid));
            // Prefer closer + fresher + higher quality
            return (da - db) || (a.fresh - b.fresh) || (b.quality - a.quality);
        });
        return fvgs.slice(0, 6);
    }

    function detectOrderBlocks(ohlc, atr) {
        if (ohlc.length < 12 || !atr) return [];
        var minDisp = atr * 1.35;
        var blocks = [];
        var volAvg = avgVolume(ohlc, Math.max(0, ohlc.length - 40), ohlc.length - 1);

        for (var i = 4; i < ohlc.length - 1; i++) {
            // Strong bullish displacement candle
            var bullDisp = ohlc[i].close - ohlc[i].open;
            var bearDisp = ohlc[i].open - ohlc[i].close;
            var volRatio = volAvg > 0 ? (ohlc[i].volume || 0) / volAvg : 1;

            if (bullDisp > minDisp && candleBody(ohlc[i]) / candleRange(ohlc[i]) > 0.55) {
                for (var j = i - 1; j >= Math.max(0, i - 8); j--) {
                    if (!isBullish(ohlc[j])) {
                        var mitigatedBull = false;
                        for (var mb = i + 1; mb < ohlc.length; mb++) {
                            if (ohlc[mb].low <= ohlc[j].low) { mitigatedBull = true; break; }
                        }
                        blocks.push({
                            type: 'bull',
                            top: ohlc[j].high, bottom: ohlc[j].low,
                            mid: (ohlc[j].high + ohlc[j].low) / 2,
                            index: j, displacement: bullDisp,
                            volRatio: volRatio, mitigated: mitigatedBull,
                            quality: (bullDisp / atr) * (0.7 + Math.min(1.5, volRatio) * 0.3) * (mitigatedBull ? 0.35 : 1),
                            fresh: ohlc.length - j
                        });
                        break;
                    }
                }
            } else if (bearDisp > minDisp && candleBody(ohlc[i]) / candleRange(ohlc[i]) > 0.55) {
                for (var k = i - 1; k >= Math.max(0, i - 8); k--) {
                    if (isBullish(ohlc[k])) {
                        var mitigatedBear = false;
                        for (var nb = i + 1; nb < ohlc.length; nb++) {
                            if (ohlc[nb].high >= ohlc[k].high) { mitigatedBear = true; break; }
                        }
                        blocks.push({
                            type: 'bear',
                            top: ohlc[k].high, bottom: ohlc[k].low,
                            mid: (ohlc[k].high + ohlc[k].low) / 2,
                            index: k, displacement: bearDisp,
                            volRatio: volRatio, mitigated: mitigatedBear,
                            quality: (bearDisp / atr) * (0.7 + Math.min(1.5, volRatio) * 0.3) * (mitigatedBear ? 0.35 : 1),
                            fresh: ohlc.length - k
                        });
                        break;
                    }
                }
            }
        }

        var price = ohlc[ohlc.length - 1].close;
        blocks = blocks.filter(function (b) {
            if (b.mitigated) return false;
            if (b.type === 'bull') return price >= b.bottom * 0.997;
            return price <= b.top * 1.003;
        });
        blocks.sort(function (a, b) {
            var da = Math.abs(price - a.mid), db = Math.abs(price - b.mid);
            return (da - db) || (b.quality - a.quality) || (a.fresh - b.fresh);
        });
        var result = [], seen = {};
        for (var n = 0; n < blocks.length; n++) {
            var key = blocks[n].type + ':' + blocks[n].index;
            if (!seen[key]) { seen[key] = true; result.push(blocks[n]); }
            if (result.length >= 5) break;
        }
        return result;
    }

    function detectBreakerBlocks(ohlc, orderBlocks) {
        var price = ohlc[ohlc.length - 1].close;
        var breakers = [];
        var atr = calcATR(ohlc, 14) || (price * 0.01);
        var raw = [];
        var minDisp = atr * 1.2;
        for (var i = 4; i < ohlc.length - 1; i++) {
            var move = ohlc[i].close - ohlc[i].open;
            if (move > minDisp) {
                for (var j = i - 1; j >= Math.max(0, i - 8); j--) {
                    if (!isBullish(ohlc[j])) {
                        raw.push({ type: 'bull', top: ohlc[j].high, bottom: ohlc[j].low, mid: (ohlc[j].high + ohlc[j].low) / 2, index: j, breakAt: i });
                        break;
                    }
                }
            } else if (move < -minDisp) {
                for (var k = i - 1; k >= Math.max(0, i - 8); k--) {
                    if (isBullish(ohlc[k])) {
                        raw.push({ type: 'bear', top: ohlc[k].high, bottom: ohlc[k].low, mid: (ohlc[k].high + ohlc[k].low) / 2, index: k, breakAt: i });
                        break;
                    }
                }
            }
        }
        for (var r = 0; r < raw.length; r++) {
            var ob = raw[r];
            var broken = false, breakIdx = -1;
            for (var t = ob.breakAt + 1; t < ohlc.length; t++) {
                if (ob.type === 'bull' && ohlc[t].close < ob.bottom) { broken = true; breakIdx = t; break; }
                if (ob.type === 'bear' && ohlc[t].close > ob.top) { broken = true; breakIdx = t; break; }
            }
            if (broken) {
                // Valid breaker: retest after break
                var retested = false;
                for (var u = breakIdx + 1; u < ohlc.length; u++) {
                    if (ohlc[u].low <= ob.top && ohlc[u].high >= ob.bottom) { retested = true; break; }
                }
                breakers.push({
                    type: ob.type === 'bull' ? 'bear' : 'bull',
                    top: ob.top, bottom: ob.bottom, mid: ob.mid,
                    label: ob.type === 'bull' ? 'bearish_breaker' : 'bullish_breaker',
                    retested: retested,
                    quality: retested ? 1.25 : 0.85
                });
            }
        }
        breakers.sort(function (a, b) {
            return Math.abs(price - a.mid) - Math.abs(price - b.mid) || (b.quality - a.quality);
        });
        return breakers.slice(0, 3);
    }

    function detectLiquidityPools(ohlc, atr) {
        var window = ohlc.slice(-90);
        var swings = findSwingPoints(window, 3, 3);
        var price = ohlc[ohlc.length - 1].close;
        var last = ohlc[ohlc.length - 1];
        var prev = ohlc.length > 1 ? ohlc[ohlc.length - 2] : last;
        var tol = atr * 0.18;
        var bsl = [], ssl = [];

        for (var i = 0; i < swings.highs.length; i++) {
            for (var j = i + 1; j < swings.highs.length; j++) {
                if (Math.abs(swings.highs[i].price - swings.highs[j].price) <= tol) {
                    bsl.push({
                        price: (swings.highs[i].price + swings.highs[j].price) / 2,
                        type: 'equal_highs',
                        strength: 2
                    });
                }
            }
        }
        for (var a = 0; a < swings.lows.length; a++) {
            for (var b = a + 1; b < swings.lows.length; b++) {
                if (Math.abs(swings.lows[a].price - swings.lows[b].price) <= tol) {
                    ssl.push({
                        price: (swings.lows[a].price + swings.lows[b].price) / 2,
                        type: 'equal_lows',
                        strength: 2
                    });
                }
            }
        }
        if (swings.highs.length) bsl.push({ price: swings.highs[swings.highs.length - 1].price, type: 'swing_high', strength: 1 });
        if (swings.lows.length) ssl.push({ price: swings.lows[swings.lows.length - 1].price, type: 'swing_low', strength: 1 });

        bsl.sort(function (x, y) {
            return Math.abs(x.price - price) - Math.abs(y.price - price) || (y.strength - x.strength);
        });
        ssl.sort(function (x, y) {
            return Math.abs(x.price - price) - Math.abs(y.price - price) || (y.strength - x.strength);
        });

        var nearestBSL = bsl.length ? bsl[0].price : price + atr;
        var nearestSSL = ssl.length ? ssl[0].price : price - atr;

        // Sweep = wick through liquidity + close back inside (stop hunt)
        var sweptHigh = last.high > nearestBSL && last.close < nearestBSL;
        var sweptLow = last.low < nearestSSL && last.close > nearestSSL;
        // Also check previous candle for fresh sweep
        if (!sweptHigh) sweptHigh = prev.high > nearestBSL && prev.close < nearestBSL && last.close < nearestBSL;
        if (!sweptLow) sweptLow = prev.low < nearestSSL && prev.close > nearestSSL && last.close > nearestSSL;

        // Rejection quality after sweep (displacement back)
        var rejectBull = sweptLow && last.close > last.open && candleBody(last) / candleRange(last) > 0.45;
        var rejectBear = sweptHigh && last.close < last.open && candleBody(last) / candleRange(last) > 0.45;

        return {
            bsl: nearestBSL, ssl: nearestSSL,
            sweptHigh: sweptHigh, sweptLow: sweptLow,
            rejectBull: rejectBull, rejectBear: rejectBear,
            equalHighs: bsl.some(function (x) { return x.type === 'equal_highs'; }),
            equalLows: ssl.some(function (x) { return x.type === 'equal_lows'; }),
            bslStrength: bsl.length ? bsl[0].strength : 1,
            sslStrength: ssl.length ? ssl[0].strength : 1
        };
    }

    function detectOrderFlowBias(ohlc) {
        if (ohlc.length < 8) return { bias: 'neutral', score: 0 };
        var bullBodies = 0, bearBodies = 0, bullVol = 0, bearVol = 0;
        for (var i = ohlc.length - 8; i < ohlc.length; i++) {
            var c = ohlc[i];
            var body = candleBody(c);
            if (isBullish(c)) { bullBodies += body; bullVol += (c.volume || 0); }
            else { bearBodies += body; bearVol += (c.volume || 0); }
        }
        var bodyDiff = (bullBodies - bearBodies) / (bullBodies + bearBodies + 1e-9);
        var volDiff = (bullVol - bearVol) / (bullVol + bearVol + 1e-9);
        var score = bodyDiff * 0.6 + volDiff * 0.4;
        var bias = score > 0.12 ? 'bull' : score < -0.12 ? 'bear' : 'neutral';
        return { bias: bias, score: score };
    }

    function analyzeSMC(ohlc, htfCache, price, atr, baseDirection, baseStrength) {
        if (!ohlc || ohlc.length < 30 || !atr) {
            return {
                direction: baseDirection || 'sideways', strength: baseStrength || 50,
                summary: 'Недостаточно данных для полного SMC-анализа.',
                signals: [], entry: price, stop: price, target: price,
                liquidity: { bsl: price, ssl: price, sweptHigh: false, sweptLow: false },
                fvgs: [], orderBlocks: [], breakers: [], htfBias: 'sideways',
                bullScore: 0, bearScore: 0, confluence: 0, structure: 'range', zone: 'equilibrium'
            };
        }

        var structure = detectMarketStructure(ohlc);
        var fvgs = detectFVGs(ohlc);
        var orderBlocks = detectOrderBlocks(ohlc, atr);
        var breakers = detectBreakerBlocks(ohlc, orderBlocks);
        var liq = detectLiquidityPools(ohlc, atr);
        var flow = detectOrderFlowBias(ohlc);

        var htf1h = (htfCache && htfCache['1h']) ? htfCache['1h'] : null;
        var htf4h = (htfCache && htfCache['4h']) ? htfCache['4h'] : null;
        var htfDir1h = htf1h ? computeHTFDirection(htf1h) : { direction: 'sideways', strength: 50 };
        var htfDir4h = htf4h ? computeHTFDirection(htf4h) : { direction: 'sideways', strength: 50 };
        var htfStruct1h = htf1h ? detectMarketStructure(htf1h) : null;
        var htfBlocks = htf1h ? detectOrderBlocks(htf1h, calcATR(htf1h, 14) || atr) : [];

        var bullScore = 0, bearScore = 0, confluence = 0;
        var signals = [];

        // 1) Market structure / BOS / CHoCH — highest priority
        if (structure.structure === 'bullish') { bullScore += 18; confluence++; }
        if (structure.structure === 'bearish') { bearScore += 18; confluence++; }
        if (structure.event === 'bos_bull') {
            bullScore += 22;
            signals.push({ key: 'smc.bosBull', type: 'bull', text: 'BOS вверх — структура подтвердила продолжение роста' });
            confluence++;
        } else if (structure.event === 'choch_bull') {
            bullScore += 30;
            signals.push({ key: 'smc.chochBull', type: 'bull', text: 'CHoCH вверх — смена характера, разворот на рост' });
            confluence += 2;
        } else if (structure.event === 'bos_bear') {
            bearScore += 22;
            signals.push({ key: 'smc.bosBear', type: 'bear', text: 'BOS вниз — структура подтвердила продолжение снижения' });
            confluence++;
        } else if (structure.event === 'choch_bear') {
            bearScore += 30;
            signals.push({ key: 'smc.chochBear', type: 'bear', text: 'CHoCH вниз — смена характера, разворот на спад' });
            confluence += 2;
        }

        // 2) Premium / Discount — buy discount in bull, sell premium in bear
        if (structure.zone === 'discount') {
            bullScore += 14;
            if (structure.structure === 'bullish') {
                signals.push({ key: 'smc.discountBull', type: 'bull', text: 'Цена в Discount-зоне бычьей структуры — зона интереса для покупок' });
                confluence++;
            }
        } else if (structure.zone === 'premium') {
            bearScore += 14;
            if (structure.structure === 'bearish') {
                signals.push({ key: 'smc.premiumBear', type: 'bear', text: 'Цена в Premium-зоне медвежьей структуры — зона интереса для продаж' });
                confluence++;
            }
        }

        // 3) Liquidity sweeps with rejection (true stop-hunt)
        if (liq.sweptLow) {
            var sweepBullPts = liq.rejectBull ? 34 : 22;
            bullScore += sweepBullPts;
            signals.push({
                key: liq.rejectBull ? 'smc.liqSweepLowReject' : 'smc.liqSweepLow',
                type: 'bull',
                text: liq.rejectBull
                    ? 'Снятие SSL + отторжение — классический stop-hunt, ожидается рост'
                    : 'Снятие SSL — сбор ликвидности снизу, вероятен отскок'
            });
            confluence += liq.rejectBull ? 2 : 1;
        }
        if (liq.sweptHigh) {
            var sweepBearPts = liq.rejectBear ? 34 : 22;
            bearScore += sweepBearPts;
            signals.push({
                key: liq.rejectBear ? 'smc.liqSweepHighReject' : 'smc.liqSweepHigh',
                type: 'bear',
                text: liq.rejectBear
                    ? 'Снятие BSL + отторжение — классический stop-hunt, ожидается спад'
                    : 'Снятие BSL — сбор ликвидности сверху, вероятен откат'
            });
            confluence += liq.rejectBear ? 2 : 1;
        }
        if (liq.equalHighs && !liq.sweptHigh) {
            signals.push({ key: 'smc.eqHighs', type: 'bear', text: 'Equal Highs (BSL) — ликвидность сверху ещё не снята' });
            bearScore += 6;
        }
        if (liq.equalLows && !liq.sweptLow) {
            signals.push({ key: 'smc.eqLows', type: 'bull', text: 'Equal Lows (SSL) — ликвидность снизу ещё не снята' });
            bullScore += 6;
        }
        if (!liq.sweptLow && Math.abs(price - liq.ssl) / price * 100 < 0.35) {
            bearScore += 7;
            signals.push({ key: 'smc.nearSSL', type: 'bear', text: 'Цена у SSL — возможен вынос стопов перед разворотом вверх' });
        }
        if (!liq.sweptHigh && Math.abs(price - liq.bsl) / price * 100 < 0.35) {
            bullScore += 7;
            signals.push({ key: 'smc.nearBSL', type: 'bull', text: 'Цена у BSL — возможен вынос стопов перед разворотом вниз' });
        }

        // 4) FVG with CE (50%) preference
        var nearestBullFVG = null, nearestBearFVG = null;
        for (var f = 0; f < fvgs.length; f++) {
            if (fvgs[f].type === 'bull' && !nearestBullFVG) nearestBullFVG = fvgs[f];
            if (fvgs[f].type === 'bear' && !nearestBearFVG) nearestBearFVG = fvgs[f];
        }
        if (nearestBullFVG) {
            var inBullFVG = price >= nearestBullFVG.bottom && price <= nearestBullFVG.top;
            var atCE = Math.abs(price - nearestBullFVG.ce) / price * 100 < 0.15;
            if (inBullFVG) {
                bullScore += atCE ? 28 : 20;
                signals.push({
                    key: atCE ? 'smc.bullFVGCE' : 'smc.bullFVG',
                    type: 'bull',
                    text: atCE
                        ? 'Цена у CE бычьего FVG (50%) — лучшая точка входа по Smart Money'
                        : 'Цена в бычьем FVG — зона справедливой стоимости для покупок'
                });
                confluence++;
            } else if (price > nearestBullFVG.top && price < nearestBullFVG.top + atr) {
                bullScore += 8;
                signals.push({ key: 'smc.bullFVGAbove', type: 'bull', text: 'Бычий FVG ниже — магнит для отката и заполнения' });
            }
        }
        if (nearestBearFVG) {
            var inBearFVG = price <= nearestBearFVG.top && price >= nearestBearFVG.bottom;
            var atCEBear = Math.abs(price - nearestBearFVG.ce) / price * 100 < 0.15;
            if (inBearFVG) {
                bearScore += atCEBear ? 28 : 20;
                signals.push({
                    key: atCEBear ? 'smc.bearFVGCE' : 'smc.bearFVG',
                    type: 'bear',
                    text: atCEBear
                        ? 'Цена у CE медвежьего FVG (50%) — лучшая точка входа в продажи'
                        : 'Цена в медвежьем FVG — зона справедливой стоимости для продаж'
                });
                confluence++;
            } else if (price < nearestBearFVG.bottom && price > nearestBearFVG.bottom - atr) {
                bearScore += 8;
                signals.push({ key: 'smc.bearFVGBelow', type: 'bear', text: 'Медвежий FVG выше — магнит для отката вверх' });
            }
        }

        // 5) Order Blocks (fresh + high quality)
        var activeOB = orderBlocks.length ? orderBlocks[0] : null;
        if (activeOB) {
            var inOB = price >= activeOB.bottom * 0.998 && price <= activeOB.top * 1.002;
            var qBoost = Math.min(12, Math.round(activeOB.quality * 4));
            if (activeOB.type === 'bull' && inOB) {
                bullScore += 24 + qBoost;
                signals.push({ key: 'smc.bullOB', type: 'bull', text: 'Цена в бычьем Order Block — институциональная зона спроса' });
                confluence++;
            } else if (activeOB.type === 'bear' && inOB) {
                bearScore += 24 + qBoost;
                signals.push({ key: 'smc.bearOB', type: 'bear', text: 'Цена в медвежьем Order Block — институциональная зона предложения' });
                confluence++;
            } else if (activeOB.type === 'bull' && price > activeOB.top && price < activeOB.top + atr * 0.8) {
                bullScore += 10;
                signals.push({ key: 'smc.bullOBNear', type: 'bull', text: 'Близко к бычьему OB — вероятен возврат в зону спроса' });
            } else if (activeOB.type === 'bear' && price < activeOB.bottom && price > activeOB.bottom - atr * 0.8) {
                bearScore += 10;
                signals.push({ key: 'smc.bearOBNear', type: 'bear', text: 'Близко к медвежьему OB — вероятен возврат в зону предложения' });
            }
        }

        // 6) Breaker Blocks
        if (breakers.length) {
            var br = breakers[0];
            var inBr = price >= br.bottom && price <= br.top;
            if (br.label === 'bullish_breaker' && (inBr || Math.abs(price - br.mid) / price < 0.004)) {
                bullScore += Math.round(18 * br.quality);
                signals.push({
                    key: br.retested ? 'smc.bullBreakerRetest' : 'smc.bullBreaker',
                    type: 'bull',
                    text: br.retested
                        ? 'Bullish Breaker с ретестом — сломанный OB держит как поддержка'
                        : 'Bullish Breaker Block — сломанный OB стал поддержкой'
                });
                confluence++;
            } else if (br.label === 'bearish_breaker' && (inBr || Math.abs(price - br.mid) / price < 0.004)) {
                bearScore += Math.round(18 * br.quality);
                signals.push({
                    key: br.retested ? 'smc.bearBreakerRetest' : 'smc.bearBreaker',
                    type: 'bear',
                    text: br.retested
                        ? 'Bearish Breaker с ретестом — сломанный OB держит как сопротивление'
                        : 'Bearish Breaker Block — сломанный OB стал сопротивлением'
                });
                confluence++;
            }
        }

        // 7) HTF alignment (1h + 4h) — trade with higher timeframe
        if (htfDir1h.direction === 'up') bullScore += 16;
        else if (htfDir1h.direction === 'down') bearScore += 16;
        if (htfDir4h.direction === 'up') bullScore += 14;
        else if (htfDir4h.direction === 'down') bearScore += 14;
        if (htfDir1h.direction === htfDir4h.direction && htfDir1h.direction !== 'sideways') {
            confluence++;
            signals.push({
                key: htfDir1h.direction === 'up' ? 'smc.htfAlignBull' : 'smc.htfAlignBear',
                type: htfDir1h.direction === 'up' ? 'bull' : 'bear',
                text: htfDir1h.direction === 'up'
                    ? '1ч и 4ч согласованы вверх — торгуем в сторону старшего тренда'
                    : '1ч и 4ч согласованы вниз — торгуем в сторону старшего тренда'
            });
        }
        if (htfStruct1h && htfStruct1h.structure === 'bullish') bullScore += 8;
        if (htfStruct1h && htfStruct1h.structure === 'bearish') bearScore += 8;
        if (htfBlocks.length) {
            var htfOB = htfBlocks[0];
            if (htfOB.type === 'bull') {
                bullScore += 12;
                signals.push({ key: 'smc.htfBullOB', type: 'bull', text: 'HTF (1ч) бычий OB подтверждает спрос' });
            } else {
                bearScore += 12;
                signals.push({ key: 'smc.htfBearOB', type: 'bear', text: 'HTF (1ч) медвежий OB подтверждает давление' });
            }
        }

        // 8) Order Flow proxy (body + volume)
        if (flow.bias === 'bull') {
            bullScore += 10 + Math.round(Math.min(8, Math.abs(flow.score) * 20));
            signals.push({ key: 'smc.flowBull', type: 'bull', text: 'Order Flow: доминируют покупатели (тело свечей + объём)' });
        } else if (flow.bias === 'bear') {
            bearScore += 10 + Math.round(Math.min(8, Math.abs(flow.score) * 20));
            signals.push({ key: 'smc.flowBear', type: 'bear', text: 'Order Flow: доминируют продавцы (тело свечей + объём)' });
        }

        // 9) Soft blend with classic indicator bias
        if (baseDirection === 'up') bullScore += Math.round(baseStrength * 0.12);
        else if (baseDirection === 'down') bearScore += Math.round(baseStrength * 0.12);

        // Penalize fighting HTF
        if (htfDir1h.direction === 'up' && bearScore > bullScore) bearScore *= 0.82;
        if (htfDir1h.direction === 'down' && bullScore > bearScore) bullScore *= 0.82;

        var total = bullScore + bearScore || 1;
        var diff = Math.abs(bullScore - bearScore);
        // Stricter threshold when confluence is low
        var needGap = confluence >= 3 ? 6 : confluence >= 2 ? 10 : 14;
        var direction = bullScore > bearScore + needGap ? 'up' : bearScore > bullScore + needGap ? 'down' : 'sideways';

        var strength;
        if (direction !== 'sideways') {
            strength = 48 + (diff / total) * 40 + Math.min(10, confluence * 2.5);
            strength = Math.max(48, Math.min(94, Math.round(strength)));
        } else {
            strength = Math.max(32, Math.min(58, Math.round(50 - (diff / total) * 12)));
        }

        // Build precise narrative
        var summary = '';
        var htfBias = htfDir1h.direction !== 'sideways' ? htfDir1h.direction : htfDir4h.direction;
        if (direction === 'up') {
            if (liq.sweptLow && (nearestBullFVG || (activeOB && activeOB.type === 'bull'))) {
                summary = 'Сценарий Smart Money: снятие ликвидности снизу → возврат в FVG/OB в Discount → движение к BSL. Структура ' +
                    (structure.structure === 'bullish' ? 'бычья' : 'перестраивается вверх') + '.';
            } else if (structure.event === 'choch_bull' || structure.event === 'bos_bull') {
                summary = 'Смена/продолжение структуры вверх. Цель — ликвидность сверху (BSL). Покупки от зон спроса (OB/FVG), не из Premium.';
            } else {
                summary = 'Бычий bias: приоритет — удержание Discount/OB и заполнение FVG с движением к ликвидности сверху. Старший ТФ: ' +
                    (htfBias === 'up' ? 'поддержка роста' : htfBias === 'down' ? 'против HTF — осторожнее' : 'нейтрален') + '.';
            }
        } else if (direction === 'down') {
            if (liq.sweptHigh && (nearestBearFVG || (activeOB && activeOB.type === 'bear'))) {
                summary = 'Сценарий Smart Money: снятие ликвидности сверху → возврат в FVG/OB в Premium → движение к SSL. Структура ' +
                    (structure.structure === 'bearish' ? 'медвежья' : 'перестраивается вниз') + '.';
            } else if (structure.event === 'choch_bear' || structure.event === 'bos_bear') {
                summary = 'Смена/продолжение структуры вниз. Цель — ликвидность снизу (SSL). Продажи от зон предложения (OB/FVG), не из Discount.';
            } else {
                summary = 'Медвежий bias: приоритет — отбой от Premium/OB и заполнение FVG с движением к ликвидности снизу. Старший ТФ: ' +
                    (htfBias === 'down' ? 'подтверждает давление' : htfBias === 'up' ? 'против HTF — осторожнее' : 'нейтрален') + '.';
            }
        } else {
            summary = 'Нет чистого SMC-сигнала: цена между BSL (' + liq.bsl.toFixed(4) + ') и SSL (' + liq.ssl.toFixed(4) +
                '). Ждите снятие ликвидности + подтверждение BOS/CHoCH или вход от OB/FVG с конfluенцией.';
        }

        var entry = price, stop = price, target = price;
        if (direction === 'up') {
            entry = (activeOB && activeOB.type === 'bull') ? activeOB.mid
                : (nearestBullFVG ? nearestBullFVG.ce : Math.max(structure.equilibrium, price - atr * 0.35));
            stop = Math.min(liq.ssl, structure.swingLow) - atr * 0.15;
            target = liq.bsl + atr * 0.05;
        } else if (direction === 'down') {
            entry = (activeOB && activeOB.type === 'bear') ? activeOB.mid
                : (nearestBearFVG ? nearestBearFVG.ce : Math.min(structure.equilibrium, price + atr * 0.35));
            stop = Math.max(liq.bsl, structure.swingHigh) + atr * 0.15;
            target = liq.ssl - atr * 0.05;
        } else {
            stop = liq.ssl - atr * 0.25;
            target = liq.bsl + atr * 0.25;
        }

        // Rank signals: keep best 6, prefer confluence side
        signals.sort(function (a, b) {
            var aw = (direction === 'up' && a.type === 'bull') || (direction === 'down' && a.type === 'bear') ? 1 : 0;
            var bw = (direction === 'up' && b.type === 'bull') || (direction === 'down' && b.type === 'bear') ? 1 : 0;
            return bw - aw;
        });

        return {
            direction: direction,
            strength: strength,
            summary: summary,
            signals: signals.slice(0, 6),
            entry: entry,
            stop: stop,
            target: target,
            liquidity: liq,
            fvgs: fvgs.slice(0, 3),
            orderBlocks: orderBlocks.slice(0, 2),
            breakers: breakers.slice(0, 1),
            htfBias: htfBias,
            bullScore: Math.round(bullScore),
            bearScore: Math.round(bearScore),
            confluence: confluence,
            structure: structure.structure,
            zone: structure.zone,
            event: structure.event
        };
    }

    // Precision trend from chart geometry (structure + EMA ribbon + slope + ADX/MACD/VWAP)
    function computePrecisionTrend(ohlc, extras) {
        extras = extras || {};
        if (!ohlc || ohlc.length < 30) {
            return { direction: 'sideways', strength: 45, confidence: 0, votes: 0 };
        }
        var closes = ohlc.map(function (c) { return c.close; });
        var highs = ohlc.map(function (c) { return c.high; });
        var lows = ohlc.map(function (c) { return c.low; });
        var n = closes.length;
        var price = closes[n - 1];
        var bull = 0, bear = 0, votes = 0;

        // 1) Multi-EMA ribbon (3/8/21/50) — chart trend backbone
        var e3 = ema(closes, 3), e8 = ema(closes, 8), e21 = ema(closes, 21), e50 = ema(closes, 50);
        if (e3 != null && e8 != null && e21 != null) {
            votes++;
            if (e3 > e8 && e8 > e21) bull += 22;
            else if (e3 < e8 && e8 < e21) bear += 22;
            else if (e3 > e21) bull += 8;
            else bear += 8;
            if (e50 != null) {
                if (price > e50 && e21 > e50) bull += 12;
                else if (price < e50 && e21 < e50) bear += 12;
            }
        }

        // 2) Linear regression slope on last 20 closes (normalized by ATR)
        var look = Math.min(20, n);
        var atr = calcATR(ohlc, 14) || Math.abs(price) * 0.01 || 1;
        var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (var i = 0; i < look; i++) {
            var x = i;
            var y = closes[n - look + i];
            sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
        }
        var denom = look * sumXX - sumX * sumX;
        var slope = denom !== 0 ? (look * sumXY - sumX * sumY) / denom : 0;
        var slopeNorm = slope / atr; // ~change per bar in ATRs
        votes++;
        if (slopeNorm > 0.08) bull += 18 + Math.min(10, Math.round(slopeNorm * 40));
        else if (slopeNorm < -0.08) bear += 18 + Math.min(10, Math.round(-slopeNorm * 40));
        else if (slopeNorm > 0.02) bull += 6;
        else if (slopeNorm < -0.02) bear += 6;

        // 3) Swing structure HH/HL vs LH/LL on last ~40 bars
        var struct = detectMarketStructure(ohlc);
        votes++;
        if (struct.structure === 'bullish') bull += 20;
        else if (struct.structure === 'bearish') bear += 20;
        if (struct.event === 'bos_bull' || struct.event === 'choch_bull') bull += 14;
        if (struct.event === 'bos_bear' || struct.event === 'choch_bear') bear += 14;

        // 4) Recent pivot: last 8 vs previous 8 midpoint
        var midNow = 0, midPrev = 0;
        for (var j = 0; j < 8; j++) {
            midNow += (highs[n - 1 - j] + lows[n - 1 - j]) / 2;
            midPrev += (highs[n - 9 - j] + lows[n - 9 - j]) / 2;
        }
        midNow /= 8; midPrev /= 8;
        votes++;
        if (midNow > midPrev * 1.0015) bull += 12;
        else if (midNow < midPrev * 0.9985) bear += 12;

        // 5) ADX / DI confirmation when available
        var adxData = extras.adxData || calcADX(ohlc);
        if (adxData && adxData.adx != null) {
            votes++;
            if (adxData.adx >= 22) {
                if (adxData.bullish) bull += 10 + Math.min(12, Math.round((adxData.adx - 22) * 0.5));
                else bear += 10 + Math.min(12, Math.round((adxData.adx - 22) * 0.5));
            } else {
                // weak trend → damp later via gap threshold
                bull += 2; bear += 2;
            }
        }

        // 6) MACD histogram momentum
        var macdData = extras.macdData || calcMACD(closes);
        if (macdData) {
            votes++;
            if (macdData.crossover || macdData.histogram > 0) bull += macdData.crossover ? 14 : 8;
            if (macdData.crossunder || macdData.histogram < 0) bear += macdData.crossunder ? 14 : 8;
        }

        // 7) VWAP side
        var vwapData = extras.vwapData || calcVWAP(ohlc);
        if (vwapData && vwapData.vwap) {
            votes++;
            if (price > vwapData.vwap) bull += 8;
            else bear += 8;
        }

        // 8) Candle body pressure last 6 bars
        var bodyBull = 0, bodyBear = 0;
        for (var k = n - 6; k < n; k++) {
            var body = ohlc[k].close - ohlc[k].open;
            if (body > 0) bodyBull += body;
            else bodyBear += Math.abs(body);
        }
        votes++;
        if (bodyBull > bodyBear * 1.25) bull += 10;
        else if (bodyBear > bodyBull * 1.25) bear += 10;

        var total = bull + bear || 1;
        var diff = Math.abs(bull - bear);
        var adxWeak = adxData && adxData.adx < 20;
        var needGap = adxWeak ? 16 : (adxData && adxData.adx > 30 ? 8 : 12);
        var direction = bull > bear + needGap ? 'up' : bear > bull + needGap ? 'down' : 'sideways';
        var strength;
        if (direction !== 'sideways') {
            strength = 52 + (diff / total) * 42;
            strength = Math.max(55, Math.min(96, Math.round(strength)));
        } else {
            strength = Math.max(35, Math.min(58, Math.round(50 - (diff / total) * 10)));
        }
        var confidence = Math.max(0, Math.min(100, Math.round((diff / total) * 100)));
        return {
            direction: direction,
            strength: strength,
            confidence: confidence,
            votes: votes,
            bullScore: Math.round(bull),
            bearScore: Math.round(bear),
            slopeNorm: slopeNorm,
            structure: struct.structure
        };
    }

    // --- Main Analysis Function ---

    function analyzeChart(ohlc, timeframe, symbol, htfCache) {
        var closes = ohlc.map(function (c) { return c.close; });
        if (closes.length < RSI_PERIOD + 5) {
            return { direction: 'sideways', strength: 0, reasoning: ['Недостаточно данных'], rsi: 50, trend: 0, horizons: [], indicators: {} };
        }

        var price = closes[closes.length - 1];
        var rsiArr = calculateAllRSI(closes, RSI_PERIOD);
        var rsi = rsiArr[rsiArr.length - 1];

        var macdData = calcMACD(closes);
        var bbData = calcBollingerBands(closes);
        var stochData = calcStochastic(ohlc);
        var adxData = calcADX(ohlc);
        var obvData = calcOBV(ohlc);
        var ichimokuData = calcIchimoku(ohlc);
        var vwapData = calcVWAP(ohlc);
        var volTrend = calcVolumeTrend(ohlc);
        var sma9 = sma(closes, 9), sma21 = sma(closes, 21);

        // SHORT-TERM fast indicators
        var ema3 = ema(closes, 3), ema8 = ema(closes, 8), ema9 = ema(closes, 9);
        var ema50 = ema(closes, 50), ema200 = ema(closes, 200);

        // [FIX #3] ATR with Wilder's smoothing
        var atr = calcATR(ohlc, 14);

        // [NEW #11] ROC acceleration detection
        var roc5 = calcROC(closes, 5);
        var roc10 = calcROC(closes, 10);

        // [NEW #1] RSI Divergence
        var rsiDivergence = detectRSIDivergence(closes, rsiArr, 20);

        // [FIX #2] ADX dynamic weight modifier for trend indicators
        var adxWeight = 1.0;
        if (adxData) {
            if (adxData.adx < 20) adxWeight = 0.6;       // Flat market — reduce trend signal weights
            else if (adxData.adx < 25) adxWeight = 0.8;   // Weak trend
            else if (adxData.adx > 40) adxWeight = 1.3;   // Strong trend — boost trend signals
            else if (adxData.adx > 30) adxWeight = 1.1;   // Moderate trend
        }

        // Score
        var bullScore = 0, bearScore = 0;
        var reasoning = [];
        var indicators = {};

        // [FIX #5] RSI — gradient scoring instead of binary
        if (rsi > RSI_OVERBOUGHT) {
            // Overbought — mean-reversion signal (expect pullback)
            var overshoot = (rsi - RSI_OVERBOUGHT) / 30; // 0..1 scale
            bearScore += 15 + Math.round(overshoot * 10); // 15-25 points
            indicators.RSI = 'bear';
            reasoning.push('RSI ' + rsi.toFixed(0) + ' — перекупленность');
        } else if (rsi < RSI_OVERSOLD) {
            // Oversold — mean-reversion signal (expect bounce)
            var overshoot = (RSI_OVERSOLD - rsi) / 30;
            bullScore += 15 + Math.round(overshoot * 10);
            indicators.RSI = 'bull';
            reasoning.push('RSI ' + rsi.toFixed(0) + ' — перепроданность');
        } else if (rsi >= 65) {
            // Near overbought — weakening bullish
            bearScore += 8;
            indicators.RSI = 'bear';
            reasoning.push('RSI ' + rsi.toFixed(0) + ' — приближается к перекупленности');
        } else if (rsi <= 35) {
            // Near oversold — weakening bearish
            bullScore += 8;
            indicators.RSI = 'bull';
            reasoning.push('RSI ' + rsi.toFixed(0) + ' — приближается к перепроданности');
        } else if (rsi > 55) {
            bullScore += 5 + Math.round((rsi - 55) / 3); // 5-8 points
            indicators.RSI = 'bull';
        } else if (rsi < 45) {
            bearScore += 5 + Math.round((45 - rsi) / 3);
            indicators.RSI = 'bear';
        } else {
            // 45-55 neutral zone — minimal weight
            indicators.RSI = rsi > RSI_MIDLINE ? 'bull' : 'bear';
            if (rsi > RSI_MIDLINE) bullScore += 2; else bearScore += 2;
        }

        // [FIX #1] RSI Divergence (very strong signal)
        if (rsiDivergence.bullish) {
            bullScore += 18;
            reasoning.push('RSI бычья дивергенция — сильный сигнал разворота вверх');
        }
        if (rsiDivergence.bearish) {
            bearScore += 18;
            reasoning.push('RSI медвежья дивергенция — сильный сигнал разворота вниз');
        }

        // MACD — weighted by ADX [FIX #2]
        if (macdData) {
            if (macdData.crossover) {
                bullScore += Math.round(22 * adxWeight);
                indicators.MACD = 'bull';
                reasoning.push('MACD бычий кроссовер');
            } else if (macdData.crossunder) {
                bearScore += Math.round(22 * adxWeight);
                indicators.MACD = 'bear';
                reasoning.push('MACD медвежий кроссовер');
            } else if (macdData.histogram > 0) {
                var macdPts = macdData.histogramRising ? 12 : 7;
                bullScore += Math.round(macdPts * adxWeight);
                indicators.MACD = 'bull';
                if (macdData.histogramRising) reasoning.push('MACD гистограмма растёт');
            } else {
                var macdPts = macdData.histogramFalling ? 12 : 7;
                bearScore += Math.round(macdPts * adxWeight);
                indicators.MACD = 'bear';
                if (macdData.histogramFalling) reasoning.push('MACD гистограмма падает');
            }
        }

        // Bollinger
        if (bbData) {
            if (bbData.pctB > 0.95) { bearScore += 15; indicators.BB = 'bear'; reasoning.push('Цена у верхней Bollinger'); }
            else if (bbData.pctB < 0.05) { bullScore += 15; indicators.BB = 'bull'; reasoning.push('Цена у нижней Bollinger'); }
            else if (bbData.pctB > 0.8) { bearScore += 6; indicators.BB = 'bear'; }
            else if (bbData.pctB < 0.2) { bullScore += 6; indicators.BB = 'bull'; }
            else { indicators.BB = bbData.pctB > 0.5 ? 'bull' : 'bear'; }
            if (bbData.squeeze) reasoning.push('BB сжатие — ожидается импульс');
        }

        // Stochastic (Overbought/Oversold only valid in flat markets or weak trends)
        if (stochData) {
            var isStrongTrend = adxData && adxData.adx > 30; // Ignore extreme stoch readings if trending strongly
            if (stochData.k > 80 && stochData.crossunder && (!isStrongTrend || direction === 'down')) { 
                bearScore += 15; indicators.Stoch = 'bear'; reasoning.push('Stoch кроссовер вниз из 80+'); 
            }
            else if (stochData.k < 20 && stochData.crossover && (!isStrongTrend || direction === 'up')) { 
                bullScore += 15; indicators.Stoch = 'bull'; reasoning.push('Stoch кроссовер вверх из 20-'); 
            }
            else { 
                indicators.Stoch = stochData.k > 50 ? 'bull' : 'bear'; 
                if (stochData.k > 50) bullScore += 4; else bearScore += 4; 
            }
        }

        // ADX [FIX #2] — now contributes to scoring via DI direction
        if (adxData) {
            indicators.ADX = adxData.trending ? 'trend' : 'flat';
            if (adxData.strong) reasoning.push('ADX ' + adxData.adx.toFixed(0) + ' — сильный тренд');
            else if (!adxData.trending) reasoning.push('ADX ' + adxData.adx.toFixed(0) + ' — слабый тренд/флет');
            // +DI vs -DI gives directional bias
            if (adxData.trending) {
                if (adxData.bullish) { bullScore += Math.round(10 * (adxData.adx / 40)); }
                else { bearScore += Math.round(10 * (adxData.adx / 40)); }
            }
        }

        // OBV
        if (obvData) {
            indicators.OBV = obvData.trend === 'up' ? 'bull' : 'bear';
            if (obvData.divergence) reasoning.push('OBV дивергенция с ценой');
            if (obvData.trend === 'up') bullScore += 8; else bearScore += 8;
        }

        // Ichimoku — weighted by ADX [FIX #2] + Chikou [FIX #10]
        if (ichimokuData) {
            if (ichimokuData.aboveCloud) { bullScore += Math.round(20 * adxWeight); indicators.Ichi = 'bull'; }
            else if (ichimokuData.belowCloud) { bearScore += Math.round(20 * adxWeight); indicators.Ichi = 'bear'; }
            else { indicators.Ichi = 'flat'; reasoning.push('Цена внутри облака Ichimoku'); }
            if (ichimokuData.tkCross === 'bull') bullScore += Math.round(10 * adxWeight);
            else if (ichimokuData.tkCross === 'bear') bearScore += Math.round(10 * adxWeight);
            // Chikou Span confirmation
            if (ichimokuData.chikouBull) bullScore += 5;
            else if (ichimokuData.chikouBear) bearScore += 5;
        }

        // VWAP
        if (vwapData) {
            indicators.VWAP = vwapData.above ? 'bull' : 'bear';
            var vwapDev = Math.abs(vwapData.deviation);
            var vwapWeight = vwapDev > 1 ? 10 : vwapDev > 0.5 ? 8 : 5;
            if (vwapData.above) bullScore += vwapWeight; else bearScore += vwapWeight;
        }

        // SMA — weighted by ADX [FIX #2]
        if (sma9 != null && sma21 != null) {
            if (sma9 > sma21) { bullScore += Math.round(15 * adxWeight); indicators.SMA = 'bull'; }
            else { bearScore += Math.round(15 * adxWeight); indicators.SMA = 'bear'; }
        }

        // EMA — weighted by ADX [FIX #2]
        if (ema50 != null && ema200 != null) {
            if (ema50 > ema200) {
                bullScore += Math.round(25 * adxWeight); // Macro trend is critical
                indicators.EMA = 'golden';
                reasoning.push('EMA50 > EMA200 — золотой крест');
            } else {
                bearScore += Math.round(25 * adxWeight);
                indicators.EMA = 'death';
                reasoning.push('EMA50 < EMA200 — крест смерти');
            }
        }

        // ═══════════════════════════════════════════════════════════
        // SHORT-TERM FAST INDICATORS (react to current price action)
        // These are critical for catching drops/rises happening NOW
        // ═══════════════════════════════════════════════════════════

        var shortBullPts = 0, shortBearPts = 0;

        // [v2.1] SHORT EMA CROSSOVER (EMA3 vs EMA8) — reacts in 3-8 candles
        if (ema3 != null && ema8 != null) {
            var emaCrossDiff = (ema3 - ema8) / (atr || price * 0.01) * 100;
            if (ema3 > ema8) {
                var shortEmaPts = Math.min(12, Math.round(5 + Math.abs(emaCrossDiff) * 1.5)); // Reduced impact
                bullScore += shortEmaPts; shortBullPts += shortEmaPts;
                indicators.EMAf = 'bull';
                if (emaCrossDiff > 5) reasoning.push('EMA3 > EMA8 — локально вверх');
            } else {
                var shortEmaPts = Math.min(12, Math.round(5 + Math.abs(emaCrossDiff) * 1.5));
                bearScore += shortEmaPts; shortBearPts += shortEmaPts;
                indicators.EMAf = 'bear';
                if (emaCrossDiff < -5) reasoning.push('EMA3 < EMA8 — локально вниз');
            }
        }

        // [v2.1] PRICE VS SHORT EMA — if price is below/above EMA9
        if (ema9 != null && atr > 0) {
            var priceVsEma9 = (price - ema9) / atr;
            if (priceVsEma9 < -0.3) {
                var pvePts = Math.min(15, Math.round(8 + Math.abs(priceVsEma9) * 4));
                bearScore += pvePts; shortBearPts += pvePts;
                indicators.PvE = 'bear';
                reasoning.push('Цена ниже EMA9 на ' + (Math.abs(priceVsEma9)).toFixed(1) + ' ATR');
            } else if (priceVsEma9 > 0.3) {
                var pvePts = Math.min(15, Math.round(8 + priceVsEma9 * 4));
                bullScore += pvePts; shortBullPts += pvePts;
                indicators.PvE = 'bull';
                reasoning.push('Цена выше EMA9 на ' + priceVsEma9.toFixed(1) + ' ATR');
            } else {
                indicators.PvE = priceVsEma9 > 0 ? 'bull' : 'bear';
            }
        }

        // [v2.1] CONSECUTIVE CANDLE DIRECTION — 3+ same-direction candles
        if (ohlc.length >= 5) {
            var bearStreak = 0, bullStreak = 0;
            for (var ci = ohlc.length - 1; ci >= Math.max(0, ohlc.length - 6); ci--) {
                var cBody = Math.abs(ohlc[ci].close - ohlc[ci].open);
                var isLive = (ci === ohlc.length - 1);
                
                // Allow live candle minor fluctuations to not break streaks
                if (isLive && atr > 0 && cBody < atr * 0.25) {
                    continue; // Skip almost flat live candle
                }

                if (ohlc[ci].close < ohlc[ci].open) {
                    if (bullStreak > 0) {
                        if (isLive) continue; // Don't let a live micro-counter tick break the history
                        break; 
                    }
                    bearStreak++;
                } else if (ohlc[ci].close > ohlc[ci].open) {
                    if (bearStreak > 0) {
                        if (isLive) continue;
                        break;
                    }
                    bullStreak++;
                } else {
                    if (!isLive) break; // Doji breaks streak
                }
            }
            if (bearStreak >= 3) {
                var streakPts = Math.min(15, Math.round(6 + bearStreak * 2)); // Reduced max impact
                bearScore += streakPts; shortBearPts += streakPts;
                indicators.Candles = 'bear';
                reasoning.push(bearStreak + ' красных свечей подряд');
            } else if (bullStreak >= 3) {
                var streakPts = Math.min(15, Math.round(6 + bullStreak * 2));
                bullScore += streakPts; shortBullPts += streakPts;
                indicators.Candles = 'bull';
                reasoning.push(bullStreak + ' зелёных свечей подряд');
            } else {
                indicators.Candles = bearStreak > 0 ? 'bear' : bullStreak > 0 ? 'bull' : 'flat';
            }
        }

        // [FIX #4] Momentum — normalized to ATR
        var shortMomentum = 0;
        if (closes.length >= 6 && atr > 0) {
            var momAbs = closes[closes.length - 1] - closes[closes.length - 6];
            var momNorm = momAbs / atr; // Normalized to ATR units
            var momPct = (momAbs / closes[closes.length - 6]) * 100;
            if (momNorm > 0.5) {
                var momScore = Math.min(12, Math.round(5 + momNorm * 2)); // Reduced
                bullScore += momScore; shortBullPts += momScore;
                reasoning.push('Моментум +' + momPct.toFixed(2) + '% (' + momNorm.toFixed(1) + ' ATR)');
            } else if (momNorm < -0.5) {
                var momScore = Math.min(12, Math.round(5 + Math.abs(momNorm) * 2));
                bearScore += momScore; shortBearPts += momScore;
                reasoning.push('Моментум ' + momPct.toFixed(2) + '% (' + momNorm.toFixed(1) + ' ATR)');
            }
            // Short momentum for horizon calculations (3 candles)
            if (closes.length >= 4) {
                shortMomentum = (closes[closes.length - 1] - closes[closes.length - 4]) / (atr || 1);
            }
        }

        // [NEW #11] ROC acceleration/deceleration
        if (roc5 != null && roc10 != null && atr > 0) {
            var roc5norm = roc5 / (atr / price * 100);
            var roc10norm = roc10 / (atr / price * 100);
            if (roc5norm > 0 && roc10norm > 0 && roc5norm > roc10norm * 1.2) {
                bullScore += 8;
                indicators.ROC = 'bull';
                reasoning.push('ROC ускорение тренда вверх');
            } else if (roc5norm < 0 && roc10norm < 0 && roc5norm < roc10norm * 1.2) {
                bearScore += 8;
                indicators.ROC = 'bear';
                reasoning.push('ROC ускорение тренда вниз');
            } else if (roc5norm > 0 && roc5norm < roc10norm * 0.5 && roc10norm > 0) {
                // Decelerating uptrend
                bearScore += 5;
                indicators.ROC = 'bear';
                reasoning.push('ROC замедление восходящего тренда');
            } else if (roc5norm < 0 && roc5norm > roc10norm * 0.5 && roc10norm < 0) {
                // Decelerating downtrend
                bullScore += 5;
                indicators.ROC = 'bull';
                reasoning.push('ROC замедление нисходящего тренда');
            } else {
                indicators.ROC = roc5 > 0 ? 'bull' : 'bear';
            }
        }

        // [FIX #6] Volume modifies predominant signal
        if (volTrend) {
            if (volTrend.rising) {
                reasoning.push('Объём растёт ×' + volTrend.ratio.toFixed(1));
                // Boost the predominant direction
                var volBoost = Math.round(Math.max(bullScore, bearScore) * 0.15);
                if (bullScore > bearScore) bullScore += volBoost;
                else if (bearScore > bullScore) bearScore += volBoost;
            } else if (volTrend.falling) {
                reasoning.push('Объём падает ×' + volTrend.ratio.toFixed(1));
                // Reduce conviction in predominant direction
                var volReduction = Math.round(Math.abs(bullScore - bearScore) * 0.10);
                if (bullScore > bearScore) bullScore -= volReduction;
                else if (bearScore > bullScore) bearScore -= volReduction;
            }
        }

        // [FIX #9] Direction — relative threshold + HYSTERESIS (ужесточено для стабильности)
        var total = bullScore + bearScore || 1;
        var diff = Math.abs(bullScore - bearScore);

        // Порог 18% — меньше ложных переключений, более чёткий сигнал
        var relativeThreshold = Math.max(18, total * 0.18);

        // Determine raw direction
        var rawDirection = 'sideways';
        if (bullScore >= bearScore + relativeThreshold) {
            rawDirection = 'up';
        } else if (bearScore >= bullScore + relativeThreshold) {
            rawDirection = 'down';
        }

        // Hysteresis: prevent dropping into sideways or flipping too easily (усилен буфер)
        var prevDir = _prevDirection[symbol];
        if (prevDir && prevDir.direction !== rawDirection && prevDir.direction !== 'sideways') {
            var dropThreshold = relativeThreshold * 0.4; // 40% буфер удержания тренда

            if (prevDir.direction === 'up' && bullScore >= bearScore - dropThreshold) {
                rawDirection = 'up';
            } else if (prevDir.direction === 'down' && bearScore >= bullScore - dropThreshold) {
                rawDirection = 'down';
            }
        }

        var direction = rawDirection;
        var strength = 50;

        // Confidence calculation (Bounded linear scaling)
        if (direction === 'up' || direction === 'down') {
            strength = 50 + (diff / Math.max(1, total)) * 45;
        } else {
            strength = 50 - (diff / Math.max(1, total)) * 50;
        }
        
        strength = Math.max(5, Math.min(95, Math.round(strength)));

        // Save direction for next call
        var memoryDir = rawDirection !== 'sideways' ? rawDirection : (prevDir ? prevDir.direction : 'sideways');
        _prevDirection[symbol] = { direction: memoryDir, timestamp: Date.now() };

        // Reversal detection (enhanced with RSI divergence [FIX #1])
        var reversalReasons = [];
        if (rsiArr.length >= 4) {
            var rsiPrev = rsiArr[rsiArr.length - 3];
            if (rsiPrev > RSI_OVERBOUGHT && rsi < RSI_OVERBOUGHT) { reversalReasons.push('RSI выходит из перекупленности'); }
            if (rsiPrev < RSI_OVERSOLD && rsi > RSI_OVERSOLD) { reversalReasons.push('RSI выходит из перепроданности'); }
        }
        if (rsiDivergence.bullish && direction === 'down') { reversalReasons.push('RSI бычья дивергенция против нисходящего тренда'); }
        if (rsiDivergence.bearish && direction === 'up') { reversalReasons.push('RSI медвежья дивергенция против восходящего тренда'); }
        if (macdData && macdData.crossover && direction === 'down') { reversalReasons.push('MACD бычий кроссовер против тренда'); }
        if (macdData && macdData.crossunder && direction === 'up') { reversalReasons.push('MACD медвежий кроссовер против тренда'); }
        if (obvData && obvData.divergence) { reversalReasons.push('OBV дивергенция с ценой'); }

        // ═══════════════════════════════════════════════════════════
        // EARLY WARNING SYSTEM — detects reversal BEFORE it happens
        // ═══════════════════════════════════════════════════════════
        var earlyWarning = null;
        var earlyReasons = [];
        var earlyScore = 0;  // 0-100 scored likelihood of imminent reversal

        if (direction !== 'sideways') {
            var counterDir = direction === 'up' ? 'down' : 'up';

            // 1. Momentum weakening (trend losing steam)
            if (closes.length >= 6 && atr > 0) {
                var mom3 = (closes[closes.length - 1] - closes[closes.length - 4]) / atr;
                var mom6 = (closes[closes.length - 1] - closes[closes.length - 7 < 0 ? 0 : closes.length - 7]) / atr;
                if (direction === 'up' && mom3 < 0 && mom6 > 0) {
                    earlyScore += 25;
                    earlyReasons.push('Моментум разворачивается вниз');
                } else if (direction === 'down' && mom3 > 0 && mom6 < 0) {
                    earlyScore += 25;
                    earlyReasons.push('Моментум разворачивается вверх');
                }
            }

            // 2. RSI Divergence against current direction
            if (rsiDivergence.bearish && direction === 'up') {
                earlyScore += 30;
                earlyReasons.push('RSI медвежья дивергенция');
            } else if (rsiDivergence.bullish && direction === 'down') {
                earlyScore += 30;
                earlyReasons.push('RSI бычья дивергенция');
            }

            // 3. MACD histogram turning against trend
            if (macdData) {
                if (direction === 'down' && macdData.histogram > 0) {
                    earlyScore += 15;
                    earlyReasons.push('MACD гистограмма положительная');
                }
                if (direction === 'up' && macdData.histogramFalling) {
                    earlyScore += 10;
                    earlyReasons.push('MACD гистограмма падает');
                } else if (direction === 'down' && macdData.histogramRising) {
                    earlyScore += 10;
                    earlyReasons.push('MACD гистограмма растёт');
                }
            }

            // 4. Short EMA cross against direction
            if (ema3 != null && ema8 != null) {
                if (direction === 'up' && ema3 < ema8) {
                    earlyScore += 20;
                    earlyReasons.push('EMA3 < EMA8 против тренда');
                } else if (direction === 'down' && ema3 > ema8) {
                    earlyScore += 20;
                    earlyReasons.push('EMA3 > EMA8 против тренда');
                }
            }

            // 5. Candle streak against direction
            if (indicators.Candles) {
                if (direction === 'up' && indicators.Candles === 'bear') {
                    earlyScore += 20;
                    earlyReasons.push('Серия красных свечей против тренда');
                } else if (direction === 'down' && indicators.Candles === 'bull') {
                    earlyScore += 20;
                    earlyReasons.push('Серия зелёных свечей против тренда');
                }
            }

            // 6. Stochastic overbought/oversold in trend direction
            if (stochData) {
                if (direction === 'up' && stochData.k > 80) {
                    earlyScore += 10;
                    earlyReasons.push('Stochastic > 80 — перекупленность');
                } else if (direction === 'down' && stochData.k < 20) {
                    earlyScore += 10;
                    earlyReasons.push('Stochastic < 20 — перепроданность');
                }
            }

            // 7. Narrowing score gap (bull/bear scores converging)
            var scoreRatio = Math.min(bullScore, bearScore) / Math.max(bullScore, bearScore);
            if (scoreRatio > 0.75) {
                earlyScore += 15;
                earlyReasons.push('Силы быков/медведей почти равны');
            }

            earlyScore = Math.min(95, earlyScore);

            if (earlyScore >= 35) {
                earlyWarning = {
                    direction: counterDir,
                    score: earlyScore,
                    reasons: earlyReasons
                };

                // Limit max confidence if early warning is strong, but do NOT flip the trend or cause 5% drops
                if (earlyScore >= 50) {
                    var penalty = Math.min(15, earlyScore * 0.2);
                    strength = Math.max(45, strength - penalty);
                }
            }
        }

        // Volatility warning (BB squeeze)
        var volatilityWarning = false, volatilityReasons = [];
        if (bbData && bbData.squeeze) { volatilityWarning = true; volatilityReasons.push('BB \u0441\u0436\u0430\u0442\u0438\u0435 \u2014 \u043e\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044f \u0438\u043c\u043f\u0443\u043b\u044c\u0441'); }

        // Horizons (enhanced [FIX #7, #8])
        var tfMinutes = tfToMinutes(timeframe);
        var horizons = PREDICTION_HORIZONS.map(function (hz) {
            var candlesAhead = Math.max(1, Math.round((hz.hours * 60) / tfMinutes));
            var longBias = Math.min(1, hz.hours / 12);
            var hBull = bullScore, hBear = bearScore;

            // [v2.2] Short-term horizons decouple from long-term scores
            // They rely mostly on shortBullPts and shortBearPts (EMA3, Candlestick streak, etc)
            if (hz.hours <= 0.25) { // 1m, 5m, 10m, 15m
                var shortWeight = 1 + (0.25 - hz.hours) * 4; // 1m gets heavily boosted relative to local noise
                var longWeight = 0.35 + (hz.hours * 2); // INCREASED BASE LONG WEIGHT (min 35%) so macro trend grounds short TFs
                hBull = (shortBullPts * shortWeight) + (bullScore * longWeight);
                hBear = (shortBearPts * shortWeight) + (bearScore * longWeight);
            }

            // [FIX #7] Short-term horizons: boost short momentum influence further
            if (hz.hours <= 10 / 60 && shortMomentum !== 0) {
                var shortBoost = Math.min(25, Math.abs(shortMomentum) * 15);
                if (shortMomentum > 0.3) hBull += shortBoost;
                else if (shortMomentum < -0.3) hBear += shortBoost;
            }

            // [v2.3] Inject Early Warning into horizons (closest horizons get strongest boost)
            if (earlyWarning && earlyWarning.score >= 35) {
                // Dropoff: 1m gets 100% of score, 1h gets ~50%, 4h gets ~0%
                var ewBoost = earlyWarning.score * Math.max(0, 1.2 - hz.hours * 0.5); 
                if (ewBoost > 0) {
                    if (earlyWarning.direction === 'up') hBull += ewBoost;
                    else if (earlyWarning.direction === 'down') hBear += ewBoost;
                }
            }

            // Higher-TF confirmation (boosted for longer horizons)
            if (htfCache) {
                var higherTFs = HIGHER_TF_MAP[timeframe] || [];
                for (var t = 0; t < higherTFs.length; t++) {
                    var htfOhlc = htfCache[higherTFs[t]];
                    if (!htfOhlc || htfOhlc.length < 30) continue;
                    var htfCloses = htfOhlc.map(function (c) { return c.close; });
                    var htfRsi = calculateAllRSI(htfCloses, RSI_PERIOD);
                    var htfRsiVal = htfRsi.length > 0 ? htfRsi[htfRsi.length - 1] : 50;
                    var htfSma9 = sma(htfCloses, 9), htfSma21 = sma(htfCloses, 21);
                    // [FIX #7] Increase HTF weight for longer horizons (was 8, scaled properly now)
                    var htfWeight = 8 + (12 * longBias); 
                    if (htfRsiVal > RSI_MIDLINE) hBull += htfWeight; else hBear += htfWeight;
                    if (htfSma9 != null && htfSma21 != null) { if (htfSma9 > htfSma21) hBull += htfWeight; else hBear += htfWeight; }
                }
            }

            // Apply reversal adjustments
            if (reversalReasons.length > 0 && hz.hours >= 0.25) {
                var reversalStrength = Math.min(0.85, reversalReasons.length * 0.3);
                var horizonFactor = Math.min(1, hz.hours / 4);
                var reduction = reversalStrength * horizonFactor;
                if (hBull > hBear) {
                    hBull -= (hBull - hBear) * reduction;
                } else {
                    hBear -= (hBear - hBull) * reduction;
                }
            }

            // Volatility warning (BB squeeze): widen uncertainty on longer horizons
            if (volatilityWarning && hz.hours >= 4) {
                var vDiff = Math.abs(hBull - hBear);
                if (hBull > hBear) hBull -= vDiff * 0.1;
                else hBear -= vDiff * 0.1;
            }

            // [FIX #9] Relative threshold for horizon direction (ужесточено)
            var hTotal = hBull + hBear || 1;
            var hDir = 'sideways';
            var hDiff = Math.abs(hBull - hBear);
            var hThreshold = Math.max(14, hTotal * 0.14);
            var hStr = hDiff / hTotal * 100;

            var hRawDir = 'sideways';
            if (hBull > hBear + hThreshold) hRawDir = 'up';
            else if (hBear > hBull + hThreshold) hRawDir = 'down';

            // [FIX] Horizon hysteresis
            var prevHz = (_prevHorizons[symbol] && _prevHorizons[symbol][hz.label]) || null;
            if (prevHz && prevHz.direction !== hRawDir && prevHz.direction !== 'sideways') {
                var hDropThreshold = hThreshold * 0.3;
                if (prevHz.direction === 'up' && hBull >= hBear - hDropThreshold) {
                    hRawDir = 'up';
                } else if (prevHz.direction === 'down' && hBear >= hBull - hDropThreshold) {
                    hRawDir = 'down';
                }
            }

            hDir = hRawDir;
            if (hDir === 'up' || hDir === 'down') {
                hStr = 50 + (hDiff / Math.max(1, hTotal)) * 45;
            } else {
                hStr = 50 - (hDiff / Math.max(1, hTotal)) * 50;
            }

            hStr = Math.max(5, Math.min(95, Math.round(hStr)));

            // Save to memory
            if (!_prevHorizons[symbol]) _prevHorizons[symbol] = {};
            var hMemDir = hRawDir !== 'sideways' ? hRawDir : (prevHz ? prevHz.direction : 'sideways');
            _prevHorizons[symbol][hz.label] = { direction: hMemDir, timestamp: Date.now() };

            var rangeMultiplier = Math.sqrt(candlesAhead);
            var rangeDelta = atr * rangeMultiplier;

            // [FIX #8] Directional range bias — shift center based on direction & strength
            var dirBias = 0;
            if (hDir === 'up') {
                dirBias = rangeDelta * (hStr / 100) * 0.35; // Shift range upward
            } else if (hDir === 'down') {
                dirBias = -rangeDelta * (hStr / 100) * 0.35; // Shift range downward
            }

            return {
                label: hz.label, hours: hz.hours, direction: hDir, strength: Math.round(hStr),
                priceLow: price + dirBias - rangeDelta,
                priceHigh: price + dirBias + rangeDelta
            };
        });

        // Show reversal warning ONLY if the reversal signals actually changed at least one horizon
        var reversalWarning = false;
        if (reversalReasons.length > 0) {
            for (var h = 0; h < horizons.length; h++) {
                if (horizons[h].direction !== direction) {
                    reversalWarning = true;
                    break;
                }
            }
        }

        // ═══════════════════════════════════════════════════════════
        // ДОЛГОСРОЧНЫЙ ПРОГНОЗ (4ч, 1д, 1нед) из старших таймфреймов
        // ═══════════════════════════════════════════════════════════
        var longTermHorizons = [];
        for (var lt = 0; lt < LONG_TERM_LABELS.length; lt++) {
            var ltf = LONG_TERM_LABELS[lt].tf;
            var ltl = LONG_TERM_LABELS[lt].label;
            var htfOhlc = htfCache ? htfCache[ltf] : null;
            if (!htfOhlc || htfOhlc.length < 30) {
                longTermHorizons.push({ label: ltl, direction: 'sideways', strength: 50, priceLow: price, priceHigh: price });
                continue;
            }
            var htfRes = computeHTFDirection(htfOhlc);
            var ltp = htfOhlc[htfOhlc.length - 1].close;
            var ltatr = calcATR(htfOhlc, 14);
            var ltRange = ltatr * 1.5;
            longTermHorizons.push({
                label: ltl,
                direction: htfRes.direction,
                strength: htfRes.strength,
                priceLow: ltp - ltRange,
                priceHigh: ltp + ltRange,
                rsi: htfRes.rsi
            });
        }

        var chartTrend = computePrecisionTrend(ohlc, {
            adxData: adxData,
            macdData: macdData,
            vwapData: vwapData
        });

        // Chart-geometry trend can override weak / conflicting classic bias
        if (chartTrend && chartTrend.direction !== 'sideways') {
            if (direction === 'sideways' || strength < 58) {
                direction = chartTrend.direction;
                strength = Math.max(strength, chartTrend.strength);
                reasoning.unshift(chartTrend.direction === 'up'
                    ? 'График: точный тренд вверх (EMA-лента + структура + наклон)'
                    : 'График: точный тренд вниз (EMA-лента + структура + наклон)');
            } else if (chartTrend.direction === direction) {
                strength = Math.min(96, Math.round(strength + 3 + chartTrend.confidence * 0.04));
            } else if (chartTrend.confidence >= 55 && chartTrend.strength >= 70 && strength < 70) {
                direction = chartTrend.direction;
                strength = Math.round((strength + chartTrend.strength) / 2);
                reasoning.unshift(chartTrend.direction === 'up'
                    ? 'График перевешивает: подтверждённый восходящий тренд'
                    : 'График перевешивает: подтверждённый нисходящий тренд');
            }
        }

        var smcForecast = analyzeSMC(ohlc, htfCache, price, atr, direction, Math.round(strength));

        // Blend strong SMC confluence into primary forecast & short horizons
        if (smcForecast && smcForecast.confluence >= 2 && smcForecast.direction !== 'sideways') {
            if (smcForecast.direction === direction) {
                strength = Math.min(95, Math.round(strength + 4 + smcForecast.confluence));
            } else if (smcForecast.confluence >= 3 && smcForecast.strength >= 62) {
                // High-confluence SMC can override weak classic bias
                if (strength < 58 || direction === 'sideways') {
                    direction = smcForecast.direction;
                    strength = Math.max(strength, Math.min(88, smcForecast.strength - 2));
                    reasoning.unshift(smcForecast.direction === 'up'
                        ? 'SMC-конfluence подтверждает рост (структура/OB/FVG/ликвидность)'
                        : 'SMC-конfluence подтверждает снижение (структура/OB/FVG/ликвидность)');
                }
            }
            // Align nearest horizons with SMC when confluence is high
            for (var hi = 0; hi < horizons.length; hi++) {
                if (horizons[hi].hours <= 1 && smcForecast.confluence >= 3) {
                    if (horizons[hi].direction !== smcForecast.direction && horizons[hi].direction !== 'sideways') {
                        // Soft pull toward SMC
                        horizons[hi].strength = Math.max(40, horizons[hi].strength - 8);
                    } else if (horizons[hi].direction === smcForecast.direction) {
                        horizons[hi].strength = Math.min(95, horizons[hi].strength + 5);
                    } else if (horizons[hi].direction === 'sideways') {
                        horizons[hi].direction = smcForecast.direction;
                        horizons[hi].strength = Math.max(horizons[hi].strength, Math.min(80, smcForecast.strength - 5));
                    }
                }
            }
        }

        return {
            direction: direction, strength: Math.round(strength), reasoning: reasoning, rsi: rsi,
            trend: bullScore - bearScore,
            chartTrend: chartTrend,
            reversalWarning: reversalWarning,
            reversalReasons: reversalReasons,
            volatilityWarning: volatilityWarning && volatilityReasons.length > 0,
            volatilityReasons: volatilityReasons,
            horizons: horizons, indicators: indicators, price: price, atr: atr,
            adx: adxData ? adxData.adx : 0, bbSqueeze: bbData ? bbData.squeeze : false,
            rsiDivergence: rsiDivergence,
            bullScore: bullScore, bearScore: bearScore,
            earlyWarning: earlyWarning,
            longTermHorizons: longTermHorizons,
            smcForecast: smcForecast,
            timeframe: timeframe
        };
    }

    // Calculate RSI from separate OHLC data (e.g. 5m candles)
    function calcRSIFromOHLC(ohlc, period) {
        if (!ohlc || ohlc.length < period + 1) return null;
        var closes = ohlc.map(function (c) { return c.close; });
        var rsiArr = calculateAllRSI(closes, period);
        return rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : null;
    }

    // --- Long-term direction from HTF OHLC — structure + trend + RSI
    function computeHTFDirection(ohlc) {
        if (!ohlc || ohlc.length < RSI_PERIOD + 21) return { direction: 'sideways', strength: 50 };
        var closes = ohlc.map(function (c) { return c.close; });
        var rsiArr = calculateAllRSI(closes, RSI_PERIOD);
        var rsi = rsiArr[rsiArr.length - 1];
        var sma9 = sma(closes, 9), sma21 = sma(closes, 21);
        var ema50 = ema(closes, 50), ema200 = ema(closes, 200);
        var struct = detectMarketStructure(ohlc);
        var bull = 0, bear = 0;
        if (rsi > 55) bull += 22; else if (rsi < 45) bear += 22;
        else if (rsi > 50) bull += 8; else bear += 8;
        if (sma9 != null && sma21 != null) { if (sma9 > sma21) bull += 22; else bear += 22; }
        if (ema50 != null && ema200 != null) { if (ema50 > ema200) bull += 26; else bear += 26; }
        if (struct.structure === 'bullish') bull += 18;
        else if (struct.structure === 'bearish') bear += 18;
        if (struct.event === 'bos_bull' || struct.event === 'choch_bull') bull += 12;
        if (struct.event === 'bos_bear' || struct.event === 'choch_bear') bear += 12;
        var total = bull + bear || 1;
        var diff = Math.abs(bull - bear);
        var dir = bull > bear + 14 ? 'up' : bear > bull + 14 ? 'down' : 'sideways';
        var str = dir !== 'sideways' ? 50 + (diff / total) * 45 : 50 - (diff / total) * 30;
        str = Math.max(10, Math.min(92, Math.round(str)));
        return { direction: dir, strength: str, rsi: rsi, structure: struct.structure };
    }

    // Public API
    return {
        analyzeChart: analyzeChart,
        analyzeSMC: analyzeSMC,
        computePrecisionTrend: computePrecisionTrend,
        calculateAllRSI: calculateAllRSI,
        calcRSIFromOHLC: calcRSIFromOHLC,
        PREDICTION_HORIZONS: PREDICTION_HORIZONS,
        LONG_TERM_LABELS: LONG_TERM_LABELS,
        HIGHER_TF_MAP: HIGHER_TF_MAP,
        tfToMinutes: tfToMinutes
    };

})();
