// Firebase init (browser) for FuturesTerminal.
// Auth backend is disabled until you paste your own firebaseConfig below.
(function () {
    'use strict';

    // Leave empty / null to keep the site fully offline from external auth backends.
    var firebaseConfig = null;
    // Example when you create your own project:
    // var firebaseConfig = {
    //     apiKey: "...",
    //     authDomain: "...",
    //     projectId: "...",
    //     storageBucket: "...",
    //     messagingSenderId: "...",
    //     appId: "..."
    // };

    window.appFirebase = window.appFirebase || {
        auth: null,
        db: null,
        FieldValue: null,
        enabled: false
    };

    if (!firebaseConfig || !firebaseConfig.apiKey || !firebaseConfig.projectId) {
        return;
    }

    try {
        if (typeof firebase === 'undefined') throw new Error('Firebase scripts are not loaded');
        if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
    } catch (e) {
        console.error('[FuturesTerminal] Firebase init failed:', e);
        return;
    }

    try { window.appFirebase.auth = firebase.auth(); } catch (e) { window.appFirebase.auth = null; }
    try { window.appFirebase.db = firebase.firestore(); } catch (e) { window.appFirebase.db = null; }
    try { window.appFirebase.FieldValue = firebase.firestore.FieldValue; } catch (e) { window.appFirebase.FieldValue = null; }
    window.appFirebase.enabled = !!(window.appFirebase.auth && window.appFirebase.db);

    try {
        if (window.appFirebase.auth && firebase.auth && firebase.auth.Auth) {
            window.appFirebase.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () { });
        }
    } catch (e) { }
})();
