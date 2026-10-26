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
    var ORDER = [];      // [{k:'suit'|'card', id}]，保持发现顺序
    var state = null;    // {kind, item_id|card_type_id, name}
    var applied = false;

    // ── 数据吸收 ────────────────────────────────────────────
    function push(kind, id, item) {
        var store = kind === 'card' ? CARD : SUIT;
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

    function walk(node, depth) {
        if (!node || depth > 8) return;
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
            return;
        }
        if (typeof node !== 'object') return;

        // 装扮：item_id
        if (Object.prototype.hasOwnProperty.call(node, 'item_id')) putSuit(node);

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
            t.indexOf('card_type_info') < 0) return;
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
        }
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
        sub.appendChild(el('span', 'bg-tag' + (item.kind === 'card' ? ' card' : ''),
            item.kind === 'card' ? '收藏集' : '装扮'));
        var tail = '#' + item.id;
        if (item.kind === 'suit' && item.part != null) {
            tail += ' · ' + (PART_LABEL[item.part] || ('part ' + item.part));
        }
        sub.appendChild(document.createTextNode(tail));
        meta.appendChild(sub);
        r.appendChild(meta);

        var btn = el('button', 'bg-apply' + (isCur ? ' done' : ''), isCur ? '使用中' : '应用');
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (isCur) return;
            if (item.kind === 'card') applyCard(item);
            else applySuit(item);
        });
        r.appendChild(btn);
        return r;
    }

    function render() {
        if (!listEl) return;
        renderStatus();

        var suits = [], cards = [];
        for (var i = 0; i < ORDER.length; i++) {
            var o = ORDER[i];
            if (o.k === 'card') { if (CARD[o.id]) cards.push(CARD[o.id]); }
            else { if (SUIT[o.id]) suits.push(SUIT[o.id]); }
        }

        // 当前页的装扮排最前
        var pid = qs('id');
        if (pid && SUIT[pid]) {
            suits = [SUIT[pid]].concat(suits.filter(function (x) { return x.id !== pid; }));
        }

        listEl.innerHTML = '';
        if (!suits.length && !cards.length) {
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

function doBridge() {
    var url = (typeof $request !== 'undefined' && $request.url) ? $request.url : '';
    var path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

    if ((typeof $request !== 'undefined' && $request.method) === 'OPTIONS') {
        return bridgeReply({ code: 0 });
    }

    if (/\/clear$/.test(path)) {
        clearState();
        return bridgeReply({ code: 0, data: null });
    }

    if (/\/state$/.test(path)) {
        var st = readState();
        if (!st) return bridgeReply({ code: 0, data: null });
        return bridgeReply({
            code: 0,
            data: st.kind === 'card'
                ? { kind: 'card', card_type_id: st.card_type_id, name: st.name }
                : { kind: 'suit', item_id: st.item_id, name: st.name }
        });
    }

    if (/\/apply-card$/.test(path)) return doBridgeApplyCard(url);
    if (/\/apply$/.test(path)) return doBridgeApplySuit(url);

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
// §8  分发
// ─────────────────────────────────────────────────────────────

(function dispatch() {
    var mode = ARG.mode || '';
    try {
        if (mode === 'inject') doInject();
        else if (mode === 'bridge') doBridge();
        else if (mode === 'spoof-skin') doSpoofSkin();
        else if (mode === 'spoof-card') doSpoofCard();
        else if (mode === 'spoof-space') doSpoofSpace();
        else if (mode === 'spoof-spacebg') doSpoofSpaceBg();
        else finish({});
    } catch (e) {
        finish({});
    }
})();
