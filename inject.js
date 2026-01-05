// XHR Logger - Inject Script (完整版)
(function() {
  'use strict';
  if (window.__XHR_LOGGER_HOOKED__) return;
  window.__XHR_LOGGER_HOOKED__ = true;
  
  let logId = 0;
  const MAX_SIZE = 512 * 1024;
  const sendLog = data => { try { window.postMessage({ type: 'XHR_LOGGER_CAPTURED', data }, '*'); } catch {} };
  const truncate = (s, max) => s && s.length > max ? s.slice(0, max) + '...[truncated]' : s;
  const isTextContent = ct => !ct || /json|text|xml|javascript|html|css|svg|urlencoded/.test(ct);
  const toAbsoluteUrl = url => { try { return new URL(url, location.href).href; } catch { return url; } };
  const parseHeaders = h => {
    const result = {};
    if (h instanceof Headers) h.forEach((v, k) => { result[k] = v; });
    else if (typeof h === 'object' && h) Object.assign(result, h);
    return result;
  };

  // ==================== Fetch ====================
  const OrigFetch = window.fetch;
  window.fetch = function(input, init) {
    const id = logId++, start = Date.now();
    let url = '', method = 'GET', reqHeaders = {}, reqBody = null;
    
    try {
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else if (input instanceof Request) {
        url = input.url; method = input.method;
        input.headers.forEach((v, k) => { reqHeaders[k] = v; });
      }
      url = toAbsoluteUrl(url); // 转换为绝对 URL
      if (init?.method) method = init.method;
      if (init?.headers) Object.assign(reqHeaders, parseHeaders(init.headers));
      if (init?.body != null) reqBody = typeof init.body === 'string' ? truncate(init.body, MAX_SIZE) : '[Body]';
    } catch {}

    return OrigFetch.apply(this, arguments).then(response => {
      const duration = Date.now() - start;
      const respHeaders = {};
      response.headers.forEach((v, k) => { respHeaders[k] = v; });
      const contentType = response.headers.get('content-type') || '';
      
      if (isTextContent(contentType)) {
        response.clone().text().then(text => {
          sendLog({
            id, type: 'Fetch', method: method.toUpperCase(), url,
            requestHeaders: reqHeaders, requestBody: reqBody,
            status: response.status, statusText: response.statusText,
            responseHeaders: respHeaders, responseBody: truncate(text, MAX_SIZE),
            duration, tabUrl: location.href, timestamp: new Date().toISOString()
          });
        }).catch(() => {
          sendLog({
            id, type: 'Fetch', method: method.toUpperCase(), url,
            requestHeaders: reqHeaders, requestBody: reqBody,
            status: response.status, statusText: response.statusText,
            responseHeaders: respHeaders, responseBody: '[读取失败]',
            duration, tabUrl: location.href, timestamp: new Date().toISOString()
          });
        });
      } else {
        sendLog({
          id, type: 'Fetch', method: method.toUpperCase(), url,
          requestHeaders: reqHeaders, requestBody: reqBody,
          status: response.status, statusText: response.statusText,
          responseHeaders: respHeaders, responseBody: `[${contentType || 'binary'}]`,
          duration, tabUrl: location.href, timestamp: new Date().toISOString()
        });
      }
      return response;
    }).catch(error => {
      sendLog({
        id, type: 'Fetch', method: method.toUpperCase(), url,
        requestHeaders: reqHeaders, requestBody: reqBody,
        status: 0, statusText: 'Error',
        responseHeaders: {}, responseBody: error.message,
        duration: Date.now() - start, tabUrl: location.href, timestamp: new Date().toISOString()
      });
      throw error;
    });
  };

  // ==================== XHR ====================
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;
  const origSetHeader = OrigXHR.prototype.setRequestHeader;
  
  OrigXHR.prototype.open = function(method, url) {
    this.__xhrId = logId++;
    this.__xhrMethod = method || 'GET';
    this.__xhrUrl = toAbsoluteUrl(url); // 转换为绝对 URL
    this.__xhrStart = Date.now();
    this.__xhrReqHeaders = {};
    return origOpen.apply(this, arguments);
  };
  
  OrigXHR.prototype.setRequestHeader = function(name, value) {
    if (this.__xhrReqHeaders) this.__xhrReqHeaders[name] = value;
    return origSetHeader.apply(this, arguments);
  };
  
  OrigXHR.prototype.send = function(body) {
    const xhr = this;
    xhr.__xhrReqBody = body != null ? (typeof body === 'string' ? truncate(body, MAX_SIZE) : '[Body]') : null;
    
    xhr.addEventListener('load', function() {
      let respBody = '[无法读取]', respHeaders = {};
      try {
        const headerStr = xhr.getAllResponseHeaders();
        if (headerStr) {
          headerStr.split('\r\n').forEach(line => {
            const idx = line.indexOf(': ');
            if (idx > 0) respHeaders[line.slice(0, idx).toLowerCase()] = line.slice(idx + 2);
          });
        }
        const ct = respHeaders['content-type'] || '';
        if (isTextContent(ct) && (!xhr.responseType || xhr.responseType === 'text' || xhr.responseType === 'json')) {
          if (xhr.responseType === 'json' && xhr.response != null) {
            respBody = truncate(JSON.stringify(xhr.response), MAX_SIZE);
          } else {
            respBody = truncate(xhr.responseText, MAX_SIZE);
          }
        } else {
          respBody = `[${xhr.responseType || ct || 'binary'}]`;
        }
      } catch {}
      
      sendLog({
        id: xhr.__xhrId, type: 'XHR', method: xhr.__xhrMethod.toUpperCase(), url: xhr.__xhrUrl,
        requestHeaders: xhr.__xhrReqHeaders || {}, requestBody: xhr.__xhrReqBody,
        status: xhr.status, statusText: xhr.statusText,
        responseHeaders: respHeaders, responseBody: respBody,
        duration: Date.now() - xhr.__xhrStart, tabUrl: location.href, timestamp: new Date().toISOString()
      });
    });
    
    xhr.addEventListener('error', function() {
      sendLog({
        id: xhr.__xhrId, type: 'XHR', method: xhr.__xhrMethod.toUpperCase(), url: xhr.__xhrUrl,
        requestHeaders: xhr.__xhrReqHeaders || {}, requestBody: xhr.__xhrReqBody,
        status: 0, statusText: 'Network Error',
        responseHeaders: {}, responseBody: '[网络错误]',
        duration: Date.now() - xhr.__xhrStart, tabUrl: location.href, timestamp: new Date().toISOString()
      });
    });
    
    return origSend.apply(this, arguments);
  };
  
  console.log('[XHR Logger] Hook active (full mode)');
})();
