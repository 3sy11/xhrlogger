// XHR Logger - Dashboard
let logs = [], filteredLogs = [], selectedLogId = null, isPaused = false, refreshTimer = null;
let subscriptions = [], selectedSubId = null, isNewSub = false;
let logStorageConfig = { defaultPath: 'xhr-logs', domainEnabled: {}, logFlushEnabled: false };
let selectedLogDomain = null;
let logDirectoryHandle = null;
let expandedLogIdInDetail = null;
let flushPort = null;
const appendQueue = {};
const domainWriting = {};
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const $ = id => document.getElementById(id);

function getPrimaryDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host.startsWith('127.')) return host;
    const parts = host.split('.');
    if (parts.length >= 2) return parts.slice(-2).join('.');
    return host;
  } catch { return 'unknown'; }
}

function init() {
  chrome.runtime.sendMessage({ type: 'GET_PAUSE_STATE' }, response => {
    if (response?.success) { isPaused = response.isPaused; updatePauseButton(); }
    loadLogs(); startRefresh();
  });
  loadSubscriptions();
  
  // Tab 切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  
  // 看板事件
  $('search-input').addEventListener('input', filterLogs);
  $('filter-method').addEventListener('change', filterLogs);
  $('filter-status').addEventListener('change', filterLogs);
  $('clear-btn').addEventListener('click', clearLogs);
  $('export-btn').addEventListener('click', exportLogs);
  $('pause-btn').addEventListener('click', togglePause);
  $('detail-panel').addEventListener('click', handleDetailClick);
  
  // 订阅事件
  $('add-sub-btn').addEventListener('click', addNewSubscription);
  $('export-sub-btn').addEventListener('click', exportSubscriptions);
  $('import-sub-btn').addEventListener('click', () => $('import-file-input').click());
  $('import-file-input').addEventListener('change', importSubscriptions);
  $('collector-config-btn').addEventListener('click', openCollectorConfig);
  $('collector-endpoint').addEventListener('input', updateTestCertLink);
  $('subscription-list-panel').addEventListener('click', handleSubListClick);
  $('subscription-form').addEventListener('click', handleFormClick);
  $('subscription-form').addEventListener('change', handleFormChange);
  
  // 上报配置 Modal
  $('collector-modal-close').addEventListener('click', closeCollectorConfig);
  $('collector-modal-overlay').addEventListener('click', e => { if (e.target === $('collector-modal-overlay')) closeCollectorConfig(); });
  $('collector-cancel-btn').addEventListener('click', closeCollectorConfig);
  $('collector-save-btn').addEventListener('click', saveCollectorConfig);
  
  // 日志管理
  $('log-flush-enabled-toggle').addEventListener('click', toggleLogFlushEnabled);
  $('log-pick-dir-btn').addEventListener('click', pickLogDirectory);
  $('log-export-disk-btn').addEventListener('click', exportLogsToDisk);
  $('log-domain-list').addEventListener('click', handleLogDomainListClick);
  $('log-by-domain-list').addEventListener('click', handleLogByDomainRowClick);
  // URL hash 检测
  if (location.hash === '#subscriptions') switchTab('subscriptions');
  if (location.hash === '#logs') switchTab('logs');
  window.addEventListener('beforeunload', () => { disconnectFlushPort(); });
}

