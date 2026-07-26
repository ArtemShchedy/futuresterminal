// FuturesTerminal shield v7 — light host lock (fail-open, no blank wipe)
(function () {
    'use strict';

    var K = 'FT#2026!own';

    function dec(b64) {
        if (!b64) return '';
        try {
            var bin = atob(b64);
            var out = '';
            for (var i = 0; i < bin.length; i++) {
                out += String.fromCharCode(bin.charCodeAt(i) ^ K.charCodeAt(i % K.length));
            }
            return out;
        } catch (e) { return ''; }
    }

    var enc = window.__FT_OWN_ENC__ || {};
    var flags = dec(enc.f || '').split('|');
    var cfg = {
        product: dec(enc.p) || 'FuturesTerminal',
        ownerToken: dec(enc.t) || '',
        copyright: dec(enc.c) || '© FuturesTerminal',
        allowedHosts: dec(enc.h || '').split(',').filter(Boolean),
        enforceHostLock: flags[0] !== '0' && !!enc.p
    };

    window.__FT_OWNER__ = cfg;

    var PRODUCT = cfg.product;
    var COPYRIGHT = cfg.copyright;

    function hostAllowed() {
        var h = '';
        var proto = '';
        try { h = String(window.location.hostname || '').toLowerCase(); } catch (e) {}
        try { proto = String(window.location.protocol || ''); } catch (e2) {}

        if (proto === 'file:' || proto === 'capacitor:' || proto === 'ionic:') return true;
        if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
        if (h.indexOf('192.168.') === 0 || h.indexOf('10.') === 0) return true;
        if (h === 'artemshchedy.github.io' || h.slice(-11) === '.github.io') return true;

        var list = cfg.allowedHosts || [];
        for (var i = 0; i < list.length; i++) {
            var a = String(list[i] || '').toLowerCase();
            if (!a) continue;
            if (h === a || h.slice(-(a.length + 1)) === '.' + a) return true;
        }
        return false;
    }

    if (cfg.enforceHostLock && !hostAllowed()) {
        try {
            document.documentElement.innerHTML =
                '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>' + PRODUCT + '</title>' +
                '<style>body{margin:0;background:#0B0B0F;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}' +
                'h1{color:#00E676;font-size:1.2rem}p{color:#8E9BAE}</style></head>' +
                '<body><div><h1>' + PRODUCT + '</h1><p>This copy is not licensed for this domain.</p></div></body>';
        } catch (e) {}
        return;
    }

    try {
        window.__FT_SHIELD__ = { product: PRODUCT, owner: cfg.ownerToken, copyright: COPYRIGHT, v: 7 };
    } catch (e) {}

    document.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        return false;
    }, true);

    var ALLOW = [
        'owner-config.js', 'shield.js', 'app.js', 'ai-engine.js',
        'tv.js', 'tradingview', 'binance.com'
    ];
    function scriptOk(src) {
        if (!src) return true;
        var s = String(src).toLowerCase();
        for (var i = 0; i < ALLOW.length; i++) if (s.indexOf(ALLOW[i]) !== -1) return true;
        try {
            if (s.indexOf('http') !== 0) return true;
            var loc = String(window.location.origin || '').toLowerCase();
            if (loc && s.indexOf(loc) === 0) return true;
        } catch (e) {}
        return false;
    }

    try {
        new MutationObserver(function (muts) {
            for (var m = 0; m < muts.length; m++) {
                var nodes = muts[m].addedNodes;
                for (var n = 0; n < nodes.length; n++) {
                    var el = nodes[n];
                    if (el && el.tagName === 'SCRIPT' && !scriptOk(el.src || '')) {
                        try { el.remove(); } catch (e) {
                            try { el.parentNode && el.parentNode.removeChild(el); } catch (e2) {}
                        }
                    }
                }
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
})();
