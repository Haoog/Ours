# 小程序 ZIP 备份解析模块

`web/wx-import.js` 是独立的浏览器 ES module，不依赖第三方库，也不读写 IndexedDB、发起网络请求或修改现有数据。模块本身只解析小程序导出的备份；网页另行执行预览和经用户确认的事务导入。

```js
import { parseWxBackup, WxImportError, WX_IMPORT_LIMITS } from './wx-import.js';

// input 为 <input type="file" multiple>；选择该次备份的全部 ZIP。
const result = await parseWxBackup(input.files);
// result.records: 从 records.json 解析出的原始记录对象，保留未知字段
// result.manifest: 从 media-manifest.json 解析出的完整清单（旧版条目可能没有 size）
// result.mediaByFileID: Map<cloud:// 文件 ID, Blob>，Blob 为未设置 MIME 类型的媒体原始字节
// result.parts: 分卷数量；result.limits: WX_IMPORT_LIMITS
// result.checks: 已执行的检查与明确无法验证的项目；result.warnings: 必须向用户说明的限制
// 失败时抛 WxImportError，error.code 可用于分支处理。
```

`error.code` 为 `INVALID_INPUT`、`LIMIT`、`ZIP_FORMAT`、`ZIP_CRC`、`READ_ERROR`、`METADATA`、`PARTS` 或 `MEDIA`。信息中的媒体路径是备份中的逻辑路径，不是本地文件系统路径。

解析器在返回前校验每个分卷的 ZIP 目录、本地头、数据描述符、无重叠的条目边界和 CRC-32；分卷总数、从 0 起的编号和 `missing`；各卷完全一致的记录文件和完整清单；清单及全部分卷的媒体并集；小程序现有回忆、吐槽、头像字段中的媒体引用。支持无媒体、旧版无 `size` 的清单、普通 ZIP 和当前生成器强制的 ZIP64。

它严格接受生成器使用的未加密、未压缩 ZIP 和生成器的 `media/00001.ext` 路径：压缩条目、未知 ZIP 扩展、ZIP 注释、尾随数据、链接、路径变形及其他不属于该格式的内容都会被拒绝。JSON 数字须能按生成器的 `JSON.stringify` 格式原样表示，防止静默舍入或变成无穷大。已知媒体字段的空条目会被拒绝；已知媒体字段或头像如果包含非空的非 `cloud://` 地址，则因 ZIP 未打包该媒体而被拒绝；不会尝试访问或下载该地址。对未知自定义字段中是否有媒体引用无法作保证，成功结果中也有对应警告。

媒体按 256 KiB 分块读取以校验 CRC，返回 Blob 切片引用所选文件，无需将全部媒体解压到内存。使用返回的 Blob 期间应保留源文件并处理读取失败；源文件在磁盘上变化时浏览器可能无法继续读取。元数据有字节、深度和节点数限制；JavaScript 引擎的对象和字符串开销不等于原始字节数。超限时抛错，无法修改限制绕过检查。确切常量见 `WX_IMPORT_LIMITS`：

| 限制项 | 上限 |
| --- | ---: |
| 分卷数 | 128 |
| 单个 ZIP / 所有 ZIP | 640 MiB / 1536 MiB |
| 单个媒体 / 所有媒体 | 512 MiB / 1024 MiB |
| 媒体数 / 七个记录数组的记录总数 | 10,000 / 50,000 |
| `records.json` / `media-manifest.json` / `backup-status.json` | 16 MiB / 8 MiB / 64 KiB |
| 单卷 ZIP 中央目录 / 每个 ZIP 路径 | 2 MiB / 255 字节 |
| 文件 ID | 4096 个 JavaScript UTF-16 代码单元 |
| 每个 JSON 的嵌套层数 / 扫描的值和键 | 64 / 250,000 |

**检查不等于真实性保证。** 历史 ZIP 未携带可靠的跨卷备份 ID 或可信媒体内容哈希，即便记录、清单、文件大小和 CRC-32 全部一致，仍无法证明所有分卷属于同一次备份，也无法证明媒体来自原始云文件。`checks.crossBackupIdentityVerified` 与 `checks.mediaAuthenticityVerified` 始终为 `false`。网页预览会说明这些限制；用户确认后，相同来源和原始 ID 的现有记录会被跳过，不会自动覆盖。

运行本地合成测试（需要先安装云函数已有的 `archiver` 依赖）：

```sh
node --test web/tests/wx-import.test.mjs
```

测试会调用真实 ZIP 生成函数，但云存储和媒体请求均为本地假实现；不会读取真实用户数据或连接线上。另可用 Node 22+ 与本机 Chrome 验证浏览器 `FileList`、`Blob` 和 ZIP64：

```sh
node web/tests/wx-import.browser.mjs
# 如 Chrome 不在默认位置，可设置 WX_IMPORT_CHROME 指向其可执行文件。
```

也可将 `web` 目录通过本机 HTTP 服务提供后，打开 `tests/wx-import.browser.html`。直接打开 `file://` 时，浏览器需要允许本地模块互相访问。
