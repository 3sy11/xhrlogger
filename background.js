// XHR Logger - Background Service Worker
let logs = [];
let isPaused = false;
let logIdCounter = 0;
let lastFlushedLogId = 0;
let dashboardFlushPort = null;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
console.log('[Background] XHR Logger started');

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'log-flush') return;
  dashboardFlushPort = port;
  port.onDisconnect.addListener(() => { dashboardFlushPort = null; chrome.storage.local.set({ silentFlushActive: false }); });
});

// ==================== 一级域名 ====================
function getPrimaryDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host.startsWith('127.')) return host;
    const parts = host.split('.');
    if (parts.length >= 2) return parts.slice(-2).join('.');
    return host;
  } catch { return 'unknown'; }
}

// ==================== 日志落盘配置 ====================
const LOG_STORAGE_CONFIG_DEFAULTS = { defaultPath: 'xhr-logs', domainEnabled: {}, logFlushEnabled: false };
async function getLogStorageConfig() {
  const { logStorageConfig } = await chrome.storage.local.get('logStorageConfig');
  return Object.assign({}, LOG_STORAGE_CONFIG_DEFAULTS, logStorageConfig || {}, { domainEnabled: Object.assign({}, (logStorageConfig || {}).domainEnabled) });
}

async function saveLogStorageConfig(config) {
  await chrome.storage.local.set({ logStorageConfig: config });
}

async function setDomainLogEnabled(domain, enabled) {
  const config = await getLogStorageConfig();
  config.domainEnabled = config.domainEnabled || {};
  config.domainEnabled[domain] = enabled;
  await saveLogStorageConfig(config);
  return { success: true };
}

function getLogsSinceLastFlush() {
  const out = logs.filter(l => l.id > lastFlushedLogId);
  const maxId = out.length ? Math.max(...out.map(l => l.id)) : lastFlushedLogId;
  return { logs: out, maxId };
}

