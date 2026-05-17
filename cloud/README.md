# 云开发部署说明

环境 ID：`cloud1-d1gg9j97ua5f7f700`（与 `miniprogram/config/env.ts` 一致）

## 1. 创建数据库集合

在云开发控制台 → **数据库** 新建集合（权限建议均为「仅云函数可读写」或「仅创建者可读写」+ 客户端只走云函数）：

| 集合 | 说明 |
|------|------|
| `couples` | 双人空间 |
| `moments` | 动态 |
| `checkins` | 每日打卡 |
| `anniversaries` | 纪念日（v0.2） |
| `rants` | 吐槽墙（v0.2） |
| `notes` | 小纸条（v0.2） |
| `moment_comments` | 动态评论（v0.2） |
| `moment_likes` | 动态爱心（v0.2） |

### 建议索引

- `moments`：`coupleId` 升序 + `createdAt` 降序（列表排序）；可选 `tag` 筛选
- `checkins`：`coupleId` + `date`（按日查询）
- `moment_comments`：`coupleId` + `momentId`
- `moment_likes`：`coupleId` + `momentId`
- `rants`：`coupleId` 升序 + `createdAt` 降序（吐槽墙列表；未建索引时云函数会内存排序）
- `notes`：`coupleId` 升序 + `createdAt` 降序（小纸条列表）

## 2. 部署云函数

1. 微信开发者工具 → 右键 `cloudfunctions/ours` → **上传并部署：云端安装依赖**
2. 首次需在该目录执行 `npm install`（工具可自动安装）

## 3. 绑定说明

- **你**：首次打开 →「创建我们的空间」→ 填昵称与开始日期
- **她**（微信号 `cai852899`）：直接打开小程序即可自动写入 `memberB`，也可通过分享卡片 `inviteFrom=空间id` 加入

## 4. 存储

动态媒体路径（由 `wx.cloud.uploadFile` 上传）：

- `moments/{coupleId}/images/*` — 照片（数量不限，可多次添加）
- `moments/{coupleId}/videos/*` — 长视频或实况配对视频（实况封面在 images）
- `moments/{coupleId}/videos/*` — 视频（每条最多 1 个，最长 60 秒）
- `moments/{coupleId}/voices/*` — 语音（每条最多 1 条，最长 60 秒）

修改云函数后请重新**上传并部署** `ours`（`config.json` 已声明 `security.msgSecCheck` 权限，用于文本内容安全）。

### 其它行为

- `listMoments` 返回 `{ items, total, hasMore }`，默认每页 20 条（上限 50）；列表项含 `coverUrl` `commentCount` `likeCount` `likedByMe`（批量换链与聚合）
- 回忆增强 action：`searchMoments` `getOnThisDay` `getMomentsStats` `listMomentCollections` `getMomentNeighbors` `getMomentsBriefStats`
- 养小猫（数据存在 `couples.pet`）：`getPet` `adoptPet` `petInteract`；记动态/签到自动加成长值
- `listCheckins` 按 `year` + `month` 查询当月签到
- `deleteMoment` / `clearAll` 会尝试删除关联的云存储 `fileID`
- `seedDemoData`：仅开发版/体验版，写入 v0.1+v0.2 全套演示（见产品文档 §16、§17）
- v0.2 action：`listAnniversaries` `addAnniversary` `deleteAnniversary` `getNextAnniversary` `listRants` `addRant` `deleteRant` `listNotes` `sendNote` `markNoteRead` `listComments` `addComment` `deleteComment` `getMomentLikes` `toggleMomentLike` `listMapPlaces`
