# TODO

1. 从看板以多选的方式导出选择的请求内容
2. 再订阅管理的时候，对订阅增加开关，开启的菜上报
3. 启用与本地WS服务的通信，与上报一个功能域


# XHR Logger

一个 Chrome/Edge 浏览器扩展插件，用于捕获和保存网页的 XHR 和 Fetch 请求数据。

## 功能特性

- ✅ **透明拦截** - 完全不影响原网页的请求执行
- ✅ **全面捕获** - 拦截所有 XMLHttpRequest 和 Fetch 请求
- ✅ **详细记录** - 记录完整的请求/响应信息（URL、方法、头、体、状态等）
- ✅ **自动保存** - 每 5 分钟自动保存到本地 JSONL 文件
- ✅ **手动保存** - 随时可手动触发保存
- ✅ **内存缓存** - 仅在内存中临时缓存，自动保存后清空
- ✅ **JSONL 格式** - 每行一条 JSON，便于处理和分析
- ✅ **CSP 兼容** - 兼容严格的内容安全策略（CSP）

## 安装步骤

### 方法一：开发者模式加载（推荐）

1. 打开 Chrome/Edge 浏览器
2. 访问扩展管理页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
3. 开启右上角的 **"开发者模式"**
4. 点击 **"加载已解压的扩展程序"**
5. 选择本项目的 `xhr-logger` 文件夹
6. 完成！插件图标会出现在浏览器工具栏

### 方法二：打包安装

1. 在扩展管理页面点击 **"打包扩展程序"**
2. 选择本项目文件夹
3. 生成 `.crx` 文件后拖入浏览器安装

## 使用说明

### 基本使用

1. **安装后自动运行** - 插件会自动开始捕获所有网页的请求
2. **查看状态** - 点击工具栏的插件图标，查看已捕获的日志数量
3. **自动保存** - 每 5 分钟自动保存到本地文件并清空缓存
4. **手动保存** - 点击"立即保存"按钮可随时保存

### 功能按钮

- **💾 立即保存** - 手动触发保存当前缓存的日志
- **👁️ 查看日志** - 在浏览器控制台中查看详细日志
- **🗑️ 清空日志** - 清空当前内存中的日志（慎用）

### 键盘快捷键

- `Ctrl/Cmd + S` - 立即保存
- `Ctrl/Cmd + L` - 查看日志

### 保存的文件

- **文件位置** - 浏览器默认下载目录
- **文件名格式** - `xhr-logs-2025-12-19_10-30-45.jsonl`
- **文件格式** - JSONL（每行一条 JSON）

## 数据格式

每条日志的 JSON 结构：

```json
{
  "id": 0,
  "type": "XHR",
  "method": "GET",
  "url": "https://api.example.com/data",
  "requestHeaders": {
    "Content-Type": "application/json"
  },
  "requestBody": null,
  "status": 200,
  "statusText": "OK",
  "responseHeaders": {
    "content-type": "application/json"
  },
  "responseBody": "{\"result\":\"success\"}",
  "startTime": 1734595200000,
  "endTime": 1734595201000,
  "duration": 1000,
  "tabId": 123,
  "tabUrl": "https://example.com",
  "timestamp": "2025-12-19T02:30:45.123Z"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 日志序号 |
| `type` | string | 请求类型（"XHR" 或 "Fetch"） |
| `method` | string | HTTP 方法（GET、POST 等） |
| `url` | string | 请求的完整 URL |
| `requestHeaders` | object | 请求头 |
| `requestBody` | string | 请求体内容 |
| `status` | number | HTTP 状态码 |
| `statusText` | string | 状态文本 |
| `responseHeaders` | object | 响应头 |
| `responseBody` | string | 响应体内容 |
| `startTime` | number | 请求开始时间戳（毫秒） |
| `endTime` | number | 请求结束时间戳（毫秒） |
| `duration` | number | 请求耗时（毫秒） |
| `tabId` | number | 浏览器标签页 ID |
| `tabUrl` | string | 当前页面 URL |
| `timestamp` | string | ISO 格式时间戳 |

## 技术架构

### 组件说明

```
┌─────────────────┐
│   网页 (Page)    │
│  XHR / Fetch    │
└────────┬────────┘
         │ 透明拦截
         ↓