function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabId}`));
  $('monitor-controls').classList.toggle('hidden', tabId !== 'monitor');
  $('subscription-controls').classList.toggle('hidden', tabId !== 'subscriptions');
  $('log-controls').classList.toggle('hidden', tabId !== 'logs');
  if (tabId === 'subscriptions') { loadSubscriptions(); renderSubscriptionList(); }
  if (tabId === 'logs') { loadLogStorageConfig(); selectedLogDomain = null; updateFlushConnection(); }
  else updateFlushConnection();
}

function startRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadLogs, 2000);
}

function updatePauseButton() {
  const btn = $('pause-btn');
  btn.textContent = isPaused ? '▶️ 继续' : '⏸️ 暂停';
  btn.classList.toggle('paused', isPaused);
}

function togglePause() {
  chrome.runtime.sendMessage({ type: 'SET_PAUSE', paused: !isPaused }, response => {
    if (response?.success) { isPaused = response.isPaused; updatePauseButton(); }
  });
}

function loadLogs() {
  chrome.runtime.sendMessage({ type: 'GET_LOGS' }, response => {
    if (response?.success) {
      if (response.isPaused !== undefined && response.isPaused !== isPaused) { isPaused = response.isPaused; updatePauseButton(); }
      const newLogs = response.logs || [];
      if (JSON.stringify(newLogs.map(l => l.id)) !== JSON.stringify(logs.map(l => l.id))) { logs = newLogs; filterLogs(); }
      if ($('tab-logs')?.classList.contains('active')) { renderLogDomainList(); renderLogByDomainList(); }
      if (logDirectoryHandle && logStorageConfig.logFlushEnabled !== false && !flushPort) updateFlushConnection();
    }
  });
}

function filterLogs() {
  const search = $('search-input').value.toLowerCase(), method = $('filter-method').value, status = $('filter-status').value;
  filteredLogs = logs.filter(log => {
    if (search && !log.url.toLowerCase().includes(search) && !log.method.toLowerCase().includes(search) && !String(log.status).includes(search)) return false;
    if (method && log.method !== method) return false;
    if (status) {
      const s = log.status;
      if (status === '2xx' && (s < 200 || s >= 300)) return false;
      if (status === '3xx' && (s < 300 || s >= 400)) return false;
      if (status === '4xx' && (s < 400 || s >= 500)) return false;
      if (status === '5xx' && (s < 500 || s >= 600)) return false;
    }
    return true;
  });
  renderList();
  const isFiltered = search || method || status;
  const countText = `${filteredLogs.length} 请求${isPaused ? ' (已暂停)' : ''}`;
  $('log-count').textContent = countText;
  
  // 更新导出按钮文本
  const exportBtn = $('export-btn');
  if (isFiltered && filteredLogs.length !== logs.length) {
    exportBtn.textContent = `📥 导出 (${filteredLogs.length})`;
    exportBtn.title = `导出过滤后的 ${filteredLogs.length} 条请求（共 ${logs.length} 条）`;
  } else {
    exportBtn.textContent = '📥 导出';
    exportBtn.title = `导出全部 ${logs.length} 条请求`;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function getResponseSize(log) { return typeof (log.responseBody || '') === 'string' ? (log.responseBody || '').length : 0; }

function renderList() {
  const list = $('request-list');
  if (filteredLogs.length === 0) {
    list.innerHTML = `<div class="empty-state"><h2>暂无请求</h2><p>${isPaused ? '监听已暂停，点击「继续」恢复监听' : '等待页面发起 XHR 或 Fetch 请求...'}</p></div>`;
    return;
  }
  list.innerHTML = filteredLogs.slice().reverse().map(log => {
    const statusClass = log.status >= 500 ? 'status-5xx' : log.status >= 400 ? 'status-4xx' : log.status >= 300 ? 'status-3xx' : 'status-2xx';
    const time = new Date(log.timestamp).toLocaleTimeString();
    const urlPath = (() => { try { return new URL(log.url).pathname + new URL(log.url).search; } catch { return log.url; } })();
    return `<div class="request-item${selectedLogId === log.id ? ' active' : ''}" data-id="${log.id}">
      <span class="method-badge method-${log.method}">${log.method}</span>
      <span class="status-badge ${statusClass}">${log.status}</span>
      <span class="request-url" title="${escapeHtml(log.url)}">${escapeHtml(urlPath)}</span>
      <span class="request-size">${formatSize(getResponseSize(log))}</span>
      <span class="request-duration">${log.duration}ms</span>
      <span class="request-time">${time}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.request-item').forEach(item => item.addEventListener('click', () => selectLog(parseInt(item.dataset.id))));
}

function selectLog(id) {
  selectedLogId = id;
  const log = logs.find(l => l.id === id);
  if (!log) return;
  document.querySelectorAll('.request-item').forEach(el => el.classList.toggle('active', parseInt(el.dataset.id) === id));
  renderDetail(log);
}

function escapeHtml(str) { return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function renderDetail(log) {
  const statusClass = log.status >= 500 ? 'status-5xx' : log.status >= 400 ? 'status-4xx' : log.status >= 300 ? 'status-3xx' : 'status-2xx';
  const formatJson = str => { try { return escapeHtml(JSON.stringify(JSON.parse(str), null, 2)); } catch { return escapeHtml(str) || '(空)'; } };
  const headersTable = headers => {
    const entries = Object.entries(headers || {});
    return entries.length === 0 ? '<p style="color: var(--text-muted);">(无)</p>' : `<table class="headers-table"><tbody>${entries.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table>`;
  };
  const respSize = formatSize(getResponseSize(log));
  $('detail-panel').innerHTML = `
    <div class="detail-url-wrapper">
      <span class="detail-url">${escapeHtml(log.url)}</span>
      <button class="btn btn-subscribe btn-small" data-action="subscribe" data-url="${encodeURIComponent(log.url)}" data-method="${log.method}">📌 订阅</button>
    </div>
    <div class="detail-meta">
      <div class="detail-meta-item"><span class="detail-meta-label">方法</span><span class="method-badge method-${log.method}">${log.method}</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">状态</span><span class="status-badge ${statusClass}">${log.status} ${log.statusText || ''}</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">耗时</span><span class="detail-meta-value">${log.duration}ms</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">大小</span><span class="detail-meta-value">${respSize}</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">类型</span><span class="detail-meta-value">${log.type}</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">时间</span><span class="detail-meta-value">${new Date(log.timestamp).toLocaleString()}</span></div>
    </div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">📤 Request Headers</span><span class="detail-section-toggle">▼</span></div><div class="detail-section-content">${headersTable(log.requestHeaders)}</div></div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">📝 Request Body</span><button class="copy-btn" data-action="copy" data-text="${encodeURIComponent(log.requestBody || '')}">复制</button></div><div class="detail-section-content">${formatJson(log.requestBody)}</div></div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">📥 Response Headers</span><span class="detail-section-toggle">▼</span></div><div class="detail-section-content">${headersTable(log.responseHeaders)}</div></div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">📄 Response Body (${respSize})</span><button class="copy-btn" data-action="copy" data-text="${encodeURIComponent(log.responseBody || '')}">复制</button></div><div class="detail-section-content">${formatJson(log.responseBody)}</div></div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">🌐 页面 URL</span><span class="detail-section-toggle">▶</span></div><div class="detail-section-content collapsed">${escapeHtml(log.tabUrl) || '(未知)'}</div></div>
  `;
}

function handleDetailClick(e) {
  const subBtn = e.target.closest('[data-action="subscribe"]');
  if (subBtn) { e.stopPropagation(); subscribeApi(decodeURIComponent(subBtn.dataset.url), subBtn.dataset.method); return; }
  const copyBtn = e.target.closest('[data-action="copy"]');
  if (copyBtn) {
    e.stopPropagation();
    navigator.clipboard.writeText(decodeURIComponent(copyBtn.dataset.text || '')).then(() => { copyBtn.textContent = '已复制'; setTimeout(() => copyBtn.textContent = '复制', 1500); });
    return;
  }
  const header = e.target.closest('[data-action="toggle"]');
  if (header) {
    const content = header.nextElementSibling;
    if (content) { content.classList.toggle('collapsed'); const t = header.querySelector('.detail-section-toggle'); if (t) t.textContent = content.classList.contains('collapsed') ? '▶' : '▼'; }
  }
}

function clearLogs() {
  if (confirm('确定要清空所有日志吗？')) {
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => {
      logs = []; filteredLogs = []; selectedLogId = null; renderList();
      $('detail-panel').innerHTML = '<div class="detail-placeholder">选择一个请求查看详情</div>';
    });
  }
}

