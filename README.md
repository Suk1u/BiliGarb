# BiliGarb — B站装扮注入器（Surge 模块）

在 B站 iOS 客户端的「装扮」界面里加一个悬浮按钮。点开自动列出当前页面出现过的所有装扮，选一个就应用 —— 主题色、侧栏图标、加载动画、名字颜色当场换成那套装扮的样子。随时可还原。

只影响本机渲染，不改你的账号，不需要拥有那套装扮。

---

## 文件

| 文件 | 作用 |
|---|---|
| `BiliGarb.sgmodule` | 模块清单，五条脚本 + MITM |
| `bili-garb.js` | 唯一脚本，靠 `argument=` 分发五种模式 |
| `test/run.js` | 本地测试台，48 条断言 |
| `test/shell.html` | 实抓的装扮 H5 外壳，当注入测试的夹具 |
| `test/detail-36438.json` | 实抓的套装详情，当伪装测试的夹具 |

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

---

## 用法

打开 B站 App → 我的 → 装扮（或任意装扮详情页）。右下角出现一个粉色圆按钮。

点它，底部弹出选择器：

- **当前应用** —— 现在伪装的是哪套装扮
- **列表** —— 当前页面已经加载过的所有装扮，带封面、`#item_id`、部件类型（装扮主 / 主题 / 加载动画 / 空间背景 …）。详情页会自动把当前这套装扮排到第一位。
- **手动输入** —— 直接填 `item_id`，不知道 id 的时候用
- **还原真实装扮** —— 清掉伪装

点某一行右边的「应用」，看到 toast 提示成功，**重开 B站**，主题就换了。

---

## 怎么工作的

三层，一个文件。

```
装扮 H5 页面 (www.bilibili.com/h5/mall/*)
  │  注入层：在 </head> 前插一段 script
  │    · hook fetch / XHR，被动吃掉页面上出现的每一个 item_id
  │    · 粉色 FAB → 抽屉 → 应用
  │    · 应用时 GET 一个魔法 URL
  ↓
桥接层 (http-request 截获 api.bilibili.com/x/garb/_sg/*)
  │    · 用 $httpClient 拉 suit/detail 全量 JSON
  │    · 写进 $persistentStore('bili.garb.current')
  │    · 短路返回 {"code":0}，带 CORS 头
  ↓
伪装层 (http-response 改写 App 拿到的数据)
       · resource/show/skin → user_equip + load_equip
       · web-interface/card → pendant + nickname_color
       · space 系列        → 按名覆盖
```

### 为什么注入点在 head 里

实抓的装扮页外壳 4182 字节，结构是：

```
<!DOCTYPE html><html><head>
  <meta viewport> <link css> <script polyfill> <title></title> <script>reportFirstScreen</script>
</head>            ← 1641 字节
<body>
  <div id="major-app"></div>
  <script src=".../13.major.<hash>.js"></script>   ← 所有 bundle 都在这
  ...
</body></html>     ← 4168 字节
```

所有业务 bundle 都堆在 `</body>` 前面。注入点放 `</head>` 之前，才能抢在 App 的代码调用 `fetch` 之前把 hook 挂上 —— 否则首屏那批请求抓不到。

### 为什么换肤是真的

`app.bilibili.com/x/resource/show/skin` 返回的 `user_equip` 里带 `package_url` 和 `package_md5`，指向 B站自家 CDN 上那套装扮的主题 zip。把这两个字段换掉，App 会自己去下载、校验、套用。

所以不需要在本地托管任何文件，也不需要伪造 md5。

### 为什么不需要签名

WBI、`appkey`+`sign`、`access_key` —— 一个都不用。我们只改写 App 自己发出的请求的**响应**，签名是 App 自己算的。

---

## 已知限制

1. **主题换肤要重开 App。** `resource/show/skin` 是启动时拉的，热改不会立刻生效。

2. **只影响本机。** 别人点开你的主页，看到的还是你真实的装扮。这是 MITM 的物理边界 —— 数据在别人的手机上渲染，我们碰不到。

3. **没有真实穿戴接口。** `/x/garb/user/suit/equip`、`/v2/.../equip`、`/user/suit/dress` 我逐个实测过，全是 HTML 404。H5 那个「佩戴成功」是 `callNative` 之后的前端提示，真穿装在原生层。所以这是伪装，不是破解。

4. **不是每套装扮都有主题部件。** 有 `suit_items.skin` 的才能换主题色和图标；只有 `loading` 的只能换加载动画；`part_id=9` 的纯主题套装反而没有卡片背景。

5. **挂件伪装多数不生效。** `suit_items.pendant` 在 schema 里有，但线上抓的套装（36438、42193）都没有这个键。没有就只改名字颜色。

6. **按钮不出现 = hybrid 缓存。** App 的 WebView 容器可能缓存了外壳 HTML，请求没走网络，注入自然没跑。清 B站缓存，或从别的入口重进装扮页。

7. **一个请求只能跑一个 http-response 脚本。** 同时装了其他 B站模块（比如去广告），同一个 URL 会冲突，后装的赢。

8. **`[MITM]` 用了 `%APPEND%`。** 别改成 `hostname =`，那会清掉你其他模块的 hostname 列表。

---

## 测试

```bash
node test/run.js
```

在 node 里模拟 Surge 运行时（`$request` / `$response` / `$done` / `$persistentStore` / `$httpClient` 全是桩），跑 48 条断言：

- 注入点位置、HTML 完整性、注入代码语法、无嵌套 `</script>`
- 非 HTML 响应放行
- 桥接 apply / clear / state / 缺参 / detail 失败
- 伪装层的字段替换、无状态放行、坏 JSON 不炸、只改自己的名片
- `$done` 每次只调一次（Surge 里调两次会断流）

夹具是实抓的：`test/shell.html` 和 `test/detail-36438.json`（鹿乃桜帆，`part_id=6`，八个部件齐全）。

---

## 数据来源

- API 文档：`Suk1u/bilibili-API-collect`（`docs/garb/*`、`docs/misc/sign/*`）
- Surge 手册：`manual.nssurge.com`
- 外壳与详情响应：线上实抓，2026-10-26
- `part_id` 对照表：`sjh8130/BilibiliSuitCollection`
