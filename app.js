// ╔══════════════════════════════════════════════════════════════════╗
// ║  APP.JS — FuturesTerminal App Logic                        ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    // Minimal polyfills for older mobile WebViews (~2015–2017)
    if (!Array.prototype.find) {
        Array.prototype.find = function (predicate) {
            if (this == null) throw new TypeError('Array.prototype.find called on null or undefined');
            var list = Object(this);
            var length = list.length >>> 0;
            for (var i = 0; i < length; i++) {
                var value = list[i];
                if (predicate.call(arguments[1], value, i, list)) return value;
            }
            return undefined;
        };
    }
    if (!String.prototype.endsWith) {
        String.prototype.endsWith = function (search, thisLen) {
            var str = String(this);
            if (thisLen === undefined || thisLen > str.length) thisLen = str.length;
            return str.substring(thisLen - search.length, thisLen) === search;
        };
    }
    if (typeof window.fetch !== 'function') {
        window.fetch = function (url, options) {
            options = options || {};
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open(options.method || 'GET', url, true);
                if (options.headers) {
                    var keys = Object.keys(options.headers);
                    for (var i = 0; i < keys.length; i++) {
                        xhr.setRequestHeader(keys[i], options.headers[keys[i]]);
                    }
                }
                xhr.onload = function () {
                    var responseText = xhr.responseText;
                    resolve({
                        ok: xhr.status >= 200 && xhr.status < 300,
                        status: xhr.status,
                        json: function () {
                            return Promise.resolve(JSON.parse(responseText));
                        },
                        text: function () {
                            return Promise.resolve(responseText);
                        }
                    });
                };
                xhr.onerror = function () { reject(new TypeError('Network request failed')); };
                xhr.send(options.body || null);
            });
        };
    }
    if (typeof window.Promise === 'undefined') {
        console.warn('Promise is not supported in this browser');
    }

    // === STATE ===
    var SYMBOL_STORAGE = 'ft_selected_symbol';
    var coins = [];
    var filteredCoins = [];
    var selectedSymbol = null;

    function getSavedSymbol() {
        try { return localStorage.getItem(SYMBOL_STORAGE) || ''; } catch (e) { return ''; }
    }

    function saveSelectedSymbol(symbol) {
        try {
            if (symbol) localStorage.setItem(SYMBOL_STORAGE, symbol);
        } catch (e) {}
    }

    function pickDefaultSymbol(preferred) {
        if (preferred && coins.some(function (c) { return c.symbol === preferred; })) {
            return preferred;
        }
        if (coins.some(function (c) { return c.symbol === 'BTC'; })) {
            return 'BTC';
        }
        return coins.length ? coins[0].symbol : null;
    }
    var currentSort = 'volume';
    var soundEnabled = false;
    var watchlistVisible = false;
    var tvWidget = null;
    var analysisCache = {};
    var lastDirections = {}; // for sound alerts: { symbol: 'up'|'down'|'sideways' }
    var watchlistUpdateTimer = null;
    var multiTFMode = false; // false = single chart, true = 4-panel grid
    var aiAnalysisGen = 0;
    var aiAnalysisInFlight = false;

    function isTabVisible() {
        return typeof document.hidden === 'undefined' || !document.hidden;
    }

    function getTvLocale() {
        var lang = 'ru';
        try { lang = (currentAppLang || localStorage.getItem('ft_lang') || 'ru'); } catch (e) {}
        return (lang === 'ru') ? 'ru' : 'en';
    }

    // === ACCESS (free local terminal — no auth / payment backend) ===
    var accessState = { ready: true, isPaid: true, demoCreditsLeft: 999, uid: null, user: null };

    function hasDemoParam() {
        try { return window.location.search.match(/[?&]demo=1/); } catch (e) { return false; }
    }

    function enforceAccessGateWhenReady() {
        if (hasDemoParam()) {
            try {
                var cleanUrl = new URL(window.location.href);
                cleanUrl.searchParams.delete('demo');
                window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search);
            } catch (e) {}
        }
        return Promise.resolve(true);
    }

    // === EMULATOR STATE ===
    var DEMO_START_BALANCE = 10000;
    var TAKER_FEE_RATE = 0.0004; // 0.04%
    var demoState = {
        balance: DEMO_START_BALANCE,
        activePositions: [], // { id, symbol, type: 'LONG'|'SHORT', leverage, margin, volume, entryPrice, fee, openTime }
        history: [] // { id, symbol, type, leverage, margin, volume, entryPrice, exitPrice, fee, pnl, openTime, closeTime }
    };
    var emulatorVisible = false;
    var historyVisible = false;
    var currentLeverage = 20;
    var currentMargin = 100;
    var priceUpdateInterval = null;

    // === WATCHLIST (localStorage) ===
    function getWatchlist() {
        try { return JSON.parse(localStorage.getItem('sb_watchlist') || '[]'); } catch (e) { return []; }
    }
    function saveWatchlist(list) {
        localStorage.setItem('sb_watchlist', JSON.stringify(list));
        updateWatchlistUI();
    }
    function isWatched(symbol) { return getWatchlist().indexOf(symbol) !== -1; }
    function addWatch(symbol) {
        var wl = getWatchlist();
        if (wl.indexOf(symbol) === -1) { wl.push(symbol); saveWatchlist(wl); }
    }
    function removeWatch(symbol) {
        var wl = getWatchlist().filter(function (s) { return s !== symbol; });
        saveWatchlist(wl);
    }

    // === EMULATOR (localStorage) ===
    function loadDemoState() {
        try {
            var saved = localStorage.getItem('ft_demo_state');
            if (saved) {
                demoState = JSON.parse(saved);
                // Ensure arrays exist
                demoState.activePositions = demoState.activePositions || [];
                demoState.history = demoState.history || [];
            }
        } catch (e) { console.error("Error loading demo state", e); }
        updateDemoBalanceUI();
        if (historyVisible) updateHistoryUI();
    }

    function saveDemoState() {
        localStorage.setItem('ft_demo_state', JSON.stringify(demoState));
        updateDemoBalanceUI();
    }

    function updateDemoBalanceUI() {
        var balEl = document.getElementById('demo-balance-display');
        var hmBalEl = document.getElementById('hm-balance');
        if (balEl) balEl.textContent = '$' + demoState.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (hmBalEl) hmBalEl.textContent = '$' + demoState.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    window.resetDemoAccount = function () {
        var resetMsg = (window.__i18nMap && window.__i18nMap['hm.resetConfirm']) || "Вы уверены, что хотите сбросить демо-счёт до $10,000? Вся история и активные позиции будут удалены.";
        if (confirm(resetMsg)) {
            demoState = {
                balance: DEMO_START_BALANCE,
                activePositions: [],
                history: []
            };
            saveDemoState();
            updateHistoryUI();
        }
    };

    // === LOAD COINS (live) ===
    var coinBySymbol = Object.create(null);
    var coinListDirty = false;
    var coinListRenderTimer = null;
    var coinTickerWs = null;
    var coinTickerWsReconnectTimer = null;
    var coinTickerWsActive = false;
    var COIN_LIST_RENDER_MS = 1000;
    var COIN_REST_BACKUP_MS = 60000;
    var COIN_WS_URL = 'wss://fstream.binance.com/ws/!ticker@arr';

    function seedAndSelectDefaultCoin() {
        if (selectedSymbol) return;
        var sym = getSavedSymbol() || 'BTC';
        if (!coins.some(function (c) { return c.symbol === sym; })) {
            coins = [{
                symbol: sym,
                fullSymbol: sym + 'USDT',
                price: 0,
                change: 0,
                volume: 0,
                trades: 0,
                tv: 'BINANCE:' + sym + 'USDT.P'
            }].concat(coins);
            coinBySymbol[sym] = coins[0];
        }
        selectCoin(sym);
    }

    function rebuildCoinIndex() {
        coinBySymbol = Object.create(null);
        for (var i = 0; i < coins.length; i++) {
            coinBySymbol[coins[i].symbol] = coins[i];
        }
    }

    function mapRestTicker(t) {
        return {
            symbol: t.symbol.replace('USDT', ''),
            fullSymbol: t.symbol,
            price: parseFloat(t.lastPrice),
            change: parseFloat(t.priceChangePercent),
            volume: parseFloat(t.quoteVolume),
            trades: parseInt(t.count, 10) || 0,
            tv: 'BINANCE:' + t.symbol + '.P'
        };
    }

    function syncSelectedPriceHeader() {
        if (!selectedSymbol) return;
        var coin = coinBySymbol[selectedSymbol];
        if (!coin) return;
        var priceEl = document.getElementById('ai-price');
        if (priceEl) priceEl.textContent = formatPrice(coin.price);
    }

    function scheduleCoinListRender() {
        coinListDirty = true;
        if (coinListRenderTimer) return;
        coinListRenderTimer = setTimeout(function () {
            coinListRenderTimer = null;
            if (!coinListDirty) return;
            coinListDirty = false;
            if (!isTabVisible()) return;
            applySortAndRender();
            syncSelectedPriceHeader();
        }, COIN_LIST_RENDER_MS);
    }

    function applyWsTickerBatch(data) {
        if (!Array.isArray(data) || !data.length) return;
        var changed = false;
        for (var i = 0; i < data.length; i++) {
            var t = data[i];
            if (!t || !t.s || t.s.slice(-4) !== 'USDT') continue;
            var sym = t.s.slice(0, -4);
            var existing = coinBySymbol[sym];
            if (existing) {
                existing.price = parseFloat(t.c) || existing.price;
                existing.change = parseFloat(t.P) || 0;
                existing.volume = parseFloat(t.q) || 0;
                existing.trades = parseInt(t.n, 10) || 0;
                changed = true;
            } else {
                var coin = {
                    symbol: sym,
                    fullSymbol: t.s,
                    price: parseFloat(t.c) || 0,
                    change: parseFloat(t.P) || 0,
                    volume: parseFloat(t.q) || 0,
                    trades: parseInt(t.n, 10) || 0,
                    tv: 'BINANCE:' + t.s + '.P'
                };
                coins.push(coin);
                coinBySymbol[sym] = coin;
                changed = true;
            }
        }
        if (changed) scheduleCoinListRender();
    }

    function connectCoinTickerWs() {
        if (typeof WebSocket === 'undefined') return;
        if (coinTickerWs && (coinTickerWs.readyState === WebSocket.OPEN || coinTickerWs.readyState === WebSocket.CONNECTING)) {
            return;
        }
        try {
            coinTickerWs = new WebSocket(COIN_WS_URL);
        } catch (e) {
            scheduleCoinTickerWsReconnect();
            return;
        }
        coinTickerWs.onopen = function () {
            coinTickerWsActive = true;
        };
        coinTickerWs.onmessage = function (ev) {
            if (!isTabVisible()) return;
            try {
                applyWsTickerBatch(JSON.parse(ev.data));
            } catch (e) {}
        };
        coinTickerWs.onclose = function () {
            coinTickerWsActive = false;
            scheduleCoinTickerWsReconnect();
        };
        coinTickerWs.onerror = function () {
            try { coinTickerWs.close(); } catch (e) {}
        };
    }

    function scheduleCoinTickerWsReconnect() {
        if (coinTickerWsReconnectTimer) return;
        coinTickerWsReconnectTimer = setTimeout(function () {
            coinTickerWsReconnectTimer = null;
            connectCoinTickerWs();
        }, 3000);
    }

    function loadCryptoCoins() {
        // Start chart/AI immediately with saved coin (or BTC) — don't wait for full ticker
        if (!selectedSymbol) {
            seedAndSelectDefaultCoin();
        }

        fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var prevSelected = selectedSymbol;
                coins = data
                    .filter(function (t) { return t.symbol.endsWith('USDT'); })
                    .map(mapRestTicker);
                rebuildCoinIndex();
                applySortAndRender();
                syncSelectedPriceHeader();
                // Only auto-select if still nothing chosen
                if (!prevSelected && !selectedSymbol) {
                    var next = pickDefaultSymbol(getSavedSymbol());
                    if (next) selectCoin(next);
                }
                connectCoinTickerWs();
            })
            .catch(function (err) {
                document.getElementById('sidebar-count').textContent = (window.__i18nMap && window.__i18nMap['sidebar.error']) || 'Ошибка загрузки';
                connectCoinTickerWs();
            });
    }

    var HOT_COINS_LIMIT = 10;
    var HOT_MIN_VOLUME = 5000000;
    var HOT_MIN_TRADES = 3000;

    function computeHotScore(c) {
        var changeAbs = Math.abs(c.change || 0);
        var vol = c.volume || 0;
        var trades = c.trades || 0;
        if (vol < HOT_MIN_VOLUME || trades < HOT_MIN_TRADES || changeAbs < 0.5) return 0;
        var changeScore = Math.min(changeAbs / 25, 1);
        var volumeScore = Math.min(Math.log10(vol) / 10, 1);
        var tradesScore = Math.min(Math.log10(trades) / 5.5, 1);
        return changeScore * 0.5 + volumeScore * 0.3 + tradesScore * 0.2;
    }

    function getHotCoins(limit) {
        var ranked = coins
            .map(function (c) {
                return { coin: c, score: computeHotScore(c) };
            })
            .filter(function (x) { return x.score > 0; })
            .sort(function (a, b) { return b.score - a.score; });
        return ranked.slice(0, limit || HOT_COINS_LIMIT).map(function (x) { return x.coin; });
    }

    function renderHotCoinsList() {
        var listEl = document.getElementById('sidebar-hot-list');
        if (!listEl) return;
        var hot = getHotCoins(HOT_COINS_LIMIT);
        if (!hot.length) {
            listEl.innerHTML = '<div class="sidebar-hot-empty">' +
                ((window.__i18nMap && window.__i18nMap['sidebar.hotEmpty']) || 'Загрузка активных монет…') +
                '</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < hot.length; i++) {
            var c = hot[i];
            var active = c.symbol === selectedSymbol ? ' active' : '';
            var changeClass = c.change >= 0 ? 'up' : 'down';
            var changeStr = (c.change >= 0 ? '+' : '') + c.change.toFixed(2) + '%';
            html += '<button type="button" class="sidebar-hot-item' + active + '" onclick="selectCoin(\'' + c.symbol + '\')">';
            html += '<span class="sidebar-hot-rank">' + (i + 1) + '</span>';
            html += '<span class="sidebar-hot-symbol">' + c.symbol + '</span>';
            html += '<span class="sidebar-hot-change ' + changeClass + '">' + changeStr + '</span>';
            html += '</button>';
        }
        listEl.innerHTML = html;
    }

    // === SORT & FILTER ===
    function applySortAndRender() {
        var query = (document.getElementById('search-input').value || '').toUpperCase();
        filteredCoins = coins.filter(function (c) {
            return c.symbol.toUpperCase().indexOf(query) !== -1 || (c.display || '').toUpperCase().indexOf(query) !== -1;
        });
        if (currentSort === 'volume') filteredCoins.sort(function (a, b) { return b.volume - a.volume; });
        else if (currentSort === 'trades') filteredCoins.sort(function (a, b) { return (b.trades || 0) - (a.trades || 0); });
        else if (currentSort === 'change') filteredCoins.sort(function (a, b) { return Math.abs(b.change) - Math.abs(a.change); });
        else if (currentSort === 'hot') {
            filteredCoins.sort(function (a, b) { return computeHotScore(b) - computeHotScore(a); });
        }
        renderCoinList();
        renderHotCoinsList();
    }

    window.filterCoins = function () { applySortAndRender(); };
    window.sortCoins = function (type) {
        currentSort = type;
        document.querySelectorAll('.sort-btn').forEach(function (b) { b.classList.remove('active'); });
        var btnId = type === 'volume' ? 'sort-vol' : ('sort-' + type);
        var btn = document.getElementById(btnId);
        if (btn) btn.classList.add('active');
        applySortAndRender();
    };

    // === RENDER COIN LIST ===
    function renderCoinList() {
        var list = document.getElementById('coin-list');
        if (!list) return;
        var scrollTop = list.scrollTop;
        var html = '';
        for (var i = 0; i < filteredCoins.length; i++) {
            var c = filteredCoins[i];
            var displayName = c.display || c.symbol;
            var isActive = c.symbol === selectedSymbol;
            var watched = isWatched(c.symbol);
            var changeClass = c.change >= 0 ? 'up' : 'down';
            var changeStr = (c.change >= 0 ? '+' : '') + c.change.toFixed(2) + '%';
            var priceStr = formatPrice(c.price);
            var suffix = '<small>USDT</small>';

            html += '<div class="coin-item' + (isActive ? ' active' : '') + '" data-symbol="' + c.symbol + '" onclick="selectCoin(\'' + c.symbol + '\')">';
            html += '<span class="coin-star' + (watched ? ' watched' : '') + '" onclick="event.stopPropagation();toggleWatchFromList(\'' + c.symbol + '\')">★</span>';
            html += '<span class="coin-name">' + displayName + suffix + '</span>';
            html += '<span class="coin-price">' + priceStr + '</span>';
            html += '<span class="coin-change ' + changeClass + '">' + changeStr + '</span>';
            html += '</div>';
        }
        list.innerHTML = html;
        list.scrollTop = scrollTop;
        var countEl = document.getElementById('sidebar-count');
        if (countEl) countEl.textContent = filteredCoins.length + ' ' + ((window.__i18nMap && window.__i18nMap['sidebar.instruments']) || 'инструментов');
    }

    function formatPrice(p) {
        if (!p || p === 0) return '—';
        if (p >= 1000) return p.toFixed(1);
        if (p >= 1) return p.toFixed(3);
        if (p >= 0.01) return p.toFixed(5);
        return p.toFixed(7);
    }

    // === SELECT COIN ===
    window.selectCoin = function (symbol) {
        selectedSymbol = symbol;
        saveSelectedSymbol(symbol);
        renderCoinList();
        loadChart(symbol);

        // Update emulator if visible
        if (emulatorVisible) {
            updateEmulatorUI();
        }

        runAIAnalysis(symbol);

        // On mobile, close coin drawer after pick so chart/AI are visible
        if (window.innerWidth <= 900) {
            setSidebarCollapsed(true);
        }
    };

    // === TRADINGVIEW CHART ===
    var TF_FAV_STORAGE = 'ft_tf_favorites';
    var TF_INTERVAL_STORAGE = 'ft_chart_interval';
    var CHART_STYLE_STORAGE = 'ft_chart_style';
    var CHART_STUDIES_STORAGE = 'ft_chart_studies';
    var TF_DEFAULT_FAVORITES = ['1', '5', '15', '60'];
    var TF_MAX_FAVORITES = 5;
    var currentChartInterval = '15';
    var currentChartStyle = '1';
    var currentChartStudies = [];
    var activeTvWidget = null;
    var tfPickerOpen = false;
    var openCtbMenu = null;

    var CHART_STYLES = [
        { id: '1', labelKey: 'chart.styleCandles', fallback: 'Свечи' },
        { id: '9', labelKey: 'chart.styleHollow', fallback: 'Пустые свечи' },
        { id: '8', labelKey: 'chart.styleHeikin', fallback: 'Хейкен Аши' },
        { id: '0', labelKey: 'chart.styleBars', fallback: 'Бары' },
        { id: '2', labelKey: 'chart.styleLine', fallback: 'Линия' },
        { id: '3', labelKey: 'chart.styleArea', fallback: 'Область' }
    ];

    // Indicators dialog (TV-style search). Built-ins load via widget studies[];
    // OI is custom Binance pane (community Pine scripts cannot run in free TV embed).
    var OI_STUDY_ID = 'ft-open-interest';
    var IND_FAV_STORAGE = 'ft_indicator_favorites';
    var IND_CATALOG = [
        { id: OI_STUDY_ID, name: 'Open Interest (Binance)', author: 'FuturesTerminal', cat: 'custom', custom: true },
        { id: 'RSI@tv-basicstudies', name: 'Relative Strength Index', author: 'TradingView', cat: 'ta' },
        { id: 'MACD@tv-basicstudies', name: 'MACD', author: 'TradingView', cat: 'ta' },
        { id: 'Stochastic@tv-basicstudies', name: 'Stochastic', author: 'TradingView', cat: 'ta' },
        { id: 'StochasticRSI@tv-basicstudies', name: 'Stochastic RSI', author: 'TradingView', cat: 'ta' },
        { id: 'MASimple@tv-basicstudies', name: 'Moving Average', author: 'TradingView', cat: 'ta' },
        { id: 'MAExp@tv-basicstudies', name: 'Moving Average Exponential', author: 'TradingView', cat: 'ta' },
        { id: 'MAWeighted@tv-basicstudies', name: 'Moving Average Weighted', author: 'TradingView', cat: 'ta' },
        { id: 'BB@tv-basicstudies', name: 'Bollinger Bands', author: 'TradingView', cat: 'ta' },
        { id: 'VWAP@tv-basicstudies', name: 'VWAP', author: 'TradingView', cat: 'ta' },
        { id: 'ATR@tv-basicstudies', name: 'Average True Range', author: 'TradingView', cat: 'ta' },
        { id: 'CCI@tv-basicstudies', name: 'Commodity Channel Index', author: 'TradingView', cat: 'ta' },
        { id: 'Momentum@tv-basicstudies', name: 'Momentum', author: 'TradingView', cat: 'ta' },
        { id: 'ROC@tv-basicstudies', name: 'Rate Of Change', author: 'TradingView', cat: 'ta' },
        { id: 'WilliamsR@tv-basicstudies', name: 'Williams %R', author: 'TradingView', cat: 'ta' },
        { id: 'OBV@tv-basicstudies', name: 'On Balance Volume', author: 'TradingView', cat: 'ta' },
        { id: 'Volume@tv-basicstudies', name: 'Volume', author: 'TradingView', cat: 'ta' },
        { id: 'IchimokuCloud@tv-basicstudies', name: 'Ichimoku Cloud', author: 'TradingView', cat: 'ta' },
        { id: 'PivotPointsStandard@tv-basicstudies', name: 'Pivot Points Standard', author: 'TradingView', cat: 'ta' },
        { id: 'AwesomeOscillator@tv-basicstudies', name: 'Awesome Oscillator', author: 'TradingView', cat: 'ta' },
        { id: 'DMI@tv-basicstudies', name: 'Directional Movement Index', author: 'TradingView', cat: 'ta' },
        { id: 'ParabolicSAR@tv-basicstudies', name: 'Parabolic SAR', author: 'TradingView', cat: 'ta' },
        { id: 'KeltnerChannels@tv-basicstudies', name: 'Keltner Channels', author: 'TradingView', cat: 'ta' },
        { id: 'ChaikinOscillator@tv-basicstudies', name: 'Chaikin Oscillator', author: 'TradingView', cat: 'ta' },
        { id: 'UltimateOscillator@tv-basicstudies', name: 'Ultimate Oscillator', author: 'TradingView', cat: 'ta' },
        { id: 'TripleEMA@tv-basicstudies', name: 'Triple EMA', author: 'TradingView', cat: 'ta' },
        { id: 'HullMA@tv-basicstudies', name: 'Hull Moving Average', author: 'TradingView', cat: 'ta' },
        { id: 'FisherTransform@tv-basicstudies', name: 'Fisher Transform', author: 'TradingView', cat: 'ta' },
        { id: 'VortexIndicator@tv-basicstudies', name: 'Vortex Indicator', author: 'TradingView', cat: 'ta' },
        { id: 'ZigZag@tv-basicstudies', name: 'Zig Zag', author: 'TradingView', cat: 'ta' },
        { id: 'PriceOsc@tv-basicstudies', name: 'Price Oscillator', author: 'TradingView', cat: 'ta' },
        { id: 'BullBearPower@tv-basicstudies', name: 'Bull Bear Power', author: 'TradingView', cat: 'ta' },
        { id: 'Envelopes@tv-basicstudies', name: 'Envelopes', author: 'TradingView', cat: 'ta' },
        { id: 'DonchianChannels@tv-basicstudies', name: 'Donchian Channels', author: 'TradingView', cat: 'ta' },
        { id: 'ChopZone@tv-basicstudies', name: 'Chop Zone', author: 'TradingView', cat: 'ta' },
        { id: 'SessionVolumeProfile@tv-basicstudies', name: 'Session Volume Profile', author: 'TradingView', cat: 'ta' }
    ];
    var indDialogState = { open: false, cat: 'favorites', query: '' };
    var oiPaneState = { points: [], candles: [], loading: false, timer: null, lastKey: '' };
    var syncedChartState = {
        priceChart: null,
        oiChart: null,
        candleSeries: null,
        volumeSeries: null,
        oiSeries: null,
        syncingRange: false,
        ro: null
    };

    var TF_CATALOG = [
        {
            groupKey: 'tf.groupMinutes',
            groupFallback: 'Минуты',
            items: [
                { interval: '1', labelKey: 'tf.1m', fallback: '1м' },
                { interval: '3', labelKey: 'tf.3m', fallback: '3м' },
                { interval: '5', labelKey: 'tf.5m', fallback: '5м' },
                { interval: '15', labelKey: 'tf.15m', fallback: '15м' },
                { interval: '30', labelKey: 'tf.30m', fallback: '30м' },
                { interval: '45', labelKey: 'tf.45m', fallback: '45м' }
            ]
        },
        {
            groupKey: 'tf.groupHours',
            groupFallback: 'Часы',
            items: [
                { interval: '60', labelKey: 'tf.1h', fallback: '1ч' },
                { interval: '120', labelKey: 'tf.2h', fallback: '2ч' },
                { interval: '180', labelKey: 'tf.3h', fallback: '3ч' },
                { interval: '240', labelKey: 'tf.4h', fallback: '4ч' }
            ]
        },
        {
            groupKey: 'tf.groupDays',
            groupFallback: 'Дни',
            items: [
                { interval: 'D', labelKey: 'tf.1d', fallback: '1д' },
                { interval: 'W', labelKey: 'tf.1w', fallback: '1нед' },
                { interval: 'M', labelKey: 'tf.1mo', fallback: '1мес' },
                { interval: '3M', labelKey: 'tf.3mo', fallback: '3мес' },
                { interval: '6M', labelKey: 'tf.6mo', fallback: '6мес' },
                { interval: '12M', labelKey: 'tf.12mo', fallback: '12мес' }
            ]
        }
    ];

    function tfLabel(item) {
        var m = window.__i18nMap || {};
        return (m[item.labelKey] || item.fallback);
    }

    function getTfCatalogItem(interval) {
        for (var g = 0; g < TF_CATALOG.length; g++) {
            for (var i = 0; i < TF_CATALOG[g].items.length; i++) {
                if (TF_CATALOG[g].items[i].interval === interval) return TF_CATALOG[g].items[i];
            }
        }
        return { interval: interval, fallback: interval };
    }

    function getFavoriteIntervals() {
        try {
            var raw = localStorage.getItem(TF_FAV_STORAGE);
            var list = raw ? JSON.parse(raw) : null;
            if (!Array.isArray(list) || !list.length) return TF_DEFAULT_FAVORITES.slice();
            return list.filter(function (v) { return typeof v === 'string' && v; }).slice(0, TF_MAX_FAVORITES);
        } catch (e) {
            return TF_DEFAULT_FAVORITES.slice();
        }
    }

    function saveFavoriteIntervals(list) {
        try { localStorage.setItem(TF_FAV_STORAGE, JSON.stringify(list)); } catch (e) {}
    }

    function getStoredChartInterval() {
        try {
            var v = localStorage.getItem(TF_INTERVAL_STORAGE);
            return v || '15';
        } catch (e) {
            return '15';
        }
    }

    function saveStoredChartInterval(interval) {
        try { localStorage.setItem(TF_INTERVAL_STORAGE, interval); } catch (e) {}
    }

    function closeTfPicker() {
        tfPickerOpen = false;
        var dd = document.getElementById('tf-picker-dropdown');
        if (dd) dd.style.display = 'none';
    }

    function renderTfPicker() {
        var listEl = document.getElementById('tf-picker-list');
        if (!listEl) return;
        var m = window.__i18nMap || {};
        var favs = getFavoriteIntervals();
        var html = '';
        for (var g = 0; g < TF_CATALOG.length; g++) {
            var group = TF_CATALOG[g];
            html += '<div class="tf-picker-group">';
            html += '<div class="tf-picker-group-title">' + (m[group.groupKey] || group.groupFallback) + '</div>';
            for (var i = 0; i < group.items.length; i++) {
                var item = group.items[i];
                var isFav = favs.indexOf(item.interval) !== -1;
                var isActive = item.interval === currentChartInterval;
                var atLimit = !isFav && favs.length >= TF_MAX_FAVORITES;
                html += '<div class="tf-picker-row' + (isActive ? ' active' : '') + '">';
                html += '<button type="button" class="tf-picker-select" onclick="selectChartTimeframe(\'' + item.interval + '\')">' + tfLabel(item) + '</button>';
                html += '<button type="button" class="tf-star-btn' + (isFav ? ' favorited' : '') + (atLimit ? ' disabled' : '') + '" onclick="toggleTfFavorite(\'' + item.interval + '\', event)" title="' + (atLimit ? (m['tf.maxStars'] || 'Максимум 5 таймфреймов') : (m['tf.starTitle'] || 'В избранное')) + '"' + (atLimit ? ' disabled' : '') + '>';
                html += '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
                html += '</button></div>';
            }
            html += '</div>';
        }
        listEl.innerHTML = html;
    }

    function loadChartStyle() {
        try {
            var s = localStorage.getItem(CHART_STYLE_STORAGE);
            if (s != null && s !== '') currentChartStyle = String(s);
        } catch (e) {}
    }

    function saveChartStyle(style) {
        currentChartStyle = String(style);
        try { localStorage.setItem(CHART_STYLE_STORAGE, currentChartStyle); } catch (e) {}
    }

    function loadChartStudies() {
        try {
            var raw = localStorage.getItem(CHART_STUDIES_STORAGE);
            var list = raw ? JSON.parse(raw) : [];
            currentChartStudies = Array.isArray(list) ? list : [];
        } catch (e) {
            currentChartStudies = [];
        }
        var migrate = {
            'ft-rsi': 'RSI@tv-basicstudies',
            'ft-macd': 'MACD@tv-basicstudies',
            'ft-stoch': 'Stochastic@tv-basicstudies',
            'Open_Interest': OI_STUDY_ID,
            'OpenInterest@tv-basicstudies': OI_STUDY_ID,
            'Open Interest@tv-basicstudies': OI_STUDY_ID
        };
        var allowed = {};
        for (var a = 0; a < IND_CATALOG.length; a++) allowed[IND_CATALOG[a].id] = true;
        currentChartStudies = currentChartStudies.map(function (id) {
            return migrate[id] || id;
        }).filter(function (id, i, arr) {
            return allowed[id] && arr.indexOf(id) === i;
        });
        saveChartStudies();
    }

    function getTvStudiesOnly() {
        return currentChartStudies.filter(function (id) {
            return id && id !== OI_STUDY_ID && String(id).indexOf('ft-') !== 0;
        });
    }

    function isOiEnabled() {
        return currentChartStudies.indexOf(OI_STUDY_ID) !== -1;
    }

    function saveChartStudies() {
        try { localStorage.setItem(CHART_STUDIES_STORAGE, JSON.stringify(currentChartStudies)); } catch (e) {}
    }

    function getIndicatorFavorites() {
        try {
            var raw = localStorage.getItem(IND_FAV_STORAGE);
            var list = raw ? JSON.parse(raw) : null;
            if (!Array.isArray(list)) {
                return ['RSI@tv-basicstudies', 'MACD@tv-basicstudies', OI_STUDY_ID];
            }
            return list.filter(function (id) { return typeof id === 'string' && id; });
        } catch (e) {
            return ['RSI@tv-basicstudies', 'MACD@tv-basicstudies', OI_STUDY_ID];
        }
    }

    function saveIndicatorFavorites(list) {
        try { localStorage.setItem(IND_FAV_STORAGE, JSON.stringify(list)); } catch (e) {}
    }

    function findIndicatorById(id) {
        for (var i = 0; i < IND_CATALOG.length; i++) {
            if (IND_CATALOG[i].id === id) return IND_CATALOG[i];
        }
        return null;
    }

    function getIndicatorsForDialog() {
        var q = String(indDialogState.query || '').trim().toLowerCase();
        var favs = getIndicatorFavorites();
        var list = IND_CATALOG.slice();
        if (!q) {
            if (indDialogState.cat === 'favorites') {
                list = favs.map(findIndicatorById).filter(Boolean);
            } else if (indDialogState.cat === 'ta') {
                list = list.filter(function (x) { return x.cat === 'ta'; });
            } else if (indDialogState.cat === 'custom') {
                list = list.filter(function (x) { return x.cat === 'custom'; });
            } else if (indDialogState.cat === 'active') {
                list = currentChartStudies.map(findIndicatorById).filter(Boolean);
            }
        } else {
            list = list.filter(function (x) {
                return (x.name + ' ' + x.author + ' ' + x.id).toLowerCase().indexOf(q) !== -1;
            });
        }
        return list;
    }

    function renderIndicatorsDialog() {
        var nav = document.getElementById('ind-dialog-nav');
        var listEl = document.getElementById('ind-dialog-list');
        if (!nav || !listEl) return;

        var cats = [
            { group: 'Мои', items: [
                { id: 'favorites', label: 'Избранное', icon: 'star' },
                { id: 'active', label: 'На графике', icon: 'list' }
            ]},
            { group: 'Встроенные', items: [
                { id: 'ta', label: 'Теханализ', icon: 'ta' },
                { id: 'custom', label: 'Open Interest', icon: 'oi' }
            ]}
        ];
        var navHtml = '';
        for (var g = 0; g < cats.length; g++) {
            navHtml += '<div class="ind-nav-group"><div class="ind-nav-group-title">' + cats[g].group + '</div>';
            for (var i = 0; i < cats[g].items.length; i++) {
                var it = cats[g].items[i];
                var active = !indDialogState.query && indDialogState.cat === it.id ? ' active' : '';
                navHtml += '<button type="button" class="ind-nav-item' + active + '" data-ind-cat="' + it.id + '">';
                if (it.icon === 'star') {
                    navHtml += '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
                } else {
                    navHtml += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 18V6M9 18v-7M14 18V9M19 18v-4"/></svg>';
                }
                navHtml += it.label + '</button>';
            }
            navHtml += '</div>';
        }
        nav.innerHTML = navHtml;

        var favs = getIndicatorFavorites();
        var rows = getIndicatorsForDialog();
        if (!rows.length) {
            listEl.innerHTML = '<div class="ind-empty">' +
                (indDialogState.query
                    ? 'Ничего не найдено'
                    : (indDialogState.cat === 'favorites'
                        ? 'Нет избранных. Нажмите ★ у индикатора.'
                        : 'Список пуст')) +
                '</div>';
            return;
        }

        var html = '';
        for (var r = 0; r < rows.length; r++) {
            var ind = rows[r];
            var on = currentChartStudies.indexOf(ind.id) !== -1;
            var isFav = favs.indexOf(ind.id) !== -1;
            html += '<div class="ind-row' + (on ? ' is-on' : '') + '" data-ind-id="' + ind.id.replace(/"/g, '') + '">';
            html += '<div class="ind-name-cell">';
            html += '<button type="button" class="ind-star-btn' + (isFav ? ' favorited' : '') + '" data-ind-fav="' + ind.id.replace(/"/g, '') + '" title="Избранное">';
            html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
            html += '</button>';
            html += '<span class="ind-name">' + ind.name + '</span></div>';
            html += '<span class="ind-author">' + ind.author + '</span>';
            html += '<span class="ind-on">' + (on ? 'Вкл' : '') + '</span>';
            html += '</div>';
        }
        listEl.innerHTML = html;
    }

    window.openIndicatorsDialog = function () {
        closeAllFloatingPanels();
        indDialogState.open = true;
        indDialogState.query = '';
        var overlay = document.getElementById('ind-dialog-overlay');
        var input = document.getElementById('ind-dialog-search');
        if (overlay) {
            overlay.classList.add('visible');
            overlay.setAttribute('aria-hidden', 'false');
        }
        renderIndicatorsDialog();
        if (input) {
            input.value = '';
            setTimeout(function () { input.focus(); }, 30);
        }
    };

    window.closeIndicatorsDialog = function () {
        indDialogState.open = false;
        var overlay = document.getElementById('ind-dialog-overlay');
        if (overlay) {
            overlay.classList.remove('visible');
            overlay.setAttribute('aria-hidden', 'true');
        }
    };

    function initIndicatorsDialog() {
        var overlay = document.getElementById('ind-dialog-overlay');
        var input = document.getElementById('ind-dialog-search');
        var nav = document.getElementById('ind-dialog-nav');
        var listEl = document.getElementById('ind-dialog-list');
        if (!overlay || overlay.dataset.bound === '1') return;
        overlay.dataset.bound = '1';

        if (input) {
            input.addEventListener('input', function () {
                indDialogState.query = input.value || '';
                renderIndicatorsDialog();
            });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') closeIndicatorsDialog();
            });
        }
        if (nav) {
            nav.addEventListener('click', function (e) {
                var btn = e.target.closest('[data-ind-cat]');
                if (!btn) return;
                indDialogState.cat = btn.getAttribute('data-ind-cat');
                indDialogState.query = '';
                if (input) input.value = '';
                renderIndicatorsDialog();
            });
        }
        if (listEl) {
            listEl.addEventListener('click', function (e) {
                var favBtn = e.target.closest('[data-ind-fav]');
                if (favBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    var fid = favBtn.getAttribute('data-ind-fav');
                    var favs = getIndicatorFavorites();
                    var ix = favs.indexOf(fid);
                    if (ix === -1) favs.push(fid);
                    else favs.splice(ix, 1);
                    saveIndicatorFavorites(favs);
                    renderIndicatorsDialog();
                    return;
                }
                var row = e.target.closest('[data-ind-id]');
                if (!row) return;
                toggleChartStudy(row.getAttribute('data-ind-id'));
            });
        }
    }

    function toggleChartStudy(studyId) {
        if (!studyId) return;
        var idx = currentChartStudies.indexOf(studyId);
        if (idx === -1) currentChartStudies.push(studyId);
        else currentChartStudies.splice(idx, 1);
        saveChartStudies();
        renderIndicatorsDialog();
        updateChartToolbarUI();
        if (selectedSymbol) loadChart(selectedSymbol);
        else updateOiPane();
    }

    function closeCtbMenus() {
        openCtbMenu = null;
        ['ctb-style-menu'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        document.querySelectorAll('.ctb-dd.open').forEach(function (n) { n.classList.remove('open'); });
    }

    function closeAllFloatingPanels() {
        closeCtbMenus();
        if (tfPickerOpen) closeTfPicker();
        if (indDialogState.open) closeIndicatorsDialog();
        var langWrap = document.getElementById('topbar-lang-wrap');
        if (langWrap) langWrap.classList.remove('dropdown-open');
        if (watchlistVisible) {
            watchlistVisible = false;
            var wl = document.getElementById('watchlist-panel');
            if (wl) wl.classList.remove('visible');
        }
        if (userMenuVisible) {
            userMenuVisible = false;
            var overlay = document.getElementById('user-menu-overlay');
            var popup = document.getElementById('user-menu-popup');
            if (overlay) overlay.classList.remove('visible');
            if (popup) popup.classList.remove('visible');
        }
    }

    function isInsideFloatingPanel(target) {
        if (!target || !target.closest) return false;
        return !!target.closest([
            '.ctb-dd',
            '#tf-picker-dropdown',
            '#tf-picker-btn',
            '#ctb-ind-btn',
            '#ind-dialog-overlay',
            '#topbar-lang-wrap',
            '#user-menu-popup',
            '#user-menu-btn',
            '#user-menu-overlay',
            '#watchlist-panel',
            '#watchlist-toggle'
        ].join(','));
    }

    var floatingPanelsDismissBound = false;
    function initFloatingPanelDismiss() {
        if (floatingPanelsDismissBound) return;
        floatingPanelsDismissBound = true;

        // Capture phase so panels close even if something stops bubbling
        document.addEventListener('mousedown', function (e) {
            if (isInsideFloatingPanel(e.target)) return;
            closeAllFloatingPanels();
        }, true);

        // TradingView iframe steals clicks — close menus when focus leaves the page chrome
        window.addEventListener('blur', function () {
            setTimeout(function () {
                closeAllFloatingPanels();
            }, 0);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeAllFloatingPanels();
        });
    }

    window.toggleCtbMenu = function (name) {
        var map = { style: 'ctb-style-menu' };
        var wrapMap = { style: 'ctb-style-wrap' };
        var id = map[name];
        if (!id) return;
        var menu = document.getElementById(id);
        if (!menu) return;
        var willOpen = openCtbMenu !== name;
        closeAllFloatingPanels();
        if (!willOpen) return;
        openCtbMenu = name;
        if (name === 'style') renderCtbStyleMenu();
        menu.style.display = 'block';
        var wrap = document.getElementById(wrapMap[name]);
        if (wrap) wrap.classList.add('open');
    };

    function renderCtbStyleMenu() {
        var menu = document.getElementById('ctb-style-menu');
        if (!menu) return;
        var m = window.__i18nMap || {};
        var html = '';
        for (var i = 0; i < CHART_STYLES.length; i++) {
            var s = CHART_STYLES[i];
            var label = m[s.labelKey] || s.fallback;
            html += '<button type="button" class="ctb-menu-item' + (s.id === currentChartStyle ? ' active' : '') + '" onclick="selectChartStyle(\'' + s.id + '\')">' + label + '</button>';
        }
        menu.innerHTML = html;
    }

    window.openFullTfPicker = function () {
        closeCtbMenus();
        tfPickerOpen = true;
        var dd = document.getElementById('tf-picker-dropdown');
        if (dd) {
            dd.style.display = 'block';
            renderTfPicker();
        }
    };

    window.focusCoinSearch = function () {
        closeCtbMenus();
        var sidebar = document.getElementById('sidebar');
        var layout = document.querySelector('.main-layout');
        if (sidebar && sidebar.classList.contains('collapsed')) {
            setSidebarCollapsed(false);
        }
        var input = document.getElementById('search-input');
        if (input) {
            setTimeout(function () {
                input.focus();
                input.select();
            }, 50);
        }
    };

    window.selectChartStyle = function (styleId) {
        saveChartStyle(styleId);
        closeCtbMenus();
        updateChartToolbarUI();
        if (selectedSymbol) loadChart(selectedSymbol);
    };


    function oiPeriodForInterval(iv) {
        var n = String(iv || '15');
        if (n === '1' || n === '3' || n === '5') return '5m';
        if (n === '15') return '15m';
        if (n === '30') return '30m';
        if (n === '60' || n === '120') return '1h';
        if (n === '240') return '4h';
        if (n === '360' || n === '480') return '6h';
        if (n === '720') return '12h';
        if (n === 'D' || n === '1D' || n === '1d' || n === 'W' || n === '1W') return '1d';
        return '15m';
    }

    function binanceKlineInterval(iv) {
        var map = {
            '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '45': '30m',
            '60': '1h', '120': '2h', '180': '3h', '240': '4h',
            'D': '1d', '1D': '1d', 'W': '1w', '1W': '1w', 'M': '1M', '1M': '1M',
            '3M': '1M', '6M': '1M', '12M': '1M'
        };
        return map[String(iv || '15')] || '15m';
    }

    function formatOiValue(v) {
        var n = Number(v);
        if (!isFinite(n)) return '—';
        var abs = Math.abs(n);
        if (abs >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + ' B';
        if (abs >= 1e6) return (n / 1e6).toFixed(2).replace('.', ',') + ' M';
        if (abs >= 1e3) return (n / 1e3).toFixed(2).replace('.', ',') + ' K';
        return n.toFixed(2).replace('.', ',');
    }

    function oiMarketSymbol(sym) {
        var s = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!s) return '';
        return s.slice(-4) === 'USDT' ? s : (s + 'USDT');
    }

    function parseOiHistRows(data) {
        if (!Array.isArray(data)) return [];
        return data.map(function (row) {
            var v = Number(row && (row.sumOpenInterestValue != null ? row.sumOpenInterestValue : row.sumOpenInterest));
            if (!isFinite(v) || v <= 0) v = Number(row && row.openInterest);
            return { t: Number(row && row.timestamp) || Number(row && row.time) || 0, v: isFinite(v) ? v : 0 };
        }).filter(function (p) { return p.v > 0 && p.t > 0; });
    }

    function hasLightweightCharts() {
        return !!(window.LightweightCharts && typeof window.LightweightCharts.createChart === 'function');
    }

    function setSyncedChartMode(on) {
        var wrap = document.getElementById('synced-chart');
        var viewport = document.getElementById('chart-viewport');
        if (wrap) {
            wrap.classList.toggle('is-active', !!on);
            wrap.setAttribute('aria-hidden', on ? 'false' : 'true');
        }
        if (viewport) viewport.classList.toggle('is-synced-mode', !!on);
    }

    function destroySyncedCharts() {
        if (syncedChartState.ro) {
            try { syncedChartState.ro.disconnect(); } catch (e) {}
            syncedChartState.ro = null;
        }
        if (syncedChartState.priceChart) {
            try { syncedChartState.priceChart.remove(); } catch (e2) {}
        }
        if (syncedChartState.oiChart) {
            try { syncedChartState.oiChart.remove(); } catch (e3) {}
        }
        syncedChartState.priceChart = null;
        syncedChartState.oiChart = null;
        syncedChartState.candleSeries = null;
        syncedChartState.volumeSeries = null;
        syncedChartState.oiSeries = null;
        syncedChartState.syncingRange = false;
        var priceEl = document.getElementById('synced-price');
        var oiEl = document.getElementById('synced-oi');
        if (priceEl) priceEl.innerHTML = '';
        if (oiEl) oiEl.innerHTML = '';
        setSyncedChartMode(false);
    }

    function lwcCommonOptions(showTime) {
        var L = window.LightweightCharts;
        return {
            layout: {
                background: { color: '#0B0B0F' },
                textColor: '#8E9BAE',
                fontSize: 11
            },
            grid: {
                vertLines: { color: 'rgba(255,255,255,0.04)' },
                horzLines: { color: 'rgba(255,255,255,0.04)' }
            },
            crosshair: {
                mode: L.CrosshairMode ? L.CrosshairMode.Normal : 1,
                vertLine: { color: 'rgba(255,255,255,0.45)', width: 1, style: 3, labelBackgroundColor: '#2a2e39' },
                horzLine: { color: 'rgba(255,255,255,0.25)', width: 1, style: 3, labelBackgroundColor: '#2a2e39' }
            },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.12 } },
            timeScale: {
                borderVisible: false,
                timeVisible: !!showTime,
                secondsVisible: false,
                visible: !!showTime,
                rightOffset: 4
            },
            handleScroll: true,
            handleScale: true
        };
    }

    function wireSyncedChartRangeAndCrosshair() {
        var price = syncedChartState.priceChart;
        var oi = syncedChartState.oiChart;
        if (!price || !oi) return;

        function mirrorRange(source, target) {
            source.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
                if (!range || syncedChartState.syncingRange) return;
                syncedChartState.syncingRange = true;
                try { target.timeScale().setVisibleLogicalRange(range); } catch (e) {}
                syncedChartState.syncingRange = false;
            });
        }
        mirrorRange(price, oi);
        mirrorRange(oi, price);

        function timeToSec(t) {
            if (t == null) return null;
            if (typeof t === 'object') {
                return Math.floor(Date.UTC(t.year, t.month - 1, t.day) / 1000);
            }
            return Number(t);
        }

        price.subscribeCrosshairMove(function (param) {
            if (!param || param.time === undefined || !syncedChartState.oiSeries) {
                try { oi.clearCrosshairPosition(); } catch (e) {}
                return;
            }
            try {
                var tSec = timeToSec(param.time);
                var pts = oiPaneState.points || [];
                var best = null;
                for (var i = 0; i < pts.length; i++) {
                    var ts = Math.floor(pts[i].t / 1000);
                    if (best == null || Math.abs(ts - tSec) < Math.abs(best.ts - tSec)) {
                        best = { ts: ts, v: pts[i].v };
                    }
                }
                if (best) oi.setCrosshairPosition(best.v, param.time, syncedChartState.oiSeries);
            } catch (e2) {}
        });

        oi.subscribeCrosshairMove(function (param) {
            if (!param || param.time === undefined || !syncedChartState.candleSeries) {
                try { price.clearCrosshairPosition(); } catch (e) {}
                return;
            }
            try {
                var tSec2 = timeToSec(param.time);
                var bars = oiPaneState.candles || [];
                var bar = null;
                for (var j = 0; j < bars.length; j++) {
                    if (bars[j].time === tSec2) { bar = bars[j]; break; }
                    if (!bar || Math.abs(bars[j].time - tSec2) < Math.abs(bar.time - tSec2)) bar = bars[j];
                }
                if (bar) price.setCrosshairPosition(bar.close, param.time, syncedChartState.candleSeries);
            } catch (e3) {}
        });
    }

    function ensureSyncedCharts() {
        if (!hasLightweightCharts()) return false;
        var priceEl = document.getElementById('synced-price');
        var oiEl = document.getElementById('synced-oi');
        if (!priceEl || !oiEl) return false;

        if (syncedChartState.priceChart && syncedChartState.oiChart) {
            setSyncedChartMode(true);
            resizeSyncedCharts();
            return true;
        }

        destroySyncedCharts();
        setSyncedChartMode(true);

        var L = window.LightweightCharts;
        var priceOpts = lwcCommonOptions(false);
        priceOpts.rightPriceScale.scaleMargins = { top: 0.06, bottom: 0.18 };
        syncedChartState.priceChart = L.createChart(priceEl, priceOpts);
        syncedChartState.candleSeries = syncedChartState.priceChart.addCandlestickSeries({
            upColor: '#00E676',
            downColor: '#FF3366',
            borderUpColor: '#00E676',
            borderDownColor: '#FF3366',
            wickUpColor: '#00E676',
            wickDownColor: '#FF3366'
        });
        syncedChartState.volumeSeries = syncedChartState.priceChart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: '',
            scaleMargins: { top: 0.82, bottom: 0 }
        });
        syncedChartState.priceChart.priceScale('').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

        var oiOpts = lwcCommonOptions(true);
        oiOpts.rightPriceScale.scaleMargins = { top: 0.12, bottom: 0.08 };
        syncedChartState.oiChart = L.createChart(oiEl, oiOpts);
        syncedChartState.oiSeries = syncedChartState.oiChart.addAreaSeries({
            lineColor: '#AB47BC',
            topColor: 'rgba(171, 71, 188, 0.35)',
            bottomColor: 'rgba(171, 71, 188, 0.02)',
            lineWidth: 2,
            priceLineVisible: true,
            lastValueVisible: true
        });

        wireSyncedChartRangeAndCrosshair();

        if (typeof ResizeObserver !== 'undefined') {
            syncedChartState.ro = new ResizeObserver(function () { resizeSyncedCharts(); });
            syncedChartState.ro.observe(priceEl);
            syncedChartState.ro.observe(oiEl);
        }
        resizeSyncedCharts();
        return true;
    }

    function resizeSyncedCharts() {
        var priceEl = document.getElementById('synced-price');
        var oiEl = document.getElementById('synced-oi');
        if (syncedChartState.priceChart && priceEl) {
            syncedChartState.priceChart.applyOptions({
                width: priceEl.clientWidth,
                height: priceEl.clientHeight
            });
        }
        if (syncedChartState.oiChart && oiEl) {
            syncedChartState.oiChart.applyOptions({
                width: oiEl.clientWidth,
                height: oiEl.clientHeight
            });
        }
    }

    function applySyncedChartData() {
        if (!syncedChartState.candleSeries || !syncedChartState.oiSeries) return;
        var candles = oiPaneState.candles || [];
        var pts = oiPaneState.points || [];
        syncedChartState.candleSeries.setData(candles);
        if (syncedChartState.volumeSeries) {
            syncedChartState.volumeSeries.setData(candles.map(function (c) {
                return {
                    time: c.time,
                    value: c.volume,
                    color: c.close >= c.open ? 'rgba(0,230,118,0.45)' : 'rgba(255,51,102,0.45)'
                };
            }));
        }
        var oiData = pts.map(function (p) {
            return { time: Math.floor(p.t / 1000), value: p.v };
        }).filter(function (p, i, arr) {
            return i === 0 || p.time > arr[i - 1].time;
        });
        syncedChartState.oiSeries.setData(oiData);

        var valueEl = document.getElementById('oi-pane-value');
        if (valueEl) {
            valueEl.textContent = oiData.length ? formatOiValue(oiData[oiData.length - 1].value) : '—';
        }

        try {
            syncedChartState.priceChart.timeScale().fitContent();
            var range = syncedChartState.priceChart.timeScale().getVisibleLogicalRange();
            if (range) syncedChartState.oiChart.timeScale().setVisibleLogicalRange(range);
        } catch (e) {}
    }

    function updateOiPane() {
        var enabled = isOiEnabled() && !multiTFMode;
        if (!enabled) {
            destroySyncedCharts();
            oiPaneState.points = [];
            oiPaneState.candles = [];
            oiPaneState.lastKey = '';
            return;
        }
        if (!selectedSymbol) {
            ensureSyncedCharts();
            oiPaneState.points = [];
            oiPaneState.candles = [];
            applySyncedChartData();
            return;
        }
        if (!hasLightweightCharts()) {
            setSyncedChartMode(false);
            return;
        }

        var market = oiMarketSymbol(selectedSymbol);
        var period = oiPeriodForInterval(currentChartInterval);
        var kIv = binanceKlineInterval(currentChartInterval);
        var key = market + '|' + period + '|' + kIv;
        if (!market) return;
        if (oiPaneState.loading && oiPaneState.lastKey === key) {
            ensureSyncedCharts();
            return;
        }

        oiPaneState.loading = true;
        oiPaneState.lastKey = key;
        ensureSyncedCharts();

        var klinesUrl = 'https://fapi.binance.com/fapi/v1/klines?symbol=' +
            encodeURIComponent(market) + '&interval=' + encodeURIComponent(kIv) + '&limit=300';
        var histUrl = 'https://fapi.binance.com/futures/data/openInterestHist?symbol=' +
            encodeURIComponent(market) + '&period=' + encodeURIComponent(period) + '&limit=300';

        Promise.all([
            fetch(klinesUrl).then(function (r) { return r.json(); }),
            fetch(histUrl).then(function (r) { return r.json(); })
        ]).then(function (pair) {
            if (!isOiEnabled() || oiPaneState.lastKey !== key) return;
            var kraw = pair[0];
            var oraw = pair[1];
            var candles = [];
            if (Array.isArray(kraw)) {
                for (var i = 0; i < kraw.length; i++) {
                    var k = kraw[i];
                    candles.push({
                        time: Math.floor(Number(k[0]) / 1000),
                        open: Number(k[1]),
                        high: Number(k[2]),
                        low: Number(k[3]),
                        close: Number(k[4]),
                        volume: Number(k[5])
                    });
                }
            }
            var pts = parseOiHistRows(oraw);
            oiPaneState.loading = false;
            oiPaneState.candles = candles;
            oiPaneState.points = pts;
            if (!pts.length) {
                return fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=' + encodeURIComponent(market))
                    .then(function (r2) { return r2.json(); })
                    .then(function (now) {
                        if (!isOiEnabled() || oiPaneState.lastKey !== key) return;
                        var v = Number(now.openInterest);
                        var t = Number(now.time) || Date.now();
                        oiPaneState.points = (isFinite(v) && v > 0)
                            ? [{ t: t - 180000, v: v }, { t: t - 90000, v: v }, { t: t, v: v }]
                            : [];
                        applySyncedChartData();
                    });
            }
            applySyncedChartData();
        }).catch(function () {
            oiPaneState.loading = false;
            if (oiPaneState.lastKey !== key) return;
            oiPaneState.points = [];
            oiPaneState.candles = [];
            applySyncedChartData();
        });
    }

    function updateIndicatorPanes() { updateOiPane(); }

    function shouldUseSyncedOiChart() {
        return isOiEnabled() && !multiTFMode && !!selectedSymbol && hasLightweightCharts();
    }

    function getTvChartApi() {
        if (!activeTvWidget) return null;
        try {
            if (typeof activeTvWidget.activeChart === 'function') return activeTvWidget.activeChart();
            if (typeof activeTvWidget.chart === 'function') return activeTvWidget.chart();
        } catch (e) {}
        return null;
    }

    function selectTvLineTool(toolName) {
        if (!toolName) return false;
        try {
            if (activeTvWidget && typeof activeTvWidget.selectLineTool === 'function') {
                activeTvWidget.selectLineTool(toolName);
                return true;
            }
            var chart = getTvChartApi();
            if (chart && typeof chart.selectLineTool === 'function') {
                chart.selectLineTool(toolName);
                return true;
            }
        } catch (e) {}
        return false;
    }

    window.setChartSideTool = function (toolId) {
        var map = {
            cursor: 'cursor',
            'pos-long': 'long_position',
            'pos-short': 'short_position'
        };
        var tvTool = map[toolId];
        if (!tvTool) return;
        document.querySelectorAll('.cst-btn[data-tool], .ctb-pos-btn').forEach(function (btn) {
            var t = btn.getAttribute('data-tool');
            if (!t || t === 'pos-clear') return;
            btn.classList.toggle('active', t === toolId);
        });
        selectTvLineTool(tvTool);
    };

    window.undoChartAction = function () {
        try {
            if (activeTvWidget && typeof activeTvWidget.undo === 'function') {
                activeTvWidget.undo();
                return;
            }
            var chart = getTvChartApi();
            if (chart && typeof chart.executeActionById === 'function') chart.executeActionById('undo');
        } catch (e) {}
    };

    window.redoChartAction = function () {
        try {
            if (activeTvWidget && typeof activeTvWidget.redo === 'function') {
                activeTvWidget.redo();
                return;
            }
            var chart = getTvChartApi();
            if (chart && typeof chart.executeActionById === 'function') chart.executeActionById('redo');
        } catch (e) {}
    };

    function updateChartToolbarUI() {
        var symEl = document.getElementById('ctb-symbol-text');
        if (symEl) symEl.textContent = selectedSymbol ? (selectedSymbol + 'USDT') : '---';

        var toolbar = document.getElementById('chart-toolbar');
        if (toolbar) toolbar.classList.add('hidden');
    }

    function renderTfToolbar() {
        var toolbar = document.getElementById('chart-toolbar');
        var favEl = document.getElementById('tf-favorites');
        if (toolbar) toolbar.classList.toggle('hidden', !!multiTFMode);
        if (!favEl) return;

        var favs = getFavoriteIntervals();
        var html = '';
        for (var i = 0; i < favs.length; i++) {
            var iv = favs[i];
            var item = getTfCatalogItem(iv);
            var cls = 'tf-btn' + (iv === currentChartInterval ? ' active' : '');
            html += '<button type="button" class="' + cls + '" onclick="selectChartTimeframe(\'' + iv + '\')">' + tfLabel(item) + '</button>';
        }
        favEl.innerHTML = html;
        updateChartToolbarUI();
        if (tfPickerOpen) renderTfPicker();
    }

    function initTfToolbar() {
        currentChartInterval = getStoredChartInterval();
        loadChartStyle();
        loadChartStudies();
        var pickerBtn = document.getElementById('tf-picker-btn');
        if (pickerBtn) {
            pickerBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var willOpen = !tfPickerOpen;
                closeAllFloatingPanels();
                tfPickerOpen = willOpen;
                var dd = document.getElementById('tf-picker-dropdown');
                if (dd) {
                    dd.style.display = tfPickerOpen ? 'block' : 'none';
                    if (tfPickerOpen) renderTfPicker();
                }
            });
        }
        initFloatingPanelDismiss();
        initIndicatorsDialog();
        renderTfToolbar();
        updateOiPane();
        if (!oiPaneState.timer) {
            oiPaneState.timer = setInterval(function () {
                if (isOiEnabled()) updateOiPane();
            }, 60000);
        }
    }

    window.selectChartTimeframe = function (interval) {
        if (multiTFMode || !selectedSymbol) return;
        currentChartInterval = interval;
        saveStoredChartInterval(interval);
        closeTfPicker();
        closeCtbMenus();

        var coin = coins.find(function (c) { return c.symbol === selectedSymbol; });
        if (!coin) return;

        if (shouldUseSyncedOiChart()) {
            renderTfToolbar();
            updateOiPane();
            try { runAIAnalysis(selectedSymbol, false); } catch (eOiTf) {}
            return;
        }

        if (activeTvWidget) {
            var applied = false;
            if (typeof activeTvWidget.setSymbol === 'function') {
                try {
                    activeTvWidget.setSymbol(coin.tv, interval);
                    applied = true;
                } catch (e) {}
            }
            if (!applied && typeof activeTvWidget.onChartReady === 'function') {
                try {
                    activeTvWidget.onChartReady(function () {
                        if (activeTvWidget.chart && typeof activeTvWidget.chart === 'function') {
                            activeTvWidget.chart().setSymbol(coin.tv, interval);
                        }
                    });
                    applied = true;
                } catch (e2) {}
            }
            if (applied) {
                renderTfToolbar();
                updateIndicatorPanes();
                try { runAIAnalysis(selectedSymbol, false); } catch (e3) {}
                return;
            }
        }
        loadChart(selectedSymbol);
        try { runAIAnalysis(selectedSymbol, false); } catch (e4) {}
    };

    window.toggleTfFavorite = function (interval, ev) {
        if (ev) { ev.stopPropagation(); ev.preventDefault(); }
        var favs = getFavoriteIntervals();
        var idx = favs.indexOf(interval);
        if (idx === -1) {
            if (favs.length >= TF_MAX_FAVORITES) return;
            favs.push(interval);
        } else {
            if (favs.length <= 1) return;
            favs.splice(idx, 1);
        }
        saveFavoriteIntervals(favs);
        renderTfToolbar();
    };

    var MULTI_TF_INTERVALS = [
        { interval: '240', label: '4H' },
        { interval: '60', label: '1H' },
        { interval: '15', label: '15M' },
        { interval: '5', label: '5M' }
    ];

    function getTvStorageUserId() {
        var key = 'ft_tv_user_id';
        try {
            var id = localStorage.getItem(key);
            if (id && typeof id === 'string') return id;
            id = 'wb_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem(key, id);
            return id;
        } catch (e) {
            return 'wb_guest';
        }
    }

    // tv.js quirk: hide_top_toolbar:false omits the param, and widgetembed then defaults to HIDDEN.
    // hide_side_toolbar:false works because tv.js sends "0" explicitly for that flag.
    function forceTvTopToolbarVisible(containerId) {
        var root = document.getElementById(containerId);
        if (!root) return;
        var patch = function () {
            var iframe = root.querySelector('iframe');
            if (!iframe || !iframe.src) return false;
            try {
                var href = iframe.src;
                var hashIdx = href.indexOf('#');
                if (hashIdx < 0) return false;
                var raw = decodeURIComponent(href.slice(hashIdx + 1));
                var cfg = JSON.parse(raw);
                if (String(cfg.hide_top_toolbar) === '0') return true;
                cfg.hide_top_toolbar = '0';
                iframe.src = href.slice(0, hashIdx + 1) + encodeURIComponent(JSON.stringify(cfg));
                return true;
            } catch (e) {
                return false;
            }
        };
        if (patch()) return;
        var n = 0;
        var timer = setInterval(function () {
            n++;
            if (patch() || n > 50) clearInterval(timer);
        }, 40);
    }

    function createChartWidget(parentEl, tvSymbol, interval, compact) {
        // Stable id for main chart helps TV restore drawings/settings after reload
        var containerId = compact
            ? ('tv-chart-' + interval + '-' + Date.now())
            : 'tv-chart-main';
        var chartDiv = document.createElement('div');
        chartDiv.id = containerId;
        chartDiv.style.cssText = 'width:100%;height:100%';
        parentEl.appendChild(chartDiv);

        var widget = new TradingView.widget({
            autosize: true,
            symbol: tvSymbol,
            interval: interval,
            timezone: 'Etc/UTC',
            theme: 'dark',
            style: compact ? '1' : String(currentChartStyle || '1'),
            locale: getTvLocale(),
            container_id: containerId,
            // Must be patched to "0" after create — see forceTvTopToolbarVisible
            hide_top_toolbar: !!compact,
            hide_side_toolbar: !!compact,
            hide_legend: false,
            enable_publishing: false,
            save_image: !compact,
            allow_symbol_change: !compact,
            doNotStoreSettings: false,
            client_id: 'tradingview.com',
            user_id: getTvStorageUserId(),
            details: false,
            hotlist: false,
            calendar: false,
            withdateranges: !compact,
            enabled_features: [],
            disabled_features: compact ? [
                'header_widget',
                'left_toolbar',
                'timeframes_toolbar'
            ] : [],
            studies: [],
            show_popup_button: true,
            popup_width: '1000',
            popup_height: '650',
            backgroundColor: '#0B0B0F',
            gridColor: 'rgba(255, 255, 255, 0.04)',
            overrides: {
                'paneProperties.background': '#0B0B0F',
                'paneProperties.backgroundType': 'solid',
                'paneProperties.vertGridProperties.color': 'rgba(255, 255, 255, 0.04)',
                'paneProperties.horzGridProperties.color': 'rgba(255, 255, 255, 0.04)',
                'mainSeriesProperties.candleStyle.upColor': '#00E676',
                'mainSeriesProperties.candleStyle.downColor': '#FF3366',
                'mainSeriesProperties.candleStyle.borderUpColor': '#00E676',
                'mainSeriesProperties.candleStyle.borderDownColor': '#FF3366',
                'mainSeriesProperties.candleStyle.wickUpColor': '#00E676',
                'mainSeriesProperties.candleStyle.wickDownColor': '#FF3366',
                'scalesProperties.textColor': '#8E9BAE',
                'scalesProperties.lineColor': 'rgba(255, 255, 255, 0.08)'
            },
            studies_overrides: {
                'volume.volume.color.0': '#00E676',
                'volume.volume.color.1': '#FF3366',
                'volume.volume.transparency': 70
            }
        });

        if (!compact) {
            activeTvWidget = widget;
            forceTvTopToolbarVisible(containerId);
        }

        return widget;
    }

    var currentLoadId = 0;

    function loadChart(symbol) {
        var coin = coins.find(function (c) { return c.symbol === symbol; });
        if (!coin) return;

        currentLoadId++;
        var thisLoadId = currentLoadId;

        var container = document.getElementById('tradingview-container');
        document.getElementById('chart-loading').classList.remove('hidden');

        // Update toggle button state
        var btn = document.getElementById('mtf-toggle');
        if (btn) btn.classList.toggle('active', multiTFMode);
        renderTfToolbar();

        // Always use native TradingView widget (full toolbar). Custom OI overlay stays off-chart.
        destroySyncedCharts();
        if (!multiTFMode) activeTvWidget = null;

        // Reset and rebuild DOM for new symbol or mode
        container.innerHTML = '';
        container.className = multiTFMode ? 'mtf-grid' : '';

        try {
            if (multiTFMode) {
                // 4-panel grid — stagger creation to avoid race conditions
                for (var i = 0; i < MULTI_TF_INTERVALS.length; i++) {
                    (function (idx) {
                        setTimeout(function () {
                            // Cancel if user clicked another coin
                            if (currentLoadId !== thisLoadId) return;

                            var tf = MULTI_TF_INTERVALS[idx];
                            var panel = document.createElement('div');
                            panel.className = 'mtf-panel';
                            var label = document.createElement('div');
                            label.className = 'mtf-label';
                            label.textContent = tf.label;
                            panel.appendChild(label);
                            container.appendChild(panel);
                            createChartWidget(panel, coin.tv, tf.interval, true);
                        }, idx * 150);
                    })(i);
                }
            } else {
                // Single chart
                createChartWidget(container, coin.tv, currentChartInterval, false);
            }

            setTimeout(function () {
                if (currentLoadId === thisLoadId) {
                    document.getElementById('chart-loading').classList.add('hidden');
                }
            }, 700);
            updateIndicatorPanes();
        } catch (e) {
            container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555">Ошибка загрузки графика</div>';
            updateIndicatorPanes();
        }
    }

    window.toggleMultiTF = function () {
        multiTFMode = !multiTFMode;
        if (selectedSymbol) loadChart(selectedSymbol);
        else updateIndicatorPanes();
    };

    var _sidebarHideTimer = null;

    function setSidebarCollapsed(collapsed) {
        var layout = document.querySelector('.main-layout');
        var sidebar = document.getElementById('sidebar');
        var btn = document.getElementById('sidebar-toggle');
        if (!layout || !sidebar) return;

        var isCollapsed = sidebar.classList.contains('collapsed');
        if (collapsed === isCollapsed) return;

        sidebar.style.willChange = 'transform';
        layout.classList.toggle('sidebar-collapsed', collapsed);
        sidebar.classList.toggle('collapsed', collapsed);
        document.body.classList.toggle('sidebar-collapsed', collapsed);

        if (btn) {
            btn.classList.toggle('is-collapsed', collapsed);
            btn.title = collapsed ? 'Развернуть панель' : 'Свернуть панель';
            btn.setAttribute('aria-label', btn.title);
        }

        clearTimeout(setSidebarCollapsed._wcTimer);
        setSidebarCollapsed._wcTimer = setTimeout(function () {
            sidebar.style.willChange = '';
        }, 420);
    }

    window.toggleSidebar = function () {
        var sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        clearTimeout(_sidebarHideTimer);
        setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    };

    function initSidebarAutoHide() {
        var sidebar = document.getElementById('sidebar');
        var btn = document.getElementById('sidebar-toggle');
        if (!sidebar) return;

        function cancelHide() {
            clearTimeout(_sidebarHideTimer);
            _sidebarHideTimer = null;
        }

        function scheduleHide() {
            if (window.innerWidth <= 900) return; // mobile: only manual toggle
            cancelHide();
            _sidebarHideTimer = setTimeout(function () {
                _sidebarHideTimer = null;
                if (!sidebar.classList.contains('collapsed')) {
                    setSidebarCollapsed(true);
                }
            }, 160);
        }

        sidebar.addEventListener('mouseenter', cancelHide);
        sidebar.addEventListener('mouseleave', scheduleHide);
        if (btn) {
            btn.addEventListener('mouseenter', cancelHide);
            btn.addEventListener('mouseleave', scheduleHide);
        }
    }

    // === REASONING / EARLY-WARNING I18N (engine outputs Russian only) ===
    var REASONING_I18N = {
        en: {
            'RSI бычья дивергенция — сильный сигнал разворота вверх': 'RSI bullish divergence — strong reversal up',
            'RSI медвежья дивергенция — сильный сигнал разворота вниз': 'RSI bearish divergence — strong reversal down',
            'MACD бычий кроссовер': 'MACD bullish crossover',
            'MACD медвежий кроссовер': 'MACD bearish crossover',
            'MACD гистограмма растёт': 'MACD histogram rising',
            'MACD гистограмма падает': 'MACD histogram falling',
            'Цена у верхней Bollinger': 'Price at upper Bollinger',
            'Цена у нижней Bollinger': 'Price at lower Bollinger',
            'BB сжатие — ожидается импульс': 'Bollinger Bands squeeze — impulse expected',
            'Stoch кроссовер вниз из 80+': 'Stoch crossover down from 80+',
            'Stoch кроссовер вверх из 20-': 'Stoch crossover up from 20-',
            'OBV дивергенция с ценой': 'OBV divergence with price',
            'Цена внутри облака Ichimoku': 'Price inside Ichimoku cloud',
            'EMA50 > EMA200 — золотой крест': 'EMA50 > EMA200 — golden cross',
            'EMA50 < EMA200 — крест смерти': 'EMA50 < EMA200 — death cross',
            'EMA3 > EMA8 — локально вверх': 'EMA3 > EMA8 — locally up',
            'EMA3 < EMA8 — локально вниз': 'EMA3 < EMA8 — locally down',
            'ROC ускорение тренда вверх': 'ROC trend acceleration up',
            'ROC ускорение тренда вниз': 'ROC trend acceleration down',
            'ROC замедление восходящего тренда': 'ROC deceleration of uptrend',
            'ROC замедление нисходящего тренда': 'ROC deceleration of downtrend',
            'RSI выходит из перекупленности': 'RSI exiting overbought',
            'RSI выходит из перепроданности': 'RSI exiting oversold',
            'RSI бычья дивергенция против нисходящего тренда': 'RSI bullish divergence vs downtrend',
            'RSI медвежья дивергенция против восходящего тренда': 'RSI bearish divergence vs uptrend',
            'MACD бычий кроссовер против тренда': 'MACD bullish crossover vs trend',
            'MACD медвежий кроссовер против тренда': 'MACD bearish crossover vs trend',
            'Моментум разворачивается вниз': 'Momentum turning down',
            'Моментум разворачивается вверх': 'Momentum turning up',
            'RSI медвежья дивергенция': 'RSI bearish divergence',
            'RSI бычья дивергенция': 'RSI bullish divergence',
            'MACD гистограмма отрицательная': 'MACD histogram negative',
            'MACD гистограмма положительная': 'MACD histogram positive',
            'EMA3 < EMA8 против тренда': 'EMA3 < EMA8 against trend',
            'EMA3 > EMA8 против тренда': 'EMA3 > EMA8 against trend',
            'Серия красных свечей против тренда': 'Series of red candles against trend',
            'Серия зелёных свечей против тренда': 'Series of green candles against trend',
            'Stochastic > 80 — перекупленность': 'Stochastic > 80 — overbought',
            'Stochastic < 20 — перепроданность': 'Stochastic < 20 — oversold',
            'Силы быков/медведей почти равны': 'Bulls/bears nearly equal',
            'SMC-конfluence подтверждает рост (структура/OB/FVG/ликвидность)': 'SMC confluence confirms upside (structure/OB/FVG/liquidity)',
            'SMC-конfluence подтверждает снижение (структура/OB/FVG/ликвидность)': 'SMC confluence confirms downside (structure/OB/FVG/liquidity)'
        }
    };

    function translateReasoning(ruText) {
        if (!ruText || typeof ruText !== 'string') return ruText;
        var lang;
        try { lang = currentAppLang || localStorage.getItem('ft_lang') || 'ru'; } catch (e) { lang = 'ru'; }
        if (lang !== 'en') {
            if (ruText === 'BB \u0441\u0436\u0430\u0442\u0438\u0435 \u2014 \u043e\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044f \u0438\u043c\u043f\u0443\u043b\u044c\u0441') return '\u0421\u0436\u0430\u0442\u0438\u0435 \u043f\u043e\u043b\u043e\u0441 \u0411\u043e\u043b\u043b\u0438\u043d\u0434\u0436\u0435\u0440\u0430 \u2014 \u043e\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044f \u0438\u043c\u043f\u0443\u043b\u044c\u0441';
            return ruText;
        }
        var map = REASONING_I18N.en;
        if (map && map[ruText]) return map[ruText];
        var s = ruText;
        var repl = function (re, enStr) { return s.replace(re, enStr); };
        if (/^RSI (\d+) — перекупленность$/.test(s)) return repl(/^RSI (\d+) — перекупленность$/, 'RSI $1 — overbought');
        if (/^RSI (\d+) — перепроданность$/.test(s)) return repl(/^RSI (\d+) — перепроданность$/, 'RSI $1 — oversold');
        if (/^RSI (\d+) — приближается к перекупленности$/.test(s)) return repl(/^RSI (\d+) — приближается к перекупленности$/, 'RSI $1 — approaching overbought');
        if (/^RSI (\d+) — приближается к перепроданности$/.test(s)) return repl(/^RSI (\d+) — приближается к перепроданности$/, 'RSI $1 — approaching oversold');
        if (/^ADX ([\d.]+) — сильный тренд$/.test(s)) return repl(/^ADX ([\d.]+) — сильный тренд$/, 'ADX $1 — strong trend');
        if (/^ADX ([\d.]+) — слабый тренд\/флет$/.test(s)) return repl(/^ADX ([\d.]+) — слабый тренд\/флет$/, 'ADX $1 — weak trend/flat');
        if (/^Цена ниже EMA9 на ([\d.]+) ATR$/.test(s)) return repl(/^Цена ниже EMA9 на ([\d.]+) ATR$/, 'Price below EMA9 by $1 ATR');
        if (/^Цена выше EMA9 на ([\d.]+) ATR$/.test(s)) return repl(/^Цена выше EMA9 на ([\d.]+) ATR$/, 'Price above EMA9 by $1 ATR');
        if (/^(\d+) красных свечей подряд$/.test(s)) return repl(/^(\d+) красных свечей подряд$/, '$1 red candles in a row');
        if (/^(\d+) зелёных свечей подряд$/.test(s)) return repl(/^(\d+) зелёных свечей подряд$/, '$1 green candles in a row');
        if (/^Моментум \+([-\d.]+)% \(([-\d.]+) ATR\)$/.test(s)) return repl(/^Моментум \+([-\d.]+)% \(([-\d.]+) ATR\)$/, 'Momentum +$1% ($2 ATR)');
        if (/^Моментум ([-\d.]+)% \(([-\d.]+) ATR\)$/.test(s)) return repl(/^Моментум ([-\d.]+)% \(([-\d.]+) ATR\)$/, 'Momentum $1% ($2 ATR)');
        if (/^Объём растёт ×([\d.]+)$/.test(s)) return repl(/^Объём растёт ×([\d.]+)$/, 'Volume rising ×$1');
        if (/^Объём падает ×([\d.]+)$/.test(s)) return repl(/^Объём падает ×([\d.]+)$/, 'Volume falling ×$1');
        return ruText;
    }

    // === AI ANALYSIS ===
    function fetchOHLC(url) {
        return fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!Array.isArray(data) || data.length < 20) return null;
                return data.map(function (c) {
                    return { open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]) };
                });
            })
            .catch(function () { return null; });
    }

    function runAIAnalysis(symbol, isBackground) {
        if (!symbol) return;
        if (isBackground && (!isTabVisible() || aiAnalysisInFlight)) return;

        var aiContent = document.getElementById('ai-content');
        var aiLoading = document.getElementById('ai-loading');
        var m = window.__i18nMap || {};
        var gen = ++aiAnalysisGen;
        aiAnalysisInFlight = true;

        if (!isBackground && aiContent && aiLoading) {
            aiContent.style.display = 'none';
            aiLoading.style.display = 'flex';
            aiLoading.textContent = (m['ai.analyzing'] ? (m['ai.analyzing'] + ' ' + symbol + '...') : ('Анализ ' + symbol + '...'));
        }

        var fullSymbol = symbol + 'USDT';
        // Match AI base timeframe to the chart the user is looking at
        var baseTF = chartIntervalToBinance(currentChartInterval);
        var limit = isBackground ? 200 : 150;
        var baseUrl = 'https://fapi.binance.com/fapi/v1/klines?symbol=' + fullSymbol + '&interval=' + baseTF + '&limit=' + limit;
        var rsi5mUrl = 'https://fapi.binance.com/fapi/v1/klines?symbol=' + fullSymbol + '&interval=5m&limit=' + limit;

        var higherTFs = AIEngine.HIGHER_TF_MAP[baseTF] || [];
        var longTermTFs = ['4h', '1d'];
        var allHTF = {};
        higherTFs.forEach(function (tf) { allHTF[tf] = true; });
        longTermTFs.forEach(function (tf) { allHTF[tf] = true; });
        var uniqueHTF = Object.keys(allHTF);

        function stillCurrent() {
            return gen === aiAnalysisGen && selectedSymbol === symbol;
        }

        // Fast path: show panel ASAP from 15m + 5m, then enrich with HTF
        Promise.all([fetchOHLC(baseUrl), fetchOHLC(rsi5mUrl)])
            .then(function (fast) {
                if (!stillCurrent()) return;
                var ohlc = fast[0];
                if (!ohlc) {
                    if (!isBackground && aiLoading && stillCurrent()) {
                        aiLoading.textContent = (m['ai.insufficientData'] ? (m['ai.insufficientData'] + ' ' + symbol) : ('Недостаточно данных для ' + symbol));
                    }
                    return;
                }
                var rsi5m = AIEngine.calcRSIFromOHLC(fast[1], 14);
                var quick = AIEngine.analyzeChart(ohlc, baseTF, symbol, {});
                if (!stillCurrent()) return;
                quick.rsi5m = rsi5m;
                analysisCache[symbol] = quick;
                displayAIResult(symbol, quick);

                var htfFetches = uniqueHTF.map(function (tf) {
                    return fetchOHLC('https://fapi.binance.com/fapi/v1/klines?symbol=' + fullSymbol + '&interval=' + tf + '&limit=' + limit);
                });
                return Promise.all(htfFetches).then(function (htfResults) {
                    if (!stillCurrent()) return;
                    var htfCache = {};
                    for (var i = 0; i < uniqueHTF.length; i++) {
                        if (htfResults[i]) htfCache[uniqueHTF[i]] = htfResults[i];
                    }
                    var full = AIEngine.analyzeChart(ohlc, baseTF, symbol, htfCache);
                    if (!stillCurrent()) return;
                    full.rsi5m = rsi5m;
                    analysisCache[symbol] = full;
                    displayAIResult(symbol, full);
                });
            })
            .catch(function () {
                if (!isBackground && stillCurrent() && aiLoading) {
                    aiLoading.textContent = (m['ai.analysisError'] ? (m['ai.analysisError'] + ' ' + symbol) : ('Ошибка анализа ' + symbol));
                }
            })
            .then(function () {
                if (gen === aiAnalysisGen) aiAnalysisInFlight = false;
            });
    }

    function renderTrendPointer(r) {
        var box = document.getElementById('ai-trend-pointer');
        var arrow = document.getElementById('ai-trend-arrow');
        var label = document.getElementById('ai-trend-label');
        var strEl = document.getElementById('ai-trend-str');
        if (!box || !arrow || !label) return;
        var ct = r.chartTrend || {};
        var dir = ct.direction || r.direction || 'sideways';
        var strength = ct.strength != null ? ct.strength : (r.strength || 0);
        var conf = ct.confidence != null ? ct.confidence : Math.max(0, Math.min(100, Math.round(strength)));
        var m = window.__i18nMap || {};
        var text = dir === 'up'
            ? (m['trend.up'] || 'Рост')
            : dir === 'down'
                ? (m['trend.down'] || 'Спад')
                : (m['trend.flat'] || 'Боковик');
        var arr = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
        box.setAttribute('data-dir', dir);
        box.title = (m['trend.byChart'] || 'Тренд по графику') + ': ' + text + ' · ' + strength + '%';
        arrow.textContent = arr;
        label.textContent = text;
        if (strEl) strEl.textContent = strength + '% · ' + conf + '%';
    }

    function chartIntervalToBinance(iv) {
        var n = String(iv || currentChartInterval || '15');
        var map = {
            '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
            '45': '30m', '60': '1h', '120': '2h', '180': '4h', '240': '4h',
            '360': '6h', '480': '8h', '720': '12h',
            'D': '1d', '1D': '1d', 'W': '1w', '1W': '1w'
        };
        return map[n] || '15m';
    }

    function renderShortTermHorizons(r) {
        var grid = document.getElementById('shortterm-grid');
        if (!grid || !r.horizons) return;
        var indices = [0, 1, 4, 5]; // 1м, 5м, 30м, 1ч
        var rsi5m = r.rsi5m != null ? r.rsi5m : r.rsi;
        var html = '';
        for (var i = 0; i < indices.length; i++) {
            var h = r.horizons[indices[i]];
            if (!h) continue;
            var arrow = h.direction === 'up' ? '↑' : h.direction === 'down' ? '↓' : '→';
            var rsi = indices[i] <= 1 ? rsi5m : r.rsi;
            html += '<div class="shortterm-item ' + h.direction + '">';
            html += '<div class="st-label">' + h.label + '</div>';
            html += '<div class="st-arrow">' + arrow + '</div>';
            html += '<div class="st-str">' + h.strength + '%</div>';
            if (rsi != null) html += '<div class="st-rsi">RSI ' + rsi.toFixed(0) + '</div>';
            html += '</div>';
        }
        grid.innerHTML = html;
    }

    function renderSMCForecast(r, d) {
        var panel = document.getElementById('smc-forecast-panel');
        if (!panel) return;
        var smc = r.smcForecast;
        var m = window.__i18nMap || {};
        var t = function (key, fallback) { return (m && m[key]) ? m[key] : fallback; };

        if (!smc) {
            panel.innerHTML = '<div class="smc-empty">' + t('smc.noData', 'Недостаточно данных для SMC-анализа') + '</div>';
            return;
        }

        var html = '';

        // RU: engine narrative; other langs: localized static summary
        var lang = 'ru';
        try { lang = currentAppLang || localStorage.getItem('ft_lang') || 'ru'; } catch (e) {}
        var summaryText = (lang === 'ru')
            ? (smc.summary || m['smc.summary.' + smc.direction] || '')
            : (m['smc.summary.' + smc.direction] || smc.summary || '');
        html += '<div class="smc-summary">' + summaryText + '</div>';

        if (smc.signals && smc.signals.length) {
            html += '<div class="smc-signals">';
            for (var si = 0; si < smc.signals.length; si++) {
                var sig = smc.signals[si];
                html += '<div class="smc-signal ' + sig.type + '">' + t(sig.key, sig.text) + '</div>';
            }
            html += '</div>';
        }

        panel.innerHTML = html;
    }

    function renderScoreSummary(symbol, r) {
        var box = document.getElementById('ai-score-summary');
        if (!box || !r) return;

        var t = function (key, fallback) {
            var m = window.__i18nMap || {};
            return (m && m[key]) ? m[key] : fallback;
        };
        var lang = 'ru';
        try { lang = currentAppLang || localStorage.getItem('ft_lang') || 'ru'; } catch (e) {}
        var isRu = (lang === 'ru');
        var f = function (key, ruFallback, enFallback) {
            return t(key, isRu ? ruFallback : enFallback);
        };

        var p = r.price || 0;
        var atr = r.atr || p * 0.02;
        var dir = r.direction;

        var bullInd = 0, bearInd = 0, totalInd = 0;
        if (r.indicators) {
            var indKeys = Object.keys(r.indicators);
            totalInd = indKeys.length;
            for (var i = 0; i < indKeys.length; i++) {
                var v = r.indicators[indKeys[i]];
                if (v === 'bull' || v === 'golden') bullInd++;
                else if (v === 'bear' || v === 'death') bearInd++;
            }
        }

        var html = '<div class="forecast-advice score-summary-body">';
        html += '<strong>' + symbol + '</strong> — ';
        if (p >= 1000) html += f('forecast.liqHigh', 'высоколиквидный актив.', 'high-liquidity asset.') + ' ';
        else if (p >= 1) html += f('forecast.liqMid', 'средний по ликвидности актив.', 'medium-liquidity asset.') + ' ';
        else html += f('forecast.liqSpec', 'спекулятивный актив', 'speculative asset') + ' (' + f('forecast.volatility', 'волатильность', 'volatility') + ' ±' + (atr / p * 100 * 5).toFixed(0) + '–' + (atr / p * 100 * 10).toFixed(0) + '% ' + f('forecast.daily', 'ежедневно', 'daily') + '). ';
        html += t('forecast.adviceQuick', "Take profit quickly, don't hold without stops.") + ' ';
        html += f('forecast.watchRsi', 'Следи за RSI', 'Watch RSI') + ' ' + (dir === 'up' ? f('forecast.rsiUpHint', '>55–60 (подтверждение роста)', '>55–60 (uptrend confirmation)') : dir === 'down' ? f('forecast.rsiDownHint', '<40 (глубина перепроданности)', '<40 (depth of oversold)') : f('forecast.rsiSideHint', 'выход из 40–60 (направление пробоя)', 'break out of 40–60 (breakout direction)'));
        html += ' ' + f('forecast.andVolume', 'и объём', 'and volume') + ' ' + (r.reasoning && r.reasoning.some(function (rr) { return rr.indexOf('Объём') !== -1; }) ? f('forecast.volConfirmed', '(текущий тренд объёма подтверждён)', '(current volume trend is confirmed)') : f('forecast.volWatch', '(следить за изменением объёма)', '(watch volume changes)')) + '.';
        html += '<br><br><strong>' + t('forecast.signals', 'Signals') + ': ' + bullInd + ' / ' + bearInd + '</strong> ' + t('forecast.ofIndicators', 'of') + ' ' + totalInd + ' ' + t('forecast.indicatorsWord', 'indicators') + '.';
        if (r.bullScore != null && r.bearScore != null) {
            html += '<br><span class="score-summary-meta">' + f('forecast.scoring', 'Скоринг', 'Score') + ': 🟢 ' + Math.round(r.bullScore) + ' / 🔴 ' + Math.round(r.bearScore) + '</span>';
        }
        html += '</div>';

        box.innerHTML = html;
        box.style.display = 'block';
    }

    function displayAIResult(symbol, r) {
        if (!r) return;
        var aiContent = document.getElementById('ai-content');
        var aiLoading = document.getElementById('ai-loading');
        if (!aiContent || !aiLoading) return;

        // Capture scroll BEFORE any DOM modification
        var scrollContainer = document.getElementById('ai-panel');
        var currentScroll = 0;
        if (scrollContainer) {
            currentScroll = scrollContainer.scrollTop;
            scrollContainer.style.overflowY = 'hidden'; // Lock scrolling
            scrollContainer.style.height = scrollContainer.clientHeight + 'px'; // Freeze height physically
        }

        // Only toggle display if currently hidden to avoid layout thrashing
        if (aiContent.style.display !== 'block') {
            aiContent.style.display = 'block';
            aiLoading.style.display = 'none';
        }

        // Symbol & Price
        var aiSym = document.getElementById('ai-symbol');
        var aiPrice = document.getElementById('ai-price');
        if (aiSym) aiSym.textContent = symbol + ' / USDT';
        if (aiPrice) aiPrice.textContent = formatPrice(r.price);
        renderTrendPointer(r);

        var m = window.__i18nMap || {};

        // Volatility warning (BB squeeze — separate from reversal)
        var volWarn = document.getElementById('volatility-warning');
        var volReasons = document.getElementById('volatility-reasons');
        if (volWarn) {
            if (r.volatilityWarning && r.volatilityReasons && r.volatilityReasons.length > 0) {
                volWarn.style.display = 'block';
                if (volReasons) volReasons.textContent = r.volatilityReasons.map(translateReasoning).join(', ');
            } else {
                volWarn.style.display = 'none';
            }
        }

        // Early warning (pre-reversal signal)
        var ewWarn = document.getElementById('early-warning');
        if (ewWarn) {
            if (r.earlyWarning && r.earlyWarning.score >= 35) {
                ewWarn.style.display = 'block';
                var ewDir = r.earlyWarning.direction === 'up' ? (m['ai.earlyUp'] || 'Смена на РОСТ') : (m['ai.earlyDown'] || 'Смена на СПАД');
                ewWarn.className = 'early-warning ew-' + r.earlyWarning.direction;
                var ewTitle = document.getElementById('early-warning-title');
                var ewScore = document.getElementById('early-warning-score');
                var ewReasons = document.getElementById('early-warning-reasons');
                if (ewTitle) ewTitle.textContent = ewDir;
                if (ewScore) ewScore.textContent = r.earlyWarning.score + '%';
                if (ewReasons) ewReasons.textContent = (r.earlyWarning.reasons || []).slice(0, 4).map(translateReasoning).join(' \u2022 ');
            } else {
                ewWarn.style.display = 'none';
            }
        }

        // SMC Forecast panel (replaces horizon grid)
        renderSMCForecast(r, getDecimals(r.price));

        // Score / signals / ADX summary — above short-term forecast
        renderScoreSummary(symbol, r);

        // Short-term horizons (1м, 5м, 30м, 1ч)
        renderShortTermHorizons(r);

        // Long-term horizons (4ч, 1д, 1нед)
        var ltGrid = document.getElementById('longterm-grid');
        var ltHtml = '';
        var lth = r.longTermHorizons || [];
        for (var j = 0; j < lth.length; j++) {
            var lt = lth[j];
            var ltArrow = lt.direction === 'up' ? '↑' : lt.direction === 'down' ? '↓' : '→';
            ltHtml += '<div class="longterm-item ' + lt.direction + '">';
            ltHtml += '<div class="lt-label">' + lt.label + '</div>';
            ltHtml += '<div class="lt-arrow">' + ltArrow + '</div>';
            ltHtml += '<div class="lt-str">' + lt.strength + '%</div>';
            if (lt.rsi != null) ltHtml += '<div class="lt-rsi">RSI ' + lt.rsi.toFixed(0) + '</div>';
            ltHtml += '</div>';
        }
        if (ltGrid) ltGrid.innerHTML = ltHtml;

        // Indicators
        var iGrid = document.getElementById('indicator-grid');
        if (iGrid) {
            var iHtml = '';
            var indNames = Object.keys(r.indicators || {});
            var chipNamesRu = { EMAf: 'EMA\u0431', PvE: 'P/EMA', Candles: '\u0421\u0432\u0435\u0447\u0438' };
            for (var i = 0; i < indNames.length; i++) {
                var name = indNames[i];
                var val = r.indicators[name];
                var cls = (val === 'bull' || val === 'golden') ? 'bull' : (val === 'bear' || val === 'death') ? 'bear' : 'flat';
                var displayName = (m['ind.' + name] !== undefined ? m['ind.' + name] : chipNamesRu[name]) || name;
                iHtml += '<div class="indicator-chip ' + cls + '">' + displayName + '</div>';
            }
            iGrid.innerHTML = iHtml;
        }

        // Reasoning
        var rList = document.getElementById('reasoning-list');
        if (rList) {
            var rHtml = '';
            var reasons = r.reasoning || [];
            for (var ri = 0; ri < reasons.length; ri++) {
                rHtml += '<div class="reasoning-item">' + translateReasoning(reasons[ri]) + '</div>';
            }
            rList.innerHTML = rHtml;
        }

        // Detailed forecast
        var forecastDiv = document.getElementById('ai-forecast');
        if (forecastDiv) forecastDiv.innerHTML = generateDetailedAnalysis(symbol, r);

        if (scrollContainer) {
            // Restore scroll synchronously
            scrollContainer.scrollTop = currentScroll;

            // Release the container lock in the next browser paint layout frame
            requestAnimationFrame(function () {
                scrollContainer.style.overflowY = 'auto';
                scrollContainer.style.height = 'auto';
                scrollContainer.scrollTop = currentScroll; // Double enforce in case of smooth-scroll interference
            });
        }

        // Check for direction change & play sound
        checkDirectionChange(symbol, r.direction);
    }

    function generateDetailedAnalysis(symbol, r) {
        var t = function (key, fallback) {
            var m = window.__i18nMap || {};
            return (m && m[key]) ? m[key] : fallback;
        };
        var lang = (function () {
            try { return currentAppLang || localStorage.getItem('ft_lang') || document.documentElement.lang || 'ru'; } catch (e) { return document.documentElement.lang || 'ru'; }
        })();
        var isRu = (lang === 'ru');
        var f = function (key, ruFallback, enFallback) {
            return t(key, isRu ? ruFallback : enFallback);
        };

        var p = r.price;
        var atr = r.atr || p * 0.02;
        var d = getDecimals(p);
        var rsi = r.rsi || 50;
        var dir = r.direction;
        var str = r.strength;

        // Support & Resistance from ATR
        var sup1 = p - atr * 1.0;
        var sup2 = p - atr * 2.0;
        var sup3 = p - atr * 3.0;
        var res1 = p + atr * 1.0;
        var res2 = p + atr * 2.0;
        var res3 = p + atr * 3.0;

        // Bull/Bear probabilities from direction & strength
        var bullProb, bearProb;
        if (dir === 'up') {
            bullProb = Math.min(85, 50 + str * 0.4);
            bearProb = 100 - bullProb;
        } else if (dir === 'down') {
            bearProb = Math.min(85, 50 + str * 0.4);
            bullProb = 100 - bearProb;
        } else {
            bullProb = 50;
            bearProb = 50;
        }
        var bullRange = Math.round(bullProb / 10) * 10;
        var bearRange = 100 - bullRange;
        var bullLo = Math.max(10, bullRange - 10);
        var bullHi = Math.min(90, bullRange + 10);
        var bearLo = Math.max(10, bearRange - 10);
        var bearHi = Math.min(90, bearRange + 10);

        // Price change estimates
        var bullUpPct = ((res2 - p) / p * 100).toFixed(1);
        var bearDownPct = ((p - sup2) / p * 100).toFixed(1);
        var deepDownPct = ((p - sup3) / p * 100).toFixed(1);

        // Early warning integration (summary only, localized)
        var activeWarning = r.earlyWarning && r.earlyWarning.score >= 35 ? r.earlyWarning : null;
        var effectiveDir = activeWarning ? activeWarning.direction : dir;
        var adxVal = r.adx || 0;

        var shortText = '';
        if (activeWarning) {
            shortText += '<strong>' + (activeWarning.direction === 'up' ? t('forecast.reversalUp', 'Reversal UP expected') : t('forecast.reversalDown', 'Reversal DOWN expected')) + '</strong>. ';
            if (activeWarning.reasons && activeWarning.reasons.length) {
                shortText += t('forecast.because', 'Because') + ': ' + activeWarning.reasons.slice(0, 4).map(translateReasoning).join(', ') + '. ';
            }
            shortText += t('forecast.watchVolume', 'Watch volume near key levels.');
        } else if (dir === 'up') {
            shortText += '<strong>' + t('forecast.trendUp', 'Uptrend continuation') + '</strong>. ';
            shortText += t('forecast.rsi', 'RSI') + ' ' + rsi.toFixed(0) + ' — ' + (rsi > 60 ? t('forecast.rsiStrongUp', 'strong bullish momentum') : t('forecast.rsiModerateUp', 'moderate bullish momentum')) + '.';
        } else if (dir === 'down') {
            shortText += '<strong>' + t('forecast.trendDown', 'Downtrend continuation') + '</strong>. ';
            shortText += t('forecast.rsi', 'RSI') + ' ' + rsi.toFixed(0) + ' — ' + (rsi < 35 ? t('forecast.rsiOversold', 'oversold — bounce possible') : t('forecast.rsiDown', 'bearish trend')) + '.';
        } else {
            shortText += '<strong>' + t('forecast.sideways', 'Consolidation / sideways') + '</strong>. ';
            shortText += t('forecast.breakout', 'Expect a strong move after breakout.') + ' ' + t('forecast.rsi', 'RSI') + ' ' + rsi.toFixed(0) + '.';
        }

        // Horizon summary (using 15m and 1h horizons as reference)
        var hz_15m = r.horizons && r.horizons[3] ? r.horizons[3] : null; // 15m
        var hz_1h = r.horizons && r.horizons[5] ? r.horizons[5] : null;  // 1h

        // Build HTML — computer/HUD style icons (square strokes)
        var html = '';
        function fcIcon(inner, opts) {
            opts = opts || {};
            var size = opts.size || 16;
            var color = opts.color || 'currentColor';
            var sw = opts.sw || '1.8';
            return '<svg class="fc-icon fc-icon-tech" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="' + sw + '" stroke-linecap="square" stroke-linejoin="miter">' + inner + '</svg>';
        }
        var ICO = {
            bars: '<path d="M4 20V11h3v9H4zm6.5 0V6h3v14h-3zM17 20v-7h3v7h-3z"/><path d="M3 20h18"/>',
            trend: '<path d="M3 18h5v-4h4V9h4V5h5"/><path d="M17 5h4v4"/>',
            bull: '<path d="M5 19h14"/><path d="M7 13l5-7 5 7"/><path d="M12 6v8"/>',
            bear: '<path d="M5 5h14"/><path d="M7 11l5 7 5-7"/><path d="M12 18V10"/>',
            real: '<rect x="4" y="4" width="16" height="16"/><path d="M8 12h8"/><path d="M12 8v8" opacity="0.35"/>',
            recs: '<rect x="3" y="3" width="18" height="18"/><path d="M12 3v18M3 12h18"/><rect x="9" y="9" width="6" height="6"/>',
            long: '<path d="M6 16h5V9h7"/><path d="M14 5h4v4"/><path d="M14 9l4-4"/>',
            short: '<path d="M18 8h-5v7H6"/><path d="M10 19H6v-4"/><path d="M10 15l-4 4"/>',
            advice: '<rect x="6" y="6" width="12" height="12"/><rect x="9" y="9" width="6" height="6"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'
        };

        // Question header
        html += '<div class="forecast-question">' + fcIcon(ICO.bars, { size: 18, color: 'var(--primary)' }) + ' ' + t('forecast.question', 'Where will price go next?') + '</div>';

        // Short-term section
        html += '<div class="forecast-section">';
        html += '<div class="forecast-section-title short-term">' + fcIcon(ICO.trend) + ' ' + t('forecast.shortTitle', 'Short-term forecast') + '</div>';
        html += '<div class="forecast-text">' + shortText + '</div>';
        if (hz_15m && hz_1h) {
            var dir15 = hz_15m.direction === 'up' ? ('↑ ' + t('ai.dirUp', 'Up')) : hz_15m.direction === 'down' ? ('↓ ' + t('ai.dirDown', 'Down')) : ('→ ' + t('ai.dirSide', 'Sideways'));
            var dir1h = hz_1h.direction === 'up' ? ('↑ ' + t('ai.dirUp', 'Up')) : hz_1h.direction === 'down' ? ('↓ ' + t('ai.dirDown', 'Down')) : ('→ ' + t('ai.dirSide', 'Sideways'));
            html += '<div class="forecast-text">' + t('forecast.expect15m', '15m') + ': <strong>' + dir15 + ' (' + hz_15m.strength + '%)</strong>';
            html += ' → ' + t('forecast.expect1h', '1h') + ': <strong>' + dir1h + ' (' + hz_1h.strength + '%)</strong></div>';
        }
        html += '</div>';

        // Bull scenario
        html += '<div class="forecast-section">';
        html += '<div class="forecast-section-title bull">' + fcIcon(ICO.bull) + ' ' + t('forecast.bullScenario', 'Bull scenario') + ' (' + bullLo + '–' + bullHi + '%)</div>';
        html += '<div class="forecast-text">';
        if (dir === 'up' || dir === 'sideways') {
            html += f('forecast.bullSupportHolds', 'Поддержка удержится на уровне', 'Support holds at') + ' <span class="price-tag">' + sup1.toFixed(d) + '</span> → ' + f('forecast.bullBounceTo', 'отскок к', 'bounce to') + ' ';
            html += '<span class="price-tag">' + res1.toFixed(d) + '</span> – <span class="price-tag">' + res2.toFixed(d) + '</span> (+' + bullUpPct + '%). ';
            html += f('forecast.bullIfRsi', 'Если RSI закрепится выше 55–60 и объём вернётся, возможен ретест', 'If RSI holds above 55–60 and volume returns, a retest is possible at') + ' <span class="price-tag">' + res3.toFixed(d) + '</span>.';
        } else {
            html += f('forecast.bullBounceFrom', 'Краткосрочный отскок от', 'Short-term bounce from') + ' <span class="price-tag">' + sup1.toFixed(d) + '</span> ' + f('forecast.bullBounceTo', 'к', 'to') + ' ';
            html += '<span class="price-tag">' + res1.toFixed(d) + '</span> (+' + ((res1 - p) / p * 100).toFixed(1) + '%). ';
            html += f('forecast.bullConfirm', 'Для подтверждения разворота необходим пробой', 'To confirm reversal, a breakout above') + ' <span class="price-tag">' + res2.toFixed(d) + '</span> ' + f('forecast.withVolume', 'с объёмом', 'with volume') + '.';
        }
        html += '</div>';
        html += '</div>';

        // Bear scenario
        html += '<div class="forecast-section">';
        html += '<div class="forecast-section-title bear">' + fcIcon(ICO.bear) + ' ' + t('forecast.bearScenario', 'Bear scenario') + ' (' + bearLo + '–' + bearHi + '%)</div>';
        html += '<div class="forecast-text">';
        if (dir === 'down' || dir === 'sideways') {
            html += f('forecast.bearIfBreak', 'Если поддержка', 'If support') + ' <span class="price-tag">' + sup1.toFixed(d) + '</span> ' + f('forecast.bearBreakVerb', 'сломается', 'breaks') + ' → ' + f('forecast.bearDumpTo', 'дамп к', 'drop to') + ' ';
            html += '<span class="price-tag">' + sup2.toFixed(d) + '</span> (−' + bearDownPct + '%). ';
            html += f('forecast.bearDeep', 'Глубокий откат до', 'A deeper move to') + ' <span class="price-tag">' + sup3.toFixed(d) + '</span> (−' + deepDownPct + '%) ' + f('forecast.bearOnMarket', 'возможен при общем сбросе', 'is possible on broader market sell-off') + '.';
        } else {
            html += f('forecast.bearPullbackFrom', 'Откат от сопротивления', 'Pullback from resistance') + ' <span class="price-tag">' + res1.toFixed(d) + '</span> ' + f('forecast.bearPullbackTo', 'к', 'to') + ' ';
            html += '<span class="price-tag">' + sup1.toFixed(d) + '</span> – <span class="price-tag">' + sup2.toFixed(d) + '</span>. ';
            html += f('forecast.bearIfLose', 'При потере', 'If price loses') + ' <span class="price-tag">' + sup2.toFixed(d) + '</span> — ' + f('forecast.bearRisk', 'риск падения к', 'risk of falling to') + ' <span class="price-tag">' + sup3.toFixed(d) + '</span>.';
        }
        html += '</div>';
        html += '</div>';

        // Realistic scenario
        html += '<div class="forecast-section">';
        html += '<div class="forecast-section-title realistic">' + fcIcon(ICO.real) + ' ' + t('forecast.realistic', 'Realistic') + '</div>';
        html += '<div class="forecast-text">';
        var rLow = dir === 'down' ? sup1 : (p - atr * 0.5);
        var rHigh = dir === 'up' ? res1 : (p + atr * 0.5);
        html += '<span class="price-tag">' + rLow.toFixed(d) + '</span> – <span class="price-tag">' + rHigh.toFixed(d) + '</span> — ';
        if (dir === 'sideways') {
            html += f('forecast.realSideways', 'консолидация в узком диапазоне. Ожидание пробоя с направлением по тренду старших ТФ.', 'tight range consolidation. Watch for a breakout aligned with higher timeframes.');
        } else if (dir === 'up') {
            html += f('forecast.realUp1', 'умеренный рост с тестом', 'moderate rise with a test of') + ' <span class="price-tag">' + res2.toFixed(d) + '</span> ' + f('forecast.realUp2', 'при сохранении покупательского интереса.', 'if buying interest persists.');
        } else {
            html += f('forecast.realDown1', 'продолжение давления с поддержкой на', 'continued pressure with support at') + ' <span class="price-tag">' + sup1.toFixed(d) + '</span>. ' + f('forecast.realDown2', 'Отскок вероятен при RSI < 30.', 'A bounce is likely if RSI < 30.');
        }
        html += '</div>';
        html += '</div>';

        // Recommendations
        html += '<div class="forecast-section">';
        html += '<div class="forecast-section-title recs">' + fcIcon(ICO.recs) + ' ' + t('forecast.recommendations', 'Recommendations') + '</div>';
        html += '<div class="forecast-rec-grid">';

        // Long (enhanced quality with ADX + divergence + warnings)
        var longQuality;
        if (activeWarning && activeWarning.direction === 'up') longQuality = f('forecast.qualityLongSpec', 'спекулятивный лонг на опережение (сигнал разворота)', 'Speculative long ahead of reversal');
        else if (dir === 'up' && adxVal > 25) longQuality = f('forecast.qualityTrendAdx', 'по тренду (подтверждён ADX)', 'Trend (ADX confirmed)');
        else if (dir === 'up') longQuality = f('forecast.qualityTrendWeak', 'по тренду, но слабый ADX — осторожно', 'Trend but weak ADX — cautious');
        else if (dir === 'sideways') longQuality = f('forecast.qualityFromSupport', 'осторожный вход от поддержки', 'Cautious entry from support');
        else if (r.rsiDivergence && r.rsiDivergence.bullish) longQuality = f('forecast.qualityCounterRsi', 'контр-трендовый, но RSI дивергенция поддерживает', 'Counter-trend but RSI divergence supports');
        else longQuality = f('forecast.qualityRisky', 'рискованно (против тренда)', 'Risky (against trend)');
        var longEntry = effectiveDir === 'up' ? sup1 : (p - atr * 0.3);
        var longStop = sup2;
        html += '<div class="forecast-rec long-rec">';
        html += '<span class="rec-label">' + fcIcon(ICO.long, { size: 14, color: 'var(--primary)', sw: '2' }) + ' ' + t('forecast.long', 'Long') + ' — ' + longQuality + '</span>';
        html += t('forecast.entry', 'Entry') + ': <span class="price-tag">' + longEntry.toFixed(d) + '</span> – <span class="price-tag">' + p.toFixed(d) + '</span>';
        html += '<br>' + t('forecast.stop', 'Stop') + ': ' + t('forecast.below', 'below') + ' <span class="price-tag">' + longStop.toFixed(d) + '</span>';
        html += '<br>' + t('forecast.take', 'Take') + ': <span class="price-tag">' + res1.toFixed(d) + '</span> / <span class="price-tag">' + res2.toFixed(d) + '</span> / <span class="price-tag">' + res3.toFixed(d) + '</span>';
        html += '</div>';

        // Short (enhanced quality with ADX + divergence + warnings)
        var shortQuality;
        if (activeWarning && activeWarning.direction === 'down') shortQuality = f('forecast.qualityShortSpec', 'спекулятивный шорт на опережение (сигнал разворота)', 'Speculative short ahead of reversal');
        else if (dir === 'down' && adxVal > 25) shortQuality = f('forecast.qualityTrendAdx', 'по тренду (подтверждён ADX)', 'Trend (ADX confirmed)');
        else if (dir === 'down') shortQuality = f('forecast.qualityTrendWeak', 'по тренду, но слабый ADX — осторожно', 'Trend but weak ADX — cautious');
        else if (dir === 'sideways') shortQuality = f('forecast.qualityFromResistance', 'от сопротивления с жёстким стопом', 'From resistance with tight stop');
        else if (r.rsiDivergence && r.rsiDivergence.bearish) shortQuality = f('forecast.qualityCounterRsi', 'контр-трендовый, но RSI дивергенция поддерживает', 'Counter-trend but RSI divergence supports');
        else shortQuality = f('forecast.qualityRisky', 'рискованно (против тренда)', 'Risky (against trend)');
        var shortEntry = effectiveDir === 'down' ? res1 : (p + atr * 0.3);
        var shortStop = res2;
        html += '<div class="forecast-rec short-rec">';
        html += '<span class="rec-label">' + fcIcon(ICO.short, { size: 14, color: 'var(--accent)', sw: '2' }) + ' ' + t('forecast.short', 'Short') + ' — ' + shortQuality + '</span>';
        html += t('forecast.entry', 'Entry') + ': <span class="price-tag">' + p.toFixed(d) + '</span> – <span class="price-tag">' + shortEntry.toFixed(d) + '</span>';
        html += '<br>' + t('forecast.stop', 'Stop') + ': ' + t('forecast.above', 'above') + ' <span class="price-tag">' + shortStop.toFixed(d) + '</span>';
        html += '<br>' + t('forecast.take', 'Take') + ': <span class="price-tag">' + sup1.toFixed(d) + '</span> / <span class="price-tag">' + sup2.toFixed(d) + '</span>';
        html += '</div>';

        html += '</div>'; // forecast-rec-grid
        html += '</div>'; // forecast-section

        // Timestamp
        var now = new Date();
        var ts = ('0' + now.getDate()).slice(-2) + '.' + ('0' + (now.getMonth() + 1)).slice(-2) + '.' + now.getFullYear() + ' ' + ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
        html += '<div class="forecast-timestamp">🤖 ' + t('forecast.engine', 'AI Engine v2.2') + ' · ' + ts + '</div>';

        return html;
    }

    function getDecimals(p) {
        if (p >= 1000) return 1;
        if (p >= 100) return 2;
        if (p >= 1) return 3;
        if (p >= 0.01) return 5;
        return 7;
    }

    // === WATCHLIST UI ===
    window.toggleWatch = function () {
        if (!selectedSymbol) return;
        if (isWatched(selectedSymbol)) removeWatch(selectedSymbol);
        else addWatch(selectedSymbol);
        renderCoinList();
    };

    window.toggleWatchFromList = function (symbol) {
        if (isWatched(symbol)) removeWatch(symbol);
        else addWatch(symbol);
        renderCoinList();
    };

    window.toggleWatchlist = function () {
        var willOpen = !watchlistVisible;
        if (willOpen) {
            closeCtbMenus();
            if (tfPickerOpen) closeTfPicker();
            var langWrap = document.getElementById('topbar-lang-wrap');
            if (langWrap) langWrap.classList.remove('dropdown-open');
            if (userMenuVisible) {
                userMenuVisible = false;
                var overlay = document.getElementById('user-menu-overlay');
                var popup = document.getElementById('user-menu-popup');
                if (overlay) overlay.classList.remove('visible');
                if (popup) popup.classList.remove('visible');
            }
        }
        watchlistVisible = willOpen;
        document.getElementById('watchlist-panel').classList.toggle('visible', watchlistVisible);
        if (watchlistVisible) updateWatchlistUI();
    };

    window.closeAIPanelMobile = function () {
        var aiPanel = document.getElementById('ai-panel');
        if (aiPanel) aiPanel.classList.remove('mobile-open');
    };

    function updateWatchlistUI() {
        var wl = getWatchlist();
        document.getElementById('wl-count').textContent = wl.length;
        var grid = document.getElementById('watchlist-grid');
        if (wl.length === 0) {
            var m = window.__i18nMap || {};
            grid.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:0.8rem;grid-column:1/-1">' + (m['watchlist.empty'] || 'Нет отслеживаемых монет. Нажмите ★ чтобы добавить.') + '</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < wl.length; i++) {
            var s = wl[i];
            var cached = analysisCache[s];
            var dir = cached ? cached.direction : '—';
            var dirClass = cached ? cached.direction : '';
            var dirLabel = dir === 'up' ? '↑' : dir === 'down' ? '↓' : dir === 'sideways' ? '→' : '•';
            html += '<div class="watchlist-item" onclick="selectCoin(\'' + s + '\')">';
            html += '<span class="wl-symbol">' + s + '</span>';
            html += '<span class="wl-dir ' + dirClass + '">' + dirLabel + '</span>';
            html += '</div>';
        }
        grid.innerHTML = html;
    }

    // === SOUND ALERTS ===
    window.toggleSound = function () {
        soundEnabled = !soundEnabled;
        var btn = document.getElementById('sound-toggle');
        btn.classList.toggle('active', soundEnabled);
    };

    function playSound(direction) {
        if (!soundEnabled) return;
        var id = direction === 'up' ? 'snd-up' : direction === 'down' ? 'snd-down' : 'snd-side';
        var audio = document.getElementById(id);
        if (audio) {
            audio.currentTime = 0;
            audio.play().catch(function () { });
        }
    }

    function checkDirectionChange(symbol, newDir) {
        if (!isWatched(symbol)) return;
        var prev = lastDirections[symbol];
        lastDirections[symbol] = newDir;
        if (prev && prev !== newDir) {
            playSound(newDir);
        }
    }

    // === WATCHLIST AUTO-UPDATE ===
    function startWatchlistUpdater() {
        if (watchlistUpdateTimer) clearInterval(watchlistUpdateTimer);
        watchlistUpdateTimer = setInterval(function () {
            var wl = getWatchlist();
            if (wl.length === 0) return;
            // Update one coin at a time (round-robin)
            var idx = Math.floor(Date.now() / 15000) % wl.length;
            var symbol = wl[idx];
            var fullSymbol = symbol + 'USDT';
            var baseTF = '15m';
            var higherTFs = AIEngine.HIGHER_TF_MAP[baseTF] || [];

            var fetches = [fetchOHLC('https://fapi.binance.com/fapi/v1/klines?symbol=' + fullSymbol + '&interval=' + baseTF + '&limit=100')];
            for (var i = 0; i < higherTFs.length; i++) {
                fetches.push(fetchOHLC('https://fapi.binance.com/fapi/v1/klines?symbol=' + fullSymbol + '&interval=' + higherTFs[i] + '&limit=100'));
            }

            Promise.all(fetches)
                .then(function (results) {
                    var ohlc = results[0];
                    if (!ohlc) return;
                    var htfCache = {};
                    for (var i = 0; i < higherTFs.length; i++) {
                        if (results[i + 1]) htfCache[higherTFs[i]] = results[i + 1];
                    }
                    var result = AIEngine.analyzeChart(ohlc, baseTF, symbol, htfCache);
                    analysisCache[symbol] = result;

                    // Update emulator price if it's the selected coin
                    if (emulatorVisible && symbol === selectedSymbol) {
                        var c = coins.find(function (coin) { return coin.symbol === symbol; });
                        if (c) {
                            c.price = result.price;
                            document.getElementById('emu-price').textContent = formatPrice(result.price);
                        }
                    }

                    checkDirectionChange(symbol, result.direction);
                    updateWatchlistUI();
                })
                .catch(function () { });
        }, 15000);
    }

    // === EMULATOR LOGIC ===
    window.toggleEmulator = function () {
        emulatorVisible = !emulatorVisible;
        var panel = document.getElementById('emulator-panel');
        var btn = document.getElementById('emulator-toggle');
        if (!panel || !btn) return;

        if (emulatorVisible) {
            panel.classList.add('visible');
            btn.classList.add('active');
            updateEmulatorUI();
        } else {
            panel.classList.remove('visible');
            btn.classList.remove('active');
        }
    };

    window.updateEmulatorUI = function () {
        if (!emulatorVisible) return;

        var symbolEl = document.getElementById('emu-symbol');
        var priceEl = document.getElementById('emu-price');
        var levLabel = document.getElementById('emu-leverage-val');
        var levSlider = document.getElementById('emu-leverage');
        var marginInput = document.getElementById('emu-margin');
        var volEl = document.getElementById('emu-volume');
        var feeEl = document.getElementById('emu-fee');

        var coin = coins.find(function (c) { return c.symbol === selectedSymbol; });
        var priceStr = coin && coin.price > 0 ? formatPrice(coin.price) : '0.00';

        symbolEl.textContent = (selectedSymbol || '---') + (selectedSymbol ? 'USDT' : '');
        priceEl.textContent = priceStr;

        currentLeverage = parseInt(levSlider.value) || 20;
        levLabel.textContent = currentLeverage + 'x';

        currentMargin = parseFloat(marginInput.value) || 0;
        var volume = currentMargin * currentLeverage;
        var fee = volume * TAKER_FEE_RATE;

        volEl.textContent = '$' + volume.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        feeEl.textContent = '$' + fee.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    };

    // === TP/SL Functions ===
    window.toggleTPSL = function () {
        var cb = document.getElementById('emu-tpsl-enabled');
        cb.checked = !cb.checked;
        onTPSLToggle();
    };

    window.onTPSLToggle = function () {
        var enabled = document.getElementById('emu-tpsl-enabled').checked;
        var fields = document.getElementById('emu-tpsl-fields');
        fields.style.display = enabled ? 'block' : 'none';
        if (!enabled) {
            document.getElementById('emu-tp-price').value = '';
            document.getElementById('emu-sl-price').value = '';
            document.getElementById('emu-tp-pnl').textContent = 'PnL: —';
            document.getElementById('emu-tp-pnl').className = 'emu-tpsl-pnl';
            document.getElementById('emu-sl-pnl').textContent = 'PnL: —';
            document.getElementById('emu-sl-pnl').className = 'emu-tpsl-pnl';
        }
    };

    window.updateTPSLEstimate = function () {
        var coin = coins.find(function (c) { return c.symbol === selectedSymbol; });
        if (!coin || coin.price <= 0) return;
        var price = coin.price;
        var margin = parseFloat(document.getElementById('emu-margin').value) || 0;
        var leverage = parseInt(document.getElementById('emu-leverage').value) || 20;
        var volume = margin * leverage;
        if (volume <= 0) return;

        var tp = parseFloat(document.getElementById('emu-tp-price').value);
        var sl = parseFloat(document.getElementById('emu-sl-price').value);

        var tpPnlEl = document.getElementById('emu-tp-pnl');
        var slPnlEl = document.getElementById('emu-sl-pnl');

        // Estimate for LONG direction (TP above, SL below)
        // For SHORT it's reversed, but we show generic estimate
        if (tp > 0 && !isNaN(tp)) {
            var tpPnlLong = ((tp - price) / price) * volume;
            var tpPnlShort = ((price - tp) / price) * volume;
            var tpFee = Math.abs(tp > price ? tpPnlLong : tpPnlShort) * 0 + volume * TAKER_FEE_RATE;
            // Show for likely direction
            var tpPnl = tp > price ? tpPnlLong - tpFee : tpPnlShort - tpFee;
            var tpLabel = tp > price ? 'Long' : 'Short';
            tpPnlEl.textContent = 'PnL (' + tpLabel + '): ' + (tpPnl >= 0 ? '+' : '') + '$' + tpPnl.toFixed(2);
            tpPnlEl.className = 'emu-tpsl-pnl ' + (tpPnl >= 0 ? 'positive' : 'negative');
        } else {
            tpPnlEl.textContent = 'PnL: —';
            tpPnlEl.className = 'emu-tpsl-pnl';
        }

        if (sl > 0 && !isNaN(sl)) {
            var slPnlLong = ((sl - price) / price) * volume;
            var slPnlShort = ((price - sl) / price) * volume;
            var slFee = volume * TAKER_FEE_RATE;
            var slPnl = sl < price ? slPnlLong - slFee : slPnlShort - slFee;
            var slLabel = sl < price ? 'Long' : 'Short';
            slPnlEl.textContent = 'PnL (' + slLabel + '): ' + (slPnl >= 0 ? '+' : '') + '$' + slPnl.toFixed(2);
            slPnlEl.className = 'emu-tpsl-pnl ' + (slPnl >= 0 ? 'positive' : 'negative');
        } else {
            slPnlEl.textContent = 'PnL: —';
            slPnlEl.className = 'emu-tpsl-pnl';
        }
    };

    window.openPosition = function (type) {
        if (!selectedSymbol) return alert("Выберите монету для торговли.");
        var coin = coins.find(function (c) { return c.symbol === selectedSymbol; });
        if (!coin || coin.price <= 0) return alert("Цена монеты не загружена.");

        var margin = parseFloat(document.getElementById('emu-margin').value) || 0;
        var leverage = parseInt(document.getElementById('emu-leverage').value) || 20;

        if (margin <= 0) return alert("Введите корректную маржу.");
        if (demoState.balance < margin) return alert("Недостаточно средств на демо-счете!");

        var volume = margin * leverage;
        var fee = volume * TAKER_FEE_RATE; // Opening fee

        // Require balance for margin + opening fee
        if (demoState.balance < (margin + fee)) {
            return alert("Недостаточно средств для маржи и комиссии открытия!");
        }

        // TP/SL validation
        var tpslEnabled = document.getElementById('emu-tpsl-enabled').checked;
        var tpPrice = null, slPrice = null;

        if (tpslEnabled) {
            var tpVal = parseFloat(document.getElementById('emu-tp-price').value);
            var slVal = parseFloat(document.getElementById('emu-sl-price').value);

            if (tpVal > 0 && !isNaN(tpVal)) {
                if (type === 'LONG' && tpVal <= coin.price) return alert("Тейк-профит для LONG должен быть выше текущей цены (" + formatPrice(coin.price) + ")");
                if (type === 'SHORT' && tpVal >= coin.price) return alert("Тейк-профит для SHORT должен быть ниже текущей цены (" + formatPrice(coin.price) + ")");
                tpPrice = tpVal;
            }

            if (slVal > 0 && !isNaN(slVal)) {
                if (type === 'LONG' && slVal >= coin.price) return alert("Стоп-лосс для LONG должен быть ниже текущей цены (" + formatPrice(coin.price) + ")");
                if (type === 'SHORT' && slVal <= coin.price) return alert("Стоп-лосс для SHORT должен быть выше текущей цены (" + formatPrice(coin.price) + ")");
                slPrice = slVal;
            }
        }

        // Deduct from balance
        demoState.balance -= margin;
        demoState.balance -= fee;

        var pos = {
            id: Date.now() + Math.random().toString(36).substring(2, 9),
            symbol: selectedSymbol + 'USDT',
            type: type, // 'LONG' or 'SHORT'
            leverage: leverage,
            margin: margin,
            volume: volume,
            entryPrice: coin.price,
            fee: fee, // Initial fee, will add closing fee later
            openTime: new Date().toISOString(),
            takeProfit: tpPrice,
            stopLoss: slPrice
        };

        demoState.activePositions.push(pos);
        saveDemoState();

        if (historyVisible) updateHistoryUI();

        // Show success animation on button
        var btn = type === 'LONG' ? document.querySelector('.btn-long') : document.querySelector('.btn-short');
        var origText = btn.textContent;
        var tpslText = '';
        if (tpPrice || slPrice) {
            tpslText = ' (';
            if (tpPrice) tpslText += 'TP: ' + formatPrice(tpPrice);
            if (tpPrice && slPrice) tpslText += ' | ';
            if (slPrice) tpslText += 'SL: ' + formatPrice(slPrice);
            tpslText += ')';
        }
        btn.textContent = "✓ ОТКРЫТО" + tpslText;
        btn.style.backgroundColor = "var(--primary)";
        btn.style.color = "#000";
        btn.style.fontSize = tpslText ? "0.62rem" : "";
        setTimeout(function () {
            btn.textContent = origText;
            btn.style.backgroundColor = "";
            btn.style.color = "";
            btn.style.fontSize = "";
        }, 1500);
    };

    window.closePosition = function (id) {
        var idx = -1;
        for (var i = 0; i < demoState.activePositions.length; i++) {
            if (demoState.activePositions[i].id === id) { idx = i; break; }
        }
        if (idx === -1) return;

        var pos = demoState.activePositions[idx];
        var cleanSymbol = pos.symbol.replace('USDT', '');
        var coin = coins.find(function (c) { return c.symbol === cleanSymbol; });
        var currentPrice = coin && coin.price > 0 ? coin.price : pos.entryPrice;

        var currentVolume = (pos.volume / pos.entryPrice) * currentPrice;
        var closingFee = currentVolume * TAKER_FEE_RATE;

        var pnl = 0;
        if (pos.type === 'LONG') {
            pnl = (currentPrice - pos.entryPrice) / pos.entryPrice * pos.volume;
        } else {
            pnl = (pos.entryPrice - currentPrice) / pos.entryPrice * pos.volume;
        }

        var netPnl = pnl - closingFee;

        // Return margin and add net PnL
        demoState.balance += pos.margin + netPnl;

        pos.exitPrice = currentPrice;
        pos.closeTime = new Date().toISOString();
        pos.pnl = netPnl;
        pos.fee += closingFee;

        demoState.activePositions.splice(idx, 1);
        demoState.history.unshift(pos);

        if (demoState.history.length > 50) {
            demoState.history.pop();
        }

        saveDemoState();
        updateHistoryUI();
    };

    window.toggleHistoryModal = function () {
        historyVisible = !historyVisible;
        var overlay = document.getElementById('history-modal-overlay');
        if (historyVisible) {
            overlay.classList.add('visible');
            updateHistoryUI();

            // Start fast price updates for active positions
            if (!priceUpdateInterval) {
                priceUpdateInterval = setInterval(fetchActivePricesAndUpdate, 1500);
            }
        } else {
            overlay.classList.remove('visible');
            if (priceUpdateInterval) {
                clearInterval(priceUpdateInterval);
                priceUpdateInterval = null;
            }
        }
    };

    // Fast price fetcher for active positions — runs every 1.5s while modal is open
    function fetchActivePricesAndUpdate() {
        if (!historyVisible || demoState.activePositions.length === 0) {
            updateHistoryUIActive();
            return;
        }

        // Collect unique symbols from active positions
        var symbolsSet = {};
        for (var i = 0; i < demoState.activePositions.length; i++) {
            var sym = demoState.activePositions[i].symbol; // e.g. "LINKUSDT"
            if (!sym.endsWith('USDT')) sym = sym + 'USDT';
            symbolsSet[sym] = true;
        }
        var symbols = Object.keys(symbolsSet);

        // Fetch current prices from Binance (lightweight ticker)
        var url = 'https://fapi.binance.com/fapi/v1/ticker/price?symbols=[' +
            symbols.map(function(s) { return '"' + s + '"'; }).join(',') + ']';

        fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!Array.isArray(data)) return;
                for (var i = 0; i < data.length; i++) {
                    var ticker = data[i];
                    var cleanSym = ticker.symbol.replace('USDT', '');
                    var price = parseFloat(ticker.price);
                    // Update coins array so PnL calculation uses fresh price
                    var coin = coins.find(function (c) { return c.symbol === cleanSym; });
                    if (coin) coin.price = price;
                }
                // Check TP/SL auto-execution BEFORE updating UI
                var closed = checkTPSLExecution();
                if (closed) updateHistoryUI();
                else updateHistoryUIActive();
            })
            .catch(function () {
                // Fallback: just repaint with existing prices
                updateHistoryUIActive();
            });
    }

    // === TP/SL Auto-Execution Engine ===
    function checkTPSLExecution() {
        var positionsToClose = [];
        for (var i = 0; i < demoState.activePositions.length; i++) {
            var pos = demoState.activePositions[i];
            if (!pos.takeProfit && !pos.stopLoss) continue;

            var cleanSymbol = pos.symbol.replace('USDT', '');
            var coin = coins.find(function (c) { return c.symbol === cleanSymbol; });
            if (!coin || coin.price <= 0) continue;
            var curPrice = coin.price;

            var triggered = null;

            if (pos.type === 'LONG') {
                // LONG TP: price >= TP target
                if (pos.takeProfit && curPrice >= pos.takeProfit) triggered = 'TP';
                // LONG SL: price <= SL target
                if (pos.stopLoss && curPrice <= pos.stopLoss) triggered = 'SL';
            } else {
                // SHORT TP: price <= TP target
                if (pos.takeProfit && curPrice <= pos.takeProfit) triggered = 'TP';
                // SHORT SL: price >= SL target
                if (pos.stopLoss && curPrice >= pos.stopLoss) triggered = 'SL';
            }

            if (triggered) {
                positionsToClose.push({ id: pos.id, trigger: triggered, symbol: pos.symbol, price: curPrice });
            }
        }

        // Execute closes (reverse order to avoid index shift issues)
        for (var j = positionsToClose.length - 1; j >= 0; j--) {
            var info = positionsToClose[j];
            closePositionByTPSL(info.id, info.trigger, info.price);
        }
        return positionsToClose.length > 0;
    }

    function closePositionByTPSL(id, trigger, triggerPrice) {
        var idx = -1;
        for (var i = 0; i < demoState.activePositions.length; i++) {
            if (demoState.activePositions[i].id === id) { idx = i; break; }
        }
        if (idx === -1) return;

        var pos = demoState.activePositions[idx];
        var exitPrice = triggerPrice;

        var currentVolume = (pos.volume / pos.entryPrice) * exitPrice;
        var closingFee = currentVolume * TAKER_FEE_RATE;

        var pnl = 0;
        if (pos.type === 'LONG') {
            pnl = (exitPrice - pos.entryPrice) / pos.entryPrice * pos.volume;
        } else {
            pnl = (pos.entryPrice - exitPrice) / pos.entryPrice * pos.volume;
        }

        var netPnl = pnl - closingFee;

        // Return margin and add net PnL
        demoState.balance += pos.margin + netPnl;

        pos.exitPrice = exitPrice;
        pos.closeTime = new Date().toISOString();
        pos.pnl = netPnl;
        pos.fee += closingFee;
        pos.closedBy = trigger; // 'TP' or 'SL'

        demoState.activePositions.splice(idx, 1);
        demoState.history.unshift(pos);

        if (demoState.history.length > 50) {
            demoState.history.pop();
        }

        saveDemoState();

        // Play sound notification
        if (trigger === 'TP') playSound('up');
        else playSound('down');

        // Keep balance / history UI fresh even when history panel is closed
        var balEl = document.getElementById('emu-balance');
        if (balEl) balEl.textContent = '$' + demoState.balance.toFixed(2);
        if (historyVisible) updateHistoryUI();
        else {
            var cnt = document.getElementById('active-pos-count');
            if (cnt) cnt.textContent = '(' + demoState.activePositions.length + ')';
        }
    }

    window.switchHistoryTab = function (tab) {
        document.getElementById('tab-active-pos').classList.toggle('active', tab === 'active');
        document.getElementById('tab-closed-pos').classList.toggle('active', tab === 'closed');

        document.getElementById('hm-active-container').style.display = tab === 'active' ? 'block' : 'none';
        document.getElementById('hm-closed-container').style.display = tab === 'closed' ? 'block' : 'none';

        updateHistoryUI();
    };

    function updateHistoryUI() {
        if (!historyVisible) return;
        document.getElementById('active-pos-count').textContent = '(' + demoState.activePositions.length + ')';
        updateHistoryUIActive();
        updateHistoryUIClosed();
    }

    function updateHistoryUIActive() {
        if (!historyVisible || document.getElementById('hm-active-container').style.display === 'none') return;
        var tbody = document.getElementById('hm-active-tbody');

        if (demoState.activePositions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="hm-empty">Нет открытых позиций</td></tr>';
            return;
        }

        var html = '';
        for (var i = 0; i < demoState.activePositions.length; i++) {
            var pos = demoState.activePositions[i];
            var cleanSymbol = pos.symbol.replace('USDT', '');
            var coin = coins.find(function (c) { return c.symbol === cleanSymbol; });
            var curPrice = coin && coin.price > 0 ? coin.price : pos.entryPrice;

            var pnl = 0;
            if (pos.type === 'LONG') {
                pnl = (curPrice - pos.entryPrice) / pos.entryPrice * pos.volume;
            } else {
                pnl = (pos.entryPrice - curPrice) / pos.entryPrice * pos.volume;
            }

            var estCloseVol = (pos.volume / pos.entryPrice) * curPrice;
            var estCloseFee = estCloseVol * TAKER_FEE_RATE;
            var dispPnl = pnl - estCloseFee;

            var roe = (dispPnl / pos.margin) * 100;
            var pnlClass = dispPnl >= 0 ? 'hm-pnl positive' : 'hm-pnl negative';
            var pnlStr = (dispPnl >= 0 ? '+' : '') + dispPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            var roeStr = (roe >= 0 ? '+' : '') + roe.toFixed(2) + '%';

            var typeClass = pos.type === 'LONG' ? 'long' : 'short';

            // TP/SL badges
            var tpslHtml = '';
            if (pos.takeProfit || pos.stopLoss) {
                tpslHtml = '<div style="margin-top:3px;font-size:0.68rem;line-height:1.3">';
                if (pos.takeProfit) tpslHtml += '<span style="color:var(--primary)">TP: ' + formatPriceNum(pos.takeProfit) + '</span> ';
                if (pos.stopLoss) tpslHtml += '<span style="color:var(--accent)">SL: ' + formatPriceNum(pos.stopLoss) + '</span>';
                tpslHtml += '</div>';
            }

            html += '<tr>';
            html += '<td><strong>' + pos.symbol + '</strong>' + tpslHtml + '</td>';
            html += '<td><span class="hm-pill ' + typeClass + '">' + pos.type + '</span></td>';
            html += '<td>' + pos.leverage + 'x</td>';
            html += '<td>$' + pos.margin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>';
            html += '<td>' + formatPriceNum(pos.entryPrice) + '</td>';
            html += '<td>' + formatPriceNum(curPrice) + '</td>';
            html += '<td><strong class="' + pnlClass + '">' + pnlStr + ' (' + roeStr + ')</strong></td>';
            html += '<td><button class="hm-close-btn" onclick="closePosition(\'' + pos.id + '\')">✕ Закрыть</button></td>';
            html += '</tr>';
        }
        tbody.innerHTML = html;
    }

    function updateHistoryUIClosed() {
        if (!historyVisible || document.getElementById('hm-closed-container').style.display === 'none') return;
        var tbody = document.getElementById('hm-closed-tbody');

        if (demoState.history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="hm-empty">История сделок пуста</td></tr>';
            return;
        }

        var html = '';
        for (var i = 0; i < demoState.history.length; i++) {
            var h = demoState.history[i];

            var d = new Date(h.closeTime);
            var dateStr = ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);

            var typeClass = h.type === 'LONG' ? 'long' : 'short';
            var pnlClass = h.pnl >= 0 ? 'hm-pnl positive' : 'hm-pnl negative';
            var pnlStr = (h.pnl >= 0 ? '+' : '') + h.pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            // Closed by indicator
            var closedByHtml = '';
            if (h.closedBy === 'TP') closedByHtml = '<br><span style="font-size:0.65rem;color:var(--primary);font-weight:600">✓ Take Profit</span>';
            else if (h.closedBy === 'SL') closedByHtml = '<br><span style="font-size:0.65rem;color:var(--accent);font-weight:600">✗ Stop Loss</span>';

            // TP/SL targets that were set
            var tpslSetHtml = '';
            if (h.takeProfit || h.stopLoss) {
                tpslSetHtml = '<br><span style="font-size:0.6rem;color:var(--text-dim)">';
                if (h.takeProfit) tpslSetHtml += 'TP:' + formatPriceNum(h.takeProfit) + ' ';
                if (h.stopLoss) tpslSetHtml += 'SL:' + formatPriceNum(h.stopLoss);
                tpslSetHtml += '</span>';
            }

            html += '<tr>';
            html += '<td style="color:var(--text-dim)">' + dateStr + '</td>';
            html += '<td><strong>' + h.symbol + '</strong></td>';
            html += '<td><span class="hm-pill ' + typeClass + '">' + h.type + '</span></td>';
            html += '<td>$' + h.margin.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' / ' + h.leverage + 'x</td>';
            html += '<td><span style="color:var(--text-dim)">В:</span> ' + formatPriceNum(h.entryPrice) + ' <br><span style="color:var(--text-dim)">Вых:</span> ' + formatPriceNum(h.exitPrice) + tpslSetHtml + '</td>';
            html += '<td><strong class="' + pnlClass + '">' + pnlStr + '</strong>' + closedByHtml + '<br><small style="color:var(--text-dim)">Комис: $' + h.fee.toFixed(2) + '</small></td>';
            html += '</tr>';
        }
        tbody.innerHTML = html;
    }

    function formatPriceNum(p) {
        if (!p) return '0';
        if (p >= 1000) return p.toFixed(2);
        if (p >= 10) return p.toFixed(3);
        if (p >= 1) return p.toFixed(4);
        if (p >= 0.01) return p.toFixed(5);
        return p.toFixed(7);
    }

    // === INIT ===
    function startAppCore() {

        // Clicking the logo toggles coin list instead of navigating away
        var logo = document.querySelector('.topbar-logo');
        if (logo) {
            logo.addEventListener('click', function (e) {
                e.preventDefault();
                if (typeof window.toggleSidebar === 'function') window.toggleSidebar();
            });
        }

        function applyMobileShell(forceCollapse) {
            var isMobile = window.innerWidth <= 900;
            var wasMobile = document.body.classList.contains('is-mobile-shell');
            document.body.classList.toggle('is-mobile-shell', isMobile);
            // Collapse drawer only when entering mobile mode (not on every resize)
            if (isMobile && (forceCollapse || !wasMobile)) {
                setSidebarCollapsed(true);
            }
        }
        applyMobileShell(true);

        var _resizeTimer = null;
        window.addEventListener('resize', function () {
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(function () {
                applyMobileShell();
                try {
                    if (tvWidget && typeof tvWidget.resize === 'function') tvWidget.resize();
                } catch (e) {}
                try { resizeSyncedCharts(); } catch (e2) {}
            }, 180);
        });
        window.addEventListener('orientationchange', function () {
            setTimeout(function () {
                applyMobileShell();
                try {
                    if (tvWidget && typeof tvWidget.resize === 'function') tvWidget.resize();
                } catch (e) {}
                try { resizeSyncedCharts(); } catch (e2) {}
            }, 280);
        });

        loadDemoState();
        initTfToolbar();
        initSidebarAutoHide();
        loadCryptoCoins();
        updateWatchlistUI();

        // Defer background jobs so first chart/AI win the network
        setTimeout(function () {
            if (getWatchlist().length > 0) startWatchlistUpdater();
        }, 4000);

        setTimeout(function () {
            // Live list via WebSocket; REST only as backup if WS is down
            setInterval(function () {
                if (!isTabVisible()) return;
                if (!coinTickerWsActive) loadCryptoCoins();
            }, COIN_REST_BACKUP_MS);

            document.addEventListener('visibilitychange', function () {
                if (!document.hidden) {
                    connectCoinTickerWs();
                    loadCryptoCoins();
                }
            });

            setInterval(function () {
                if (!isTabVisible()) return;
                if (selectedSymbol) {
                    runAIAnalysis(selectedSymbol, true);
                }
            }, 30000);

            setInterval(function () {
                if (!isTabVisible() || !emulatorVisible) return;
                updateEmulatorUI();
            }, 1000);

            setInterval(function () {
                if (!isTabVisible()) return;
                if (demoState.activePositions.length === 0) return;
                var hasTPSL = demoState.activePositions.some(function (p) { return p.takeProfit || p.stopLoss; });
                if (!hasTPSL || historyVisible) return;

                var symbolsSet = {};
                for (var i = 0; i < demoState.activePositions.length; i++) {
                    var pos = demoState.activePositions[i];
                    if (!pos.takeProfit && !pos.stopLoss) continue;
                    var sym = pos.symbol;
                    if (!sym.endsWith('USDT')) sym = sym + 'USDT';
                    symbolsSet[sym] = true;
                }
                var symbols = Object.keys(symbolsSet);
                if (symbols.length === 0) return;

                var url = 'https://fapi.binance.com/fapi/v1/ticker/price?symbols=[' +
                    symbols.map(function (s) { return '"' + s + '"'; }).join(',') + ']';

                fetch(url)
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (!Array.isArray(data)) return;
                        for (var i = 0; i < data.length; i++) {
                            var ticker = data[i];
                            var cleanSym = ticker.symbol.replace('USDT', '');
                            var price = parseFloat(ticker.price);
                            var coin = coins.find(function (c) { return c.symbol === cleanSym; });
                            if (coin) coin.price = price;
                        }
                        var closedBg = checkTPSLExecution();
                        if (closedBg && historyVisible) updateHistoryUI();
                    })
                    .catch(function () {});
            }, 2000);
        }, 2500);
    }

    function init() {
        accessState.ready = true;
        accessState.isPaid = true;
        startAppCore();
    }

    // === USER MENU (аккаунт, выйти, купить, мобильное приложение) ===
    var userMenuVisible = false;

    window.toggleUserMenu = function (opts) {
        opts = opts || {};
        var keepLangOpen = !!opts.keepLangOpen;
        var willOpen = !userMenuVisible;
        if (willOpen) {
            closeCtbMenus();
            if (tfPickerOpen) closeTfPicker();
            if (watchlistVisible) {
                watchlistVisible = false;
                var wl = document.getElementById('watchlist-panel');
                if (wl) wl.classList.remove('visible');
            }
            if (!keepLangOpen) {
                var langWrapClose = document.getElementById('topbar-lang-wrap');
                if (langWrapClose) langWrapClose.classList.remove('dropdown-open');
            }
        }
        userMenuVisible = willOpen;
        var overlay = document.getElementById('user-menu-overlay');
        var popup = document.getElementById('user-menu-popup');
        var langWrap = document.getElementById('topbar-lang-wrap');
        if (!keepLangOpen && langWrap && !willOpen) langWrap.classList.remove('dropdown-open');
        if (overlay) overlay.classList.toggle('visible', userMenuVisible);
        if (popup) {
            popup.classList.toggle('visible', userMenuVisible);
            if (userMenuVisible) updateUserMenuState();
        }
    };

    var LANG_STORAGE = 'ft_lang';
    var currentAppLang = null;
    function getLangFromUrl() {
        try {
            var u = new URL(window.location.href);
            var v = u.searchParams.get('lang');
            return v ? String(v) : null;
        } catch (e) { return null; }
    }
    function normalizeLang(code) {
        var c = String(code || '').toLowerCase().split('-')[0];
        if (!c) return null;
        if (c === 'ru') return 'ru';
        if (c === 'en') return 'en';
        // Old languages (zh/es/de/fr/ko/uk) migrate to English
        return 'en';
    }

    function buildIndexUrl(lang, baseHref) {
        var href = baseHref || 'index.html';
        try {
            var url = new URL(href, window.location.href);
            if (lang) url.searchParams.set('lang', lang);
            return url.pathname.split('/').pop() + url.search + url.hash;
        } catch (e) {
            var hash = '';
            var hIdx = href.indexOf('#');
            if (hIdx !== -1) { hash = href.slice(hIdx); href = href.slice(0, hIdx); }
            var hasQuery = href.indexOf('?') !== -1;
            var hasLang = href.indexOf('lang=') !== -1;
            var out = href;
            if (lang && !hasLang) out = href + (hasQuery ? '&' : '?') + 'lang=' + encodeURIComponent(lang);
            return out + hash;
        }
    }

    function updateHomeLinks(lang) {
        var links = document.querySelectorAll('a[href^="index.html"]');
        links.forEach(function (a) {
            var href = a.getAttribute('href') || '';
            a.setAttribute('href', buildIndexUrl(lang, href));
        });
    }
    function setAppLang(code, persist) {
        code = normalizeLang(code) || 'ru';
        if (persist !== false) {
            try { localStorage.setItem(LANG_STORAGE, code); } catch (e) {}
        }
        var prevLang = currentAppLang;
        currentAppLang = code;
        var opts = document.querySelectorAll('.topbar-lang-option');
        opts.forEach(function (o) { o.classList.toggle('active', o.getAttribute('data-lang') === code); });
        applyI18n(code);
        updateHomeLinks(code);
        var m = window.__i18nMap;
        if (selectedSymbol && analysisCache[selectedSymbol]) {
            displayAIResult(selectedSymbol, analysisCache[selectedSymbol]);
        } else {
            var aiLoading = document.getElementById('ai-loading');
            if (aiLoading) aiLoading.textContent = (m && m['ai.selectCoin']) || 'Выберите монету из списка';
        }
        var searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.placeholder = (m && m['topbar.searchCrypto']) || 'Поиск монеты...';
        renderCoinList();
        try { renderTfToolbar(); } catch (e) {}
        try { updateChartToolbarUI(); } catch (e) {}
        // Reload chart so TradingView locale matches selected language
        if (prevLang && prevLang !== code && selectedSymbol && !multiTFMode) {
            try { loadChart(selectedSymbol); } catch (e2) {}
        }
    }
    function getAppLang() {
        try { return normalizeLang(localStorage.getItem(LANG_STORAGE) || 'ru') || 'ru'; } catch (e) { return 'ru'; }
    }
    function initLang() {
        initFloatingPanelDismiss();
        var btn = document.getElementById('topbar-lang-btn');
        var wrap = document.getElementById('topbar-lang-wrap');
        if (btn && wrap) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var willOpen = !wrap.classList.contains('dropdown-open');
                closeAllFloatingPanels();
                if (willOpen) wrap.classList.add('dropdown-open');
            });
        }
        var opts = document.querySelectorAll('.topbar-lang-option');
        opts.forEach(function (btn) {
            btn.addEventListener('click', function () {
                setAppLang(btn.getAttribute('data-lang'));
            });
        });
        var fromUrl = normalizeLang(getLangFromUrl());
        if (fromUrl) setAppLang(fromUrl, true);
        else setAppLang(getAppLang());
    }

    // Sync language across open tabs/windows
    window.addEventListener('storage', function (e) {
        if (!e || e.key !== LANG_STORAGE) return;
        var next = e.newValue || 'ru';
        if (next === currentAppLang) return;
        setAppLang(next, false);
    });

    function applyI18n(lang) {
        var L = normalizeLang(lang) || 'ru';
        var dict = {
            ru: {
                'lang.menuTitle': 'Язык',
                'lang.aria': 'Язык',
                'lang.title': 'Язык',
                'account.label': 'Аккаунт',
                'account.menuAria': 'Меню пользователя',
                'account.lifetimeActive': 'Бесплатный полный доступ',
                'account.logout': 'Выйти',
                'account.downloadApp': 'Скачать мобильное приложение',
                'account.exitHome': 'Выйти на главную',
                'account.fullAccess': 'Полный доступ к терминалу',
                'account.buy': 'Купить',
                'topbar.emulator': '⚡ Эмулятор',
                'topbar.soundTitle': 'Звуковые уведомления',
                'topbar.soundAria': 'Звуковые уведомления',
                'topbar.searchCrypto': 'Поиск монеты...',
                'topbar.homeTitle': 'На главную',
                'demo.label': 'Демо-доступ:',
                'demo.exit': 'Выйти',
                'sidebar.volume': 'Объём за 24 часа',
                'sidebar.24h': '24h%',
                'sidebar.trades': 'Количество сделок',
                'sidebar.hotTitle': '🔥 Волатильные сейчас',
                'sidebar.hotEmpty': 'Загрузка активных монет…',
                'sidebar.loading': 'Загрузка...',
                'sidebar.error': 'Ошибка загрузки',
                'sidebar.instruments': 'инструментов',
                'chart.collapseTitle': 'Свернуть панель',
                'chart.mtfTitle': '4 таймфрейма',
                'chart.indicators': 'Индикаторы',
                'chart.styleCandles': 'Свечи',
                'chart.styleHollow': 'Пустые свечи',
                'chart.styleHeikin': 'Хейкен Аши',
                'chart.styleBars': 'Бары',
                'chart.styleLine': 'Линия',
                'chart.styleArea': 'Область',
                'tf.allTitle': 'Все таймфреймы',
                'tf.pickHint': 'Нажмите ★ чтобы добавить в панель',
                'tf.starTitle': 'В избранное',
                'tf.maxStars': 'Максимум 5 таймфреймов',
                'tf.groupMinutes': 'Минуты',
                'tf.groupHours': 'Часы',
                'tf.groupDays': 'Дни',
                'tf.1m': '1м', 'tf.3m': '3м', 'tf.5m': '5м', 'tf.15m': '15м', 'tf.30m': '30м', 'tf.45m': '45м',
                'tf.1h': '1ч', 'tf.2h': '2ч', 'tf.3h': '3ч', 'tf.4h': '4ч',
                'tf.1d': '1д', 'tf.1w': '1нед', 'tf.1mo': '1мес', 'tf.3mo': '3мес', 'tf.6mo': '6мес', 'tf.12mo': '12мес',
                'chart.selectCoin': 'Выберите монету для анализа',
                'emu.title': '⚡ Демо Торговля',
                'emu.leverage': 'Плечо (Leverage)',
                'emu.margin': 'Маржа (USD)',
                'emu.volumeLabel': 'Объём позиции:',
                'emu.feeLabel': 'Комиссия (0.04%):',
                'emu.tp': 'Тейк-профит',
                'emu.sl': 'Стоп-лосс',
                'emu.activationPrice': 'Цена активации',
                'emu.tpslHint': 'TP/SL сработают автоматически при достижении цены.',
                'emu.long': 'UP (Лонг)',
                'emu.short': 'DOWN (Шорт)',
                'emu.history': 'Мои позиции и история',
                'ai.selectCoin': 'Выберите монету из списка',
                'ai.confidenceLabel': 'Уверенность',
                'ai.watch': '★ Отслеживать',
                'ai.volatilityTitle': '⚡ Ожидается сильное движение',
                'ai.earlyWarningTitle': 'Внимание',
                'ai.horizonsTitle': 'Прогноз по времени',
                'smc.title': 'Smart Money — основной прогноз',
                'smc.noData': 'Недостаточно данных для SMC-анализа',
                'smc.liquidity': 'Ликвидность',
                'smc.fvg': 'FVG',
                'smc.orderBlock': 'Order Block',
                'smc.sweptBSL': 'BSL снята',
                'smc.sweptSSL': 'SSL снята',
                'smc.fvgBull': 'Бычий',
                'smc.fvgBear': 'Медвежий',
                'smc.noFVG': 'Нет активных FVG',
                'smc.obBull': 'Бычий OB',
                'smc.obBear': 'Медвежий OB',
                'smc.noOB': 'OB не найден',
                'smc.breaker': 'Breaker',
                'smc.htfLabel': '1ч',
                'smc.htfUp': '1ч',
                'smc.htfDown': '1ч',
                'smc.htfSide': '1ч',
                'smc.summary.up': 'После снятия ликвидности или от OB/FVG — движение к BSL. Покупки из Discount.',
                'smc.summary.down': 'После снятия ликвидности или от OB/FVG — движение к SSL. Продажи из Premium.',
                'smc.summary.sideways': 'Консолидация между BSL и SSL. Ждите снятия ликвидности + BOS/CHoCH.',
                'smc.bosBull': 'BOS вверх — структура подтвердила продолжение роста',
                'smc.bosBear': 'BOS вниз — структура подтвердила продолжение снижения',
                'smc.chochBull': 'CHoCH вверх — смена характера, разворот на рост',
                'smc.chochBear': 'CHoCH вниз — смена характера, разворот на спад',
                'smc.discountBull': 'Цена в Discount-зоне бычьей структуры — зона интереса для покупок',
                'smc.premiumBear': 'Цена в Premium-зоне медвежьей структуры — зона интереса для продаж',
                'smc.liqSweepLow': 'Снятие SSL — сбор ликвидности снизу, вероятен отскок',
                'smc.liqSweepHigh': 'Снятие BSL — сбор ликвидности сверху, вероятен откат',
                'smc.liqSweepLowReject': 'Снятие SSL + отторжение — классический stop-hunt, ожидается рост',
                'smc.liqSweepHighReject': 'Снятие BSL + отторжение — классический stop-hunt, ожидается спад',
                'smc.eqHighs': 'Equal Highs (BSL) — ликвидность сверху ещё не снята',
                'smc.eqLows': 'Equal Lows (SSL) — ликвидность снизу ещё не снята',
                'smc.nearSSL': 'Цена у SSL — возможен вынос стопов перед разворотом вверх',
                'smc.nearBSL': 'Цена у BSL — возможен вынос стопов перед разворотом вниз',
                'smc.bullFVG': 'Цена в бычьем FVG — зона справедливой стоимости для покупок',
                'smc.bullFVGCE': 'Цена у CE бычьего FVG (50%) — лучшая точка входа по Smart Money',
                'smc.bullFVGAbove': 'Бычий FVG ниже — магнит для отката и заполнения',
                'smc.bearFVG': 'Цена в медвежьем FVG — зона справедливой стоимости для продаж',
                'smc.bearFVGCE': 'Цена у CE медвежьего FVG (50%) — лучшая точка входа в продажи',
                'smc.bearFVGBelow': 'Медвежий FVG выше — магнит для отката вверх',
                'smc.bullOB': 'Цена в бычьем Order Block — институциональная зона спроса',
                'smc.bearOB': 'Цена в медвежьем Order Block — институциональная зона предложения',
                'smc.bullOBNear': 'Близко к бычьему OB — вероятен возврат в зону спроса',
                'smc.bearOBNear': 'Близко к медвежьему OB — вероятен возврат в зону предложения',
                'smc.htfBullOB': 'HTF (1ч) бычий OB подтверждает спрос',
                'smc.htfBearOB': 'HTF (1ч) медвежий OB подтверждает давление',
                'smc.htfAlignBull': '1ч и 4ч согласованы вверх — торгуем в сторону старшего тренда',
                'smc.htfAlignBear': '1ч и 4ч согласованы вниз — торгуем в сторону старшего тренда',
                'smc.bullBreaker': 'Bullish Breaker Block — сломанный OB стал поддержкой',
                'smc.bearBreaker': 'Bearish Breaker Block — сломанный OB стал сопротивлением',
                'smc.bullBreakerRetest': 'Bullish Breaker с ретестом — сломанный OB держит как поддержка',
                'smc.bearBreakerRetest': 'Bearish Breaker с ретестом — сломанный OB держит как сопротивление',
                'smc.flowBull': 'Order Flow: доминируют покупатели (тело свечей + объём)',
                'smc.flowBear': 'Order Flow: доминируют продавцы (тело свечей + объём)',
                'ai.longtermTitle': 'Долгосрочный прогноз',
                'trend.up': 'Рост',
                'trend.down': 'Спад',
                'trend.flat': 'Боковик',
                'trend.byChart': 'Тренд по графику',
                'ai.shorttermTitle': 'Краткосрочный прогноз',
                'ai.indicatorsTitle': 'Индикаторы',
                'ai.reasoningTitle': 'Анализ',
                'ai.analyzing': 'Анализ',
                'ai.insufficientData': 'Недостаточно данных для',
                'ai.analysisError': 'Ошибка анализа',
                'ai.dirUp': 'Рост',
                'ai.dirDown': 'Спад',
                'ai.dirSide': 'Боковик',
                'ai.watched': '★ Отслеживается',
                'ai.watchOff': '☆ Отслеживать',
                'ai.earlyUp': 'Смена на РОСТ',
                'ai.earlyDown': 'Смена на СПАД',
                'ind.EMAf': 'EMA\u0431',
                'ind.PvE': 'P/EMA',
                'ind.Candles': '\u0421\u0432\u0435\u0447\u0438',
                'watchlist.empty': 'Нет отслеживаемых монет. Нажмите ★ чтобы добавить.',
                'forecast.question': 'Куда пойдёт цена в ближайшее время?',
                'forecast.shortTitle': 'Краткосрочный прогноз',
                'forecast.expect15m': 'Ожидание 15м',
                'forecast.expect1h': '1ч',
                'forecast.adx': 'ADX',
                'forecast.adxStrong': 'сильный тренд',
                'forecast.adxTrend': 'есть тренд',
                'forecast.adxWeak': 'слабый тренд',
                'forecast.adxFlat': 'флет',
                'forecast.adxHintStrong': 'Движение уверенное, трендовые сигналы надёжнее.',
                'forecast.adxHintTrend': 'Тренд подтверждён (>25), можно опираться на направление.',
                'forecast.adxHintWeak': 'Сила тренда низкая, ложные пробои вероятнее.',
                'forecast.adxHintFlat': 'Рынок боковой (<20), трендовые сигналы слабее.',
                'forecast.reversalUp': 'Ожидается разворот ВВЕРХ',
                'forecast.reversalDown': 'Ожидается разворот ВНИЗ',
                'forecast.because': 'Причины',
                'forecast.watchVolume': 'Внимание на объёмы при пробое ближайших уровней.',
                'forecast.trendUp': 'Продолжение роста',
                'forecast.trendDown': 'Продолжение снижения',
                'forecast.sideways': 'Консолидация / боковик',
                'forecast.breakout': 'Ожидается сильное движение после пробоя.',
                'forecast.rsi': 'RSI',
                'forecast.rsiStrongUp': 'сильный восходящий импульс',
                'forecast.rsiModerateUp': 'умеренный восходящий импульс',
                'forecast.rsiOversold': 'перепроданность — возможен отскок',
                'forecast.rsiDown': 'нисходящий тренд',
                'forecast.bullScenario': 'Сценарий роста',
                'forecast.bearScenario': 'Сценарий снижения',
                'forecast.realistic': 'Реалистичный',
                'forecast.bullSupportHolds': 'Поддержка удержится на уровне',
                'forecast.bullBounceTo': 'отскок к',
                'forecast.bullIfRsi': 'Если RSI закрепится выше 55–60 и объём вернётся, возможен ретест',
                'forecast.bullBounceFrom': 'Краткосрочный отскок от',
                'forecast.bullConfirm': 'Для подтверждения разворота необходим пробой',
                'forecast.withVolume': 'с объёмом',
                'forecast.bearIfBreak': 'Если поддержка',
                'forecast.bearBreakVerb': 'сломается',
                'forecast.bearDumpTo': 'дамп к',
                'forecast.bearDeep': 'Глубокий откат до',
                'forecast.bearOnMarket': 'возможен при общем сбросе',
                'forecast.bearPullbackFrom': 'Откат от сопротивления',
                'forecast.bearPullbackTo': 'к',
                'forecast.bearIfLose': 'При потере',
                'forecast.bearRisk': 'риск падения к',
                'forecast.realSideways': 'консолидация в узком диапазоне. Ожидание пробоя с направлением по тренду старших ТФ.',
                'forecast.realUp1': 'умеренный рост с тестом',
                'forecast.realUp2': 'при сохранении покупательского интереса.',
                'forecast.realDown1': 'продолжение давления с поддержкой на',
                'forecast.realDown2': 'Отскок вероятен при RSI < 30.',
                'forecast.recommendations': 'Рекомендации',
                'forecast.long': 'Лонг',
                'forecast.short': 'Шорт',
                'forecast.entry': 'Вход',
                'forecast.stop': 'Стоп',
                'forecast.take': 'Тейк',
                'forecast.below': 'ниже',
                'forecast.above': 'выше',
                'forecast.advice': 'Общий совет',
                'forecast.adviceQuick': 'Фиксируй профит быстро, не держи без стопов.',
                'forecast.liqHigh': 'высоколиквидный актив.',
                'forecast.liqMid': 'средний по ликвидности актив.',
                'forecast.liqSpec': 'спекулятивный актив',
                'forecast.volatility': 'волатильность',
                'forecast.daily': 'ежедневно',
                'forecast.watchRsi': 'Следи за RSI',
                'forecast.rsiUpHint': '>55–60 (подтверждение роста)',
                'forecast.rsiDownHint': '<40 (глубина перепроданности)',
                'forecast.rsiSideHint': 'выход из 40–60 (направление пробоя)',
                'forecast.andVolume': 'и объём',
                'forecast.volConfirmed': '(текущий тренд объёма подтверждён)',
                'forecast.volWatch': '(следить за изменением объёма)',
                'forecast.scoring': 'Скоринг',
                'forecast.signals': 'Сигналы',
                'forecast.ofIndicators': 'из',
                'forecast.indicatorsWord': 'индикаторов',
                'forecast.engine': 'AI Engine v2.2',
                'forecast.qualityLongSpec': 'спекулятивный лонг на опережение (сигнал разворота)',
                'forecast.qualityShortSpec': 'спекулятивный шорт на опережение (сигнал разворота)',
                'forecast.qualityTrendAdx': 'по тренду (подтверждён ADX)',
                'forecast.qualityTrendWeak': 'по тренду, но слабый ADX — осторожно',
                'forecast.qualityFromSupport': 'осторожный вход от поддержки',
                'forecast.qualityFromResistance': 'от сопротивления с жёстким стопом',
                'forecast.qualityCounterRsi': 'контр-трендовый, но RSI дивергенция поддерживает',
                'forecast.qualityRisky': 'рискованно (против тренда)',
                'watchlist.title': '★ Watchlist',
                'hm.title': '💼 Демо Счёт — Позиции и История',
                'hm.tabActive': 'Открытые позиции',
                'hm.tabClosed': 'История сделок',
                'hm.balance': 'Баланс',
                'hm.resetTitle': 'Сбросить счет до $10k',
                'hm.resetConfirm': 'Вы уверены, что хотите сбросить демо-счёт до $10,000? Вся история и активные позиции будут удалены.',
                'hm.coin': 'Монета',
                'hm.type': 'Тип',
                'hm.leverage': 'Плечо',
                'hm.margin': 'Маржа',
                'hm.entryPrice': 'Цена входа',
                'hm.currentPrice': 'Тек. цена',
                'hm.pnl': 'PnL (ROE%)',
                'hm.action': 'Действие',
                'hm.closeTime': 'Время закрытия',
                'hm.marginLeverage': 'Маржа / Плечо',
                'hm.entryExit': 'Вход - Выход',
                'auth.closeAria': 'Закрыть'
            },
            en: {
                'lang.menuTitle': 'Language',
                'lang.aria': 'Language',
                'lang.title': 'Language',
                'account.label': 'Account',
                'account.menuAria': 'User menu',
                'account.lifetimeActive': 'Free full access',
                'account.logout': 'Log out',
                'account.downloadApp': 'Download mobile app',
                'account.exitHome': 'Back to home',
                'account.fullAccess': 'Full access to terminal',
                'account.buy': 'Buy',
                'topbar.emulator': '⚡ Emulator',
                'topbar.soundTitle': 'Sound alerts',
                'topbar.soundAria': 'Sound alerts',
                'topbar.searchCrypto': 'Search coin...',
                'topbar.homeTitle': 'Home',
                'demo.label': 'Demo access:',
                'demo.exit': 'Exit',
                'sidebar.volume': 'Volume for 24 hours',
                'sidebar.24h': '24h%',
                'sidebar.trades': 'Number of trades',
                'sidebar.hotTitle': '🔥 Hot & volatile now',
                'sidebar.hotEmpty': 'Loading active coins…',
                'sidebar.loading': 'Loading...',
                'sidebar.error': 'Load error',
                'sidebar.instruments': 'instruments',
                'chart.collapseTitle': 'Collapse panel',
                'chart.mtfTitle': '4 timeframes',
                'tf.allTitle': 'All timeframes',
                'tf.pickHint': 'Tap ★ to add to toolbar',
                'tf.starTitle': 'Add to favorites',
                'tf.maxStars': 'Maximum 5 timeframes',
                'tf.groupMinutes': 'Minutes',
                'tf.groupHours': 'Hours',
                'tf.groupDays': 'Days',
                'tf.1m': '1m', 'tf.3m': '3m', 'tf.5m': '5m', 'tf.15m': '15m', 'tf.30m': '30m', 'tf.45m': '45m',
                'tf.1h': '1h', 'tf.2h': '2h', 'tf.3h': '3h', 'tf.4h': '4h',
                'tf.1d': '1D', 'tf.1w': '1W', 'tf.1mo': '1M', 'tf.3mo': '3M', 'tf.6mo': '6M', 'tf.12mo': '12M',
                'chart.selectCoin': 'Select a coin to analyze',
                'chart.indicators': 'Indicators',
                'chart.styleCandles': 'Candles',
                'chart.styleHollow': 'Hollow candles',
                'chart.styleHeikin': 'Heikin Ashi',
                'chart.styleBars': 'Bars',
                'chart.styleLine': 'Line',
                'chart.styleArea': 'Area',
                'emu.title': '⚡ Demo Trading',
                'emu.leverage': 'Leverage',
                'emu.margin': 'Margin (USD)',
                'emu.volumeLabel': 'Position size:',
                'emu.feeLabel': 'Fee (0.04%):',
                'emu.tp': 'Take profit',
                'emu.sl': 'Stop loss',
                'emu.activationPrice': 'Activation price',
                'emu.tpslHint': 'TP/SL will trigger automatically at price.',
                'emu.long': 'UP (Long)',
                'emu.short': 'DOWN (Short)',
                'emu.history': 'My positions and history',
                'ai.selectCoin': 'Select a coin from the list',
                'ai.confidenceLabel': 'Confidence',
                'ai.watch': '★ Watch',
                'ai.volatilityTitle': '⚡ Strong move expected',
                'ai.earlyWarningTitle': 'Attention',
                'ai.horizonsTitle': 'Forecast by time',
                'smc.title': 'Smart Money — main forecast',
                'smc.noData': 'Insufficient data for SMC analysis',
                'smc.liquidity': 'Liquidity',
                'smc.fvg': 'FVG',
                'smc.orderBlock': 'Order Block',
                'smc.sweptBSL': 'BSL swept',
                'smc.sweptSSL': 'SSL swept',
                'smc.fvgBull': 'Bullish',
                'smc.fvgBear': 'Bearish',
                'smc.noFVG': 'No active FVG',
                'smc.obBull': 'Bullish OB',
                'smc.obBear': 'Bearish OB',
                'smc.noOB': 'No OB found',
                'smc.breaker': 'Breaker',
                'smc.htfLabel': '1h',
                'smc.htfUp': '1h',
                'smc.htfDown': '1h',
                'smc.htfSide': '1h',
                'smc.summary.up': 'After liquidity sweep or from OB/FVG — move toward BSL. Buy from Discount.',
                'smc.summary.down': 'After liquidity sweep or from OB/FVG — move toward SSL. Sell from Premium.',
                'smc.summary.sideways': 'Consolidation between BSL and SSL. Wait for sweep + BOS/CHoCH.',
                'smc.bosBull': 'Bullish BOS — structure confirmed continuation up',
                'smc.bosBear': 'Bearish BOS — structure confirmed continuation down',
                'smc.chochBull': 'Bullish CHoCH — character change, reversal up',
                'smc.chochBear': 'Bearish CHoCH — character change, reversal down',
                'smc.discountBull': 'Price in Discount of bullish structure — buy-interest zone',
                'smc.premiumBear': 'Price in Premium of bearish structure — sell-interest zone',
                'smc.liqSweepLow': 'SSL swept — liquidity grab below, bounce likely',
                'smc.liqSweepHigh': 'BSL swept — liquidity grab above, pullback likely',
                'smc.liqSweepLowReject': 'SSL sweep + rejection — classic stop-hunt, upside expected',
                'smc.liqSweepHighReject': 'BSL sweep + rejection — classic stop-hunt, downside expected',
                'smc.eqHighs': 'Equal Highs (BSL) — upside liquidity not swept yet',
                'smc.eqLows': 'Equal Lows (SSL) — downside liquidity not swept yet',
                'smc.nearSSL': 'Price at SSL — possible stop run before bounce up',
                'smc.nearBSL': 'Price at BSL — possible stop run before reversal down',
                'smc.bullFVG': 'Price in bullish FVG — fair value zone for buys',
                'smc.bullFVGCE': 'Price at bullish FVG CE (50%) — best Smart Money entry',
                'smc.bullFVGAbove': 'Bullish FVG below — magnet for pullback fill',
                'smc.bearFVG': 'Price in bearish FVG — fair value zone for sells',
                'smc.bearFVGCE': 'Price at bearish FVG CE (50%) — best sell entry',
                'smc.bearFVGBelow': 'Bearish FVG above — magnet for upward pullback',
                'smc.bullOB': 'Price in bullish Order Block — institutional demand zone',
                'smc.bearOB': 'Price in bearish Order Block — institutional supply zone',
                'smc.bullOBNear': 'Near bullish OB — likely return into demand',
                'smc.bearOBNear': 'Near bearish OB — likely return into supply',
                'smc.htfBullOB': 'HTF (1h) bullish OB confirms demand',
                'smc.htfBearOB': 'HTF (1h) bearish OB confirms pressure',
                'smc.htfAlignBull': '1h and 4h aligned up — trade with higher-timeframe trend',
                'smc.htfAlignBear': '1h and 4h aligned down — trade with higher-timeframe trend',
                'smc.bullBreaker': 'Bullish Breaker Block — broken OB became support',
                'smc.bearBreaker': 'Bearish Breaker Block — broken OB became resistance',
                'smc.bullBreakerRetest': 'Bullish Breaker retest — broken OB holding as support',
                'smc.bearBreakerRetest': 'Bearish Breaker retest — broken OB holding as resistance',
                'smc.flowBull': 'Order Flow: buyers dominate (candle bodies + volume)',
                'smc.flowBear': 'Order Flow: sellers dominate (candle bodies + volume)',
                'ai.longtermTitle': 'Long-term forecast',
                'trend.up': 'Up',
                'trend.down': 'Down',
                'trend.flat': 'Sideways',
                'trend.byChart': 'Chart trend',
                'ai.shorttermTitle': 'Short-term forecast',
                'ai.indicatorsTitle': 'Indicators',
                'ai.reasoningTitle': 'Analysis',
                'ai.analyzing': 'Analyzing',
                'ai.insufficientData': 'Not enough data for',
                'ai.analysisError': 'Analysis error for',
                'ai.dirUp': 'Up',
                'ai.dirDown': 'Down',
                'ai.dirSide': 'Sideways',
                'ai.watched': '★ Watched',
                'ai.watchOff': '☆ Watch',
                'ai.earlyUp': 'Switching to UP',
                'ai.earlyDown': 'Switching to DOWN',
                'ind.EMAf': 'EMA',
                'ind.PvE': 'P/EMA',
                'ind.Candles': 'Candles',
                'watchlist.empty': 'No watched coins yet. Click ★ to add.',
                'forecast.question': 'Where will price go next?',
                'forecast.shortTitle': 'Short-term forecast',
                'forecast.expect15m': '15m expectation',
                'forecast.expect1h': '1h',
                'forecast.adx': 'ADX',
                'forecast.adxStrong': 'strong trend',
                'forecast.adxTrend': 'trend present',
                'forecast.adxWeak': 'weak trend',
                'forecast.adxFlat': 'flat',
                'forecast.adxHintStrong': 'Move is firm; trend signals are more reliable.',
                'forecast.adxHintTrend': 'Trend confirmed (>25); direction can be trusted more.',
                'forecast.adxHintWeak': 'Trend strength is low; false breakouts are more likely.',
                'forecast.adxHintFlat': 'Sideways market (<20); trend signals are weaker.',
                'forecast.reversalUp': 'Reversal UP expected',
                'forecast.reversalDown': 'Reversal DOWN expected',
                'forecast.because': 'Reasons',
                'forecast.watchVolume': 'Watch volume near key levels.',
                'forecast.trendUp': 'Uptrend continuation',
                'forecast.trendDown': 'Downtrend continuation',
                'forecast.sideways': 'Consolidation / sideways',
                'forecast.breakout': 'Expect a strong move after breakout.',
                'forecast.rsi': 'RSI',
                'forecast.rsiStrongUp': 'strong bullish momentum',
                'forecast.rsiModerateUp': 'moderate bullish momentum',
                'forecast.rsiOversold': 'oversold — bounce possible',
                'forecast.rsiDown': 'bearish trend',
                'forecast.bullScenario': 'Bull scenario',
                'forecast.bearScenario': 'Bear scenario',
                'forecast.realistic': 'Realistic',
                'forecast.bullSupportHolds': 'Support holds at',
                'forecast.bullBounceTo': 'bounce to',
                'forecast.bullIfRsi': 'If RSI holds above 55–60 and volume returns, a retest is possible at',
                'forecast.bullBounceFrom': 'Short-term bounce from',
                'forecast.bullConfirm': 'To confirm reversal, a breakout above',
                'forecast.withVolume': 'with volume',
                'forecast.bearIfBreak': 'If support',
                'forecast.bearBreakVerb': 'breaks',
                'forecast.bearDumpTo': 'drop to',
                'forecast.bearDeep': 'A deeper move to',
                'forecast.bearOnMarket': 'is possible on broader market sell-off.',
                'forecast.bearPullbackFrom': 'Pullback from resistance',
                'forecast.bearPullbackTo': 'to',
                'forecast.bearIfLose': 'If price loses',
                'forecast.bearRisk': 'risk of falling to',
                'forecast.realSideways': 'tight range consolidation. Watch for a breakout aligned with higher timeframes.',
                'forecast.realUp1': 'moderate rise with a test of',
                'forecast.realUp2': 'if buying interest persists.',
                'forecast.realDown1': 'continued pressure with support at',
                'forecast.realDown2': 'A bounce is likely if RSI < 30.',
                'forecast.recommendations': 'Recommendations',
                'forecast.long': 'Long',
                'forecast.short': 'Short',
                'forecast.entry': 'Entry',
                'forecast.stop': 'Stop',
                'forecast.take': 'Take',
                'forecast.below': 'below',
                'forecast.above': 'above',
                'forecast.advice': 'General advice',
                'forecast.adviceQuick': 'Take profit quickly, don’t hold without stops.',
                'forecast.liqHigh': 'high-liquidity asset.',
                'forecast.liqMid': 'medium-liquidity asset.',
                'forecast.liqSpec': 'speculative asset',
                'forecast.volatility': 'volatility',
                'forecast.daily': 'daily',
                'forecast.watchRsi': 'Watch RSI',
                'forecast.rsiUpHint': '>55–60 (uptrend confirmation)',
                'forecast.rsiDownHint': '<40 (depth of oversold)',
                'forecast.rsiSideHint': 'break out of 40–60 (breakout direction)',
                'forecast.andVolume': 'and volume',
                'forecast.volConfirmed': '(current volume trend is confirmed)',
                'forecast.volWatch': '(watch volume changes)',
                'forecast.scoring': 'Score',
                'forecast.signals': 'Signals',
                'forecast.ofIndicators': 'of',
                'forecast.indicatorsWord': 'indicators',
                'forecast.engine': 'AI Engine v2.2',
                'forecast.qualityLongSpec': 'Speculative long ahead of reversal',
                'forecast.qualityShortSpec': 'Speculative short ahead of reversal',
                'forecast.qualityTrendAdx': 'Trend (ADX confirmed)',
                'forecast.qualityTrendWeak': 'Trend but weak ADX — cautious',
                'forecast.qualityFromSupport': 'Cautious entry from support',
                'forecast.qualityFromResistance': 'From resistance with tight stop',
                'forecast.qualityCounterRsi': 'Counter-trend but RSI divergence supports',
                'forecast.qualityRisky': 'Risky (against trend)',
                'watchlist.title': '★ Watchlist',
                'hm.title': '💼 Demo Account — Positions and History',
                'hm.tabActive': 'Open positions',
                'hm.tabClosed': 'Trade history',
                'hm.balance': 'Balance',
                'hm.resetTitle': 'Reset account to $10k',
                'hm.resetConfirm': 'Are you sure you want to reset the demo account to $10,000? All history and open positions will be deleted.',
                'hm.coin': 'Coin',
                'hm.type': 'Type',
                'hm.leverage': 'Leverage',
                'hm.margin': 'Margin',
                'hm.entryPrice': 'Entry price',
                'hm.currentPrice': 'Current price',
                'hm.pnl': 'PnL (ROE%)',
                'hm.action': 'Action',
                'hm.closeTime': 'Close time',
                'hm.marginLeverage': 'Margin / Leverage',
                'hm.entryExit': 'Entry - Exit',
                'auth.closeAria': 'Close'
            }
        };

        var map = dict[L] || dict.ru;
        window.__i18nMap = map;

        var nodes = document.querySelectorAll('[data-i18n]');
        nodes.forEach(function (el) {
            var key = el.getAttribute('data-i18n');
            if (map[key]) el.textContent = map[key];
        });
        var ariaNodes = document.querySelectorAll('[data-i18n-aria]');
        ariaNodes.forEach(function (el) {
            var key = el.getAttribute('data-i18n-aria');
            if (map[key]) el.setAttribute('aria-label', map[key]);
        });
        var titleNodes = document.querySelectorAll('[data-i18n-title]');
        titleNodes.forEach(function (el) {
            var key = el.getAttribute('data-i18n-title');
            if (map[key]) el.setAttribute('title', map[key]);
        });
        var phNodes = document.querySelectorAll('[data-i18n-placeholder]');
        phNodes.forEach(function (el) {
            var key = el.getAttribute('data-i18n-placeholder');
            if (map[key]) el.setAttribute('placeholder', map[key]);
        });
        try { document.documentElement.lang = (L === 'en') ? 'en' : 'ru'; } catch (e) {}
    }

    function updateUserMenuState() {
        var elPaid = document.getElementById('user-menu-paid');
        if (elPaid) elPaid.style.display = 'block';
        var sub = document.getElementById('user-menu-subtitle');
        if (sub) {
            sub.textContent = '';
            sub.style.display = 'none';
        }
    }

    function initUserMenu() {
        var downloadUser = document.getElementById('user-menu-download');
        if (downloadUser) downloadUser.addEventListener('click', function (e) {
            e.preventDefault();
            toggleUserMenu();
        });
    }

    function initPulsingRocket() {
        var rocket = document.querySelector('.ai-header .pulsing-rocket');
        if (!rocket) return;

        // 🚀 emoji already points ~45° (nose up-right). Align rotation to velocity.
        var EMOJI_NOSE_DEG = 45;
        var t0 = performance.now();
        var phase = Math.random() * Math.PI * 2;
        var phaseG = Math.random() * Math.PI * 2;
        var speed = 0.55 + Math.random() * 0.15;
        var ampAlong = 2.6;
        var ampTurn = 0.9;
        var smoothRot = 0;
        var prevX = 0;
        var prevY = 0;
        var hasPrev = false;

        function tick(now) {
            var t = (now - t0) / 1000;
            // Flight progress along a soft curved path (always forward, gentle bank)
            var u = t * speed + phase;
            var along = Math.sin(u) * ampAlong;
            var turn = Math.sin(u * 0.5) * ampTurn;
            // Path basis: forward = NE (nose direction), side = NW/SE for banking
            var fx = 0.7071;
            var fy = -0.7071;
            var sx = -0.7071;
            var sy = -0.7071;
            var x = along * fx + turn * sx;
            var y = along * fy + turn * sy;

            // Nose follows velocity (tangent of the path)
            var vx;
            var vy;
            if (hasPrev) {
                vx = x - prevX;
                vy = y - prevY;
            } else {
                // Initial tangent of parametric path
                vx = Math.cos(u) * ampAlong * fx + 0.5 * Math.cos(u * 0.5) * ampTurn * sx;
                vy = Math.cos(u) * ampAlong * fy + 0.5 * Math.cos(u * 0.5) * ampTurn * sy;
            }
            prevX = x;
            prevY = y;
            hasPrev = true;

            var speed2 = vx * vx + vy * vy;
            var targetRot = 0;
            if (speed2 > 1e-8) {
                // Screen y grows down; atan2(vx, -vy) = angle from up, clockwise-friendly
                var deg = Math.atan2(vx, -vy) * 180 / Math.PI;
                targetRot = deg - EMOJI_NOSE_DEG;
            }
            // Soft-limit and smooth rotation so it never snaps
            if (targetRot > 18) targetRot = 18;
            if (targetRot < -18) targetRot = -18;
            smoothRot += (targetRot - smoothRot) * 0.06;

            var thrust = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.9 + phaseG));
            var opacity = 0.84 + 0.16 * thrust;
            // Exhaust glow slightly behind the nose (down-left of NE flight)
            var glowX = (-1.2 * thrust).toFixed(1);
            var glowY = (1.2 * thrust).toFixed(1);

            rocket.style.transform = 'translate(' + x.toFixed(2) + 'px, ' + y.toFixed(2) + 'px) rotate(' + smoothRot.toFixed(2) + 'deg)';
            rocket.style.opacity = opacity.toFixed(3);
            rocket.style.filter = 'drop-shadow(' + glowX + 'px ' + glowY + 'px ' + (2.5 + thrust * 3.5).toFixed(1) + 'px rgba(0, 230, 118, ' + (0.2 + thrust * 0.4).toFixed(2) + '))';

            requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            init();
            initUserMenu();
            initLang();
            initPulsingRocket();
        });
    } else {
        init();
        initUserMenu();
        initLang();
        initPulsingRocket();
    }

})();
