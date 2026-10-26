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

function readState() {
    try {
        var s = $persistentStore.read(STORE_KEY);
        if (!s) return null;
        var o = JSON.parse(s);
        if (!o) return null;
        if (o.kind === 'card') return o.card ? o : null;
        return o.detail ? o : null;
    } catch (e) { return null; }
}

/** 只要装扮态；收藏集态返回 null */
function readSuitState() {
    var s = readState();
    return (s && s.kind !== 'card' && s.detail) ? s : null;
}

function writeState(o) {
    try { $persistentStore.write(JSON.stringify(o), STORE_KEY); } catch (e) {}
}

function clearState() {
    try { $persistentStore.write(null, STORE_KEY); } catch (e) {}
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
        '.bg-fab{position:fixed;right:16px;bottom:calc(26px + env(safe-area-inset-bottom,0px));',
        'width:52px;height:52px;border-radius:50%;background:#FB7299;border:none;padding:0;margin:0;',
        'display:flex;align-items:center;justify-content:center;cursor:pointer;',
        'box-shadow:0 6px 20px rgba(251,114,153,.42);z-index:2147483646;',
        'transition:transform .15s ease,box-shadow .15s ease;-webkit-tap-highlight-color:transparent}',
        '.bg-fab:active{transform:scale(.92);box-shadow:0 3px 10px rgba(251,114,153,.36)}',

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

    function renderStatus() {
        if (!statusEl) return;
        if (applied && state && state.name) {
            statusEl.className = 'bg-status';
            statusEl.textContent = '当前应用：' + state.name +
                (state.kind === 'card' ? '（收藏集）' : '（装扮）');
        } else {
            statusEl.className = 'bg-status off';
            statusEl.textContent = '未应用任何装扮 · 点下方任一行开始';
        }
    }

    function curKey() {
        if (!applied || !state) return '';
        if (state.set_id) return 'set:' + state.set_id;
        if (state.kind === 'card') return 'card:' + state.card_type_id;
        return 'suit:' + state.item_id;
    }

    function row(item) {
        var key = item.kind + ':' + item.id;
        var isCur = curKey() === key;

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
            state = j.data || null;
            applied = !!state;
            toast('已应用：' + ((state && state.name) || fallbackName) + '　重开 B站 生效');
        } else {
            toast('失败：' + ((j && j.message) || '未知错误'));
        }
        render();
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

    function mergeLocal(dst, src) {
        var n = 0;
        for (var k in src) {
            var v = src[k];
            if (!v) continue;
            if (!Array.isArray(v) || !v.length) continue;
            dst[k] = dst[k] ? dst[k].concat(v) : v;
            n++;
        }
        return n;
    }

    /**
     * 13 位素材 id 只有登录态接口认（x/garb/internal/v2/mall/suit/detail），
     * 而登录态只在页面里，所以解析必须在这边做，做完再 POST 给桥接落盘。
     */
    function resolveInternal(ctx) {
        var merged = {};
        var hitId = 0;
        var ids = (ctx && ctx.ids) || [];
        var i = 0;

        function step() {
            if (i >= ids.length) {
                if (!Object.keys(merged).length) return Promise.resolve(null);
                var pid = hitId || Number(ids[0]) || 0;
                return Promise.resolve({
                    set_id: ctx.set_id,
                    name: ctx.name,
                    item_id: pid,
                    detail: { item_id: pid, name: ctx.name, suit_items: merged }
                });
            }
            var id = ids[i++];
            return _fetch('https://api.bilibili.com/x/garb/internal/v2/mall/suit/detail?item_id=' +
                encodeURIComponent(id) + '&part=&from=&from_id=', { credentials: 'include' })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    var d = j && j.code === 0 && j.data;
                    if (d && d.suit_items) {
                        if (mergeLocal(merged, d.suit_items) > 0 && !hitId) hitId = Number(id);
                    }
                    return step();
                })
                .catch(function () { return step(); });
        }
        return step();
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
                if (j && j.code === -2 && j.data && j.data.ids) {
                    toast('换登录态接口重试…');
                    return resolveInternal(j.data).then(function (res) {
                        if (!res) { toast('这套拿不到装扮包'); render(); return; }
                        // 不设 Content-Type，浏览器按 text/plain 发 → 简单请求，不触发预检
                        return _fetch(SG + '/store-suit', {
                            method: 'POST',
                            credentials: 'include',
                            body: JSON.stringify(res)
                        })
                            .then(function (r2) { return r2.json(); })
                            .then(function (j2) { afterApply(j2, item.name); });
                    });
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
        fab.addEventListener('click', openSheet);

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

        loadCurrent();
        loadState().then(renderStatus, function () { });

        ['pushState', 'replaceState'].forEach(function (k) {
            var orig = history[k];
            if (typeof orig !== 'function') return;
            history[k] = function () {
                var r = orig.apply(this, arguments);
                setTimeout(function () { loadCurrent(); if (sheet.classList.contains('on')) render(); }, 420);
                return r;
            };
        });
        window.addEventListener('popstate', function () {
            setTimeout(function () { loadCurrent(); if (sheet.classList.contains('on')) render(); }, 420);
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
            writeState({ kind: 'suit', item_id: d.item_id, name: d.name, detail: d, at: Date.now() });

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

            writeState({
                kind: 'card',
                act_id: Number(actId) || actId,
                lottery_id: Number(o.lot) || o.lot,
                card_type_id: info.id,
                name: info.name || ('卡 #' + info.id),
                act_title: j.data.name || '',
                card: info,
                at: Date.now()
            });

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
                    if (!cands) {
                        // 公开接口全部失败。13 位素材 id 只有登录态的内部接口认，
                        // 交给页面（带 cookie）去试 internal/v2/mall/suit/detail。
                        return bridgeReply({
                            code: -2,
                            message: '需要登录态接口解析',
                            data: {
                                set_id: String(collectId),
                                name: hitName,
                                act_id: actId,
                                lottery_id: lotId,
                                ids: ids
                            }
                        });
                    }

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
                        if (!n) {
                            return bridgeReply({
                                code: -2,
                                message: '搜到同名装扮但拿不到装扮包，改走登录态接口',
                                data: {
                                    set_id: String(collectId),
                                    name: hitName,
                                    act_id: actId,
                                    lottery_id: lotId,
                                    ids: ids
                                }
                            });
                        }
                        return commit(found, 1, n, 'search');
                    });
                });
            });
        })
        .catch(function (e) {
            bridgeReply({ code: -1, message: String(e && e.message ? e.message : e) });
        });

    /** 收尾：写状态 + 回包 */
    function commit(items, resolved, primaryId, source) {
        var detail = {
            item_id: Number(primaryId),
            name: hitName,
            suit_items: items
        };

        writeState({
            kind: 'suit',
            set_id: String(collectId),
            item_id: detail.item_id,
            name: detail.name,
            detail: detail,
            act_id: Number(actId) || actId,
            lottery_id: Number(lotId) || lotId,
            at: Date.now()
        });

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

    writeState({
        kind: 'suit',
        set_id: p.set_id ? String(p.set_id) : '',
        item_id: Number(p.item_id) || 0,
        name: name,
        detail: {
            item_id: Number(p.item_id) || 0,
            name: name,
            suit_items: p.detail.suit_items
        },
        source: 'internal',
        at: Date.now()
    });

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
        return bridgeReply({
            code: 0,
            data: st.kind === 'card'
                ? { kind: 'card', card_type_id: st.card_type_id, name: st.name }
                : { kind: 'suit', item_id: st.item_id, name: st.name, set_id: st.set_id || '' }
        });
    }

    if (path === '/x/garb/_sg/dump/clear') {
        try { $persistentStore.write(null, CAP_KEY); } catch (e) {}
        return bridgeReply({ code: 0, data: [] });
    }

    if (path === '/x/garb/_sg/dump') {
        var arr = capRead();
        return bridgeReply({ code: 0, count: arr.length, data: arr });
    }

    if (path === '/x/garb/_sg/store-suit') return doBridgeStoreSuit();
    if (path === '/x/garb/_sg/apply-card') return doBridgeApplyCard(url);
    if (path === '/x/garb/_sg/apply-set') return doBridgeApplySet(url);
    if (path === '/x/garb/_sg/apply') return doBridgeApplySuit(url);

    bridgeReply({ code: -1, message: 'unknown bridge path' });
}

