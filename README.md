# BiliGarb — B站装扮 / 收藏集注入器（Surge 模块）

在 B站 iOS 客户端的「装扮」和「收藏集」页面里加一个悬浮按钮。点开自动列出当前页面出现过的装扮、收藏集卡片、收藏集兑换物，选一个就应用 —— 主题色、侧栏图标、加载动画、名字颜色、空间背景当场换成那套装扮的样子。随时可还原。

只影响本机渲染，不改你的账号，不需要拥有那套装扮或那张卡。

---

## 文件

| 文件 | 作用 |
|---|---|
| `BiliGarb.sgmodule` | 模块清单，六条脚本 + MITM |
| `bili-garb.js` | 唯一脚本，靠 `argument=` 分发六种模式 |
| `test/run.js` | 本地测试台，105 条断言 |
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
https://cdn.jsdelivr.net/gh/Suk1u/BiliGarb@main/BiliGarb.sgmodule
```

模块里的 `script-path` 已经指向 jsDelivr 上的脚本，不需要手动放任何文件。

想改成跟仓库同步开发，也可以把 `bili-garb.js` 和 `BiliGarb.sgmodule` 放进 Surge 配置目录，再把每条 `script-path` 换成本地相对路径 `bili-garb.js`。

### 2. 开 MITM

模块已经声明了 hostname，Surge 会自动装证书。确认两件事：

1. Surge → 首页 → 系统代理 / 抓取 HTTPS 已开
2. iOS 设置 → 通用 → 关于本机 → 证书信任设置 → 对 Surge 证书打开信任

**第 2 步不做，整套东西一点反应都没有。**

### 3. 改完之后记得清 CDN 缓存

`script-path` 指向 jsDelivr 的 `@main`，它会把文件缓存最长 12 小时。推完新版本如果 Surge 还在跑旧脚本，手动清一下：

```
https://purge.jsdelivr.net/gh/Suk1u/BiliGarb@main/bili-garb.js
https://purge.jsdelivr.net/gh/Suk1u/BiliGarb@main/BiliGarb.sgmodule
```

浏览器打开这两个地址，看到 `"status": "finished"` 就好了。也可以在模块里把 `script-update-interval` 调小、或者干脆改成 commit-pinned 的 `@<sha>` 地址彻底绕开缓存。

---

## 用法

打开 B站 App → 我的 → 装扮（或任意装扮详情页 / 收藏集页面）。右下角出现一个粉色圆按钮。

点它，底部弹出选择器，分两组：

**装扮 · N** —— 当前页面加载过的所有装扮，带封面、`#item_id`、部件类型（套装 / 个性主题 / 加载动画 / 空间背景 …）。详情页会自动把当前这套排到第一位。

**收藏集卡片 · N** —— 当前收藏集里的所有卡，带卡面、`#card_type_id`、稀有度。卡片列表来自卡池详情接口，整池都会列出来。

**收藏集兑换物 · N** —— 收藏集里能兑换出来的东西：静态主题套装、头像挂件、表情包、评论背景。带名字、预览图和类型。

底部还有：

- **手动输入** —— 直接填 `item_id`，不知道 id 的时候用
- **还原真实装扮** —— 清掉伪装

点某一行右边的「应用」，看到 toast 提示成功，**重开 B站** 生效。

装扮和收藏集是两套互斥状态 —— 应用卡片会顶掉之前应用的装扮，反之亦然。状态栏会写明当前是「（装扮）」还是「（收藏集）」。

---

## 怎么工作的

三层，一个文件，两套数据模型。

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

## 已知限制

1. **主题换肤要重开 App。** `resource/show/skin` 是启动时拉的，热改不会立刻生效。

2. **只影响本机。** 别人点开你的主页，看到的还是你真实的装扮。这是 MITM 的物理边界 —— 数据在别人的手机上渲染，我们碰不到。

3. **没有真实穿戴接口。** `/x/garb/user/suit/equip`、`/v2/.../equip`、`/user/suit/dress` 我逐个实测过，全是 HTML 404。H5 那个「佩戴成功」是 `callNative` 之后的前端提示，真穿装在原生层。所以这是伪装，不是破解。

4. **收藏集只能换空间背景。** 卡片的其他几张脸（名片、开屏、评论背景）在外部找不到可验证的读取接口，所以没做 —— 宁可少做，不做瞎猜。`SpaceBackgroundInfo` 的响应结构也没法验证，用的是结构匹配，真机上不生效就把那次的响应抓给我。

5. **收藏集的主题套装大概率穿不上，这是接口层面的事实。** `collect_list` 里 `redeem_item_type:5` 那条（名字就叫「静态主题套装」）给的是 `redeem_item_id` —— 四个用 `&` 串起来的**素材 id**，不是装扮的 `item_id`。这四个 id 拿去查 `suit/detail` 全部返回 `suit_items:null` 的空壳，装扮商城按名字搜也搜不到，`x/vas/dlc_act/*` 里也没有素材详情接口（试了 `material/detail`、`collect_redeem/detail`、`act/material/list`，全是 HTML 404）。

   所以模块的做法是：**能列出来**（名字、预览图、类型都从 `collect_list` 直接读），点应用时把四个 id 逐个丢给 `suit/detail`，能解析出装扮包的才合并进来。四个都解析不出就明确告诉你「这套是收藏集素材，拿不到装扮包」，不会假装成功。

   要真正穿上，需要拿到它对应的装扮 `item_id`（兑换之后会进「我的装扮」，那时就能在装扮列表里直接选）。

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

在 node 里模拟 Surge 运行时（`$request` / `$response` / `$done` / `$persistentStore` / `$httpClient` 全是桩），跑 105 条断言：

- 两个外壳的注入点位置、HTML 完整性、注入代码语法、无嵌套 `</script>`
- 非 HTML 响应放行
- 桥接 apply / apply-card / apply-set / clear / state / 缺参 / detail 失败 / 卡不在池子里
- `lottery_id` 缺失时自动走 `act/basic/v2` 解析
- 兑换物的四个 id 全查不到 → 明确失败且不落盘；有一个能解析 → 合并成功并记下 `set_id`
- 伪装层的字段替换、无状态放行、坏 JSON 不炸、只改自己的名片
- 空间背景的顶层命中、嵌套命中、四种该放行的场景
- 两套状态互斥：卡片态不触发装扮伪装，装扮态不触发空间背景
- `$done` 每次只调一次（Surge 里调两次会断流）

夹具全是线上实抓，见上面的文件表。

---

## 数据来源

- API 文档：`Suk1u/bilibili-API-collect`（`docs/garb/*`、`docs/misc/sign/*`）
- Surge 手册：`manual.nssurge.com`
- 两个外壳、套装详情、卡池详情、卡池网格：线上实抓，2026-10-26
- `part_id` 对照表：`mall-h5-major` bundle 内的枚举（1 头像挂件 / 2 动态卡片 / 3 点赞效果 / 4 表情 / 5 表情包 / 6 套装 / 7 空间背景 / 8 评论背景 / 9 个性主题 / 10 加载动画 / 11 进度条 / 12 开屏画面 / 13 头像）