┌─────────────────┐
│  content.js     │
│  拦截请求/响应   │
└────────┬────────┘
         │ sendMessage
         ↓
┌─────────────────┐
│  background.js  │
│  内存缓存       │
│  5分钟定时器    │
└────────┬────────┘
         │ chrome.downloads
         ↓
┌─────────────────┐
│  本地 JSONL 文件 │
└─────────────────┘
```

### 核心技术

1. **Content Script（隔离世界）**
   - 在 `document_start` 时注入
   - 重写 `window.XMLHttpRequest` 和 `window.fetch`
   - 透明拦截，不影响原请求执行

2. **Background Service Worker**
   - 维护内存中的日志数组
   - 使用 `setInterval` 实现 5 分钟定时器
   - 使用 `chrome.downloads` API 保存文件

3. **Popup 界面**
   - 实时显示日志数量和倒计时
   - 提供手动保存和清空功能
   - 使用 `chrome.runtime.sendMessage` 与 background 通信

### CSP 兼容性

本插件使用 **Content Script 隔离世界**，即使网页有严格的 CSP（如 `script-src 'self'`），插件仍能正常工作。

原因：
- Content Script 在隔离世界运行，不受页面 CSP 限制
- 对 `window` 对象的修改会影响主世界
- 因此能成功拦截所有请求

## 开发调试

### 查看日志

1. **Content Script 日志**
   - 打开网页，按 F12 打开开发者工具
   - 查看 Console 标签
   - 过滤 `[XHR Logger]` 前缀

2. **Background 日志**
   - 访问 `chrome://extensions/`
   - 找到 XHR Logger，点击 "Service Worker"
   - 在打开的控制台中查看日志

3. **Popup 日志**
   - 右键点击插件图标
   - 选择"检查弹出内容"
   - 查看 Console

### 测试建议

1. 访问任意网站（如 GitHub、Google）
2. 观察控制台是否有拦截日志
3. 点击插件图标查看捕获数量
4. 测试保存功能
5. 打开保存的 JSONL 文件验证数据

## 注意事项

1. **自动保存** - 每 5 分钟自动保存，无需手动操作
2. **内存限制** - 日志仅在内存中缓存，保存后清空
3. **二进制数据** - 二进制响应会标记为 `[Binary or unreadable response]`
4. **隐私安全** - 所有数据仅保存在本地，不上传任何服务器
5. **性能影响** - 拦截操作已优化，对页面性能影响极小

## 常见问题

### Q: 为什么看不到日志？
A: 确保：
- 插件已启用
- 当前网页有 XHR/Fetch 请求
- 查看控制台是否有 `[XHR Logger]` 日志

### Q: 自动保存的文件在哪里？
A: 在浏览器的默认下载目录，文件名格式为 `xhr-logs-{时间}.jsonl`

### Q: JSONL 文件如何打开？
A: 
- 使用文本编辑器打开
- 每行是一条独立的 JSON
- 可用 Python、Node.js 等工具解析

### Q: 会影响网页性能吗？
A: 影响极小。拦截操作非常轻量，数据收集是异步的，不阻塞原请求。

## 许可证

MIT License

Copyright (c) 2025 XHR Logger

本项目开源免费，欢迎使用和改进。

## 更新日志

### v1.0.0 (2025-12-19)
- ✨ 首次发布
- ✅ 支持 XHR 和 Fetch 拦截
- ✅ 5 分钟自动保存
- ✅ JSONL 格式导出
- ✅ 现代化 UI 界面