// ─────────────────────────────────────────────────────────────
// §4  mode=spoof-skin
// ─────────────────────────────────────────────────────────────

function doSpoofSkin() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readSuitState();
    if (!st) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data) return finish({});

    var items = (st.detail && st.detail.suit_items) || {};
    var sk = firstPart(items.skin);
    var ld = firstPart(items.loading);
    var changed = false;

    if (sk && sk.properties) {
        var p = sk.properties;
        if (p.package_url) {
            body.data.user_equip = {
                id: sk.item_id,
                name: st.detail.name || st.name || '',
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
            changed = true;
        }
    }

    if (ld && ld.properties && ld.properties.loading_url) {
        var q = ld.properties;
        body.data.load_equip = {
            id: ld.item_id,
            name: ld.name || '',
            ver: Number(q.ver) || 0,
            loading_url: q.loading_url
        };
        changed = true;
    }

    if (!changed) return finish({});
    finish({ body: JSON.stringify(body) });
}

// ─────────────────────────────────────────────────────────────
// §5 / §6  名片与空间页的按名覆盖
// ─────────────────────────────────────────────────────────────

function spoofParts(st) {
    var items = (st.detail && st.detail.suit_items) || {};
    var out = { pendant: null, color: '' };

    var pd = firstPart(items.pendant);
    if (pd && pd.properties && pd.properties.image) {
        out.pendant = {
            pid: pd.item_id,
            name: pd.name || '',
            image: pd.properties.image,
            expire: 0,
            image_enhance: pd.properties.image_enhance || pd.properties.image,
            image_enhance_frame: pd.properties.image_enhance_frame || '',
            n_pid: pd.item_id
        };
    }

    var sk = firstPart(items.skin);
    if (sk && sk.properties && sk.properties.color) out.color = sk.properties.color;
    return out;
}

