// XHR Logger - Content Script (消息转发 + 页面订阅检测)
(function() {
  'use strict';
  if (window.__XHR_LOGGER_CONTENT__) return;
  window.__XHR_LOGGER_CONTENT__ = true;
  
  // 监听来自主世界的消息，转发到 background
  window.addEventListener('message', function(event) {
    if (event.source !== window || event.data?.type !== 'XHR_LOGGER_CAPTURED') return;
    try {
      chrome.runtime.sendMessage({ type: 'LOG_CAPTURED', data: event.data.data });
    } catch (e) { /* extension context invalidated */ }
  });
  
  // 页面加载完成后检查页面订阅
  window.addEventListener('load', function() {
    setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: 'CHECK_PAGE_SUBSCRIPTION', url: location.href }, response => {
          if (response?.matched && response.subscription) {
            console.log(`[XHR Logger] 📌 页面订阅命中: ${response.subscription.name}，准备保存...`);
            const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\n' : '<!DOCTYPE html>\n';
            const html = doctype + document.documentElement.outerHTML;
            chrome.runtime.sendMessage({ type: 'SAVE_PAGE_HTML', url: location.href, html }, saveResponse => {
              if (saveResponse?.success) console.log('[XHR Logger] ✅ 页面已自动保存');
              else console.log('[XHR Logger] ❌ 页面保存失败:', saveResponse?.message);
            });
          }
        });
      } catch (e) { /* extension context invalidated */ }
    }, 1000);
  });
})();
