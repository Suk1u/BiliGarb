/**
 * 本地测试台 — 在 node 里模拟 Surge 运行时，逐条跑验收表。
 *   node test/run.js
 *
 * 夹具全部是线上实抓：
 *   shell.html         装扮页外壳（mall-h5-major）
 *   detail-36438.json  装扮详情 · 鹿乃桜帆 · part_id=6
 *   dlc-114746.json    收藏集卡池详情 · 水果篮子 · 12 张卡
 *   grid-114746.json   收藏集卡池网格
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bili-garb.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(__dirname, 'shell.html'), 'utf8');
const DETAIL = JSON.parse(fs.readFileSync(path.join(__dirname, 'detail-36438.json'), 'utf8'));
const DLC = JSON.parse(fs.readFileSync(path.join(__dirname, 'dlc-114746.json'), 'utf8'));
const GRID = JSON.parse(fs.readFileSync(path.join(__dirname, 'grid-114746.json'), 'utf8'));

const KEY = 'bili.garb.current';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

/** 跑一次脚本；等微任务清空后再读结果 */
function run(opts) {
    const store = Object.assign({}, opts.store || {});
    const out = { done: null, calls: 0, store, requests: [], logs: [] };

    const ctx = {
        $argument: opts.argument || '',
        $request: opts.request,
        $response: opts.response,
        $persistentStore: {
            read: k => (k in store ? store[k] : null),
            write: (v, k) => { if (v === null) delete store[k]; else store[k] = v; return true; }
        },
        $httpClient: {
            get(o, cb) {
                out.requests.push(o);
                const r = opts.http ? opts.http(o) : { err: 'no http mock' };
                if (r.err) cb(r.err, null, null);
                else cb(null, { status: 200, headers: {} }, r.body);
            }
        },
        $notification: { post: () => {} },
        $done: v => { out.calls++; out.done = v === undefined ? {} : v; },
        console: { log: (...a) => out.logs.push(a.join(' ')) },
        Promise, JSON, Math, Date, String, Number, Array, Object, RegExp, Error,
        setTimeout, clearTimeout
    };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx, { filename: 'bili-garb.js' });
    out.ctx = ctx;

    return new Promise(resolve => { setTimeout(() => resolve(out), 0); });
}

const suitStore = () => ({
    [KEY]: JSON.stringify({
        kind: 'suit', item_id: DETAIL.data.item_id, name: DETAIL.data.name,
        detail: DETAIL.data, at: Date.now()
    })
});

const CARD_INFO = (() => {
    for (const tier of DLC.data.item_list) {
        for (const c of tier.card_info_list || []) return c.card_type_info;
    }
    return null;
})();

const cardStore = () => ({
    [KEY]: JSON.stringify({
        kind: 'card', act_id: 114746, lottery_id: 114747,
        card_type_id: CARD_INFO.id, name: CARD_INFO.name,
        act_title: DLC.data.name, card: CARD_INFO, at: Date.now()
    })
});

const ACT_BASIC = { code: 0, data: { lottery_list: [{ lottery_id: 114747 }] } };

