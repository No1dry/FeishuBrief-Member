# 部署与运维

## 当前部署状态与拓扑

本阶段已提供本地实现、离线测试和部署配置示例，尚未启动线上实例，也未发送真实邀请邮件。正式组内启用还需要确定域名、运行主机、SMTP 发信账号及首位管理员邮箱，然后由管理员完成一轮真实邀请验收。

部署为一个 Member Service 进程、一份本机持久化 SQLite 数据库、一个同源 Console。服务默认监听 `127.0.0.1:5190`。外部 HTTPS 反向代理将 `/api/member/` 转发到该服务，并将成员页面放在同一域名 `/app`。

静态文件可以由反向代理直接提供，也可以设置 `MEMBER_CONSOLE_DIR` 为已构建的 Console `dist` 绝对路径，由 Member Service 提供前端文件，再统一经过 HTTPS 代理。不要将私有数据库、邮件目录、引擎导出包或 `.env` 放进 `dist` 或其他公开根目录。

当前是单主机试用方案，不支持多副本部署或跨主机共享 SQLite 文件。产品化扩容前先迁移为支持多实例的数据库和相应并发机制。

## 运行与依赖

- 使用 Node.js `>=24.21.0 <25`。服务通过 `node:sqlite` 的同步 API 访问数据库，开启外键、WAL 和 5 秒 busy timeout。
- 使用提交的 `package-lock.json` 执行 `npm ci`。本次 Nodemailer 已升级到 `10.0.10`，依赖审计未发现已知漏洞；依赖变更后重新审计。
- `start`、`dev`、`bootstrap`、`backup` 通过 Node 原生 `--env-file-if-exists=.env` 读取配置。工作目录应为 Member 项目根目录，相对数据路径按该目录解析。
- 数据库首次打开时按文件名顺序应用 `migrations/*.sql`，迁移和记录在事务中完成。不要修改已经应用的迁移；新增迁移应新增编号文件。
- `src/engine` 为受控引擎副本。部署前执行 `npm run engine:check`，不直接修改副本。

## 配置变量

| 配置 | 含义与限制 |
| --- | --- |
| `NODE_ENV` | 生产使用 `production` |
| `MEMBER_ORIGIN` | Console 的准确源，例如 `https://brief.example.org`；不可带路径、参数或凭据 |
| `MEMBER_HOST` | 默认 `127.0.0.1`；本地不安全模式仅允许 loopback |
| `MEMBER_PORT` | 默认 `5190` |
| `MEMBER_DATABASE_PATH` | 默认 `data/member.sqlite`；持久化私有路径 |
| `MEMBER_SECRET` | 至少 32 字节随机密钥，用于验证码、邀请、会话及 CSRF 的认证派生 |
| `MEMBER_MACHINE_TOKEN` | 独立的至少 32 字节随机密钥；生产必须设置；本地留空则机器接口关闭 |
| `MEMBER_CONSOLE_DIR` | 可选，构建后的 Console `dist` 绝对路径 |
| `MEMBER_MAIL_MODE` | 生产为 `smtp`；显式本地开发可为 `local` |
| `MEMBER_SMTP_HOST` | SMTP 主机；SMTP 模式必填 |
| `MEMBER_SMTP_PORT` | 默认 `465` |
| `MEMBER_SMTP_SECURE` | 默认 `true` 表示连接即 TLS；设为 `false` 时仍强制 STARTTLS，不允许明文发送 |
| `MEMBER_SMTP_FROM` | 发信地址，SMTP 模式必填 |
| `MEMBER_SMTP_USER` / `MEMBER_SMTP_PASSWORD` | 如需认证，两者必须一起设置 |
| `MEMBER_ALLOW_INSECURE_LOCAL` | 仅本地使用 `true`；同时要求非 production、loopback origin 和监听地址 |
| `MEMBER_LOCAL_MAIL_PATH` | 本地文件邮箱路径，默认 `data/local-mail`；仅开发，不通过 HTTP 提供 |