function exportLogs() {
  // 导出当前过滤筛选后的结果
  const logsToExport = filteredLogs.length > 0 ? filteredLogs : logs;
  const searchTerm = $('search-input').value.trim();
  const methodFilter = $('filter-method').value;
  const statusFilter = $('filter-status').value;
  
  // 生成文件名，包含过滤条件
  let filename = 'xhr-logs';
  if (searchTerm || methodFilter || statusFilter) {
    filename += '-filtered';
    if (methodFilter) filename += `-${methodFilter}`;
    if (statusFilter) filename += `-${statusFilter}`;
  }
  filename += `-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
  
  // 导出数据，包含元信息
  const exportData = {
    exportTime: new Date().toISOString(),
    totalLogs: logs.length,
    filteredLogs: logsToExport.length,
    filters: {
      search: searchTerm || null,
      method: methodFilter || null,
      status: statusFilter || null
    },
    logs: logsToExport
  };
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  
  // 提示信息
  const msg = logsToExport.length === logs.length 
    ? `已导出全部 ${logsToExport.length} 条请求` 
    : `已导出过滤后的 ${logsToExport.length} 条请求（共 ${logs.length} 条）`;
  console.log(`[Dashboard] ${msg}`);
}

// ==================== 订阅管理 ====================

function loadSubscriptions() {
  chrome.runtime.sendMessage({ type: 'GET_SUBSCRIPTIONS' }, response => {
    if (response?.success) { subscriptions = response.subscriptions || []; updateSubCount(); }
  });
}

function updateSubCount() { $('sub-count').textContent = `${subscriptions.length} 订阅`; }

function renderSubscriptionList() {
  const list = $('subscription-list');
  if (subscriptions.length === 0) { list.innerHTML = '<div class="subscription-empty">暂无订阅，点击右上角「新增订阅」创建</div>'; return; }
  list.innerHTML = subscriptions.map(sub => `
    <div class="subscription-item${sub.enabled ? '' : ' disabled'}${selectedSubId === sub.id ? ' active' : ''}" data-id="${sub.id}">
      <div class="sub-toggle${sub.enabled ? ' active' : ''}" data-action="toggle-sub" data-id="${sub.id}"></div>
      <div class="sub-info">
        <div class="sub-name">
          ${escapeHtml(sub.name)}
          ${sub.reportEnabled === false ? '<span class="report-badge disabled">上报关闭</span>' : '<span class="report-badge">上报开启</span>'}
        </div>
        ${sub.description ? `<div class="sub-desc">${escapeHtml(sub.description)}</div>` : ''}
        <div class="sub-pattern">${escapeHtml(sub.urlPattern)}</div>
        <div class="sub-tags">
          <span class="sub-tag ${sub.type}">${sub.type === 'api' ? 'API' : '页面'}</span>
          <span class="sub-tag${sub.matchMode === 'regex' ? ' regex' : ''}">${sub.matchMode === 'regex' ? '正则' : '精确'}</span>
          ${sub.method ? `<span class="sub-tag">${sub.method}</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function handleSubListClick(e) {
  const toggle = e.target.closest('[data-action="toggle-sub"]');
  if (toggle) { e.stopPropagation(); toggleSubscription(toggle.dataset.id); return; }
  const item = e.target.closest('.subscription-item');
  if (item && !toggle) selectSubscription(item.dataset.id);
}

function selectSubscription(id) {
  selectedSubId = id; isNewSub = false;
  document.querySelectorAll('.subscription-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  const sub = subscriptions.find(s => s.id === id);
  if (sub) renderSubscriptionForm(sub);
}

function addNewSubscription() {
  selectedSubId = null; isNewSub = true;
  document.querySelectorAll('.subscription-item').forEach(el => el.classList.remove('active'));
  renderSubscriptionForm({ name: '', description: '', type: 'api', matchMode: 'exact', urlPattern: '', queryPattern: '', method: '', enabled: true, reportEnabled: true });
}

function renderSubscriptionForm(sub) {
  $('sub-detail-title').textContent = isNewSub ? '新增订阅' : '编辑订阅';
  const methodDisplay = sub.type === 'api' ? 'block' : 'none';
  // 命中信息区域（非新建时显示）
  let lastMatchInfo = '';
  if (!isNewSub) {
    const hasMatch = sub.lastMatchedAt;
    const matchTime = hasMatch ? new Date(sub.lastMatchedAt).toLocaleString() : '暂无';
    const matchUrl = sub.lastMatchedUrl ? escapeHtml(sub.lastMatchedUrl) : '-';
    const sourcePage = sub.lastSourcePageUrl ? escapeHtml(sub.lastSourcePageUrl) : '-';
    lastMatchInfo = `<div class="form-info"><div class="info-title">📊 命中记录</div><div class="info-row"><span class="info-label">最后命中:</span><span class="info-value">${matchTime}</span></div><div class="info-row"><span class="info-label">命中 URL:</span><span class="info-value info-url">${matchUrl}</span></div>${sub.type === 'api' ? `<div class="info-row"><span class="info-label">来源页面:</span><span class="info-value info-url">${sourcePage}</span></div>` : ''}</div>`;
  }
  $('subscription-form').innerHTML = `
    <div class="form-group"><label>订阅名称</label><input type="text" class="form-input" id="form-name" value="${escapeHtml(sub.name)}" placeholder="输入订阅名称"></div>
    <div class="form-group"><label>简介</label><input type="text" class="form-input" id="form-description" value="${escapeHtml(sub.description || '')}" placeholder="订阅用途说明（可选）"></div>
    <div class="form-row">
      <div class="form-group"><label>类型</label><select class="form-select" id="form-type"><option value="api"${sub.type === 'api' ? ' selected' : ''}>API 订阅</option><option value="page"${sub.type === 'page' ? ' selected' : ''}>页面订阅</option></select></div>
      <div class="form-group"><label>匹配模式</label><select class="form-select" id="form-match-mode"><option value="exact"${sub.matchMode === 'exact' ? ' selected' : ''}>完全匹配</option><option value="regex"${sub.matchMode === 'regex' ? ' selected' : ''}>正则匹配</option></select></div>
    </div>
    <div class="form-group"><label>URL 路径模式</label><input type="text" class="form-input" id="form-url-pattern" value="${escapeHtml(sub.urlPattern)}" placeholder="https://example.com/api/path"></div>
    <div class="form-group"><label>查询参数模式（可选）</label><input type="text" class="form-input" id="form-query-pattern" value="${escapeHtml(sub.queryPattern)}" placeholder="key=value 或正则表达式"></div>
    <div class="form-group" id="form-method-group" style="display:${methodDisplay}"><label>请求方法（可选）</label><select class="form-select" id="form-method"><option value="">全部方法</option><option value="GET"${sub.method === 'GET' ? ' selected' : ''}>GET</option><option value="POST"${sub.method === 'POST' ? ' selected' : ''}>POST</option><option value="PUT"${sub.method === 'PUT' ? ' selected' : ''}>PUT</option><option value="DELETE"${sub.method === 'DELETE' ? ' selected' : ''}>DELETE</option><option value="PATCH"${sub.method === 'PATCH' ? ' selected' : ''}>PATCH</option></select></div>
    <div class="form-group report-toggle-group">
      <label class="toggle-label">
        <input type="checkbox" id="form-report-enabled" ${sub.reportEnabled !== false ? 'checked' : ''}>
        <span class="toggle-text">启用自动上报</span>
        <span class="toggle-hint">关闭后订阅仍会生效，但不会上报数据</span>
      </label>
    </div>
    ${lastMatchInfo}
    <div class="form-actions">${isNewSub ? '' : '<button class="btn btn-danger" data-action="delete-sub">删除</button>'}<button class="btn btn-success" data-action="save-sub">保存</button></div>
  `;
}

function handleFormClick(e) {
  const saveBtn = e.target.closest('[data-action="save-sub"]');
  if (saveBtn) { saveSubscription(); return; }
  const delBtn = e.target.closest('[data-action="delete-sub"]');
  if (delBtn && selectedSubId) deleteSubscription(selectedSubId);
}

function handleFormChange(e) {
  if (e.target.id === 'form-type') {
    const methodGroup = $('form-method-group');
    if (methodGroup) methodGroup.style.display = e.target.value === 'api' ? 'block' : 'none';
  }
}

function saveSubscription() {
  const sub = {
    name: $('form-name')?.value.trim() || '未命名订阅',
    description: $('form-description')?.value.trim() || '',
    type: $('form-type')?.value || 'api',
    matchMode: $('form-match-mode')?.value || 'exact',
    urlPattern: $('form-url-pattern')?.value.trim() || '',
    queryPattern: $('form-query-pattern')?.value.trim() || '',
    method: $('form-type')?.value === 'api' ? ($('form-method')?.value || '') : '',
    reportEnabled: $('form-report-enabled')?.checked !== false
  };
  if (!sub.urlPattern) { alert('请输入 URL 路径模式'); return; }
  
  if (isNewSub) {
    chrome.runtime.sendMessage({ type: 'ADD_SUBSCRIPTION', subscription: sub }, response => {
      if (response?.success) {
        subscriptions.push(response.subscription);
        selectedSubId = response.subscription.id; isNewSub = false;
        renderSubscriptionList(); renderSubscriptionForm(response.subscription); updateSubCount();
      }
    });
  } else if (selectedSubId) {
    chrome.runtime.sendMessage({ type: 'UPDATE_SUBSCRIPTION', id: selectedSubId, updates: sub }, response => {
      if (response?.success) {
        const idx = subscriptions.findIndex(s => s.id === selectedSubId);
        if (idx !== -1) subscriptions[idx] = { ...subscriptions[idx], ...sub };
        renderSubscriptionList();
      }
    });
  }
}

function toggleSubscription(id) {
  chrome.runtime.sendMessage({ type: 'TOGGLE_SUBSCRIPTION', id }, response => {
    if (response?.success) {
      const sub = subscriptions.find(s => s.id === id);
      if (sub) sub.enabled = response.enabled;
      renderSubscriptionList();
    }
  });
}

function deleteSubscription(id) {
  if (!confirm('确定要删除这个订阅吗？')) return;
  chrome.runtime.sendMessage({ type: 'DELETE_SUBSCRIPTION', id }, response => {
    if (response?.success) {
      subscriptions = subscriptions.filter(s => s.id !== id);
      selectedSubId = null;
      renderSubscriptionList();
      $('subscription-form').innerHTML = '<div class="form-placeholder">选择一个订阅查看详情，或点击「新增订阅」创建</div>';
      updateSubCount();
    }
  });
}

function subscribeApi(url, method) {
  try {
    const urlObj = new URL(url);
    const sub = {
      name: urlObj.pathname.split('/').filter(Boolean).pop() || urlObj.hostname,
      description: '',
      type: 'api', matchMode: 'exact',
      urlPattern: urlObj.origin + urlObj.pathname,
      queryPattern: urlObj.search ? urlObj.search.slice(1) : '',
      method: method || ''
    };
    chrome.runtime.sendMessage({ type: 'ADD_SUBSCRIPTION', subscription: sub }, response => {
      if (response?.success) {
        subscriptions.push(response.subscription);
        updateSubCount();
        // 切换到订阅管理 Tab 并选中
        switchTab('subscriptions');
        selectedSubId = response.subscription.id; isNewSub = false;
        renderSubscriptionList();
        renderSubscriptionForm(response.subscription);
      } else { alert('添加失败：' + (response?.message || '未知错误')); }
    });
  } catch (e) { alert('URL 解析失败：' + e.message); }
}

// ==================== 订阅导入导出 ====================

function exportSubscriptions() {
  if (subscriptions.length === 0) { alert('暂无订阅可导出'); return; }
  const data = { version: '1.0', exportTime: new Date().toISOString(), subscriptions: subscriptions };
  const content = JSON.stringify(data, null, 2);
  const base64 = btoa(unescape(encodeURIComponent(content)));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  chrome.downloads.download({
    url: `data:application/json;base64,${base64}`,
    filename: `xhr-subscriptions-${timestamp}.json`,
    saveAs: true
  }, downloadId => {
    if (downloadId) console.log('[Dashboard] 订阅已导出');
    else alert('导出失败');
  });
}

function importSubscriptions(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const data = JSON.parse(event.target.result);
      const importSubs = data.subscriptions || data;
      if (!Array.isArray(importSubs) || importSubs.length === 0) { alert('无效的订阅文件'); return; }
      const validSubs = importSubs.filter(s => s.urlPattern && s.type);
      if (validSubs.length === 0) { alert('未找到有效的订阅'); return; }
      if (!confirm(`确定要导入 ${validSubs.length} 个订阅吗？`)) return;
      let imported = 0;
      for (const sub of validSubs) {
        const newSub = { name: sub.name || '导入的订阅', description: sub.description || '', type: sub.type, matchMode: sub.matchMode || 'exact', urlPattern: sub.urlPattern, queryPattern: sub.queryPattern || '', method: sub.method || '' };
        const response = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'ADD_SUBSCRIPTION', subscription: newSub }, resolve));
        if (response?.success) { subscriptions.push(response.subscription); imported++; }
      }
      updateSubCount();
      renderSubscriptionList();
      alert(`成功导入 ${imported} 个订阅`);
    } catch (err) { alert('导入失败：' + err.message); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ==================== 上报配置管理 ====================

function openCollectorConfig() {
  chrome.runtime.sendMessage({ type: 'GET_COLLECTOR_CONFIG' }, response => {
    if (response?.success) {
      const config = response.config;
      $('collector-endpoint').value = config.endpoint || 'https://172.27.0.101:8443/collect';
      $('collector-enabled').checked = config.enabled !== false;
      // 更新测试链接
      updateTestCertLink();
    }
    $('collector-modal-overlay').classList.add('active');
  });
}

function updateTestCertLink() {
  const endpoint = $('collector-endpoint').value.trim();
  const link = $('test-cert-link');
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      const testUrl = `${url.protocol}//${url.host}/health`;
      link.href = testUrl;
      link.onclick = (e) => {
        e.preventDefault();
        window.open(testUrl, '_blank');
      };
    } catch { link.href = '#'; }
  }
}

