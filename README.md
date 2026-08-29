# AcFun-Web-IP

## 概述

本文档记录了对 A 站（AcFun）评论系统 IP 属地功能的完整逆向分析过程。目标是在 A 站网页版评论区显示 IP 属地（类似 B 站的 BiliReveal 脚本），最终因架构隔离问题未能实现，但获得了完整的技术细节，供后续开发者参考。

## 结论

**A 站网页版无法通过前端脚本实现 IP 属地显示。** 根本原因是网页版和 App 使用两套完全独立的后端系统，认证不互通。

| 系统 | API 端点 | 是否返回 `ipLocation` | 认证方式 |
|---|---|---|---|
| 网页版 | `rest/pc-direct/comment/list` | ❌ 不返回 | Cookie |
| App | `rest/app/comment/list` | ✅ 返回 | access_token |

---

## 技术发现

### 1. 网页版评论 API

```
POST https://www.acfun.cn/rest/pc-direct/comment/list
参数: sourceId, sourceType, pivotCommentId, newPivotCommentId, t, supportZtEmot
```

返回的评论字段（38 个）：

```json
{
  "commentId": 807009960,
  "userName": "寒鸦号",
  "content": "理中客来咯！！！",
  "postDate": "20分钟前",
  "deviceModel": "网页端",
  "isSameCity": false,        // ← 唯一与位置相关的字段（仅布尔值）
  "floor": 16,
  "likeCountFormat": "0",
  "subCommentCount": 0,
  "timestamp": 1787974236243
  // ... 无 ipLocation 字段
}
```

**关键发现：** `isSameCity` 字段说明后端知道用户所在城市，但未在接口中暴露具体位置。

### 2. App 评论 API（反编译结果）

通过 jadx 反编译 A 站 APK（`tv.acfundanmaku.video`），发现以下关键信息：

#### API 接口定义

文件：`tv.acfun.core.refactor.http.service.AcFunApiService`

```java
// 评论列表（有 token 版本）
@GET("/rest/app/comment/list")
Observable<CommentParent> L(
    @Query("sourceId") String,
    @Query("sourceType") int,
    @Query("pcursor") String,
    @Query("count") int,
    @Query("showHotComments") int,
    @Query("access_token") String
);

// 评论列表（无 token 版本）
@GET("/rest/app/comment/list")
Observable<CommentParent> I3(
    @Query("sourceId") String,
    @Query("sourceType") int,
    @Query("pcursor") String,
    @Query("count") int,
    @Query("showHotComments") int
);

// 子评论列表
@GET("/rest/app/comment/sublist")
Observable<CommentChild> O3(
    @Query("sourceId") String,
    @Query("sourceType") int,
    @Query("pcursor") String,
    @Query("count") int,
    @Query("rootCommentId") String,
    @Query("isIssueTimeUbb") boolean
);
```

#### 评论数据模型

文件：`tv.acfun.core.model.bean.CommentFloorContent`、`CommentRoot`、`CommentSub`

```java
// 评论模型中包含 ipLocation 字段
public class CommentSub {
    // ... 其他字段
    public String ipLocation;  // ← IP 属地！网页版没有这个字段
    public boolean isSameCity;
    // ...
}
```

#### UI 显示代码

```java
// 评论组件中显示 IP 属地的代码
textView4.setText(StringUtils.a(
    CommentUtils.c.b(commentSubC.timestamp),
    commentSubC.ipLocation  // ← 将 ipLocation 拼接到时间后面显示
));
```

### 3. API 域名配置

文件：`tv.acfun.core.common.domain.HostProvider`

| 方法 | 域名 | 用途 |
|---|---|---|
| `getAcFunApiHost()` | `https://api-new.app.acfun.cn` | App 主 API |
| `getLegacyApiHost()` | `https://apipc.app.acfun.cn` | 旧版 API |
| `getPCApiHost()` | `https://mobile.app.acfun.cn` | PC 端 API |
| `getIdHost()` | `https://id.app.acfun.cn` | 登录认证 |

**实际网络请求中发现 App 使用 `https://api-ipv6.app.acfun.cn`（IPv6 版本）。**

### 4. Token 机制

#### Token 获取

文件：`tv.acfun.core.refactor.http.service.IdService`

```java
public interface IdService {
    @POST("/rest/app/token/get")
    Observable<KwaiToken> a(@Field("sid") String str);

    @POST("/rest/app/visitor/login")
    Observable<KwaiVisitorToken> b(@Field("sid") String str);
}
```

#### Token 管理

文件：`tv.acfun.core.utils.MidgroundTokenManager`

