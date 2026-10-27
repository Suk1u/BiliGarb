/**
 * BiliGarb — B站装扮 / 收藏集注入器 · Surge 模块脚本
 *
 * 单一文件，六种模式，靠 argument=mode=xxx 分发：
 *   inject        http-response  在装扮 H5 外壳 HTML 里注入悬浮按钮与选择器
 *   bridge        http-request   截获页面发来的魔法 URL，落盘所选装扮或卡片
 *   spoof-skin    http-response  改写 resource/show/skin → 主题色 + 加载动画
 *   spoof-card    http-response  改写 web-interface/card → 挂件 + 名字颜色
 *   spoof-space   http-response  改写 space 系列 → 按名覆盖
 *   spoof-spacebg http-response  改写 Right/SpaceBackgroundInfo → 收藏集空间背景
 *
 * 无外部依赖。不需要 WBI / appkey / access_key —— 我们只改写 App 自己
 * 发出的请求的响应，签名由 App 自己算。
 *
 * 两套数据体系：
 *   装扮   suit  —— item_id 标识，suit_items.{card,card_bg,skin,loading,...}
 *   收藏集 card  —— card_type_id 标识，card_type_info.{content,space_background,splash}
 */

// ─────────────────────────────────────────────────────────────
// §0  工具
// ─────────────────────────────────────────────────────────────

var ARG = (function () {
    var out = {};
    var raw = String(typeof $argument === 'string' ? $argument : '').trim();
    if (!raw) return out;
    // 兼容两种写法：argument=mode=inject 与 argument=inject
    if (raw.indexOf('=') < 0) { out.mode = raw; return out; }
    raw.split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    });
    return out;
})();

var STORE_KEY = 'bili.garb.current';

var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

var HEADERS = {
    'User-Agent': UA,
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'Accept': 'application/json, text/plain, */*'
};

var _finished = false;
function finish(v) {
    if (_finished) return;
    _finished = true;
    try { $done(v || {}); } catch (e) { /* 已结束 */ }
}

function req(opts) {
    return new Promise(function (resolve, reject) {
        var o = { 'auto-cookie': false, timeout: 12, headers: HEADERS };
        for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
        $httpClient.get(o, function (err, resp, data) {
            if (err) reject(new Error(String(err)));
            else resolve({ resp: resp, data: data });
        });
    });
}

/**
 * 状态模型 v2 —— 分槽。
 *
 * 旧版是单一 kind（suit / card / equip），一次只能整套应用。
 * 新版把可独立替换的部件拆成槽位，可以混搭：
 *   主题留这套、挂件用那套、加载动画再用第三套。
 *
 * slots:
 *   skin     个性主题      user_equip 块
 *   loading  加载动画      load_equip 块
 *   pendant  头像挂件      pendant 对象 + 名字颜色
 *   spacebg  空间背景      {image, animation}
 *   playicon 进度条        play_icon 块
 */
var SLOTS = ['skin', 'loading', 'pendant', 'spacebg', 'playicon'];
var SLOT_LABEL = {
    skin: '主题', loading: '加载动画', pendant: '头像挂件',
    spacebg: '空间背景', playicon: '进度条'
};

function emptyState() { return { v: 2, name: '', slots: {} }; }

function writeState(o) {
    try { $persistentStore.write(JSON.stringify(o), STORE_KEY); } catch (e) {}
}

function clearState() {
    try { $persistentStore.write(null, STORE_KEY); } catch (e) {}
}

/** 读状态，旧格式自动迁移 */
function readState() {
    try {
        var raw = $persistentStore.read(STORE_KEY);
        if (!raw) return null;
        var o = JSON.parse(raw);
        if (!o) return null;
        if (o.v === 2 && o.slots) return o;
        return migrate(o);
    } catch (e) { return null; }
}

function countSlots(st) {
    if (!st || !st.slots) return 0;
    var n = 0;
    for (var i = 0; i < SLOTS.length; i++) if (st.slots[SLOTS[i]]) n++;
    return n;
}

/** 旧状态（kind: suit / card / equip）→ v2 槽位 */
function migrate(o) {
    var st = emptyState();
    st.name = o.name || '';

    if (o.kind === 'equip') {
        if (o.user_equip) st.slots.skin = { id: o.id, name: o.name || '', user_equip: o.user_equip };
        if (o.load_equip) st.slots.loading = { id: o.id, name: o.name || '', load_equip: o.load_equip };
        if (o.play_icon) st.slots.playicon = { id: o.id, name: o.name || '', icon: o.play_icon };
        return countSlots(st) ? st : null;
    }

    if (o.kind === 'card') {
        var sb = o.card && o.card.space_background;
        if (!sb) return null;
        st.slots.spacebg = {
            id: o.card_type_id, name: o.name || '',
            image: sb.image || '', animation: sb.animation || null
        };
        return st;
    }

    if (o.detail) {
        var n = fromDetail(o.detail, o.name);
        if (o.set_id) n.set_id = String(o.set_id);
        return countSlots(n) ? n : null;
    }
    return null;
}

// ── 从 suit/detail 的 suit_items 造各个槽位 ──────────────────

function buildUserEquip(it, fallbackName) {
    var p = (it && it.properties) || {};
    if (!p.package_url) return null;
    return {
        id: it.item_id,
        name: it.name || fallbackName || '',
        preview: p.image_cover || p.image_preview || '',
        ver: Number(p.ver) || Math.floor(Date.now() / 1000),
        package_url: p.package_url,
        package_md5: p.package_md5 || '',
        data: {
            color: p.color || '#ffffff',
            color_mode: p.color_mode || 'light',
            color_second_page: p.color_second_page || '#ffffff',
            tail_color: p.tail_color || '#e9e9e9',
            tail_color_selected: p.tail_color_selected || '#ffe556',
            tail_icon_ani: String(p.tail_icon_ani) === 'true',
            tail_icon_ani_mode: p.tail_icon_ani_mode || 'once'
        }
    };
}

function buildLoading(it) {
    var p = (it && it.properties) || {};
    if (!p.loading_url) return null;
    return { id: it.item_id, name: it.name || '', ver: Number(p.ver) || 0, loading_url: p.loading_url };
}

function buildPendant(it) {
    var p = (it && it.properties) || {};
    if (!p.image) return null;
    return {
        pid: it.item_id,
        name: it.name || '',
        image: p.image,
        expire: 0,
        image_enhance: p.image_enhance || p.image,
        image_enhance_frame: p.image_enhance_frame || '',
        n_pid: it.item_id
    };
}

/** 进度条。键名按资源包 _trans.json 里 play_icon 的形状，取不到就给空串。 */
function buildPlayIcon(it) {
    var p = (it && it.properties) || {};
    var mid = p.middle_png || p.image || '';
    var any = p.drag_left_png || p.drag_right_png || mid || p.squared_image;
    if (!any) return null;
    return {
        drag_left_png: p.drag_left_png || '',
        drag_right_png: p.drag_right_png || '',
        middle_png: mid,
        squared_image: p.squared_image || '',
        static_icon_image: p.static_icon_image || p.image || '',
        goods_type: p.goods_type || 'garb',
        ver: String(p.ver || ''),
        id: it.item_id
    };
}

/**
 * 空间背景。有两种完全不同的形状：
 *   装扮套装：分层图 image1_landscape / image1_portrait … image5_*，外加 fan_no_image
 *   收藏集卡片：{image, animation}
 * 都收，靠槽位里有没有 layers 区分。
 */
function buildSpaceBg(it) {
    var p = (it && it.properties) || {};

    // 分层形状
    var layers = {};
    var n = 0;
    for (var k in p) {
        if (/^image\d+_(landscape|portrait)$/.test(k) && p[k]) { layers[k] = p[k]; n++; }
    }
    if (p.fan_no_image) { layers.fan_no_image = p.fan_no_image; n++; }
    if (p.fan_no_color) { layers.fan_no_color = p.fan_no_color; }
    if (n > 0) return { layers: layers };

    // 单图 / 动图形状
    var img = p.image || p.image_cover || p.image_preview || '';
    var anim = (p.animation && typeof p.animation === 'object') ? p.animation : null;
    if (!anim) {
        var url = p.animation_url || p.animation_backup_image || '';
        if (url) {
            anim = {
                animation_url: p.animation_url || '',
                animation_backup_image: p.animation_backup_image || p.image || '',
                animation_first_frame: p.animation_first_frame || p.image || '',
                duration: p.duration || 0,
                is_mute: p.is_mute !== undefined ? p.is_mute : true
            };
        }
    }
    if (!img && !anim) return null;
    return { image: img, animation: anim };
}

/** 从 detail 造完整槽位集 */
function fromDetail(detail, fallbackName) {
    var st = emptyState();
    var items = (detail && detail.suit_items) || {};
    var name = (detail && detail.name) || fallbackName || '';
    st.name = name;

    var sk = firstPart(items.skin);
    var ue = buildUserEquip(sk, name);
    if (ue) st.slots.skin = { id: sk.item_id, name: sk.name || name, user_equip: ue };

    var ld = buildLoading(firstPart(items.loading));
    if (ld) st.slots.loading = { id: ld.id, name: ld.name || name, load_equip: ld };

    // 名字颜色跟主题走，不跟挂件走 —— 没有挂件的套装也常常有颜色
    st.color = (sk && sk.properties && sk.properties.color) || '';

    var pd = buildPendant(firstPart(items.pendant));
    if (pd) st.slots.pendant = { id: pd.pid, name: pd.name || name, pendant: pd };

    var pi = buildPlayIcon(firstPart(items.play_icon));
    if (pi) st.slots.playicon = { id: pi.id, name: name, icon: pi };

    var sbi = firstPart(items.space_bg);
    var sbg = buildSpaceBg(sbi);
    if (sbg) {
        st.slots.spacebg = {
            id: sbi && sbi.item_id,
            name: (sbi && sbi.name) || name,
            image: sbg.image || '',
            animation: sbg.animation || null,
            layers: sbg.layers || null
        };
    }

    return st;
}