function closeCollectorConfig() {
  $('collector-modal-overlay').classList.remove('active');
}

function saveCollectorConfig() {
  const config = {
    endpoint: $('collector-endpoint').value.trim() || 'https://localhost:8443/collect',
    enabled: $('collector-enabled').checked
  };
  if (!config.endpoint) { alert('请输入上报地址'); return; }
  try { new URL(config.endpoint); } catch { alert('请输入有效的 URL'); return; }
  chrome.runtime.sendMessage({ type: 'SAVE_COLLECTOR_CONFIG', config }, response => {
    if (response?.success) {
      alert('配置已保存');
      closeCollectorConfig();
    } else { alert('保存失败'); }
  });
}

// ==================== 日志管理 ====================

function loadLogStorageConfig() {
  chrome.runtime.sendMessage({ type: 'GET_LOG_STORAGE_CONFIG' }, response => {
    if (response?.success) { logStorageConfig = response.config || { defaultPath: 'xhr-logs', domainEnabled: {}, logFlushEnabled: false }; updateLogPathDisplay(); updateLogFlushToggle(); renderLogDomainList(); renderLogByDomainList(); updateFlushConnection(); }
  });
}

function updateLogPathDisplay() {
  const el = $('log-path-display');
  if (!el) return;
  if (logDirectoryHandle) el.textContent = `已选目录: ${logDirectoryHandle.name}`;
  else el.textContent = logStorageConfig.logFlushEnabled !== false ? '请选择目录以开始落盘' : '默认: 下载目录/xhr-logs';
}

