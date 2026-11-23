// 移植自 script.js（隔离 world）：OAuth 回调回传、Gmail 镜像、OAuth 中继发起
(function () {
    'use strict';

    const BRIDGE_PREFIX = '__TM_BRIDGE__';
    let CFG = { blockProtocol: true, server: '', apiKey: '' };
    const SERVER_BASE_GET = () => (CFG.server || '').trim().replace(/\/+$/, '');

    // 通过后台发起请求（携带 API Key，绕开 CORS / 页面 CSP）
    function api(path, obj) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ type: 'http', method: 'POST', path, body: JSON.stringify(obj) }, (res) => {
                    if (chrome.runtime.lastError || !res) return resolve({ ok: false, status: 0, error: String(chrome.runtime.lastError && chrome.runtime.lastError.message) });
                    resolve(res);
                });
            } catch (e) { resolve({ ok: false, status: 0, error: String(e) }); }
        });
    }

    function copyText(text) {
        navigator.clipboard.writeText(text).catch(() => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;opacity:0;';
                document.documentElement.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            } catch (e) {}
        });
    }

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
            if (cont && cont.includes(BRIDGE_PREFIX)) return 'IN_CONTINUE';
        } catch (e) {}
        return null;
    }

    function onDomReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
        else fn();
    }

    // ---- 配置下发给 MAIN world（协议拦截开关） ----
    function pushConfig() {
        document.dispatchEvent(new CustomEvent('tmx-config', { detail: JSON.stringify({ blockProtocol: !!CFG.blockProtocol }) }));
    }
    chrome.storage.local.get({ blockProtocol: true, server: '', apiKey: '' }).then((c) => {
        CFG = c;
        pushConfig();
    });
    chrome.storage.onChanged.addListener((changes) => {
        for (const k in changes) CFG[k] = changes[k].newValue;
        pushConfig();
    });

    // =====================================================================
    // 模块 A：主力端截获 Google OAuth 回调并回传
    // =====================================================================
    if (location.hostname !== 'accounts.google.com') {
        const incomingCode = extractBridgeCode();
        if (incomingCode && incomingCode !== 'IN_CONTINUE') {
            window.stop();
            const fullCallbackUrl = location.href;

            const showToast = (txt, color = '#4ade80') => {
                onDomReady(() => {
                    const div = document.createElement('div');
                    Object.assign(div.style, {
                        position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                        zIndex: '2147483647', background: '#18181b', color: color,
                        padding: '14px 20px', borderRadius: '8px', fontSize: '14px',
                        border: '1px solid #3f3f46', fontFamily: 'system-ui, sans-serif'
                    });
                    div.textContent = txt;
                    (document.body || document.documentElement).appendChild(div);
                });
            };

            showToast('✅ Google 授权已截获，正在回传至中继网关...');
            api('/oauth/callback', { code: incomingCode, callback_url: fullCallbackUrl }).then((res) => {
                if (res.status === 200) chrome.runtime.sendMessage({ type: 'closeTab' });
                else if (res.status) showToast(`❌ 回传失败 (${res.status}): ${res.text}`, '#f87171');
                else showToast(`❌ ${res.error || '无法连接公网中继网关'}`, '#f87171');
            });
            return;
        }
    }

    // =====================================================================
    // 模块 B：Gmail 防限流串行预取 + 优先插队
    // =====================================================================
    if (location.hostname === 'mail.google.com' && location.pathname.startsWith('/mail/')) {
        if (window.top !== window) return;

        let activeMailCode = '';
        let syncTimer = null;
        let ssePort = null;
        let pingTimer = null;
        const prefetchedIds = new Set();
        const fetchQueue = [];
        let workerRunning = false;

        const getGmailIK = () => {
            try {
                document.documentElement.removeAttribute('data-tmx-ik');
                document.dispatchEvent(new CustomEvent('tmx-get-ik'));
                const fromMain = document.documentElement.getAttribute('data-tmx-ik');
                if (fromMain) return fromMain;
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
        const postToGateway = async (payloadObj) => {
            if (!activeMailCode) return;
            const t0 = performance.now();
            const res = await api('/mail/push', payloadObj);
            if (payloadObj.fetched_id) {
                console.log(`[Gmail Mirror 网关推送] ID=${payloadObj.fetched_id} | 状态=${res.status} | 耗时=${(performance.now() - t0).toFixed(0)}ms`);
            }
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
            stopSSE();
            ssePort = chrome.runtime.connect({ name: 'mail-sse' });
            ssePort.postMessage({ type: 'start', code });
            ssePort.onMessage.addListener((m) => {
                if (m.event === 'ready') {
                    console.log('[Gmail Mirror SSE] 主力端长连接已就绪');
                } else if (m.event === 'fetch') {
                    const targetId = (m.data || '').trim();
                    console.log('[Gmail Mirror SSE] 收到副端点击指令, 优先插队拉取:', targetId);
                    if (targetId) enqueueFetch(targetId, true);
                }
            });
            // 定时心跳，避免后台 service worker 空闲被回收
            pingTimer = setInterval(() => { try { ssePort.postMessage({ type: 'ping' }); } catch (e) {} }, 20000);
        };

        const stopSSE = () => {
            if (pingTimer) clearInterval(pingTimer);
            pingTimer = null;
            if (ssePort) { try { ssePort.disconnect(); } catch (e) {} }
            ssePort = null;
        };

        const stopMirrorSession = () => {
            if (syncTimer) clearInterval(syncTimer);
            syncTimer = null;
            stopSSE();
            fetchQueue.length = 0;
            prefetchedIds.clear();
            if (activeMailCode) {
                const oldCode = activeMailCode;
                activeMailCode = '';
                api('/mail/push', { code: oldCode, close: true });
            }
        };

        window.addEventListener('beforeunload', stopMirrorSession);

        onDomReady(() => {
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
                    if (!SERVER_BASE_GET() || !CFG.apiKey) {
                        statusLabel.textContent = '⚠️ 请先在扩展设置页配置服务器与 API Key';
                        return;
                    }
                    activeMailCode = genCode(12);
                    copyText(`${SERVER_BASE_GET()}/mail/${activeMailCode}`);

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
        });

        return;
    }

    // =====================================================================
    // 模块 C：副浏览器端发起 OAuth 中继（钩子在 main-bridge.js）
    // =====================================================================
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

    let bridging = false;
    async function startRemoteBridge(rawUrl) {
        if (bridging) return;
        const server = SERVER_BASE_GET();
        if (!server || !CFG.apiKey) {
            alert('[OAuth Bridge] 请先在扩展设置页配置中转服务器与 API Key');
            return;
        }
        bridging = true;
        const code = genCode(10);
        const cleanOAuthUrl = buildCleanOAuthUrl(rawUrl, code);
        copyText(`${server}/go/${code}`);

        const res = await api('/oauth/create', { code: code, oauth_url: cleanOAuthUrl });
        if (res.status === 200) {
            window.location.replace(`${server}/wait/${code}`);
        } else if (res.status) {
            bridging = false;
            alert(`[OAuth Bridge] 网关注册失败 (${res.status}): ${res.text}`);
        } else {
            bridging = false;
            alert('[OAuth Bridge] 无法连接公网中继网关: ' + server);
        }
    }

    if (location.hostname === 'accounts.google.com' && isGoogleOAuthUrl(location.href)) {
        if (!extractBridgeCode(location.href)) {
            window.stop();
            // 等配置读取完成后再发起
            const go = () => startRemoteBridge(location.href);
            chrome.storage.local.get({ server: '', apiKey: '' }).then((c) => { CFG.server = c.server; CFG.apiKey = c.apiKey; go(); });
        }
        return;
    }

    // MAIN world 钩子触发的发起请求
    document.addEventListener('tmx-oauth-start', (e) => startRemoteBridge(e.detail));
})();
