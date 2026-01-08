// XHR Logger - Popup Script
document.addEventListener('DOMContentLoaded', function() {
  const messageEl = document.getElementById('message');
  const dashboardBtn = document.getElementById('dashboard-btn');
  const saveHtmlBtn = document.getElementById('save-html-btn');
  const subscribePageBtn = document.getElementById('subscribe-page-btn');
  
  const showMessage = (text, type = 'info') => {
    messageEl.textContent = text;
    messageEl.className = `message message-${type}`;
    setTimeout(() => { messageEl.className = 'message'; }, 3000);
  };
  
  // 打开 Dashboard
  dashboardBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    window.close();
  });
  
  // 保存页面源码（渲染后的 HTML）
  saveHtmlBtn.addEventListener('click', async () => {
    saveHtmlBtn.disabled = true;
    saveHtmlBtn.innerHTML = '<span class="btn-icon">⏳</span><span>获取中...</span>';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\n' : '<!DOCTYPE html>\n';
          return doctype + document.documentElement.outerHTML;
        }
      });
      const title = (tab.title || 'page').replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${title}_${timestamp}.html`;
      const comment = `<!-- Source: ${tab.url} -->\n<!-- Saved: ${new Date().toLocaleString()} -->\n`;
      const content = comment + result;
      const base64 = btoa(unescape(encodeURIComponent(content)));
      chrome.downloads.download({ url: `data:text/html;base64,${base64}`, filename, saveAs: true }, downloadId => {
        if (downloadId) showMessage('页面源码已保存！', 'success');
        else showMessage('保存失败', 'error');
      });
    } catch (e) { showMessage(`错误: ${e.message}`, 'error'); }
    saveHtmlBtn.disabled = false;
    saveHtmlBtn.innerHTML = '<span class="btn-icon">📄</span><span>保存页面源码</span>';
  });
  
  // 添加当前页面到订阅（默认填入查询参数）
  subscribePageBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = new URL(tab.url);
      const subscription = {
        name: tab.title || url.hostname,
        description: '',
        type: 'page',
        matchMode: 'exact',
        urlPattern: url.origin + url.pathname,
        queryPattern: url.search ? url.search.slice(1) : '',
        method: '',
        reportEnabled: true
      };
      chrome.runtime.sendMessage({ type: 'ADD_SUBSCRIPTION', subscription }, response => {
        if (response?.success) showMessage('页面已添加到订阅！', 'success');
        else showMessage(response?.message || '添加失败', 'error');
      });
    } catch (e) { showMessage(`错误: ${e.message}`, 'error'); }
  });
  
  // 快捷键
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); dashboardBtn.click(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveHtmlBtn.click(); }
  });
});