/** 把 src 的某个槽位搬进 dst */
function copySlot(dst, src, slot) {
    if (src && src.slots && src.slots[slot]) dst.slots[slot] = src.slots[slot];
    else delete dst.slots[slot];
}

// ── 纯 JS MD5（Surge 的 JS 引擎没有 crypto） ─────────────────
// 已用 md5("") / "abc" / "message digest" 和 B站 APP 签名测试向量校验过。
function md5(str) {
    function safeAdd(x, y) {
        var lsw = (x & 0xffff) + (y & 0xffff);
        var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
        return (msw << 16) | (lsw & 0xffff);
    }
    function rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
    function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

    var n = str.length;
    var bytes = [];
    for (var i = 0; i < n; i++) bytes.push(str.charCodeAt(i) & 0xff);

    var bitLen = n * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var k = 0; k < 8; k++) bytes.push((k < 4) ? ((bitLen >>> (8 * k)) & 0xff) : 0);

    var x = [];
    for (var w = 0; w < bytes.length; w += 4) {
        x.push(bytes[w] | (bytes[w + 1] << 8) | (bytes[w + 2] << 16) | (bytes[w + 3] << 24));
    }

    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;

    for (var j = 0; j < x.length; j += 16) {
        var oa = a, ob = b, oc = c, od = d;

        a = ff(a, b, c, d, x[j], 7, -680876936);
        d = ff(d, a, b, c, x[j + 1], 12, -389564586);
        c = ff(c, d, a, b, x[j + 2], 17, 606105819);
        b = ff(b, c, d, a, x[j + 3], 22, -1044525330);
        a = ff(a, b, c, d, x[j + 4], 7, -176418897);
        d = ff(d, a, b, c, x[j + 5], 12, 1200080426);
        c = ff(c, d, a, b, x[j + 6], 17, -1473231341);
        b = ff(b, c, d, a, x[j + 7], 22, -45705983);
        a = ff(a, b, c, d, x[j + 8], 7, 1770035416);
        d = ff(d, a, b, c, x[j + 9], 12, -1958414417);
        c = ff(c, d, a, b, x[j + 10], 17, -42063);
        b = ff(b, c, d, a, x[j + 11], 22, -1990404162);
        a = ff(a, b, c, d, x[j + 12], 7, 1804603682);
        d = ff(d, a, b, c, x[j + 13], 12, -40341101);
        c = ff(c, d, a, b, x[j + 14], 17, -1502002290);
        b = ff(b, c, d, a, x[j + 15], 22, 1236535329);

        a = gg(a, b, c, d, x[j + 1], 5, -165796510);
        d = gg(d, a, b, c, x[j + 6], 9, -1069501632);
        c = gg(c, d, a, b, x[j + 11], 14, 643717713);
        b = gg(b, c, d, a, x[j], 20, -373897302);
        a = gg(a, b, c, d, x[j + 5], 5, -701558691);
        d = gg(d, a, b, c, x[j + 10], 9, 38016083);
        c = gg(c, d, a, b, x[j + 15], 14, -660478335);
        b = gg(b, c, d, a, x[j + 4], 20, -405537848);
        a = gg(a, b, c, d, x[j + 9], 5, 568446438);
        d = gg(d, a, b, c, x[j + 14], 9, -1019803690);
        c = gg(c, d, a, b, x[j + 3], 14, -187363961);
        b = gg(b, c, d, a, x[j + 8], 20, 1163531501);
        a = gg(a, b, c, d, x[j + 13], 5, -1444681467);
        d = gg(d, a, b, c, x[j + 2], 9, -51403784);
        c = gg(c, d, a, b, x[j + 7], 14, 1735328473);
        b = gg(b, c, d, a, x[j + 12], 20, -1926607734);

        a = hh(a, b, c, d, x[j + 5], 4, -378558);
        d = hh(d, a, b, c, x[j + 8], 11, -2022574463);
        c = hh(c, d, a, b, x[j + 11], 16, 1839030562);
        b = hh(b, c, d, a, x[j + 14], 23, -35309556);
        a = hh(a, b, c, d, x[j + 1], 4, -1530992060);
        d = hh(d, a, b, c, x[j + 4], 11, 1272893353);
        c = hh(c, d, a, b, x[j + 7], 16, -155497632);
        b = hh(b, c, d, a, x[j + 10], 23, -1094730640);
        a = hh(a, b, c, d, x[j + 13], 4, 681279174);
        d = hh(d, a, b, c, x[j], 11, -358537222);
        c = hh(c, d, a, b, x[j + 3], 16, -722521979);
        b = hh(b, c, d, a, x[j + 6], 23, 76029189);
        a = hh(a, b, c, d, x[j + 9], 4, -640364487);
        d = hh(d, a, b, c, x[j + 12], 11, -421815835);
        c = hh(c, d, a, b, x[j + 15], 16, 530742520);
        b = hh(b, c, d, a, x[j + 2], 23, -995338651);

        a = ii(a, b, c, d, x[j], 6, -198630844);
        d = ii(d, a, b, c, x[j + 7], 10, 1126891415);
        c = ii(c, d, a, b, x[j + 14], 15, -1416354905);
        b = ii(b, c, d, a, x[j + 5], 21, -57434055);
        a = ii(a, b, c, d, x[j + 12], 6, 1700485571);
        d = ii(d, a, b, c, x[j + 3], 10, -1894986606);
        c = ii(c, d, a, b, x[j + 10], 15, -1051523);
        b = ii(b, c, d, a, x[j + 1], 21, -2054922799);
        a = ii(a, b, c, d, x[j + 8], 6, 1873313359);
        d = ii(d, a, b, c, x[j + 15], 10, -30611744);
        c = ii(c, d, a, b, x[j + 6], 15, -1560198380);
        b = ii(b, c, d, a, x[j + 13], 21, 1309151649);
        a = ii(a, b, c, d, x[j + 4], 6, -145523070);
        d = ii(d, a, b, c, x[j + 11], 10, -1120210379);
        c = ii(c, d, a, b, x[j + 2], 15, 718787259);
        b = ii(b, c, d, a, x[j + 9], 21, -343485551);

        a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
    }

    function hex(num) {
        var s = '', v;
        for (var i = 0; i < 4; i++) {
            v = (num >>> (i * 8)) & 0xff;
            s += ('0' + v.toString(16)).slice(-2);
        }
        return s;
    }
    return hex(a) + hex(b) + hex(c) + hex(d);
}

// ── APP 签名（appkey + appsec） ──────────────────────────────
var APPKEY = '27eb53fc9058f8c3';
var APPSEC = 'c2ed53a74eeefe3cf99fbd01d8c9c375';
var TOKEN_KEY = 'bili.garb.access_key';

function readToken() {
    try { return $persistentStore.read(TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function writeToken(t) {
    try { $persistentStore.write(String(t || ''), TOKEN_KEY); } catch (e) {}
}

/** sign = md5(sorted_query + appsec)，返回完整 query 串（含 sign） */
function appSign(params) {
    var keys = Object.keys(params).sort();
    var q = keys.map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]));
    }).join('&');
    return q + '&sign=' + md5(q + APPSEC);
}

/** 带 APP 签名的 GET，自动补 appkey/ts/platform/build 和 access_key */
function appGet(path, params) {
    var p = {};
    for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) p[k] = params[k];
    p.appkey = APPKEY;
    p.ts = Math.round(Date.now() / 1000);
    p.platform = 'ios';
    p.mobi_app = 'iphone';
    p.build = '91601100';
    var ak = readToken();
    if (ak) p.access_key = ak;
    return req({ url: 'https://api.bilibili.com' + path + '?' + appSign(p) });
}

function firstPart(v) {
    if (Array.isArray(v)) return v.length ? v[0] : null;
    if (v && typeof v === 'object') return v;
    return null;
}

function hdr(name) {
    if (typeof $request === 'undefined' || !$request.headers) return '';
    var h = $request.headers;
    var lower = name.toLowerCase();
    for (var k in h) if (k.toLowerCase() === lower) return h[k];
    return '';
}

/** 从请求 Cookie 里取自己的 uid，用于只改自己的名片 */
function selfUid() {
    var c = hdr('Cookie');
    if (!c) return '';
    var m = /(?:^|;\s*)DedeUserID=(\d+)/.exec(c);
    return m ? m[1] : '';
}

/** 通用深遍历：只读，不插入键 */
function walkObject(node, fn, depth) {
    depth = depth || 0;
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walkObject(node[i], fn, depth + 1);
        return;
    }
    if (typeof node !== 'object') return;
    fn(node);
    for (var k in node) {
        var v = node[k];
        if (v && typeof v === 'object') walkObject(v, fn, depth + 1);
    }
}

/** 收藏集卡片里「空间背景」资源的结构签名 */
function looksLikeSpaceBg(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    var a = o.animation;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
    return !!(a.animation_url || a.animation_backup_image || a.animation_first_frame);
}

// ─────────────────────────────────────────────────────────────
// §1  注入页面里的那段代码（自包含，不可引用外部变量）
// ─────────────────────────────────────────────────────────────

