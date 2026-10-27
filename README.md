# BiliGarb — B站装扮 / 收藏集注入器（Surge 模块）

在 B站 iOS 客户端的「装扮」和「收藏集」页面里加一个悬浮按钮。点开自动列出当前页面出现过的装扮、收藏集卡片、收藏集兑换物，选一个就应用 —— 主题色、侧栏图标、加载动画、名字颜色、空间背景当场换成那套装扮的样子。随时可还原。

只影响本机渲染，不改你的账号，不需要拥有那套装扮或那张卡。

---

## 文件

| 文件 | 作用 |
|---|---|
| `BiliGarb.sgmodule` | 模块清单，七条脚本 + MITM |
| `BiliGarb-Debug.sgmodule` | 诊断包，只在抓包时临时启用（见「抓包」一节） |
| `../docs/bili-garb-coverage.md` | 装扮覆盖情况：哪些做了、哪些做不了、为什么 |
| `bili-garb.js` | 唯一脚本，靠 `argument=` 分发六种模式 |
| `test/run.js` | 本地测试台，217 条断言 |
| `test/shell.html` | 实抓的装扮 H5 外壳（`mall-h5-major`） |
| `test/shell-digital.html` | 实抓的收藏集 H5 外壳（`digital-card-next`） |
| `test/detail-36438.json` | 实抓的套装详情 · 鹿乃桜帆 · `part_id=6` |
| `test/dlc-114746.json` | 实抓的收藏集卡池详情 · 水果篮子 · 12 张卡 |
| `test/grid-114746.json` | 实抓的收藏集卡池网格 |
| `test/collect-114746.json` | 实抓的收藏集兑换物（主题套装 / 头像挂件 / 表情包 / 评论背景） |

---

## 安装

### 1. 装模块

Surge → 首页 → 模块 → 右上角 `+` → 从 URL 导入，填：

```
https://gcore.jsdelivr.net/gh/Suk1u/BiliGarb@main/BiliGarb.sgmodule
```

模块里的 `script-path` 指向同一个 CDN 上的脚本，不需要手动放任何文件。

**`script-path` 用的是 commit SHA，不是 `@main`。** jsDelivr 的 `@main` 别名缓存很难清 —— 推完新版本半小时还是旧文件，purge 接口还会限流（`"throttled": true`）。换成固定 SHA 后每次都是新 URL，任何边缘都立刻可读。代价是每次发版要顺手把模块里那七个 SHA 一起换掉。

所以：**想拿最新脚本，用带 SHA 的模块地址**；`@main` 那条要等缓存自然过期（最长 12 小时）。

想改成跟仓库同步开发，也可以把 `bili-garb.js` 和 `BiliGarb.sgmodule` 放进 Surge 配置目录，再把每条 `script-path` 换成本地相对路径 `bili-garb.js`。

### 2. 开 MITM

模块已经声明了 hostname，Surge 会自动装证书。确认两件事：

1. Surge → 首页 → 系统代理 / 抓取 HTTPS 已开
2. iOS 设置 → 通用 → 关于本机 → 证书信任设置 → 对 Surge 证书打开信任

**第 2 步不做，整套东西一点反应都没有。**

### 3. 改完之后记得清 CDN 缓存

`script-path` 指向 jsDelivr 的 `@main`，它有缓存。推完新版本如果 Surge 还在跑旧脚本，手动清一下：

```
https://purge.jsdelivr.net/gh/Suk1u/BiliGarb@main/bili-garb.js
https://purge.jsdelivr.net/gh/Suk1u/BiliGarb@main/BiliGarb.sgmodule
```

浏览器打开这两个地址，看到 `"status": "finished"` 就好了。**注意 purge 有频率限制**，连打几次会返回 `"throttled": true`，那就等十分钟再来。清完回读一下体积，和本地文件对得上才算生效。

实在急，就把模块里的域名换成另一个边缘（`gcore` / `testingcf` / `fastly` / `cdn`），同一份文件、不同的缓存，哪个先更新用哪个。

