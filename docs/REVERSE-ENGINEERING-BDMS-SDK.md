# 汽水音乐（SodaMusic）BDMS 安全 SDK 逆向分析报告

> 本文档详细记录了对汽水音乐 PC 客户端 BDMS（ByteDance Machine Security）安全签名 SDK 的逆向分析过程，
> 包括问题定位、SDK 文件定位、多次失败尝试、最终突破以及完整的技术实现。

---

## 一、问题背景

### 1.1 现象

PopDownloader 项目的批量下载/单曲下载功能完全失效。调用汽水音乐上游 API `https://api.qishui.com/luna/pc/track_v2` 时：

- HTTP 状态码：200 OK
- 响应体：**0 字节**（空 body）
- Content-Type：`application/json`

而使用有效 session 调用其他接口（如 `/luna/pc/me`、`/luna/pc/me/playlist`）均能正常返回数据。

### 1.2 对比分析

| 接口 | 请求头 | 结果 |
|------|--------|------|
| `/luna/pc/me` | 仅 Cookie | ✅ 正常返回用户数据 |
| `/luna/pc/me/playlist` | 仅 Cookie | ✅ 正常返回歌单列表 |
| `/luna/pc/playlist/detail` | 仅 Cookie | ✅ 正常返回歌单详情 |
| `/luna/pc/track_v2` | 仅 Cookie | ❌ 返回空 body |
| `/luna/pc/video_v2` | 仅 Cookie | ⚠️ 返回错误码 1000062 |

**结论**：`track_v2` 接口需要额外的反爬虫签名头。

---

## 二、SDK 文件定位

### 2.1 安装目录结构

```
C:\Users\xiaoli\AppData\Local\Programs\Soda Music\3.5.1\
├── SodaMusic.exe                    ← Electron 主程序（36.4.0-rs.29 定制版）
├── resources\
│   ├── app.asar                     ← Electron 主应用（36MB）
│   ├── app.asar.unpacked\           ← 解包的原生模块
│   │   ├── bdms.node       (164KB) ← 🔑 核心安全模块
│   │   ├── metasecml.dll   (8.8MB) ← 底层加密库
│   │   ├── device.node              ← 设备指纹模块
│   │   ├── bdticket.node            ← 票据模块
│   │   └── ttnet.node               ← 网络模块
│   └── main.asar                    ← 前端渲染代码
│       └── assets\
│           └── fws.esm-*.js         ← Frontier WebSocket SDK
└── data\
    └── icudtl.dat                   ← Unicode 数据
```

### 2.2 bdms.node 导出函数

```javascript
// 通过 Node.js require() 加载后查看
const bdms = require('.../app.asar.unpacked/bdms.node')
console.log(Object.keys(bdms))
// → [ 'init', 'generateHttpSignatureHeaders', 'report' ]
```

| 函数 | 用途 |
|------|------|
| `init(options)` | 初始化 SDK，设置设备指纹等上下文 |
| `generateHttpSignatureHeaders(url, headersStr)` | 为 HTTP 请求生成签名头 |
| `report(event)` | 上报事件数据 |

---

## 三、抓包分析：确认签名头

### 3.1 SodaMusic 客户端请求头

通过 ProxyPin 抓取汽水音乐客户端的实际 HTTP 请求，发现以下关键头：

```
POST https://api.qishui.com/luna/pc/track_v2?aid=386088&... HTTP/2
content-length: 106
x-helios: O2UAAAZFEmoFjWrDQyDjeTa7TYgCA5kISapKYeOsVUX1SgGc
x-medusa: qUOQal2rz5B9lExRfGlYGv2M8XL3WwMBw7cHZCDAMUA2mQVz88InuLBpnJLWHB5jP...
x-ss-stub: D39033A0DD54C62EBD5CB2FB569D1566
content-type: application/json; charset=utf-8
user-agent: LunaPC/3.7.0(452316191)
cookie: sessionid=910e7ab0e427f869072e4b86b6fd8f4d; ...
```

### 3.2 头部对比测试

| 测试条件 | 结果 |
|----------|------|
| 不带签名头 | 200 OK，**0 字节** |
| 带签名头 + 正确 track_id | 200 OK，**18KB+ 完整数据** |
| 带签名头 + 不同 track_id | 200 OK，空 body（签名绑定了请求体） |

**确认：`x-helios` 和 `x-medusa` 是反爬虫签名，必须存在才能获取响应数据。**

### 3.3 x-medusa 二进制分析

```javascript
// Base64 解码后分析
const decoded = Buffer.from(xMedusa, 'base64')
// 长度：652 字节
// 首字节：0xA9（不是标准 protobuf 开头）
// Shannon 信息熵：7.688 bits/byte（接近最大值 8.0）→ 加密数据
// 字节分布极度均匀 → 典型加密特征
// 结论：AES-GCM 或类似 AEAD 加密后的密文 + 认证标签
```

### 3.4 x-helios 分析

