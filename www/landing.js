// Лендинг: модалки входа и оплаты, редирект в Терминал
(function () {
    'use strict';

    var STORAGE_PAID = 'ft_paid';
    var STORAGE_USER = 'ft_user';

    var authOverlay = document.getElementById('auth-modal-overlay');
    var authModal = document.getElementById('auth-modal');
    var authForm = document.getElementById('auth-form');
    var authClose = document.getElementById('auth-close');
    var authSubmit = document.getElementById('auth-submit');
    var btnLogin = document.getElementById('btn-login');
    var btnOpenTerminal = document.getElementById('btn-open-terminal');
    var accountWrap = document.getElementById('landing-account-wrap');
    var btnAccount = document.getElementById('btn-account');
    var accountLabel = document.getElementById('account-label');
    var accountDropdown = document.getElementById('landing-account-dropdown');
    var btnLogout = document.getElementById('btn-logout');

    var paymentOverlay = document.getElementById('payment-modal-overlay');
    var paymentModal = document.getElementById('payment-modal');
    var paymentClose = document.getElementById('payment-close');
    var paymentSubmit = document.getElementById('payment-submit');

    var demoExpiredToast = document.getElementById('demo-expired-toast');
    var demoExpiredClose = document.getElementById('demo-expired-close');

    var authGoogle = document.getElementById('auth-google');
    var authTabLogin = document.getElementById('auth-tab-login');
    var authTabRegister = document.getElementById('auth-tab-register');
    var authErrorEl = document.getElementById('auth-error');
    var authMode = 'login'; // 'login' | 'register'

    var langWrap = document.getElementById('landing-lang-wrap');
    var btnLang = document.getElementById('btn-lang');
    var langDropdown = document.getElementById('landing-lang-dropdown');
    var LANG_STORAGE = 'ft_lang';
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

    // Site is free — full access for everyone (hide buy / pricing CTAs)
    var SITE_FREE = true;

    // Access state (Firebase-backed)
    // authReady: Firebase has resolved current user (may be null)
    // paidReady: Firestore has resolved purchased flag (best effort)
    var accessState = { authReady: false, paidReady: false, user: null, uid: null, isPaid: true, demoCreditsLeft: 3 };

    function isPaid() {
        return SITE_FREE || !!accessState.isPaid;
    }

    function setPaid() {
        accessState.isPaid = true;
        // Keep legacy flag for any leftover UI logic.
        try { localStorage.setItem(STORAGE_PAID, '1'); } catch (e) {}
    }

    function ensureUserDoc(user, providerName) {
        var wf = window.appFirebase;
        if (!wf || !wf.db || !wf.FieldValue || !user || !user.uid) return Promise.resolve();

        var ref = wf.db.collection('users').doc(user.uid);
        var serverTs = wf.FieldValue.serverTimestamp();
        var increment = wf.FieldValue.increment(1);

        return ref.get().then(function (snap) {
            if (snap.exists) {
                return ref.set({
                    email: user.email || null,
                    authProvider: providerName || snap.data().authProvider,
                    lastSignInAt: serverTs,
                    signInCount: increment
                }, { merge: true });
            }
            return ref.set({
                uid: user.uid,
                email: user.email || null,
                authProvider: providerName || 'password',
                createdAt: serverTs,
                lastSignInAt: serverTs,
                signInCount: 1,
                purchased: false,
                purchasedAt: null,
                demoCreditsLeft: 3
            }, { merge: true });
        }).catch(function () { });
    }

    function refreshPaidStateForUser(user) {
        var wf = window.appFirebase;
        if (!wf || !wf.db || !user || !user.uid) {
            accessState.isPaid = SITE_FREE ? true : false;
            accessState.paidReady = true;
            updateLandingAuthState();
            return;
        }

        if (SITE_FREE) {
            accessState.isPaid = true;
            accessState.paidReady = true;
            updateLandingAuthState();
            return;
        }

        wf.db.collection('users').doc(user.uid).get()
            .then(function (doc) {
                var data = (doc.exists && doc.data()) ? doc.data() : {};
                accessState.isPaid = !!(data && data.purchased === true);
                accessState.demoCreditsLeft = (typeof data.demoCreditsLeft === 'number') ? data.demoCreditsLeft : 3;
                accessState.paidReady = true;
                updateLandingAuthState();
            })
            .catch(function () {
                accessState.isPaid = false;
                accessState.demoCreditsLeft = 3;
                accessState.paidReady = true;
                updateLandingAuthState();
            });
    }

    function unlockLandingAsGuest() {
        if (accessState._inited) return;
        accessState._inited = true;
        accessState.user = null;
        accessState.uid = null;
        accessState.authReady = true;
        accessState.isPaid = SITE_FREE ? true : false;
        accessState.demoCreditsLeft = 3;
        accessState.paidReady = true;
        updateLandingAuthState();
    }

    function initFirebaseAccessState() {
        var wf = window.appFirebase;
        // Auth backend off (firebaseConfig=null) — do not wait forever / black screen
        if (wf && wf.enabled === false) {
            unlockLandingAsGuest();
            return;
        }
        if (!wf || !wf.auth || !wf.db || !wf.FieldValue) {
            if (!initFirebaseAccessState._retries) initFirebaseAccessState._retries = 0;
            initFirebaseAccessState._retries++;
            if (initFirebaseAccessState._retries > 40) {
                unlockLandingAsGuest();
                return;
            }
            setTimeout(initFirebaseAccessState, 50);
            return;
        }
        if (accessState._inited) return;
        accessState._inited = true;

        wf.auth.onAuthStateChanged(function (user) {
            accessState.user = user || null;
            accessState.uid = user ? user.uid : null;
            accessState.authReady = true;
            accessState.paidReady = false;

            if (!user) {
                accessState.isPaid = SITE_FREE ? true : false;
                accessState.demoCreditsLeft = 3;
                accessState.paidReady = true;
                updateLandingAuthState();
                return;
            }

            // Ensure user doc exists for monitoring.
            ensureUserDoc(user, 'auto').then(function () {
                refreshPaidStateForUser(user);
            });
        });
    }

    function waitForAuthReady(timeoutMs) {
        timeoutMs = timeoutMs || 9000;
        return new Promise(function (resolve) {
            if (accessState.authReady) return resolve(true);
            var started = Date.now();
            var t = setInterval(function () {
                if (accessState.authReady) {
                    clearInterval(t);
                    resolve(true);
                    return;
                }
                if (Date.now() - started > timeoutMs) {
                    clearInterval(t);
                    resolve(false);
                }
            }, 50);
        });
    }

    function openAuth() {
        if (authOverlay) {
            authOverlay.classList.add('visible');
            document.body.style.overflow = 'hidden';
        }
    }

    function closeAuth() {
        if (authOverlay) {
            authOverlay.classList.remove('visible');
            document.body.style.overflow = '';
        }
    }

    function setAuthError(msg) {
        if (!authErrorEl) return;
        var text = (msg || '').trim();
        if (!text) {
            authErrorEl.textContent = '';
            authErrorEl.style.display = 'none';
            return;
        }
        authErrorEl.textContent = text;
        authErrorEl.style.display = 'block';
    }

    function setAuthMode(next) {
        authMode = (next === 'register') ? 'register' : 'login';
        if (authTabLogin) authTabLogin.classList.toggle('active', authMode === 'login');
        if (authTabRegister) authTabRegister.classList.toggle('active', authMode === 'register');
        if (authSubmit) {
            authSubmit.textContent = (authMode === 'register') ? 'Зарегистрироваться' : 'Войти по email';
        }
        setAuthError('');
        var pwdEl = document.getElementById('auth-password');
        if (pwdEl) {
            pwdEl.setAttribute('autocomplete', authMode === 'register' ? 'new-password' : 'current-password');
        }
    }

    function openPayment() {
        if (SITE_FREE) {
            goToTerminal();
            return;
        }
        closeAuth();
        if (paymentOverlay) {
            paymentOverlay.classList.add('visible');
            document.body.style.overflow = 'hidden';
        }
    }

    function closePayment() {
        if (paymentOverlay) {
            paymentOverlay.classList.remove('visible');
            document.body.style.overflow = '';
        }
    }

    function buildAppUrl(lang, baseHref) {
        var href = baseHref || 'app.html';
        try {
            var url = new URL(href, window.location.href);
            if (lang) url.searchParams.set('lang', lang);
            return url.pathname.split('/').pop() + url.search + url.hash;
        } catch (e) {
            // fallback for file:// quirks
            var hasQuery = href.indexOf('?') !== -1;
            var hasLang = href.indexOf('lang=') !== -1;
            if (!lang || hasLang) return href;
            return href + (hasQuery ? '&' : '?') + 'lang=' + encodeURIComponent(lang);
        }
    }

    function updateTerminalLinks(lang) {
        var links = document.querySelectorAll('a[href^="app.html"]');
        links.forEach(function (a) {
            var href = a.getAttribute('href') || '';
            a.setAttribute('href', buildAppUrl(lang, href));
        });
    }

    function goToTerminal() {
        window.location.href = buildAppUrl(currentLang || getLang(), 'app.html');
    }

    function stayOnLandingAfterAuth() {
        closePayment();
        closeAuth();
        // no redirect
    }

    function showDemoExpiredLocalToast() {
        if (!demoExpiredToast) return;
        demoExpiredToast.style.display = 'flex';
    }

    function resolveDemoCreditsLeft() {
        var wf = window.appFirebase;
        if (!accessState.user || !wf || !wf.db) return Promise.resolve(3);
        if (accessState.paidReady && typeof accessState.demoCreditsLeft === 'number') {
            return Promise.resolve(accessState.demoCreditsLeft);
        }
        return wf.db.collection('users').doc(accessState.user.uid).get()
            .then(function (doc) {
                var data = (doc.exists && doc.data()) ? doc.data() : {};
                var credits = (typeof data.demoCreditsLeft === 'number') ? data.demoCreditsLeft : 3;
                accessState.demoCreditsLeft = credits;
                accessState.isPaid = !!(data && data.purchased === true);
                accessState.paidReady = true;
                return credits;
            })
            .catch(function () { return 3; });
    }

    function handleTerminalEntry() {
        if (!accessState.authReady) return;
        if (SITE_FREE || isPaid()) { goToTerminal(); return; }
        if (!accessState.user) { openAuth(); return; }

        resolveDemoCreditsLeft().then(function (creditsLeft) {
            if (creditsLeft <= 0) {
                showDemoExpiredLocalToast();
                return;
            }
            goToTerminal();
        });
    }

    function getGuestDemoCreditsLeft() {
        try {
            var raw = localStorage.getItem('ft_guest_demo_credits_left');
            var n = raw == null ? 3 : parseInt(raw, 10);
            if (isNaN(n)) return 3;
            return Math.max(0, n);
        } catch (e) { return 3; }
    }

    function goToDemoTerminal() {
        window.location.href = buildAppUrl(currentLang || getLang(), 'app.html?demo=1');
    }

    function handleDemoEntry() {
        if (!accessState.authReady) return;
        // Paid users should not go to demo.
        if (isPaid()) {
            goToTerminal();
            return;
        }

        if (!accessState.user) {
            var guestCredits = getGuestDemoCreditsLeft();
            if (guestCredits <= 0) {
                showDemoExpiredLocalToast();
                return;
            }
            goToDemoTerminal();
            return;
        }

        resolveDemoCreditsLeft().then(function (creditsLeft) {
            if (creditsLeft <= 0) {
                showDemoExpiredLocalToast();
                return;
            }
            goToDemoTerminal();
        });
    }

    // Отображение «Войти» vs «Аккаунт» в шапке
    function updateLandingAuthState() {
        var paid = isPaid();
        var signedIn = !!accessState.user;
        var user = accessState.user;

        // UI: если пользователь залогинен в Firebase — показываем "Аккаунт" (даже если ещё не купил).
        // А "Купить" / "Lifetime" логика остаётся на уровне purchased (в терминале).
        if (btnLogin) btnLogin.style.display = signedIn ? 'none' : '';
        if (accountWrap) {
            accountWrap.style.display = signedIn ? 'flex' : 'none';
            accountWrap.classList.remove('dropdown-open');
        }

        // Label: Google -> displayName, Email -> email
        if (accountLabel) {
            var label = '';
            if (user) {
                if (user.displayName && String(user.displayName).trim()) label = String(user.displayName).trim();
                else if (user.email && String(user.email).trim()) label = String(user.email).trim();
            }
            accountLabel.textContent = label || 'Аккаунт';
        }

        // Purchase CTAs / pricing — hidden when paid or site is free
        var demoLinks = document.querySelectorAll('a[href*="demo=1"]');
        demoLinks.forEach(function (a) {
            if (SITE_FREE) {
                a.style.display = '';
                a.setAttribute('href', 'app.html');
            } else {
                a.style.display = paid ? 'none' : '';
            }
        });

        var btnPricingLifetime = document.getElementById('btn-pricing-lifetime');
        if (btnPricingLifetime) btnPricingLifetime.style.display = (SITE_FREE || paid) ? 'none' : '';

        // Hide "Купить" nav links when site is free / paid
        var buyNavLinks = document.querySelectorAll('a[href="#pricing"]');
        buyNavLinks.forEach(function (a) { a.style.display = (SITE_FREE || paid) ? 'none' : ''; });

        // Hide entire pricing section when site is free
        var pricingSection = document.getElementById('pricing');
        if (pricingSection) pricingSection.style.display = SITE_FREE ? 'none' : '';
        var paymentModal = document.getElementById('payment-modal');
        if (paymentModal && SITE_FREE) paymentModal.style.display = 'none';

        // Safety: never keep payment modal open after auth state updates.
        if (paymentOverlay) {
            paymentOverlay.classList.remove('visible');
            document.body.style.overflow = '';
        }

        // Auth state is resolved at least once -> allow auth UI to render without flicker
        try { document.documentElement.classList.remove('auth-pending'); } catch (e) {}

        // Purchased state: remove access-pending when it is safe
        // - if not signed in: no purchased lookup needed
        // - if signed in: wait until paidReady is set (best effort)
        try {
            if (!accessState.user) {
                document.documentElement.classList.remove('access-pending');
            } else if (accessState.paidReady) {
                document.documentElement.classList.remove('access-pending');
            }
        } catch (e) {}

        // Remove full-page boot lock only when we know enough to render final UI.
        // If signed out: authReady is enough.
        // If signed in: wait for paidReady too.
        try {
            var canRender = !!accessState.authReady && (!accessState.user || !!accessState.paidReady);
            if (canRender) document.documentElement.classList.remove('boot-pending');
        } catch (e) {}
    }

    if (btnAccount) {
        btnAccount.addEventListener('click', function (e) {
            e.stopPropagation();
            accountWrap.classList.toggle('dropdown-open');
            if (langWrap) langWrap.classList.remove('dropdown-open');
        });
    }
    if (btnLogout) {
        btnLogout.addEventListener('click', function () {
            var wf = window.appFirebase;
            if (wf && wf.auth) {
                wf.auth.signOut().catch(function () { });
            }
            updateLandingAuthState();
        });
    }
    document.addEventListener('click', function () {
        if (accountWrap) accountWrap.classList.remove('dropdown-open');
        if (langWrap) langWrap.classList.remove('dropdown-open');
    });
    if (accountDropdown) {
        accountDropdown.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    if (btnLang && langWrap) {
        btnLang.addEventListener('click', function (e) {
            e.stopPropagation();
            langWrap.classList.toggle('dropdown-open');
            if (accountWrap) accountWrap.classList.remove('dropdown-open');
        });
    }
    if (langDropdown) {
        langDropdown.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    var currentLang = null;
    function setLang(code, persist) {
        code = normalizeLang(code) || 'ru';
        if (persist !== false) {
            try { localStorage.setItem(LANG_STORAGE, code); } catch (e) {}
        }
        currentLang = code;
        var opts = document.querySelectorAll('.landing-lang-option');
        opts.forEach(function (o) {
            o.classList.toggle('active', o.getAttribute('data-lang') === code);
        });
        applyI18n(code);
        updateTerminalLinks(code);
    }
    function getLang() {
        try { return normalizeLang(localStorage.getItem(LANG_STORAGE) || 'ru') || 'ru'; } catch (e) { return 'ru'; }
    }
    var langOpts = document.querySelectorAll('.landing-lang-option');
    langOpts.forEach(function (btn) {
        btn.addEventListener('click', function () {
            setLang(btn.getAttribute('data-lang'));
        });
    });
    var fromUrl = normalizeLang(getLangFromUrl());
    if (fromUrl) setLang(fromUrl, true);
    else setLang(getLang());
    updateTerminalLinks(currentLang || getLang());

    // Sync language across open tabs/windows (landing <-> terminal)
    window.addEventListener('storage', function (e) {
        if (!e || e.key !== LANG_STORAGE) return;
        var next = e.newValue || 'ru';
        if (next === currentLang) return;
        setLang(next, false);
    });

    // Centered anchor scroll for pricing (works from any entry point, incl. terminal -> index.html#pricing)
    function scrollElementToViewportCenter(el, behavior) {
        if (!el) return;
        var rect = el.getBoundingClientRect();
        var absoluteTop = (window.pageYOffset || document.documentElement.scrollTop || 0) + rect.top;
        var targetTop = absoluteTop - (window.innerHeight / 2 - rect.height / 2);
        if (targetTop < 0) targetTop = 0;
        try {
            window.scrollTo({ top: targetTop, behavior: behavior || 'smooth' });
        } catch (e) {
            window.scrollTo(0, targetTop);
        }
    }

    function centerHashIfNeeded(behavior) {
        if (!window.location || !window.location.hash) return;
        var hash = window.location.hash.replace('#', '');
        if (!hash) return;
        var el = document.getElementById(hash);
        if (!el) return;
        scrollElementToViewportCenter(el, behavior || 'smooth');
    }

    // Intercept clicks on links to #pricing to center the section
    var pricingLinks = document.querySelectorAll('a[href="#pricing"]');
    pricingLinks.forEach(function (a) {
        a.addEventListener('click', function (e) {
            e.preventDefault();
            try { history.pushState(null, '', '#pricing'); } catch (err) {}
            centerHashIfNeeded('smooth');
        });
    });

    window.addEventListener('hashchange', function () { centerHashIfNeeded('smooth'); });
    // When coming from another page with #pricing, fonts/layout may shift — re-run a couple times
    setTimeout(function () { centerHashIfNeeded('auto'); }, 0);
    setTimeout(function () { centerHashIfNeeded('auto'); }, 120);
    setTimeout(function () { centerHashIfNeeded('auto'); }, 320);

    function applyI18n(lang) {
        var L = normalizeLang(lang) || 'ru';
        var dict = {
            ru: {
                'nav.buy': 'Купить', 'nav.demo': 'Демо', 'nav.terminal': 'Терминал',
                'lang.menuTitle': 'Язык', 'lang.aria': 'Язык', 'lang.title': 'Язык',
                'auth.login': 'Войти', 'account.label': 'Аккаунт', 'account.openTerminal': 'Открыть Терминал', 'account.logout': 'Выйти',
                'footer.terminal': 'Терминал', 'footer.demo': 'Демо', 'footer.copy': '© FuturesTerminal. Торговля сопряжена с рисками.',
                'tv.poweredBy': 'Powered by',
                'hero.label': 'Торговый терминал', 'hero.title1': 'Прогнозируйте рынок с ИИ', 'hero.title2': 'точностью',
                'hero.subtitle': 'Превратите терминал в мощный аналитический инструмент. Автоматическое определение трендов, анализ RSI, скользящих средних и моментума в реальном времени.',
                'hero.demoBtn': 'Демо 5 минут', 'hero.enterTerminal': 'Войти в Терминал',
                'hero.trustBinance': 'Данные Binance', 'hero.trustDemo': 'Демо без карты', 'hero.trustCryptoForex': 'Только крипто',
                'preview.label': 'Интерфейс', 'preview.title': 'Будущее трейдинга', 'preview.search': 'Поиск...', 'preview.emulator': '⚡ Эмулятор',
                'preview.volume': 'Объём', 'preview.24h': '24h%', 'preview.name': 'Имя', 'preview.directionUp': 'Рост', 'preview.confidenceLabel': 'Уверенность',
                'preview.longtermTitle': 'Долгосрочный прогноз', 'preview.candles': 'Свечи',
                'preview.forecastText': 'Краткосрочный прогноз: продолжение роста. Поддержка удержится, отскок к сопротивлению. RSI 58 — умеренный восходящий импульс.',
                'preview.ctaHintBefore': 'Откройте ', 'preview.ctaHintAfter': ' и попробуйте интерфейс за 5 минут.',
                'how.label': 'Как начать', 'how.title': 'Четыре шага до первого сигнала',
                'how.step1Title': 'Демо', 'how.step1Desc': 'Запустите терминал на 5 минут без регистрации и оцените интерфейс и AI-анализ.',
                'how.step2Title': 'Вход', 'how.step2Desc': 'Войдите по email или через Google, Facebook, X — один аккаунт на всех устройствах.',
                'how.step3Title': 'Оплата', 'how.step3Desc': 'Lifetime: $49 один раз. Оплата криптой (USDT, TON) — доступ навсегда.',
                'how.step4Title': 'Терминал', 'how.step4Desc': 'Полный доступ: графики, AI-прогноз по горизонтам, эмулятор и история сделок.',
                'slogan.before': 'Один интерфейс. ', 'slogan.accent': 'AI-прогноз', 'slogan.after': ' и полный контроль.',
                'metrics.label': 'Метрики', 'metrics.title': 'Все нужные метрики в одном месте',
                'metrics.card1Title': 'Анализ RSI и Моментума', 'metrics.card1Desc': 'Моментальный расчёт перекупленности и перепроданности. ИИ вычисляет импульс движения за последние 5 свечей.',
                'metrics.card2Title': 'Zero-Lag Скользящие', 'metrics.card2Desc': 'Анализ пересечения краткосрочных и долгосрочных SMA/EMA без задержек. Чёткий контекст рынка.',
                'metrics.card3Title': 'Уверенность ИИ (%)', 'metrics.card3Desc': 'Нейросеть агрегирует все факторы в единый процент уверенности: Спад, Рост или Боковик.',
                'features.label': 'Возможности', 'features.title': 'Всё, что нужно для анализа и практики',
                'features.f1Title': 'Мультитаймфрейм', 'features.f1Desc': '4 графика в одном окне: 4H, 1H, 15M, 5M. Контекст старших ТФ и детализация младших без переключения.',
                'features.f2Title': 'Прогноз по времени', 'features.f2Desc': 'Краткосрочные горизонты от 1 минуты до 1 часа и долгосрочные 4ч, 1д, 1нед с процентом уверенности.',
                'features.f3Title': 'Раннее предупреждение', 'features.f3Desc': 'Сигналы смены тренда до разворота. Оценка вероятности и причины — RSI-дивергенция, сужение Bollinger Bands.',
                'features.f4Title': 'Демо-счёт и TP/SL', 'features.f4Desc': 'Эмулятор с плечом до 100x, маржа и комиссия 0.04%. Тейк-профит и стоп-лосс с автоматическим срабатыванием.',
                'features.f5Title': 'Криптовалюты в одном месте', 'features.f5Desc': 'Список монет по объёму и 24h%. Графики TradingView и AI-анализ для крипто.',
                'features.f6Title': 'Рекомендации по входам', 'features.f6Desc': 'Сценарии лонг/шорт с уровнями входа, стопа и тейков. Учёт индикаторов, ADX и дивергенций.',
                'product.label': 'Продукт', 'product.title': 'Один терминал вместо нескольких окон',
                'product.b1Title': 'Графики', 'product.b1Desc': 'Список инструментов, поиск, сортировка по объёму и 24h%. Один или четыре таймфрейма на экране. RSI на графике.',
                'product.b2Title': 'AI-панель', 'product.b2Desc': 'Направление и сила сигнала, RSI, горизонты, долгосрочный прогноз, индикаторы и текстовый разбор с уровнями.',
                'product.b3Title': 'Эмулятор', 'product.b3Desc': 'Открытие лонг/шорт, плечо, маржа, TP/SL. Баланс $10k, история позиций и закрытие по кнопке или по срабатыванию ордеров.',
                'pricing.label': 'Тариф', 'pricing.title': 'Доступ навсегда', 'pricing.cardTitle': 'Lifetime License', 'pricing.forever': '/ навсегда',
                'pricing.li1': 'Полный доступ к терминалу в браузере', 'pricing.li2': 'Мгновенный анализ 141+ монет', 'pricing.li3': 'Бесплатные обновления алгоритма', 'pricing.li4': 'Поддержка в Telegram',
                'pricing.payBtn': 'Оплатить Crypto', 'pricing.methods': 'Поддерживаем USDT (TRC20, BEP20), TON', 'pricing.noteBefore': 'Сначала попробуйте ', 'pricing.noteAfter': ' без регистрации.',
                'cta.title': 'Готовы попробовать?', 'cta.subtitle': 'Запустите демо или войдите в аккаунт и откройте полный терминал.', 'cta.demoBtn': 'Демо 5 минут', 'cta.enterBtn': 'Войти в Терминал',
                'auth.modalTitle': 'Вход в Терминал', 'auth.modalSubtitle': 'Войдите, чтобы оформить подписку и получить полный доступ.',
                'auth.emailLabel': 'Email', 'auth.emailPlaceholder': 'your@email.com', 'auth.passwordLabel': 'Пароль', 'auth.passwordPlaceholder': '••••••••',
                'auth.submitBtn': 'Войти по email', 'auth.divider': 'или войти через', 'auth.footerNote': 'Регистрируясь, вы соглашаетесь с условиями использования.', 'auth.closeAria': 'Закрыть',
                'payment.modalTitle': 'Lifetime License', 'payment.modalSubtitle': '$49 — доступ к терминалу навсегда.', 'payment.payBtn': 'Оплатить Crypto', 'payment.note': 'Поддерживаем USDT (TRC20, BEP20), TON',
                'demoExpired.text': 'Демо-доступ закончился. Войдите и оплатите подписку для полного доступа.'
            },
            en: {
                'nav.buy': 'Buy', 'nav.demo': 'Demo', 'nav.terminal': 'Terminal',
                'lang.menuTitle': 'Language', 'lang.aria': 'Language', 'lang.title': 'Language',
                'auth.login': 'Sign in', 'account.label': 'Account', 'account.openTerminal': 'Open Terminal', 'account.logout': 'Sign out',
                'footer.terminal': 'Terminal', 'footer.demo': 'Demo', 'footer.copy': '© FuturesTerminal. Trading involves risks.',
                'tv.poweredBy': 'Powered by',
                'hero.label': 'Trading terminal', 'hero.title1': 'Predict the market with AI', 'hero.title2': 'Accuracy',
                'hero.subtitle': 'Turn the terminal into a powerful analytics tool. Automatic trend detection, RSI, moving averages and momentum analysis in real time.',
                'hero.demoBtn': 'Demo 5 min', 'hero.enterTerminal': 'Enter Terminal',
                'hero.trustBinance': 'Binance data', 'hero.trustDemo': 'Demo, no card', 'hero.trustCryptoForex': 'Crypto only',
                'preview.label': 'Interface', 'preview.title': 'The future of trading', 'preview.search': 'Search...', 'preview.emulator': '⚡ Emulator',
                'preview.volume': 'Volume', 'preview.24h': '24h%', 'preview.name': 'Name', 'preview.directionUp': 'Up', 'preview.confidenceLabel': 'Confidence',
                'preview.longtermTitle': 'Long-term forecast', 'preview.candles': 'Candles',
                'preview.forecastText': 'Short-term forecast: uptrend continues. Support holds, bounce to resistance. RSI 58 — moderate bullish momentum.',
                'preview.ctaHintBefore': 'Open ', 'preview.ctaHintAfter': ' and try the interface in 5 minutes.',
                'how.label': 'How to start', 'how.title': 'Four steps to your first signal',
                'how.step1Title': 'Demo', 'how.step1Desc': 'Run the terminal for 5 minutes with no sign-up and try the interface and AI analysis.',
                'how.step2Title': 'Sign in', 'how.step2Desc': 'Sign in with email or Google, Facebook, X — one account on all devices.',
                'how.step3Title': 'Payment', 'how.step3Desc': 'Lifetime: $49 one-time. Pay with crypto (USDT, TON) — access forever.',
                'how.step4Title': 'Terminal', 'how.step4Desc': 'Full access: charts, AI forecast by timeframe, emulator and trade history.',
                'slogan.before': 'One interface. ', 'slogan.accent': 'AI forecast', 'slogan.after': ' and full control.',
                'metrics.label': 'Metrics', 'metrics.title': 'All the metrics you need in one place',
                'metrics.card1Title': 'RSI and momentum analysis', 'metrics.card1Desc': 'Instant overbought/oversold. AI computes momentum over the last 5 candles.',
                'metrics.card2Title': 'Zero-Lag moving averages', 'metrics.card2Desc': 'Short and long-term SMA/EMA crossover analysis with no lag. Clear market context.',
                'metrics.card3Title': 'AI confidence (%)', 'metrics.card3Desc': 'The model aggregates all factors into a single confidence: Down, Up or Sideways.',
                'features.label': 'Features', 'features.title': 'Everything for analysis and practice',
                'features.f1Title': 'Multi-timeframe', 'features.f1Desc': '4 charts in one window: 4H, 1H, 15M, 5M. Higher TF context and lower TF detail without switching.',
                'features.f2Title': 'Time-based forecast', 'features.f2Desc': 'Short-term horizons from 1 min to 1 hour and long-term 4h, 1d, 1w with confidence percentage.',
                'features.f3Title': 'Early warning', 'features.f3Desc': 'Trend change signals before the turn. Probability and cause — RSI divergence, Bollinger squeeze.',
                'features.f4Title': 'Demo account and TP/SL', 'features.f4Desc': 'Emulator with leverage up to 100x, margin and 0.04% fee. Take profit and stop loss with auto execution.',
                'features.f5Title': 'Crypto in one place', 'features.f5Desc': 'Coins by volume and 24h%. TradingView charts and AI analysis for crypto.',
                'features.f6Title': 'Entry recommendations', 'features.f6Desc': 'Long/short scenarios with entry, stop and target levels. Indicators, ADX and divergences.',
                'product.label': 'Product', 'product.title': 'One terminal instead of many windows',
                'product.b1Title': 'Charts', 'product.b1Desc': 'Instruments list, search, sort by volume and 24h%. One or four timeframes on screen. RSI on chart.',
                'product.b2Title': 'AI panel', 'product.b2Desc': 'Direction and signal strength, RSI, horizons, long-term forecast, indicators and text analysis with levels.',
                'product.b3Title': 'Emulator', 'product.b3Desc': 'Open long/short, leverage, margin, TP/SL. $10k balance, position history and close by button or order trigger.',
                'pricing.label': 'Pricing', 'pricing.title': 'Access forever', 'pricing.cardTitle': 'Lifetime License', 'pricing.forever': '/ forever',
                'pricing.li1': 'Full terminal access in browser', 'pricing.li2': 'Instant analysis of 141+ coins', 'pricing.li3': 'Free algorithm updates', 'pricing.li4': 'Telegram support',
                'pricing.payBtn': 'Pay with Crypto', 'pricing.methods': 'We support USDT (TRC20, BEP20), TON', 'pricing.noteBefore': 'Try ', 'pricing.noteAfter': ' first, no sign-up.',
                'cta.title': 'Ready to try?', 'cta.subtitle': 'Launch the demo or sign in and open the full terminal.', 'cta.demoBtn': 'Demo 5 min', 'cta.enterBtn': 'Enter Terminal',
                'auth.modalTitle': 'Sign in to Terminal', 'auth.modalSubtitle': 'Sign in to subscribe and get full access.',
                'auth.emailLabel': 'Email', 'auth.emailPlaceholder': 'your@email.com', 'auth.passwordLabel': 'Password', 'auth.passwordPlaceholder': '••••••••',
                'auth.submitBtn': 'Sign in with email', 'auth.divider': 'or sign in with', 'auth.footerNote': 'By signing up you agree to the terms of use.', 'auth.closeAria': 'Close',
                'payment.modalTitle': 'Lifetime License', 'payment.modalSubtitle': '$49 — terminal access forever.', 'payment.payBtn': 'Pay with Crypto', 'payment.note': 'We support USDT (TRC20, BEP20), TON',
                'demoExpired.text': 'Demo access has ended. Sign in and pay to get full access.'
            }
        };

        var map = dict[L] || dict.ru;

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
            if (map[key]) el.placeholder = map[key];
        });
        try { document.documentElement.lang = (L === 'en') ? 'en' : 'ru'; } catch (e) {}
        // Убираем opacity:0 (anti-FOUC из <head>)
        document.documentElement.style.opacity = '';
    }

    // Кнопка "Войти" / "Войти в терминал"
    function onLoginClick() {
        handleTerminalEntry();
    }

    if (btnLogin) btnLogin.addEventListener('click', onLoginClick);
    if (btnOpenTerminal) btnOpenTerminal.addEventListener('click', onLoginClick);
    var btnOpenTerminal2 = document.getElementById('btn-open-terminal-2');
    if (btnOpenTerminal2) btnOpenTerminal2.addEventListener('click', onLoginClick);

    // Guard all direct links to app.html (without demo flag) to avoid "flash then redirect".
    var terminalLinks = document.querySelectorAll('a[href^="app.html"]:not([href*="demo=1"])');
    terminalLinks.forEach(function (a) {
        a.addEventListener('click', function (e) {
            e.preventDefault();
            handleTerminalEntry();
        });
    });

    // Guard all demo links to avoid "flash then redirect" when demo credits are exhausted.
    var demoLinks = document.querySelectorAll('a[href*="app.html?demo=1"]');
    demoLinks.forEach(function (a) {
        a.addEventListener('click', function (e) {
            e.preventDefault();
            handleDemoEntry();
        });
    });

    // Кнопка «Оплатить Crypto» на странице (pricing)
    var btnPricingLifetime = document.getElementById('btn-pricing-lifetime');
    if (btnPricingLifetime) btnPricingLifetime.addEventListener('click', function () {
        if (!accessState.authReady) return;
        // Если уже залогинен — показываем оплату. Если нет — показываем вход.
        if (accessState.user) openPayment();
        else openAuth();
    });

    // Закрытие модалок
    if (authClose) authClose.addEventListener('click', closeAuth);
    if (paymentClose) paymentClose.addEventListener('click', closePayment);

    if (authOverlay) {
        authOverlay.addEventListener('click', function (e) {
            if (e.target === authOverlay) closeAuth();
        });
    }
    if (paymentOverlay) {
        paymentOverlay.addEventListener('click', function (e) {
            if (e.target === paymentOverlay) closePayment();
        });
    }

    // Вход по email (sign-in + auto-register when user not found)
    if (authForm) {
        authForm.addEventListener('submit', function (e) {
            e.preventDefault();
            setAuthError('');
            var emailEl = document.getElementById('auth-email');
            var email = emailEl && emailEl.value ? emailEl.value.trim() : '';
            var passwordEl = document.getElementById('auth-password');
            var password = passwordEl && passwordEl.value ? passwordEl.value : '';
            if (!email || !password) return;

            var wf = window.appFirebase;
            if (!wf || !wf.auth) { alert('Firebase не инициализирован'); return; }

            authSubmit.textContent = 'Вход...';
            authSubmit.disabled = true;

            var authPromise = (authMode === 'register')
                ? wf.auth.createUserWithEmailAndPassword(email, password)
                : wf.auth.signInWithEmailAndPassword(email, password);

            authPromise
                .then(function (cred) {
                    return ensureUserDoc(cred.user, 'email').then(function () {
                        return wf.db.collection('users').doc(cred.user.uid).get()
                            .then(function (doc) {
                                var data = (doc.exists && doc.data()) ? doc.data() : {};
                                var paidNow = !!(data && data.purchased === true);
                                accessState.isPaid = paidNow;
                                accessState.demoCreditsLeft = (typeof data.demoCreditsLeft === 'number') ? data.demoCreditsLeft : 3;
                                accessState.authReady = true;
                                accessState.paidReady = true;
                                updateLandingAuthState();
                                stayOnLandingAfterAuth();
                            });
                    });
                })
                .catch(function (err) {
                    // If user does not exist on login: suggest switching to registration.
                    if (err && err.code === 'auth/user-not-found') {
                        setAuthMode('register');
                        setAuthError('Аккаунт не найден. Переключился на регистрацию.');
                        return;
                    }
                    if (err && err.code === 'auth/wrong-password') {
                        setAuthError('Неверный email или пароль.');
                        return;
                    }
                    if (err && err.code === 'auth/invalid-credential') {
                        setAuthError('Неверный email или пароль.');
                        return;
                    }
                    if (err && err.code === 'auth/email-already-in-use') {
                        setAuthMode('login');
                        setAuthError('Email уже зарегистрирован. Переключился на вход.');
                        return;
                    }
                    setAuthError((err && err.message) ? err.message : String(err));
                })
                .finally(function () {
                    authSubmit.textContent = (authMode === 'register') ? 'Зарегистрироваться' : 'Войти по email';
                    authSubmit.disabled = false;
                });
        });
    }

    // Социальный вход
    function socialLogin(provider) {
        var wf = window.appFirebase;
        if (!wf || !wf.auth) { setAuthError('Firebase не инициализирован'); return; }
        setAuthError('');

        var p = null;
        try {
            if (provider === 'google') p = new firebase.auth.GoogleAuthProvider();
        } catch (e) {
            p = null;
        }

        if (!p) {
            alert('Провайдер не настроен в Firebase: ' + provider);
            return;
        }

        wf.auth.signInWithPopup(p)
            .then(function (cred) {
                return ensureUserDoc(cred.user, provider).then(function () {
                    return wf.db.collection('users').doc(cred.user.uid).get()
                        .then(function (doc) {
                            var data = (doc.exists && doc.data()) ? doc.data() : {};
                            var paidNow = !!(data && data.purchased === true);
                            accessState.isPaid = paidNow;
                            accessState.demoCreditsLeft = (typeof data.demoCreditsLeft === 'number') ? data.demoCreditsLeft : 3;
                            accessState.authReady = true;
                            accessState.paidReady = true;
                            updateLandingAuthState();
                            stayOnLandingAfterAuth();
                        });
                });
            })
            .catch(function (err) {
                if (err && err.code === 'auth/invalid-credential') {
                    setAuthError('Не удалось выполнить вход. Попробуй ещё раз.');
                    return;
                }
                setAuthError((err && err.message) ? err.message : String(err));
            });
    }

    if (authGoogle) authGoogle.addEventListener('click', function () { socialLogin('google'); });

    if (authTabLogin) authTabLogin.addEventListener('click', function () { setAuthMode('login'); });
    if (authTabRegister) authTabRegister.addEventListener('click', function () { setAuthMode('register'); });

    // Clear inline error on typing
    var authEmailEl = document.getElementById('auth-email');
    var authPwdEl = document.getElementById('auth-password');
    if (authEmailEl) authEmailEl.addEventListener('input', function () { setAuthError(''); });
    if (authPwdEl) authPwdEl.addEventListener('input', function () { setAuthError(''); });

    // Оплата (test): помечаем purchased=true и редирект в Терминал
    if (paymentSubmit) {
        paymentSubmit.addEventListener('click', function () {
            if (paymentSubmit.disabled) return;

            var wf = window.appFirebase;
            if (!wf || !wf.auth || !wf.db) { alert('Firebase не инициализирован'); return; }

            paymentSubmit.textContent = 'Обработка...';
            paymentSubmit.disabled = true;

            // Wait until Firebase finishes loading auth state.
            waitForAuthReady(9000).then(function () {
                var user = wf.auth.currentUser || accessState.user;
                if (!user) {
                    // If user is not available even after authReady,
                    // do NOT annoy with re-login loop; ask to refresh.
                    closePayment();
                    alert('Сессия входа ещё не восстановилась. Обнови страницу (Ctrl+F5) и попробуй снова.');
                    paymentSubmit.textContent = 'Оплатить Crypto';
                    paymentSubmit.disabled = false;
                    return;
                }

                var serverTs = wf.FieldValue && wf.FieldValue.serverTimestamp ? wf.FieldValue.serverTimestamp() : null;

                wf.db.collection('users').doc(user.uid).set({
                    purchased: true,
                    purchasedAt: serverTs,
                    demoCreditsLeft: 0
                }, { merge: true }).then(function () {
                    try {
                        wf.db.collection('users').doc(user.uid).collection('events').add({
                            type: 'purchase_test',
                            ts: serverTs,
                            price: 49,
                            currency: 'USD'
                        });
                    } catch (e) { }
                    setPaid();
                    closePayment();
                    goToTerminal();
                }).catch(function (err) {
                    alert((err && err.message) ? err.message : String(err));
                    paymentSubmit.textContent = 'Оплатить Crypto';
                    paymentSubmit.disabled = false;
                });
            });
        });
    }

    // Показать тост "Демо закончилось" при ?demo=expired
    function checkDemoExpired() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('demo') === 'expired' && demoExpiredToast) {
            demoExpiredToast.style.display = 'flex';
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    if (demoExpiredClose) {
        demoExpiredClose.addEventListener('click', function () {
            if (demoExpiredToast) demoExpiredToast.style.display = 'none';
        });
    }

    checkDemoExpired();
    // Safety: ensure payment modal is not visible on page load.
    if (paymentOverlay) {
        paymentOverlay.classList.remove('visible');
        document.body.style.overflow = '';
    }
    setAuthMode('login');
    initFirebaseAccessState();
})();