---

## 用法

打开 B站 App → 我的 → 装扮（或任意装扮详情页 / 收藏集页面）。右下角出现一个粉色圆按钮。

点它，底部弹出选择器，分两组：

**装扮 · N** —— 当前页面加载过的所有装扮，带封面、`#item_id`、部件类型（套装 / 个性主题 / 加载动画 / 空间背景 …）。详情页会自动把当前这套排到第一位。每行还有「部件」按钮，可以只取其中一个部件。

**收藏集卡片 · N** —— 当前收藏集里的所有卡，带卡面、`#card_type_id`、稀有度。卡片列表来自卡池详情接口，整池都会列出来。

**收藏集兑换物 · N** —— 收藏集里能兑换出来的东西：静态主题套装、头像挂件、表情包、评论背景。带名字、预览图和类型。

底部还有：

- **手动输入** —— 直接填 `item_id`，不知道 id 的时候用
- **还原真实装扮** —— 清掉伪装

点某一行右边的「应用」，看到 toast 提示成功，**重开 B站** 生效。

### 混搭

装扮行上还有一个小按钮「**部件**」。点开它会展开五个槽位：

```
主题   加载动画   头像挂件   空间背景   进度条
```

点其中一个，**只换那一个槽位**，其他槽位原样保留。所以可以：

- 主题用 A 套、加载动画用 B 套、挂件用 C 套
- 收藏集卡片的空间背景 + 某套装的主题
- 资源包灌进来的主题 + 套装自带的挂件

状态栏会显示「已应用 N 个部件」以及每个槽位现在是哪套。收藏集卡片只填空间背景槽，不会顶掉其他部件。

---

## 怎么工作的

三层，一个文件。状态是**分槽**的：

```
slots: {
  skin      个性主题     → resource/show/skin 的 user_equip
  loading   加载动画     → 同一个响应的 load_equip
  playicon  进度条       → 同一个响应的 play_icon
  pendant   头像挂件     → web-interface/card 和 space 系列的 pendant + nickname_color
  spacebg   空间背景     → space 系列里 image1_* 的分层结构 / SpaceBackgroundInfo 的 {image,animation}
}
```

外加一个 `color`（名字颜色），跟主题走不跟挂件走 —— 很多套装没有挂件但有颜色。

旧格式（`kind: suit / card / equip`）读的时候自动迁移，不用手动清。

```
装扮 H5 页面 (www.bilibili.com/h5/mall/*)
  │  注入层：在 </head> 前插一段 script
  │    · hook fetch / XHR，被动吃掉页面上出现的每一个 item_id / card_type_id
  │    · 粉色 FAB → 抽屉 → 应用
  │    · 应用时 GET 一个魔法 URL
  ↓
桥接层 (http-request 截获 api.bilibili.com/x/garb/_sg/*)
  │    · /apply      → 拉 suit/detail 全量 JSON
  │    · /apply-card → 拉 lottery/detail/v2，按 card_type_id 挑出那张卡
  │    · 写进 $persistentStore('bili.garb.current')
  │    · 短路返回 {"code":0}，带 CORS 头
  ↓
伪装层 (http-response 改写 App 拿到的数据)
       · resource/show/skin            → user_equip + load_equip   [装扮]
       · web-interface/card            → pendant + nickname_color  [装扮]
       · space 系列                    → 按名覆盖                  [装扮]
       · Right/SpaceBackgroundInfo     → 空间背景                  [收藏集]
```

### 两套数据体系

| | 装扮 | 收藏集 |
|---|---|---|
| 标识 | `item_id` | `card_type_id` |
| 详情接口 | `x/garb/v2/mall/suit/detail` | `x/vas/dlc_act/lottery/detail/v2` |
| 结构 | `suit_items.{card,card_bg,skin,loading,space_bg,thumbup,play_icon,emoji_package}` | `card_type_info.{content,space_background,splash,overview_image}` |
| 可穿表面 | 主题色 / 挂件 / 名字颜色 | 空间背景 / 名片 / 开屏 |