async function exportLogsToFiles() {
  const config = await getLogStorageConfig();
  const basePath = (config.defaultPath || 'xhr-logs').replace(/\/+$/, '').replace(/^\/+/, '') || 'xhr-logs';
  const domainEnabled = config.domainEnabled || {};
  const byDomain = {};
  for (const log of logs) {
    const domain = getPrimaryDomain(log.url);
    if (domainEnabled[domain] === false) continue;
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(log);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let done = 0;
  for (const [domain, domainLogs] of Object.entries(byDomain)) {
    if (domainLogs.length === 0) continue;
    const sorted = domainLogs.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const safeDomain = domain.replace(/[^a-z0-9.-]/gi, '_');
    const content = JSON.stringify({ domain, exportedAt: new Date().toISOString(), logs: sorted }, null, 2);
    const base64 = btoa(unescape(encodeURIComponent(content)));
    await chrome.downloads.download({ url: `data:application/json;base64,${base64}`, filename: `${basePath}/${safeDomain}-${ts}.json`, saveAs: false });
    done++;
  }
  return { success: true, count: done };
}

// ==================== 订阅管理 ====================
const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
const generateLogId = () => ++logIdCounter;

async function getSubscriptions() {
  const { subscriptions = [] } = await chrome.storage.local.get('subscriptions');
  return subscriptions;
}

async function saveSubscriptions(subscriptions) {
  await chrome.storage.local.set({ subscriptions });
}

async function addSubscription(sub) {
  const subs = await getSubscriptions();
  const newSub = { id: generateId(), ...sub, enabled: true, reportEnabled: true, createdAt: Date.now() };
  subs.push(newSub);
  await saveSubscriptions(subs);
  return { success: true, subscription: newSub };
}

async function updateSubscription(id, updates) {
  const subs = await getSubscriptions();
  const idx = subs.findIndex(s => s.id === id);
  if (idx === -1) return { success: false, message: '订阅不存在' };
  subs[idx] = { ...subs[idx], ...updates };
  await saveSubscriptions(subs);
  return { success: true, subscription: subs[idx] };
}

async function deleteSubscription(id) {
  const subs = await getSubscriptions();
  const filtered = subs.filter(s => s.id !== id);
  if (filtered.length === subs.length) return { success: false, message: '订阅不存在' };
  await saveSubscriptions(filtered);
  return { success: true };
}

async function toggleSubscription(id) {
  const subs = await getSubscriptions();
  const sub = subs.find(s => s.id === id);
  if (!sub) return { success: false, message: '订阅不存在' };
  sub.enabled = !sub.enabled;
  await saveSubscriptions(subs);
  return { success: true, enabled: sub.enabled };
}

// ==================== 订阅匹配 ====================
function matchPattern(value, pattern, isRegex) {
  if (!pattern) return true;
  if (isRegex) {
    try { return new RegExp(pattern).test(value); } catch { return false; }
  }
  return value === pattern || value.includes(pattern);
}

function matchSubscription(sub, url, method) {
  if (!sub.enabled) return false;
  try {
    const urlObj = new URL(url);
    const urlPath = urlObj.origin + urlObj.pathname;
    const urlQuery = urlObj.search ? urlObj.search.slice(1) : '';
    const isRegex = sub.matchMode === 'regex';
    // 匹配 URL 路径
    if (!matchPattern(urlPath, sub.urlPattern, isRegex)) return false;
    // 匹配查询参数（如果设置了）
    if (sub.queryPattern && !matchPattern(urlQuery, sub.queryPattern, isRegex)) return false;
    // 匹配请求方法（仅 API 订阅）
    if (sub.type === 'api' && sub.method && sub.method !== method) return false;
    return true;
  } catch { return false; }
}

async function checkApiSubscription(logData) {
  const subs = await getSubscriptions();
  const apiSubs = subs.filter(s => s.type === 'api' && s.enabled);
  for (const sub of apiSubs) {
    if (matchSubscription(sub, logData.url, logData.method)) {
      console.log(`[Background] 📌 API 订阅命中: ${sub.name}`);
      // 更新订阅的最后命中信息
      sub.lastSourcePageUrl = logData.tabUrl;
      sub.lastMatchedUrl = logData.url;
      sub.lastMatchedAt = new Date().toISOString();
      await saveSubscriptions(subs);
      // 检查上报开关
      if (sub.reportEnabled !== false) {
        await saveApiLog(logData, sub);
      } else {
        console.log(`[Background] ⏭️  订阅「${sub.name}」上报已关闭，跳过上报`);
      }
      return true;
    }
  }
  return false;
}

async function checkPageSubscription(pageUrl, updateMatch = false) {
  const subs = await getSubscriptions();
  const pageSubs = subs.filter(s => s.type === 'page' && s.enabled);
  for (const sub of pageSubs) {
    if (matchSubscription(sub, pageUrl, '')) {
      console.log(`[Background] 📌 页面订阅命中: ${sub.name}`);
      if (updateMatch) {
        sub.lastMatchedUrl = pageUrl;
        sub.lastMatchedAt = new Date().toISOString();
        await saveSubscriptions(subs);
      }
      // 检查上报开关
      if (sub.reportEnabled === false) {
        console.log(`[Background] ⏭️  订阅「${sub.name}」上报已关闭，跳过上报`);
        return null;
      }
      return sub;
    }
  }
  return null;
}

// ==================== 配置管理 ====================
const COLLECTOR_CONFIG_DEFAULTS = { endpoint: 'https://localhost:8443/collect', enabled: true };
async function getCollectorConfig() {
  const { collectorConfig } = await chrome.storage.local.get('collectorConfig');
  return Object.assign({}, COLLECTOR_CONFIG_DEFAULTS, collectorConfig || {});
}

async function saveCollectorConfig(config) {
  await chrome.storage.local.set({ collectorConfig: config });
}

// ==================== 自动上报 ====================
async function reportToCollector(data) {
  const config = await getCollectorConfig();
  if (!config.enabled) {
    console.log('[Background] 上报已禁用');
    return { success: false, message: '上报已禁用' };
  }
  console.log(`[Background] 📤 准备上报到: ${config.endpoint}`, { dataSize: JSON.stringify(data).length });
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    console.log(`[Background] 📥 收到响应: ${response.status} ${response.statusText}`);
    if (response.ok) {
      console.log(`[Background] ✅ 上报成功: ${config.endpoint}`);
      return { success: true };
    } else {
      const text = await response.text().catch(() => '');
      console.error(`[Background] ❌ 上报失败: ${response.status}, 响应: ${text.substring(0, 200)}`);
      return { success: false, message: `HTTP ${response.status}` };
    }
  } catch (e) {
    console.error('[Background] ❌ 上报异常:', e);
    console.error('[Background] 错误详情:', { name: e.name, message: e.message, stack: e.stack?.split('\n')[0] });
    console.error('[Background] ⚠️  提示: 如果是证书错误，请先在浏览器中访问', config.endpoint.replace(/\/collect$/, '/health'), '并信任证书');
    return { success: false, message: e.message };
  }
}

