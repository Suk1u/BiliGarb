/**
 * BiliGarb — B站装扮注入器 / Surge 模块脚本
 *
 * 单一文件，五种模式，靠 argument=mode=xxx 分发：
 *   inject       http-response  在装扮 H5 外壳 HTML 里注入悬浮按钮与选择器
 *   bridge       http-request   截获页面发来的魔法 URL，落盘所选装扮
 *   spoof-skin   http-response  改写 resource/show/skin → 主题色 + 加载动画
 *   spoof-card   http-response  改写 web-interface/card → 挂件 + 名字颜色
 *   spoof-space  http-response  改写 space 系列 → 按名覆盖
 *
 * 无外部依赖。不需要 WBI / appkey / access_key —— 我们只改写 App 自己
 * 发出的请求的响应，签名由 App 自己算。
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
        var o = {
            'auto-cookie': false,
            timeout: 12,
            headers: HEADERS
        };
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
        return (o && o.detail) ? o : null;
    } catch (e) { return null; }
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
    for (var k in h) {
        if (k.toLowerCase() === lower) return h[k];
    }
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

// ─────────────────────────────────────────────────────────────
// §1  注入页面里的那段代码（自包含，不可引用外部变量）
// ─────────────────────────────────────────────────────────────

function overlayMain() {
    if (window.__BILI_GARB_UI__) return;
    window.__BILI_GARB_UI__ = true;

    var SG = 'https://api.bilibili.com/x/garb/_sg';
    var REG = {};        // id -> {id, name, cover, part}
    var ORDER = [];      // 保持发现顺序
    var state = { item_id: '', name: '' };
    var applied = false;

    // ── 数据吸收 ────────────────────────────────────────────
    function put(node) {
        var raw = node.item_id;
        if (typeof raw !== 'number' && typeof raw !== 'string') return;
        var id = String(raw);
        if (!id || id === '0') return;

        var p = (node.properties && typeof node.properties === 'object') ? node.properties : {};
        var name = node.name || node.group_name || '';
        var cover = p.image_cover || p.image_preview || p.image || p.image_preview_small || '';
        if (!name && !cover) return;

        if (!REG[id]) ORDER.push(id);
        REG[id] = {
            id: id,
            name: String(name || ('#' + id)),
            cover: String(cover || ''),
            part: (typeof node.part_id === 'number') ? node.part_id : null
        };
    }

    function walk(node, depth) {
        if (!node || depth > 8) return;
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
            return;
        }
        if (typeof node !== 'object') return;
        if (Object.prototype.hasOwnProperty.call(node, 'item_id')) put(node);
        for (var k in node) {
            var v = node[k];
            if (v && typeof v === 'object') walk(v, depth + 1);
        }
    }

    function absorbText(t) {
        if (!t || typeof t !== 'string') return;
        if (t.length > 4000000) return;
        if (t.indexOf('item_id') < 0) return;
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

    // ── 当前页装扮 ──────────────────────────────────────────
    function qs(k) {
        var m = new RegExp('[?&]' + k + '=([^&#]*)').exec(location.href);
        return m ? decodeURIComponent(m[1]) : '';
    }

    function loadCurrent() {
        var id = qs('id');
        if (!id || !_fetch) return;
        _fetch('https://api.bilibili.com/x/garb/v2/mall/suit/detail?item_id=' +
            encodeURIComponent(id), { credentials: 'include' })
            .then(function (r) { return r.text(); })
            .then(absorbText)
            .catch(function () { });
    }

    function loadState() {
        if (!_fetch) return Promise.resolve();
        return _fetch(SG + '/state', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.code === 0 && j.data) {
                    state = j.data;
                    applied = true;
                }
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
        'max-height:72vh;display:flex;flex-direction:column;overflow:hidden;',
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
        '.bg-row{display:flex;align-items:center;gap:12px;padding:9px 6px;border-radius:12px}',
        '.bg-row:active{background:#f6f7f9}',
        '.bg-row.cur{background:#fff1f5}',
        '.bg-thumb{width:46px;height:46px;border-radius:10px;object-fit:cover;',
        'background:#eef0f3;flex:0 0 auto}',
        '.bg-meta{flex:1 1 auto;min-width:0}',
        '.bg-name{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.bg-sub{font-size:11.5px;color:#9499a0;margin-top:2px}',
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

    function partLabel(part) {
        var M = { 1: '头像框', 2: '动态卡片', 3: '点赞效果', 4: '表情', 5: '表情包', 6: '装扮主', 7: '空间背景', 8: '勋章', 9: '主题', 10: '加载动画', 11: '进度条', 13: 'NFT' };
        return (part != null && M[part]) ? M[part] : (part != null ? ('part ' + part) : '');
    }

    function renderStatus() {
        if (!statusEl) return;
        if (applied && state && state.name) {
            statusEl.className = 'bg-status';
            statusEl.textContent = '当前应用：' + state.name +
                (state.item_id ? '（#' + state.item_id + '）' : '');
        } else {
            statusEl.className = 'bg-status off';
            statusEl.textContent = '未应用任何装扮 · 点下方任一行开始';
        }
    }

    function row(item) {
        var r = el('div', 'bg-row');
        if (applied && state && String(state.item_id) === String(item.id)) r.className = 'bg-row cur';

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
        var sub = '#' + item.id + (item.part != null ? ' · ' + partLabel(item.part) : '');
        meta.appendChild(el('div', 'bg-sub', sub));
        r.appendChild(meta);

        var isCur = applied && state && String(state.item_id) === String(item.id);
        var btn = el('button', 'bg-apply' + (isCur ? ' done' : ''), isCur ? '使用中' : '应用');
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (isCur) return;
            apply(item.id, item.name);
        });
        r.appendChild(btn);
        return r;
    }

    function render() {
        if (!listEl) return;
        renderStatus();

        var ids = ORDER.slice();
        var cur = qs('id');
        if (cur && REG[cur]) {
            ids = [cur].concat(ids.filter(function (x) { return x !== cur; }));
        }

        listEl.innerHTML = '';
        if (!ids.length) {
            listEl.appendChild(el('div', 'bg-empty',
                '本页还没抓到装扮数据。\n往上滑一滑让页面加载列表，或在下方直接输入 item_id。'));
            return;
        }
        for (var i = 0; i < ids.length && i < 200; i++) {
            if (REG[ids[i]]) listEl.appendChild(row(REG[ids[i]]));
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

    function apply(id, name) {
        if (!_fetch) { toast('当前环境不支持请求'); return; }
        toast('应用中…');
        _fetch(SG + '/apply?item_id=' + encodeURIComponent(id), { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.code === 0) {
                    state = j.data || { item_id: id, name: name };
                    applied = true;
                    toast('已应用：' + (state.name || name) + '　重开 B站 生效');
                } else {
                    toast('失败：' + ((j && j.message) || '未知错误'));
                }
                render();
            })
            .catch(function (e) {
                toast('失败：' + (e && e.message ? e.message : e));
                render();
            });
    }

    function reset() {
        if (!_fetch) return;
        _fetch(SG + '/clear', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function () {
                state = { item_id: '', name: '' };
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
            apply(v, '#' + v);
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

        // 首屏吸收 + 状态同步
        loadCurrent();
        loadState().then(renderStatus, function () { });

        // 跨路由存活
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

        // 兜底：页面自己滚动加载新数据时，抽屉开着就跟着刷新
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
        return bridgeReply({
            code: 0,
            data: st ? { item_id: st.item_id, name: st.name } : null
        });
    }

    if (/\/apply$/.test(path)) {
        var m = /[?&]item_id=(\d+)/.exec(url);
        if (!m) return bridgeReply({ code: -1, message: 'missing item_id' });

        var id = m[1];
        req({ url: 'https://api.bilibili.com/x/garb/v2/mall/suit/detail?item_id=' + id })
            .then(function (r) {
                var j;
                try { j = JSON.parse(r.data); } catch (e) {
                    return bridgeReply({ code: -1, message: 'detail 解析失败' });
                }
                if (!j || j.code !== 0 || !j.data) {
                    return bridgeReply({
                        code: (j && j.code) || -1,
                        message: (j && j.message) || 'detail 请求失败'
                    });
                }

                var d = j.data;
                writeState({
                    item_id: d.item_id,
                    name: d.name,
                    detail: d,
                    at: Date.now()
                });

                var items = d.suit_items || {};
                var hasSkin = !!(firstPart(items.skin) && firstPart(items.skin).properties);
                var hasLoad = !!(firstPart(items.loading) && firstPart(items.loading).properties);

                bridgeReply({
                    code: 0,
                    data: {
                        item_id: d.item_id,
                        name: d.name,
                        has_skin: hasSkin,
                        has_loading: hasLoad
                    }
                });
            })
            .catch(function (e) {
                bridgeReply({ code: -1, message: String(e && e.message ? e.message : e) });
            });
        return;
    }

    bridgeReply({ code: -1, message: 'unknown bridge path' });
}

// ─────────────────────────────────────────────────────────────
// §4  mode=spoof-skin
// ─────────────────────────────────────────────────────────────

function doSpoofSkin() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readState();
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

/** 从已存 detail 里抽出可复用的三个伪装块 */
function spoofParts(st) {
    var items = (st.detail && st.detail.suit_items) || {};
    var out = { pendant: null, nameplate: null, color: '' };

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
    if (sk && sk.properties) {
        if (sk.properties.color) out.color = sk.properties.color;
    }
    return out;
}

