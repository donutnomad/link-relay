const DEFAULTS = { blockProtocol: true, server: '', apiKey: '' };

async function getCfg() {
  const c = await chrome.storage.local.get(DEFAULTS);
  c.server = (c.server || '').trim().replace(/\/+$/, '');
  c.apiKey = (c.apiKey || '').trim();
  return c;
}

// 首次安装若尚未获得主机权限（Firefox），引导到设置页授予
chrome.runtime.onInstalled.addListener(async () => {
  try {
    if (!(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) chrome.runtime.openOptionsPage();
  } catch (e) {}
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'http') {
    (async () => {
      try {
        const c = await getCfg();
        if (!c.server || !c.apiKey) {
          return sendResponse({ ok: false, status: 0, error: '未配置中转服务器或 API Key，请在扩展设置页填写' });
        }
        const r = await fetch(c.server + msg.path, {
          method: msg.method || 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
          body: msg.body
        });
        sendResponse({ ok: r.ok, status: r.status, text: await r.text() });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: String(e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'closeTab' && sender.tab) {
    chrome.tabs.remove(sender.tab.id);
  }
});

// Gmail 镜像 SSE：在后台用 fetch 流式读取，通过 Port 转发给页面（绕开页面 CSP）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mail-sse') return;
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  port.onMessage.addListener((m) => {
    if (m.type === 'start') run(m.code);
  });

  async function run(code) {
    const c = await getCfg();
    if (!c.server || !c.apiKey) return;
    const url = `${c.server}/mail/events?code=${encodeURIComponent(code)}&token=${encodeURIComponent(c.apiKey)}`;
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            const data = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            try { port.postMessage({ event, data: data.join('\n') }); } catch (e) { return; }
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
});