function overlayMain() {
    if (window.__BILI_GARB_UI__) return;
    window.__BILI_GARB_UI__ = true;

    var SG = 'https://api.bilibili.com/x/garb/_sg';
    var SUIT = {};       // item_id      -> {kind:'suit', id, name, cover, part}
    var CARD = {};       // card_type_id -> {kind:'card', id, name, cover}
    var SET = {};        // collect_id   -> {kind:'set',  id, name, cover, typeName, ids}
    var ORDER = [];      // [{k:'suit'|'card'|'set', id}]，保持发现顺序
    var state = null;    // {kind, item_id|card_type_id, name}
    var applied = false;

    // ── 数据吸收 ────────────────────────────────────────────
    function push(kind, id, item) {
        var store = kind === 'card' ? CARD : (kind === 'set' ? SET : SUIT);
        if (!store[id]) ORDER.push({ k: kind, id: id });
        store[id] = item;
    }

    function putSuit(node) {
        var raw = node.item_id;
        if (typeof raw !== 'number' && typeof raw !== 'string') return;
        var id = String(raw);
        if (!id || id === '0') return;

        var p = (node.properties && typeof node.properties === 'object') ? node.properties : {};
        var name = node.name || node.group_name || '';
        var cover = p.image_cover || p.image_preview || p.image || p.image_preview_small || '';
        if (!name && !cover) return;

        push('suit', id, {
            kind: 'suit',
            id: id,
            name: String(name || ('#' + id)),
            cover: String(cover || ''),
            part: (typeof node.part_id === 'number') ? node.part_id : null
        });
    }

    function putCard(info, fallbackId, fallbackName, fallbackImg) {
        var raw = (info && info.id) || fallbackId;
        if (typeof raw !== 'number' && typeof raw !== 'string') return;
        var id = String(raw);
        if (!id || id === '0') return;

        var name = (info && info.name) || fallbackName || '';
        var cover = '';
        if (info) {
            cover = info.overview_image
                || (info.content && info.content.animation && info.content.animation.animation_backup_image)
                || (info.space_background && info.space_background.animation
                    && info.space_background.animation.animation_backup_image)
                || (info.space_background && info.space_background.image)
                || '';
        }
        cover = cover || fallbackImg || '';
        if (!name && !cover) return;

        push('card', id, {
            kind: 'card',
            id: id,
            name: String(name || ('卡 #' + id)),
            cover: String(cover || ''),
            part: null
        });
    }

    /** 收藏集兑换物：主题套装 / 头像挂件 / 表情包 / 评论背景 */
    function putSet(node) {
        if (node.collect_id == null) return;
        if (!node.redeem_item_name && !node.redeem_item_image) return;

        var raw = String(node.redeem_item_id || '');
        var ids = raw ? raw.split('&').filter(function (x) { return /^\d+$/.test(x); }) : [];

        push('set', String(node.collect_id), {
            kind: 'set',
            id: String(node.collect_id),
            name: String(node.redeem_item_name || ('兑换物 #' + node.collect_id)),
            cover: String(node.redeem_item_image || ''),
            part: null,
            typeName: String(node.redeem_item_type_name || ''),
            ids: ids
        });
    }

    function walk(node, depth) {
        if (!node || depth > 8) return;
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
            return;
        }
        if (typeof node !== 'object') return;

        // 装扮：item_id
        if (Object.prototype.hasOwnProperty.call(node, 'item_id')) putSuit(node);

        // 收藏集兑换物
        if (Object.prototype.hasOwnProperty.call(node, 'redeem_item_type')) putSet(node);

        // 收藏集：detail/v2 的 {card_type_info:{...}}
        if (node.card_type_info && typeof node.card_type_info === 'object') {
            putCard(node.card_type_info);
        }
        // 收藏集：网格的 {card_type_id, card_name, card_img}
        if (Object.prototype.hasOwnProperty.call(node, 'card_type_id')) {
            putCard(null, node.card_type_id, node.card_name, node.card_img);
        }
        // 收藏集：背包的 {card_item:{card_type_id,...}}
        if (node.card_item && typeof node.card_item === 'object' &&
            Object.prototype.hasOwnProperty.call(node.card_item, 'card_type_id')) {
            putCard(null, node.card_item.card_type_id, node.card_item.card_name, node.card_item.card_img);
        }

        for (var k in node) {
            var v = node[k];
            if (v && typeof v === 'object') walk(v, depth + 1);
        }
    }

    function absorbText(t) {
        if (!t || typeof t !== 'string') return;
        if (t.length > 4000000) return;
        if (t.indexOf('item_id') < 0 && t.indexOf('card_type_id') < 0 &&
            t.indexOf('card_type_info') < 0 && t.indexOf('redeem_item_type') < 0) return;
        try { walk(JSON.parse(t), 0); } catch (e) { }
    }

    // ── 被动捕获 ────────────────────────────────────────────
    var _fetch = window.fetch;

    if (_fetch) {
        window.fetch = function () {
            var p = _fetch.apply(this, arguments);
            try {
                p.then(function (r) {
                    try {
                        if (r && typeof r.clone === 'function') {
                            r.clone().text().then(absorbText, function () { });
                        }
                    } catch (e) { }
                }, function () { });
            } catch (e) { }
            return p;
        };
    }

    var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && XP.open) {
        var _open = XP.open;
        XP.open = function () {
            var self = this;
            self.addEventListener('load', function () {
                try {
                    if (self.responseType === 'json') absorbText(JSON.stringify(self.response));
                    else if (!self.responseType || self.responseType === 'text') absorbText(self.responseText);
                } catch (e) { }
            });
            return _open.apply(self, arguments);
        };
    }

    // ── 当前页装扮 / 当前收藏集 ─────────────────────────────
    function qs(k) {
        var m = new RegExp('[?&]' + k + '=([^&#]*)').exec(location.href);
        return m ? decodeURIComponent(m[1]) : '';
    }

    function loadCurrent() {
        if (!_fetch) return;

        // 装扮详情页：?id=<item_id>
        var sid = qs('id');
        if (sid) {
            _fetch('https://api.bilibili.com/x/garb/v2/mall/suit/detail?item_id=' +
                encodeURIComponent(sid), { credentials: 'include' })
                .then(function (r) { return r.text(); })
                .then(absorbText)
                .catch(function () { });
        }

        // 收藏集详情页：?act_id=&lottery_id=
        var act = qs('act_id');
        var lot = qs('lottery_id');
        if (act && lot) {
            _fetch('https://api.bilibili.com/x/vas/dlc_act/lottery/detail/v2?act_id=' +
                encodeURIComponent(act) + '&lottery_id=' + encodeURIComponent(lot),
                { credentials: 'include' })
                .then(function (r) { return r.text(); })
                .then(absorbText)
                .catch(function () { });
            loadCollect(act, lot);
        } else if (act) {
            // 只有 act_id 的页面（穿戴页），先解析 lottery_id 再拉兑换物
            _fetch('https://api.bilibili.com/x/vas/dlc_act/act/basic/v2?act_id=' +
                encodeURIComponent(act), { credentials: 'include' })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    var list = (j && j.data && j.data.lottery_list) || [];
                    if (list.length) loadCollect(act, String(list[0].lottery_id));
                })
                .catch(function () { });
        }
    }

    /** 收藏集兑换物：主题套装 / 头像挂件 / 表情包 / 评论背景 */
    function loadCollect(act, lot) {
        _fetch('https://api.bilibili.com/x/vas/dlc_act/lottery/collect_list?act_id=' +
            encodeURIComponent(act) + '&lottery_id=' + encodeURIComponent(lot),
            { credentials: 'include' })
            .then(function (r) { return r.text(); })
            .then(absorbText)
            .catch(function () { });
    }

    function loadState() {
        if (!_fetch) return Promise.resolve();
        return _fetch(SG + '/state', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.code === 0 && j.data) { state = j.data; applied = true; }
                else { state = null; applied = false; }
            })
            .catch(function () { });
    }

    // ── 样式 ────────────────────────────────────────────────
    var CSS = [
        '.bg-fab{position:fixed;right:16px;bottom:calc(96px + env(safe-area-inset-bottom,0px));',
        'width:52px;height:52px;border-radius:50%;background:#FB7299;border:none;padding:0;margin:0;',
        'display:flex;align-items:center;justify-content:center;cursor:pointer;',
        'box-shadow:0 6px 20px rgba(251,114,153,.42);z-index:2147483646;',
        'transition:transform .15s ease,box-shadow .15s ease;-webkit-tap-highlight-color:transparent}',
        '.bg-fab:active{transform:scale(.92);box-shadow:0 3px 10px rgba(251,114,153,.36)}',
        '.bg-fab{touch-action:none;user-select:none;-webkit-user-select:none}',

        '.bg-mask{position:fixed;left:0;right:0;top:0;bottom:0;background:rgba(0,0,0,.46);',
        'z-index:2147483647;opacity:0;pointer-events:none;transition:opacity .2s ease}',
        '.bg-mask.on{opacity:1;pointer-events:auto}',

        '.bg-sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;',
        'background:#fff;color:#18191c;border-radius:18px 18px 0 0;',
        'transform:translateY(103%);transition:transform .26s cubic-bezier(.22,.61,.36,1);',
        'max-height:74vh;display:flex;flex-direction:column;overflow:hidden;',
        'font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;',
        'box-shadow:0 -8px 32px rgba(0,0,0,.16)}',
        '.bg-sheet.on{transform:translateY(0)}',

        '.bg-hd{display:flex;align-items:center;justify-content:space-between;',
        'padding:16px 18px 10px;flex:0 0 auto}',
        '.bg-title{font-size:16px;font-weight:600;letter-spacing:.2px}',
        '.bg-close{width:28px;height:28px;border:none;background:transparent;color:#9499a0;',
        'font-size:22px;line-height:1;padding:0;cursor:pointer}',

        '.bg-status{margin:0 18px 12px;padding:9px 12px;border-radius:10px;',
        'background:#fff1f5;color:#d63f68;font-size:12.5px;flex:0 0 auto;',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.bg-status.off{background:#f4f5f7;color:#787c85}',

        '.bg-list{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;',
        'padding:0 12px 4px;min-height:60px}',
        '.bg-group{font-size:11.5px;color:#9499a0;letter-spacing:.4px;',
        'padding:10px 8px 4px;font-weight:500}',
        '.bg-row{display:flex;align-items:center;gap:12px;padding:9px 6px;border-radius:12px}',
        '.bg-row:active{background:#f6f7f9}',
        '.bg-row.cur{background:#fff1f5}',
        '.bg-thumb{width:46px;height:46px;border-radius:10px;object-fit:cover;',
        'background:#eef0f3;flex:0 0 auto}',
        '.bg-meta{flex:1 1 auto;min-width:0}',
        '.bg-name{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.bg-sub{font-size:11.5px;color:#9499a0;margin-top:2px}',
        '.bg-tag{display:inline-block;font-size:10px;line-height:1;padding:2px 5px;',
        'border-radius:4px;background:#eef0f3;color:#787c85;margin-right:5px;vertical-align:1px}',
        '.bg-tag.card{background:#e8f0ff;color:#4a72c4}',
        '.bg-apply{flex:0 0 auto;border:none;border-radius:14px;padding:6px 14px;',
        'background:#FB7299;color:#fff;font-size:12.5px;cursor:pointer}',
        '.bg-apply:active{opacity:.8}',
        '.bg-apply.done{background:#eef0f3;color:#9499a0}',
        '.bg-more{flex:0 0 auto;border:none;border-radius:14px;padding:6px 10px;',
        'background:#eef0f3;color:#61666d;font-size:12px;cursor:pointer;margin-left:-6px}',
        '.bg-more:active{opacity:.7}',
        '.bg-slotbar{display:flex;flex-wrap:wrap;gap:6px;padding:2px 6px 10px 64px}',
        '.bg-slotbtn{border:1px solid #e3e5e7;background:#fff;color:#61666d;',
        'border-radius:12px;padding:5px 12px;font-size:12px;cursor:pointer}',
        '.bg-slotbtn:active{background:#fff1f5;border-color:#FB7299;color:#d63f68}',

        '.bg-empty{padding:22px 10px;text-align:center;color:#9499a0;font-size:12.5px}',

        '.bg-manual{display:flex;gap:8px;padding:10px 18px;flex:0 0 auto;',
        'border-top:1px solid #f1f2f4}',
        '.bg-input{flex:1 1 auto;min-width:0;border:1px solid #e3e5e7;border-radius:10px;',
        'padding:9px 12px;font-size:13px;outline:none;background:#fafbfc;color:#18191c}',
        '.bg-input:focus{border-color:#FB7299;background:#fff}',
        '.bg-go{flex:0 0 auto;border:none;border-radius:10px;padding:0 16px;',
        'background:#FB7299;color:#fff;font-size:13px;cursor:pointer}',

        '.bg-ft{display:flex;align-items:center;justify-content:space-between;gap:10px;',
        'padding:10px 18px calc(14px + env(safe-area-inset-bottom,0px));flex:0 0 auto}',
        '.bg-reset{border:1px solid #e3e5e7;background:#fff;color:#61666d;border-radius:10px;',
        'padding:8px 16px;font-size:12.5px;cursor:pointer}',
        '.bg-reset:active{background:#f6f7f9}',
        '.bg-hint{font-size:11px;color:#b0b4ba;text-align:right;flex:1 1 auto}',

        '.bg-toast{position:fixed;left:50%;bottom:120px;transform:translateX(-50%) translateY(8px);',
        'background:rgba(24,25,28,.9);color:#fff;font-size:12.5px;padding:9px 16px;border-radius:18px;',
        'z-index:2147483647;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;',
        'max-width:78vw;text-align:center;line-height:1.4}',
        '.bg-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}',

        '@media (prefers-color-scheme: dark){',
        '.bg-sheet{background:#1f2023;color:#e3e5e7}',
        '.bg-status{background:#3a2229;color:#ff8fb0}',
        '.bg-status.off{background:#2a2b2f;color:#9499a0}',
        '.bg-row.cur{background:#3a2229}',
        '.bg-row:active{background:#2a2b2f}',
        '.bg-thumb{background:#2a2b2f}',
        '.bg-sub{color:#787c85}',
        '.bg-tag{background:#2a2b2f;color:#9499a0}',
        '.bg-tag.card{background:#26314a;color:#7f9fd8}',
        '.bg-manual{border-top-color:#2a2b2f}',
        '.bg-input{background:#2a2b2f;border-color:#3a3b40;color:#e3e5e7}',
        '.bg-input:focus{background:#232428}',
        '.bg-reset{background:#2a2b2f;border-color:#3a3b40;color:#b0b4ba}',
        '.bg-apply.done{background:#2a2b2f;color:#787c85}',
        '.bg-more{background:#2a2b2f;color:#b0b4ba}',
        '.bg-slotbtn{background:#232428;border-color:#3a3b40;color:#b0b4ba}',
        '}'
    ].join('');

    // ── DOM ─────────────────────────────────────────────────
    var fab, mask, sheet, listEl, statusEl, toastEl, toastTimer;

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function toast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.classList.add('on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
    }

    var PART_LABEL = {
        1: '头像挂件', 2: '动态卡片', 3: '点赞效果', 4: '表情', 5: '表情包',
        6: '套装', 7: '空间背景', 8: '评论背景', 9: '个性主题',
        10: '加载动画', 11: '进度条', 12: '开屏画面', 13: '头像'
    };

    // 和桥接层的 SLOTS / SLOT_LABEL 保持一致
    var SLOT_ORDER = ['skin', 'loading', 'pendant', 'spacebg', 'playicon'];
    var SLOT_LABEL = {
        skin: '主题', loading: '加载动画', pendant: '头像挂件',
        spacebg: '空间背景', playicon: '进度条'
    };

    function renderStatus() {
        if (!statusEl) return;
        var n = state && state.count ? state.count : 0;
        if (applied && n > 0) {
            var names = [];
            for (var k in (state.slots || {})) {
                names.push(SLOT_LABEL[k] + '：' + (state.slots[k] || ''));
            }
            statusEl.className = 'bg-status';
            statusEl.textContent = '已应用 ' + n + ' 个部件 · ' + names.join('｜');
        } else {
            statusEl.className = 'bg-status off';
            statusEl.textContent = '未应用任何装扮 · 点下方任一行开始';
        }
    }

    /** 这一行是否已经在用（任一槽位 id 命中即算） */
    function isInUse(item) {
        if (!state || !state.slots) return false;
        for (var k in state.slots) {
            var sl = state.slots[k];
            if (sl && String(sl.id) === String(item.id)) return true;
        }
        return false;
    }

    function toggleSlots(rowEl, item) {
        var next = rowEl.nextSibling;
        if (next && next.className && next.className.indexOf('bg-slotbar') === 0) {
            next.parentNode.removeChild(next);
            return;
        }
        var bar = el('div', 'bg-slotbar');
        SLOT_ORDER.forEach(function (sl) {
            var b = el('button', 'bg-slotbtn', SLOT_LABEL[sl]);
            b.addEventListener('click', function (ev) {
                ev.stopPropagation();
                applyPart(item, sl);
            });
            bar.appendChild(b);
        });
        rowEl.parentNode.insertBefore(bar, rowEl.nextSibling);
    }

    function row(item) {
        var isCur = isInUse(item);

        var r = el('div', 'bg-row' + (isCur ? ' cur' : ''));

        if (item.cover) {
            var img = el('img', 'bg-thumb');
            img.src = item.cover;
            img.loading = 'lazy';
            img.onerror = function () { img.style.visibility = 'hidden'; };
            r.appendChild(img);
        } else {
            r.appendChild(el('div', 'bg-thumb'));
        }

        var meta = el('div', 'bg-meta');
        meta.appendChild(el('div', 'bg-name', item.name));

        var sub = el('div', 'bg-sub');
        var isCollect = item.kind === 'card' || item.kind === 'set';
        sub.appendChild(el('span', 'bg-tag' + (isCollect ? ' card' : ''),
            isCollect ? '收藏集' : '装扮'));

        var tail = '#' + item.id;
        if (item.kind === 'suit' && item.part != null) {
            tail += ' · ' + (PART_LABEL[item.part] || ('part ' + item.part));
        } else if (item.kind === 'set' && item.typeName) {
            tail = item.typeName;
        }
        sub.appendChild(document.createTextNode(tail));
        meta.appendChild(sub);
        r.appendChild(meta);

        if (item.kind === 'suit') {
            var more = el('button', 'bg-more', '部件');
            more.addEventListener('click', function (ev) {
                ev.stopPropagation();
                toggleSlots(r, item);
            });
            r.appendChild(more);
        }

        var btn = el('button', 'bg-apply' + (isCur ? ' done' : ''), isCur ? '使用中' : '应用');
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (isCur) return;
            if (item.kind === 'card') applyCard(item);
            else if (item.kind === 'set') applySet(item);
            else applySuit(item);
        });
        r.appendChild(btn);
        return r;
    }

    function render() {
        if (!listEl) return;
        renderStatus();

        var suits = [], cards = [], sets = [];
        for (var i = 0; i < ORDER.length; i++) {
            var o = ORDER[i];
            if (o.k === 'card') { if (CARD[o.id]) cards.push(CARD[o.id]); }
            else if (o.k === 'set') { if (SET[o.id]) sets.push(SET[o.id]); }
            else { if (SUIT[o.id]) suits.push(SUIT[o.id]); }
        }

        // 当前页的装扮排最前
        var pid = qs('id');
        if (pid && SUIT[pid]) {
            suits = [SUIT[pid]].concat(suits.filter(function (x) { return x.id !== pid; }));
        }

        listEl.innerHTML = '';
        if (!suits.length && !cards.length && !sets.length) {
            listEl.appendChild(el('div', 'bg-empty',
                '本页还没抓到数据。\n往上滑一滑让页面加载，或在下方直接输入 item_id。'));
            return;
        }

        if (suits.length) {
            listEl.appendChild(el('div', 'bg-group', '装扮 · ' + suits.length));
            for (var s = 0; s < suits.length && s < 150; s++) listEl.appendChild(row(suits[s]));
        }
        if (cards.length) {
            listEl.appendChild(el('div', 'bg-group', '收藏集卡片 · ' + cards.length));
            for (var c = 0; c < cards.length && c < 150; c++) listEl.appendChild(row(cards[c]));
        }
        if (sets.length) {
            listEl.appendChild(el('div', 'bg-group', '收藏集兑换物 · ' + sets.length));
            for (var t = 0; t < sets.length && t < 60; t++) listEl.appendChild(row(sets[t]));
        }
    }

    function openSheet() {
        loadCurrent();
        loadState().then(render, render);
        mask.classList.add('on');
        sheet.classList.add('on');
        render();
    }

    function closeSheet() {
        mask.classList.remove('on');
        sheet.classList.remove('on');
    }

    function afterApply(j, fallbackName) {
        if (j && j.code === 0) {
            toast('已应用：' + fallbackName + '　重开 B站 生效');
            return loadState().then(render, render);
        }
        toast('失败：' + ((j && j.message) || '未知错误'));
        render();
    }

    /** 只应用一个部件，其余槽位保留 */
    function applyPart(item, slot) {
        if (!_fetch) { toast('当前环境不支持请求'); return; }
        toast('应用中…');
        _fetch(SG + '/apply-part?item_id=' + encodeURIComponent(item.id) +
            '&slot=' + encodeURIComponent(slot), { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.code === 0 && j.data) {
                    afterApply(j, (j.data.label || SLOT_LABEL[slot] || slot) + ' · ' + item.name);
                } else {
                    toast('失败：' + ((j && j.message) || '未知错误'));
                }
            })
            .catch(function (e) { toast('失败：' + (e && e.message ? e.message : e)); });
    }

    function applySuit(item) {
        if (!_fetch) { toast('当前环境不支持请求'); return; }
        toast('应用中…');
        _fetch(SG + '/apply?item_id=' + encodeURIComponent(item.id), { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (j) { afterApply(j, item.name); })
            .catch(function (e) { toast('失败：' + (e && e.message ? e.message : e)); render(); });
    }

    function applyCard(item) {
        if (!_fetch) { toast('当前环境不支持请求'); return; }
        var act = qs('act_id');
        var lot = qs('lottery_id');
        if (!act) { toast('拿不到 act_id，请在收藏集页面内操作'); return; }
        toast('应用中…');
        _fetch(SG + '/apply-card?act_id=' + encodeURIComponent(act) +
            '&lottery_id=' + encodeURIComponent(lot) +
            '&card_type_id=' + encodeURIComponent(item.id), { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (j) { afterApply(j, item.name); })
            .catch(function (e) { toast('失败：' + (e && e.message ? e.message : e)); render(); });
    }

    function applySet(item) {
        if (!_fetch) { toast('当前环境不支持请求'); return; }
        var act = qs('act_id');
        var lot = qs('lottery_id');
        if (!act) { toast('拿不到 act_id，请在收藏集页面内操作'); return; }
        toast('应用中…');
        _fetch(SG + '/apply-set?act_id=' + encodeURIComponent(act) +
            '&lottery_id=' + encodeURIComponent(lot) +
            '&collect_id=' + encodeURIComponent(item.id), { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.code === -3) {
                    toast('需要 access_key —— 用 Safari 打开 /x/garb/_sg/set-token?access_key=你的令牌');
                    return;
                }
                afterApply(j, item.name);
            })
            .catch(function (e) { toast('失败：' + (e && e.message ? e.message : e)); render(); });
    }

    function reset() {
        if (!_fetch) return;
        _fetch(SG + '/clear', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function () {
                state = null;
                applied = false;
                toast('已还原为真实装扮');
                render();
            })
            .catch(function () { toast('还原失败'); });
    }

    // ── 悬浮按钮拖动 ────────────────────────────────────────
    // 照 Bili-skin 里 mountLauncher 的做法：
    //   元素级 touchstart(passive:true) / touchmove(passive:false) / touchend
    //   按下时先把 right/bottom 换算成 left/top
    //   位移超过 5px 才算拖，才算 preventDefault
    //   松手：拖过就存位置，没拖过就当点击
    var FAB_KEY = 'bili.garb.fabpos';
    var docDragBound = false;
    var fabDrag = { sx: 0, sy: 0, ox: 0, oy: 0, moved: false, dragging: false };

    function fabDown(e) {
        if (!fab) return;
        var t = e.touches ? e.touches[0] : e;
        var r = fab.getBoundingClientRect();
        fabDrag.dragging = true;
        fabDrag.moved = false;
        fabDrag.sx = t.clientX;
        fabDrag.sy = t.clientY;
        fabDrag.ox = r.left;
        fabDrag.oy = r.top;
        // 从 right/bottom 锚定切到 left/top，后面才好直接加减位移
        fab.style.left = r.left + 'px';
        fab.style.top = r.top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    }

    function fabMove(e) {
        if (!fabDrag.dragging || !fab) return;
        var t = e.touches ? e.touches[0] : e;
        var dx = t.clientX - fabDrag.sx;
        var dy = t.clientY - fabDrag.sy;
        if (!fabDrag.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        fabDrag.moved = true;
        if (e.cancelable) e.preventDefault();
        var w = fab.offsetWidth || 52;
        var h = fab.offsetHeight || 52;
        var vw = window.innerWidth || 375;
        var vh = window.innerHeight || 667;
        fab.style.left = Math.min(Math.max(fabDrag.ox + dx, 4), vw - w - 4) + 'px';
        fab.style.top = Math.min(Math.max(fabDrag.oy + dy, 4), vh - h - 4) + 'px';
    }

    function fabUp() {
        if (!fabDrag.dragging) return;
        fabDrag.dragging = false;
        if (!fab) return;
        if (fabDrag.moved) {
            var r = fab.getBoundingClientRect();
            try {
                localStorage.setItem(FAB_KEY, JSON.stringify({
                    left: Math.round(r.left), top: Math.round(r.top)
                }));
            } catch (e) { }
        } else {
            openSheet();
        }
    }

    function bindFabDrag(node) {
        node.addEventListener('touchstart', fabDown, { passive: true });
        node.addEventListener('touchmove', fabMove, { passive: false });
        node.addEventListener('touchend', fabUp);
        node.addEventListener('mousedown', fabDown);
        if (!docDragBound) {
            docDragBound = true;
            document.addEventListener('mousemove', fabMove);
            document.addEventListener('mouseup', fabUp);
        }
    }

    function restoreFab() {
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem(FAB_KEY) || 'null'); } catch (e) { saved = null; }
        if (!saved || saved.left == null) return;
        var w = fab.offsetWidth || 52;
        var h = fab.offsetHeight || 52;
        var vw = window.innerWidth || 375;
        var vh = window.innerHeight || 667;
        fab.style.left = Math.min(Math.max(saved.left, 4), vw - w - 4) + 'px';
        fab.style.top = Math.min(Math.max(saved.top, 4), vh - h - 4) + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    }

    function mount() {
        if (document.getElementById('bg-root')) return;

        var style = el('style');
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);

        fab = el('button', 'bg-fab');
        fab.setAttribute('aria-label', '装扮注入器');
        fab.innerHTML =
            '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" ' +
            'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 2.6l1.85 4.6 4.6 1.85-4.6 1.85L12 15.5l-1.85-4.6L5.55 9.05l4.6-1.85z"/>' +
            '<circle cx="18.2" cy="17.6" r="2.1"/>' +
            '<path d="M5.4 16.4l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z"/>' +
            '</svg>';
        bindFabDrag(fab);

        mask = el('div', 'bg-mask');
        mask.addEventListener('click', closeSheet);

        sheet = el('div', 'bg-sheet');

        var hd = el('div', 'bg-hd');
        hd.appendChild(el('div', 'bg-title', '装扮注入器'));
        var closeBtn = el('button', 'bg-close', '×');
        closeBtn.addEventListener('click', closeSheet);
        hd.appendChild(closeBtn);
        sheet.appendChild(hd);

        statusEl = el('div', 'bg-status off', '读取中…');
        sheet.appendChild(statusEl);

        listEl = el('div', 'bg-list');
        sheet.appendChild(listEl);

        var manual = el('div', 'bg-manual');
        var input = el('input', 'bg-input');
        input.type = 'number';
        input.inputMode = 'numeric';
        input.placeholder = '手动输入 item_id';
        var go = el('button', 'bg-go', '应用');
        go.addEventListener('click', function () {
            var v = String(input.value || '').replace(/\D/g, '');
            if (!v) { toast('先填一个 item_id'); return; }
            applySuit({ id: v, name: '#' + v });
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') go.click();
        });
        manual.appendChild(input);
        manual.appendChild(go);
        sheet.appendChild(manual);

        var ft = el('div', 'bg-ft');
        var rs = el('button', 'bg-reset', '还原真实装扮');
        rs.addEventListener('click', reset);
        ft.appendChild(rs);
        ft.appendChild(el('div', 'bg-hint', '应用后重开 B站 生效'));
        sheet.appendChild(ft);

        toastEl = el('div', 'bg-toast');

        var root = el('div');
        root.id = 'bg-root';
        root.appendChild(mask);
        root.appendChild(sheet);
        root.appendChild(fab);
        root.appendChild(toastEl);
        document.body.appendChild(root);
        restoreFab();

        loadCurrent();
        loadState().then(renderStatus, function () { });

        ['pushState', 'replaceState'].forEach(function (k) {
            var orig = history[k];
            if (typeof orig !== 'function') return;
            history[k] = function () {
                var r = orig.apply(this, arguments);
                setTimeout(function () {
                    if (!document.getElementById('bg-root')) mount();
                    loadCurrent();
                    if (sheet.classList.contains('on')) render();
                }, 420);
                return r;
            };
        });
        window.addEventListener('popstate', function () {
            setTimeout(function () {
                if (!document.getElementById('bg-root')) mount();
                loadCurrent();
                if (sheet.classList.contains('on')) render();
            }, 420);
        });

        setInterval(function () {
            if (sheet.classList.contains('on')) render();
        }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
}