/** 只改自己：能从 Cookie 拿到 uid 时，别人的名片原样放过 */
function isSelf(obj) {
    var uid = selfUid();
    if (!uid) return true;
    var mid = obj && (obj.mid != null ? obj.mid : (obj.uid != null ? obj.uid : null));
    if (mid == null) return true;
    return String(mid) === String(uid);
}

function doSpoofCard() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readState();
    if (!st) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data || !body.data.card) return finish({});

    var card = body.data.card;
    if (!isSelf(card)) return finish({});

    var parts = spoofParts(st);
    var changed = false;

    if (parts.pendant) {
        card.pendant = parts.pendant;
        changed = true;
    }
    if (parts.color) {
        card.nickname_color = parts.color;
        changed = true;
    }

    if (!changed) return finish({});
    finish({ body: JSON.stringify(body) });
}

function doSpoofSpace() {
    if (typeof $response === 'undefined' || !$response.body) return finish({});

    var st = readState();
    if (!st) return finish({});

    var body;
    try { body = JSON.parse($response.body); } catch (e) { return finish({}); }
    if (!body || !body.data) return finish({});

    var parts = spoofParts(st);
    if (!parts.pendant && !parts.color) return finish({});

    var changed = false;

    walkObject(body.data, function (o) {
        if (!isSelf(o)) return;

        if (parts.pendant &&
            o.pendant && typeof o.pendant === 'object' && !Array.isArray(o.pendant)) {
            o.pendant = parts.pendant;
            changed = true;
        }
        if (parts.color &&
            typeof o.nickname_color === 'string' && o.nickname_color) {
            o.nickname_color = parts.color;
            changed = true;
        }
    }, 0);

    if (!changed) return finish({});
    finish({ body: JSON.stringify(body) });
}

// ─────────────────────────────────────────────────────────────
// §7  分发
// ─────────────────────────────────────────────────────────────

(function dispatch() {
    var mode = ARG.mode || '';
    try {
        if (mode === 'inject') doInject();
        else if (mode === 'bridge') doBridge();
        else if (mode === 'spoof-skin') doSpoofSkin();
        else if (mode === 'spoof-card') doSpoofCard();
        else if (mode === 'spoof-space') doSpoofSpace();
        else finish({});
    } catch (e) {
        finish({});
    }
})();