收藏集的卡片不是「一个 part_id」，而是一个 `card_type_id` 带好几张脸 —— 卡面、空间背景、开屏各自是 `card_type_info` 下的兄弟字段，能不能穿取决于哪个不为空。

### 为什么注入点在 head 里

两个外壳都实测过：

```
装扮页   mall-h5-major      4182 字节   </head>@1641  #major-app@1659  </body>@4168
收藏集页 digital-card-next  4354 字节   </head>@3529  #app@3555        </body>@4338
```

两页的所有业务 bundle 都堆在 `</body>` 前面。注入点放 `</head>` 之前，才能抢在 App 的代码调用 `fetch` 之前把 hook 挂上 —— 否则首屏那批请求抓不到。

### 为什么换肤是真的

`app.bilibili.com/x/resource/show/skin` 返回的 `user_equip` 里带 `package_url` 和 `package_md5`，指向 B站自家 CDN 上那套装扮的主题 zip。把这两个字段换掉，App 会自己去下载、校验、套用。

所以不需要在本地托管任何文件，也不需要伪造 md5。

### 为什么空间背景用结构匹配

`x/garb/Right/SpaceBackgroundInfo` 需要登录，响应结构在外部拿不到（不带 Cookie 一律 `-400`）。所以不猜键名，改成认结构签名 —— 只改同时带 `image` 和 `animation`、且 `animation` 里有 `animation_url` / `animation_backup_image` 的那个对象。认不出就整包放行，绝不插新键。

### 为什么不需要签名

WBI、`appkey`+`sign`、`access_key` —— 一个都不用。我们只改写 App 自己发出的请求的**响应**，签名是 App 自己算的。

---

## 设置 access_key

收藏集的主题套装只能通过 App 签名的接口解析，需要你的一次性授权令牌。

**取令牌**：抓一次 App 的任意请求，URL 里 `access_key=` 后面那串就是。

**设令牌**：Safari 打开（Surge 要开着）

```
https://api.bilibili.com/x/garb/_sg/set-token?access_key=把令牌粘在这里
```

看到 `{"code":0,"data":{"set":true,"masked":"0b8be0…IIEC"}}` 就设好了。查状态：

```
https://api.bilibili.com/x/garb/_sg/token-status
```

令牌存在 `$persistentStore` 里，只在本机。**有效期大约 30 天**，过期了重新设一次。

清掉：

```
https://api.bilibili.com/x/garb/_sg/set-token?access_key=
```

> 为什么不用 cookie：页面里的 cookie 打这个接口返回 `-403 访问权限不足`，连对照 id 也是。只有 App 身份能过。

---

## 收藏集主题套装（资源包）

13 位素材 id 的 `package_url` 公开接口拿不到 —— 那个接口是 App 独占的，网页带 cookie 也是 `-403`。所以这类主题只能靠**资源包**喂进来。

社区整理的资源包里有个 `xxx_trans.json`，长这样：

```json
{
  "user_equip": {
    "id": 1780036210001,
    "name": "从零开始的异世界",
    "preview": "https://i0.hdslb.com/bfs/garb/xxx.png",
    "ver": "1780054798",
    "package_url": "https://i0.hdslb.com/bfs/garb/zip/xxx.zip",
    "data": { "color_mode": "light", "color": "#000000", "color_second_page": "#F3E5EB",
              "tail_color": "#0066FF", "tail_color_selected": "#D400B9" }
  },
  "load_equip": { "id": 1780036045001, "name": "Re0加载", "loading_url": "...", "ver": "..." },
  "play_icon": { ... }
}
```

**这就是 `resource/show/skin` 要的 `user_equip` 结构本身**，`id` 就是那个 13 位素材 id，`package_url` 指向 B站 CDN 上的主题 zip。

把它整份塞进 URL 打开（Surge 要开着）：

```
https://api.bilibili.com/x/garb/_sg/set-equip?json=<URL 编码后的整份 JSON>
```

