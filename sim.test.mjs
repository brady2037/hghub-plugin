/**
 * hghub-plugin/huanguo-source.js 的本地模拟验证（Node）：
 * 1. 模块可导入、meta 形状正确；
 * 2. 工厂在 mock 宿主上返回全部能力对象；
 * 3. endpoints 列表：无缓存、无网络时仍返回非空（固定主站）；
 * 4. 发布脚本 JS-as-data 解析：合法数组解析、危险构造拒绝；
 * 5. 信封解包、cardOf 映射、normalizePlay 逻辑（经 mock 响应驱动）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./huanguo-source.js', import.meta.url), 'utf8');
const module_ = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);

assert.equal(module_.meta.id, 'hghub.huangguo');
assert.equal(module_.meta.protocol, 1);
assert.equal(module_.meta.kind, 'source');
assert.equal(module_.meta.mature, true);
assert.match(module_.meta.version, /^\d+\.\d+\.\d+$/);

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.plugins[0].id, module_.meta.id);
assert.equal(manifest.plugins[0].version, module_.meta.version);
assert.match(manifest.description, /Android.*huanguo-source\.js/);

// ── mock 宿主 ──────────────────────────────────────────────
function makeHost({ httpData, networkDown = false } = {}) {
  const storage = new Map();
  const calls = [];
  const hg = {
    PluginError: class PluginError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
    codec: {
      utf8Encode: s => new TextEncoder().encode(s),
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    },
    endpoint: { current: null },
    storage: {
      async get(key) { return storage.get(key); },
      async set(key, value) { storage.set(key, value); },
      async remove(key) { storage.delete(key); },
    },
    http: {
      async fetch(req) {
        calls.push(req);
        if (networkDown) throw new Error('NETWORK down');
        const entry = httpData ? await httpData(req) : null;
        if (!entry) throw new Error(`NETWORK no-mock for ${req.url}`);
        const status = entry.status ?? 200;
        return { ok: status >= 200 && status < 300, status, url: entry.finalUrl || req.url, data: entry.data };
      },
    },
  };
  return { hg, storage, calls };
}

const ctx = { requestId: 'sim', deadline: null, signal: new AbortController().signal };

// ── 1. 工厂与能力对象 ──────────────────────────────────────
{
  const { hg } = makeHost();
  const plugin = module_.default(hg);
  for (const name of ['endpoints', 'home', 'feed', 'catalog', 'search', 'media', 'comments']) {
    assert.ok(plugin[name] && typeof plugin[name] === 'object', `缺少能力 ${name}`);
  }
  assert.equal(typeof plugin.endpoints.list, 'function');
  assert.equal(typeof plugin.media.getDetail, 'function');
  assert.equal(typeof plugin.media.resolvePlayback, 'function');
  console.log('PASS  工厂返回全部能力对象');
}

// ── 2. endpoints：断网 + 无缓存 → 固定主站，非空 ──────────
{
  const { hg } = makeHost({ networkDown: true });
  const plugin = module_.default(hg);
  const list = await plugin.endpoints.list({ refresh: true }, ctx);
  assert.ok(Array.isArray(list) && list.length >= 1);
  assert.equal(list[0].id, 'main');
  assert.equal(list[0].url, 'https://huangguoai.com');
  console.log('PASS  断网时 endpoints 返回固定主站（非空）');
}

// ── 3. 发布页 → publish.js → 镜像解析（合法样本） ─────────
const PUBLISH_JS = [
  '// 发布数据',
  'var urls = ["HuangGuoA.com", "huangguo-2.com"];',
  'const subdomains = ["a", \'b\', "c"];',
  'void 0; /* 无副作用 */',
].join('\n');

function publishHttp(req) {
  if (req.url === 'https://huangguoai.pages.dev/') {
    return { data: '<html><script src="publish.js"></script></html>' };
  }
  if (req.url === 'https://huang-guo.pages.dev/') {
    return { data: "<html><script src='/assets/publish.js?v=3'></script></html>" };
  }
  if (req.url.endsWith('publish.js') || req.url.includes('publish.js?')) {
    return { data: PUBLISH_JS };
  }
  return null;
}