```java
public class MidgroundTokenManager {
    public static final String f44129d = "acfun.midground.api"; // sid 值

    // Token 存储在 SharedPreferences 中
    private void h(KwaiToken kwaiToken) {
        AcFunPreferenceUtils.t.q().n0(kwaiToken.apiSt);      // API token
        AcFunPreferenceUtils.t.q().z0(kwaiToken.ssecurity);   // 安全密钥
        AcFunPreferenceUtils.t.q().A0(kwaiToken.userId);      // 用户 ID
    }
}
```

#### KwaiToken 结构

```java
public class KwaiToken {
    public String apiSt;       // API token（用于 access_token 参数）
    public String ssecurity;   // 安全密钥（用于请求签名）
    public long userId;        // 用户 ID
}
```

#### Token 使用

文件：`tv.acfun.core.refactor.http.AcFunParams`

```java
public static Map<String, String> getHeaders() {
    map.put("access_token", SigninHelper.g().h()); // 从 SigninHelper 获取 token
    // ...
}
```

### 5. 请求签名机制

A 站 App 的 API 请求可能需要签名验证（基于 `ssecurity`），不仅仅是简单的 token 传递。这增加了从外部调用 App API 的难度。

---

## 尝试过的方案

### 方案 1：直接调用 App API（不带 token）

```
GET https://api-new.app.acfun.cn/rest/app/comment/list?sourceId=xxx&sourceType=3
```

**结果：** 错误码 105001（需要认证）

### 方案 2：用网页 Cookie 调用 App API

```
GET https://api-new.app.acfun.cn/rest/app/comment/list?...&access_token=acPostHint值
```

**结果：** 错误码 105001（Cookie 和 App token 不互通）

### 方案 3：获取访客 Token

```
POST https://id.app.acfun.cn/rest/app/visitor/login
Body: sid=acfun.midground.api
```

**结果：** 返回 401（`token value error`），该接口需要已有 token 才能使用

### 方案 4：抓取移动端页面

```
GET https://m.acfun.cn/v/?ac=xxx
```

**结果：** 页面是 SPA 架构，HTML 中只有配置标志，评论数据通过 JavaScript 动态加载，无法从 HTML 中提取

### 方案 5：用 `isSameCity` 穷举

通过换不同城市的 IP 探测评论者位置。

**结果：** 理论可行但实际不可行——需要全国各城市的代理 IP，且每条评论都要测试

### 方案 6：从 App 提取 Token

| 方法 | 结果 |
|---|---|
| `adb run-as` | App 不可调试（正式版） |
| `adb backup` | 备份失败（47 字节空文件） |
| `adb logcat` | 只显示网络监控统计，不显示完整请求 URL |
| 抓包工具 | HTTPS 证书固定，无法拦截 |

---

## 为什么 BiliReveal 能成功但 AcFun 不行

| 对比项 | B 站（BiliReveal） | A 站 |
|---|---|---|
| 网页 API 返回 IP 属地 | ✅ `reply_control.location` | ❌ 没有 |
| 手机端显示 IP | ✅ 是 | ✅ 是 |
| 网页端显示 IP | ❌ 不显示 | ❌ 不显示 |
| 脚本原理 | 挖出 API 已返回但未渲染的数据 | 需要调用完全不同的 API |
| 认证隔离 | 网页和 App 共享数据 | 网页和 App 完全隔离 |

B 站的网页 API 已经返回了 IP 属地数据，只是前端不渲染。BiliReveal 只是把这些数据"挖出来"显示。

A 站的网页 API 根本不返回 IP 属地数据。要获取这些数据必须调用 App API，而 App API 需要独立的认证 token，网页端无法获取。

---

## 可能的解决方案

### 方案 A：后端代理（最可行）

```
用户浏览器 → 代理服务器（带 App token）→ A 站 App API → 返回 ipLocation
```

需要：
1. 一台服务器（可用 Cloudflare Workers 免费方案）
2. 一个 Root 手机导出 App token
3. token 过期后重新导出（约几个月一次）

### 方案 B：浏览器扩展

Chrome 扩展拥有更强的权限，可以：
- 存储和管理 token
- 绕过部分 CORS 限制
- 做后台代理请求

### 方案 C：等待官方支持

A 站可能在未来版本中在网页版也显示 IP 属地。

---

## 附录：ADB 命令参考

```powershell
# 查找 A 站 App 包名
adb shell pm list packages | findstr acfun
# 输出: tv.acfundanmaku.video

# 尝试导出 SharedPreferences（需要 Root）
adb shell "su -c 'cat /data/data/tv.acfundanmaku.video/shared_prefs/*.xml'" | findstr "apist token ssecurity"

# 查看网络请求日志
adb logcat -c; adb logcat | findstr "access_token comment/list"
```

---

## 致谢

本分析基于 A 站 Android App 版本 7.5.0（`tv.acfundanmaku.video`），使用 jadx 进行反编译。

---

*本文档仅供技术研究和学习交流使用。*