```javascript
const decoded = Buffer.from(xHelios, 'base64')
// 长度：36 字节
// 前 4 字节：3B 65 00 00（包含 ASCII 字符和零字节）
// 熵值偏低（4.89）→ 前几字节包含结构化数据（版本/标志）
// 结论：轻量级设备/会话标识令牌
```

---

## 四、逆向尝试历程

### 4.1 尝试一：独立 Node.js 加载 bdms.node

```bash
node -e "const bdms = require('.../bdms.node'); bdms.init();"
```

**结果**：❌ 崩溃
```
FATAL ERROR: Error::New napi_get_last_error_info
```

**原因**：`init()` 没有传入正确参数，内部提取 `deviceId` 属性时得到 `undefined`，
然后尝试用 `napi_get_last_error_info` 创建错误对象时触发崩溃。

### 4.2 尝试二：标准 Electron 36.4.0 加载

```bash
npx electron --no-sandbox bdms-server.js
```

**结果**：❌ 同样崩溃（相同 N-API 错误）

**原因**：SodaMusic 使用的是字节跳动定制版 Electron（`36.4.0-rs.29`），
标准 Electron 的 N-API 实现有差异。

### 4.3 尝试三：koffi FFI 调用 metasecml.dll

```javascript
const koffi = require('koffi')
const lib = koffi.load('.../metasecml.dll')
// 尝试调用导出函数
```

**结果**：❌ 无法使用

`metasecml.dll` 只有 3 个混淆导出函数：
- `MSBridgeML`（地址 0x1d010）
- `MSBridgeOV`（地址 0x1d010，与上一个相同）
- `o0o0`（地址 0x191c0）

无法理解其参数格式和功能。

### 4.4 尝试四：下载汽水音乐 3.7.0 提取

**结果**：❌ NSIS 安装包嵌套打包，提取过程过于复杂

### 4.5 尝试五：启动 SodaMusic + --remote-debugging-port

**结果**：❌ SodaMusic 的定制 Electron 不支持此参数

---

## 五、突破性发现

### 5.1 社区逆向资源

搜索到的关键资源：

1. **GitHub: `huaerxiela/douyin-algorithm`** — 包含 X-Helios、X-Medusa 六神算法分析
2. **CSDN 博客** — 多篇详细讲解 `bdms.init` 调用方式的文章
3. **字节跳动安全体系** — 被社区称为"六神算法"：
   - X-Argus / X-Gorgon / X-Khronos / X-Ladon / **X-Helios** / **X-Medusa**

### 5.2 从 sourcemap 逆向的完整调用链

汽水音乐的 `main.asar` 中包含了 `.js.map` sourcemap 文件，
从中提取到了 `addons/bdms/index.js` 的源码：

```javascript
// 1. 初始化 SDK
bdms.init({ deviceId: deviceData.did ?? fakeDid })

// 2. 构建签名头
const headerLines = []
for (const [key, values] of Object.entries(headers)) {
  for (const value of values) {
    headerLines.push(`${key}\r\n${value}`)
  }
}

// 3. 生成签名
const result = bdms.generateHttpSignatureHeaders(
  params.url,
  headerLines.join('\r\n')
)

// 4. 解析结果（\r\n 分隔的 key-value 对）
const signatureData = result.split('\r\n').filter(t => t.trim())
for (let i = 0; i < signatureData.length / 2; i++) {
  headers[signatureData[i * 2]] = [signatureData[i * 2 + 1]]
}
```

### 5.3 关键参数

| 参数 | 值 | 来源 |
|------|-----|------|
| `deviceId` | `2117006317868281` | 抓包请求 URL 参数 |
| `user-agent` | `LunaPC/3.7.0(452316191)` | 抓包请求头 |
| `version_name` | `3.7.0` | 版本配置 |
| `version_code` | `30070000` | 版本配置 |

---

## 六、最终验证

### 6.1 正确的 init() 调用

```javascript
const BDMS_PATH = 'C:/Users/.../app.asar.unpacked/bdms.node'
const METASECML_DIR = 'C:/Users/.../app.asar.unpacked'

// 确保 metasecml.dll 在 PATH 中
process.env.PATH = METASECML_DIR + ';' + (process.env.PATH || '')

const bdms = require(BDMS_PATH)

// ✅ 正确的初始化方式
bdms.init({ deviceId: '2117006317868281' })
```

### 6.2 签名头生成

```javascript
// headers 格式：每个 header 用 \r\n 分隔 key 和 value
function buildHeadersString(headers) {
  const lines = []
  for (const [key, values] of Object.entries(headers)) {
    for (const value of (Array.isArray(values) ? values : [values])) {
      lines.push(`${key}\r\n${value}`)
    }
  }
  return lines.join('\r\n')
}

const url = 'https://api.qishui.com/luna/pc/track_v2?aid=386088&...'
const headersStr = buildHeadersString({
  'content-type': 'application/json; charset=utf-8',
  'user-agent': 'LunaPC/3.7.0(452316191)',
  'accept-encoding': 'gzip, deflate',
})

const result = bdms.generateHttpSignatureHeaders(url, headersStr)
// result: "X-Helios\r\n<48字符签名>\r\nX-Medusa\r\n<872字符加密载荷>"
```

