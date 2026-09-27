# FeishuBrief Member Service

Phase 4 建立的独立成员服务，现已提供 Phase 5 成员 Console 和 Phase 6 个人通知所需接口，供课题组 5–20 人试用。使用 Node.js 24.21、TypeScript、原生 HTTP 和 SQLite，负责邀请登录、权限、个人偏好、个人简报版本、反馈、验证绑定及持久通知队列。内容采集和模型处理继续由 `FeishuBrief-next` 完成。

源码仓库：[No1dry/FeishuBrief-Member](https://github.com/No1dry/FeishuBrief-Member)。前端独立位于 [No1dry/FeishuBrief-Console](https://github.com/No1dry/FeishuBrief-Console)，内容引擎位于 [No1dry/FeishuBrief](https://github.com/No1dry/FeishuBrief)。本仓库可独立安装、类型检查和运行离线测试；文中同级目录链接及 `engine:check` 用于多工程开发工作区，不是生产运行依赖。

## 当前可用范围

- 管理员邀请成员；成员使用邮箱中的 8 位验证码登录，无需密码或 GitHub Token。
- 四种角色：课题组管理员、主题负责人、成员、只读成员。每次请求重新检查权限。
- 个人偏好和订阅版本持久化；主次主题、关键词、内容类型、条数等可调整。
- 共享内容通过带校验证据的引擎导出导入；组装预览、固定版本、历史和反馈不调用模型。
- 完整成员 Console 提供订阅、未保存草稿预览、站内简报、历史、内容库和收藏；历史收藏仍受当前阅读权限和内容撤回限制。
- 管理 Console 提供成员邀请和授权、主题目录编辑、实际导入/组装汇总及审计；运行汇总不展示他人的私人正文。
- 个人数据保存在私有数据库；现有群体完整简报及群推送流程继续保留。
- 个人飞书私聊验证和 PushPlus 好友验证码绑定；固定版本通知、持久队列、限频退避、未知结果核对及管理员补发。
- 成员可设置上海时区的每日/工作日计划；暂停、解绑、账号停用会取消未发送任务。后台投递与调度默认关闭。

入口和交互见 [Phase 5 Console](https://github.com/No1dry/FeishuBrief-Console/blob/main/docs/phase5-implementation.md) 与 [Phase 6 个人通知](docs/phase6-implementation.md)。本地实现与模拟验证不等于上线：生产域名、服务器、SMTP 和两渠道真实绑定/收件仍待部署验收。公开自助注册继续关闭。

## 本地试用

需要 Node.js `>=24.21.0 <25`。本项目、`FeishuBrief-next` 和 `FeishuBrief-Console` 保持为同级目录，便于校验引擎契约和构建 Console。

```powershell
cd FeishuBrief-Member
npm ci
npm run typecheck
npm test
```

只有同时检出相邻 `FeishuBrief-next` 源码的维护者才需执行 `npm run engine:check`；独立克隆本仓库不需要该步骤。引擎运行所需的四份纯函数文件已随源码受控保存，来源和许可见 [引擎副本说明](src/engine/NOTICE.md)。

创建仅供本机使用的 `.env`，不要提交该文件。下面的 `MEMBER_SECRET` 必须替换为随机密钥：

```dotenv
NODE_ENV=development
MEMBER_ORIGIN=http://127.0.0.1:5180
MEMBER_HOST=127.0.0.1
MEMBER_PORT=5190
MEMBER_ALLOW_INSECURE_LOCAL=true
MEMBER_SECRET=替换为至少32字节的随机密钥
MEMBER_DATABASE_PATH=data/member.sqlite
MEMBER_MAIL_MODE=local
MEMBER_LOCAL_MAIL_PATH=data/local-mail
```

可以执行以下命令生成密钥，将结果自行保存到 `.env`。机器导入需要另行生成一个不同的密钥并设置 `MEMBER_MACHINE_TOKEN`；本地未设置时机器接口关闭。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run bootstrap -- owner@example.test "课题组管理员"
npm run dev
```

`bootstrap` 只建立首位管理员的登录资格，不会发送邮件或直接创建会话。已有活跃管理员时不能再次初始化。开发邮件保存到私有 `data/local-mail` 目录；本地模拟登录时从该目录读取验证码，生产环境必须使用 SMTP。

另开终端运行 Console：

```powershell
cd FeishuBrief-Console
npm ci
$env:MEMBER_API_PROXY='1'
npm run dev -- --host 127.0.0.1 --port 5180 --strictPort
```

打开 `http://127.0.0.1:5180/app`。输入初始化邮箱、请求验证码，在同一浏览器完成验证。管理员可以在成员页面的管理区域邀请其他成员。邀请邮件使用 URL fragment 承载一次性令牌，页面读取后清理地址；邀请限定邮箱，72 小时内有效。

首次启动的数据库没有共享内容。管理员账号和邀请登录可以先验证；雷达、默认偏好和个人简报需要先导入已通过引擎校验的内容。引擎桥接命令为 `member:topics` 和 `member:export`，具体操作见 [引擎集成文档](https://github.com/No1dry/FeishuBrief/blob/main/docs/phase4-integration.md)，不能用任意 JSON 伪造 ready 内容。

## 项目脚本

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 自动读取 `.env`，监听代码变化启动本地服务 |
| `npm start` | 自动读取 `.env`，启动单实例服务 |
| `npm run bootstrap -- <邮箱> [名称]` | 初始化首位管理员；不会发送邮件 |
| `npm run backup -- <新备份文件>` | 通过 SQLite backup API 创建私有一致性备份，不覆盖已有文件 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 模拟邮件、临时数据库和合成内容的离线测试 |
| `npm run engine:check` | 检查已复制的引擎契约、组装器及验证器与源文件一致 |
| `npm run engine:sync` | 引擎变更后同步受控副本；不要手工编辑 `src/engine` |

运行脚本使用 Node 原生 `--env-file-if-exists=.env`，无需 dotenv。数据库启动时按顺序应用 `migrations/*.sql`，由 `schema_migrations` 记录已应用迁移。

## 服务边界

- `/app` 是邮箱登录的成员页面，管理员也在这里使用成员服务管理功能。
- Console 原有管理员工作台继续保留；它的 GitHub 工作流操作属于现有引擎管理路径，不会转化为普通成员权限。
- 前端和 `/api/member` 必须同源。生产环境使用 HTTPS，通常由反向代理终止 TLS。
- 服务仅支持单进程、单主机 SQLite WAL 部署；不要同时启动多个副本共享数据库，不要将数据库放入公共站点或同步网盘。
- 个人通知需经验证绑定，并由明确发送操作或已开启的计划入队；保存订阅与预览本身不会发送消息。

详细说明：[部署与运维](docs/deployment.md)、[API 契约](docs/api.md)。

## Phase 5 验证记录（2026-09-27）

- Member 类型检查和 29 项测试通过：邀请与会话、权限和并发版本、持久化、真实 HTTP 接口、内容证明及撤销，以及 Phase 5 草稿零写入、收藏/反馈隔离、运营汇总和 CSP。四份引擎文件一致性校验沿用 Phase 4 验证，Phase 5 未修改引擎副本。
- Phase 5 最终 Console 60 项浏览器测试全部通过，生产构建及真实本机 Chrome/HTTP 联调通过，覆盖内容库、收藏、个人版本、管理页面、会话清理和响应头；范围与复现命令见 [Phase 5 实现说明](https://github.com/No1dry/FeishuBrief-Console/blob/main/docs/phase5-implementation.md)。
- 引擎既有 18 组离线检查通过，新增第 19 组 `member:check` 通过，包含两个命令入口和本机模拟接收端。类型检查通过。
- 检查未访问真实模型或发送真实邮件、飞书/PushPlus 消息。生产 SMTP、HTTPS 反向代理和 Linux 服务部署尚待实际服务器验收；Actions 工作流仅已编写，未触发线上运行。

Phase 6 的绑定、个人通知和定时入口已实现；能力接口依据服务端实际配置返回开关，默认 `personalDelivery.enabled=false`、`scheduler.enabled=false`。个人通知发送更新提醒和需本人登录的固定版本链接，正文在 Console 阅读。后续公开邮箱注册已保存在 [产品化与邮箱自主注册方案](docs/product-email-registration-plan.md)，当前服务保持邀请制。

Phase 6 最终本地验证为 64 项 Member 测试通过、类型检查通过、四份引擎文件一致性通过。Console 构建与真实本机 HTTP/Chrome 联调通过，详细记录见 [Phase 6 说明](docs/phase6-implementation.md)。以上均为合成数据和模拟通道，不代表线上部署或真实收件验收。

部署模板提供 [systemd 单实例服务](deploy/systemd/feishubrief-member.service)、[生产环境变量示例](deploy/member.env.example) 和 [同源 Nginx 代理](deploy/nginx/feishubrief.conf)，均使用示例域名且不含凭据。

[独立 Member CI](.github/workflows/test.yml) 固定 Node `24.21.0`，执行锁定依赖安装、类型检查和离线测试。测试阶段仅允许本机回环网络；工作流不需要相邻引擎仓库，也不运行模型、SMTP 或消息推送。引擎源码一致性检查仍在同级项目开发/打包流程执行。
