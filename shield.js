// FuturesTerminal shield v6 — decrypt owner config + host/IP/anti-tamper
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
    if (!enc.p || !enc.t) {
        try {
            document.documentElement.innerHTML = '<body style="background:#0B0B0F;color:#fff;font-family:sans-serif;padding:40px;text-align:center"><h1>FuturesTerminal</h1><p>Owner config missing or corrupted.</p></body>';
        } catch (e) {}
        return;
    }

    var flags = dec(enc.f).split('|');
    var cfg = {
        product: dec(enc.p) || 'FuturesTerminal',
        ownerToken: dec(enc.t),
        copyright: dec(enc.c),
        allowedHosts: dec(enc.h).split(',').filter(Boolean),
        allowedIps: dec(enc.i || '').split(',').filter(Boolean),
        enforceHostLock: flags[0] !== '0',
        enforceIpLock: flags[1] === '1',
        builtAt: dec(enc.b)
    };

    window.__FT_OWNER__ = cfg;

    var PRODUCT = cfg.product;
    var OWNER = cfg.ownerToken;
    var COPYRIGHT = cfg.copyright || ('© ' + PRODUCT);

    function hostAllowed() {
        var h = '';
        var proto = '';
        try { h = String(window.location.hostname || '').toLowerCase(); } catch (e) {}
        try { proto = String(window.location.protocol || ''); } catch (e2) {}

        if (proto === 'file:' || proto === 'capacitor:' || proto === 'ionic:') return true;
        if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
        if (h.indexOf('192.168.') === 0 || h.indexOf('10.') === 0) return true;

        var list = cfg.allowedHosts || [];
        for (var i = 0; i < list.length; i++) {
            var a = String(list[i] || '').toLowerCase();
            if (!a) continue;
            if (h === a || h.slice(-(a.length + 1)) === '.' + a) return true;
        }
        return false;
    }

    function showBlock(reason) {
        try {
            document.documentElement.innerHTML =
                '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>' + PRODUCT + ' — Access denied</title>' +
                '<style>body{margin:0;background:#0B0B0F;color:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}' +
                'h1{font-size:1.25rem;margin:0 0 12px;color:#00E676}p{color:#8E9BAE;max-width:420px;line-height:1.5;margin:0 auto}</style></head>' +
                '<body><div><h1>' + PRODUCT + '</h1><p>' + reason + '</p><p style="margin-top:16px;font-size:12px;opacity:.6">' + COPYRIGHT + '</p></div></body>';
        } catch (e) {}
    }

    if (cfg.enforceHostLock && !hostAllowed()) {
        showBlock('This copy of ' + PRODUCT + ' is not licensed for this domain.');
        return;
    }

    function bootShield() {
        try {
            Object.defineProperty(window, '__FT_SHIELD__', {
                value: Object.freeze({ product: PRODUCT, owner: OWNER, copyright: COPYRIGHT, v: 6 }),
                writable: false,
                configurable: false
            });
        } catch (e) {
            window.__FT_SHIELD__ = { product: PRODUCT, owner: OWNER, v: 6 };
        }

        document.addEventListener('keydown', function (e) {
            var blocked = false;
            if (e.key === 'F12' || e.keyCode === 123) blocked = true;
            if (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) blocked = true;
            if (e.ctrlKey && !e.shiftKey && (e.keyCode === 85 || e.keyCode === 83)) blocked = true;
            if (blocked) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                return false;
            }
        }, true);

        document.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            return false;
        }, true);

        function isEditable(el) {
            if (!el) return false;
            var tag = (el.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
            if (el.isContentEditable) return true;
            return !!(el.closest && el.closest('input, textarea, select, [contenteditable="true"]'));
        }

        document.addEventListener('selectstart', function (e) {
            if (isEditable(e.target)) return;
            e.preventDefault();
        }, true);
        document.addEventListener('dragstart', function (e) {
            if (isEditable(e.target)) return;
            e.preventDefault();
        }, true);
        document.addEventListener('copy', function (e) {
            if (isEditable(e.target)) return;
            e.preventDefault();
            try { if (e.clipboardData) e.clipboardData.setData('text/plain', COPYRIGHT); } catch (err) {}
        }, true);

        var ALLOW = [
            'owner-config.js', 'shield.js', 'app.js', 'landing.js', 'ai-engine.js',
            'firebase-init.js', 'demo-timer.js', 'tv.js', 'tradingview',
            'gstatic.com/firebasejs', 'googleapis.com', 'gstatic.com'
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

        setTimeout(function () {
            try {
                if (!document.getElementById('ft-owner-meta') && document.head) {
                    var meta = document.createElement('meta');
                    meta.id = 'ft-owner-meta';
                    meta.name = 'owner';
                    meta.content = PRODUCT + ' | ' + OWNER;
                    document.head.appendChild(meta);
                }
            } catch (e) {}
        }, 500);

        setTimeout(function () {
            var noop = function () {};
            var methods = ['log', 'debug', 'info', 'warn', 'error', 'table', 'trace', 'dir'];
            for (var i = 0; i < methods.length; i++) {
                try { Object.defineProperty(console, methods[i], { value: noop, writable: false, configurable: false }); } catch (e) {}
            }
        }, 6000);
    }

    function checkIpThenContinue() {
        var ips = cfg.allowedIps || [];
        if (!cfg.enforceIpLock || !ips.length) {
            bootShield();
            return;
        }
        var map = {};
        for (var i = 0; i < ips.length; i++) map[String(ips[i]).trim()] = true;
        var done = false;
        function fail() { if (!done) { done = true; showBlock('Access from this IP address is not allowed.'); } }
        function ok(ip) { if (!done) { done = true; if (map[ip]) bootShield(); else fail(); } }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'https://api.ipify.org?format=json', true);
            xhr.timeout = 6000;
            xhr.onload = function () {
                try { ok(String((JSON.parse(xhr.responseText || '{}')).ip || '')); } catch (e) { fail(); }
            };
            xhr.onerror = fail;
            xhr.ontimeout = fail;
            xhr.send();
        } catch (e) { fail(); }
    }

    checkIpThenContinue();
})();
