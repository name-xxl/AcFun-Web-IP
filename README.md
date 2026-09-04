# AcFunReveal - A站网页版显示 IP 属地

> 通过 A 站用户资料 API 获取评论者 IP 属地，注入到网页版评论区。

## 功能

- ✅ 评论区显示 IP 属地（设备型号/网页端后面）
- ✅ 楼中楼/折叠评论支持
- ✅ 个人主页 UP IP 显示
- ✅ 用户主页 IP 显示
- ✅ 可视区域优先查询（IntersectionObserver）
- ✅ 全局 uid 缓存 + 按页面缓存（ac 号）
- ✅ 串行限流队列（防风控）
- ✅ 翻页/懒加载自动处理
- ✅ SPA 导航自动刷新
- ✅ 点击 IP 弹出原生风格设置面板
- ✅ 缓存导入/导出

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴 `dist/acfun-reveal.user.js` 内容
3. 保存，登录 A 站后打开页面即可

> 属地字段需要登录态，未登录时 API 返回空 `ipLocation`。

## 开发

单文件油猴脚本 + 拼接式模块化（无打包器依赖，`node build.js` 即可）：

```
src/
  00-header.js        油猴元数据 + IIFE 开头
  10-constants.js     CONFIG：API 端点、DOM 选择器、阈值（A 站改版只改这里）
  20-utils.js         日志
  30-storage.js       GM 存储、页面缓存、全局 uid 缓存（TTL/上限/迁移）
  40-api.js           IP 查询：串行限流队列、页面 fetch、负缓存写入
  50-inject.js        UID 提取、IP 标签构造与注入
  60-intercept.js     拦截评论 API（fetch/XHR），建立 commentId→userId 映射
  70-observers.js     IntersectionObserver / MutationObserver / 路由监听 / 三个注入场景
  80-panel.js         设置面板（仿 A 站原生弹窗，主色 #fd4c5d）
  85-cache-actions.js 缓存导入/导出/清空（面板与菜单共用）
  90-menu.js          油猴菜单（3 项只读入口）
  99-main.js          启动流程 + window.ACFunReveal 调试接口
```

```bash
node build.js            # 拼接 src/ -> dist/acfun-reveal.user.js（含版本一致性校验）
node tools/smoke-test.js # 冒烟测试：语法、版本、关键函数、面板样式
```

版本号需同步三处：`package.json`、`src/00-header.js` 的 `@version`、`src/10-constants.js` 的 `VERSION`，build.js 会校验，不一致直接报错。

## 设置面板

点击页面上任意 IP 标签弹出（油猴菜单里也有 ⚙️ 设置面板兜底入口）：

- 用户资料卡片：用户名 / UID / IP属地 / 查询时间
- 缓存开关
- 页面缓存保留天数（永久/1天/7天/30天，即时生效）
- 缓存管理：导出 / 导入 / 清空

## 技术原理

```
1. 拦截评论 API 响应 → 提取 commentId → userId 映射
2. IntersectionObserver 监听评论元素进入视口
3. 可见评论 → 全局 uid 缓存 → 页面缓存 → 串行队列（200ms 间隔）→ userInfo API
4. 将 profile.ipLocation 注入评论区 .area-comment-from
```

- 网页版评论 API 不含 IP 字段；属地来自用户资料 API 的 `profile.ipLocation`（当前属地，非评论时属地）
- `ipLocation` 需要请求方登录态：使用页面上下文 `fetch`（`credentials: 'include'`，自动携带含 HttpOnly 的完整 cookie）
- 全局 uid 缓存 TTL 1 天（用户搬家后次日刷新），页面缓存按 ac 号、默认永久
- 查询失败（无属地）写入 6 小时负缓存，避免反复请求

## 局限性

- 属地基于用户主页实时资料，不代表发布评论时的 IP
- 覆盖率依赖 API 返回，部分用户可能没有属地
- 移动端 `m.acfun.cn` 已匹配但 DOM 选择器为 PC 端，暂未生效

## 版本历史

### v5.6.0 — 模块化重构

- 拆分为 `src/` 12 个编号模块 + `build.js` 拼接构建（对齐 danmaku-sender 工程约定）
- 设置面板样式对齐 A 站原生：主色 `#fd4c5d`、原生字体栈、原生圆角/边框规范
- 新增构建期双重版本一致性校验、冒烟测试

### v5.5.0 — 原生风格设置面板

- 油猴菜单 7 项 → 3 项（设置面板 / 复制日志 / 查看缓存），设置收进点击 IP 弹出的面板
- 面板含用户资料卡片（用户名/UID/属地/查询时间）
- 导出格式升级为 `{ version, pages, uids }` 打包，兼容旧版纯页面缓存导入

### v5.4.0 — 全局缓存与限流

- 全局 uid 二级缓存（TTL 1 天、上限 5000、旧页面缓存自动迁移）：同一用户跨视频不再重复查询
- 请求串行队列 + 200ms 强制间隔，防风控
- 注入标签 tooltip 显示查询时间；原地重渲染的评论从缓存补注入
- `commentUserMap` 路由切换时清空；新增 `@noframes`
- 移除 `GM_xmlhttpRequest`，统一页面 fetch（`credentials: 'include'` + 10s 超时）

### v5.3.1 — 登录态修复

- 请求改用页面上下文 `fetch`：同源自动携带全部 cookie（含 HttpOnly），修复"登录了但 ipLocation 全空"
- 根因：v5.2.0 手动传 `document.cookie` 读不到 HttpOnly 登录凭证，残缺 Cookie 覆盖了真实凭证

### v5.3.0 — 质量重构

- CONFIG 集中配置；负缓存（失败 6 小时不重试）；缓存上限 500 页
- 存储封装、函数拆分、菜单数据驱动、暴露 `window.ACFunReveal` 调试接口
- 修复：失败不缓存导致重复请求、UP 注入 WeakSet 提前标记、缓存无限膨胀、注入点缺失静默失败

### v5.2.0 及更早

见 [GitHub 仓库 README](https://github.com/name-xxl/AcFun-Web-IP)。


## 许可

MIT License
