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
| `access_codes` | 管理台生成的一次性授权码 |
| `space_invites` | 双人空间第二位成员的一次性邀请 token |
| `admins` | 管理台管理员白名单（仅云函数读写） |

`access_codes`、`space_invites`、`admins` 建议设置为「仅云函数可读写」。邀请码只保存哈希，网页管理台不会从数据库恢复原始邀请码；生成后请立即复制并发给客户。网页会在当前管理台会话中保留最近一次生成结果，关闭提示后不再显示原始码。

### 建议索引（重要：消除全表扫描）

本应用按「双人空间」多租户：几乎所有查询都带 `coupleId`。**只要每个集合都建 `coupleId` 复合索引，按空间聚合的查询就只扫描本空间文档，而非整张集合表**，这就是这里所说的「去全表扫描」。索引在云开发控制台「数据库 → 集合 → 索引管理」新建（代码无法创建索引）。

按实际查询模式（`where` 字段在前、`orderBy` 字段在后，方向需一致）建议：

| 集合 | 索引字段（顺序/方向） | 命中的查询 |
|------|----------------------|-----------|
| `couples` | `memberA.openid`(单字段) | 登录态查找本人空间 |
| `couples` | `memberB.openid`(单字段) | 同上（对方） |
| `moments` | `coupleId`↑ + `sortAt`↓ | 时间轴分页、那年今日、合辑、地图、相邻导航 |
| `moments` | `coupleId`↑ + `tag`↑ + `sortAt`↓ | 标签筛选分页 |
| `moments` | `coupleId`↑ + `kind`↑ | `getMomentsBriefStats` 计数、系统卡判定 |
| `moments` | `coupleId`↑ + `authorRole`↑ | A/B 发布数计数 |
| `checkins` | `coupleId`↑ + `date`↑ | 当日签到、月历区间查询 |
| `checkins` | `coupleId`↑ + `date`↑ + `openid`↑ | 判断本人当日是否已签 |
| `moment_comments` | `coupleId`↑ + `momentId`↑ + `createdAt`↑ | 评论列表、批量计数（`momentId in [...]`） |
| `moment_likes` | `coupleId`↑ + `momentId`↑ | 爱心数、批量聚合 |
| `moment_likes` | `coupleId`↑ + `momentId`↑ + `openid`↑ | 判断本人是否已赞 |
| `anniversaries` | `coupleId`↑ + `date`↑ | 纪念日列表（按日期升序） |
| `rants` | `coupleId`↑ + `createdAt`↓ | 吐槽墙列表（未建索引时云函数内存兜底排序） |
| `notes` | `coupleId`↑ + `createdAt`↓ | 小纸条列表 |
| `access_codes` | `createdAt`↓、`codeHash`（单字段） | 管理台列表、兑换邀请码 |
| `space_invites` | `tokenHash`（单字段）、`coupleId`↑ | 第二位成员兑换邀请链接 |
| `admins` | `uid`（单字段）、`openid`（单字段） | 管理台身份校验 |

> 说明：`getOnThisDay`/`getMomentsStats`/`listMomentCollections`/`listMapPlaces` 需对「本空间全部动态」做聚合，属设计内的有界扫描——建好上面的 `coupleId+sortAt` 索引后即为按空间的范围扫描，单空间数据量小（百量级），无需额外预计算字段。若未来单空间动态量很大，再考虑增加 `monthDay` 等冗余字段做月日检索。

## 2. 部署云函数

1. 微信开发者工具 → 右键 `cloudfunctions/ours` → **上传并部署：云端安装依赖**
2. 首次需在该目录执行 `npm install`（工具可自动安装）
3. 右键 `cloudfunctions/admin-api` → **上传并部署：云端安装依赖**。这个函数只接受已登录且存在于 `admins` 集合的网页账号；若管理台需要统计历史媒体文件大小，建议将该函数的执行超时设为至少 15 秒。

## 3. 网页管理台

管理台是独立的 Vite 网页，不放进小程序页面。开发预览：

```bash
cd admin-web
cp .env.example .env
npm install
npm run dev
```

