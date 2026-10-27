/**
 * 极简 DOM 桩，用来验证注入的 overlay 能不能真的挂上去。
 *
 * 为什么需要它：overlay 是一个大函数，`mount()` 里任何一处 ReferenceError
 * 都会让整个挂载流程中断 —— 表现是「按钮根本不出现」，而语法检查查不出来。
 * 13:19 那次重写丢了 reset/applySuit 等六个函数，就是靠这个才发现的。
 */

function makeEl(tag) {
    const el = {
        tagName: (tag || 'div').toUpperCase(),
        style: {}, children: [], parentNode: null,
        className: '', id: '', textContent: '', innerHTML: '', dataset: {},
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); },
            remove(c) { this._s.delete(c); },
            contains(c) { return this._s.has(c); }
        },
        setAttribute() {}, getAttribute() { return null; },
        appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
        insertBefore(c) { c.parentNode = el; el.children.push(c); return c; },
        removeChild(c) { el.children = el.children.filter(x => x !== c); return c; },
        addEventListener() {}, removeEventListener() {},
        getBoundingClientRect() { return { left: 300, top: 500, width: 52, height: 52 }; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        contains(x) { return x === el || el.children.indexOf(x) > -1; }
    };
    return el;
}

function runOverlay(OVERLAY_JS) {
    const vm = require('vm');
    const ids = {};

    const body = makeEl('body');
    const head = makeEl('head');
    const documentElement = makeEl('html');
    documentElement.appendChild(head);
    documentElement.appendChild(body);

    const findById = (id) => {
        if (ids[id]) return ids[id];
        const walk = (n) => {
            if (n.id === id) return n;
            for (const c of n.children) { const r = walk(c); if (r) return r; }
            return null;
        };
        return walk(documentElement);
    };

    const document = {
        readyState: 'complete',
        body, head, documentElement,
        createElement: makeEl,
        createTextNode: (t) => ({ nodeType: 3, textContent: t }),
        getElementById: findById,
        addEventListener() {}, removeEventListener() {},
        contains(n) {
            const walk = (x) => { if (x === n) return true; for (const c of x.children) if (walk(c)) return true; return false; };
            return walk(documentElement);
        },
        querySelector() { return null; }
    };

    const origBody = body.appendChild.bind(body);
    body.appendChild = (c) => { if (c.id) ids[c.id] = c; return origBody(c); };
    const origHead = head.appendChild.bind(head);
    head.appendChild = (c) => { if (c.id) ids[c.id] = c; return origHead(c); };

    const deferred = [];
    const sandbox = {
        document,
        innerWidth: 390, innerHeight: 844,
        localStorage: { getItem: () => null, setItem: () => {} },
        addEventListener() {}, removeEventListener() {},
        setTimeout: (fn) => { deferred.push(fn); return 0; },
        setInterval: () => 0,
        MutationObserver: class { observe() {} disconnect() {} },
        fetch: () => Promise.resolve({ json: () => Promise.resolve({ code: 0, data: null }) }),
        console: { log() {}, warn() {}, error() {} },
        navigator: { userAgent: 'test' },
        location: { href: 'https://www.bilibili.com/h5/mall/home', search: '', pathname: '/h5/mall/home' },
        getComputedStyle: () => ({}),
        history: { pushState() {}, replaceState() {}, state: null },
        encodeURIComponent, decodeURIComponent, JSON, Math, Date, Object, Array, String, Number, isNaN, parseInt, parseFloat
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;

    let error = null;
    try {
        vm.createContext(sandbox);
        vm.runInContext(OVERLAY_JS, sandbox, { filename: 'overlay.js' });
    } catch (e) {
        error = e;
    }

    // 跑一轮延迟回调，捕捉异步初始化里的错误
    const deferredErrors = [];
    for (const fn of deferred) {
        try { fn(); } catch (e) { deferredErrors.push(e.message); }
    }

    const root = findById('bg-root');
    return {
        error,
        deferredErrors,
        root,
        children: root ? root.children.map(c => c.className || c.tagName) : [],
        bodyChildren: body.children.map(c => c.id || c.className || c.tagName)
    };
}

module.exports = { runOverlay };