var OVERLAY_JS = '(' + overlayMain.toString() + ')();';

// ─────────────────────────────────────────────────────────────
// §2  mode=inject
// ─────────────────────────────────────────────────────────────

function doInject() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var ct = '';
    for (var k in ($response.headers || {})) {
        if (k.toLowerCase() === 'content-type') ct = $response.headers[k];
    }
    if (!/text\/html/i.test(ct)) return finish({});

    var html = $response.body;
    var tag = '<script>' + OVERLAY_JS + '</scr' + 'ipt>';

    if (html.indexOf('</head>') > -1) {
        html = html.replace('</head>', tag + '</head>');
    } else if (html.indexOf('</body>') > -1) {
        html = html.replace('</body>', tag + '</body>');
    } else {
        return finish({});
    }

    finish({ body: html });
}

// ─────────────────────────────────────────────────────────────
// §3  mode=bridge
// ─────────────────────────────────────────────────────────────

function bridgeReply(obj) {
    var origin = hdr('Origin') || 'https://www.bilibili.com';
    finish({
        response: {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Cache-Control': 'no-store'
            },
            body: JSON.stringify(obj)
        }
    });
}

function queryOf(url, name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(url);
    return m ? decodeURIComponent(m[1]) : '';
}

/** 从 detail/v2 的 item_list 里按 card_type_id 找一张卡 */
function pickCard(detail, cardTypeId) {
    if (!detail || !detail.item_list) return null;
    for (var i = 0; i < detail.item_list.length; i++) {
        var tier = detail.item_list[i];
        var list = tier && tier.card_info_list;
        if (!list) continue;
        for (var j = 0; j < list.length; j++) {
            var info = list[j] && list[j].card_type_info;
            if (!info) continue;
            if (String(info.id) === String(cardTypeId)) return info;
        }
    }
    return null;
}

