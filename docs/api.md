# Member Service API

所有业务接口以 `/api/member/` 为前缀。除机器接口和下述平台回调外，只服务同源 Console。本文以实现中的字段为准；浏览器请求对象采用严格 schema，未知字段会返回 `400`。

## 通用规则

- 浏览器写请求使用 `Content-Type: application/json`，`Origin` 必须精确等于 `MEMBER_ORIGIN`。跨站请求被拒绝。
- 登录后写请求还需要 `X-CSRF-Token`，值取自会话响应。会话令牌仅存在 HttpOnly Cookie，不在 JSON 中返回。
- Cookie 为 `SameSite=Lax; Path=/`；生产环境额外使用 `Secure` 和 `__Host-` 前缀。登录挑战 Cookie 10 分钟有效；会话绝对有效期 7 天、闲置上限 12 小时。
- 私有响应使用 `Cache-Control: no-store`。请求不接受 query 参数；分页和搜索参数尚未开放。
- 普通 JSON 请求最大 64 KiB，机器导入最大 20 MiB。暂不支持请求体压缩。
- 错误结构为 `{ "error": "错误代码" }`，不会返回数据库、SMTP 凭据或内部异常堆栈。

## 登录与邀请

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET auth/config` | 无 | `{registrationMode:"invite-only",emailLogin:true}` |
| `POST auth/request-code` | `{email,invitationToken?}` | `202 {challengeId}`，同时设置浏览器挑战 Cookie |
| `POST auth/verify-code` | `{challengeId,code}` | `200` 会话对象，设置会话 Cookie 并清除挑战 Cookie |
| `GET session` | 会话 Cookie | 当前会话对象 |
| `POST logout` | `{}`，会话和 CSRF | `204`；撤销会话并清除 Cookie |

会话响应为平铺对象：

```json
{
  "userId": "用户 UUID",
  "displayName": "组内成员",
  "csrfToken": "当前会话的 CSRF 令牌",
  "preferencesEnabled": true,
  "role": "member",
  "ownedTopicIds": [],
  "readTopicIds": ["*"]
}
```

首次登录需要有效的邀请令牌与该邀请指定的邮箱。已激活成员后续只需邮箱验证码。未知邮箱、未获邀邮箱和缺少有效邀请的待激活邮箱均返回同样的 `202` 响应格式，且不会自动创建账号。发送失败的验证码被立即作废，响应不会泄露 SMTP 详情。

验证码为 8 位数字，有效期 10 分钟，单次挑战最多验证 5 次；新挑战会使该邮箱的旧挑战失效。邮件请求按邮箱限制为每小时 8 次、至少间隔 60 秒，按连接 IP 限制为每小时 30 次。验证码验证每 IP 每小时最多 60 次。计数持久化于数据库，进程重启不会重置。

邀请令牌只通过邀请邮件发送，不经管理员 API 返回；使用后失效。重新邀请待激活邮箱会撤销旧邀请，但不会隐式改动该成员的既有授权。

## 成员内容与订阅

下列接口均检查当前账号状态及服务端主题读取权限。调用者不能通过请求体传入其他 `userId` 读取或修改他人数据。

| 方法与路径 | 请求/响应重点 |
| --- | --- |
| `GET capabilities` | 当前服务能力；个人投递/调度按配置返回且默认关闭，结构见下文 |
| `GET topics` | `{topics:[{id,name,revisionId,scope,subtopics}]}`，仅返回可读的启用主题 |
| `GET radar` | 返回经过权限与撤回过滤的 `RadarSnapshot` |
| `GET library` | `{items:[{item:RadarItem,origin,feedback}],currentAvailable}`；当前候选与本人收藏历史，按事件去重 |
| `GET preferences` | `{revision,preferences}`；首次版本标识为 `"initial"` |
| `PUT preferences` | `{baseRevision,preferences}` → `{revision,preferences}` |
| `GET subscription` | `{revision,subscription}`；未建立订阅时为 `{revision:"initial",subscription:null,defaults}` |
| `PUT subscription` | `{baseRevision,subscription}` → `{revision,subscription}` |
| `POST preview` | `{subscriptionRevisionId?}` 或 `{subscription:完整订阅草稿}` → `{edition,finalized:false,draft}`；不保存草稿或个人历史 |
| `GET editions` | `{editions:[{editionId,reportDate,cutoffAt,status,count,finalized}]}`，最多最近 100 条 |
| `POST editions` | `{requestId,subscriptionRevisionId?}` → `{edition,finalized,idempotent}` |
| `GET editions/:editionId` | `{edition,finalized}`；检查当前访问权限、撤回状态及保存版本完整性 |
| `POST feedback` | `{targetEventId,kind,retractsFeedbackId?}` → 持久化反馈对象 |
| `GET feedback` | `{revision,items:[{eventId,read,saved,notRelevant,feedback:[{feedbackId,kind,occurredAt}]}]}`；只含本人当前有效、仍可访问的反馈 |

`preferences` 为 `{primaryTopicId,secondaryTopicIds,keywords,excludeKeywords,subtopicIds,codeOnly}`。`subtopicIds` 是主题 ID 到子方向 ID 数组的映射。主次主题须存在、启用且可读，子方向必须属于对应选中主题。

`subscription` 除上述字段外还包括：

| 字段 | 取值 |
| --- | --- |
| `contentTypes` | 非空数组：`paper`、`repository`、`research`、`industry`、`opinion`、`video` |
| `maxItems` | 1–50 的整数 |
| `primaryShare` | 0–1 |
| `preferOpenSource` | 布尔值 |
| `frequency` | `daily`、`weekdays`、`paused` |
| `channel` | `in-app`、`feishu`、`wechat`；保存仅改变选择，外部发送还需绑定及显式投递/已启用计划 |
| `firstEditionLookbackDays` | 1 或 7 |

写入偏好和订阅共享同一版本链。`baseRevision` 必须等于最近一次读取的版本，冲突返回 `409 revision_conflict`。保存订阅本身不会运行采集、模型、个人外部发送或定时任务。

草稿预览使用上表完整 `subscription` 设置字段，不接受 `memberId`、`effectiveAt`、`revisionId` 或其他身份字段。`subscription` 与 `subscriptionRevisionId` 互斥；`{}` 继续预览当前已保存订阅。草稿无需先保存，服务端重新验证当前主题和子方向权限，并使用当前用户、反馈及已收录历史组装。草稿不会创建订阅修订、正式版本、反馈或发送任务；`draft:true` 只说明本次使用未保存设置，固定正式版本仍使用已保存订阅。

能力响应为：

```json
{
  "schemaVersion": 1,
  "library": true,
  "feedback": true,
  "draftPreview": true,
  "personalEditions": true,
  "notificationBindings": true,
  "personalDelivery": { "enabled": false, "phase": 6, "channels": [] },
  "scheduler": { "enabled": false, "phase": 6 },
  "groupDelivery": { "mode": "existing-engine" }
}
```

能力接口需要登录。上例是默认无个人通道配置的响应；`personalDelivery.channels` 列出已配置通道，`enabled` 还要求部署启用消费者，`scheduler.enabled` 取决于两个运行开关。`notificationBindings:true` 表示已有绑定页面接口，不代表任何账号已绑定。`groupDelivery` 仅说明既有引擎继续负责群体完整简报，不代表本服务已读取或确认任何群发送状态。

内容库 `origin` 为 `current` 或 `saved-history`。`item` 使用雷达卡片的展示字段，不返回原始全文、候选内部标识、原始诊断或其他成员数据。当前候选有相同事件时优先选用当前候选，多个当前修订按发布时间、质量去重；没有当前候选时，只有仍处于收藏状态的本人历史条目进入内容库。历史条目逐条检查当前主题读取权限和撤回状态，并裁剪无权访问的主题标签；某条历史内容被撤回不影响同版中其他仍有效的收藏条目。主题目录等待重新处理时，`currentAvailable:false`，仍可显示允许访问的历史收藏；收藏不会绕过内容撤回或阅读权限。

固定版本请求的 `requestId` 为 8–100 位字母、数字、下划线或短横线，限定在当前成员内。相同请求与相同订阅版本会返回已保存结果；复用请求标识生成另一订阅版本返回 `409 request_conflict`。仅 ready 版本推进已收录历史；空结果不凑数。

**`edition` 是用于成员展示的投影，会省略内部 `diagnostics`。** 数据库保存完整不可变版本及组装输入，服务端负责校验和回放。不能将 API 的展示投影当作完整 `PersonalEdition` 再计算哈希或传回引擎回放。

反馈 `kind` 支持 `read`、`saved`、`not-relevant`、`retract`。普通反馈必须指向当前用户可访问的内容；撤回必须指定自己的既有反馈 ID，不能撤回其他用户的反馈，也不能重复撤回。`GET feedback` 和库内 `feedback` 状态中的数组仅包含尚未撤回的普通反馈，其 `kind` 不含 `retract`；时间是 ISO 字符串。库内 `feedback` 对象与反馈项相同，但省略 `eventId`。重复操作可能产生同类型的多个有效反馈 ID，取消某个状态时应撤回该类型全部有效 ID；仍有一个收藏反馈有效时 `saved` 仍为 `true`。`revision` 是当前本人可见反馈状态的哈希，不作为写请求的 CAS 版本。

## 管理员接口

| 方法与路径 | 权限 | 请求/响应 |
| --- | --- | --- |
| `GET admin/members` | `lab_owner` | `{members:[MemberUser]}` |
| `POST admin/invitations` | `lab_owner` | `{email,displayName?,role?,ownedTopicIds?,readTopicIds?}` → `{user,invitation}` |
| `GET admin/invitations` | `lab_owner` | `{invitations:[...]}`，最多最近 200 条 |
| `PUT admin/members/:userId` | `lab_owner` | `{baseRevision,displayName?,role?,ownedTopicIds?,readTopicIds?,status?}` → `{member}` |
| `GET admin/audit` | `lab_owner` | `{events:[...]}`，最多最近 200 条 |
| `GET admin/operations` | `lab_owner` | 导入、组装、真实投递记录/计数和调度状态，结构见下文 |
| `GET admin/topics` | `lab_owner` / `topic_owner` | `{revision,profiles}`；主题负责人仅见自己负责的主题 |
| `PUT admin/topics/:topicId` | 管理员可新增；负责人只可改已有授权主题 | `{baseRevision,profile}` → `{profile,reprocessingRequired:true}` |
| `DELETE admin/topics/:topicId` | 管理员或相应负责人 | `{baseRevision}` → `{revision,deleted:true,reprocessingRequired:true}` |
| `POST admin/revocations` | `lab_owner` | `{revisionId,reason}` → `{revoked:true}` |

`MemberUser` 包含 `{userId,email,displayName,status,role,revision,ownedTopicIds,readTopicIds}`。这里的 `revision` 和 `baseRevision` 是正整数；内容订阅与主题版本使用字符串，两者不要混用。

角色为 `lab_owner`、`topic_owner`、`member`、`viewer`。账号状态为 `invited`、`active`、`disabled`；管理员更新接口接受 `active` 或 `disabled`。邮箱未完成验证时不能通过状态更新直接激活。角色、主题授权和状态变动会撤销该用户的所有会话及未使用挑战；不能停用或降级最后一名活跃管理员。

邀请响应为 `{invitationId,email,expiresAt,status:"pending"}`，`expiresAt` 是 Unix 毫秒。列表状态还可能为 `accepted`、`revoked`、`expired`。邀请发送失败返回 `503 mail_unavailable` 并撤销本次邀请，管理员可修复邮件配置后重新邀请。

主题写入中的 `profile` 为主题配置本体，带有 `id,name,enabled,priority,weight,keywords,aliases,excludeKeywords` 以及范围、示例、子方向、阈值等可选项。首次创建使用 `baseRevision:"initial"`；后续使用当前 profile 的 `revisionId`。至少保留一个启用主题，当前目录上限 12 个。主题修改后旧审阅结果不会自动冒充新规则结果，需要引擎重新处理并导入符合新版本的内容。

运行汇总结构如下，所有时间字段为 ISO 字符串，`lastCreatedAt` 在尚无个人版本时为 `null`：

```typescript
{
  generatedAt: string,
  content: {
    readyImports: number, revokedRevisions: number, activeTopics: number,
    catalogRevision: string, currentCatalogReady: boolean,
    latestImports: Array<{
      exportId: string, snapshotId: string, reportDate: string,
      cutoffAt: string, generatedAt: string, importedAt: string,
      status: "ready", catalogCurrent: boolean
    }>
  },
  assembly: {
    status: "on-demand", editions: number, officialEditions: number,
    membersWithEditions: number, lastCreatedAt: string | null
  },
  delivery: {
    enabled: boolean, phase: 6, records: DeliveryView[], counts: Record<string, number>,
    worker: { enabled: boolean, started: boolean, running: boolean,
      lastStartedAt: string | null, lastFinishedAt: string | null, lastOutcome: "idle" | "ok" | "failed" }
  },
  scheduler: { enabled: boolean, phase: 6, timeZone: "Asia/Shanghai",
    configuredMembers: number, enabledMembers: number, lastRunAt: string | null },
  groupDelivery: { mode: "existing-engine" }
}
```

`latestImports` 最多 20 条，按实际导入时间排序。`ready` 表示导入当时已完整验证并原子提交，`catalogCurrent` 另外表示它是否匹配当前启用主题修订；`currentCatalogReady:false` 提醒管理员等待按新目录处理的内容。组装本身仍为同步调用，标为 `on-demand`；Phase 6 的定时器可在独立计划下调用它。投递区提供管理员所需的成员、固定版本 ID 与状态，不返回私人正文、订阅、平台目标或凭据。主题负责人和普通成员均无权访问汇总。审计记录通过 `admin/audit` 读取。

## Phase 6 绑定、计划与投递

浏览器写接口均检查会话、Origin、CSRF；`viewer` 可以读取本人状态，不能绑定、改计划或投递。平台目标永远由验证流程取得，浏览器不得传 `open_id`、`chat_id`、好友 Token 或任意接收人。

| 方法与路径 | 请求 / 响应 |
| --- | --- |
| `GET notifications` | `{channels:[{channel,configured}],bindings:BindingView[],schedule,deliveries:DeliveryView[]}` |
| `POST notifications/bindings/:channel/start` | `{}` → `201 ChallengeView`，channel 为 `feishu` / `wechat` |
| `GET notifications/challenges/:id` | 本人、同登录会话的挑战状态 |
| `GET notifications/challenges/:id/qr` | 经认证的限时二维码图片，不接受任意源 URL |
| `POST notifications/challenges/:id/confirm` | 飞书 `{}`，微信 `{code:"8位验证码"}` → `{binding:BindingView}` |
| `DELETE notifications/bindings/:id` | `{}` → `{ok:true}`；事务中解绑并取消此渠道待发任务 |
| `GET notifications/schedule` | `{revision,enabled,localTime,timeZone:"Asia/Shanghai",systemEnabled}` |
| `PUT notifications/schedule` | `{baseRevision,enabled,localTime,timeZone:"Asia/Shanghai"}` → 新计划；`HH:mm`；CAS 冲突 `409` |
| `GET notifications/deliveries` | `{deliveries:DeliveryView[]}`，本人最近 100 条 |
| `POST notifications/deliveries` | `{editionId,channel,requestId,confirmSend:true}` → `201 {delivery,idempotent}` |
| `GET admin/deliveries` | 仅管理员，最近 200 条投递元数据 |
| `POST admin/deliveries/:id/reconcile` | `{reason}` → `{delivery}`，实际查询可用平台；不盲目重发 |
| `POST admin/deliveries/:id/review` | `{reason,confirmUnknown:true}` → `{delivery}`，记录人工核对且保留 `unknown` |
| `POST admin/deliveries/:id/resend` | `{requestId,reason,confirmDuplicate:true}` → `{delivery,idempotent}`；固定原版本、成员及绑定目标 |

`BindingView` 为 `{bindingId,channel,status:"active"|"unbound",displayName,verifiedAt}`。`ChallengeView` 为 `{challengeId,channel,status,expiresAt,code?,qrCodeUrl?,displayName?}`；状态为 `waiting`、`awaiting-confirmation`、`awaiting-code`、`complete`、`expired`、`failed`。飞书绑定码只在开始响应中出现，不会通过后续状态读取还原；刷新后可重新开始。

`DeliveryView` 为 `{intentId,editionId,memberId,reportDate,channel,status,attempts,nextAttemptAt,createdAt,updatedAt,providerMessageId,errorCode,sourceIntentId,reason,canReconcile,unknownReviewedAt}`。时间使用 ISO 字符串，可空字段为 `null`。状态含义见 [Phase 6](phase6-implementation.md)。平台受理/确认不代表已读。`requestId` 为 8–100 位字母、数字、下划线、短横线；重复请求返回已有任务，另一请求重复正常版本返回 `409 delivery_exists`。管理员原因须为 3–300 字符。

自动计划使用当天合格内容，空结果不推送，不补发昨天版。组装和入队使用可恢复的固定请求；普通保存不会开启计划。`enabled` 为成员意愿，`systemEnabled` 为部署能力；部署不开启时页面明确显示未运行。

`POST webhooks/feishu` 只接受通过签名、解密和事件校验的原始 JSON 请求。`POST webhooks/pushplus` 接受好友事件线索后仍须开放接口查询与一次性验证码证明，返回 `{code:200,msg:"success"}`；不相信匿名消息回调来确认投递。这两个精确路由不使用浏览器 Cookie/CSRF，其他路径没有此例外。平台回调同样限制 64 KiB，禁止 query 参数和压缩请求体。

## 机器接口

这些接口只接受服务端 `Authorization: Bearer <MEMBER_MACHINE_TOKEN>`，不使用浏览器 Cookie 或 CSRF。机器密钥不进入 Console 包、浏览器存储或 URL。

| 方法与路径 | 用途 |
| --- | --- |
| `GET machine/catalog` | 读取服务端主题目录，供引擎生成新的冻结主题版本 |
| `POST machine/imports` | 导入完整引擎导出包；验证哈希、批次、证据与主题版本后原子写入 ready 内容 |
| `POST machine/revocations` | 从已验证的引擎导出包同步撤回；请求体同样是完整导出包，不是任意 revision ID 列表 |

导入协议为 `member-export-contract` 中的 schema version 1，包含 `exportId`、`generatedAt`、`catalogBatchId`、候选快照、证明批次和撤回列表。相同导出可以重试；验证失败不产生半写入 ready 状态。已撤回内容不会因旧包重传而恢复。

`GET /health` 位于 API 前缀外，只返回数据库连通状态 `{status:"ok"}`。

## 常见错误

| 状态码 | 示例 | 处理方式 |
| --- | --- | --- |
| 400 | `invalid_request`、`invalid_json` | 修正字段和 JSON 格式 |
| 401 | `session_required`、`session_expired`、`invalid_code` | 重新登录；验证码必须使用发起请求的浏览器 |
| 403 | `origin_rejected`、`csrf_rejected`、`forbidden`、`read_only` | 检查同源、会话或授权，不靠前端隐藏按钮替代权限检查 |
| 404 | `not_found`、`member_not_found` | 目标不存在或对当前用户不可见 |
| 409 | `revision_conflict`、`topics_changed`、`last_owner` | 重新读取版本或修正管理操作 |
| 410 | `edition_unavailable` | 版本涉及已撤回内容或已失去访问权限 |
| 429 | `rate_limited` | 等待限额窗口恢复 |
| 503 | `mail_unavailable`、`edition_integrity` | 由管理员检查邮件配置或私有数据完整性 |
