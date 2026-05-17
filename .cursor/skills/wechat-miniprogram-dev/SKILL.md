---
name: wechat-miniprogram-dev
description: >-
  Builds and maintains WeChat Mini Programs (微信小程序): pages, custom
  components, WXML/WXSS/JS/TS, app.json routing, API usage, performance,
  storage, and release/review readiness. Use when editing miniprogram/,
  project.config.json, sitemap, cloud or wx.* APIs, or when the user mentions
  小程序、微信开发者工具、提审、真机调试。
---

# 微信小程序开发（wechat-miniprogram-dev）

本仓库由 `.cursor/rules/ours-wechat-skills-always.mdc`（`alwaysApply: true`）绑定为**每次 Agent 对话**均需遵守本文件。

## 项目结构（本仓库）

- 小程序源码在 `miniprogram/`，入口配置为根目录 `project.config.json` 指向的 `miniprogram`。
- 页面在 `miniprogram/pages/`；全局样式与逻辑见 `miniprogram/app.wxss`、`miniprogram/app.ts`。
- 新增页面：建四件套（`wxml`/`wxss`/`ts`/`json`）并在 `miniprogram/app.json` 的 `pages` 中注册路径。

## 编码约定

- **数据驱动视图**：在 `Page` / `Component` 的 `data` 中维护状态，WXML 只做展示与事件绑定。
- **异步**：网络、文件、存储等用 Promise/async 或回调，注意错误分支与用户提示（`wx.showToast` 等）。
- **安全**：不在前端硬编码密钥；敏感逻辑放云函数或自有后端；遵守用户隐私与授权弹窗规范。
- **性能**：列表长数据用虚拟列表或分页；图片用合适尺寸与懒加载；避免在 `setData` 中传过大对象。

## UI 与视觉

- 页面与组件的视觉方向、配色、排版、动效遵循 **frontend-design** 技能；实现层使用 WXSS（`rpx`、CSS 变量、小程序支持的动画属性）。
- 避免照搬 Web 字体栈；优先系统字体 + 可选 `wx.loadFontFace` 加载品牌字体。

## 调试与发布

- 本地用微信开发者工具打开仓库根目录；以 `project.config.json` 为准。
- 真机预览前检查合法域名、HTTPS、业务类目与隐私协议配置。
- 提审前自检：无调试残留、无 test 数据、用户路径与权限说明完整。

## 需要最新规则时

涉及审核条款、接口废弃、基础库行为变化时，配合 **online-search** 技能联网查微信开放文档，避免用过时假设。