function doBridgeApplySuit(url) {
    var id = queryOf(url, 'item_id');
    if (!id) return bridgeReply({ code: -1, message: 'missing item_id' });

    req({ url: 'https://api.bilibili.com/x/garb/v2/mall/suit/detail?item_id=' + id })
        .then(function (r) {
            var j;
            try { j = JSON.parse(r.data); } catch (e) {
                return bridgeReply({ code: -1, message: 'detail 解析失败' });
            }
            if (!j || j.code !== 0 || !j.data) {
                return bridgeReply({ code: (j && j.code) || -1, message: (j && j.message) || 'detail 请求失败' });
            }

            var d = j.data;
            writeState(fromDetail(d, d.name));

            var items = d.suit_items || {};
            var sk = firstPart(items.skin);
            var ld = firstPart(items.loading);

            bridgeReply({
                code: 0,
                data: {
                    kind: 'suit',
                    item_id: d.item_id,
                    name: d.name,
                    has_skin: !!(sk && sk.properties && sk.properties.package_url),
                    has_loading: !!(ld && ld.properties && ld.properties.loading_url)
                }
            });
        })
        .catch(function (e) {
            bridgeReply({ code: -1, message: String(e && e.message ? e.message : e) });
        });
}

function doBridgeApplyCard(url) {
    var actId = queryOf(url, 'act_id');
    var lotteryId = queryOf(url, 'lottery_id');
    var cardTypeId = queryOf(url, 'card_type_id');

    if (!actId) return bridgeReply({ code: -1, message: 'missing act_id' });
    if (!cardTypeId) return bridgeReply({ code: -1, message: 'missing card_type_id' });

    // lottery_id 缺失时先解析出来
    var resolveLottery = lotteryId
        ? Promise.resolve(lotteryId)
        : req({ url: 'https://api.bilibili.com/x/vas/dlc_act/act/basic/v2?act_id=' + actId })
            .then(function (r) {
                var j = JSON.parse(r.data);
                var list = (j && j.data && j.data.lottery_list) || [];
                if (!list.length) throw new Error('该活动没有卡池');
                return String(list[0].lottery_id);
            });

    resolveLottery
        .then(function (lot) {
            return req({
                url: 'https://api.bilibili.com/x/vas/dlc_act/lottery/detail/v2?act_id=' +
                    actId + '&lottery_id=' + lot
            }).then(function (r) { return { lot: lot, raw: r.data }; });
        })
        .then(function (o) {
            var j;
            try { j = JSON.parse(o.raw); } catch (e) {
                return bridgeReply({ code: -1, message: 'detail 解析失败' });
            }
            if (!j || j.code !== 0 || !j.data) {
                return bridgeReply({ code: (j && j.code) || -1, message: (j && j.message) || 'detail 请求失败' });
            }

            var info = pickCard(j.data, cardTypeId);
            if (!info) return bridgeReply({ code: -1, message: '该卡池里没有这张卡' });

            // 只换空间背景这一个槽，其他槽位保留 —— 这样卡片可以和装扮混搭
            var cur = readState() || emptyState();
            var sb = info.space_background;
            if (sb) {
                cur.slots.spacebg = {
                    id: info.id,
                    name: info.name || ('卡 #' + info.id),
                    image: sb.image || '',
                    animation: sb.animation || null
                };
            }
            cur.name = info.name || cur.name;
            writeState(cur);

            bridgeReply({
                code: 0,
                data: {
                    kind: 'card',
                    card_type_id: info.id,
                    name: info.name || ('卡 #' + info.id),
                    has_space_bg: looksLikeSpaceBg(info.space_background),
                    has_content: !!(info.content && (info.content.image || info.content.animation)),
                    has_splash: !!(info.splash && info.splash.resource)
                }
            });
        })
        .catch(function (e) {
            bridgeReply({ code: -1, message: String(e && e.message ? e.message : e) });
        });
}