async function saveApiLog(logData, sub) {
  try {
    const saveData = {
      type: 'api',
      _meta: {
        subscription: { name: sub.name, type: sub.type, urlPattern: sub.urlPattern },
        sourcePageUrl: logData.tabUrl,
        savedAt: new Date().toISOString()
      },
      request: { method: logData.method, url: logData.url, headers: logData.requestHeaders, body: logData.requestBody },
      response: { status: logData.status, statusText: logData.statusText, headers: logData.responseHeaders, body: logData.responseBody },
      timing: { duration: logData.duration, timestamp: logData.timestamp }
    };
    await reportToCollector(saveData);
  } catch (e) { console.error('[Background] 保存 API 失败:', e); }
}

async function savePageHtml(pageUrl, html, sub) {
  try {
    const saveData = {
      type: 'page',
      _meta: {
        subscription: { name: sub.name, type: sub.type, urlPattern: sub.urlPattern },
        sourcePageUrl: pageUrl,
        savedAt: new Date().toISOString()
      },
      content: html
    };
    await reportToCollector(saveData);
    console.log(`[Background] ✅ 自动上报页面: ${sub.name}`);
    return { success: true };
  } catch (e) {
    console.error('[Background] 保存页面失败:', e);
    return { success: false, message: e.message };
  }
}

// 保存日志到文件
async function saveToFile() {
  if (logs.length === 0) return { success: false, message: '没有日志可保存' };
  try {
    const jsonContent = JSON.stringify(logs, null, 2);
    const base64 = btoa(unescape(encodeURIComponent(jsonContent)));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `xhr-logs-${timestamp}.json`;
    await chrome.downloads.download({ url: `data:application/json;base64,${base64}`, filename, saveAs: true });
    const count = logs.length;
    logs = [];
    return { success: true, message: `已保存 ${count} 条日志`, count };
  } catch (error) {
    return { success: false, message: `保存失败: ${error.message}` };
  }
}