`.env` 中的 `VITE_CLOUD_ENV_ID` 已有当前环境 ID 默认值；正式部署前请在 CloudBase 静态网站托管中配置同名环境变量。若站点根目录配置为仓库根目录，构建命令使用 `npm --prefix admin-web install && npm --prefix admin-web run build`，输出目录为 `admin-web/dist`；也可以直接上传构建后的 `admin-web/dist`。CloudBase 静态托管支持 React/Vue/Vite 项目，具体入口见官方文档：<https://docs.cloudbase.net/hosting/introduce>。

首次初始化管理员：

1. 在 CloudBase 控制台开启「账号密码」登录，创建一个管理台账号。
2. 先打开网页管理台登录。若账号尚未授权，页面会显示当前账号的 `uid`。
3. 在数据库新建一条 `admins` 文档：`{ "uid": "网页显示的 uid", "role": "superadmin", "status": "active" }`。
4. 刷新网页即可使用「概览 / 邀请码 / 双人空间」三个模块。

网页通过 CloudBase Web SDK 调用 `admin-api` 云函数；CloudBase Web SDK 支持在浏览器中调用云函数，参考：<https://docs.cloudbase.net/api-reference/webv2/functions>。

## 4. 授权与绑定说明

- 管理员在网页「邀请码」里生成授权码，设置动态数、媒体数、存储量和到期日。
- 客户兑换后，邀请码中的额度会复制到对应 `couples.quota`；小程序发布动态、上传媒体时持续校验动态数、媒体数、单条媒体数和存储字节数。
- 客户首次打开小程序时只能看到「邀请码激活」页；没有有效邀请码不能创建空间，也不会自动加入别人的空间。
- 客户兑换邀请码后创建 `memberA` 空间；进入「我们」页生成第二位成员专属邀请链接。
- 第二位成员只能通过该邀请链接加入，一个空间最多两人，邀请链接默认 7 天有效。
- 管理员在网页「双人空间」里可以看到成员、授权额度、资源用量，以及该空间的全部动态和媒体。
- 网页可删除未兑换、已撤销或已过期且未绑定空间的邀请码；也可在二次确认后删除整个空间及其记录、媒体和授权记录。
- 管理台的动态、媒体和存储统计按对应空间的实际记录汇总，兼容早期空间中 `couples.usage` 未回填的情况；修改 `admin-api` 后需重新上传并部署该云函数。

## 5. 存储与额度

动态媒体路径（由 `wx.cloud.uploadFile` 上传）：

- `moments/{coupleId}/images/*` — 照片（额度由邀请码决定，可多次添加）
- `moments/{coupleId}/videos/*` — 视频或实况配对视频（实况封面在 images）
- `moments/{coupleId}/voices/*` — 语音（每条最多 1 条，最长 60 秒）

动态发布成功后会登记动态数量、媒体文件数量和客户端读取到的文件大小；删除动态会回收对应额度。修改云函数后请重新**上传并部署** `ours`（`config.json` 已声明 `security.msgSecCheck` 权限，用于文本内容安全）。

### 其它行为

- `listMoments` 返回 `{ items, total, hasMore }`，默认每页 20 条（上限 50）；列表项含 `coverUrl` `commentCount` `likeCount` `likedByMe`（批量换链与聚合）
- 回忆增强 action：`searchMoments` `getOnThisDay` `getMomentsStats` `listMomentCollections` `getMomentNeighbors` `getMomentsBriefStats`
- 发布可靠性 action：`validateMoment`（上传前校验文字/日期）`cleanupUploadedFiles`（发布失败清理本次上传）`resolveMediaUrls`（客户端换链失败时云端兜底）
- 养小猫（数据存在 `couples.pet`）：`getPet` `adoptPet` `petInteract`；记动态/签到自动加成长值
- `listCheckins` 按 `year` + `month` 查询当月签到
- `deleteMoment` / `cleanupUploadedFiles` 会尝试删除关联的云存储 `fileID`
- `seedDemoData`：仅开发版/体验版，写入 v0.1+v0.2 全套演示（见产品文档 §16、§17）
- v0.2 action：`listAnniversaries` `addAnniversary` `deleteAnniversary` `getNextAnniversary` `listRants` `addRant` `deleteRant` `listNotes` `sendNote` `markNoteRead` `listComments` `addComment` `deleteComment` `getMomentLikes` `toggleMomentLike` `listMapPlaces`