function updateLogFlushToggle() {
  const el = $('log-flush-enabled-toggle');
  if (!el) return;
  const on = logStorageConfig.logFlushEnabled !== false;
  el.classList.toggle('active', on);
}

function toggleLogFlushEnabled(e) {
  e.stopPropagation();
  const next = logStorageConfig.logFlushEnabled === false;
  logStorageConfig.logFlushEnabled = next;
  chrome.runtime.sendMessage({ type: 'SET_LOG_FLUSH_ENABLED', enabled: next }, () => {
    updateLogFlushToggle();
    updateFlushConnection();
    updateLogPathDisplay();
    if (next && !logDirectoryHandle) alert('请点击「选择目录」指定落盘位置后，落盘才会开始。');
  });
}

function connectFlushPort() {
  if (flushPort || !logDirectoryHandle || logStorageConfig.logFlushEnabled === false) return;
  flushPort = chrome.runtime.connect({ name: 'log-flush' });
  chrome.runtime.sendMessage({ type: 'SET_SILENT_FLUSH_ACTIVE', active: true }).catch(() => {});
  flushPort.onMessage.addListener(msg => {
    if (msg.type === 'APPEND_LOG' && msg.log) { const d = getPrimaryDomain(msg.log.url); if (!appendQueue[d]) appendQueue[d] = []; appendQueue[d].push(msg.log); processAppendQueue(d); }
  });
  flushPort.onDisconnect.addListener(() => { flushPort = null; chrome.runtime.sendMessage({ type: 'SET_SILENT_FLUSH_ACTIVE', active: false }).catch(() => {}); });
}