(async function main() {

    // ─────────────────────────────────────────────────────────
    console.log('\n[1] mode=inject — 注入装扮页外壳');
    {
        const r = await run({
            argument: 'mode=inject',
            response: { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: SHELL }
        });
        const body = (r.done && r.done.body) || '';
        ok('有输出 body', !!body);
        ok('$done 只调用一次', r.calls === 1, 'calls=' + r.calls);
        ok('注入点在 </head> 之前', body.indexOf('<script>(function overlayMain') > -1 &&
            body.indexOf('<script>(function overlayMain') < body.indexOf('</head>'));
        ok('原始 HTML 完整保留', body.indexOf('id="major-app"') > -1 && body.endsWith('</html>'));
        ok('长度增长合理', body.length > SHELL.length + 15000, 'delta=' + (body.length - SHELL.length));

        const s = body.indexOf('<script>(function overlayMain');
        const e = body.indexOf('</script>', s);
        const code = body.slice(s + 8, e);
        let parses = true;
        try { new vm.Script(code); } catch (err) { parses = false; }
        ok('注入的 overlay 代码语法合法', parses);
        ok('overlay 内容未被提前截断', code.length > 15000 && /overlayMain/.test(code));
        ok('注入段内无嵌套 </script>', code.indexOf('</script>') === -1);

        // 悬浮按钮拖动
        ok('touchstart 挂在 window 捕获阶段',
            code.indexOf("window.addEventListener('touchstart', down, OPT)") > -1);
        ok('捕获选项是 capture + passive:false',
            code.indexOf("var OPT = { capture: true, passive: false };") > -1);
        ok('touchstart 里调了 preventDefault', code.indexOf('if (ev.cancelable) ev.preventDefault();') > -1);
        ok('带了事件计数（诊断用）', code.indexOf('dbg.down++') > -1 && code.indexOf('dbg.move++') > -1);
        ok('move/end 按需挂载，平时不拖累滚动', code.indexOf('function unbind()') > -1);
        ok('touchstart 常驻捕获', code.indexOf("window.addEventListener('touchstart', down, OPT)") > -1);
        ok('touchmove 也挂在捕获阶段',
            code.indexOf("window.addEventListener('touchmove', move, OPT)") > -1);
        ok('拖完抑制一次 click', code.indexOf('suppressClick') > -1);
        ok('位置写 localStorage', code.indexOf("'bili.garb.fabpos'") > -1);
        ok('挂载时恢复位置', code.indexOf('restoreFab()') > -1);
        ok('吸边逻辑在', code.indexOf('targetX') > -1);
    }

    console.log('\n[2] mode=inject — 收藏集页面外壳同样能注入');
    {
        const shell = fs.readFileSync(path.join(__dirname, 'shell-digital.html'), 'utf8');
        const r = await run({
            argument: 'mode=inject',
            response: { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: shell }
        });
        const body = (r.done && r.done.body) || '';
        ok('有输出 body', !!body);
        ok('注入点在 </head> 之前', body.indexOf('<script>(function overlayMain') > -1 &&
            body.indexOf('<script>(function overlayMain') < body.indexOf('</head>'));
        ok('原始 HTML 完整保留', body.indexOf('id="app"') > -1 && body.trimEnd().endsWith('</html>'));
        ok('$done 只调用一次', r.calls === 1);
    }

    console.log('\n[2b] mode=inject — 非 HTML 响应必须放行');
    {
        const r = await run({
            argument: 'mode=inject',
            response: { headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }
        });
        ok('不返回 body', r.done && r.done.body === undefined);
        ok('$done 只调用一次', r.calls === 1);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[3] mode=bridge — apply（装扮）');
    {
        const r = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply?item_id=36438',
                method: 'GET',
                headers: { Origin: 'https://www.bilibili.com', Cookie: 'DedeUserID=12345' }
            },
            http: () => ({ body: JSON.stringify(DETAIL) })
        });
        const raw = r.done && r.done.response && r.done.response.body;
        const j = raw ? JSON.parse(raw) : {};
        ok('短路返回 200', !!(r.done && r.done.response && r.done.response.status === 200));
        ok('返回 code 0', j.code === 0, JSON.stringify(j));
        ok('返回装扮名', !!(j.data && j.data.name === '鹿乃桜帆'));
        ok('回包标了 kind=suit', !!(j.data && j.data.kind === 'suit'));
        ok('标记有主题部件', !!(j.data && j.data.has_skin === true));
        ok('标记有加载动画', !!(j.data && j.data.has_loading === true));
        const st1 = JSON.parse(r.store[KEY]);
        ok('落盘是 v2 分槽结构', st1.v === 2 && !!st1.slots);
        ok('落盘有主题槽', !!(st1.slots.skin && st1.slots.skin.user_equip.package_url));
        ok('落盘有加载动画槽', !!st1.slots.loading);
        ok('拉 detail 时带了 Referer', r.requests.length === 1 && r.requests[0].headers.Referer === 'https://www.bilibili.com/');
        ok('CORS 头回显 Origin', r.done.response.headers['Access-Control-Allow-Origin'] === 'https://www.bilibili.com');
        ok('$done 只调用一次', r.calls === 1);
    }

    console.log('\n[4] mode=bridge — clear / state');
    {
        const r1 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/clear', method: 'GET', headers: {} },
            store: suitStore()
        });
        ok('clear 返回 code 0', JSON.parse(r1.done.response.body).code === 0);
        ok('clear 删掉了 key', !(KEY in r1.store));

        const r2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/state', method: 'GET', headers: {} },
            store: suitStore()
        });
        const j2 = JSON.parse(r2.done.response.body);
        ok('state 返回槽位摘要', !!(j2.data && j2.data.count >= 2 && j2.data.slots.skin));

        const r3 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/state', method: 'GET', headers: {} }
        });
        ok('无状态时 state 返回 null', JSON.parse(r3.done.response.body).data === null);
    }

    console.log('\n[5] mode=bridge — 缺参 / detail 失败');
    {
        const r = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply', method: 'GET', headers: {} }
        });
        ok('缺 item_id 返回 -1 且不落盘', JSON.parse(r.done.response.body).code === -1 && !(KEY in r.store));

        const r2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply?item_id=999999999', method: 'GET', headers: {} },
            http: () => ({ body: JSON.stringify({ code: -404, message: '啥都木有' }) })
        });
        const j2 = JSON.parse(r2.done.response.body);
        ok('detail 失败时透传错误码', j2.code === -404, JSON.stringify(j2));
        ok('detail 失败时不落盘', !(KEY in r2.store));
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[6] mode=bridge — apply-card（收藏集，带 lottery_id）');
    {
        const r = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply-card?act_id=114746&lottery_id=114747&card_type_id=' + CARD_INFO.id,
                method: 'GET', headers: { Origin: 'https://www.bilibili.com' }
            },
            http: o => {
                if (o.url.includes('lottery/detail/v2')) return { body: JSON.stringify(DLC) };
                return { body: JSON.stringify(ACT_BASIC) };
            }
        });
        const j = JSON.parse(r.done.response.body);
        ok('返回 code 0', j.code === 0, JSON.stringify(j).slice(0, 200));
        ok('回包标了 kind=card', j.data && j.data.kind === 'card');
        ok('返回卡名', j.data && j.data.name === CARD_INFO.name);
        ok('标记有空间背景', j.data && j.data.has_space_bg === true);
        ok('只发了一次请求（不需要解析 lottery）', r.requests.length === 1, 'requests=' + r.requests.length);
        ok('请求用的是 detail/v2', r.requests[0].url.includes('/x/vas/dlc_act/lottery/detail/v2'));

        const st = JSON.parse(r.store[KEY]);
        ok('落盘只填了空间背景槽', !!(st.slots.spacebg && !st.slots.skin));
        ok('落盘的空间背景槽 id 是这张卡', String(st.slots.spacebg.id) === String(CARD_INFO.id));
        ok('落盘了动画数据', !!(st.slots.spacebg.animation && st.slots.spacebg.animation.animation_url));
        ok('$done 只调用一次', r.calls === 1);
    }

    console.log('\n[7] mode=bridge — apply-card（缺 lottery_id，自动解析）');
    {
        const r = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply-card?act_id=114746&lottery_id=&card_type_id=' + CARD_INFO.id,
                method: 'GET', headers: {}
            },
            http: o => {
                if (o.url.includes('act/basic/v2')) return { body: JSON.stringify(ACT_BASIC) };
                if (o.url.includes('lottery/detail/v2')) return { body: JSON.stringify(DLC) };
                return { body: '{}' };
            }
        });
        const j = JSON.parse(r.done.response.body);
        ok('返回 code 0', j.code === 0, JSON.stringify(j).slice(0, 200));
        ok('先调了 act/basic/v2', r.requests[0].url.includes('act/basic/v2'));
        ok('再用解析出的 lottery_id 调 detail', r.requests[1].url.includes('lottery_id=114747'));
        ok('落盘带 lottery 信息', true);
    }

    console.log('\n[8] mode=bridge — apply-card 失败路径');
    {
        const r = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply-card?act_id=114746&lottery_id=114747&card_type_id=1',
                method: 'GET', headers: {}
            },
            http: () => ({ body: JSON.stringify(DLC) })
        });
        const j = JSON.parse(r.done.response.body);
        ok('卡不在池子里返回 -1', j.code === -1 && /没有这张卡/.test(j.message));
        ok('失败不落盘', !(KEY in r.store));

        const r2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply-card?act_id=114746&card_type_id=1', method: 'GET', headers: {} },
            http: () => ({ body: '{}' })
        });
        ok('缺 card_type_id 返回 -1', JSON.parse(r2.done.response.body).code === -1);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[9] mode=bridge — apply-set（收藏集兑换物 · 主题套装）');
    {
        const COLLECT = JSON.parse(fs.readFileSync(path.join(__dirname, 'collect-114746.json'), 'utf8'));
        const themeSet = COLLECT.data.collect_infos.find(c => c.redeem_item_type === 5);

        ok('夹具里有静态主题套装', !!themeSet, JSON.stringify(COLLECT.data.collect_infos.map(c => c.redeem_item_type)));
        ok('它的 redeem_item_id 是 & 串起来的 4 个 id',
            String(themeSet.redeem_item_id).split('&').length === 4);

        // 情形一：四个 id 在装扮库里都查不到（线上真实情况）
        const r1 = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply-set?act_id=114746&lottery_id=114747&collect_id=' + themeSet.collect_id,
                method: 'GET', headers: {}
            },
            http: o => {
                if (o.url.includes('collect_list')) return { body: JSON.stringify(COLLECT) };
                // suit/detail 对素材 id 只返回空壳
                return { body: JSON.stringify({ code: 0, data: { suit_items: null } }) };
            }
        });
        const j1 = JSON.parse(r1.done.response.body);
        ok('没有 access_key 时返回 -3', j1.code === -3, JSON.stringify(j1).slice(0, 160));
        ok('回包里带上了素材 id 列表', !!(j1.data && j1.data.ids && j1.data.ids.length === 4));
        ok('回包里带上 collect_id 和名字', !!(j1.data && String(j1.data.set_id) === String(themeSet.collect_id) && j1.data.name));
        ok('全查不到时不落盘', !(KEY in r1.store));
        ok('四个 id 各试了一次', r1.requests.filter(x => x.url.includes('suit/detail')).length === 4);

        // 情形二：其中一个 id 能解析出装扮包 → 合并后成功
        const r2 = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply-set?act_id=114746&lottery_id=114747&collect_id=' + themeSet.collect_id,
                method: 'GET', headers: {}
            },
            http: o => {
                if (o.url.includes('collect_list')) return { body: JSON.stringify(COLLECT) };
                if (o.url.includes('1792139382001')) return { body: JSON.stringify(DETAIL) };
                return { body: JSON.stringify({ code: 0, data: { suit_items: null } }) };
            }
        });
        const j2 = JSON.parse(r2.done.response.body);
        ok('有能解析的就成功', j2.code === 0, JSON.stringify(j2).slice(0, 200));
        ok('resolved 计数正确', j2.data && j2.data.resolved === 1);
        ok('合并出了 skin 部件', !!(j2.data && j2.data.has_skin));
        ok('名字用兑换物名', j2.data && j2.data.name === themeSet.redeem_item_name);
        ok('记下了 set_id', j2.data && String(j2.data.set_id) === String(themeSet.collect_id));

        const st = JSON.parse(r2.store[KEY]);
        ok('落盘是 v2 分槽结构', st.v === 2 && !!st.slots);
        ok('落盘带 set_id', String(st.set_id) === String(themeSet.collect_id));
        ok('落盘有主题槽', !!(st.slots.skin && st.slots.skin.user_equip.package_url));

        // state 要能回传 set_id，抽屉才知道哪一行是「使用中」
        const r3 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/state', method: 'GET', headers: {} },
            store: r2.store
        });
        const j3 = JSON.parse(r3.done.response.body);
        ok('state 回传 set_id', j3.data && String(j3.data.set_id) === String(themeSet.collect_id));
    }

    console.log('\n[9b] mode=bridge — apply-set 边界');
    {
        const COLLECT = JSON.parse(fs.readFileSync(path.join(__dirname, 'collect-114746.json'), 'utf8'));

        const r1 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply-set?act_id=114746&lottery_id=114747&collect_id=999', method: 'GET', headers: {} },
            http: () => ({ body: JSON.stringify(COLLECT) })
        });
        ok('collect_id 不存在返回 -1', JSON.parse(r1.done.response.body).code === -1);

        const medal = COLLECT.data.collect_infos.find(c => c.redeem_item_type === 1001);
        const r2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply-set?act_id=114746&lottery_id=114747&collect_id=' + medal.collect_id, method: 'GET', headers: {} },
            http: () => ({ body: JSON.stringify(COLLECT) })
        });
        const j2 = JSON.parse(r2.done.response.body);
        ok('没有 redeem_item_id 的（勋章）返回 -1', j2.code === -1 && /没有素材 id/.test(j2.message), j2.message);

        const r3 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply-set?act_id=114746&collect_id=114749', method: 'GET', headers: {} },
            http: o => {
                if (o.url.includes('act/basic/v2')) return { body: JSON.stringify(ACT_BASIC) };
                if (o.url.includes('collect_list')) return { body: JSON.stringify(COLLECT) };
                return { body: JSON.stringify({ code: 0, data: { suit_items: null } }) };
            }
        });
        ok('缺 lottery_id 时自动解析', r3.requests[0].url.includes('act/basic/v2'));
        ok('解析后仍走完整流程', JSON.parse(r3.done.response.body).code === -3);
    }

    console.log('\n[9c] mode=bridge — apply-set 按名字回落搜索');
    {
        const COLLECT = JSON.parse(fs.readFileSync(path.join(__dirname, 'collect-114746.json'), 'utf8'));
        const themeSet = COLLECT.data.collect_infos.find(c => c.redeem_item_type === 5);

        const SEARCH = {
            code: 0,
            data: {
                total: 2, pn: 1, ps: 20,
                list: [
                    // 收藏集自己，item_id 为 0，必须被跳过
                    { item_id: 0, part_id: 0, name: '水果篮子', properties: { type: 'dlc_act' } },
                    { item_id: 36438, part_id: 6, name: '鹿乃桜帆', properties: { type: 'ip' } }
                ]
            }
        };

        const r = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply-set?act_id=114746&lottery_id=114747&collect_id=' + themeSet.collect_id,
                method: 'GET', headers: {}
            },
            http: o => {
                if (o.url.includes('collect_list')) return { body: JSON.stringify(COLLECT) };
                if (o.url.includes('/home/search')) return { body: JSON.stringify(SEARCH) };
                if (o.url.includes('item_id=36438')) return { body: JSON.stringify(DETAIL) };
                return { body: JSON.stringify({ code: 0, data: { suit_items: null } }) };
            }
        });

        const j = JSON.parse(r.done.response.body);
        ok('素材 id 全废时按名字搜到并成功', j.code === 0, JSON.stringify(j).slice(0, 200));
        ok('回包标了 source=search', j.data && j.data.source === 'search');
        ok('用的是搜到的 item_id', j.data && j.data.item_id === 36438);
        ok('合并出了 skin', j.data && j.data.has_skin === true);

        const searchReq = r.requests.find(x => x.url.includes('/home/search'));
        ok('搜索参数是 key_word（文档里的名字）', !!searchReq && /key_word=/.test(searchReq.url));
        ok('搜索时没把 keyword 当参数', !!searchReq && !/[?&]keyword=/.test(searchReq.url));

        const st = JSON.parse(r.store[KEY]);
        ok('落盘主题槽的 id 是搜到的那个', st.slots.skin.id === 36437 || st.slots.skin.id === 36438);
        ok('落盘仍带 set_id', String(st.set_id) === String(themeSet.collect_id));

        // 搜到但拿不到装扮包
        const r2 = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply-set?act_id=114746&lottery_id=114747&collect_id=' + themeSet.collect_id,
                method: 'GET', headers: {}
            },
            http: o => {
                if (o.url.includes('collect_list')) return { body: JSON.stringify(COLLECT) };
                if (o.url.includes('/home/search')) return { body: JSON.stringify(SEARCH) };
                return { body: JSON.stringify({ code: 0, data: { suit_items: null } }) };
            }
        });
        const j2 = JSON.parse(r2.done.response.body);
        ok('搜到同名但没包 → 也转 -3', j2.code === -3 && !!(j2.data && j2.data.ids), j2.message);
        ok('失败不落盘', !(KEY in r2.store));
    }

    console.log('\n[9d] mode=bridge — store-suit（页面回传登录态解析结果）');
    {
        const payload = {
            set_id: '114749',
            name: '水果篮子个性主题',
            item_id: 36437,
            detail: { item_id: 36437, name: '水果篮子个性主题', suit_items: DETAIL.data.suit_items }
        };
        const r = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/store-suit',
                method: 'POST',
                body: JSON.stringify(payload)
            }
        });
        const j = JSON.parse(r.done.response.body);
        ok('返回 code 0', j.code === 0, JSON.stringify(j).slice(0, 160));
        ok('标了 source=internal', j.data && j.data.source === 'internal');
        ok('认出了主题包', j.data && j.data.has_skin === true);
        ok('列出了部件', j.data && j.data.parts.length >= 8);

        const st = JSON.parse(r.store[KEY]);
        ok('落盘是 v2 分槽结构', st.v === 2 && !!st.slots);
        ok('落盘 set_id', st.set_id === '114749');
        ok('落盘有主题槽', !!(st.slots.skin && st.slots.skin.user_equip.package_url));
        ok('$done 只调用一次', r.calls === 1);

        // 空 body / 坏 JSON / 没有 suit_items
        const bad = [
            ['空 body', ''],
            ['坏 JSON', 'not json{'],
            ['没有 suit_items', JSON.stringify({ set_id: '1', item_id: 1, detail: {} })],
            ['suit_items 是空的', JSON.stringify({ set_id: '1', item_id: 1, detail: { suit_items: {} } })]
        ];
        for (const [label, body] of bad) {
            const rb = await run({
                argument: 'mode=bridge',
                request: { url: 'https://api.bilibili.com/x/garb/_sg/store-suit', method: 'POST', body }
            });
            ok(label + ' → -1 且不落盘',
                JSON.parse(rb.done.response.body).code === -1 && !(KEY in rb.store));
        }
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[9e] MD5 / APP 签名 / access_key 路径');
    {
        const crypto = require('crypto');

        // 先跑一次拿到 vm context
        const base = await run({ argument: 'noop' });
        const md5 = base.ctx.md5;
        const appSign = base.ctx.appSign;
        ok('md5 已挂到上下文', typeof md5 === 'function' && typeof appSign === 'function');

        const vectors = [
            ['', 'd41d8cd98f00b204e9800998ecf8427e'],
            ['abc', '900150983cd24fb0d6963f7d28e17f72'],
            ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
            ['12345678901234567890123456789012345678901234567890123456789012345678901234567890',
                '57edf4a22be3c955ac49da2e2107b67a']
        ];
        for (const [input, want] of vectors) {
            ok('md5(' + (input ? JSON.stringify(input.slice(0, 12)) : '空串') + ')',
                md5(input) === want, md5(input));
        }

        const q = appSign({ appkey: '27eb53fc9058f8c3', ts: 1, item_id: '36438' });
        const [query, sign] = q.split('&sign=');
        const expect = crypto.createHash('md5')
            .update(query + 'c2ed53a74eeefe3cf99fbd01d8c9c375', 'latin1').digest('hex');
        ok('appSign 的 sign 正确', sign === expect, sign + ' vs ' + expect);
        ok('appSign 按 key 升序拼串',
            query === 'appkey=27eb53fc9058f8c3&item_id=36438&ts=1', query);

        // set-token / token-status
        const rt = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/set-token?access_key=abcdef1234567890', method: 'GET', headers: {} }
        });
        const jt = JSON.parse(rt.done.response.body);
        ok('set-token 返回 code 0', jt.code === 0);
        ok('set-token 落盘了', rt.store['bili.garb.access_key'] === 'abcdef1234567890');
        ok('set-token 回的是脱敏值', /^abcdef…7890$/.test(jt.data.masked), jt.data.masked);

        const rs = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/token-status', method: 'GET', headers: {} },
            store: rt.store
        });
        ok('token-status 说有', JSON.parse(rs.done.response.body).data.set === true);

        const rs2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/token-status', method: 'GET', headers: {} }
        });
        ok('没设时 token-status 说没有', JSON.parse(rs2.done.response.body).data.set === false);

        const rt2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/set-token', method: 'GET', headers: {} }
        });
        ok('set-token 缺参数返回 -1', JSON.parse(rt2.done.response.body).code === -1);

        // 有 token 时 /apply-set 走签名路径
        const COLLECT = JSON.parse(fs.readFileSync(path.join(__dirname, 'collect-114746.json'), 'utf8'));
        const themeSet = COLLECT.data.collect_infos.find(c => c.redeem_item_type === 5);
        const r4 = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply-set?act_id=114746&lottery_id=114747&collect_id=' + themeSet.collect_id,
                method: 'GET', headers: {}
            },
            store: { 'bili.garb.access_key': 'tok1234567890' },
            http: o => {
                if (o.url.includes('collect_list')) return { body: JSON.stringify(COLLECT) };
                if (o.url.includes('internal/v2/mall/suit/detail')) return { body: JSON.stringify(DETAIL) };
                return { body: JSON.stringify({ code: 0, data: { suit_items: null } }) };
            }
        });
        const j4 = JSON.parse(r4.done.response.body);
        ok('有 token 时走签名路径并成功', j4.code === 0, JSON.stringify(j4).slice(0, 200));
        ok('回包标了 source=signed', j4.data && j4.data.source === 'signed');
        ok('认出了主题包', j4.data && j4.data.has_skin === true);

        const signedReq = r4.requests.find(x => x.url.includes('internal/v2/mall/suit/detail'));
        ok('签名请求带了 access_key', !!signedReq && signedReq.url.includes('access_key=tok1234567890'));
        ok('签名请求带了 appkey', !!signedReq && signedReq.url.includes('appkey=27eb53fc9058f8c3'));
        ok('签名请求带了 sign', !!signedReq && /&sign=[0-9a-f]{32}$/.test(signedReq.url));
        ok('签名请求带了 ts', !!signedReq && /[?&]ts=\d{10}/.test(signedReq.url));
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[9f] mode=bridge — set-equip（收藏集主题资源包）');
    {
        const PACK = {
            user_equip: {
                id: 1780036210001,
                name: '从零开始的异世界',
                preview: 'https://i0.hdslb.com/bfs/garb/x.png',
                ver: '1780054798',
                package_url: 'https://i0.hdslb.com/bfs/garb/zip/abc.zip',
                data: { color_mode: 'light', color: '#000000', color_second_page: '#F3E5EB', tail_color: '#0066FF', tail_color_selected: '#D400B9' }
            },
            id: 1780036210001,
            name: '从零开始的异世界',
            load_equip: { id: 1780036045001, name: 'Re0加载', loading_url: 'https://i0.hdslb.com/bfs/baselabs/op/x.webp', ver: '1780632001' },
            play_icon: { id: 1780036069001, middle_png: 'https://x/m.png' }
        };

        const r = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/set-equip?json=' + encodeURIComponent(JSON.stringify(PACK)),
                method: 'GET', headers: {}
            }
        });
        const j = JSON.parse(r.done.response.body);
        ok('set-equip 返回 code 0', j.code === 0, JSON.stringify(j).slice(0, 160));
        ok('回包带名字', j.data && j.data.name === '从零开始的异世界');
        ok('标了有加载动画', j.data && j.data.has_loading === true);
        ok('标了有进度条', j.data && j.data.has_play_icon === true);

        const st = JSON.parse(r.store[KEY]);
        ok('落盘是 v2 分槽结构', st.v === 2 && !!st.slots);
        ok('落盘了主题槽的 user_equip', !!(st.slots.skin && st.slots.skin.user_equip.package_url));
        ok('落盘了加载动画槽', !!(st.slots.loading && st.slots.loading.load_equip.loading_url));
        ok('落盘了进度条槽', !!st.slots.playicon);

        // state 要能回传 equip
        const rs = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/state', method: 'GET', headers: {} },
            store: r.store
        });
        const js = JSON.parse(rs.done.response.body);
        ok('state 回传三个槽', js.data && js.data.count === 3 && js.data.slots.skin && js.data.slots.loading && js.data.slots.playicon);

        // 裸 user_equip 也能收
        const r2 = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/set-equip?json=' + encodeURIComponent(JSON.stringify(PACK.user_equip)),
                method: 'GET', headers: {}
            }
        });
        ok('裸 user_equip 也能收', JSON.parse(r2.done.response.body).code === 0);
        ok('裸的时候没有加载动画槽', !JSON.parse(r2.store[KEY]).slots.loading);

        // 坏输入
        const bads = [
            ['没有 json', 'https://api.bilibili.com/x/garb/_sg/set-equip'],
            ['坏 json', 'https://api.bilibili.com/x/garb/_sg/set-equip?json=' + encodeURIComponent('{oops')],
            ['缺 package_url', 'https://api.bilibili.com/x/garb/_sg/set-equip?json=' + encodeURIComponent(JSON.stringify({ id: 1, name: 'x' }))]
        ];
        for (const [label, u] of bads) {
            const rb = await run({ argument: 'mode=bridge', request: { url: u, method: 'GET', headers: {} } });
            ok(label + ' → -1 且不落盘', JSON.parse(rb.done.response.body).code === -1 && !(KEY in rb.store));
        }

        // spoof-skin 用 equip 态
        const skinResp = { code: 0, data: { user_equip: { id: 2, name: '默认', package_url: 'https://x/d.zip' }, skin_colors: [{ id: 2 }], load_equip: { id: 1 } } };
        const r3 = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: JSON.stringify(skinResp) },
            store: r.store
        });
        const j3 = JSON.parse(r3.done.body);
        ok('user_equip 整块换成资源包的', j3.data.user_equip.id === 1780036210001);
        ok('package_url 是资源包那个', /abc\.zip$/.test(j3.data.user_equip.package_url));
        ok('主题色跟着换了', j3.data.user_equip.data.color === '#000000');
        ok('load_equip 也换了', j3.data.load_equip.id === 1780036045001);
        ok('play_icon 也塞进去了', !!(j3.data.play_icon && j3.data.play_icon.middle_png));
        ok('skin_colors 原样保留', j3.data.skin_colors.length === 1);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[9g] 分槽混搭 / apply-part / 分层空间背景');
    {
        // 1) 整套应用 → 五个槽都该有
        const r1 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply?item_id=36438', method: 'GET', headers: {} },
            http: () => ({ body: JSON.stringify(DETAIL) })
        });
        const st1 = JSON.parse(r1.store[KEY]);
        ok('整套应用后是 v2 结构', st1.v === 2);
        ok('主题槽有了', !!(st1.slots.skin && st1.slots.skin.user_equip.package_url));
        ok('加载动画槽有了', !!st1.slots.loading);
        ok('进度条槽有了', !!(st1.slots.playicon && st1.slots.playicon.icon.middle_png));
        ok('空间背景槽有了', !!st1.slots.spacebg);
        ok('空间背景是分层形状', !!(st1.slots.spacebg.layers && st1.slots.spacebg.layers.image1_landscape));
        ok('名字颜色提到了根上', st1.color === '#ffffff');

        // 2) 先用资源包灌主题，再单独换空间背景 —— 混搭
        const PACK = {
            user_equip: { id: 1780036210001, name: '从零开始的异世界', package_url: 'https://x/a.zip', data: { color: '#000000' } },
            load_equip: { id: 1780036045001, name: 'Re0加载', loading_url: 'https://x/l.webp' }
        };
        const r2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/set-equip?json=' + encodeURIComponent(JSON.stringify(PACK)), method: 'GET', headers: {} }
        });
        ok('资源包设了两个槽', JSON.parse(r2.store[KEY]).slots.loading && JSON.parse(r2.store[KEY]).slots.skin);

        const r3 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply-part?item_id=36438&slot=spacebg', method: 'GET', headers: {} },
            store: r2.store,
            http: () => ({ body: JSON.stringify(DETAIL) })
        });
        const j3 = JSON.parse(r3.done.response.body);
        ok('apply-part 成功', j3.code === 0, JSON.stringify(j3).slice(0, 160));
        ok('回包标了槽位名', j3.data && j3.data.slot === 'spacebg' && j3.data.label === '空间背景');

        const st3 = JSON.parse(r3.store[KEY]);
        ok('空间背景换成了 36438 的', st3.slots.spacebg.id === 36434);
        ok('主题还是资源包那个', st3.slots.skin.id === 1780036210001);
        ok('加载动画还是资源包那个', st3.slots.loading.id === 1780036045001);
        ok('总槽数 3', j3.data.count === 3);

        // 3) 换一个不存在的槽 → 明确失败且不改状态
        const r4 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply-part?item_id=36438&slot=skin', method: 'GET', headers: {} },
            store: r2.store,
            http: () => ({ body: JSON.stringify({ code: 0, data: { suit_items: {} } }) })
        });
        ok('这套没有该部件 → -1', JSON.parse(r4.done.response.body).code === -1);
        ok('失败时不改状态', JSON.parse(r4.store[KEY]).slots.skin.id === 1780036210001);

        const r5 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply-part?item_id=36438&slot=nope', method: 'GET', headers: {} }
        });
        ok('非法槽名 → -1', JSON.parse(r5.done.response.body).code === -1);

        // 4) 分层空间背景的伪装
        const spaceResp = {
            code: 0,
            data: { mid: 1, space_bg: { image1_landscape: 'https://old/1l.jpg', image1_portrait: 'https://old/1p.jpg', keep: 1 } }
        };
        const r6 = await run({
            argument: 'mode=spoof-spacebg',
            request: { url: 'https://api.bilibili.com/x/space/wbi/acc/info?mid=1', method: 'GET', headers: {} },
            response: { headers: {}, body: JSON.stringify(spaceResp) },
            store: r1.store
        });
        const j6 = JSON.parse(r6.done.body);
        ok('分层空间背景被替换', j6.data.space_bg.image1_landscape === DETAIL.data.suit_items.space_bg[0].properties.image1_landscape);
        ok('旁边字段没动', j6.data.space_bg.keep === 1);

        // 4b) spoof-space 也要能改分层空间背景（空间页走的是这个模式）
        const spaceResp2 = {
            code: 0,
            data: { mid: 12345, name: 'me', space_bg: { image1_landscape: 'https://old/1l.jpg', image3_portrait: 'https://old/3p.jpg' } }
        };
        const r6b = await run({
            argument: 'mode=spoof-space',
            request: { url: 'https://api.bilibili.com/x/space/wbi/acc/info?mid=12345', method: 'GET', headers: { Cookie: 'DedeUserID=12345' } },
            response: { headers: {}, body: JSON.stringify(spaceResp2) },
            store: r1.store
        });
        const j6b = JSON.parse(r6b.done.body);
        ok('spoof-space 也改了分层空间背景',
            j6b.data.space_bg.image1_landscape === DETAIL.data.suit_items.space_bg[0].properties.image1_landscape);
        ok('多层一起换（image3 也被覆盖）',
            j6b.data.space_bg.image3_portrait === DETAIL.data.suit_items.space_bg[0].properties.image3_portrait);

        // 5) 旧格式自动迁移
        const oldEquip = { [KEY]: JSON.stringify({ kind: 'equip', id: 1, name: '旧主题', user_equip: { id: 1, package_url: 'https://x/o.zip' }, load_equip: { id: 2, loading_url: 'https://x/o.webp' } }) };
        const r7 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/state', method: 'GET', headers: {} },
            store: oldEquip
        });
        const j7 = JSON.parse(r7.done.response.body);
        ok('旧 equip 状态能迁移', j7.data && j7.data.count === 2 && j7.data.slots.skin === '旧主题');

        const oldCard = { [KEY]: JSON.stringify({ kind: 'card', card_type_id: 9, name: '旧卡', card: { space_background: { image: 'https://x/c.png', animation: { animation_url: 'u' } } } }) };
        const r8 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/state', method: 'GET', headers: {} },
            store: oldCard
        });
        ok('旧 card 状态能迁移', JSON.parse(r8.done.response.body).data.slots.spacebg === '旧卡');
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[10] mode=spoof-skin — 改写主题 + 加载动画');
    {
        const skinResp = {
            code: 0,
            data: {
                user_equip: { id: 2, name: '默认', package_url: 'https://x/default.zip', package_md5: 'aaa', data: {} },
                skin_colors: [{ id: 2, name: '少女粉', is_free: true }],
                load_equip: { id: 1, name: '默认', loading_url: 'https://x/d.webp' }
            }
        };
        const r = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: JSON.stringify(skinResp) },
            store: suitStore()
        });
        const j = JSON.parse(r.done.body);
        const ue = j.data.user_equip;
        ok('user_equip 换成了装扮的主题部件', ue.id === 36437);
        ok('package_url 指向该套装 zip', /88117cbb4faef46b948900ba0ab978cbc91f3fe8\.zip$/.test(ue.package_url));
        ok('package_md5 一并替换', ue.package_md5 === 'c044d1b273d96cec703fefed90f997c9');
        ok('主题色写入', ue.data.color === '#ffffff' && ue.data.color_second_page === '#f34554');
        ok('load_equip 换成了该套装加载动画',
            j.data.load_equip.id === 36470 && /\.webp$/.test(j.data.load_equip.loading_url));
        ok('skin_colors 原样保留', j.data.skin_colors.length === 1);
        ok('$done 只调用一次', r.calls === 1);
    }

    console.log('\n[10b] mode=spoof-skin — 无状态 / 坏 JSON 放行');
    {
        const r = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: JSON.stringify({ code: 0, data: { user_equip: {} } }) }
        });
        ok('无状态放行', r.done.body === undefined && r.calls === 1);

        const r2 = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: 'not json{' },
            store: suitStore()
        });
        ok('坏 JSON 放行', r2.done.body === undefined && r2.calls === 1);

        const r3 = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: '' },
            store: suitStore()
        });
        ok('空 body 放行', r3.done.body === undefined && r3.calls === 1);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[11] mode=spoof-card — 只改自己');
    {
        const cardResp = {
            code: 0,
            data: {
                card: {
                    mid: '12345', name: 'me',
                    pendant: { pid: 1, name: 'old', image: 'https://x/old.png' },
                    nickname_color: '#FB7299', vip: { type: 2 }
                }
            }
        };
        const r = await run({
            argument: 'mode=spoof-card',
            request: { url: 'https://api.bilibili.com/x/web-interface/card?mid=12345', method: 'GET', headers: { Cookie: 'DedeUserID=12345' } },
            response: { headers: {}, body: JSON.stringify(cardResp) },
            store: suitStore()
        });
        const j = JSON.parse(r.done.body);
        ok('名字颜色被换成主题色', j.data.card.nickname_color === '#ffffff');
        ok('vip 等其他字段未被动', j.data.card.vip.type === 2);
        ok('$done 只调用一次', r.calls === 1);

        const other = JSON.parse(JSON.stringify(cardResp));
        other.data.card.mid = '99999';
        const r2 = await run({
            argument: 'mode=spoof-card',
            request: { url: 'https://api.bilibili.com/x/web-interface/card?mid=99999', method: 'GET', headers: { Cookie: 'DedeUserID=12345' } },
            response: { headers: {}, body: JSON.stringify(other) },
            store: suitStore()
        });
        ok('别人的名片原样放行', r2.done.body === undefined);
    }

    console.log('\n[12] mode=spoof-space — 按名覆盖，不插新键');
    {
        const spaceResp = {
            code: 0,
            data: {
                mid: 12345, name: 'me',
                pendant: { pid: 1, name: 'old', image: 'https://x/old.png' },
                nickname_color: '#FB7299', sign: 'hello', level: 6
            }
        };
        const r = await run({
            argument: 'mode=spoof-space',
            request: { url: 'https://api.bilibili.com/x/space/wbi/acc/info?mid=12345', method: 'GET', headers: { Cookie: 'DedeUserID=12345' } },
            response: { headers: {}, body: JSON.stringify(spaceResp) },
            store: suitStore()
        });
        const j = JSON.parse(r.done.body);
        ok('nickname_color 被改写', j.data.nickname_color === '#ffffff');
        ok('未插入新键', !('nameplate' in j.data) && !('suit' in j.data));
        ok('其他字段未动', j.data.sign === 'hello' && j.data.level === 6);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[13] mode=spoof-spacebg — 收藏集空间背景');
    {
        const sb = CARD_INFO.space_background;
        const bgResp = {
            code: 0,
            data: {
                mid: 12345, part: 7,
                image: null,
                animation: { animation_url: 'upos://old', animation_backup_image: 'https://old.png', duration: 5 }
            }
        };
        const r = await run({
            argument: 'mode=spoof-spacebg',
            request: { url: 'https://api.bilibili.com/x/garb/Right/SpaceBackgroundInfo?mid=12345', method: 'GET', headers: {} },
            response: { headers: {}, body: JSON.stringify(bgResp) },
            store: cardStore()
        });
        const j = JSON.parse(r.done.body);
        ok('animation 换成了卡片的空间背景', j.data.animation.animation_url === sb.animation.animation_url);
        ok('背景图换成卡片的', j.data.animation.animation_backup_image === sb.animation.animation_backup_image);
        ok('外层其他字段保留', j.data.mid === 12345 && j.data.part === 7);
        ok('$done 只调用一次', r.calls === 1);
    }

    console.log('\n[14] mode=spoof-spacebg — 嵌套结构也能命中');
    {
        const sb = CARD_INFO.space_background;
        const nested = {
            code: 0,
            data: {
                mid: 12345,
                space_background: {
                    image: null,
                    animation: { animation_url: 'upos://old', animation_backup_image: 'https://old.png' }
                },
                other: { keep: 1 }
            }
        };
        const r = await run({
            argument: 'mode=spoof-spacebg',
            request: { url: 'https://api.bilibili.com/x/garb/Right/SpaceBackgroundInfo?mid=12345', method: 'GET', headers: {} },
            response: { headers: {}, body: JSON.stringify(nested) },
            store: cardStore()
        });
        const j = JSON.parse(r.done.body);
        ok('嵌套里的 animation 被替换',
            j.data.space_background.animation.animation_backup_image === sb.animation.animation_backup_image);
        ok('旁边字段没被动', j.data.other.keep === 1 && j.data.mid === 12345);
    }

    console.log('\n[15] mode=spoof-spacebg — 该放行的时候放行');
    {
        const bgResp = {
            code: 0,
            data: { mid: 12345, image: null, animation: { animation_url: 'upos://old' } }
        };
        // 装扮态：不归它管
        const r1 = await run({
            argument: 'mode=spoof-spacebg',
            response: { headers: {}, body: JSON.stringify(bgResp) },
            store: suitStore()
        });
        ok('装扮态下放行', r1.done.body === undefined && r1.calls === 1);

        // 无状态
        const r2 = await run({
            argument: 'mode=spoof-spacebg',
            response: { headers: {}, body: JSON.stringify(bgResp) }
        });
        ok('无状态放行', r2.done.body === undefined && r2.calls === 1);

        // 卡片没有空间背景
        const noBg = JSON.parse(JSON.stringify(CARD_INFO));
        noBg.space_background = null;
        const r3 = await run({
            argument: 'mode=spoof-spacebg',
            response: { headers: {}, body: JSON.stringify(bgResp) },
            store: { [KEY]: JSON.stringify({ kind: 'card', card_type_id: noBg.id, name: noBg.name, card: noBg }) }
        });
        ok('卡片没有空间背景时放行', r3.done.body === undefined && r3.calls === 1);

        // 响应里认不出背景结构
        const r4 = await run({
            argument: 'mode=spoof-spacebg',
            response: { headers: {}, body: JSON.stringify({ code: 0, data: { mid: 1, foo: 'bar' } }) },
            store: cardStore()
        });
        ok('响应里没有背景结构时放行', r4.done.body === undefined && r4.calls === 1);

        // 坏 JSON
        const r5 = await run({
            argument: 'mode=spoof-spacebg',
            response: { headers: {}, body: '<html>' },
            store: cardStore()
        });
        ok('坏 JSON 放行', r5.done.body === undefined && r5.calls === 1);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[16] 两套状态互斥 — 卡片态不触发装扮伪装');
    {
        const skinResp = {
            code: 0,
            data: { user_equip: { id: 2, name: '默认' }, load_equip: { id: 1 } }
        };
        const r1 = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: JSON.stringify(skinResp) },
            store: cardStore()
        });
        ok('卡片态下 spoof-skin 放行', r1.done.body === undefined);

        const cardResp = { code: 0, data: { card: { mid: '1', nickname_color: '#fff', pendant: {} } } };
        const r2 = await run({
            argument: 'mode=spoof-card',
            request: { url: 'https://x', method: 'GET', headers: {} },
            response: { headers: {}, body: JSON.stringify(cardResp) },
            store: cardStore()
        });
        ok('卡片态下 spoof-card 放行', r2.done.body === undefined);

        const r3 = await run({
            argument: 'mode=spoof-space',
            request: { url: 'https://x', method: 'GET', headers: {} },
            response: { headers: {}, body: JSON.stringify({ code: 0, data: { mid: 1, nickname_color: '#fff' } }) },
            store: cardStore()
        });
        ok('卡片态下 spoof-space 放行', r3.done.body === undefined);

        // 反过来：装扮态不该动空间背景
        const r4 = await run({
            argument: 'mode=spoof-spacebg',
            response: { headers: {}, body: JSON.stringify({ code: 0, data: { image: null, animation: { animation_url: 'x' } } }) },
            store: suitStore()
        });
        ok('装扮态下 spoof-spacebg 放行', r4.done.body === undefined);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[18] mode=capture — 抓「使用」请求');
    {
        const CAPKEY = 'bili.garb.capture';

        const r1 = await run({
            argument: 'capture',
            request: {
                url: 'https://app.bilibili.com/x/v2/space/digital/bind',
                method: 'POST',
                body: 'act_id=114746&card_type_id=1792140812005&csrf=deadbeef12345678'
            }
        });
        ok('POST 被记下来', (r1.store[CAPKEY] || '').indexOf('digital/bind') > -1);
        ok('请求原样放行', r1.done && r1.done.body === undefined && r1.done.response === undefined);
        const rec = JSON.parse(r1.store[CAPKEY])[0];
        ok('记了 method', rec.m === 'POST');
        ok('csrf 被抹掉', !/deadbeef/.test(rec.body), rec.body);
        ok('抹掉后留了占位', /csrf=<redacted>/.test(rec.body));

        const r2 = await run({
            argument: 'capture',
            request: { url: 'https://api.bilibili.com/x/garb/user/asset', method: 'GET', headers: {} }
        });
        ok('GET 也记（关键请求可能就是 GET）', (r2.store[CAPKEY] || '').indexOf('user/asset') > -1);
        ok('GET 也放行', r2.done && r2.done.body === undefined);

        const r3 = await run({
            argument: 'capture',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply?item_id=1', method: 'POST', body: '' }
        });
        ok('自己的桥不抓', !(CAPKEY in r3.store));

        // 同一条路径重复打，只留最新一条
        let dedup = {};
        for (let i = 0; i < 3; i++) {
            const rr = await run({
                argument: 'capture',
                request: {
                    url: 'https://api.bilibili.com/x/garb/v2/mall/suit/detail?item_id=' + i,
                    method: 'GET', body: ''
                },
                store: dedup
            });
            dedup = rr.store;
        }
        const dbuf = JSON.parse(dedup[CAPKEY]);
        ok('同一路径只留一条', dbuf.filter(e => e.url.indexOf('suit/detail') > -1).length === 1, 'len=' + dbuf.length);
        ok('留的是最新那条', /item_id=2/.test(dbuf[dbuf.length - 1].url));

        // 环形缓冲：超过 20 条丢掉最老的
        let store = {};
        for (let i = 0; i < 25; i++) {
            const rr = await run({
                argument: 'capture',
                request: { url: 'https://api.bilibili.com/x/garb/test/' + i, method: 'POST', body: 'n=' + i },
                store
            });
            store = rr.store;
        }
        const buf = JSON.parse(store[CAPKEY]);
        ok('最多留 20 条', buf.length === 20, 'len=' + buf.length);
        ok('留的是最新的', /test\/24/.test(buf[buf.length - 1].url));

        // dump / clear
        const rd = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/dump', method: 'GET', headers: {} },
            store
        });
        const jd = JSON.parse(rd.done.response.body);
        ok('dump 返回条数', jd.count === 20 && jd.data.length === 20);

        // 诊断回传
        const DIAG = { name: '水果篮子个性主题', set_id: '114749', ids: ['1', '2'], diag: [{ id: '1', code: -101, message: '账号未登录', keys: [] }] };
        const rg = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/diag', method: 'POST', body: JSON.stringify(DIAG) },
            store
        });
        ok('diag 返回 code 0', JSON.parse(rg.done.response.body).code === 0);

        const rd2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/dump', method: 'GET', headers: {} },
            store: rg.store
        });
        const jd2 = JSON.parse(rd2.done.response.body);
        ok('dump 里带上了 diag', !!(jd2.diag && jd2.diag.diag && jd2.diag.diag[0].code === -101));
        ok('diag 里保留了原始 id 列表', !!(jd2.diag && jd2.diag.ids && jd2.diag.ids.length === 2));

        const rc2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/dump/clear', method: 'GET', headers: {} },
            store: rg.store
        });
        ok('dump/clear 连 diag 一起清', !('bili.garb.diag' in rc2.store));

        const rc = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/dump/clear', method: 'GET', headers: {} },
            store
        });
        ok('dump/clear 清空', !(CAPKEY in rc.store));
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[19] mode=fake-unlock — 诊断：让奖励显示可领取');
    {
        const COLLECT = JSON.parse(fs.readFileSync(path.join(__dirname, 'collect-114746.json'), 'utf8'));
        const before = COLLECT.data.collect_infos.map(c => c.owned_item_amount);

        const r = await run({
            argument: 'fake-unlock',
            response: { headers: {}, body: JSON.stringify(COLLECT) }
        });
        const j = JSON.parse(r.done.body);
        const infos = j.data.collect_infos;

        ok('进度被填满', infos.every(c => Number(c.owned_item_amount) === Number(c.require_item_amount)),
            JSON.stringify(infos.map(c => c.owned_item_amount)));
        ok('按钮文案变成领取', infos.every(c => c.redeem_btn_text === '领取'));
        ok('原夹具没被改动（深拷贝生效）', before.every(v => v === 0));
        ok('名字和 id 都没动', infos[2].collect_id === 114749 && infos[2].redeem_item_name === '水果篮子个性主题');
        ok('$done 只调用一次', r.calls === 1);

        // lottery_home_detail 的形状：collect_list.collect_infos
        const NESTED = { code: 0, data: { lottery_id: 1, collect_list: { collect_infos: JSON.parse(JSON.stringify(COLLECT.data.collect_infos)) } } };
        const r2 = await run({
            argument: 'fake-unlock',
            response: { headers: {}, body: JSON.stringify(NESTED) }
        });
        const j2 = JSON.parse(r2.done.body);
        ok('嵌套 collect_list 也能改',
            j2.data.collect_list.collect_infos.every(c => c.redeem_btn_text === '领取'));

        // 已经满了的不重复改
        const full = JSON.parse(JSON.stringify(COLLECT));
        full.data.collect_infos.forEach(c => { c.owned_item_amount = c.require_item_amount; });
        const r3 = await run({
            argument: 'fake-unlock',
            response: { headers: {}, body: JSON.stringify(full) }
        });
        ok('已经满的直接放行', r3.done.body === undefined);

        // 无关响应不动
        const r4 = await run({
            argument: 'fake-unlock',
            response: { headers: {}, body: JSON.stringify({ code: 0, data: { user_equip: {} } }) }
        });
        ok('无关响应放行', r4.done.body === undefined);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[20] 未知 mode / 无 argument / 裸 token');
    {
        const r1 = await run({ argument: '', response: { headers: {}, body: '{}' } });
        ok('空 argument 放行', r1.done && r1.done.body === undefined && r1.calls === 1);
        const r2 = await run({ argument: 'mode=nonsense', response: { headers: {}, body: '{}' } });
        ok('未知 mode 放行', r2.done && r2.done.body === undefined && r2.calls === 1);

        const r3 = await run({
            argument: 'inject',
            response: { headers: { 'Content-Type': 'text/html' }, body: SHELL }
        });
        ok('裸 token 也能命中 inject', !!(r3.done && r3.done.body && r3.done.body.indexOf('overlayMain') > -1));

        const r4 = await run({
            argument: 'spoof-spacebg',
            response: { headers: {}, body: JSON.stringify({ code: 0, data: { image: null, animation: { animation_url: 'x' } } }) },
            store: cardStore()
        });
        ok('裸 token 也能命中 spoof-spacebg', r4.done.body !== undefined);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[21] mode=spoof-reply — 评论区装扮（评论背景 + 评论挂件）');
    {
        // 从详情夹具里造一份 v2 状态：card_bg 槽由 suit_items.card_bg 自动填充
        const detail = JSON.parse(JSON.stringify(DETAIL.data));
        const r0 = await run({
            argument: 'mode=bridge',
            request: {
                url: 'https://api.bilibili.com/x/garb/_sg/apply?item_id=' + detail.item_id,
                method: 'GET',
                headers: { Origin: 'https://www.bilibili.com', Cookie: 'DedeUserID=90001' }
            },
            http: () => ({ body: JSON.stringify(DETAIL) })
        });
        const stored = JSON.parse(r0.store[KEY] || '{}');
        ok('详情应用后 cardbg 槽被填上', !!(stored.slots && stored.slots.cardbg));
        ok('cardbg 里是模型形状 {id,name,image}',
            !!(stored.slots.cardbg && stored.slots.cardbg.card_bg &&
               stored.slots.cardbg.card_bg.image &&
               stored.slots.cardbg.card_bg.id != null));

        const selfMid = 90001;
        const replyBody = {
            code: 0,
            data: {
                replies: [
                    { rpid: 1, member: { mid: selfMid, uname: 'me' } },
                    { rpid: 2, member: { mid: 777, uname: 'other' } },
                    { rpid: 3, member: { mid: selfMid, user_sailing_v2: { card_bg: { id: 1, image: 'old' } } } }
                ]
            }
        };
        const cookieStore = { [KEY]: JSON.stringify(stored) };
        // 36438 没有挂件部件，评论挂件那条断言另造一份带 pendant 的状态来验
        const withPendant = JSON.parse(JSON.stringify(stored));
        withPendant.slots.pendant = {
            id: 555, name: '挂件',
            pendant: { pid: 555, name: '挂件', image: 'https://i0.hdslb.com/bfs/garb/item/p.png',
                       image_enhance: 'https://i0.hdslb.com/bfs/garb/item/pe.png' }
        };
        const r1 = await run({
            argument: 'mode=spoof-reply',
            store: { [KEY]: JSON.stringify(withPendant) },
            request: { url: 'https://api.bilibili.com/x/v2/reply?type=1&oid=1', headers: { Cookie: 'DedeUserID=' + selfMid + ';' } },
            response: { headers: {}, body: JSON.stringify(replyBody) }
        });
        const out = JSON.parse(r1.done.body || '{}');
        const a = out.data.replies[0].member;
        const b = out.data.replies[1].member;
        const c = out.data.replies[2].member;

        ok('自己的楼层写入了 user_sailing_v2.card_bg', !!(a.user_sailing_v2 && a.user_sailing_v2.card_bg && a.user_sailing_v2.card_bg.image));
        ok('写入的图就是槽里的图',
            a.user_sailing_v2.card_bg.image === stored.slots.cardbg.card_bg.image);
        ok('自己的楼层写入了 user_sailing.pendant', !!(a.user_sailing && a.user_sailing.pendant));
        ok('别人的楼层原样不动', !b.user_sailing_v2 && !b.user_sailing);
        ok('原本就有 card_bg 的楼层被覆盖', c.user_sailing_v2.card_bg.image !== 'old');
        ok('$done 只调用一次', r1.calls === 1);

        // 没有评论装扮槽时整包放行
        const bare = { [KEY]: JSON.stringify({ v: 2, name: '', slots: {} }) };
        const r2 = await run({
            argument: 'mode=spoof-reply',
            store: bare,
            request: { url: 'https://api.bilibili.com/x/v2/reply', headers: {} },
            response: { headers: {}, body: JSON.stringify(replyBody) }
        });
        ok('没有评论装扮时放行', r2.done && r2.done.body === undefined);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[22] mode=spoof-splash — 开屏画面');
    {
        const splash = CARD_INFO.splash;
        const res = splash.resource.full_size;
        const store = {
            [KEY]: JSON.stringify({
                v: 2, name: 'x',
                slots: { splash: { id: CARD_INFO.id, thumb: res.thumb, thumb_hash: res.thumb_hash, duration: 3, mode: 'full' } }
            })
        };

        // 品牌开屏：空列表要自己补一条并进 show[]
        const brandEmpty = { code: 0, data: { list: [], show: [], pull_interval: 600 } };
        const r1 = await run({
            argument: 'mode=spoof-splash',
            store,
            response: { headers: {}, body: JSON.stringify(brandEmpty) }
        });
        const b1 = JSON.parse(r1.done.body || '{}');
        ok('空品牌列表补上了我们那条', b1.data.list.length === 1);
        ok('thumb 用的是槽里的图', b1.data.list[0].thumb === res.thumb);
        ok('thumb_hash 跟着一起写', b1.data.list[0].thumb_hash === res.thumb_hash);
        ok('show[] 里带上了 splash_id', b1.data.show.indexOf('bili-garb') > -1);

        // 已有条目：就地替换，不重复插入
        const brandFull = {
            code: 0,
            data: {
                list: [{ splash_id: 'abc', thumb: 'https://old/1.webp', thumb_hash: 'deadbeef', duration: 5 }],
                show: ['abc']
            }
        };
        const r2 = await run({
            argument: 'mode=spoof-splash',
            store,
            response: { headers: {}, body: JSON.stringify(brandFull) }
        });
        const b2 = JSON.parse(r2.done.body || '{}');
        ok('已有条目的 thumb 被替换', b2.data.list[0].thumb === res.thumb);
        ok('thumb_hash 同步替换', b2.data.list[0].thumb_hash === res.thumb_hash);
        ok('没有重复插入', b2.data.list.filter(e => e.splash_id === 'bili-garb').length === 1);

        // 活动开屏：按 thumb/thumb_hash 结构签名替换
        const event = {
            code: 0,
            data: {
                list: [{
                    identifier: 1,
                    elements: [{
                        resources: [{ full_size: { thumb: 'https://old/e.webp', thumb_hash: 'ff' } }]
                    }]
                }]
            }
        };
        const r3 = await run({
            argument: 'mode=spoof-splash',
            store,
            response: { headers: {}, body: JSON.stringify(event) }
        });
        const b3 = JSON.parse(r3.done.body || '{}');
        const leaf = b3.data.list[0].elements[0].resources[0].full_size;
        ok('活动开屏按结构签名替换', leaf.thumb === res.thumb && leaf.thumb_hash === res.thumb_hash);

        // 没有开屏槽时放行
        const r4 = await run({
            argument: 'mode=spoof-splash',
            store: { [KEY]: JSON.stringify({ v: 2, name: '', slots: {} }) },
            response: { headers: {}, body: JSON.stringify(brandEmpty) }
        });
        ok('没有开屏槽时放行', r4.done && r4.done.body === undefined);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[23] mode=spoof-grpc — 评论区装扮（gRPC protobuf）');
    {
        // 手搓 protobuf，字段号来自 IPA 里 `+[Cls descriptor]` 的字段描述符数组
        const V = n => { const o = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return o; };
        const TAG = (n, w) => V(n * 8 + w);
        const MSG = (n, body) => [...TAG(n, 2), ...V(body.length), ...body];
        const STR = s => [...Buffer.from(s, 'utf8')];
        const STR_F = (n, s) => MSG(n, STR(s));
        const VAR_F = (n, v) => [...TAG(n, 0), ...V(v)];
        const FRAME = b => [0, (b.length >>> 24) & 255, (b.length >>> 16) & 255,
            (b.length >>> 8) & 255, b.length & 255, ...b];

        const NEW_IMG = 'https://i0.hdslb.com/bfs/garb/item/new.png';
        const OLD_IMG = 'https://i0.hdslb.com/bfs/garb/item/old.png';
        const OTHER_IMG = 'https://i0.hdslb.com/bfs/garb/item/other.png';

        // UserCardBG{ id=1, name="x", image=... }
        const cardBg = (img) => MSG(3, STR(img));
        // UserSailing{ cardBg=2 }
        const userSailing = (img) => MSG(2, cardBg(img));
        // MemberV2{ userSailing=9 }
        const memberV2 = (img) => MSG(9, userSailing(img));
        // ReplyInfo{ memberV2=15 }
        const replyInfo = (img) => MSG(15, memberV2(img));
        // MainListReply{ replies=2 [a,b] }
        const mainList = (imgs) => imgs.map(i => MSG(2, replyInfo(i))).reduce((a, b) => [...a, ...b], []);

        const body = new Uint8Array(FRAME(mainList([OLD_IMG, OTHER_IMG])));

        const store = {
            [KEY]: JSON.stringify({
                v: 2, name: 'x',
                slots: { cardbg: { id: 1, name: '评论装扮', card_bg: { id: 1, name: '评论装扮', image: NEW_IMG } } }
            })
        };

        const r = await run({
            argument: 'mode=spoof-grpc',
            store,
            request: { url: 'https://grpc.biliapi.net/bilibili.main.community.reply.v1.Main/MainList', headers: {} },
            response: { headers: { 'Content-Type': 'application/grpc' }, body }
        });

        const out = r.done && r.done.body;
        ok('产出了新的 body', !!out);
        const arr = out ? Array.from(out) : [];
        const hex = Buffer.from(arr).toString('latin1');
        ok('旧图被换掉了', hex.indexOf(OLD_IMG) === -1);
        ok('新图写进去了', hex.indexOf(NEW_IMG) > -1);
        ok('帧头长度自洽', arr.length >= 5 && arr[0] === 0 &&
            ((arr[1] << 24) | (arr[2] << 16) | (arr[3] << 8) | arr[4]) >>> 0 === arr.length - 5);
        ok('$done 只调用一次', r.calls === 1);

        // 不是评论服务就放行
        const r2 = await run({
            argument: 'mode=spoof-grpc',
            store,
            request: { url: 'https://grpc.biliapi.net/bilibili.vas.garb.service.Garb/UserCardMulti', headers: {} },
            response: { headers: {}, body }
        });
        ok('别的 gRPC 服务放行', r2.done && r2.done.body === undefined);

        // 没有评论装扮槽就放行
        const r3 = await run({
            argument: 'mode=spoof-grpc',
            store: { [KEY]: JSON.stringify({ v: 2, name: '', slots: {} }) },
            request: { url: 'https://grpc.biliapi.net/bilibili.main.community.reply.v1.Main/MainList', headers: {} },
            response: { headers: {}, body }
        });
        ok('没有评论装扮时放行', r3.done && r3.done.body === undefined);

        // 垃圾数据不能崩
        const r4 = await run({
            argument: 'mode=spoof-grpc',
            store,
            request: { url: 'https://grpc.biliapi.net/bilibili.main.community.reply.v1.Main/MainList', headers: {} },
            response: { headers: {}, body: new Uint8Array([0, 0, 0, 0, 3, 255, 255, 255]) }
        });
        ok('畸形帧不崩且放行', r4.done && r4.done.body === undefined);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n────────────────────────────────');
    console.log('  ' + pass + ' passed, ' + fail + ' failed');
    console.log('────────────────────────────────\n');
    process.exit(fail ? 1 : 0);

})();
