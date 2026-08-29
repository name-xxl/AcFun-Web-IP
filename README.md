# AcFunReveal - A站网页版显示 IP 属地

> 通过 A 站用户资料 API 获取评论者 IP 属地，注入到网页版评论区。

## 功能

- ✅ 评论区显示 IP 属地（设备型号/网页端后面）
- ✅ 楼中楼/折叠评论支持
- ✅ 个人主页 UP IP 显示
- ✅ 用户主页 IP 显示
- ✅ 可视区域优先查询（IntersectionObserver）
- ✅ 按页面缓存（文章/视频按 ac 号）
- ✅ 翻页/懒加载自动处理
- ✅ SPA 导航自动刷新
- ✅ 缓存导入/导出

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴 `AcFunReveal.user.js` 内容
3. 保存，打开 A 站页面即可

## 版本历史

### v5.1.0 — 可视区域优先

使用 `IntersectionObserver` 实现懒加载，只查询可见评论的 IP：

```
页面加载 → 拦截评论 API → 建立 commentId→userId 映射
  ↓
评论进入视口 → 查询该用户 IP → 注入
  ↓
滚动 → 新评论进入视口 → 查询 → 注入
  ↓
已缓存 → 直接注入，不发请求
```

| 场景 | API 调用 | 注入时机 |
|---|---|---|
| 打开页面（25条评论，可见5条） | 5 次 | 立即 |
| 滚动看到更多 | 逐个查询 | 进入视口时 |
| 再次访问（有缓存） | 0 次 | 立即 |

### v5.0.0 — 性能优化重构

| 优化项 | 说明 |
|---|---|
| `WeakSet` 去重 | 已注入的评论元素跳过重复处理 |
| `Promise` 去重 | 同一用户的 IP 查询不会重复发起 |
| 统一 Observer | 一个 MutationObserver 管理所有 DOM 变化 |
| 300ms 防抖 | 避免频繁 DOM 变化触发重复扫描 |
| 代码精简 | 350 行 → 260 行 |

### v3.2.0 — 缓存机制

引入完整的缓存系统：

```json
{
  "ac173173": {
    "users": {
      "23682490": { "ip": "四川", "name": "AC娘本体" },
      "51737407": { "ip": "江西", "name": "name_xxl" }
    },
    "time": 1693312000000,
    "url": "https://www.acfun.cn/a/ac173173"
  }
}
```

- **开启缓存**：按 ac 号存储，再次访问直接读取
- **关闭缓存**：每次重新查询，离开页面清除
- **自定义天数**：0=永久，或设置 1/7/30 天自动过期
- **导入/导出**：支持 JSON 格式

### v3.0.0 — 按需查询

去掉轮询定时器，改用 MutationObserver：

| 场景 | 之前 | 现在 |
|---|---|---|
| 打开页面 | 持续轮询 | 查询一次，等待 |
| 翻页 | 轮询发现 | Observer 立即触发 |
| 无操作 | 每 1.5 秒检查 | 不做任何事 |
| 已查用户 | 每次检查缓存 | WeakSet 直接跳过 |

## 技术原理

### 核心发现

A 站网页版评论 API (`/rest/pc-direct/comment/list`) 返回的评论数据**没有 IP 属地字段**。但用户资料 API (`/rest/pc-direct/user/userInfo?userId=xxx`) 返回的 `profile.ipLocation` **包含 IP 属地**。

### 工作流程

```
1. 拦截评论 API 响应 → 提取 commentId → userId 映射
2. IntersectionObserver 监听评论元素进入视口
3. 可见评论 → 查询用户资料 API → 获取 profile.ipLocation
4. 将 IP 属地注入到评论区 .area-comment-from 容器末尾
```

### 为什么不用移动端 API

移动端 API (`/rest/app/comment/list`) 的评论数据直接包含 `ipLocation`，但：

- 需要 App 的 `access_token`（通过快手安全 SDK Azeroth 签名）
- 签名算法在混淆的 native 代码中，无法从网页端复制
- 网页端和 App 端的认证系统完全独立

### 支持的页面

| 页面 | 功能 | 缓存 |
|---|---|---|
| 文章 `/a/ac*` | 评论区 IP | ✅ 按 ac 号缓存 |
| 视频 `/v/ac*` | 评论区 IP | ✅ 按 ac 号缓存 |
| 个人主页 `/member` | UP IP | ❌ 实时查询 |
| 用户主页 `/u/xxx` | 用户 IP | ❌ 实时查询 |

## 菜单

| 菜单 | 功能 |
|---|---|
| 🟢/🔴 缓存开关 | 开启/关闭缓存 |
| ⏰ 设置缓存天数 | 0=永久, 1/7/30 天 |
| 📋 复制全部日志 | 复制调试日志到剪贴板 |
| 📊 查看本页缓存 | 查看当前页面的 IP 缓存 |
| 📦 导出全部缓存 | 导出所有页面的缓存 JSON |
| 📥 导入缓存 | 导入之前导出的缓存 |
| 🗑️ 清空缓存 | 清除所有缓存数据 |

## 性能

| 指标 | 数值 |
|---|---|
| 内存占用 | ~60-100KB |
| 首屏 API 调用 | 仅可见评论数（约5个） |
| 缓存命中时 | 0 次 API 调用 |
| CPU 开销 | 极低（IntersectionObserver 硬件加速） |

## 局限性

- **IP 属地来源**：基于用户主页实时资料，不代表发布评论时的 IP
- **覆盖率**：依赖用户资料 API 返回 `ipLocation`，部分用户可能没有
- **实时性**：用户换城市后，显示的是当前城市（非评论时城市）

## 开发过程

### 关键逆向发现

1. **App 反编译**（jadx）：发现 `ipLocation` 字段存在于 `CommentFloorContent`、`CommentRoot`、`CommentSub` 等类中
2. **API 分析**：网页 API 不返回 `ipLocation`，移动端 API 需要签名认证
3. **嗅探器**：通过自定义 API 嗅探脚本发现网页端 `/rest/pc-direct/user/userInfo` 返回 `profile.ipLocation`
4. **DOM 分析**：通过保存页面 HTML 分析评论区的真实 DOM 结构

### 踩过的坑

| 问题 | 原因 | 解决 |
|---|---|---|
| 注入不生效 | `[data-cid]` 选择器不对 | 改用 `[data-commentid]` |
| UP IP 不显示 | `log-item` 的 JSON 被 HTML 编码 | 改用链接提取 userId |
| 个人主页不触发 | `/member` vs `/member/` 路径不匹配 | 去掉尾部斜杠 |
| 控制台无日志 | `log()` 不写入 `allLogs` 数组 | 统一用 `addLog()` |
| IP 换行显示 | `.up-time` 是 block 元素 | 用 `appendChild` 而非 `insertBefore` |
| 注入分批出现 | 每批查询完都注入 | 改用 IntersectionObserver |
| 移动端 API 105001 | 缺少请求签名（Azeroth SDK） | 改用用户资料 API |

## 许可

MIT License