看到 `{"code":0,"data":{"kind":"equip","name":"…","has_loading":true}}` 就设好了。之后 `resource/show/skin` 会被整块替换成这份配置，主题色、侧栏图标、加载动画一起换。重开 B站 生效。

只传裸的 `user_equip` 对象也行（那就只换主题，不带加载动画）。

清掉用 `/clear`，和别的状态一样。

> 这套机制对**任何**你手里有资源包的主题都通用，不限收藏集。

---

## 抓包（排查用）

模块里带了一个旁观式抓包脚本，专门用来抓「使用 / 佩戴」前后的接口调用，好把没解析出来的装扮补进映射。

**读写都记**，只记装扮 / 收藏集 / 空间相关的域名路径，同一个接口只留最新一条（最多 20 条），`csrf` 会自动抹成 `<redacted>`，**不改动任何请求**。

1. 确认模块已装、MITM 已开
2. 在 B站里进收藏集，点你想抓的那个「使用」/「佩戴」
3. Safari 打开：

   ```
   https://api.bilibili.com/x/garb/_sg/dump
   ```

4. 页面上是一段 JSON，`data` 数组里就是抓到的请求，复制发我
5. 清空重来：

   ```
   https://api.bilibili.com/x/garb/_sg/dump/clear
   ```

每条长这样：

```json
{
  "t": "2026-10-26T13:20:11.000Z",
  "m": "POST",
  "url": "https://app.bilibili.com/x/v2/space/digital/bind",
  "body": "act_id=114746&card_type_id=1792140812005&csrf=<redacted>"
}
```

看到 `body` 里出现 5~9 位的 `item_id`，就是真装扮 id，能直接写进映射；看到 `act_id` + `card_type_id`，说明服务端按活动解析，那就得换条路。

`dump` 返回里还有个 `diag` 字段：当收藏集套装走登录态接口失败时，页面会把**每个 id 的返回码和 message** 回传到这里。排查 `-101` 这类问题时先看它。

### 按钮点不动怎么办

收藏集的奖励是**领取型**，不是佩戴型 —— 没达到条件时按钮只显示「进行中 0/4」，点不动，也就走不到素材预览页，抓不到解析请求。

这时候临时启用诊断包 `BiliGarb-Debug.sgmodule`：它只改客户端看到的进度数字（`owned_item_amount` 填成 `require_item_amount`，按钮文案改成「领取」），让按钮变得可点。**服务端该拒还是拒，不会真的发放任何东西。**

装好诊断包 → 回收藏集页面下拉刷新 → 点那个主题套装 → 主模块的抓包会记下它发的请求 → 抓完把诊断包关掉。

---

## 已知限制

1. **主题换肤要重开 App。** `resource/show/skin` 是启动时拉的，热改不会立刻生效。

2. **只影响本机。** 别人点开你的主页，看到的还是你真实的装扮。这是 MITM 的物理边界 —— 数据在别人的手机上渲染，我们碰不到。

3. **没有真实穿戴接口。** `/x/garb/user/suit/equip`、`/v2/.../equip`、`/user/suit/dress` 我逐个实测过，全是 HTML 404。H5 那个「佩戴成功」是 `callNative` 之后的前端提示，真穿装在原生层。所以这是伪装，不是破解。

4. **收藏集只能换空间背景。** 卡片的其他几张脸（名片、开屏、评论背景）在外部找不到可验证的读取接口，所以没做 —— 宁可少做，不做瞎猜。`SpaceBackgroundInfo` 的响应结构也没法验证，用的是结构匹配，真机上不生效就把那次的响应抓给我。