function isSelf(obj) {
    var uid = selfUid();
    if (!uid) return true;
    var mid = obj && (obj.mid != null ? obj.mid : (obj.uid != null ? obj.uid : null));
    if (mid == null) return true;
    return String(mid) === String(uid);
}

function doSpoofCard() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readSuitState();
    if (!st) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data || !body.data.card) return finish({});

    var card = body.data.card;
    if (!isSelf(card)) return finish({});

    var parts = spoofParts(st);
    var changed = false;

    if (parts.pendant) { card.pendant = parts.pendant; changed = true; }
    if (parts.color) { card.nickname_color = parts.color; changed = true; }

    if (!changed) return finish({});
    finish({ body: JSON.stringify(body) });
}

function doSpoofSpace() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readSuitState();
    if (!st) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data) return finish({});

    var parts = spoofParts(st);
    if (!parts.pendant && !parts.color) return finish({});

    var changed = false;
    walkObject(body.data, function (o) {
        if (!isSelf(o)) return;
        if (parts.pendant && o.pendant && typeof o.pendant === 'object' && !Array.isArray(o.pendant)) {
            o.pendant = parts.pendant;
            changed = true;
        }
        if (parts.color && typeof o.nickname_color === 'string' && o.nickname_color) {
            o.nickname_color = parts.color;
            changed = true;
        }
    }, 0);

    if (!changed) return finish({});
    finish({ body: JSON.stringify(body) });
}

// ─────────────────────────────────────────────────────────────
// §7  mode=spoof-spacebg —— 收藏集卡片的空间背景
// ─────────────────────────────────────────────────────────────

function doSpoofSpaceBg() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readState();
    if (!st || st.kind !== 'card' || !st.card) return finish({});

    var sb = st.card.space_background;
    if (!looksLikeSpaceBg(sb)) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data || typeof body.data !== 'object') return finish({});

    var changed = false;

    if (looksLikeSpaceBg(body.data)) {
        // 顶层就是背景本体
        body.data.image = sb.image || body.data.image || null;
        body.data.animation = sb.animation;
        changed = true;
    } else {
        walkObject(body.data, function (o) {
            if (!looksLikeSpaceBg(o)) return;
            o.image = sb.image || o.image || null;
            o.animation = sb.animation;
            changed = true;
        }, 0);
    }

    if (!changed) return finish({});
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