{
  const { hg, storage } = makeHost({ httpData: publishHttp });
  const plugin = module_.default(hg);
  const list = await plugin.endpoints.list({ refresh: true }, ctx);
  const ids = list.map(e => e.id);
  assert.ok(ids.includes('main'));
  assert.ok(ids.includes('a.huangguoa.com'), '域名小写化 + 子域拼接');
  assert.ok(ids.includes('a.huangguo-2.com'), '子域拼接');
  assert.ok(ids.includes('c.huangguo-2.com'), '交错合并且子域齐全');
  assert.ok(storage.has('endpoints:v1'), '镜像列表已持久化');
  const again = await plugin.endpoints.list({}, ctx); // 走缓存
  assert.equal(again.length, list.length);
  console.log('PASS  发布页镜像解析与缓存：', ids.join(', '));
}

// 单页请求超时不丢弃另一页结果；取消始终终止整次发现。
for (const code of ['TIMEOUT', 'CANCELLED']) {
  const { hg, storage } = makeHost({ httpData: req => {
    if (req.url.startsWith('https://huangguoai.pages.dev/')) {
      throw new hg.PluginError(code, code);
    }
    return publishHttp(req);
  } });
  const discovery = () => module_.default(hg).endpoints.list({ refresh: true }, ctx);
  if (code === 'CANCELLED') {
    await assert.rejects(discovery, { code });
    assert.equal(storage.size, 0);
  } else {
    const list = await discovery();
    assert.ok(list.some(e => e.id === 'a.huangguoa.com'));
  }
}
{
  const { hg } = makeHost({ httpData: () => { throw new hg.PluginError('TIMEOUT', '单请求超时'); } });
  const list = await module_.default(hg).endpoints.list({ refresh: true }, ctx);
  assert.deepEqual(list.map(e => e.id), ['main']);
}
console.log('PASS  镜像单页超时容错与取消传播');

// ── 4. 危险发布脚本被拒绝 → 回退固定主站 ──────────────────
for (const evil of [
  'var urls = ["ok.com", "x" + document.cookie];',   // 数组内拼接表达式
  'var urls = [...another];',                          // 展开非字面量
  'var urls = ["a.com"]; var urls = ["b.com"];',      // 重复声明
  'var urls = ["a.com"].concat(more);',               // 声明后接动态表达式
]) {
  const { hg } = makeHost({
    httpData: req => {
      if (req.url === 'https://huangguoai.pages.dev/' || req.url === 'https://huang-guo.pages.dev/') {
        return { data: '<script src="publish.js"></script>' };
      }
      return { data: evil };
    },
  });
  const plugin = module_.default(hg);
  const list = await plugin.endpoints.list({ refresh: true }, ctx);
  assert.equal(list.length, 1, `应拒绝：${evil}`);
  assert.equal(list[0].id, 'main');
}
console.log('PASS  非字面量/动态发布脚本被拒绝，回退固定主站');

// ── 5. 信封解包 + 列表分页 + entryEpisodeId ────────────────
function apiHttp(data) {
  return req => {
    if (req.url.includes('/api/')) {
      return { data: { status: 1, msg: 'ok', data: typeof data === 'function' ? data(req) : data } };
    }
    return null;
  };
}

{
  const paged = page => ({
    items: [{ id: 42, title: '示例剧', cover: 'https://cdn.example.com/a.bin', episode_count: 3, hot: 120, is_finished: true }],
    pagination: { page, pages: 2, total: 2 },
  });
  const { hg } = makeHost({ httpData: apiHttp(req => {
    if (req.url.includes('/api/search')) return paged(Number(req.query.page) || 1);
    return paged(1);
  }) });
  const plugin = module_.default(hg);
  const result = await plugin.search.search({ query: '示例', cursor: null }, ctx);
  assert.equal(result.items[0].id, '42');
  assert.equal(result.items[0].status, 'finished');
  assert.equal(result.items[0].stats.plays, 120);
  assert.deepEqual(result.items[0].cover.transform.type, 'aes-cbc');
  assert.equal(Buffer.from(result.items[0].cover.transform.key, 'base64').toString('utf8'), 'f5d965df75336270');
  assert.equal(Buffer.from(result.items[0].cover.transform.iv, 'base64').toString('utf8'), '97b60394abc2fbe1');
  assert.ok(result.next, '有下一页 cursor');
  const feedPage = await plugin.feed.list({}, ctx);
  assert.equal(feedPage.items[0].entryEpisodeId, '1');
  console.log('PASS  搜索/Feed 映射、封面 AES 变换、分页 cursor');
}