function disconnectFlushPort() {
  if (flushPort) { try { flushPort.disconnect(); } catch (e) {} flushPort = null; }
  chrome.runtime.sendMessage({ type: 'SET_SILENT_FLUSH_ACTIVE', active: false }).catch(() => {});
}

function updateFlushConnection() {
  if (logDirectoryHandle && logStorageConfig.logFlushEnabled !== false) connectFlushPort();
  else disconnectFlushPort();
}

async function processAppendQueue(domain) {
  if (domainWriting[domain] || !appendQueue[domain]?.length || !logDirectoryHandle) return;
  domainWriting[domain] = true;
  const log = appendQueue[domain].shift();
  const safeDomain = domain.replace(/[^a-z0-9.-]/gi, '_');
  const dateStr = new Date().toISOString().slice(0, 10);
  const line = JSON.stringify(log) + '\n';
  try {
    const dir = await logDirectoryHandle.getDirectoryHandle(safeDomain, { create: true });
    const baseName = `${dateStr}.ndjson`;
    let fileHandle, currentSize = 0;
    try { fileHandle = await dir.getFileHandle(baseName, { create: false }); const f = await fileHandle.getFile(); currentSize = f.size; } catch { fileHandle = await dir.getFileHandle(baseName, { create: true }); }
    if (currentSize + line.length > MAX_FILE_BYTES) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fileHandle = await dir.getFileHandle(`${dateStr}-${ts}.ndjson`, { create: true });
      const w = await fileHandle.createWritable();
      await w.write(line);
      await w.close();
    } else {
      const w = await fileHandle.createWritable({ keepExistingData: true });
      if (w.seek) await w.seek(currentSize);
      await w.write(line);
      await w.close();
    }
  } catch (e) { console.error('[Dashboard] append log', e); }
  domainWriting[domain] = false;
  if (appendQueue[domain]?.length) processAppendQueue(domain);
}

