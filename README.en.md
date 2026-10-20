# Ours

**A photo journal for two. Keep the days you share, one memory at a time.**

[简体中文](./README.md) | **English**

Ours is a WeChat Mini Program for couples to keep photos, words, videos, voice recordings, and places in a shared space for two. From an everyday meal to a memorable trip, each moment becomes part of your timeline.

This repository includes the Mini Program, cloud functions, and a standalone web admin console. The Mini Program interface is currently in Chinese.

[Features](#features) · [Getting started](#getting-started) · [Development commands](#development-commands) · [Troubleshooting](#troubleshooting) · [Further documentation](#further-documentation)

## Features

| Feature | Description |
| --- | --- |
| A shared space for two | Activate a space with a single-use access code issued by an administrator, then invite your partner with a dedicated link. Each space supports up to two members. |
| Multimedia memories | Combine text, photos, GIFs, Live Photos, video, and voice recordings. Add a tag, location, and memory date, including dates in the past. |
| Memory timeline | Browse by date with pagination, keyword search, and tag filters. Rediscover memories with On This Day and navigate between adjacent entries. |
| Places, collections, and recaps | View recorded locations on a map, browse collections by tag or place, and explore monthly statistics and photo recaps across years. |
| Shared interactions | Comment on memories and leave likes. Authors can edit an entry's text, date, tag, and location. |
| Days together and anniversaries | Track your days together, manage anniversaries, and see the next anniversary countdown on the home page. |
| Personal settings | Update your own avatar, nickname, and relationship start date. Choose from Lavender, Peach, Mint, and Sky themes. |
| Memory backups | Export records and original media as ZIP volumes, including records, a media manifest, and an export status report. |
| Standalone admin console | Administrators can issue access codes, inspect spaces and members, adjust quotas, browse records and media, and delete spaces. |

The Mini Program currently has three tabs: **Home (首页) / Memories (回忆) / Us (我们)**. Drafts are saved locally, with reliability handling for publishing retries, like retries, and media cleanup.

## Technology

| Component | Technology |
| --- | --- |
| WeChat Mini Program | Native Mini Program APIs, TypeScript, WXML, WXSS |
| Application backend | WeChat Cloud Development, Node.js, `wx-server-sdk`, cloud database and storage |
| Web admin console | React 18, TypeScript, Vite 5, CloudBase Web SDK |
| Admin API | Node.js, `@cloudbase/node-sdk`, administrator allowlist checks |
| Backup export | `archiver`, producing ZIP files with JSON records and original media |

## Repository structure

```text
.
|-- miniprogram/               # WeChat Mini Program
|   |-- pages/                # Home, memories, profile, composer, details, activation, invites
|   |-- subpages/             # Source for anniversaries, the places map, backup, and other subpages
|   |-- components/           # Live Photo and places map components
|   |-- services/             # Sessions, data access, drafts, themes, and caches
|   |-- utils/                # Date, media, and timeline utilities
|   `-- config/env.ts         # Mini Program cloud environment configuration
|-- cloudfunctions/
|   |-- ours/                 # Mini Program application backend
|   `-- admin-api/            # Web admin console backend
|-- admin-web/                # Standalone React admin console
|-- cloud/README.md           # Cloud deployment, collections, and indexes
|-- docs/                     # Product documentation
|-- scripts/verify-core.cjs    # Local core workflow verification
|-- project.config.json       # WeChat DevTools project configuration
|-- README.md                 # Chinese README
`-- README.en.md              # English README
```

Available page routes are defined in [`miniprogram/app.json`](./miniprogram/app.json).

## Getting started

### 1. Prepare your environment and install dependencies

- Install Node.js 20 or later and npm for local development.
- Install WeChat DevTools and prepare a Mini Program AppID with Cloud Development enabled.
- Create your own WeChat Cloud Development / CloudBase environment with a cloud database, cloud functions, and cloud storage.

```bash
git clone https://github.com/Haoog/Ours.git
cd Ours
npm ci
```

Root dependencies support TypeScript and local verification. The admin console and each cloud function have separate dependencies.

### 2. Configure your AppID and cloud environment

Import the **repository root** into WeChat DevTools. The project already sets `miniprogram/` as the Mini Program root, `cloudfunctions/` as the cloud function root, and enables the TypeScript compiler plugin.

Replace the existing configuration with your own values:

| File | Setting |
| --- | --- |
| [`project.config.json`](./project.config.json) | Set `appid` to your Mini Program AppID. |
| [`miniprogram/config/env.ts`](./miniprogram/config/env.ts) | Set `CLOUD_ENV_ID` to your cloud environment ID. |
| `admin-web/.env` | Create this file in step 4 and set `VITE_CLOUD_ENV_ID` to the same environment ID. |

For example, the Mini Program configuration should contain:

```ts
export const CLOUD_ENV_ID = 'your-cloud-env-id'
```

### 3. Initialize the database and deploy cloud functions

Create these **11 collections** in the Cloud Development console. Configure database permissions to allow reads and writes only through cloud functions:

| Purpose | Collections |
| --- | --- |
| Spaces and memories | `couples`, `moments` |
| Anniversaries and memory interactions | `anniversaries`, `moment_comments`, `moment_likes` |
| Historical feature data and compatibility APIs | `checkins`, `rants`, `notes` |
| Activation, invitations, and administrators | `access_codes`, `space_invites`, `admins` |

Create the corresponding indexes using the [cloud deployment guide](./cloud/README.md) (Chinese). Indexes are an important part of configuring timeline, filter, and space queries.

In WeChat DevTools, right-click each directory below and select **Upload and Deploy: Install Dependencies in the Cloud (上传并部署：云端安装依赖)**:

1. `cloudfunctions/ours`
2. `cloudfunctions/admin-api`

Use a Node.js 18 or later cloud function runtime. For `ours`, **512 MB of memory and a 120-second timeout** are recommended for media backup volumes. Install its dependencies in the cloud, including `archiver`. A timeout of at least 15 seconds is recommended for `admin-api` when calculating historical media usage.

`ours/config.json` already declares the `security.msgSecCheck` permission. Deploy both functions before running or releasing the Mini Program and admin console.

### 4. Run the admin console and authorize the first administrator

```bash
cd admin-web
cp .env.example .env
```

Edit `.env` to use the cloud environment ID from step 2:

```dotenv
VITE_CLOUD_ENV_ID=your-cloud-env-id
```

Then start the console:

```bash
npm ci
npm run dev
```

Open the local URL printed in the terminal and complete the initial authorization:

1. Enable account/password authentication in the CloudBase console and create an admin console account.
2. Sign in on the web. If the account is not authorized yet, the page displays its `uid`.
3. Add a document to the `admins` collection:

   ```json
   {
     "uid": "uid-shown-on-the-login-page",
     "role": "superadmin",
     "status": "active"
   }
   ```

4. Refresh the page to access Overview (概览), Access Codes (邀请码), and Spaces (双人空间).

See the [admin console guide](./admin-web/README.md) (Chinese) for CloudBase static hosting instructions. `VITE_CLOUD_ENV_ID` is a build-time variable: restart the development server or rebuild the site after changing it.

### 5. Activate a space and invite your partner

1. Generate a single-use access code in the web admin console. Configure memory count, media count, media files per entry, storage allowance, and applicable expiration dates.
2. Compile the Mini Program in WeChat DevTools. Enter the code, choose an avatar and nickname, and set your relationship start date to activate the space.
3. Open Us (我们), generate an invitation card for the second member, and share it with your partner.
4. Your partner joins the same space through the card containing the invitation token. Invitations expire after 7 days by default; each space supports up to two members.
5. Tap **+** to publish your first memory, then explore the timeline, places, collections, and recaps in Memories (回忆).

Access codes activate new spaces; partner invitations connect the second member. Opening the Mini Program directly through search leads to activation. Joining an existing space requires its invitation card.

## Development commands

Run these commands from the **repository root**:

| Command | Purpose |
| --- | --- |
| `npm ci` | Install root dependencies. |
| `npm run typecheck` | Check Mini Program TypeScript types. |
| `npm run verify:core` | Verify core workflows with a local mock database and WeChat APIs, without connecting to production data. |
| `npm --prefix admin-web ci` | Install admin console dependencies. |
| `npm run admin:dev` | Start the admin development server; configure `admin-web/.env` first. |
| `npm run admin:build` | Type-check and build the admin console into `admin-web/dist/`. |

`verify:core` covers publish deduplication, media reference protection, transaction rollback and cleanup retries, author edit permissions, like retries, draft recovery, and ZIP exports of original files. Compile, preview, and upload the Mini Program through WeChat DevTools.

## Access and current behavior

- Cloud functions verify a regular user's WeChat identity and space membership before granting data access. Authorized administrators can inspect space records and media through the admin console.
- Cloud functions enforce limits on memory count, media count, media files per entry, and storage. Actual allowances depend on the admin configuration.
- Backups are available under Us (我们) → Back Up Memories (备份回忆). Each volume includes up to 10 media files, along with `records.json`, `media-manifest.json`, and `backup-status.json`. Files that could not be exported are listed in the status report.
- Anniversaries support saved dates and countdowns. The current page does not integrate subscription message reminders.
- Verify WeChat capabilities such as Live Photos, location selection, audio recording, and file sharing on a physical device.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Startup displays “暂时连不上” (Unable to connect) | Confirm the Mini Program environment ID matches the environment selected in DevTools, both cloud functions are deployed, and all required collections exist. |
| You cannot reach the home page without a code | Authorize an administrator and generate a single-use access code. New users must activate a space first. |
| The second member cannot join | Open the dedicated invitation card, check that it has not expired, and confirm the space has an available member slot. |
| The admin console says “当前账号尚未授权” (Account not authorized) | Check that the `admins` document uses the `uid` shown on the login page and has `status` set to `active`. |
| The admin console still uses the old environment | Check `VITE_CLOUD_ENV_ID` in `.env` and restart the development server. Rebuild and upload deployed sites. |
| A backup fails or contains missing files | Confirm the latest `ours` function is deployed with `archiver`, check its timeout and memory settings, and inspect `backup-status.json` inside the ZIP. |

## Further documentation

- [Chinese README](./README.md)
- [Cloud deployment: database, indexes, functions, and quotas](./cloud/README.md) (Chinese)
- [Admin console: local development, initial authorization, and deployment](./admin-web/README.md) (Chinese)
- [Product documentation: design, historical features, and change history](./docs/产品功能说明.md) (Chinese)

Questions and suggestions are welcome through [GitHub Issues](https://github.com/Haoog/Ours/issues). Pull requests are welcome too.
