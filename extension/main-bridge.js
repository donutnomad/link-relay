// OAuth 拦截钩子 + Gmail ik 提取（MAIN world）。真正的网络请求由 content.js 处理。
(function () {
    'use strict';

    // Gmail ik 提供者（隔离 world 无法访问 window.GLOBALS）
    document.addEventListener('tmx-get-ik', () => {
        try {
            const g = window.GLOBALS;
            if (g && g[9]) document.documentElement.setAttribute('data-tmx-ik', g[9]);
        } catch (e) {}
    });

    // 与原脚本一致：accounts.google.com 与 Gmail 页面不安装 C 模块钩子
    if (location.hostname === 'accounts.google.com') return;
    if (location.hostname === 'mail.google.com' && location.pathname.startsWith('/mail/')) return;

    function isGoogleOAuthUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url, location.href);
            if (u.hostname !== 'accounts.google.com') return false;
            const path = u.pathname;
            const hasOAuthPath =
                path.includes('/o/oauth2') || path.includes('/gsi/') ||
                path.includes('/signin/oauth') || path.includes('/v3/signin');
            const hasOAuthParams =
                u.searchParams.has('client_id') ||
                u.searchParams.get('flowName') === 'GeneralOAuthFlow' ||
                (u.searchParams.get('continue') || '').includes('oauth');
            return hasOAuthPath && hasOAuthParams;
        } catch (e) { return false; }
    }

    function start(url) {
        const abs = new URL(url, location.href).href;
        document.dispatchEvent(new CustomEvent('tmx-oauth-start', { detail: abs }));
    }

    const rawOpen = window.open;
    window.open = function (url, ...args) {
        if (isGoogleOAuthUrl(url)) {
            start(url);
            return { closed: false, close: () => {}, focus: () => {} };
        }
        return rawOpen.apply(this, [url, ...args]);
    };

    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('navigate', function (e) {
            if (e.destination && isGoogleOAuthUrl(e.destination.url)) {
                if (e.cancelable) e.preventDefault();
                start(e.destination.url);
            }
        }, true);
    }

    document.addEventListener('click', function (e) {
        const anchor = e.target.closest ? e.target.closest('a') : null;
        if (anchor && anchor.href && isGoogleOAuthUrl(anchor.href)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            start(anchor.href);
        }
    }, true);

    if (navigator.credentials && navigator.credentials.get) {
        const rawGet = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = function (options) {
            if (options && options.identity) {
                return Promise.reject(new DOMException('FedCM disabled by OAuth bridge', 'NotAllowedError'));
            }
            return rawGet(options);
        };
    }
})();