async function pickLogDirectory() {
  try {
    if (typeof showDirectoryPicker !== 'function') { alert('当前环境不支持目录选择'); return; }
    const handle = await showDirectoryPicker();
    logDirectoryHandle = handle;
    updateLogPathDisplay();
    updateFlushConnection();
  } catch (err) { if (err.name !== 'AbortError') alert('选择目录失败: ' + (err.message || err)); }
}

function exportLogsToDisk() {
  if (logDirectoryHandle) {
    chrome.runtime.sendMessage({ type: 'GET_LOGS' }, async response => {
      if (!response?.success || !response.logs?.length) { alert('暂无日志'); return; }
      const domainEnabled = logStorageConfig.domainEnabled || {};
      const byDomain = {};
      for (const log of response.logs) {
        const d = getPrimaryDomain(log.url);
        if (domainEnabled[d] === false) continue;
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(log);
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let done = 0;
      for (const [domain, arr] of Object.entries(byDomain)) {
        if (arr.length === 0) continue;
        const sorted = arr.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const safeDomain = domain.replace(/[^a-z0-9.-]/gi, '_');
        const content = JSON.stringify({ domain, exportedAt: new Date().toISOString(), logs: sorted }, null, 2);
        try {
          const dir = await logDirectoryHandle.getDirectoryHandle(safeDomain, { create: true });
          const file = await dir.getFileHandle(`${ts}.json`, { create: true });
          const w = await file.createWritable();
          await w.write(content);
          await w.close();
          done++;
        } catch (e) { console.error('[Dashboard] write fail', e); }
      }
      alert(done ? `已保存 ${done} 个文件到所选目录` : '没有可导出的域名');
    });
  } else {
    chrome.runtime.sendMessage({ type: 'EXPORT_LOGS_TO_FILES' }, response => {
      if (response?.success) { if (response.count === 0) alert('没有可导出的日志，或请检查左侧域名开关'); else alert(`已导出 ${response.count} 个文件到下载目录/xhr-logs`); } else { alert(response?.message || '导出失败'); }
    });
  }
}

function renderLogDomainList() {
  const byDomain = {};
  for (const log of logs) {
    const d = getPrimaryDomain(log.url);
    if (!byDomain[d]) byDomain[d] = 0;
    byDomain[d]++;
  }
  const enabledFirst = (a, b) => {
    const ae = logStorageConfig.domainEnabled[a] !== false;
    const be = logStorageConfig.domainEnabled[b] !== false;
    if (ae !== be) return ae ? -1 : 1;
    return a.localeCompare(b);
  };
  const domains = Object.keys(byDomain).sort(enabledFirst);
  const list = $('log-domain-list');
  if (domains.length === 0) { list.innerHTML = '<div class="log-domain-empty">暂无请求，按一级域名划分的列表将在此显示</div>'; return; }
  list.innerHTML = domains.map(domain => {
    const enabled = logStorageConfig.domainEnabled[domain] !== false;
    const active = selectedLogDomain === domain ? ' active' : '';
    return `<div class="log-domain-item${active}" data-domain="${escapeHtml(domain)}" data-action="select">
      <div class="sub-toggle${enabled ? ' active' : ''}" data-action="log-toggle" data-domain="${escapeHtml(domain)}"></div>
      <span class="log-domain-name">${escapeHtml(domain)}</span>
      <span class="log-domain-count">${byDomain[domain]}</span>
    </div>`;
  }).join('');
}

function handleLogDomainListClick(e) {
  const toggle = e.target.closest('[data-action="log-toggle"]');
  if (toggle) {
    e.stopPropagation();
    const domain = toggle.dataset.domain;
    const item = toggle.closest('.log-domain-item');
    const next = !item.querySelector('.sub-toggle.active');
    chrome.runtime.sendMessage({ type: 'SET_DOMAIN_LOG_ENABLED', domain, enabled: next }, response => {
      if (response?.success) { logStorageConfig.domainEnabled = logStorageConfig.domainEnabled || {}; logStorageConfig.domainEnabled[domain] = next; renderLogDomainList(); renderLogByDomainList(); }
    });
    return;
  }
  const row = e.target.closest('.log-domain-item');
  if (row && !e.target.closest('[data-action="log-toggle"]')) {
    selectedLogDomain = row.dataset.domain;
    renderLogDomainList();
    renderLogByDomainList();
    const title = $('log-detail-title');
    if (title) title.textContent = selectedLogDomain ? `详细日志: ${selectedLogDomain}` : '按域名的详细日志';
  }
}

function logRowDetailHtml(log) {
  const statusClass = log.status >= 500 ? 'status-5xx' : log.status >= 400 ? 'status-4xx' : log.status >= 300 ? 'status-3xx' : 'status-2xx';
  const formatJson = str => { try { return escapeHtml(JSON.stringify(JSON.parse(str), null, 2)); } catch { return escapeHtml(str) || '(空)'; } };
  const headersTable = headers => {
    const entries = Object.entries(headers || {});
    return entries.length === 0 ? '<p style="color: var(--text-muted);">(无)</p>' : `<table class="headers-table"><tbody>${entries.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table>`;
  };
  const respSize = formatSize(typeof (log.responseBody || '') === 'string' ? (log.responseBody || '').length : 0);
  return `<div class="log-row-detail-inner">
    <div class="detail-url-wrapper"><span class="detail-url">${escapeHtml(log.url)}</span></div>
    <div class="detail-meta">
      <div class="detail-meta-item"><span class="detail-meta-label">方法</span><span class="method-badge method-${log.method}">${log.method}</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">状态</span><span class="status-badge ${statusClass}">${log.status}</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">耗时</span><span class="detail-meta-value">${log.duration}ms</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">大小</span><span class="detail-meta-value">${respSize}</span></div>
      <div class="detail-meta-item"><span class="detail-meta-label">时间</span><span class="detail-meta-value">${new Date(log.timestamp).toLocaleString()}</span></div>
    </div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">📤 Request Headers</span><span class="detail-section-toggle">▼</span></div><div class="detail-section-content">${headersTable(log.requestHeaders)}</div></div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">📝 Request Body</span><button class="copy-btn" data-action="copy" data-text="${encodeURIComponent(log.requestBody || '')}">复制</button></div><div class="detail-section-content">${formatJson(log.requestBody)}</div></div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">📥 Response Headers</span><span class="detail-section-toggle">▼</span></div><div class="detail-section-content">${headersTable(log.responseHeaders)}</div></div>
    <div class="detail-section"><div class="detail-section-header" data-action="toggle"><span class="detail-section-title">📄 Response Body</span><button class="copy-btn" data-action="copy" data-text="${encodeURIComponent(log.responseBody || '')}">复制</button></div><div class="detail-section-content">${formatJson(log.responseBody)}</div></div>
  </div>`;
}

function handleLogByDomainRowClick(e) {
  const copyBtn = e.target.closest('[data-action="copy"]');
  if (copyBtn) { e.stopPropagation(); navigator.clipboard.writeText(decodeURIComponent(copyBtn.dataset.text || '')).then(() => { copyBtn.textContent = '已复制'; setTimeout(() => copyBtn.textContent = '复制', 1500); }); return; }
  const sectionHeader = e.target.closest('.detail-section-header[data-action="toggle"]');
  if (sectionHeader) { e.stopPropagation(); const content = sectionHeader.nextElementSibling; if (content) { content.classList.toggle('collapsed'); const t = sectionHeader.querySelector('.detail-section-toggle'); if (t) t.textContent = content.classList.contains('collapsed') ? '▶' : '▼'; } return; }
  const row = e.target.closest('.log-row');
  if (!row) return;
  const id = parseInt(row.dataset.id);
  expandedLogIdInDetail = expandedLogIdInDetail === id ? null : id;
  renderLogByDomainList();
}

function renderLogByDomainList() {
  const list = $('log-by-domain-list');
  const title = $('log-detail-title');
  if (title) title.textContent = selectedLogDomain ? `详细日志: ${selectedLogDomain}` : '按域名的详细日志';
  if (!selectedLogDomain) { list.innerHTML = '<div class="log-domain-empty">在左侧选择一个域名</div>'; return; }
  const arr = logs.filter(l => getPrimaryDomain(l.url) === selectedLogDomain).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (arr.length === 0) { list.innerHTML = '<div class="log-domain-empty">该域名暂无日志</div>'; return; }
  list.innerHTML = arr.map(log => {
    const statusClass = log.status >= 500 ? 'status-5xx' : log.status >= 400 ? 'status-4xx' : log.status >= 300 ? 'status-3xx' : 'status-2xx';
    const time = new Date(log.timestamp).toLocaleTimeString();
    const path = (() => { try { return new URL(log.url).pathname + new URL(log.url).search; } catch { return log.url; } })();
    const expanded = expandedLogIdInDetail === log.id;
    const detailHtml = expanded ? logRowDetailHtml(log) : '';
    return `<div class="log-row-wrap${expanded ? ' expanded' : ''}" data-id="${log.id}">
      <div class="log-row" data-id="${log.id}"><span class="log-row-expand">${expanded ? '▼' : '▶'}</span><span class="method-badge method-${log.method}">${log.method}</span><span class="status-badge ${statusClass}">${log.status}</span><span class="log-row-url" title="${escapeHtml(log.url)}">${escapeHtml(path)}</span><span class="log-row-time">${time}</span></div>
      ${detailHtml ? `<div class="log-row-detail">${detailHtml}</div>` : ''}
    </div>`;
  }).join('');
}

document.addEventListener('DOMContentLoaded', init);
