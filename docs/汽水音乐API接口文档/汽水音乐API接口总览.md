# 汽水音乐 API 接口总览

面向 SodaMusic-Download 开发者，说明汽水音乐 PC 客户端上游接口的域名、前缀、鉴权、公共参数与文档导航。

---

## 一、域名与业务前缀

### 1.1 主域名

| 域名 | 用途 |
|------|------|
| `https://api.qishui.com` | 主业务 API。PC 客户端绝大多数 goapi 接口拼在此域名下 |
| conf.qishui.com | 配置下发（客户端设置/开关类） |
| bff-pc.qishui.com | PC BFF 聚合层 |
| aweme.snssdk.com / i.snssdk.com | 字节系账号与内容相关联调 |
| sso.bytedance.com | 字节 SSO |
| pc-mon / mon.zijieapi.com | 埋点与监控 |
| vcs / verify / mcs.zijieapi.com | 验证码与风控相关服务 |

HTTP DNS：客户端启动时配置 `dig.bdurl.net`（见 `src/app.ts`）。

### 1.2 业务路径前缀

| 前缀 | 说明 |
|------|------|
| `/luna/pc/*` | PC 优先路径。客户端 `apiCaller` 优先选择以 `/luna/pc/` 开头且 method 匹配的路径 |
| `/luna/*` | 通用 goapi 路径，H5/移动端与 PC 共用 |
| `/luna/h5/*` | H5/分享页变体 |
| `/passport/*` | 账号认证（扫码、token 心跳） |
| `/service/*` | 服务类辅助接口（extract 中可见前缀，具体 path 以 sourcemap 为准） |
| `/feedback/*` | 反馈相关 |
| `/webcast/*` | 直播相关零信任加签路径 |
| `/seo_api/*` | SEO 友链模板 |

接口总量：`logs/asar-extract/api-endpoints-precise.json` 共 **412** 条 method/path/fn 记录。

---

## 二、鉴权

### 2.1 会话 Cookie

| 项 | 值 |
|----|-----|
| 关键 Cookie | `sessionid` |
| 作用域 | 域 `.qishui.com` |
| 可选关联 | `sessionid_ss`（BDTicket 零信任加签会读取） |
| PC 本机持久化 | `%AppData%\Roaming\SodaMusic\Network\Cookies`（Chromium SQLite） |
| 登录失效业务码 | `status_code = 1000016`（客户端会清空用户态） |

请求时在 Header 中带：`Cookie: sessionid=<value>`。

### 2.2 签名与风控头

| 机制 | 头/组件 | 说明 |
|------|---------|------|
| BDMS 签名 | `X-Helios` / `X-Medusa` | 由 `bdms.node` 生成；对 `qishui.com` 业务请求生效（`/passport/`、`/ttwid/` 除外） |
| 请求体摘要 | `X-SS-STUB` | body 的 MD5（大写十六进制），TTNet 发送前补齐 |
| 零信任 BDTicket | 额外签名头 | 仅对白名单路径加签 |
| 风控验证 | 响应头 `bdturing-verify` | 客户端弹出验证码窗口后重试 |
| 二次验证 | 响应头 `x-tt-verify-passport-decision` | 客户端触发二次验证后重试 |

详细机制见 [安全签名与公共机制](./安全签名与公共机制.md)。

### 2.3 哪些接口需要 Cookie / 签名

| 类别 | Cookie | BDMS 签名 | 备注 |
|------|--------|-----------|------|
| `/passport/web/get_qrcode/`、`check_qrconnect/` | 否 | 否 | 登录前后均可调 |
| `/luna/pc/me`、歌单、收藏、playlist/detail | 是 | 可选 | 本项目实测仅 Cookie 可返回数据 |
| `/luna/pc/track_v2` | 是 | **必须** | 无签名时 HTTP 200 + 空 body |
| `/luna/pc/video_v2` | 是 | **建议** | 无签名实测可返回 1000062 |
| `/luna/pc/mcheck`、`/luna/mcheck` | 是 | 建议 | 媒体可用性检查，下载流程相关 |
| BDTicket 白名单路径 | 是 | 是 | 另需零信任头，见安全文档 |

---

## 三、公共 query 参数

客户端 `getTTCommonParams()`（`src/services/request/request.ts`）会拼进几乎所有业务请求：

| 参数 | PC 客户端取值 | 本项目固定示例 |
|------|----------------|----------------|
| `aid` | APP_ID | `386088` |
| `app_name` | `luna_pc` | `luna_pc` |
| `region` / `geo_region` / `os_region` | `cn` | `cn` |
| `sim_region` | 空 | 空 |
| `device_id` | 全局配置 deviceId | 逆向样本 `2117006317868281` |
| `iid` | 全局配置 installId | `27960026095955` |
| `version_name` | APP_VERSION | `3.7.0` |
| `version_code` | APP_VERSION_CODE | `30070000` |
| `channel` | 安装渠道 | `official` |
| `build_mode` | APP_BRANCH | `master` |
| `ac` | 网络类型 | `wifi` |
| `tz_name` | 系统时区 | `Asia/Shanghai` |
| `device_platform` | `windows` / `mac` | `windows` |
| `device_type` | `Windows` / `MacOS` | `Windows` |
| `os_version` | `os.version()` | 视本机 |
| `fp` | deviceId 同源 | 与 `device_id` 一致 |