SMTP 强制 TLS、校验证书并要求至少 TLS 1.2；连接、握手和 socket 均设置超时。邮件不读取任意本地文件或 URL。凭据只在服务端环境或私有 `.env` 中保存。

首次配置时分别执行下面命令两次，将两个结果保存在 `MEMBER_SECRET` 和 `MEMBER_MACHINE_TOKEN`，不要重复使用同一密钥：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

本地调试完整步骤见 [README](../README.md)。该流程使用模拟邮箱域名和文件邮箱，不能证明生产 SMTP 可以成功到达真实收件箱。

## 上线步骤

1. 在持久化主机上安装锁定依赖，执行类型检查、引擎契约一致性检查和离线测试；在 Console 项目执行构建。
2. 根据 `.env.example` 设置真实 HTTPS origin、独立随机密钥、私有数据库路径及 SMTP 配置。用服务账号限制数据目录和 `.env` 的访问权限；Windows 上同时配置实际 NTFS 权限，不能仅依赖 POSIX mode。
3. 为 Console 和 `/api/member/` 配置同源 HTTPS。转发原始浏览器 `Origin`，不要把它改成服务内部地址。登录相关响应不得缓存；代理不得记录请求体、Cookie、Authorization 或邮件内容。
4. 执行 `npm run bootstrap -- <管理员邮箱> [显示名称]`。命令只初始化资格，不发送邮件、不设置密码，也不创建已登录会话。
5. 以单实例方式启动 `npm start`，确认 `/health` 返回正常；进程托管器负责退出后重启，工作目录保持固定。
6. 管理员访问 `/app`，请求验证码并从真实邮箱登录；邀请一个组内测试成员，验证邀请接受、登出、禁用后会话失效及无权读取其他成员数据。
7. 从引擎导入小范围、已验证共享内容，核对站内雷达和个人预览。不要为上线验收启动全量采集、模型处理或真实群推送。

步骤 6 的真实邮件与线上验收尚未执行。Phase 6 已实现飞书/微信身份绑定、持久个人通知与定时任务；默认关闭运行开关，需按 [Phase 6 接入说明](phase6-implementation.md) 配置并单独验收。现有群体完整简报推送由原流程维护。

## Linux 部署模板

仓库提供三个需要运维替换路径/域名后使用的文件，当前未在本机安装服务或启用代理：

| 文件 | 约定 |
| --- | --- |
| [systemd unit](../deploy/systemd/feishubrief-member.service) | 用户/组 `feishubrief`，工作目录 `/opt/feishubrief/member`，Node 可执行文件 `/usr/bin/node` |
| [环境文件示例](../deploy/member.env.example) | 安装到 `/etc/feishubrief/member.env`；空密钥和 SMTP 字段会阻止服务启动 |
| [Nginx 配置](../deploy/nginx/feishubrief.conf) | 示例域名 `brief.example.org`，TLS 证书路径需替换，转发到 `127.0.0.1:5190` |

