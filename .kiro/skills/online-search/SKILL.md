---
name: online-search
description: >-
  Retrieves up-to-date facts, API changes, error messages, and official
  documentation via web search or URL fetch. Use when the user asks for
  current events, platform policy or review rules, library or SDK versions,
  breaking changes, or anything that may be outdated in training data—especially
  WeChat Mini Program / 微信开放平台 docs and community fixes.
---

# 联网检索（online-search）

本仓库由 `.kiro/steering/ours-skills.md`（`inclusion: always`）绑定为**每次 Agent 对话**均需遵守本文件。

## 何时必须联网

- 微信开发者文档、审核规范、基础库版本、接口变更、错误码含义
- npm / 依赖版本、CVE、框架 release notes
- 用户给出的报错全文或平台提示需要对照最新说明时

## 怎么做

1. 先用 **web search** 用具体关键词（产品名 + 功能/错误码 + 年份）查官方或高可信来源。
2. 若已知官方文档 URL，用 **fetch** 拉取对应页面再总结要点；注意页面可能需分段阅读。
3. 结论里区分：**官方文档**、**社区方案**；不确定时写明不确定性。
4. 不要仅凭记忆断言「已下线」「必过审」等平台规则类结论。

## 与本项目结合

OursWXAPP 为微信小程序仓库（`miniprogram/`、`project.config.json`）。涉及微信能力、审核、性能与隐私合规时，优先联网核对 [微信开放文档](https://developers.weixin.qq.com/miniprogram/dev/framework/) 当前表述。
