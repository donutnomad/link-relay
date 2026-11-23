// ==UserScript==
// @name         Link Relay
// @namespace    link-relay
// @version      8.4
// @description  拦截外部协议跳转；Google OAuth 跨浏览器中继；Gmail 镜像
// @icon         https://www.google.com/s2/favicons?sz=64&domain=google.com
// @updateURL    https://raw.githubusercontent.com/donutnomad/link-relay/main/link-relay.user.js
// @downloadURL  https://raw.githubusercontent.com/donutnomad/link-relay/main/link-relay.user.js
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        unsafeWindow
// @grant        window.close
// @connect      *
// ==/UserScript==

// ===== 模块一：外部协议拦截（可开关）=====
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

    // 用于临时放行用户手动点击“放行”的链接
    let bypassedUrl = null;
    // 防抖记录，避免某些流氓网页在死循环里疯狂触发同链接弹窗
    let lastShownUrl = '';
    let lastShownTime = 0;

    function isProtocolBlockEnabled() {
        try { return GM_getValue('protocolBlock', true) !== false; } catch (e) { return true; }
    }

    function isExternalProtocol(url) {
        if (!isProtocolBlockEnabled()) return false;
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
    if (unsafeWindow.navigation && typeof unsafeWindow.navigation.addEventListener === 'function') {
        unsafeWindow.navigation.addEventListener('navigate', function (e) {
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

    const origAnchorClick = unsafeWindow.HTMLAnchorElement.prototype.click;
    unsafeWindow.HTMLAnchorElement.prototype.click = function () {
        const href = this.getAttribute('href') || this.href;
        if (href && isExternalProtocol(href)) {
            showBlockedToast(href, 'a.click()');
            return;
        }
        return origAnchorClick.apply(this, arguments);
    };

    // 3. 拦截 window.open
    const rawOpen = unsafeWindow.open;
    unsafeWindow.open = function (url, ...args) {
        if (isExternalProtocol(url)) {
            showBlockedToast(url, 'window.open');
            return null;
        }
        return rawOpen.apply(this, [url, ...args]);
    };

    // 4. 拦截隐藏 <iframe> 静默唤端
    const origSetAttribute = unsafeWindow.Element.prototype.setAttribute;
    unsafeWindow.Element.prototype.setAttribute = function (name, value) {
        if (this.tagName === 'IFRAME' && name.toLowerCase() === 'src' && isExternalProtocol(value)) {
            showBlockedToast(value, 'iframe');
            return;
        }
        return origSetAttribute.apply(this, arguments);
    };

    const iframeSrcDesc = Object.getOwnPropertyDescriptor(unsafeWindow.HTMLIFrameElement.prototype, 'src');
    if (iframeSrcDesc && iframeSrcDesc.set) {
        Object.defineProperty(unsafeWindow.HTMLIFrameElement.prototype, 'src', {
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

    // 油猴菜单：开关 Protocol 拦截
    if (window.top === window && typeof GM_registerMenuCommand === 'function') {
        let menuId = null;
        const registerMenu = () => {
            if (menuId !== null && typeof GM_unregisterMenuCommand === 'function') {
                try { GM_unregisterMenuCommand(menuId); } catch (e) {}
            }
            const on = isProtocolBlockEnabled();
            menuId = GM_registerMenuCommand(
                on ? '🛡️ 外部协议拦截：已开启（点击关闭）' : '⚪ 外部协议拦截：已关闭（点击开启）',
                () => {
                    GM_setValue('protocolBlock', !isProtocolBlockEnabled());
                    registerMenu();
                    console.log('[Link Relay] 外部协议拦截 ' + (isProtocolBlockEnabled() ? '已开启' : '已关闭'));
                }
            );
        };
        registerMenu();
    }
})();

// ===== 模块二：OAuth 中继 / Gmail 镜像 =====
(function () {
    'use strict';

    // 中转服务器地址与 API Key：通过油猴菜单配置，保存在 GM 存储中（不写在脚本里）
    const getServer = () => String(GM_getValue('serverBase', '') || '').trim().replace(/\/+$/, '');
    const getKey = () => String(GM_getValue('apiKey', '') || '').trim();

    function ensureConfigured() {
        if (getServer() && getKey()) return true;
        alert('[Link Relay] 尚未配置中转服务器或 API Key。\n请点击油猴图标 → 本脚本菜单 → 打开设置面板。');
        return false;
    }

    // 设置面板：在当前页面弹出（Shadow DOM 隔离样式），可同时查看和修改所有配置
    function openSettingsPanel() {
        if (document.getElementById('tm-link-relay-settings')) return;
        const host = document.createElement('div');
        host.id = 'tm-link-relay-settings';
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
        const root = host.attachShadow({ mode: 'open' });
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        root.innerHTML = `
        <style>
          .mask{position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
          .box{background:#fff;color:#1e293b;width:min(440px,92vw);border-radius:12px;padding:20px 22px;box-shadow:0 20px 50px rgba(0,0,0,.35);font-size:14px}
          h2{margin:0 0 14px;font-size:17px}
          label{display:block;margin:12px 0 4px;font-size:13px;color:#475569}
          input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;color:#1e293b;background:#fff}
          .row{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px;color:#475569}
          .row.main{margin-top:14px;color:#1e293b;font-size:14px}
          .hint{font-size:12px;color:#94a3b8;margin-top:4px}
          .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
          button{border:0;border-radius:6px;padding:8px 18px;font-size:14px;cursor:pointer}
          .save{background:#2563eb;color:#fff}.cancel{background:#e2e8f0;color:#1e293b}
        </style>
        <div class="mask"><div class="box">
          <h2>Link Relay 设置</h2>
          <label>中转服务器地址</label>
          <input type="text" id="srv" placeholder="https://relay.example.com" value="${esc(getServer())}">
          <label>API Key</label>
          <input type="password" id="key" autocomplete="off" value="${esc(getKey())}">
          <div class="row"><input type="checkbox" id="show"><label for="show" style="margin:0">显示 API Key</label></div>
          <div class="row main"><input type="checkbox" id="blk" ${GM_getValue('protocolBlock', true) !== false ? 'checked' : ''}><label for="blk" style="margin:0;color:inherit;font-size:inherit">拦截外部协议跳转</label></div>
          <div class="hint">保存后立即生效，无需刷新页面（协议拦截开关在新触发的跳转上生效）。</div>
          <div class="actions"><button class="cancel" id="cancel">取消</button><button class="save" id="save">保存</button></div>
        </div></div>`;
        const $ = (id) => root.getElementById(id);
        const close = () => host.remove();
        $('show').onchange = () => { $('key').type = $('show').checked ? 'text' : 'password'; };
        $('cancel').onclick = close;
        root.querySelector('.mask').addEventListener('mousedown', (ev) => { if (ev.target.classList.contains('mask')) close(); });
        $('save').onclick = () => {
            let v = $('srv').value.trim().replace(/\/+$/, '');
            if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
            GM_setValue('serverBase', v);
            GM_setValue('apiKey', $('key').value.trim());
            GM_setValue('protocolBlock', $('blk').checked);
            close();
        };
        (document.body || document.documentElement).appendChild(host);
    }

    if (window.top === window && typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('⚙️ 打开设置面板', openSettingsPanel);
    }
    const BRIDGE_PREFIX = '__TM_BRIDGE__';

    function genCode(len = 12) {
        const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const arr = new Uint8Array(len);
        crypto.getRandomValues(arr);
        return Array.from(arr, x => chars[x % chars.length]).join('');
    }

    function extractBridgeCode(targetUrl = location.href) {
        const regex = new RegExp(`^${BRIDGE_PREFIX}([^:]+):`);
        try {
            const u = new URL(targetUrl);
            const queryState = u.searchParams.get('state');
            if (queryState) {
                const m = queryState.match(regex);
                if (m) return m[1];
            }
            if (u.hash && u.hash.length > 1) {
                const hashParams = new URLSearchParams(u.hash.slice(1));
                const hashState = hashParams.get('state');
                if (hashState) {
                    const m = hashState.match(regex);
                    if (m) return m[1];
                }
            }
            const cont = u.searchParams.get('continue');
            if (cont && cont.includes(BRIDGE_PREFIX)) {
                return 'IN_CONTINUE';
            }
        } catch (e) {}
        return null;
    }

    // =========================================================================
    // 模块 A：主力端截获 Google OAuth 回调并回传
    // =========================================================================
    if (location.hostname !== 'accounts.google.com') {
        const incomingCode = extractBridgeCode();
        if (incomingCode && incomingCode !== 'IN_CONTINUE') {
            window.stop();
            const fullCallbackUrl = location.href;

            const showToast = (txt, color = '#4ade80') => {
                const render = () => {
                    const div = document.createElement('div');
                    Object.assign(div.style, {
                        position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                        zIndex: '2147483647', background: '#18181b', color: color,
                        padding: '14px 20px', borderRadius: '8px', fontSize: '14px',
                        border: '1px solid #3f3f46', fontFamily: 'system-ui, sans-serif'
                    });
                    div.textContent = txt;
                    (document.body || document.documentElement).appendChild(div);
                };
                if (document.body || document.documentElement) render();
                else window.addEventListener('DOMContentLoaded', render, { once: true });
            };

            if (!getServer() || !getKey()) {
                showToast('❌ Link Relay 未配置中转服务器或 API Key，无法回传授权', '#f87171');
                return;
            }
            showToast('✅ Google 授权已截获，正在回传至中继网关...');

            GM_xmlhttpRequest({
                method: 'POST',
                url: `${getServer()}/oauth/callback`,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getKey()}`
                },
                data: JSON.stringify({
                    code: incomingCode,
                    callback_url: fullCallbackUrl
                }),
                onload: function (res) {
                    if (res.status === 200) window.close();
                    else showToast(`❌ 回传失败 (${res.status}): ${res.responseText}`, '#f87171');
                },
                onerror: function () {
                    showToast('❌ 无法连接公网中继网关', '#f87171');
                }
            });
            return;
        }
    }

  // =========================================================================
    // 模块 B：Gmail 防限流串行预取 + 优先插队 + 全链路耗时日志（v7.3）
    // =========================================================================
    if (location.hostname === 'mail.google.com' && location.pathname.startsWith('/mail/')) {
        let activeMailCode = '';
        let syncTimer = null;
        let hostEventSource = null;
        const prefetchedIds = new Set();
        const fetchQueue = [];
        let workerRunning = false;

        const getGmailIK = () => {
            try {
                if (unsafeWindow.GLOBALS && unsafeWindow.GLOBALS[9]) return unsafeWindow.GLOBALS[9];
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const txt = s.textContent || '';
                    const m = txt.match(/var GLOBALS=\[(?:[^,]*,){9}"([a-f0-9]+)"/i) || txt.match(/"ik"\s*:\s*"([a-f0-9]+)"/i);
                    if (m) return m[1];
                }
                const m2 = document.documentElement.innerHTML.match(/"ik"\s*:\s*"([a-f0-9]+)"/i);
                return m2 ? m2[1] : '';
            } catch (e) {
                return '';
            }
        };

        const scrapeInbox = () => {
            const rows = document.querySelectorAll('tr.zA');
            const list = [];
            rows.forEach((row, idx) => {
                let hexId = '';
                const attrsToTry = ['data-legacy-last-message-id', 'data-legacy-message-id', 'data-legacy-thread-id'];
                for (const attr of attrsToTry) {
                    const el = row.hasAttribute(attr) ? row : row.querySelector(`[${attr}]`);
                    if (el) {
                        const val = el.getAttribute(attr);
                        if (val && /^[0-9a-f]{16}$/i.test(val.trim())) {
                            hexId = val.trim();
                            break;
                        }
                    }
                }
                if (!hexId) {
                    const hexMatch = row.outerHTML.match(/data-legacy-[a-z-]+="([0-9a-f]{16})"/i);
                    if (hexMatch) hexId = hexMatch[1];
                }
                if (!hexId) hexId = row.getAttribute('id') || ('row_' + idx);

                const senderEl = row.querySelector('.yW span[email], .yW span');
                const subjectEl = row.querySelector('.y6 span');
                const snippetEl = row.querySelector('.y2');
                const timeEl = row.querySelector('.xW span');

                list.push({
                    id: hexId,
                    sender: senderEl ? (senderEl.getAttribute('name') || senderEl.textContent.trim()) : '未知发件人',
                    subject: subjectEl ? subjectEl.textContent.trim() : '(无主题)',
                    snippet: snippetEl ? snippetEl.textContent.replace(/^\s*-\s*/, '').trim() : '',
                    time: timeEl ? timeEl.textContent.trim() : '',
                    unread: row.classList.contains('zE')
                });
            });
            return list;
        };

        const scrapeEmail = () => {
            try {
                const el = document.querySelector('div.gb_gd');
                const match = (el && el.textContent || '').match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
                return match ? match[0] : '';
            } catch (e) {
                return '';
            }
        };

        const decodeHTMLEntities = (str) => {
            return str
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
        };

        const escapeHTMLStr = (str) => {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        };

        const decodeQuotedPrintable = (str, charset = 'utf-8') => {
            const cleaned = str.replace(/=\r?\n/g, '');
            const bytes = [];
            for (let i = 0; i < cleaned.length; i++) {
                if (cleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
                    bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
                    i += 2;
                } else {
                    bytes.push(cleaned.charCodeAt(i));
                }
            }
            try { return new TextDecoder(charset).decode(new Uint8Array(bytes)); }
            catch (e) { return new TextDecoder('utf-8').decode(new Uint8Array(bytes)); }
        };

        const decodeBase64Body = (str, charset = 'utf-8') => {
            try {
                const cleanB64 = str.replace(/\s+/g, '');
                const validLen = cleanB64.length - (cleanB64.length % 4);
                const binary = atob(cleanB64.slice(0, validLen));
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                try { return new TextDecoder(charset).decode(bytes); }
                catch (e) { return new TextDecoder('utf-8').decode(bytes); }
            } catch (e) {
                return '';
            }
        };

        const decodeMimeWords = (value) => {
            if (!value) return '';
            return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset, encoding, data) => {
                try {
                    if (encoding.toLowerCase() === 'b') {
                        const binary = atob(data);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                        return new TextDecoder(charset).decode(bytes);
                    }
                    const q = data.replace(/_/g, ' ');
                    return q.replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
                } catch (e) {
                    return data;
                }
            }).replace(/\s+/g, ' ').trim();
        };

        const extractHeaders = (rawEML) => {
            const splitIdx = rawEML.search(/\r?\n\r?\n/);
            const headerBlock = splitIdx === -1 ? rawEML : rawEML.slice(0, splitIdx);
            const map = {};
            let currentKey = '';
            headerBlock.split(/\r?\n/).forEach((line) => {
                if (/^[ \t]/.test(line)) {
                    if (currentKey) map[currentKey] = (map[currentKey] || '') + ' ' + line.trim();
                } else {
                    const m = line.match(/^([^\s:]+):\s*(.*)$/);
                    if (m) {
                        currentKey = m[1].toLowerCase();
                        map[currentKey] = m[2].trim();
                    }
                }
            });

            const domainOf = (value) => {
                if (!value) return '';
                const m = value.match(/@([^\s@>]+)>?\s*$/);
                return m ? m[1] : '';
            };
            const dkim = map['dkim-signature'] || '';
            const listId = (map['list-id'] || '').replace(/[<>]/g, '').trim();

            return {
                from: decodeMimeWords(map['from'] || ''),
                reply_to: decodeMimeWords(map['reply-to'] || ''),
                to: decodeMimeWords(map['to'] || ''),
                cc: decodeMimeWords(map['cc'] || ''),
                date: decodeMimeWords(map['date'] || ''),
                subject: decodeMimeWords(map['subject'] || ''),
                mailing_list: decodeMimeWords(listId),
                mailed_by: domainOf(map['return-path']) || domainOf(map['received']) || '',
                signed_by: (dkim.match(/\bd\s*=\s*([^;\s]+)/i) || [])[1] || '',
                security: 'Standard encryption (TLS)'
            };
        };

        const extractMimeContent = (rawPart) => {
            const splitIdx = rawPart.search(/\r?\n\r?\n/);
            if (splitIdx === -1) return { html: '', text: rawPart };

            const headerBlock = rawPart.slice(0, splitIdx).replace(/\r?\n[ \t]+/g, ' ');
            const bodyBlock = rawPart.slice(splitIdx).replace(/^\r?\n\r?\n/, '');

            const ctMatch = headerBlock.match(/^Content-Type:\s*([^\r\n]+)/im);
            const cteMatch = headerBlock.match(/^Content-Transfer-Encoding:\s*([^\r\n]+)/im);
            const contentType = ctMatch ? ctMatch[1] : 'text/plain; charset=utf-8';
            const encoding = cteMatch ? cteMatch[1].trim().toLowerCase() : '';

            const charsetMatch = contentType.match(/charset=["']?([^"';\s]+)/i);
            const charset = charsetMatch ? charsetMatch[1] : 'utf-8';

            if (/multipart\//i.test(contentType)) {
                const boundaryMatch = contentType.match(/boundary=["']?([^"';\r\n]+)/i);
                if (!boundaryMatch) return { html: '', text: '' };
                const boundary = boundaryMatch[1];
                const parts = bodyBlock.split('--' + boundary);
                let result = { html: '', text: '' };

                for (const part of parts) {
                    const trimmed = part.trim();
                    if (!trimmed || trimmed === '--') continue;
                    const sub = extractMimeContent(part.replace(/^\r?\n/, ''));
                    if (sub.html && !result.html) result.html = sub.html;
                    if (sub.text && !result.text) result.text = sub.text;
                    if (result.html) break;
                }
                return result;
            }

            let decoded = bodyBlock;
            if (encoding === 'base64') decoded = decodeBase64Body(bodyBlock, charset);
            else if (encoding === 'quoted-printable') decoded = decodeQuotedPrintable(bodyBlock, charset);

            if (/text\/html/i.test(contentType)) return { html: decoded, text: '' };
            if (/text\/plain/i.test(contentType)) return { html: '', text: decoded };
            return { html: '', text: '' };
        };

        const parseAndSanitizeEML = (rawEML) => {
            const { html, text } = extractMimeContent(rawEML);
            const baseStyle = '<base target="_blank"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6;color:#1e293b;margin:16px;word-break:break-word;}a{color:#2563eb;text-decoration:underline;}</style>';

            if (html) {
                const safeHtml = html
                    .replace(/<(script|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
                    .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, '')
                    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
                    .replace(/<img\b([^>]*)>/gi, (match, attrs) => {
                        const altMatch = attrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
                        const altText = (altMatch && (altMatch[1] || altMatch[2])) || '已拦截外部图片';
                        return `<span style="display:inline-block;padding:2px 6px;margin:2px;background:#f1f5f9;border:1px dashed #94a3b8;border-radius:4px;color:#475569;font-size:11px;">🛡️ [${escapeHTMLStr(altText)}]</span>`;
                    })
                    .replace(/url\s*\(\s*['"]?https?:\/\/[^)]*\)/gi, 'none')
                    .replace(/href="https:\/\/www\.google\.com\/url\?[^"]*?\bq=([^&"]+)[^"]*"/gi, (m, encodedUrl) => {
                        try { return `href="${decodeURIComponent(encodedUrl)}"`; } catch (e) { return m; }
                    });
                return baseStyle + safeHtml;
            }

            if (text) {
                const escaped = escapeHTMLStr(text);
                const linked = escaped.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
                return baseStyle + `<div style="white-space:pre-wrap;">${linked}</div>`;
            }

            return baseStyle + '<p>（无法提取邮件正文）</p>';
        };

        const fetchCleanMailHTML = async (hexId) => {
            const t0 = performance.now();
            const ik = getGmailIK();
            if (!ik) throw new Error('未能提取到 Gmail 会话参数 ik');
            const basePathMatch = location.pathname.match(/^\/mail\/u\/\d+\//);
            const basePath = basePathMatch ? basePathMatch[0] : '/mail/u/0/';
            const omUrl = `${location.origin}${basePath}?ik=${encodeURIComponent(ik)}&view=om&th=${encodeURIComponent(hexId)}`;

            const res = await fetch(omUrl, { credentials: 'include' });
            const t1 = performance.now();
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const reader = res.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let rawText = '';
            const MAX_BYTES = 96 * 1024;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                rawText += decoder.decode(value, { stream: true });
                if (rawText.length >= MAX_BYTES || /<\/pre>/i.test(rawText)) {
                    reader.cancel().catch(() => {});
                    break;
                }
            }
            const t2 = performance.now();

            if (/^\s*<(?:!DOCTYPE|html)/i.test(rawText)) {
                const preMatch = rawText.match(/<pre\b[^>]*>([\s\S]*?)(?:<\/pre>|$)/i);
                if (preMatch && preMatch[1]) {
                    rawText = decodeHTMLEntities(preMatch[1]);
                }
            }
            const parsed = parseAndSanitizeEML(rawText);
            const headers = extractHeaders(rawText);
            const t3 = performance.now();
            console.log(`[Gmail Mirror 耗时] ID=${hexId} | Google响应=${(t1 - t0).toFixed(0)}ms | 流读取=${(t2 - t1).toFixed(0)}ms | 正则解析=${(t3 - t2).toFixed(0)}ms | 字节=${rawText.length}`);
            return { html: parsed, headers: headers };
        };

        const postToGateway = (payloadObj) => {
            return new Promise((resolve) => {
                if (!activeMailCode) return resolve();
                const t0 = performance.now();
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${getServer()}/mail/push`,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${getKey()}`
                    },
                    data: JSON.stringify(payloadObj),
                    onload: (res) => {
                        if (payloadObj.fetched_id) {
                            console.log(`[Gmail Mirror 网关推送] ID=${payloadObj.fetched_id} | 状态=${res.status} | 耗时=${(performance.now() - t0).toFixed(0)}ms`);
                        }
                        resolve();
                    },
                    onerror: () => resolve()
                });
            });
        };

        // 串行队列处理器：一次只拉 1 封避免 Google 并发限速，支持用户点击高优先级插队
        const enqueueFetch = (hexId, highPriority = false) => {
            if (!hexId || !activeMailCode) return;
            if (!highPriority && prefetchedIds.has(hexId)) return;

            const existingIdx = fetchQueue.indexOf(hexId);
            if (existingIdx !== -1) {
                if (highPriority && existingIdx > 0) {
                    fetchQueue.splice(existingIdx, 1);
                    fetchQueue.unshift(hexId);
                }
                return;
            }

            if (highPriority) {
                fetchQueue.unshift(hexId);
            } else {
                fetchQueue.push(hexId);
            }
            processQueue();
        };

        const processQueue = async () => {
            if (workerRunning || fetchQueue.length === 0 || !activeMailCode) return;
            workerRunning = true;

            while (fetchQueue.length > 0 && activeMailCode) {
                const targetId = fetchQueue.shift();
                try {
                    const fetched = await fetchCleanMailHTML(targetId);
                    prefetchedIds.add(targetId);
                    await postToGateway({
                        code: activeMailCode,
                        fetched_id: targetId,
                        clean_html: fetched.html,
                        headers: fetched.headers,
                        email: scrapeEmail()
                    });
                } catch (err) {
                    await postToGateway({
                        code: activeMailCode,
                        fetched_id: targetId,
                        clean_html: `<div style="font-family:sans-serif;color:#dc2626;padding:20px;">❌ 邮件解析失败: ${escapeHTMLStr(String(err))}</div>`
                    });
                }
                // 队列中还有预取任务时稍微让出 250ms，避免触发 Google 频控
                if (fetchQueue.length > 0) {
                    await new Promise(r => setTimeout(r, 250));
                }
            }
            workerRunning = false;
        };

        const syncInboxAndPrefetch = () => {
            if (!activeMailCode) return;
            const inbox = scrapeInbox();
            if (inbox.length > 0) {
                postToGateway({ code: activeMailCode, inbox: inbox, email: scrapeEmail() });
                // 仅串行预取顶部前 3 封，避免并发轰炸
                inbox.slice(0, 3).forEach(m => {
                    if (/^[0-9a-f]{16}$/i.test(m.id)) {
                        enqueueFetch(m.id, false);
                    }
                });
            }
        };

        const startHostSSE = (code) => {
            if (hostEventSource) hostEventSource.close();
            const sseUrl = `${getServer()}/mail/events?code=${encodeURIComponent(code)}&token=${encodeURIComponent(getKey())}`;
            hostEventSource = new EventSource(sseUrl);

            hostEventSource.addEventListener('ready', () => {
                console.log('[Gmail Mirror SSE] 主力端长连接已就绪');
            });

            hostEventSource.addEventListener('fetch', (e) => {
                const targetId = (e.data || '').trim();
                console.log('[Gmail Mirror SSE] 收到副端点击指令, 优先插队拉取:', targetId);
                if (targetId) enqueueFetch(targetId, true);
            });

            hostEventSource.onerror = (err) => {
                console.warn('[Gmail Mirror SSE] 连接波动重连中...', err);
            };
        };

        const stopMirrorSession = () => {
            if (syncTimer) clearInterval(syncTimer);
            syncTimer = null;
            if (hostEventSource) hostEventSource.close();
            hostEventSource = null;
            fetchQueue.length = 0;
            prefetchedIds.clear();
            if (activeMailCode) {
                const oldCode = activeMailCode;
                activeMailCode = '';
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${getServer()}/mail/push`,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${getKey()}`
                    },
                    data: JSON.stringify({ code: oldCode, close: true })
                });
            }
        };

        window.addEventListener('beforeunload', stopMirrorSession);

        window.addEventListener('DOMContentLoaded', () => {
            const widget = document.createElement('div');
            Object.assign(widget.style, {
                position: 'fixed', bottom: '16px', right: '20px', zIndex: '999999',
                background: '#18181b', color: '#f4f4f5', border: '1px solid #3f3f46',
                borderRadius: '10px', padding: '10px 14px', fontSize: '12px',
                fontFamily: 'system-ui, sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                display: 'flex', alignItems: 'center', gap: '10px'
            });

            const statusLabel = document.createElement('span');
            statusLabel.textContent = '🛡️ 镜像未开启';

            const toggleBtn = document.createElement('button');
            toggleBtn.textContent = '生成配对短链';
            Object.assign(toggleBtn.style, {
                background: '#2563eb', color: '#fff', border: 'none',
                borderRadius: '6px', padding: '5px 10px', cursor: 'pointer', fontWeight: '500'
            });

            toggleBtn.onclick = () => {
                if (!activeMailCode) {
                    if (!ensureConfigured()) return;
                    activeMailCode = genCode(12);
                    const mirrorUrl = `${getServer()}/mail/${activeMailCode}`;
                    try { GM_setClipboard(mirrorUrl); } catch (e) {}
                    navigator.clipboard.writeText(mirrorUrl).catch(() => {});

                    statusLabel.textContent = `⚡ 实时共享中: ${activeMailCode}`;
                    toggleBtn.textContent = '停止并销毁';
                    toggleBtn.style.background = '#dc2626';

                    startHostSSE(activeMailCode);
                    syncInboxAndPrefetch();
                    syncTimer = setInterval(syncInboxAndPrefetch, 4000);
                } else {
                    stopMirrorSession();
                    statusLabel.textContent = '🛡️ 镜像已关闭销毁';
                    toggleBtn.textContent = '生成配对短链';
                    toggleBtn.style.background = '#2563eb';
                }
            };

            widget.appendChild(statusLabel);
            widget.appendChild(toggleBtn);
            document.body.appendChild(widget);
        }, { once: true });

        return;
    }
    // =========================================================================
    // 模块 C：副浏览器端拦截 Google 第三方 OAuth 登录
    // =========================================================================
    function isGoogleOAuthUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url, location.href);
            if (u.hostname !== 'accounts.google.com') return false;
            const path = u.pathname;
            const hasOAuthPath =
                path.includes('/o/oauth2') ||
                path.includes('/gsi/') ||
                path.includes('/signin/oauth') ||
                path.includes('/v3/signin');
            const hasOAuthParams =
                u.searchParams.has('client_id') ||
                u.searchParams.get('flowName') === 'GeneralOAuthFlow' ||
                (u.searchParams.get('continue') || '').includes('oauth');
            return hasOAuthPath && hasOAuthParams;
        } catch (e) {
            return false;
        }
    }

    function buildCleanOAuthUrl(rawUrl, code) {
        const u = new URL(rawUrl, location.href);
        const mergedParams = new URLSearchParams(u.search);
        const cont = u.searchParams.get('continue');
        if (cont) {
            try {
                const contUrl = new URL(cont);
                for (const [k, v] of contUrl.searchParams.entries()) {
                    if (!mergedParams.has(k)) mergedParams.set(k, v);
                }
            } catch (e) {}
        }

        const ALLOWED_OAUTH_KEYS = [
            'client_id', 'redirect_uri', 'response_type', 'scope', 'state',
            'code_challenge', 'code_challenge_method', 'access_type', 'prompt',
            'include_granted_scopes', 'login_hint', 'hd', 'nonce'
        ];

        const cleanUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        for (const key of ALLOWED_OAUTH_KEYS) {
            if (mergedParams.has(key)) {
                cleanUrl.searchParams.set(key, mergedParams.get(key));
            }
        }
        if (!cleanUrl.searchParams.has('response_type')) cleanUrl.searchParams.set('response_type', 'code');
        if (!cleanUrl.searchParams.has('prompt')) cleanUrl.searchParams.set('prompt', 'select_account');
        if (!cleanUrl.searchParams.has('redirect_uri')) {
            cleanUrl.searchParams.set('redirect_uri', location.origin + location.pathname);
        }

        const origState = cleanUrl.searchParams.get('state') || '';
        cleanUrl.searchParams.set('state', `${BRIDGE_PREFIX}${code}:${origState}`);
        return cleanUrl.toString();
    }

    function startRemoteBridge(rawUrl) {
        if (!ensureConfigured()) return;
        const code = genCode(10);
        const cleanOAuthUrl = buildCleanOAuthUrl(rawUrl, code);
        const shortLink = `${getServer()}/go/${code}`;

        try { GM_setClipboard(shortLink); } catch (e) {}

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${getServer()}/oauth/create`,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getKey()}`
            },
            data: JSON.stringify({
                code: code,
                oauth_url: cleanOAuthUrl
            }),
            onload: function (res) {
                if (res.status === 200) {
                    window.location.replace(`${getServer()}/wait/${code}`);
                } else {
                    alert(`[OAuth Bridge] 网关注册失败 (${res.status}): ${res.responseText}`);
                }
            },
            onerror: function () {
                alert('[OAuth Bridge] 无法连接公网中继网关: ' + getServer());
            }
        });
    }

    if (location.hostname === 'accounts.google.com' && isGoogleOAuthUrl(location.href)) {
        if (!extractBridgeCode(location.href)) {
            if (!getServer() || !getKey()) return; // 未配置时不接管，保持正常登录
            window.stop();
            startRemoteBridge(location.href);
            return;
        }
        return;
    }

    const rawOpen = unsafeWindow.open;
    unsafeWindow.open = function (url, ...args) {
        if (isGoogleOAuthUrl(url)) {
            startRemoteBridge(url);
            return { closed: false, close: () => {}, focus: () => {} };
        }
        return rawOpen.apply(this, [url, ...args]);
    };

    if (unsafeWindow.navigation && typeof unsafeWindow.navigation.addEventListener === 'function') {
        unsafeWindow.navigation.addEventListener('navigate', function (e) {
            if (e.destination && isGoogleOAuthUrl(e.destination.url)) {
                if (e.cancelable) e.preventDefault();
                startRemoteBridge(e.destination.url);
            }
        }, true);
    }

    document.addEventListener('click', function (e) {
        const anchor = e.target.closest ? e.target.closest('a') : null;
        if (anchor && anchor.href && isGoogleOAuthUrl(anchor.href)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            startRemoteBridge(anchor.href);
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
