/**
 * 本地测试台 — 在 node 里模拟 Surge 运行时，逐条跑验收表。
 *   node test/run.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bili-garb.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(__dirname, 'shell.html'), 'utf8');
const DETAIL = JSON.parse(fs.readFileSync(path.join(__dirname, 'detail-36438.json'), 'utf8'));

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

    return new Promise(resolve => {
        setTimeout(() => resolve(out), 0);
    });
}

const stateStore = () => ({
    [KEY]: JSON.stringify({
        item_id: DETAIL.data.item_id,
        name: DETAIL.data.name,
        detail: DETAIL.data,
        at: Date.now()
    })
});

(async function main() {

    // ─────────────────────────────────────────────────────────
    console.log('\n[1] mode=inject — 注入外壳 HTML');
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

    console.log('\n[2] mode=inject — 非 HTML 响应必须放行');
    {
        const r = await run({
            argument: 'mode=inject',
            response: { headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }
        });
        ok('不返回 body', r.done && r.done.body === undefined);
        ok('$done 只调用一次', r.calls === 1);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[3] mode=bridge — apply');
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
        ok('标记有主题部件', !!(j.data && j.data.has_skin === true));
        ok('标记有加载动画', !!(j.data && j.data.has_loading === true));
        ok('落盘了全量 detail', !!r.store[KEY] && JSON.parse(r.store[KEY]).detail.suit_items.skin.length > 0);
        ok('拉 detail 时带了 Referer', r.requests.length === 1 && r.requests[0].headers.Referer === 'https://www.bilibili.com/');
        ok('CORS 头回显 Origin', r.done.response.headers['Access-Control-Allow-Origin'] === 'https://www.bilibili.com');
        ok('$done 只调用一次', r.calls === 1);
    }

    console.log('\n[4] mode=bridge — clear / state');
    {
        const r1 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/clear', method: 'GET', headers: {} },
            store: stateStore()
        });
        ok('clear 返回 code 0', JSON.parse(r1.done.response.body).code === 0);
        ok('clear 删掉了 key', !(KEY in r1.store));

        const r2 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/state', method: 'GET', headers: {} },
            store: stateStore()
        });
        const j2 = JSON.parse(r2.done.response.body);
        ok('state 返回当前装扮', !!(j2.data && j2.data.item_id === 36438 && j2.data.name === '鹿乃桜帆'));

        const r3 = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/state', method: 'GET', headers: {} }
        });
        ok('无状态时 state 返回 null', JSON.parse(r3.done.response.body).data === null);
    }

    console.log('\n[5] mode=bridge — 缺 item_id / detail 失败');
    {
        const r = await run({
            argument: 'mode=bridge',
            request: { url: 'https://api.bilibili.com/x/garb/_sg/apply', method: 'GET', headers: {} }
        });
        ok('返回 -1 且不落盘', JSON.parse(r.done.response.body).code === -1 && !(KEY in r.store));

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
    console.log('\n[6] mode=spoof-skin — 改写主题 + 加载动画');
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
            store: stateStore()
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

    console.log('\n[7] mode=spoof-skin — 无状态必须放行');
    {
        const r = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: JSON.stringify({ code: 0, data: { user_equip: {} } }) }
        });
        ok('不返回 body', r.done.body === undefined);
        ok('$done 只调用一次', r.calls === 1);
    }

    console.log('\n[8] mode=spoof-skin — 坏 JSON / 空 body 不炸');
    {
        const r = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: 'not json{' },
            store: stateStore()
        });
        ok('坏 JSON 原样放行', r.done.body === undefined);
        ok('$done 只调用一次', r.calls === 1);

        const r2 = await run({
            argument: 'mode=spoof-skin',
            response: { headers: {}, body: '' },
            store: stateStore()
        });
        ok('空 body 原样放行', r2.done.body === undefined && r2.calls === 1);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[9] mode=spoof-card — 只改自己');
    {
        const cardResp = {
            code: 0,
            data: {
                card: {
                    mid: '12345',
                    name: 'me',
                    pendant: { pid: 1, name: 'old', image: 'https://x/old.png' },
                    nickname_color: '#FB7299',
                    vip: { type: 2 }
                }
            }
        };
        const r = await run({
            argument: 'mode=spoof-card',
            request: { url: 'https://api.bilibili.com/x/web-interface/card?mid=12345', method: 'GET', headers: { Cookie: 'DedeUserID=12345' } },
            response: { headers: {}, body: JSON.stringify(cardResp) },
            store: stateStore()
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
            store: stateStore()
        });
        ok('别人的名片原样放行', r2.done.body === undefined);
    }

    console.log('\n[10] mode=spoof-space — 按名覆盖，不插新键');
    {
        const spaceResp = {
            code: 0,
            data: {
                mid: 12345,
                name: 'me',
                pendant: { pid: 1, name: 'old', image: 'https://x/old.png' },
                nickname_color: '#FB7299',
                sign: 'hello',
                level: 6
            }
        };
        const r = await run({
            argument: 'mode=spoof-space',
            request: { url: 'https://api.bilibili.com/x/space/wbi/acc/info?mid=12345', method: 'GET', headers: { Cookie: 'DedeUserID=12345' } },
            response: { headers: {}, body: JSON.stringify(spaceResp) },
            store: stateStore()
        });
        const j = JSON.parse(r.done.body);
        ok('nickname_color 被改写', j.data.nickname_color === '#ffffff');
        ok('未插入新键', !('nameplate' in j.data) && !('suit' in j.data));
        ok('其他字段未动', j.data.sign === 'hello' && j.data.level === 6);
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n[11] 未知 mode / 无 argument / 裸 token');
    {
        const r1 = await run({ argument: '', response: { headers: {}, body: '{}' } });
        ok('空 argument 放行', r1.done && r1.done.body === undefined && r1.calls === 1);
        const r2 = await run({ argument: 'mode=nonsense', response: { headers: {}, body: '{}' } });
        ok('未知 mode 放行', r2.done && r2.done.body === undefined && r2.calls === 1);

        // 模块里用的是裸 token 写法 argument=inject
        const r3 = await run({
            argument: 'inject',
            response: { headers: { 'Content-Type': 'text/html' }, body: SHELL }
        });
        ok('裸 token 也能命中 inject', !!(r3.done && r3.done.body && r3.done.body.indexOf('overlayMain') > -1));
    }

    // ─────────────────────────────────────────────────────────
    console.log('\n────────────────────────────────');
    console.log('  ' + pass + ' passed, ' + fail + ' failed');
    console.log('────────────────────────────────\n');
    process.exit(fail ? 1 : 0);

})();