/** 把多个套装部件的 suit_items 合并成一份 */
function mergeSuitItems(target, src) {
    var got = 0;
    for (var k in src) {
        if (!src[k]) continue;
        var v = src[k];
        if (!Array.isArray(v) || !v.length) continue;
        if (!target[k]) target[k] = v;
        else if (Array.isArray(target[k])) target[k] = target[k].concat(v);
        got++;
    }
    return got;
}

/**
 * 按名字去装扮商城搜同名装扮。
 * 文档 docs/garb/lottery.md「装扮/收藏集搜索API」：参数是 key_word，不是 keyword。
 * 收藏集兑换物在文档年代就是普通装扮 item_id，所以这条路对老收藏集有效。
 */
function searchSuitByName(name) {
    if (!name) return Promise.resolve(null);
    var url = 'https://api.bilibili.com/x/garb/v2/mall/home/search?key_word=' +
        encodeURIComponent(name) + '&ps=20&pn=1';
    return req({ url: url })
        .then(function (r) {
            var j;
            try { j = JSON.parse(r.data); } catch (e) { return null; }
            if (!j || j.code !== 0 || !j.data || !j.data.list) return null;

            // 优先 part_id=6 的装扮，item_id 为 0 的是收藏集自己，跳过
            var cands = j.data.list.filter(function (x) {
                return x && Number(x.item_id) > 0;
            });
            cands.sort(function (a, b) {
                var pa = Number(a.part_id) === 6 ? 0 : 1;
                var pb = Number(b.part_id) === 6 ? 0 : 1;
                if (pa !== pb) return pa - pb;
                return Number(a.item_id) < Number(b.item_id) ? 1 : -1;
            });
            return cands.length ? cands : null;
        })
        .catch(function () { return null; });
}

