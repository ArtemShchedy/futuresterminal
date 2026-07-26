// Демо-доступ: 5 минут. Проверка при загрузке app.html?demo=1
(function () {
    'use strict';
    var DEMO_DURATION_MS = 5 * 60 * 1000;
    var DEMO_CREDITS_DEFAULT = 3;

    var STORAGE_KEY = 'ft_demo_end';
    var STORAGE_GUEST_CREDITS = 'ft_guest_demo_credits_left';

    function getParams() {
        var m = window.location.search.match(/[?&]demo=1/);
        return { isDemo: !!m };
    }

    function getStoredEndTime() {
        try {
            var t = localStorage.getItem(STORAGE_KEY);
            return t ? parseInt(t, 10) : null;
        } catch (e) { return null; }
    }

    function setDemoEndTime() {
        var end = Date.now() + DEMO_DURATION_MS;
        try { localStorage.setItem(STORAGE_KEY, String(end)); } catch (e) {}
        return end;
    }

    function formatTime(ms) {
        var totalSec = Math.max(0, Math.floor(ms / 1000));
        var m = Math.floor(totalSec / 60);
        var s = totalSec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function getGuestCreditsLeft() {
        try {
            var v = localStorage.getItem(STORAGE_GUEST_CREDITS);
            var n = v ? parseInt(v, 10) : DEMO_CREDITS_DEFAULT;
            if (isNaN(n) || n < 0) n = DEMO_CREDITS_DEFAULT;
            return n;
        } catch (e) {
            return DEMO_CREDITS_DEFAULT;
        }
    }

    function setGuestCreditsLeft(n) {
        try { localStorage.setItem(STORAGE_GUEST_CREDITS, String(n)); } catch (e) {}
    }

    function getCurrentUserOnce() {
        var wf = window.appFirebase;
        if (!wf || !wf.auth) return Promise.resolve({ user: null });

        return new Promise(function (resolve) {
            var unsub = wf.auth.onAuthStateChanged(function (user) {
                try { unsub(); } catch (e) {}
                resolve({ user: user || null });
            });
        });
    }

    function logUserEvent(uid, type, extra) {
        var wf = window.appFirebase;
        if (!uid || !wf || !wf.db || !wf.FieldValue) return;
        try {
            wf.db.collection('users').doc(uid).collection('events').add(Object.assign({
                type: type,
                ts: wf.FieldValue.serverTimestamp()
            }, extra || {}));
        } catch (e) {}
    }

    function checkUserPaid(user) {
        var wf = window.appFirebase;
        if (!user || !wf || !wf.db) return Promise.resolve(false);
        return wf.db.collection('users').doc(user.uid).get().then(function (doc) {
            return !!(doc.exists && doc.data() && doc.data().purchased === true);
        }).catch(function () { return false; });
    }

    function decrementDemoCreditsForUser(user) {
        var wf = window.appFirebase;
        if (!user || !wf || !wf.db || !wf.FieldValue) return Promise.reject(new Error('NO_DB'));

        var ref = wf.db.collection('users').doc(user.uid);
        var incrementUsed = wf.FieldValue.increment ? wf.FieldValue.increment(1) : null;
        var serverTs = wf.FieldValue.serverTimestamp();

        return wf.db.runTransaction(function (tx) {
            return tx.get(ref).then(function (doc) {
                var credits = DEMO_CREDITS_DEFAULT;
                var used = 0;
                if (doc.exists && doc.data()) {
                    credits = (doc.data().demoCreditsLeft != null ? doc.data().demoCreditsLeft : DEMO_CREDITS_DEFAULT);
                    used = doc.data().demoSessionsUsed || 0;
                }
                credits = parseInt(credits, 10);
                if (isNaN(credits)) credits = DEMO_CREDITS_DEFAULT;
                if (credits <= 0) throw new Error('NO_DEMO_CREDITS');

                tx.set(ref, {
                    demoCreditsLeft: credits - 1,
                    lastDemoStartedAt: serverTs,
                    demoSessionsUsed: used + 1
                }, { merge: true });
            });
        });
    }

    function redirectDemoExpired() {
        window.location.replace('index.html');
    }

    async function init() {
        var params = getParams();
        if (!params.isDemo) return;

        var banner = document.getElementById('demo-timer-banner');
        var valueEl = document.getElementById('demo-timer-value');
        if (!banner || !valueEl) return;

        var auth = await getCurrentUserOnce();
        var user = auth && auth.user ? auth.user : null;

        // If user already paid: don't run demo timer.
        if (user) {
            var paid = await checkUserPaid(user);
            if (paid) {
                var url = new URL(window.location.href);
                url.searchParams.delete('demo');
                window.location.replace(url.pathname + url.search);
                return;
            }
        }

        var uidForEvents = user ? user.uid : null;
        var endTime = getStoredEndTime();
        var now = Date.now();

        // Continue existing demo session (do not consume credits again).
        if (endTime && endTime > now) {
            banner.style.display = 'flex';
        } else {
            // Start a new demo session: consume one credit.
            if (user) {
                try {
                    await decrementDemoCreditsForUser(user);
                    logUserEvent(uidForEvents, 'demo_start');
                } catch (e) {
                    redirectDemoExpired();
                    return;
                }
            } else {
                var creditsLeft = getGuestCreditsLeft();
                if (creditsLeft <= 0) {
                    redirectDemoExpired();
                    return;
                }
                creditsLeft -= 1;
                setGuestCreditsLeft(creditsLeft);
                logUserEvent(null, 'demo_start_guest');
            }

            endTime = setDemoEndTime();
            banner.style.display = 'flex';
        }

        function tick() {
            var left = endTime - Date.now();
            if (left <= 0) {
                try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
                logUserEvent(uidForEvents, 'demo_expired');
                redirectDemoExpired();
                return;
            }
            valueEl.textContent = formatTime(left);
        }

        tick();
        setInterval(tick, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