示例通过 Member Service 提供 `/opt/feishubrief/console/dist` 中的已构建 Console。Nginx 转发全部路径，保持 `/api/member/` 前缀和浏览器 `Origin`，关闭缓存及请求/响应落盘缓冲，并将 `/app/`、`/admin/` 重定向为无尾斜杠的入口，兼容当前相对资源路径。配置指令含义见 [Nginx 官方代理文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。

### Console 响应头与入口隔离

服务提供完整的路径级 CSP；Nginx 必须转发该响应头，不另行追加残缺或冲突的 CSP。模板只在代理层去重 HSTS。`/` 跳转到 `/app`，成员入口和管理员入口需要加载各自的完整文档，不能仅修改浏览器 history/hash 后复用旧文档的策略。

- `/app` 和其他成员页面：`connect-src 'self'`，浏览器只能连接同源成员服务。
- `/admin`：额外允许 `https://api.github.com`，供既有引擎 Console 的 GitHub 操作使用；不会因此开放其他远程 API。
- JavaScript 只允许本站脚本，不允许内联脚本或 `eval`。样式允许本站和内联组件样式属性，字体仅允许本站，与已构建 Console 的自托管字体一致。
- 图片只允许本站和 `data:`；对象、iframe 和外部页面嵌入均禁用；表单提交限于本站。
- 生产启用 `upgrade-insecure-requests`、HSTS、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、同源 COOP/CORP 和关闭摄像头/麦克风等权限的 Permissions Policy。所有响应不缓存。
- 每个服务端 HTML 注入 `<base href="/">`，使深链接仍从根路径加载构建资源；同时注入 `feishubrief-surface` meta，供前端跨入口时强制整页导航。静态 Pages 未经此服务处理，不具备该运行时隔离标记，不能当作生产成员服务入口。

API 响应单独采用 `default-src 'none'` 的最小策略。Vite 开发服务器的 HMR 属于开发环境，不应通过放宽生产 CSP 来支持；浏览器生产验收使用构建后的 `dist`。

准备服务账号和目录时，代码/依赖/Console 由部署账号管理，服务账号只需读取；私有持久化目录为 `/var/lib/feishubrief`。systemd 的 `StateDirectory` 创建该目录并限制权限，`ProtectSystem=strict` 将其他文件系统路径设为只读，`PrivateTmp` 为运行时缓存提供私有临时目录。环境文件应为 `root:feishubrief` 所有、`0640`，上级配置目录至少限制到 `0750`。相关能力见 [systemd 官方执行配置](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)。

运维需要先创建账号、部署项目、安装依赖、放置 Console 构建产物及完整环境文件，并验证 `/usr/bin/node --version` 为 `v24.21.0`。然后按实际安装位置检查配置：

```bash
sudo systemd-analyze verify /etc/systemd/system/feishubrief-member.service
sudo nginx -t
```

首次引导或备份使用相同环境文件和服务账号，从 `/opt/feishubrief/member` 运行；不要在命令行参数中写入真实密钥：

```bash
sudo -u feishubrief /usr/bin/node --env-file=/etc/feishubrief/member.env --import tsx scripts/bootstrap.ts owner@example.org "课题组管理员"
sudo -u feishubrief /usr/bin/node --env-file=/etc/feishubrief/member.env --import tsx scripts/backup.ts /var/lib/feishubrief/backups/member-before-update.sqlite
```

引导前 `/var/lib/feishubrief` 需要由运维预先创建并授予服务账号 `0700` 权限，或先启动一次 unit 让 systemd 创建；Node 不会自行获得写入 `/var/lib` 的权限。上面的邮箱仅为示例，运维应替换为实际首位管理员。

确认配置正确后，可由运维执行 `systemctl daemon-reload`、`systemctl enable --now feishubrief-member` 并加载 Nginx 配置。不得额外运行第二个 `npm start` 或配置多 worker。模板提供可审阅的部署起点，当前 Windows 验证环境没有执行 Linux systemd/Nginx 的运行验收。

## 独立离线 CI

[`.github/workflows/test.yml`](../.github/workflows/test.yml) 可随 Member 项目根目录独立提交，触发于 push、pull request 和手动执行，权限仅 `contents: read`，checkout 不保留凭据。Node 固定为 `24.21.0`。

安装锁定依赖后执行 `npm run typecheck`，随后在独立 Linux 网络命名空间中执行与 `npm test` 相同的 TypeScript 测试入口。命名空间仅启用 loopback，允许测试本机 HTTP 服务，无法连接模型服务、真实 SMTP 或消息平台；没有提供任何业务密钥，也不上传私有数据产物。安装依赖本身需要 npm 网络连接。工作流语法见 [GitHub Actions 官方文档](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)。

该 CI 使用 Ubuntu 托管 runner 的 `sudo`、`unshare` 和 `ip`；若网络隔离无法建立会直接失败，不降级为允许外网的测试。它不运行 `engine:check`，因为独立仓库没有相邻的 `FeishuBrief-next`；打包前仍需在包含两个项目的工作区执行该一致性检查。当前只准备了 workflow 文件，未推送或触发云端 Actions。

## 权限和会话管理

| 角色 | 能力 |
| --- | --- |
| `lab_owner` | 邀请、角色/权限分配、成员停用、全主题管理、审计和撤回 |
| `topic_owner` | 管理已有且获授权的主题，使用自己的订阅和简报 |
| `member` | 调整自己的偏好/订阅、预览/固定个人版本、反馈 |
| `viewer` | 读取当前允许查看的内容；不能修改个人设置、固定版本或写反馈 |

所有角色都受账号状态检查。主题读取授权由 `readTopicIds` 控制，默认 `['*']`；主题编辑授权由 `ownedTopicIds` 控制。后台更新角色、主题授权或停用账号后，会撤销全部已有会话和未使用验证码挑战。最后一名活跃管理员不能被停用或降级。

会话不因服务器重启消失，但仍受 7 天绝对有效期和 12 小时闲置上限约束。更换 `MEMBER_SECRET` 会使现有会话、验证码及待接受邀请无法匹配；轮换后需要成员重新登录并重新发送未完成邀请。更换机器密钥时同步更新引擎端配置。

请求限流使用直连 socket IP，**目前不信任 `X-Forwarded-For`**。位于单一反向代理后的请求会共用该代理 IP 的每小时 30 次验证码发送上限。对 5–20 人试用可错开发送；如有并发需求，应实现受控代理 IP 信任与配额调整，不能直接信任任意客户端头。

## 备份、恢复与更新

使用项目提供的 SQLite backup API 创建一致性备份：

```powershell
npm run backup -- data/backups/member-before-update.sqlite
```

备份命令不会覆盖已有文件。备份包含成员邮箱、授权、私有内容、会话哈希和审计数据，需要与生产数据库相同的保护。保留周期和外部备份位置由组内运维确定；当前服务没有自动轮换或清理计划。

恢复时先停止唯一服务实例，保留原数据库和 WAL/SHM 文件作为可回退副本，再将完整备份放到一个新的私有路径，通过 `MEMBER_DATABASE_PATH` 指向它后启动。不要在运行中覆盖数据库，也不要把旧 WAL/SHM 文件与恢复的备份混用。**恢复旧备份前将两个通知运行开关设为 false**，先核对备份之后平台可能已受理、但备份中仍为待发送的任务；不能直接重开消费者。恢复后检查迁移记录、账号、主题目录、最新个人版本与投递记录；备份之后发生的更新需要明确处理。

升级前先备份，再部署代码、执行迁移和验收。数据库迁移只提供向前应用；降级代码必须先评估 schema 兼容性，不能假定旧版本可直接读取新 schema。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 启动拒绝 HTTP | 生产必须 HTTPS；本地检查 loopback origin 和 `MEMBER_ALLOW_INSECURE_LOCAL=true` |
| 点击发送后未收到验证码 | 核对账号是否已激活或邀请有效、SMTP 配置和发信域权限；API 不披露账号是否存在 |
| `origin_rejected` | 对比页面 origin 与 `MEMBER_ORIGIN`，包含协议和端口；检查代理没有改写 Origin |
| `invalid_code` | 同一浏览器发起和验证、8 位验证码、10 分钟有效期、最新一次挑战、最多 5 次尝试 |
| `rate_limited` | 数据库限流不会因重启恢复；检查邮箱冷却和代理共享 IP 配额 |
| 内容暂不可用 | 尚未导入 ready 内容、主题规则已变化需重新处理、内容被撤回，或读取权限改变 |
| 保存返回 `revision_conflict` | 重新读取版本并重新确认草稿；不能自动覆盖其他人的修改 |
| 邀请邮件失败 | 管理员接口返回 `mail_unavailable`，失败邀请已撤销；修复 SMTP 后重新邀请 |

本阶段测试使用合成身份、临时 SQLite、注入时钟和邮件接收器，未使用真实 SMTP、真实成员或个人外部通知。