### 6.3 测试结果

```
✅ init({ deviceId: '2117006317868281' }) 成功
✅ generateHttpSignatureHeaders 返回签名头：
   X-Helios: 4EgAAO3JufRXfjlL3EvtIaimPAFhc9XwedBqp3U80BNbyz78 (48 chars)
   X-Medusa: jASRanjszpBY001RWS5ZGtjL8HKpfAMBybcmEwBAIVY2GWyx... (872 chars)

✅ 使用签名头调用 track_v2 API：
   Track name: 芸芸
   Has track_player: true
   Has video_model: true (9178 bytes, 5 种音质)
   Has main_url + encrypt_info: true
```

---

## 七、集成到 PopDownloader

### 7.1 bdms-signer.js 模块

```javascript
// server/utils/bdms-signer.js
const BDMS_NODE_PATH = path.join(SODAMUSIC_PATH, 'resources', 'app.asar.unpacked', 'bdms.node')
const METASECML_DIR = path.join(SODAMUSIC_PATH, 'resources', 'app.asar.unpacked')

function initSigner(deviceId) {
  process.env.PATH = METASECML_DIR + ';' + (process.env.PATH || '')
  const bdms = require(BDMS_NODE_PATH)
  bdms.init({ deviceId })
}

function generateSignatureHeaders(url, existingHeaders) {
  const headersStr = buildHeadersString(existingHeaders)
  const result = bdms.generateHttpSignatureHeaders(url, headersStr)
  return parseSignatureResult(result)  // { 'X-Helios': '...', 'X-Medusa': '...' }
}
```

### 7.2 API 请求中使用签名

```javascript
// server/utils/track-download.js
const sigHeaders = generateSignatureHeaders(trackV2Url, {
  'content-type': 'application/json; charset=utf-8',
  'user-agent': 'LunaPC/3.7.0(452316191)',
  'accept-encoding': 'gzip, deflate',
})

const response = await fetchWithTimeout(trackV2Url, {
  method: 'POST',
  headers: {
    Cookie: `sessionid=${sessionid};`,
    'User-Agent': 'LunaPC/3.7.0(452316191)',
    ...sigHeaders,  // ← 关键：添加 X-Helios + X-Medusa
  },
  body: requestBody,
})
```

---

## 八、技术总结

### 8.1 签名生成架构

```
PopDownloader 后端
  │
  ├── bdms-signer.js
  │     ├── require(bdms.node)          ← 加载原生模块
  │     ├── bdms.init({ deviceId })     ← 初始化（只需一次）
  │     └── bdms.generateHttpSignatureHeaders(url, headersStr)
  │           │
  │           ├── metasecml.dll          ← 底层加密实现
  │           └── 返回 "X-Helios\r\n...\r\nX-Medusa\r\n..."
  │
  └── track-download.js / track-v2.js
        └── fetchWithTimeout(url, { headers: { ...sigHeaders } })
              │
              └── → api.qishui.com/luna/pc/track_v2
                    → 返回完整 track 数据（含 video_model 下载 URL）
```

### 8.2 依赖关系

```
bdms.node (164KB N-API 模块)
  ├── 依赖 metasecml.dll (8.8MB) — 底层加密
  ├── 依赖 device.device — 设备指纹
  └── 依赖 SodaMusic PC 客户端环境
        ├── Windows 系统（仅 Windows 可用）
        └── SodaMusic 安装目录中的原生模块
```

### 8.3 限制

- **仅支持 Windows** — bdms.node 依赖 SodaMusic 的 Windows 原生模块
- **依赖 SodaMusic 安装** — 需要汽水音乐 PC 客户端已安装在系统上
- **deviceId 绑定** — 签名头与设备 ID 绑定，不同设备需要不同的 deviceId
- **版本依赖** — 签名算法可能随汽水音乐版本更新而变化

---

## 附录：关键文件清单

| 文件 | 位置 | 用途 |
|------|------|------|
| bdms.node | `resources/app.asar.unpacked/bdms.node` | 核心签名模块 |
| metasecml.dll | `resources/app.asar.unpacked/metasecml.dll` | 底层加密库 |
| bdms-signer.js | `server/utils/bdms-signer.js` | PopDownloader 签名封装 |
| track-download.js | `server/utils/track-download.js` | 使用签名的下载逻辑 |
| track-v2.js | `server/apis/track-v2.js` | 使用签名的 API 代理 |
| main.js.map | `resources/main.asar/assets/main-*.js.map` | sourcemap（含 BDMS 调用源码） |

---

*文档版本：1.0 | 创建日期：2026-08-28*