/** 收藏集兑换物：主题套装等，redeem_item_id 是 & 串起来的素材 id */
function doBridgeApplySet(url) {
    var actId = queryOf(url, 'act_id');
    var lotteryId = queryOf(url, 'lottery_id');
    var collectId = queryOf(url, 'collect_id');

    // 给 commit() 用的外层变量
    var hit = null, lotId = '', hitName = '';

    if (!actId) return bridgeReply({ code: -1, message: 'missing act_id' });
    if (!collectId) return bridgeReply({ code: -1, message: 'missing collect_id' });

    var resolveLottery = lotteryId
        ? Promise.resolve(lotteryId)
        : req({ url: 'https://api.bilibili.com/x/vas/dlc_act/act/basic/v2?act_id=' + actId })
            .then(function (r) {
                var j = JSON.parse(r.data);
                var list = (j && j.data && j.data.lottery_list) || [];
                if (!list.length) throw new Error('该活动没有卡池');
                return String(list[0].lottery_id);
            });

    resolveLottery
        .then(function (lot) {
            return req({
                url: 'https://api.bilibili.com/x/vas/dlc_act/lottery/collect_list?act_id=' +
                    actId + '&lottery_id=' + lot
            }).then(function (r) { return { lot: lot, raw: r.data }; });
        })
        .then(function (o) {
            var j;
            try { j = JSON.parse(o.raw); } catch (e) {
                return bridgeReply({ code: -1, message: 'collect_list 解析失败' });
            }
            var infos = (j && j.data && j.data.collect_infos) || [];
            lotId = String(o.lot);
            for (var i = 0; i < infos.length; i++) {
                if (String(infos[i].collect_id) === String(collectId)) { hit = infos[i]; break; }
            }
            if (!hit) return bridgeReply({ code: -1, message: '没找到这个兑换物' });
            hitName = hit.redeem_item_name || ('兑换物 #' + collectId);

            var raw = String(hit.redeem_item_id || '');
            var ids = raw ? raw.split('&').filter(function (x) { return /^\d+$/.test(x); }) : [];

            if (!ids.length) {
                return bridgeReply({
                    code: -1,
                    message: '「' + (hit.redeem_item_name || '该兑换物') + '」没有素材 id，无法解析'
                });
            }

            // 逐个试 suit/detail，能解析出 suit_items 的才并进来
            var merged = {};
            var resolved = 0;
            var chain = Promise.resolve();

            ids.forEach(function (id) {
                chain = chain.then(function () {
                    return req({ url: 'https://api.bilibili.com/x/garb/v2/mall/suit/detail?item_id=' + id })
                        .then(function (r) {
                            var d;
                            try { d = JSON.parse(r.data); } catch (e) { return; }
                            if (!d || d.code !== 0 || !d.data || !d.data.suit_items) return;
                            if (mergeSuitItems(merged, d.data.suit_items) > 0) resolved++;
                        })
                        .catch(function () { });
                });
            });

            return chain.then(function () {
                if (Object.keys(merged).length) {
                    return commit(merged, resolved, ids[0], 'material');
                }

                // 素材 id 解析不出来 —— 回落：按兑换物名字去商城搜同名装扮。
                // 文档年代 redeem_item_id 就是普通装扮 item_id，老收藏集走这条能中。
                return searchSuitByName(hit.redeem_item_name).then(function (cands) {
                    // 公开接口全部失败。13 位素材 id 只有 internal 接口认，
                    // 而那个接口拒 cookie（-403），必须走 appkey+sign+access_key。
                    if (!cands) return signedFallback(ids);

                    var found = {};
                    var n = 0;
                    var c = Promise.resolve();

                    cands.slice(0, 5).forEach(function (cand) {
                        c = c.then(function () {
                            if (n > 0) return;
                            return req({ url: 'https://api.bilibili.com/x/garb/v2/mall/suit/detail?item_id=' + cand.item_id })
                                .then(function (r) {
                                    var d;
                                    try { d = JSON.parse(r.data); } catch (e) { return; }
                                    if (!d || d.code !== 0 || !d.data || !d.data.suit_items) return;
                                    if (mergeSuitItems(found, d.data.suit_items) > 0) {
                                        n = Number(cand.item_id);
                                    }
                                })
                                .catch(function () { });
                        });
                    });

                    return c.then(function () {
                        if (!n) return signedFallback(ids);
                        return commit(found, 1, n, 'search');
                    });
                });
            });
        })
        .catch(function (e) {
            bridgeReply({ code: -1, message: String(e && e.message ? e.message : e) });
        });

    /** 用 access_key 走 APP 签名，直接问 internal 接口 */
    function signedFallback(ids) {
        if (!readToken()) {
            return bridgeReply({
                code: -3,
                message: '需要 access_key',
                data: { set_id: String(collectId), name: hitName, ids: ids }
            });
        }
        var m2 = {}, hit2 = 0;
        var chain2 = Promise.resolve();
        ids.forEach(function (id) {
            chain2 = chain2.then(function () {
                return appGet('/x/garb/internal/v2/mall/suit/detail', { item_id: id })
                    .then(function (r) {
                        var d;
                        try { d = JSON.parse(r.data); } catch (e) { return; }
                        if (!d || d.code !== 0 || !d.data || !d.data.suit_items) return;
                        if (mergeSuitItems(m2, d.data.suit_items) > 0 && !hit2) hit2 = Number(id);
                    })
                    .catch(function () { });
            });
        });
        return chain2.then(function () {
            if (!Object.keys(m2).length) {
                return bridgeReply({ code: -1, message: 'access_key 也解析不出装扮包' });
            }
            return commit(m2, 1, hit2, 'signed');
        });
    }

    /** 收尾：写状态 + 回包 */
    function commit(items, resolved, primaryId, source) {
        var detail = {
            item_id: Number(primaryId),
            name: hitName,
            suit_items: items
        };

        var ns = fromDetail(detail, hitName);
        ns.set_id = String(collectId);
        writeState(ns);

        bridgeReply({
            code: 0,
            data: {
                kind: 'suit',
                set_id: String(collectId),
                item_id: detail.item_id,
                name: detail.name,
                resolved: resolved,
                source: source,
                parts: Object.keys(items),
                has_skin: !!(firstPart(items.skin) && firstPart(items.skin).properties
                    && firstPart(items.skin).properties.package_url)
            }
        });
    }
}

/**
 * 页面把 internal/v2/mall/suit/detail 的结果 POST 过来存下。
 * 13 位素材 id 只有登录态接口认，而登录态只在页面里，所以解析放页面做。
 */
function doBridgeStoreSuit() {
    var raw = (typeof $request !== 'undefined' && $request.body) || '';
    if (!raw) return bridgeReply({ code: -1, message: 'empty body' });

    var p;
    try { p = JSON.parse(raw); } catch (e) {
        return bridgeReply({ code: -1, message: 'body 不是 JSON' });
    }
    if (!p || !p.detail || !p.detail.suit_items) {
        return bridgeReply({ code: -1, message: '没有 suit_items' });
    }

    var keys = Object.keys(p.detail.suit_items);
    if (!keys.length) return bridgeReply({ code: -1, message: 'suit_items 是空的' });

    var name = p.name || p.detail.name || ('套装 #' + p.item_id);

    var ns = fromDetail({
        item_id: Number(p.item_id) || 0,
        name: name,
        suit_items: p.detail.suit_items
    }, name);
    if (p.set_id) ns.set_id = String(p.set_id);
    writeState(ns);

    var sk = firstPart(p.detail.suit_items.skin);
    bridgeReply({
        code: 0,
        data: {
            kind: 'suit',
            set_id: p.set_id ? String(p.set_id) : '',
            item_id: Number(p.item_id) || 0,
            name: name,
            source: 'internal',
            parts: keys,
            has_skin: !!(sk && sk.properties && sk.properties.package_url)
        }
    });
}

/**
 * 收藏集主题套装：直接把资源包里的 user_equip 块存下来。
 * 13 位素材 id 的 package_url 公开接口拿不到，只能靠资源包供给。
 * 接受 {user_equip, load_equip, play_icon} 或裸的 user_equip 对象。
 */
function doBridgeSetEquip(url) {
    var raw = (typeof $request !== 'undefined' && $request.body) || '';
    if (!raw) raw = queryOf(url, 'json');
    if (!raw) return bridgeReply({ code: -1, message: 'missing json' });

    var p;
    try { p = JSON.parse(raw); } catch (e) {
        return bridgeReply({ code: -1, message: 'json 解析失败' });
    }

    var ue = p.user_equip || p;
    if (!ue || ue.id == null || !ue.package_url) {
        return bridgeReply({ code: -1, message: '缺 user_equip.id 或 package_url' });
    }

    var nm = ue.name || ('主题 #' + ue.id);
    var cur = readState() || emptyState();
    cur.slots.skin = { id: ue.id, name: nm, user_equip: ue };
    if (p.load_equip) {
        cur.slots.loading = { id: p.load_equip.id || ue.id, name: p.load_equip.name || nm, load_equip: p.load_equip };
    }
    if (p.play_icon) {
        cur.slots.playicon = { id: p.play_icon.id || ue.id, name: nm, icon: p.play_icon };
    }
    cur.name = nm;
    writeState(cur);
    var st = { name: nm, load_equip: p.load_equip || null, play_icon: p.play_icon || null };

    bridgeReply({
        code: 0,
        data: {
            kind: 'equip',
            id: ue.id,
            name: st.name,
            has_loading: !!st.load_equip,
            has_play_icon: !!st.play_icon
        }
    });
}

/** 只应用某套装里的一个部件，其余槽位保留 —— 混搭的关键 */
function doBridgeApplyPart(url) {
    var id = queryOf(url, 'item_id');
    var slot = queryOf(url, 'slot');
    if (!id) return bridgeReply({ code: -1, message: 'missing item_id' });
    if (SLOTS.indexOf(slot) < 0) return bridgeReply({ code: -1, message: 'bad slot' });

    req({ url: 'https://api.bilibili.com/x/garb/v2/mall/suit/detail?item_id=' + id })
        .then(function (r) {
            var j;
            try { j = JSON.parse(r.data); } catch (e) {
                return bridgeReply({ code: -1, message: 'detail 解析失败' });
            }
            if (!j || j.code !== 0 || !j.data) {
                return bridgeReply({ code: (j && j.code) || -1, message: (j && j.message) || 'detail 请求失败' });
            }

            var full = fromDetail(j.data, j.data.name);
            var picked = full.slots[slot];
            if (!picked) {
                return bridgeReply({
                    code: -1,
                    message: '这套没有' + (SLOT_LABEL[slot] || slot)
                });
            }

            var cur = readState() || emptyState();
            cur.slots[slot] = picked;
            cur.name = picked.name || full.name || cur.name;
            writeState(cur);

            bridgeReply({
                code: 0,
                data: {
                    slot: slot,
                    label: SLOT_LABEL[slot] || slot,
                    name: picked.name || '',
                    count: countSlots(cur)
                }
            });
        })
        .catch(function (e) {
            bridgeReply({ code: -1, message: String(e && e.message ? e.message : e) });
        });
}

function doBridge() {
    var url = (typeof $request !== 'undefined' && $request.url) ? $request.url : '';
    var path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

    if ((typeof $request !== 'undefined' && $request.method) === 'OPTIONS') {
        return bridgeReply({ code: 0 });
    }

    if (path === '/x/garb/_sg/clear') {
        clearState();
        return bridgeReply({ code: 0, data: null });
    }

    if (path === '/x/garb/_sg/state') {
        var st = readState();
        if (!st) return bridgeReply({ code: 0, data: null });
        var slots = {};
        for (var i = 0; i < SLOTS.length; i++) {
            var k = SLOTS[i];
            if (st.slots && st.slots[k]) slots[k] = st.slots[k].name || '';
        }
        return bridgeReply({
            code: 0,
            data: {
                name: st.name || '',
                set_id: st.set_id || '',
                count: countSlots(st),
                slots: slots
            }
        });
    }

    if (path === '/x/garb/_sg/diag') {
        var body = (typeof $request !== 'undefined' && $request.body) || '';
        try { $persistentStore.write(String(body).slice(0, 8000), 'bili.garb.diag'); } catch (e) {}
        return bridgeReply({ code: 0 });
    }

    if (path === '/x/garb/_sg/dump/clear') {
        try { $persistentStore.write(null, CAP_KEY); } catch (e) {}
        try { $persistentStore.write(null, 'bili.garb.diag'); } catch (e) {}
        return bridgeReply({ code: 0, data: [] });
    }

    if (path === '/x/garb/_sg/dump') {
        var arr = capRead();
        var diag = null;
        try {
            var d = $persistentStore.read('bili.garb.diag');
            if (d) diag = JSON.parse(d);
        } catch (e) { diag = null; }
        return bridgeReply({ code: 0, count: arr.length, data: arr, diag: diag });
    }

    if (path === '/x/garb/_sg/set-token') {
        var ak = queryOf(url, 'access_key');
        if (!ak) return bridgeReply({ code: -1, message: 'missing access_key' });
        writeToken(ak);
        return bridgeReply({ code: 0, data: { set: true, masked: ak.slice(0, 6) + '…' + ak.slice(-4) } });
    }

    if (path === '/x/garb/_sg/token-status') {
        var t = readToken();
        return bridgeReply({
            code: 0,
            data: t ? { set: true, masked: t.slice(0, 6) + '…' + t.slice(-4) } : { set: false }
        });
    }

    if (path === '/x/garb/_sg/set-equip') return doBridgeSetEquip(url);
    if (path === '/x/garb/_sg/store-suit') return doBridgeStoreSuit();
    if (path === '/x/garb/_sg/apply-part') return doBridgeApplyPart(url);
    if (path === '/x/garb/_sg/apply-card') return doBridgeApplyCard(url);
    if (path === '/x/garb/_sg/apply-set') return doBridgeApplySet(url);
    if (path === '/x/garb/_sg/apply') return doBridgeApplySuit(url);

    bridgeReply({ code: -1, message: 'unknown bridge path' });
}

