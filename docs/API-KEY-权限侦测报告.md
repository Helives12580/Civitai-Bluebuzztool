# civitai API Key 权限侦测报告

> 场景：用 API Key 自动完成 civitai 的每日 Blue Buzz 任务。
> 本文回答一个问题：**该给 key 勾哪些权限，以及为什么。**
>
> 结论来自真实 key 的实测 + civitai 主仓源码，不是推测。

---

## 一、结论先行

```
选「完全访问 / Full access」最省事。
```

如果界面支持细粒度勾选，**最小可用集**是：

```
BuzzRead  +  UserRead  +  SocialWrite  +  Full
```

其中 `Full` **绕不开** —— 原因见第三节。

---

## 二、工具实际调用的端点

### 扫描阶段（只读，不产生任何副作用）

| 端点 | 用途 | 源码要求的 scope |
|---|---|---|
| `GET /api/v1/me` | 验证 key、读账号信息与 key 自身权限 | 登录态即可 |
| `GET /api/trpc/buzz.getUserAccount` | 读 buzz 账户 | `BuzzRead` |
| `GET /api/trpc/buzz.getUserTransactions` | 读当日奖励流水，算剩余额度 | `BuzzRead` |
| `GET /api/trpc/user.getFollowingUsers` | 读已关注列表，防止误取关 | `UserRead` |
| `GET /api/trpc/user.userRewardDetails` | 取官方任务定义（单次额度与上限） | 登录态即可 |
| `GET /api/v1/images` | 取 reaction 的目标图片池 | 公开，无需认证 |

### 执行阶段

| 端点 | 用途 | 源码要求的 scope |
|---|---|---|
| `POST /api/trpc/buzz.claimDailyBoostReward` | 领每日 boost（25 buzz） | `BuzzRead` |
| `POST /api/trpc/reaction.toggle` | 给内容发反应（2 buzz/次） | `SocialWrite` |
| `POST /api/trpc/user.toggleFollow` | 关注他人（10 buzz/次） | **无声明 → 隐含 `Full`** |
| `GET /api/trpc/user.getCreator` | username 解析成 userId | 公开过程，无 scope |

**以上 10 个端点全部经真实 key 实测，返回 HTTP 200。**

---

## 三、为什么 `Full` 绕不开

`user.router.ts` 里关注端点长这样：

```ts
toggleFollow: verifiedProcedure
  .input(toggleFollowUserSchema)
  .mutation(toggleFollowUserHandler),
```

注意它**没有** `.meta({ requiredScope: ... })`，而其它端点都有：

```ts
getUserAccount: buzzProcedure.meta({ requiredScope: TokenScope.BuzzRead }).query(...)
toggle:         guardedProcedure.meta({ requiredScope: TokenScope.SocialWrite })...
getFollowingUsers: protectedProcedure.meta({ requiredScope: TokenScope.UserRead })...
```

这个缺席不是疏漏 —— `src/server/trpc.ts` 的注释把规则写死了：

```ts
// - Procedures without `.meta({ requiredScope })` implicitly require `TokenScope.Full`.
```

**未声明 scope 的过程，隐含要求 `TokenScope.Full`。**

所以：只勾 `BuzzRead` + `SocialWrite` + `UserRead` 的话，「关注他人」这一项会 401，
而另外两项照常工作 —— 表现为"大部分能跑、就一项不行"的迷惑现象，最容易debug错方向。

---

## 四、权限不足分别会怎样

| 缺的权限 | 表现 |
|---|---|
| 缺 `BuzzRead` | **扫描直接失败** —— 读不到交易流水就算不出剩余额度，工具会拒绝执行（这是刻意的：宁可不做，也不错做） |
| 缺 `UserRead` | 读不到已关注列表，「关注他人」被安全闸整项跳过（防止把手动关注过的人误取关） |
| 缺 `SocialWrite` | `reaction.toggle` 返回 401，反应任务失败 |
| 缺 `Full` | `user.toggleFollow` 返回 401，仅关注任务失败，其余正常 |

---

## 五、一个必须知道的坑：`Please use the public API instead`

用**无效** key 调任何 tRPC 过程，civitai 会返回：

```
401 Please use the public API instead: https://developer.civitai.com/
```

这条文案极易被误读成"tRPC 不允许 API key 调用"。**不是那个意思。**

`src/server/createContext.ts` 里：

```ts
const isBearerAuth = req.context?.apiKeyId != null;
const acceptableOrigin = !isProd || isBearerAuth || isAllowedOriginRequest(req);
```

携带**有效** API key 的 Bearer 请求，`isBearerAuth` 为真，`acceptableOrigin` **直接置真**，连来源白名单都不过。
只有 key 没通过认证（`apiKeyId` 为 null）时，请求才会掉进来源校验分支，抛出那条 `isAcceptableOrigin` 的
UNAUTHORIZED —— 于是"key 无效"伪装成了"请改用公开 API"。