// 消息处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'OPEN_DASHBOARD':
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      sendResponse({ success: true });
      break;
    case 'LOG_CAPTURED':
      if (isPaused) { sendResponse({ success: false, paused: true }); break; }
      const logData = message.data;
      logData.id = generateLogId();
      if (sender.tab) logData.tabId = sender.tab.id;
      logs.push(logData);
      console.log(`[Background] ✅ ${logs.length} | ${logData.method} ${logData.url}`);
      checkApiSubscription(logData);
      getLogStorageConfig().then(config => {
        if (config.logFlushEnabled !== false && dashboardFlushPort && config.domainEnabled?.[getPrimaryDomain(logData.url)] !== false)
          try { dashboardFlushPort.postMessage({ type: 'APPEND_LOG', log: logData }); } catch (e) {}
      });
      sendResponse({ success: true });
      break;
    case 'GET_LOGS':
      sendResponse({ success: true, logs, count: logs.length, isPaused });
      break;
    case 'SET_PAUSE':
      isPaused = message.paused;
      chrome.storage.local.set({ pauseState: { paused: isPaused } });
      console.log(`[Background] ${isPaused ? '⏸️ 暂停监听' : '▶️ 继续监听'}`);
      sendResponse({ success: true, isPaused });
      break;
    case 'GET_PAUSE_STATE':
      chrome.storage.local.get('pauseState').then(({ pauseState }) => {
        if (pauseState && typeof pauseState.paused === 'boolean') isPaused = pauseState.paused;
        sendResponse({ success: true, isPaused });
      });
      return true;
    case 'SAVE_TO_FILE':
      saveToFile().then(sendResponse);
      return true;
    case 'CLEAR_LOGS':
      const count = logs.length;
      logs = [];
      sendResponse({ success: true, message: `已清空 ${count} 条日志` });
      break;
    case 'GET_STATUS':
      sendResponse({ success: true, count: logs.length, isPaused });
      break;
    // 页面订阅检查
    case 'CHECK_PAGE_SUBSCRIPTION':
      checkPageSubscription(message.url).then(sub => {
        sendResponse({ success: true, matched: !!sub, subscription: sub });
      });
      return true;
    case 'SAVE_PAGE_HTML':
      checkPageSubscription(message.url, true).then(sub => {
        if (sub) savePageHtml(message.url, message.html, sub).then(sendResponse);
        else sendResponse({ success: false, message: '未命中订阅' });
      });
      return true;
    // 订阅管理
    case 'GET_SUBSCRIPTIONS':
      getSubscriptions().then(subs => sendResponse({ success: true, subscriptions: subs }));
      return true;
    case 'ADD_SUBSCRIPTION':
      addSubscription(message.subscription).then(sendResponse);
      return true;
    case 'UPDATE_SUBSCRIPTION':
      updateSubscription(message.id, message.updates).then(sendResponse);
      return true;
    case 'DELETE_SUBSCRIPTION':
      deleteSubscription(message.id).then(sendResponse);
      return true;
    case 'TOGGLE_SUBSCRIPTION':
      toggleSubscription(message.id).then(sendResponse);
      return true;
    // 上报配置管理
    case 'GET_COLLECTOR_CONFIG':
      getCollectorConfig().then(config => sendResponse({ success: true, config }));
      return true;
    case 'SAVE_COLLECTOR_CONFIG':
      saveCollectorConfig(message.config).then(() => sendResponse({ success: true }));
      return true;
    case 'GET_LOG_STORAGE_CONFIG':
      getLogStorageConfig().then(c => sendResponse({ success: true, config: c }));
      return true;
    case 'SAVE_LOG_STORAGE_CONFIG':
      saveLogStorageConfig(message.config).then(() => sendResponse({ success: true }));
      return true;
    case 'SET_DOMAIN_LOG_ENABLED':
      setDomainLogEnabled(message.domain, message.enabled).then(sendResponse);
      return true;
    case 'EXPORT_LOGS_TO_FILES':
      exportLogsToFiles().then(sendResponse);
      return true;
    case 'GET_LOGS_SINCE_LAST_FLUSH': {
      const { logs: sinceLogs, maxId } = getLogsSinceLastFlush();
      sendResponse({ success: true, logs: sinceLogs, maxId });
      break;
    }
    case 'SET_LAST_FLUSHED_ID':
      lastFlushedLogId = Math.max(lastFlushedLogId, message.id || 0);
      sendResponse({ success: true });
      break;
    case 'SET_SILENT_FLUSH_ACTIVE':
      chrome.storage.local.set({ silentFlushActive: !!message.active }).then(() => sendResponse({ success: true }));
      return true;
    case 'SET_LOG_FLUSH_ENABLED':
      getLogStorageConfig().then(c => { c.logFlushEnabled = !!message.enabled; saveLogStorageConfig(c).then(() => sendResponse({ success: true })); });
      return true;
    default:
      sendResponse({ success: false, message: 'Unknown message type' });
  }
});

chrome.storage.local.get('pauseState').then(({ pauseState }) => { if (pauseState?.paused === true) isPaused = true; });

chrome.runtime.onInstalled.addListener(details => {
  console.log('[Background] Extension', details.reason);
});