5. **收藏集的主题套装：能列出来，能不能穿上取决于这套是哪个年代的。**

   `collect_list` 里 `redeem_item_type:5` 那条（名字就叫「静态主题套装」）给的是 `redeem_item_id`。这个字段有两种形态：

   - **老收藏集**：一个普通装扮 `item_id`（`bilibili-API-collect` 的 `docs/garb/lottery.md` 里示例是 `"56658"`），直接查 `suit/detail` 就出装扮包。
   - **新收藏集**：四个用 `&` 串起来的**素材 id**（水果篮子是 `1792139382001&1792139059001&1792139122001&1792139156001`）。这四个 id 查 `suit/detail` 全部返回 `suit_items:null` 的空壳，`x/vas/dlc_act/*` 里也没有素材详情接口（`material/detail`、`collect_redeem/detail`、`act/material/list` 全是 HTML 404），`lottery.md` 里五个接口也没有一个是解素材的。

   模块的处理顺序：**先按 `&` 拆开逐个查 `suit/detail`，能解析出装扮包的合并进来；一个都不行就按兑换物名字去装扮商城搜同名装扮**（`x/garb/v2/mall/home/search`，参数是 `key_word`，不是 `keyword`），搜到就应用那个。两条都不通才明确告诉你「商城也搜不到同名装扮」，不假装成功。

   要真正穿上新版素材套装，得等它兑换后进「我的装扮」，那时会拿到真实 `item_id`，在装扮列表里直接选就行。

   **这条已经用真机抓包查死了。** 抓包确认 App 打开「抽卡奖励」页时调的是：

   ```
   GET x/vas/dlc_act/lottery/home_reward_preview
       ?act_id=&lottery_id=&anchor_id=<collect_id>&preview_type=2&show_source=2
   ```

   `anchor_id` 就是 `collect_id`。这个接口**免登录**能调，`preview_type=1` 返回 12 张卡，`preview_type=2` 返回 4 条兑换奖励。但四条奖励的 `modules` 全是 `null`，`redeem_item_id` 原样吐回来那串素材 id，只多了张静态预览图和一段 mp4。

   连同下面这些一起，全部排除过了，没有一条能把素材 id 换成装扮 id：

   - `suit/detail?item_id=<素材id>`（含 `part` 参数的各种取值）→ `suit_items:null`
   - `x/garb/v2/mall/home/search?key_word=` 与 `x/garb/vas/search?key_word=` → 0 条
   - `x/garb/vas/goods/list?anchor_id=<collect_id>` → 0 条
   - `x/vas/dlc_act/home_reward_preview`（`preview_type` 1/2/3/4 × `show_source` 1/2 全试）→ `modules:null`
   - `x/vas/dlc_act/*` 下 18 个接口里没有任何素材详情接口
   - `material/detail`、`collect_redeem/detail`、`act/material/list` → HTML 404

   **但最后找到了另一条路。** 那个 13 位 id 不是「不存在」，是**只有 App 签名的接口认**。

   H5 页面自己用的根本不是公开的 `v2/mall/suit/detail`，而是：

   ```
   GET x/garb/internal/v2/mall/suit/detail?item_id=&part=&from=&from_id=
   ```

   这个接口在 `mall-h5-major` bundle 里的调用点写得很清楚（`item_id / part / from / from_id` 四个参数）。裸调一律 `-101 账号未登录` —— 而登录态只在页面里有。

   所以模块的处理顺序变成：

   1. 公开 `suit/detail` 逐个查素材 id，能出装扮包的合并
   2. 不行就按兑换物名字搜同名装扮
   3. 还不行，桥接返回 `code:-2` 把 id 列表交给页面；**页面用 `credentials:'include'` 去打 `internal/v2/mall/suit/detail`**，解析出来再 POST 回 `/store-suit` 落盘

   实测这条路**走不通**：页面带 cookie 去打，返回 `-403 访问权限不足`，连已知能用的对照 id（`36438`）也是 `-403`。说明接口整体拒绝网页来源，跟具体是哪套素材无关。而只带 `appkey`+`sign`、不带 `access_key` 去调，返回 `-101 账号未登录`。

   所以它要的是 **`appkey` + `sign` + `access_key`** 三件套 —— 也就是 App 的身份。现在模块就是这么做的：桥接层自己算 `md5(sorted_query + appsec)`，带上 `access_key` 直接问。需要你先设一次 `access_key`，见下面「设置 access_key」。

