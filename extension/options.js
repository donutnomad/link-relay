const $ = (id) => document.getElementById(id);
const DEFAULTS = { blockProtocol: true, server: '', apiKey: '' };

chrome.storage.local.get(DEFAULTS).then((c) => {
  $('blockProtocol').checked = !!c.blockProtocol;
  $('server').value = c.server;
  $('apiKey').value = c.apiKey;
});

$('blockProtocol').addEventListener('change', () => {
  chrome.storage.local.set({ blockProtocol: $('blockProtocol').checked });
});

$('save').addEventListener('click', async () => {
  let server = $('server').value.trim().replace(/\/+$/, '');
  if (server && !/^https?:\/\//i.test(server)) server = 'https://' + server;
  $('server').value = server;
  await chrome.storage.local.set({
    blockProtocol: $('blockProtocol').checked,
    server,
    apiKey: $('apiKey').value.trim()
  });
  $('status').textContent = '已保存 ✓';
  setTimeout(() => ($('status').textContent = ''), 1500);
});

// 权限检查（Firefox 默认不授予主机权限）
const ALL = { origins: ['<all_urls>'] };
async function checkPerm() {
  try {
    const ok = await chrome.permissions.contains(ALL);
    $('permBox').style.display = ok ? 'none' : 'block';
  } catch (e) {}
}
$('grant').addEventListener('click', async () => {
  try { await chrome.permissions.request(ALL); } catch (e) {}
  checkPerm();
});
checkPerm();
