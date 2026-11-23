// 移植自 protocol.js（MAIN world）
(function () {
    'use strict';

    // 仅允许纯网页与浏览器内部基础协议
    const STRICT_WEB_PROTOCOLS = new Set([
        'http:',
        'https:',
        'javascript:',
        'blob:',
        'data:',
        'about:'
    ]);

    // 由设置页控制（通过 isolated 脚本下发）；默认开启
    let enabled = true;
    document.addEventListener('tmx-config', (e) => {
        try { enabled = !!JSON.parse(e.detail).blockProtocol; } catch (err) {}
    });

    // 用于临时放行用户手动点击“放行”的链接
    let bypassedUrl = null;
    // 防抖记录，避免某些流氓网页在死循环里疯狂触发同链接弹窗
    let lastShownUrl = '';
    let lastShownTime = 0;

    function isExternalProtocol(url) {
        if (!enabled) return false;
        if (!url || typeof url !== 'string') return false;
        const trimmed = url.trim();

        if (bypassedUrl && trimmed === bypassedUrl) {
            bypassedUrl = null;
            return false;
        }

        if (
            trimmed.startsWith('/') ||
            trimmed.startsWith('./') ||
            trimmed.startsWith('../') ||
            trimmed.startsWith('#')
        ) {
            return false;
        }

        try {
            const parsed = new URL(trimmed, location.href);
            return !STRICT_WEB_PROTOCOLS.has(parsed.protocol.toLowerCase());
        } catch (e) {
            return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
        }
    }

    // 在页面右下角显示被拦截的链接提示条（使用 Shadow DOM 隔离网页样式）
    function showBlockedToast(url, source) {
        console.warn(`[已拦截外部协议 - ${source}]:`, url);

        const now = Date.now();
        if (url === lastShownUrl && now - lastShownTime < 1500) {
            return; // 1.5秒内重复触发同一链接不再重复弹窗
        }
        lastShownUrl = url;
        lastShownTime = now;

        const render = () => {
            let host = document.getElementById('tm-protocol-blocker-host');
            if (!host) {
                host = document.createElement('div');
                host.id = 'tm-protocol-blocker-host';
                Object.assign(host.style, {
                    position: 'fixed',
                    bottom: '20px',
                    right: '20px',
                    zIndex: '2147483647',
                    pointerEvents: 'none'
                });
                (document.body || document.documentElement).appendChild(host);
            }

            const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });

            // 限制最多同时显示 3 条通知
            while (shadow.children.length >= 3) {
                shadow.removeChild(shadow.firstChild);
            }

            const card = document.createElement('div');
            Object.assign(card.style, {
                pointerEvents: 'auto',
                background: 'rgba(24, 24, 27, 0.94)',
                color: '#f4f4f5',
                border: '1px solid rgba(255, 255, 255, 0.14)',
                borderRadius: '10px',
                padding: '12px 14px',
                marginTop: '10px',
                width: '340px',
                boxShadow: '0 10px 25px rgba(0, 0, 0, 0.35)',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontSize: '12px',
                lineHeight: '1.5',
                backdropFilter: 'blur(8px)',
                transition: 'opacity 0.25s ease'
            });

            // 头部标题栏
            const header = document.createElement('div');
            Object.assign(header.style, {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '6px',
                fontWeight: '600',
                color: '#fbbf24'
            });
            header.textContent = `🛡️ 已拦截外部协议 (${source})`;

            const closeBtn = document.createElement('span');
            closeBtn.textContent = '✕';
            Object.assign(closeBtn.style, {
                cursor: 'pointer',
                color: '#a1a1aa',
                padding: '0 4px',
                fontSize: '13px'
            });
            closeBtn.onclick = () => card.remove();
            header.appendChild(closeBtn);

            // 链接展示框
            const urlBox = document.createElement('div');
            urlBox.textContent = url;
            Object.assign(urlBox.style, {
                background: 'rgba(0, 0, 0, 0.45)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '6px',
                padding: '6px 8px',
                color: '#e4e4e7',
                wordBreak: 'break-all',
                maxHeight: '72px',
                overflowY: 'auto',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: '11px',
                marginBottom: '8px',
                userSelect: 'all'
            });

            // 底部操作按钮
            const actions = document.createElement('div');
            Object.assign(actions.style, {
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px'
            });

            const btnStyle = {
                border: 'none',
                borderRadius: '5px',
                padding: '4px 10px',
                fontSize: '11px',
                cursor: 'pointer',
                fontWeight: '500'
            };

            const copyBtn = document.createElement('button');
            copyBtn.textContent = '复制链接';
            Object.assign(copyBtn.style, btnStyle, {
                background: '#3f3f46',
                color: '#fff'
            });
            copyBtn.onclick = () => {
                navigator.clipboard.writeText(url).then(() => {
                    copyBtn.textContent = '已复制 ✓';
                    copyBtn.style.background = '#16a34a';
                    setTimeout(() => {
                        copyBtn.textContent = '复制链接';
                        copyBtn.style.background = '#3f3f46';
                    }, 1500);
                });
            };

            const allowBtn = document.createElement('button');
            allowBtn.textContent = '此次放行';
            Object.assign(allowBtn.style, btnStyle, {
                background: '#2563eb',
                color: '#fff'
            });
            allowBtn.onclick = () => {
                bypassedUrl = url;
                card.remove();
                window.location.href = url;
            };

            actions.appendChild(copyBtn);
            actions.appendChild(allowBtn);

            card.appendChild(header);
            card.appendChild(urlBox);
            card.appendChild(actions);
            shadow.appendChild(card);

            // 8 秒后自动淡出消失（鼠标悬停时暂停计时）
            let timer = setTimeout(() => fadeOut(), 8000);
            const fadeOut = () => {
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 250);
            };
            card.onmouseenter = () => clearTimeout(timer);
            card.onmouseleave = () => {
                timer = setTimeout(() => fadeOut(), 3000);
            };
        };

        if (document.body || document.documentElement) {
            render();
        } else {
            window.addEventListener('DOMContentLoaded', render, { once: true });
        }
    }

    // 1. 拦截现代 Chrome Navigation API（覆盖 location.href / assign / replace）
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('navigate', function (e) {
            if (e.destination && isExternalProtocol(e.destination.url)) {
                if (e.cancelable) {
                    e.preventDefault();
                }
                showBlockedToast(e.destination.url, 'Navigation');
            }
        }, true);
    }

    // 2. 拦截所有 <a> 标签点击与虚拟 .click()
    document.addEventListener('click', function (e) {
        const anchor = e.target.closest ? e.target.closest('a') : null;
        const href = anchor ? (anchor.getAttribute('href') || anchor.href) : null;
        if (href && isExternalProtocol(href)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            showBlockedToast(href, '<a> 点击');
        }
    }, true);

    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        const href = this.getAttribute('href') || this.href;
        if (href && isExternalProtocol(href)) {
            showBlockedToast(href, 'a.click()');
            return;
        }
        return origAnchorClick.apply(this, arguments);
    };

    // 3. 拦截 window.open
    const rawOpen = window.open;
    window.open = function (url, ...args) {
        if (isExternalProtocol(url)) {
            showBlockedToast(url, 'window.open');
            return null;
        }
        return rawOpen.apply(this, [url, ...args]);
    };

    // 4. 拦截隐藏 <iframe> 静默唤端
    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        if (this.tagName === 'IFRAME' && name.toLowerCase() === 'src' && isExternalProtocol(value)) {
            showBlockedToast(value, 'iframe');
            return;
        }
        return origSetAttribute.apply(this, arguments);
    };

    const iframeSrcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (iframeSrcDesc && iframeSrcDesc.set) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
            set: function (value) {
                if (isExternalProtocol(value)) {
                    showBlockedToast(value, 'iframe.src');
                    return;
                }
                return iframeSrcDesc.set.call(this, value);
            },
            get: iframeSrcDesc.get
        });
    }
})();