**看到这条提示，先查 key 本身，不要怀疑端点。**

---

## 六、两个会让人算错账的 API 事实

### 1. `buzz.getUserAccount` 不返回 blue 账户

Blue Buzz 的奖励**全部入账到 `blue` 钱包**（流水里方向写作 `yellow -> blue`），
但 `buzz.getUserAccount` 返回的账户数组里**看不到 blue**。

后果：拿它做"执行前后余额对比"来核对收益，会永远得到 `delta = 0`，让人误以为奖励没到账。

**正解**：用 `buzz.getUserTransactions` 拉当日流水，按入账笔数求和。
流水里每笔的 `description` 就是奖励的英文说明，可以直接对到任务类型。

### 2. `buzz.getUserTransactions` 的日期参数要 superjson 标注

它的入参是 `z.date()`，而 civitai 走 superjson transformer。直接传 ISO 字符串会被拒：

```
400 expected date, received string
```

必须带 `meta.values` 标注类型：

```json
{
  "json": { "start": "2026-09-29T00:00:00.000Z", "end": "2026-09-29T23:59:59.999Z", "limit": 200 },
  "meta": { "values": { "start": ["Date"], "end": ["Date"] } }
}
```

---

## 七、实测证据

**环境**：civitai.red（与 civitai.com 内容一致的镜像），真实账号，真实执行。

**动作**：50 次 `reaction.toggle` + 3 次 `user.toggleFollow` + 1 次 `buzz.claimDailyBoostReward`
→ 全部 HTTP 200。

**到账**（站点交易流水原文，逐笔可查）：

| 奖励描述 | 笔数 | 金额 |
|---|---|---|
| `For encouraging others to post content` | 50 | 100 |
| `For first 3 people that you follow each day` | 3 | 30 |
| `For claiming daily boost rewards` | 1 | 25 |
| **合计** | | **155** |

与按任务定义推算的理论值**完全一致**，且 buzz 可用于实际购买付费模型，
说明到账真实可用，不是账面数字。

### 与官方后台任务中心的对账

拿 civitai 官方后台的任务中心与本工具的流水口径逐条对照，三项自动任务完全吻合：

| 任务 | civitai 官方后台 | 本工具（流水口径） |
|---|---|---|
| 给出独特反应 | 100 / 100 | 100（50 笔） |
| 每日首次关注他人 | 30 / 30 | 30（3 笔） |
| 每日在生成器领取 | 25 / 25 | 25（1 笔） |

**连 UTC 日界倒计时都吻合**：官方显示 `Resets in 14h 24m`，本工具同刻显示 `14:26:52`，
差约 3 分钟（两张截图的时间差）。两个独立来源在数值与日界上同时对上。

### 官方任务定义接口的两个已知行为

`user.userRewardDetails` 返回官方任务定义，与本地常量对照 11 项：
**单次金额 11/11 一致、上限 11/11 一致、`description` 原文 11/11 逐字一致**。
两处差异都是官方侧的已知行为：

- **`interval` 有 7 项返回空**，全是 `onDemand: true`。源码里 `interval` 取自 `caps[]` 中的
  `intervalCap`，而 onDemand 项用单值 `cap` 定义，取不到就 `undefined`。
  它们语义上仍是**按 UTC 日**结算（`getKey` 用 `dayjs().startOf('day')`、Redis 去重键按日过期、官方页面的重置倒计时）。
- **只返回 11 项**。少的是 `userReferred`（邀请注册，500 buzz），源码标了 `visible: false`，
  官方 UI 不展示但奖励真实可得。

---

## 八、三步自检你的 key

不用读源码，让工具自己招供：

1. **验证 Key** —— 回显 `username · tier · tokenScope`，确认 key 有效
2. **扫描当前可做任务** —— 需要 `BuzzRead` + `UserRead`，失败会写明原因；
   扫描结果里会列出**本次实际调用了哪些端点、什么状态码**
3. **开始完成** —— 需要 `SocialWrite` + `Full`，哪一项缺权限会逐项报错

---

## 九、附：日上限与 UTC 日界

| 任务 | 单次 | 日上限 |
|---|---|---|
| 每日在生成器领取 | 25 | 25 |
| 给出独特反应 | 2 | 100（50 次） |
| 每日首次关注他人 | 10 | 30（3 次） |

**上限按 UTC 结算**，不是本地时间。北京时间比 UTC 早 8 小时 —— UTC 零点 = 北京时间早上 8:00。

另外这些额度是**账号级**的：你手动点过的赞同样占额度。所以自动工具必须先查站点当日流水，
否则会在已经满了的额度上白做动作 —— 拿不到 buzz，却在别人内容上留下真实痕迹。
