# FeishuBrief Member Service

Private, single-lab member service. Keep separate from the script-based content engine and static Console.

- Node 24, TypeScript, native HTTP and `node:sqlite` transactions; persistent database and migrations live here. Single process/host deployment for the group pilot. Product expansion must migrate to a supported multi-instance database before scaling.
- Invitation-only email verification. Public registration is a future design, disabled in this service. Never print or return real OTPs, invitation secrets or session tokens in logs. Test mail sink is allowed only in explicitly configured local development/tests.
- Server owns authorization and ownership on every request. Disabled users lose all sessions. All mutations require exact Origin and authenticated CSRF, except machine-authenticated ingestion and browser-bound login challenges.
- Private responses use no-store. Secure HttpOnly SameSite cookies in production. No credentials in URL query, frontend bundle or localStorage. Email credentials only in environment.
- All content must cross the validated engine export boundary before becoming ready. Revoke before display. No model or notification calls in member assembly/preview.
- Database transactions protect optimistic revision checks, ready imports, edition/history commits, roles and audit events. Never hold a SQL transaction across asynchronous SMTP/network work.
- Contract/assembler files copied from the engine are versioned vendor inputs; sync script must verify their parity. Do not hand-edit vendor files.
- Test only synthetic identities/content and injected mail transport. Never send email, Feishu or PushPlus messages during verification. No actual private content in test output/artifacts.
- Preserve all prior group/public brief workflows. Phase 6 personal notifications use independent credentials, verified bindings, immutable editions and persistent intents. Do not send from previews or subscription saves. Notification workers and scheduling are explicitly disabled by default.
- Platform webhook exceptions are restricted to their exact routes. Feishu requires signature/encryption verification over the raw body. An untrusted PushPlus callback cannot activate a binding or confirm a delivery; verify the friend through the authenticated platform API and a recipient-held code.
- Ambiguous sends or interrupted in-flight attempts become unknown; never automatically resend them. Revalidate user, subscription, binding and content immediately before network dispatch. Cancellation is transactional; graceful shutdown drains pending work before closing SQLite.