6. **不是每套装扮都有主题部件。** 有 `suit_items.skin` 的才能换主题色和图标；只有 `loading` 的只能换加载动画；`part_id=9` 的纯主题套装反而没有卡片背景。

7. **挂件伪装多数不生效。** `suit_items.pendant` 在 schema 里有，但线上抓的套装（36438、42193）都没有这个键。没有就只改名字颜色。

8. **按钮不出现 = hybrid 缓存。** App 的 WebView 容器可能缓存了外壳 HTML，请求没走网络，注入自然没跑。清 B站缓存，或从别的入口重进装扮页。

9. **一个请求只能跑一个 http-response 脚本。** 同时装了其他 B站模块（比如去广告），同一个 URL 会冲突，后装的赢。

10. **`[MITM]` 用了 `%APPEND%`。** 别改成 `hostname =`，那会清掉你其他模块的 hostname 列表。

---

## 测试

```bash
node test/run.js
```

在 node 里模拟 Surge 运行时（`$request` / `$response` / `$done` / `$persistentStore` / `$httpClient` 全是桩），跑 217 条断言：

- 两个外壳的注入点位置、HTML 完整性、注入代码语法、无嵌套 `</script>`
- 非 HTML 响应放行
- 桥接 apply / apply-card / apply-set / clear / state / 缺参 / detail 失败 / 卡不在池子里
- `lottery_id` 缺失时自动走 `act/basic/v2` 解析
- 兑换物的四个 id 全查不到 → 按名字回落搜索；再不行返回 `-2` 把 id 交给页面
- `/store-suit`：页面回传登录态解析结果后落盘，坏 body / 空 suit_items 一律拒
- 有一个能解析 → 合并成功并记下 `set_id`；搜索参数必须是 `key_word`
- 伪装层的字段替换、无状态放行、坏 JSON 不炸、只改自己的名片
- 空间背景的顶层命中、嵌套命中、四种该放行的场景
- 两套状态互斥：卡片态不触发装扮伪装，装扮态不触发空间背景
- 抓包层：读写都记、按接口去重、不记自己的桥、`csrf` 抹掉、环形缓冲最多 20 条、dump / clear
- 诊断包：只填进度数字、不动名字和 id、已经满的放行、无关响应放行
- `$done` 每次只调一次（Surge 里调两次会断流）

夹具全是线上实抓，见上面的文件表。

---

## 数据来源

- API 文档：`Suk1u/bilibili-API-collect`（`docs/garb/*`、`docs/misc/sign/*`）
- Surge 手册：`manual.nssurge.com`
- 两个外壳、套装详情、卡池详情、卡池网格、兑换物列表：线上实抓，2026-10-26
- `part_id` 对照表：`mall-h5-major` bundle 内的枚举（1 头像挂件 / 2 动态卡片 / 3 点赞效果 / 4 表情 / 5 表情包 / 6 套装 / 7 空间背景 / 8 评论背景 / 9 个性主题 / 10 加载动画 / 11 进度条 / 12 开屏画面 / 13 头像）

### 顺带确认的免登录接口

真机抓包时验证过的，写在这里省得以后再摸：

```
GET x/vas/dlc_act/lottery/home_reward_preview   收藏集奖励预览（anchor_id = collect_id）
    ?act_id=&lottery_id=&anchor_id=&preview_type=&show_source=
    preview_type=1 → 12 张卡；preview_type=2 → 兑换奖励列表

GET x/garb/vas/search?key_word=&pn=&ps=          App 侧搜索，收藏集也在结果里
GET x/garb/vas/goods/list?anchor_id=&biz_type=   商品列表，biz_type 1=装扮 4=收藏集
GET x/garb/vas/goods/list_filter                 biz_type / group_id_v2 的筛选项
GET x/garb/mall_v2/nav                           商城导航
```

以上都免登录。`x/garb/vas/*` 这一族是 App 用的，比 H5 那套 `x/garb/v2/mall/*` 覆盖面更宽。
