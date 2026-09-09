# Ours 网页管理台

这是独立于微信小程序的管理网页，用来生成一次性邀请码、查看空间状态/额度，以及查看每个空间的成员、全部动态和照片。它通过 CloudBase Web SDK 调用 `admin-api` 云函数，浏览器端不直接读写数据库。

## 本地运行

```bash
cp .env.example .env
npm install
npm run dev
```

默认环境 ID 是当前项目的 `cloud1-d1gg9j97ua5f7f700`。如需切换环境，修改 `.env`：

```dotenv
VITE_CLOUD_ENV_ID=你的 CloudBase 环境 ID
```

## 首次管理员初始化

1. 在 CloudBase 控制台的身份认证中开启「账号密码」登录并创建管理员账号。
2. 先登录网页。若账号还没有权限，登录页会展示它的 `uid`。
3. 在数据库创建 `admins` 集合，并加入文档：

```json
{
  "uid": "网页显示的 uid",
  "role": "superadmin",
  "status": "active"
}
```

4. 刷新网页，确认可以看到「概览 / 邀请码 / 双人空间」。

`admins`、`access_codes`、`space_invites` 建议配置为仅云函数可读写。

管理台的空间动态数、媒体数和存储用量会按 `moments` / `rants` 实际记录汇总，兼容早期没有回填 `couples.usage` 的历史空间；系统记录不计入动态额度。邀请码原文只在生成响应和当前管理台会话中可见，数据库只保存哈希；额度在客户兑换时写入空间并由小程序云函数持续校验。

管理台支持删除未兑换、已撤销或已过期且未绑定空间的邀请码；删除空间会在二次确认后清理空间记录、授权记录及关联媒体文件。

## 部署到网页

在 CloudBase 静态网站托管中新建站点，构建命令为：

```bash
npm install && npm run build
```

输出目录为 `dist`，环境变量配置为 `VITE_CLOUD_ENV_ID`。也可以先本地构建后上传 `dist` 目录。

如果站点构建根目录使用仓库根目录，则改用：

```bash
npm --prefix admin-web install && npm --prefix admin-web run build
```

此时输出目录是 `admin-web/dist`。

部署 `admin-web` 前，需要先部署：

- `cloudfunctions/ours`
- `cloudfunctions/admin-api`

小程序端的完整集合、索引和发布顺序见 [`cloud/README.md`](../cloud/README.md)。