PC 请求附加 Header（非必须业务逻辑，但与客户端行为一致）：

| Header | 含义 |
|--------|------|
| `User-Agent` | `LunaPC/{version}({TRON_BUILD_ID})`，例：`LunaPC/3.7.0(452316191)` |
| `x-luna-background-type` | `foreground` / `minimize` / `blur` |
| `x-luna-is-background-req` | 前台 `0` / 后台 `1` |
| `x-luna-is-local-user` | 本地有登录态 `1` / 无 `0` |

---

## 四、业务状态码

| status_code | 含义 | 客户端/本项目处理 |
|-------------|------|-------------------|
| `0` | 成功 | 正常解析业务字段 |
| `1000016` | 登录失效 | 客户端清空用户信息缓存；本项目要求重新登录 |
| `1000062` | 权限/签名相关错误（video_v2 无签名样本） | 检查 Cookie 与 BDMS 签名 |
| 其他非 0 | 业务失败 | 读 `status_info.status_msg` 或 `message` |

说明：HTTP 仍可能为 200，业务失败体现在 body 的 `status_code`。部分接口（尤其 track_v2）在签名缺失时返回 **HTTP 200 + 空 body**。

响应中常见 `status_info`：`log_id`、`now`（服务端秒级时间）、`now_ts_ms`、`status_msg`。客户端用 `now` 同步本地时钟。

---

## 五、接口分组导航

本目录：`docs/汽水音乐API接口文档/`

| 分组 | 文档 | 典型路径 |
|------|------|----------|
| 总览（本文） | 汽水音乐API接口总览.md | — |
| 认证与登录 | [认证与登录接口](./认证与登录接口.md) | `/passport/web/*`、`/luna/sso/token`、本机 Cookies |
| 用户 / 歌单 / 收藏 | [用户歌单与收藏接口](./用户歌单与收藏接口.md) | `/luna/pc/me*`、`/luna/pc/playlist/detail` |
| 曲目 / 视频 / 媒体 | [曲目视频与媒体接口](./曲目视频与媒体接口.md) | `/luna/pc/track_v2`、`/luna/pc/video_v2`、`/luna/pc/mcheck` |
| 搜索 / 发现 / 内容 | [搜索发现与内容接口](./搜索发现与内容接口.md) | `/luna/pc/search/*`、`/luna/pc/discover`、album/artist/chart |
| 评论 / 商业化 / 社交 | [评论商业化与社交接口](./评论商业化与社交接口.md) | comments、commerce、live、im |
| 安全与公共机制 | [安全签名与公共机制](./安全签名与公共机制.md) | BDMS、BDTicket、设备、风控 |
| 本项目代理对照 | [本项目本地代理接口对照](./本项目本地代理接口对照.md) | `/api/*` → 上游映射 |
| 随机播放机制 | [汽水音乐随机播放机制](../汽水音乐随机播放机制.md) | feed/song-tab、radio/tracks、playlist/feed/media |

---

## 六、调用约定速查

1. **Method**：PC 路径存在 GET/POST 双份时，客户端 `idlMethods` 与 goapi path 表会对齐；`track_v2` 实际走 POST + JSON body。
2. **PC 优先**：`data.paths` 中优先取 `/luna/pc/` + 匹配 method，否则取任意匹配 method，否则取第一条。
3. **POST 时**：query 与 body 同名字段以 body 为准（客户端会从 query 删除已出现在 body 的 key）。
4. **分页**：大量列表接口使用 `cursor` + `count`，响应返回 `next_cursor` / `has_more`。
5. **歌词**：无独立 lyric API；`track_v2` / `track` 响应的 `lyric` 字段携带歌词（IDL `TrackIncludeLyrics = 'lyric'`）。
6. **媒体 URL**：`track_v2` → `track_player.video_model`（JSON 字符串）→ `video_list[].main_url` + `encrypt_info.spade_a`。

---

## 七、原始材料索引

| 材料 | 路径 |
|------|------|
| 精确接口表（412 条） | `logs/asar-extract/api-endpoints-precise.json` |
| sourcemap 路径表 | `logs/asar-extract/api-paths-from-sourcemap.json` |
| IDL 契约 | `logs/asar-extract/idl-contracts/*.ts` |
| 客户端源码提取 | `logs/asar-extract/src-dump/*` |
| BDMS 安全分析 | `docs/REVERSE-ENGINEERING-BDMS-SDK.md` |
| 随机播放机制 | `docs/汽水音乐随机播放机制.md` |
| 本项目上游配置 | `server/config/qishui-auth.js` |

---

## 文档说明

基于 SodaMusic PC 3.5.1 / 3.7.0 逆向材料整理，仅供本项目开发者学习研究与本地调试对接使用。