// ─────────────────────────────────────────────────────────────
// §4 / §5 / §6 / §7  伪装层 —— 全部按槽位取值
// ─────────────────────────────────────────────────────────────

/** 主题 / 加载动画 / 进度条：都挂在 resource/show/skin 上 */
function doSpoofSkin() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readState();
    if (!st || !st.slots) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data) return finish({});

    var hit = false;
    var s1 = st.slots.skin, s2 = st.slots.loading, s3 = st.slots.playicon;

    if (s1 && s1.user_equip) { body.data.user_equip = s1.user_equip; hit = true; }
    if (s2 && s2.load_equip) { body.data.load_equip = s2.load_equip; hit = true; }
    // show/skin 未必有 play_icon 这个键，但 ObjC 的 JSON 模型会忽略未知键
    if (s3 && s3.icon) { body.data.play_icon = s3.icon; hit = true; }

    if (!hit) return finish({});
    finish({ body: JSON.stringify(body) });
}

/** 只改自己的，别人的名片原样放过 */
function isSelf(obj) {
    var uid = selfUid();
    if (!uid) return true;
    var mid = obj && (obj.mid != null ? obj.mid : (obj.uid != null ? obj.uid : null));
    if (mid == null) return true;
    return String(mid) === String(uid);
}

/** 名片：挂件 + 名字颜色 */
function doSpoofCard() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readState();
    if (!st) return finish({});
    var pd = st.slots && st.slots.pendant;
    var color = st.color || '';
    if (!pd && !color) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data || !body.data.card) return finish({});

    var card = body.data.card;
    if (!isSelf(card)) return finish({});

    var hit = false;
    if (pd && pd.pendant) { card.pendant = pd.pendant; hit = true; }
    if (color) { card.nickname_color = color; hit = true; }

    if (!hit) return finish({});
    finish({ body: JSON.stringify(body) });
}

/** 空间页：按名覆盖 pendant / nickname_color，认不出的键原样放过 */
function doSpoofSpace() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readState();
    if (!st) return finish({});
    var pd = st.slots && st.slots.pendant;
    var color = st.color || '';
    var sbg = st.slots && st.slots.spacebg;
    var layers = (sbg && sbg.layers) ? sbg.layers : null;
    if (!pd && !color && !layers) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data) return finish({});

    var hit = false;
    walkObject(body.data, function (o) {
        if (!isSelf(o)) return;
        if (pd && pd.pendant && o.pendant && typeof o.pendant === 'object' && !Array.isArray(o.pendant)) {
            o.pendant = pd.pendant;
            hit = true;
        }
        if (color && typeof o.nickname_color === 'string' && o.nickname_color) {
            o.nickname_color = color;
            hit = true;
        }
        // 分层空间背景：认 image1_* 这个结构签名
        if (layers && (typeof o.image1_landscape === 'string' || typeof o.image1_portrait === 'string')) {
            for (var k in layers) if (layers[k]) o[k] = layers[k];
            hit = true;
        }
    }, 0);

    if (!hit) return finish({});
    finish({ body: JSON.stringify(body) });
}

/** 空间背景：按结构签名替换，认不出就整包放行 */
function doSpoofSpaceBg() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readState();
    var sbg = st && st.slots && st.slots.spacebg;
    if (!sbg) return finish({});
    if (!sbg.layers && !sbg.image && !looksLikeSpaceBg(sbg)) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data || typeof body.data !== 'object') return finish({});

    var hit = false;

    // 分层形状：响应里出现 image1_* 就当是空间背景，按层覆盖
    if (sbg.layers) {
        walkObject(body.data, function (o) {
            if (typeof o.image1_landscape !== 'string' && typeof o.image1_portrait !== 'string') return;
            for (var k in sbg.layers) {
                if (sbg.layers[k]) o[k] = sbg.layers[k];
            }
            hit = true;
        }, 0);
        if (!hit) return finish({});
        return finish({ body: JSON.stringify(body) });
    }

    // 单图 / 动图形状
    function apply(o) {
        if (sbg.animation) o.animation = sbg.animation;
        if (sbg.image) o.image = sbg.image;
        else if (o.image === undefined) o.image = null;
        hit = true;
    }

    if (looksLikeSpaceBg(body.data)) {
        apply(body.data);
    } else {
        walkObject(body.data, function (o) {
            if (!looksLikeSpaceBg(o)) return;
            apply(o);
        }, 0);
    }

    if (!hit) return finish({});
    finish({ body: JSON.stringify(body) });
}

// ─────────────────────────────────────────────────────────────
// §8  mode=capture —— 抓一次「使用」请求，供人工分析
// ─────────────────────────────────────────────────────────────

var CAP_KEY = 'bili.garb.capture';
var CAP_MAX = 20;
var CAP_BODY_MAX = 4000;

function capRead() {
    try {
        var a = JSON.parse($persistentStore.read(CAP_KEY) || '[]');
        return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
}

function capPath(u) {
    return String(u || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
}

/** 同一个 方法+路径 只留最新一条，避免刷屏 */
function capPush(entry) {
    var p = capPath(entry.url);
    var arr = capRead().filter(function (e) {
        return !(e.m === entry.m && capPath(e.url) === p);
    });
    arr.push(entry);
    while (arr.length > CAP_MAX) arr.shift();
    try { $persistentStore.write(JSON.stringify(arr), CAP_KEY); } catch (e) {}
}

/** csrf 是账号令牌，落盘前抹掉，免得被贴来贴去 */
function redactBody(b) {
    var s = String(b || '');
    s = s.replace(/([?&]|^)(csrf|biliCSRF)=([^&]*)/g, '$1$2=<redacted>');
    s = s.replace(/"(csrf|biliCSRF)"\s*:\s*"[^"]*"/g, '"$1":"<redacted>"');
    if (s.length > CAP_BODY_MAX) s = s.slice(0, CAP_BODY_MAX) + '…(' + s.length + ' bytes)';
    return s;
}

function doCapture() {
    // 自己的桥不抓
    var url = (typeof $request !== 'undefined' && $request.url) ? $request.url : '';
    if (!url || url.indexOf('/_sg/') > -1) return finish({});

    var method = String((typeof $request !== 'undefined' && $request.method) || 'GET').toUpperCase();

    // 读和写都要 —— 「使用」之后 App 很可能紧跟着发一个 GET 去取新的装备状态，
    // 那个 GET 才是解析素材 id 的关键，只记 POST 会漏掉。
    capPush({
        t: new Date().toISOString(),
        m: method,
        url: url,
        body: redactBody((typeof $request !== 'undefined' && $request.body) || '')
    });

    // 原样放行，绝不改动 App 的请求
    finish({});
}

// ─────────────────────────────────────────────────────────────
// §9  mode=fake-unlock —— 诊断用：让收藏集奖励看起来可领取
// ─────────────────────────────────────────────────────────────

/**
 * 收藏集的奖励是「领取」型，没达到条件时按钮只是「进行中0/4」，
 * 点不动，也就走不到素材预览页，抓不到解析请求。
 * 这个模式只改客户端看到的进度数字，让按钮变成可点，
 * 好让人点进去触发那个预览接口。服务端该拒还是拒，不会真发东西。
 *
 * 只在诊断时启用，正常使用请关掉对应的模块。
 */
function doFakeUnlock() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data) return finish({});

    var lists = [];
    if (body.data.collect_infos) lists.push(body.data.collect_infos);
    if (body.data.collect_list && body.data.collect_list.collect_infos) {
        lists.push(body.data.collect_list.collect_infos);
    }
    if (!lists.length) return finish({});

    var changed = 0;
    lists.forEach(function (arr) {
        if (!Array.isArray(arr)) return;
        arr.forEach(function (c) {
            if (!c || typeof c !== 'object') return;
            var need = Number(c.require_item_amount);
            if (!(need > 0)) return;
            if (Number(c.owned_item_amount) >= need) return;

            c.owned_item_amount = need;
            c.redeem_btn_text = '领取';
            changed++;
        });
    });

    if (!changed) return finish({});
    finish({ body: JSON.stringify(body) });
}

// ─────────────────────────────────────────────────────────────
// §10  分发
// ─────────────────────────────────────────────────────────────

(function dispatch() {
    var mode = ARG.mode || '';
    try {
        if (mode === 'inject') doInject();
        else if (mode === 'bridge') doBridge();
        else if (mode === 'capture') doCapture();
        else if (mode === 'spoof-skin') doSpoofSkin();
        else if (mode === 'spoof-card') doSpoofCard();
        else if (mode === 'spoof-space') doSpoofSpace();
        else if (mode === 'spoof-spacebg') doSpoofSpaceBg();
        else if (mode === 'fake-unlock') doFakeUnlock();
        else finish({});
    } catch (e) {
        finish({});
    }
})();