// ── 6. 业务失败信封 → UPSTREAM_ERROR ──────────────────────
{
  const { hg } = makeHost({ httpData: () => ({ data: { status: 0, msg: '被拒绝' } }) });
  const plugin = module_.default(hg);
  await assert.rejects(() => plugin.search.search({ query: 'x' }, ctx), err => err.code === 'UPSTREAM_ERROR');
  console.log('PASS  业务失败信封映射为 UPSTREAM_ERROR');
}

// ── 7. 详情 + 分集占位 + 播放解析 ─────────────────────────
{
  const detail = {
    id: 42, title: '示例剧', episode_count: 2, hot: 5,
    created_at: '2026-01-02T03:04:05Z',
    interaction: { liked: true, collected: false },
    episodes: [{ ep_num: 1, title: '第 1 集', duration: 90 }, { ep_num: 2, duration: 91 }],
  };
  const play = { streams: { main: 'https://cdn.example.com/v1.m3u8', hevc: 'https://cdn.example.com/v2.m3u8' }, duration: 120 };
  const { hg, calls } = makeHost({ httpData: req => {
    if (req.url.includes('/episodes/1/playback')) return { data: play };
    if (req.url.includes('/api/videos/42') && req.url.includes('/comments')) {
      return { data: { items: [{ id: 7, nickname: '用户', text: '好看', like_count: 2, is_pinned: true }], pagination: { page: 1, pages: 1 } } };
    }
    return { data: detail };
  } });
  const plugin = module_.default(hg);
  const d = await plugin.media.getDetail({ id: '42' }, ctx);
  assert.equal(d.playlists[0].episodes.length, 2);
  assert.equal(d.playlists[0].episodes[0].id, '1');
  assert.equal(d.playlists[0].episodes[0].index, 1);
  assert.equal(d.year, 2026);
  assert.equal(d.interaction.liked, true);

  const p = await plugin.media.resolvePlayback({ mediaId: '42', episodeId: '1', codecs: ['hevc', 'h264'] }, ctx);
  assert.equal(p.streams[0].codec, 'hevc', 'codecs 偏好排序生效');
  assert.equal(p.streams[0].format, 'hls');
  assert.equal(p.durationSec, 120);
  assert.equal(p.streams.length, 2);

  const c = await plugin.comments.list({ target: { kind: 'media', mediaId: '42', episodeId: '1' } }, ctx);
  assert.equal(c.items[0].author.name, '用户');
  assert.equal(c.items[0].pinned, true);
  assert.equal(c.next, null);
  console.log('PASS  详情/播放/评论映射与 codecs 偏好');
}

// ── 8. 播放回退旧接口 ─────────────────────────────────────
{
  const { hg, calls } = makeHost({ httpData: req => {
    if (req.url.includes('/episodes/')) return { status: 404 };
    if (req.url.includes('/play')) return { data: { video_url_hevc: 'https://cdn.example.com/legacy.m3u8', duration: 60 } };
    return null;
  } });
  const plugin = module_.default(hg);
  const p = await plugin.media.resolvePlayback({ mediaId: '9', episodeId: '2' }, ctx);
  assert.equal(p.streams.length, 1);
  assert.equal(p.streams[0].url, 'https://cdn.example.com/legacy.m3u8');
  console.log('PASS  playback 主接口失败回退 legacy /play');
}

// 错误分类与播放终止条件。
const playbackParams = { mediaId: '42', episodeId: '1', codecs: [] };
for (const [entry, code] of [
  [{ data: { status: 0, msg: '视频不存在' } }, 'NOT_FOUND'],
  [{ status: 404 }, 'NOT_FOUND'],
  [{ status: 401 }, 'AUTH_REQUIRED'],
  [{ status: 429 }, 'RATE_LIMITED'],
  [{ status: 503 }, 'UPSTREAM_ERROR'],
]) {
  const { hg } = makeHost({ httpData: () => entry });
  await assert.rejects(() => module_.default(hg).media.getDetail({ id: '42' }, ctx), { code });
}
for (const code of ['CANCELLED', 'TIMEOUT', 'AUTH_REQUIRED', 'AUTH_EXPIRED', 'CONTENT_LOCKED', 'NOT_FOUND', 'NETWORK']) {
  const { hg, calls } = makeHost({ httpData: () => { throw new hg.PluginError(code, code); } });
  await assert.rejects(() => module_.default(hg).media.resolvePlayback(playbackParams, ctx), { code });
  assert.equal(calls.length, 1, `${code} 不触发回退`);
}
{
  const { hg } = makeHost({ httpData: req => {
    if (req.method === 'POST') return { status: 404 };
    throw new hg.PluginError('AUTH_EXPIRED', '登录已失效');
  } });
  await assert.rejects(() => module_.default(hg).media.resolvePlayback(playbackParams, ctx), { code: 'AUTH_EXPIRED' });
}
{
  const { hg, calls } = makeHost({ httpData: () => ({ data: { streams: { main: '', hevc: '' } } }) });
  await assert.rejects(() => module_.default(hg).media.resolvePlayback(playbackParams, ctx), { code: 'UPSTREAM_CHANGED' });
  assert.equal(calls.length, 2);
}
console.log('PASS  错误分类、取消/认证终止、回退错误保留、空播放响应');

