# 组织 OIDC 登录

OIDC 是现有邀请制账户的另一种登录方式。组织管理员先配置身份提供方，成员用本地密码登录并在「账户安全 → 组织身份绑定」显式关联已验证的同邮箱身份。不会按邮箱自动合并账户、开放注册或增加项目权限；本地密码入口始终保留。

## 配置与使用

1. 团队所有者或管理员完成本地 MFA，在团队管理的「组织 OIDC 登录」添加名称、Issuer、Client ID、Client Secret 和原因。
2. 平台读取并验证 discovery 文档，保存授权、令牌和 JWKS 端点；将页面显示的回调地址注册到身份提供方。支持 HTTPS，开发验收可使用字面 loopback HTTP。
3. 成员先接受团队邀请，登录后十分钟内在账户安全页选择绑定。提供方必须返回已验证、与本地账户相同的邮箱；不同邮箱及未受邀人员会被拒绝。
4. 登录页选择组织提供方。已启用的本地 MFA 仍走验证器/恢复码流程；仅 IdP 登录成功不会跳过这一步（原有可信设备策略仍适用）。
5. 成员可解除绑定并撤销自己的登录会话；管理员可停用、重新启用或轮换提供方密钥。提供方变更撤销所有已绑定成员的本地会话及待完成 MFA，包括密码创建的会话。成员角色与本地密码保留。

## 数据与权限

迁移 051 新增组织提供方、MFA 登录证明及会话来源字段。配置由 MFA 管理员维护并写审计；数据库复核当前成员资格、配置版本和单次证明。配置更新使用版本比较，过时页面不能覆盖新配置。

Client Secret 使用 AES-GCM 加密，密钥从部署的持久 `BETTER_AUTH_SECRET` 分域派生，关联组织与提供方 ID。公开列表、管理列表和 discovery 接口不返回 Secret；OAuth access/refresh/ID token 不持久保存到账户记录。备份恢复必须保留认证配置与数据库，不能随意替换认证密钥。

授权码、PKCE S256、state、nonce、ID Token 非对称签名、issuer 和 audience 验证交由固定版本 Better Auth genericOAuth 实现。只接受验证后的 ID Token 身份，未返回 ID Token 或 `email_verified !== true` 均拒绝。端点快照在创建时固定，远端 discovery 改变不会悄悄改变已审核配置；Issuer/Client ID 变更通过新增提供方完成。

## 基础边界

- 首版要求授权、令牌与 JWKS 端点和 issuer 同源；不支持跨源端点布局。
- 登录资格来自本地成员管理；未实现 SCIM、IdP 组到角色映射、IdP 主动注销或自动离职同步。
- 原有管理员 MFA 要求继续有效。提供方停用及本地成员停用生效，IdP 单独停用一个账户不会自动撤销既有本地会话。
- 当前验收使用真实签名的本机可控 IdP，不声称完成外部企业身份系统或公网部署验收。

## 重复验收

数据库专项：`node_modules/.bin/tsx --test tests/collab/oidc.test.ts`。

隔离浏览器主流程：`PI_COLLAB_E2E_FOCUS=oidc npm run test:collab:identity:e2e`。在临时数据库和独立 Next 源码副本中运行，覆盖提供方配置、显式绑定、登录、拒绝未绑定账户/错误签名/issuer/audience/nonce/state/PKCE/未验证邮箱、本地 MFA、停用及密码回退、解绑。只使用 loopback 测试身份，不调用模型或外部身份服务。
