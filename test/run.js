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
        ok('kind 是 suit', !!(j.data && j.data.kind === 'suit'));
        ok('标记有主题部件', !!(j.data && j.data.has_skin === true));
        ok('标记有加载动画', !!(j.data && j.data.has_loading === true));
        ok('落盘了全量 detail', !!r.store[KEY] && JSON.parse(r.store[KEY]).detail.suit_items.skin.length > 0);
        ok('落盘的 kind 是 suit', JSON.parse(r.store[KEY]).kind === 'suit');
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
        ok('state 返回装扮', !!(j2.data && j2.data.kind === 'suit' && j2.data.item_id === 36438));

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
        ok('kind 是 card', j.data && j.data.kind === 'card');
        ok('返回卡名', j.data && j.data.name === CARD_INFO.name);
        ok('标记有空间背景', j.data && j.data.has_space_bg === true);
        ok('只发了一次请求（不需要解析 lottery）', r.requests.length === 1, 'requests=' + r.requests.length);
        ok('请求用的是 detail/v2', r.requests[0].url.includes('/x/vas/dlc_act/lottery/detail/v2'));

        const st = JSON.parse(r.store[KEY]);
        ok('落盘 kind=card', st.kind === 'card');
        ok('落盘 card_type_id', String(st.card_type_id) === String(CARD_INFO.id));
        ok('落盘了完整 card_type_info', !!(st.card && st.card.space_background));
        ok('落盘 act_id / lottery_id', st.act_id === 114746 && String(st.lottery_id) === '114747');
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
        ok('落盘 lottery_id 正确', String(JSON.parse(r.store[KEY]).lottery_id) === '114747');
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
    console.log('\n[9] mode=spoof-skin — 改写主题 + 加载动画');
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

    console.log('\n[10] mode=spoof-skin — 无状态 / 坏 JSON 放行');
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
    console.log('\n[17] 未知 mode / 无 argument / 裸 token');
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
    console.log('\n────────────────────────────────');
    console.log('  ' + pass + ' passed, ' + fail + ' failed');
    console.log('────────────────────────────────\n');
    process.exit(fail ? 1 : 0);

})();