// 空评论及内联回复在插件边界过滤。
{
  const { hg } = makeHost({ httpData: apiHttp({ items: [
    { id: 1, text: '  ' },
    { id: 2, text: '正文', reply_list: [{ id: 3, text: '' }, { id: 4, text: '回复' }] },
  ] }) });
  const result = await module_.default(hg).comments.list({ target: { kind: 'media', mediaId: '42' } }, ctx);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].replies.map(r => r.id), ['4']);
}
console.log('PASS  空评论和空回复过滤');

// 使用虚拟时钟验证串行请求共享剩余预算，不等待真实超时。
{
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    const budgetCtx = { ...ctx, deadline: now + 20000 };
    const { hg, calls } = makeHost({ httpData: req => {
      if (req.method === 'POST') { now += 12000; return { status: 404 }; }
      return { data: { video_url: 'https://cdn.example.com/v.m3u8' } };
    } });
    await module_.default(hg).media.resolvePlayback(playbackParams, budgetCtx);
    assert.deepEqual(calls.map(c => c.timeoutMs), [15000, 8000]);
    assert.ok(calls.every(c => c.signal === ctx.signal));

    const exhausted = makeHost({ httpData: () => { now += 21000; return { status: 404 }; } });
    await assert.rejects(() => module_.default(exhausted.hg).media.resolvePlayback(playbackParams, { ...ctx, deadline: now + 20000 }), { code: 'TIMEOUT' });
    assert.equal(exhausted.calls.length, 1);

    const mirrors = makeHost({ httpData: req => {
      if (req.url.endsWith('/')) now += 4000;
      return publishHttp(req);
    } });
    const deadline = now + 10000;
    await module_.default(mirrors.hg).endpoints.list({ refresh: true }, { ...ctx, deadline });
    assert.ok(mirrors.calls.every(c => c.timeoutMs > 0 && c.timeoutMs <= 8000));
    assert.ok(mirrors.calls.filter(c => c.url.includes('publish.js')).every(c => c.timeoutMs === 2000));

    const expiredMirrors = makeHost({ httpData: req => {
      now += 8000;
      return publishHttp(req);
    } });
    await assert.rejects(() => module_.default(expiredMirrors.hg).endpoints.list(
      { refresh: true }, { ...ctx, deadline: now + 15000 }
    ), { code: 'TIMEOUT' });
    assert.equal(expiredMirrors.storage.size, 0);
    assert.equal(expiredMirrors.calls.length, 2);

    const home = makeHost({ httpData: req => {
      if (req.url.endsWith('/api/videos')) now += 9000;
      return { data: { items: [{ id: 42, title: '示例剧' }] } };
    } });
    await module_.default(home.hg).home.getSections({}, { ...ctx, deadline: now + 15000 });
    assert.deepEqual(home.calls.map(c => c.timeoutMs), [15000, 6000]);

    for (const code of ['CANCELLED', 'TIMEOUT']) {
      const stoppedHome = makeHost({ httpData: req => {
        if (req.url.endsWith('/api/videos')) return { data: { items: [{ id: 42, title: '示例剧' }] } };
        throw new stoppedHome.hg.PluginError(code, code);
      } });
      await assert.rejects(() => module_.default(stoppedHome.hg).home.getSections({}, ctx), { code });
      assert.equal(stoppedHome.calls.length, 2);
    }
  } finally {
    Date.now = originalNow;
  }
}
console.log('PASS  播放与镜像串行请求预算、预算耗尽停止请求');

console.log('\n全部模拟用例通过。');
