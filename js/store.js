/* ============================================================
   store.js — 数据层
   职责：数据模型 / 自动保存 / 持久化适配器 / SRS 复习算法 / 统计
   设计要点：持久化通过 Adapter 接口隔离，当前为 LocalAdapter，
   当前默认 LocalAdapter（localStorage）；可扩展其他同步适配器，上层逻辑零改动。
   ============================================================ */

(function (global) {
  'use strict';

  // ---------- 常量 ----------

  const LANGS = {
    en: { key: 'en', name: '英语', short: 'EN', flag: '🇬🇧' },
    ja: { key: 'ja', name: '日语', short: '日', flag: '🇯🇵' },
    ko: { key: 'ko', name: '韩语', short: '한', flag: '🇰🇷' }
  };

  const TYPES = {
    word:     { key: 'word',     name: '单词' },
    phrase:   { key: 'phrase',   name: '短语' },
    sentence: { key: 'sentence', name: '句子' },
    grammar:  { key: 'grammar',  name: '语法' }
  };

  const LEVELS = [
    { v: 0, name: '陌生', color: 'danger' },
    { v: 1, name: '眼熟', color: 'warn' },
    { v: 2, name: '会用', color: 'accent' },
    { v: 3, name: '掌握', color: 'ok' }
  ];

  const SKILLS = [
    { key: 'listening', name: '听力', emoji: '🎧' },
    { key: 'speaking',  name: '口语', emoji: '🗣️' },
    { key: 'reading',   name: '阅读', emoji: '📖' },
    { key: 'writing',   name: '写作', emoji: '✍️' }
  ];

  // 艾宾浩斯遗忘曲线间隔（天）
  const SRS_INTERVALS = [0, 1, 2, 4, 7, 15, 30, 60, 120];

  const STORAGE_KEY = 'lang-workbench-v1';
  // 「最佳快照」键：始终保存本机见过的最完整数据（条目数只增不减），用于同步意外清空本地时自动找回。
  // 与 STORAGE_KEY 分开存储，避免被同步写入的空状态一并覆盖。
  const BEST_KEY = 'lang-workbench-best';
  // 用户主动清空数据时临时置 true，允许把空状态上传到云端（清完让其它设备也清）；平时为 false，拒绝上传空数据。
  let _allowEmptySync = false;

  function readBestState() {
    try {
      const raw = global.localStorage.getItem(BEST_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function readBestN() {
    const b = readBestState();
    return b && Array.isArray(b.entries) ? b.entries.length : 0;
  }
  function writeBestSnapshot(state) {
    try {
      const n = Array.isArray(state.entries) ? state.entries.length : 0;
      if (n >= readBestN()) global.localStorage.setItem(BEST_KEY, JSON.stringify(state)); // 仅当更完整才覆盖，绝不降级
    } catch (e) { /* 无关紧要 */ }
  }

  // ---------- 工具 ----------

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function todayKey(d) {
    const t = d ? new Date(d) : new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const day = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function addDays(dateKey, n) {
    const d = new Date(dateKey + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return todayKey(d);
  }

  function daysBetween(a, b) {
    const d1 = new Date(a + 'T00:00:00');
    const d2 = new Date(b + 'T00:00:00');
    return Math.round((d2 - d1) / 86400000);
  }

  function formatDateLabel(key) {
    const d = new Date(key + 'T00:00:00');
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function weekdayLabel(key) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(key + 'T00:00:00').getDay()];
  }

  function relativeDayLabel(key) {
    const diff = daysBetween(key, todayKey());
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    return null;
  }

  // fetch 带超时，避免 GitHub API 无响应时长时间挂起
  async function fetchWithTimeout(url, options, timeoutMs) {
    timeoutMs = timeoutMs || 12000;
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let id;
    if (controller) {
      id = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const res = await fetch(url, controller ? Object.assign({}, options, { signal: controller.signal }) : options);
      return res;
    } finally {
      if (id) clearTimeout(id);
    }
  }

  // 把 fetch 异常 / HTTP 状态归类为可读类型，避免把「超时/网络」误报成「Token 无效」
  function classifyFetchError(e, status) {
    if (status === 401) return { type: 'auth', message: 'Token 无效或没有 gist 权限（401）' };
    if (status === 403) return { type: 'ratelimit', message: 'GitHub API 限流中（403）' };
    if (status === 404) return { type: 'notfound', message: '同步码对应的 Gist 不存在（404）' };
    if (status != null && status >= 500) return { type: 'server', message: 'GitHub 服务器错误（' + status + '）' };
    if (status != null) return { type: 'http', message: 'GitHub 请求失败（HTTP ' + status + '）' };
    const msg = e && e.message ? e.message : String(e);
    if (/abort|timeout|timed out/i.test(msg) || (e && e.name === 'AbortError')) return { type: 'timeout', message: '连接 GitHub 超时，请检查网络或稍后重试' };
    return { type: 'network', message: '网络异常，无法连接到 GitHub' };
  }

  // ---------- 持久化适配器 ----------

  /**
   * 本地适配器：写入 localStorage。
   * 同步接口保持 Promise 形态，方便无缝替换为云端实现。
   */
  const LocalAdapter = {
    name: 'local',
    async load() {
      try {
        const raw = global.localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.warn('[store] 读取本地数据失败', e);
        return null;
      }
    },
    async save(state) {
      try {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        writeBestSnapshot(state);   // 同步维护「最佳快照」，供意外清空时找回
        return true;
      } catch (e) {
        console.error('[store] 保存失败', e);
        return false;
      }
    }
  };

  // GitHub Gist 同步适配器（免费、零服务器；浏览器直连 api.github.com，CORS 已验证支持）
  const GistAdapter = {
    name: 'gist',
    ready: false,
    error: null,
    _token: '',
    _gistId: '',
    _rateLimitedUntil: 0,   // GitHub API 限流恢复时间戳（ms）；限流期间直接跳过请求，避免进一步消耗配额
    _lastErrorType: '',     // 最近一次失败类型：timeout/network/ratelimit/auth/notfound/http/server

    async init(cfg) {
      const token = (cfg && cfg.token) || '';
      const key = (cfg && cfg.key) || '';
      if (!token) { this.ready = false; this.error = '缺少 GitHub Token'; return false; }
      if (!key) { this.ready = false; this.error = '缺少同步码（Gist ID）'; return false; }
      this._token = token;
      this._gistId = key;
      this.ready = true;
      this.error = null;
      return true;
    },

    async load() {
      if (!this.ready) return null;
      this._lastErrorType = '';
      // 限流中：跳过读取请求（与保存一致），避免进一步消耗配额；本地镜像仍可用
      if (this._rateLimitedUntil && Date.now() < this._rateLimitedUntil) { this._lastErrorType = 'ratelimit'; return null; }
      // 重试：GitHub API 偶发超时/网络抖动，多试两次能显著提高「启动时拉回云端好数据」的成功率
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetchWithTimeout('https://api.github.com/gists/' + this._gistId, {
            headers: { 'Authorization': 'Bearer ' + this._token, 'Accept': 'application/vnd.github+json' }
          }, attempt === 0 ? 12000 : 8000);
          if (res.status === 404) { this._lastErrorType = 'notfound'; return null; }
          if (!res.ok) {
            const t = await res.text().catch(() => '');
            const err = classifyFetchError(new Error(t), res.status);
            this._lastErrorType = err.type;
            this.error = err.message;
            lastErr = err;
            // 401/404/限流属确定性失败，重试无意义，直接返回
            if (err.type === 'auth' || err.type === 'notfound' || err.type === 'ratelimit') return null;
            continue;   // 其它（超时/网络/5xx）重试
          }
          const data = await res.json();
          const file = data && data.files && data.files['langworkbench_state.json'];
          if (!file || file.content == null) return null;
          this.error = null;
          this._lastErrorType = '';
          return JSON.parse(file.content);
        } catch (e) {
          const err = classifyFetchError(e, null);
          this._lastErrorType = err.type;
          this.error = err.message;
          lastErr = err;
          continue;   // 超时/网络抖动重试
        }
      }
      if (lastErr && lastErr.type === 'timeout') this._lastErrorType = 'timeout';
      return null;
    },

    // 上传到 Gist 前剥离全部凭证（Token、同步码、AI Key），避免把凭证明文写进 Gist 文件。
    // 凭证只存本机、永不上云：因此新设备打开不会有任何填写内容（需手动填写同一个 Token+同步码才能同步）。
    _safePayload(state) {
      const safe = JSON.parse(JSON.stringify(state));
      if (safe && safe.settings) {
        safe.settings.gistToken = '';
        safe.settings.gistKey = '';
      }
      if (safe && safe.settings && safe.settings.ai) { safe.settings.ai.apiKey = ''; }
      return safe;
    },

    async save(state) {
      if (!this.ready) return false;
      this._lastErrorType = '';
      // GitHub API 限流中：跳过请求，避免进一步消耗配额（_rateLimitedUntil 由上次 403 设置）
      if (this._rateLimitedUntil && Date.now() < this._rateLimitedUntil) { this._lastErrorType = 'ratelimit'; return false; }
      // 防丢兜底：本机曾有过数据（最佳快照非空）却要上传空状态 → 拒绝，避免把云端所有设备一并清空。
      // 仅用户主动清空（_allowEmptySync=true 或 state.clearedAt 有标记）时才放行。
      const stateCleared = state && Number(state.clearedAt) > 0;
      if (!_allowEmptySync && !stateCleared) {
        const n = (state && state.entries) ? state.entries.length : 0;
        if (n === 0 && readBestN() > 0) {
          this._lastErrorType = 'emptyguard';
          this.error = '已阻止上传空数据（避免清空云端所有设备），你本机仍有备份';
          console.warn('[GistAdapter] 拒绝上传空数据');
          return false;
        }
      }
      const content = JSON.stringify(this._safePayload(state));
      try {
        const res = await fetchWithTimeout('https://api.github.com/gists/' + this._gistId, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + this._token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
          body: JSON.stringify({ files: { 'langworkbench_state.json': { content } } })
        });
        if (res.status === 403) {
          const t = await res.text().catch(() => '');
          if (/rate limit/i.test(t)) {
            const reset = Number(res.headers.get('X-RateLimit-Reset')) || 0;
            this._rateLimitedUntil = reset ? reset * 1000 : Date.now() + 60 * 60 * 1000;
            this._lastErrorType = 'ratelimit';
            this.error = 'GitHub API 限流中（约 ' + Math.ceil((this._rateLimitedUntil - Date.now()) / 60000) + ' 分钟后恢复）';
            console.warn('[GistAdapter] 触发限流，预计恢复', new Date(this._rateLimitedUntil).toLocaleTimeString());
            return false;
          }
          const err = classifyFetchError(new Error(t), 403);
          this._lastErrorType = err.type;
          this.error = err.message;
          return false;
        }
        if (!res.ok) {
          const t2 = await res.text().catch(() => '');
          const err = classifyFetchError(new Error(t2), res.status);
          this._lastErrorType = err.type;
          this.error = err.message;
          return false;
        }
        this._rateLimitedUntil = 0;   // 成功即清除限流标记
        this.error = null;
        this._lastErrorType = '';
        return true;
      } catch (e) {
        const err = classifyFetchError(e, null);
        this._lastErrorType = err.type;
        this.error = err.message;
        console.warn('[GistAdapter] 保存失败', e);
        return false;
      }
    },

    // 创建新 Gist（首次开启且未提供同步码时调用），返回 gist id
    async create(token, state) {
      this._lastErrorType = '';
      try {
        const res = await fetchWithTimeout('https://api.github.com/gists', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
          body: JSON.stringify({ description: 'lang-workbench sync', public: false, files: { 'langworkbench_state.json': { content: JSON.stringify(this._safePayload(state)) } } })
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          const err = classifyFetchError(new Error(t), res.status);
          this._lastErrorType = err.type;
          this.error = err.message;
          return null;
        }
        this.error = null;
        const data = await res.json();
        return data.id || null;
      } catch (e) {
        const err = classifyFetchError(e, null);
        this._lastErrorType = err.type;
        this.error = err.message;
        return null;
      }
    },

    // 轮询订阅（Gist 无 WebSocket，用 20s 轮询模拟近实时同步）
    subscribe(cb) {
      if (!this.ready) return () => {};
      let last = '';
      const tick = async () => {
        try {
          const res = await fetchWithTimeout('https://api.github.com/gists/' + this._gistId, {
            headers: { 'Authorization': 'Bearer ' + this._token, 'Accept': 'application/vnd.github+json' }
          }, 8000);
          if (!res.ok) return;
          const data = await res.json();
          const file = data.files && data.files['langworkbench_state.json'];
          if (!file || file.content == null) return;
          const h = file.content.length + ':' + file.content.slice(0, 64);
          if (h !== last) { last = h; try { cb(JSON.parse(file.content)); } catch (e) {} }
        } catch (e) { /* ignore */ }
      };
      const iv = setInterval(tick, 20000);
      return () => clearInterval(iv);
    }
  };

  // ---------- 默认状态 ----------

  function defaultState() {
    return {
      version: 1,
      entries: [],          // 学习条目
      checkins: {},         // { '2026-08-09': { listening:true, speaking:false, reading:true, writing:false, minutes:30, completed:false } }
      settings: {
        theme: 'light',
        activeLang: 'all',
        dailyGoal: 10,                          // 每日每语言词量
        difficulty: { en: 3, ja: 1, ko: 1 },    // 各语言难度上限：en=混合全部 / ja,ko=入门起点
        gistSync: false,                        // 是否启用 GitHub Gist 同步
        gistToken: '',                          // GitHub Personal Access Token（仅勾 gist 权限）
        gistKey: '',                            // 同步码 = Gist ID（多端共用同一码即共享同一份数据）
        ai: { enabled: false, baseUrl: '', apiKey: '', model: '' }  // AI 辅助（浏览器直连 OpenAI 兼容接口）
      },
      learnSession: null,    // 今日学习会话（持久化 + 可同步）：{ date, themes, salt, focus, order, idx, langDone, langCheckedIn, dur, added[], judged }
      clearedAt: 0,          // 最近一次用户主动清空数据的时间戳（同步用：其他设备拉到该标记时也执行清空）
      clearedAck: 0,         // 本机已确认处理的清空时间戳（防止重复清空）
      updatedAt: Date.now()
    };
  }

  // ---------- Store ----------

  const Store = {
    state: defaultState(),
    adapter: LocalAdapter,
    _listeners: [],
    _saveTimer: null,
    _status: 'idle',      // idle | saving | saved | offline
    _statusListeners: [],
    _gistError: null,     // GitHub 同步最近一次错误
    _gistEnabled: false,
    _gistUnsub: null,
    onRemote: null,       // 云端推送远端状态时的回调（app 用于重渲染）

    // ===== 生命周期 =====

    async init() {
      let loaded = await this.adapter.load();
      if (loaded && typeof loaded === 'object') {
        this.state = Object.assign(defaultState(), loaded);
        this.state.settings = Object.assign(defaultState().settings, loaded.settings || {});
      }
      // 防丢兜底：主数据被同步意外清空（条目/打卡/会话全空），但「最佳快照」仍有数据 → 自动从快照恢复，
      // 避免一次同步抖动就把全部学习记录抹掉且无法找回。
      // 例外：如果 clearedAck >= clearedAt > 0，说明用户已主动清空过数据，不应从快照恢复已删数据。
      const best = readBestState();
      const mainEmpty = (!this.state.entries || this.state.entries.length === 0)
        && (!this.state.checkins || Object.keys(this.state.checkins).length === 0)
        && !this.state.learnSession;
      const userCleared = (Number(this.state.clearedAck) || 0) >= (Number(this.state.clearedAt) || 0) && (Number(this.state.clearedAt) || 0) > 0;
      const bestHas = best && Array.isArray(best.entries)
        && (best.entries.length > 0 || (best.checkins && Object.keys(best.checkins).length > 0));
      if (mainEmpty && bestHas && !userCleared) {
        this.state = Object.assign(defaultState(), best);
        this.state.settings = Object.assign(defaultState().settings, best.settings || {});
        this._recoveredFromBest = true;
      }
      this._migrate();
      return this.state;
    },

    /** 本机是否存在可恢复的「最佳快照」（供 UI 提示用户数据已自动找回） */
    hasRecoveredData() {
      return !!this._recoveredFromBest;
    },

    /** 用户主动清空（清记录 / 清空全部）时调用：放行一次空数据上传，并清除最佳快照以免复活已删数据 */
    signalClearSync() {
      _allowEmptySync = true;
      try { if (global.localStorage) global.localStorage.removeItem(BEST_KEY); } catch (e) {}
      setTimeout(() => { _allowEmptySync = false; }, 5000);
    },

    _migrate() {
      // 保证每条数据结构完整，避免旧数据缺字段导致渲染异常
      this.state.entries.forEach(e => {
        if (!LANGS[e.lang]) e.lang = 'en';   // 修复非法/缺失的语言字段，避免渲染崩溃
        if (!e.srs) e.srs = { stage: 0, nextReview: todayKey(), reviews: 0, lapses: 0 };
        if (typeof e.level !== 'number') e.level = 0;
        if (!Array.isArray(e.tags)) e.tags = [];
        if (e._bankId === undefined) e._bankId = '';
        if (!e.dateKey) e.dateKey = todayKey(e.createdAt || Date.now());
        // 兼容旧数据：新增 learned 标记；只有被复习过（reviews>0）的旧条目才视为已学，否则不算
        if (typeof e.learned !== 'boolean') e.learned = !!(e.srs && e.srs.reviews > 0);
        // 学习(真实点击)时间：用于统计「今日已学习」；旧数据无记录则回退到创建时间
        if (typeof e.learnedAt !== 'number') e.learnedAt = e.learned ? (e.createdAt || 0) : 0;
      });

      // 兼容旧版：checkins 由「按语言」改为「按技能(听说读写)全局」
      for (const dk in this.state.checkins) {
        const rec = this.state.checkins[dk];
        if (rec && (rec.en || rec.ja || rec.ko)) {
          const fixed = { listening: false, speaking: false, reading: false, writing: false, minutes: 0, studySeconds: 0 };
          for (const lg of ['en', 'ja', 'ko']) {
            const lr = rec[lg];
            if (lr) {
              SKILLS.forEach(s => { if (lr[s.key]) fixed[s.key] = true; });
              fixed.minutes += Number(lr.minutes) || 0;
            }
          }
          this.state.checkins[dk] = fixed;
        } else if (rec && typeof rec === 'object') {
          ['listening', 'speaking', 'reading', 'writing'].forEach(k => {
            if (typeof rec[k] !== 'boolean') rec[k] = false;
          });
          if (typeof rec.minutes !== 'number') rec.minutes = 0;
          if (typeof rec.studySeconds !== 'number') rec.studySeconds = 0;
          if (typeof rec.completed !== 'boolean') rec.completed = false;
        }
      }
      this._fixLearnSession();
    },

    useAdapter(adapter) {
      this.adapter = adapter;
      return this;
    },

    /**
     * 远端状态合并（首次接入远端同步时使用）：保留本地尚未上云的记录，避免接入即丢数据。
     * - 条目：远端优先，并集（按 id 去重）。
     * - 打卡：布尔 OR，分钟取最大。
     */
    _mergeForCloud(remote) {
      // 远端执行了主动清空（clearedAt 比本机 clearedAck 新）→ 本机也清空，不做并集
      const remoteCleared = Number(remote && remote.clearedAt) || 0;
      const localAck = Number(this.state.clearedAck) || 0;
      if (remoteCleared > localAck) {
        try { if (global.localStorage) global.localStorage.removeItem(BEST_KEY); } catch (e) {}
        const cleared = defaultState();
        cleared.clearedAt = remoteCleared;
        cleared.clearedAck = remoteCleared;
        cleared.settings = Object.assign(defaultState().settings, this.state.settings || {});
        this._fixLearnSession(cleared);
        return cleared;
      }
      const base = Object.assign(defaultState(), remote);
      base.settings = Object.assign(defaultState().settings, remote.settings || {});
      const remoteIds = new Set((remote.entries || []).map(e => e.id));
      const localOnly = (this.state.entries || []).filter(e => e.id && !remoteIds.has(e.id));
      base.entries = (remote.entries || []).concat(localOnly);
      const ck = {};
      const dks = new Set([].concat(Object.keys(base.checkins || {}), Object.keys(this.state.checkins || {})));
      dks.forEach(dk => {
        const lc = this.state.checkins[dk] || {};
        const rc = base.checkins[dk] || {};
        ck[dk] = {
          listening: !!(lc.listening || rc.listening),
          speaking: !!(lc.speaking || rc.speaking),
          reading: !!(lc.reading || rc.reading),
          writing: !!(lc.writing || rc.writing),
          minutes: Math.max(Number(lc.minutes) || 0, Number(rc.minutes) || 0)
        };
      });
      base.checkins = ck;
      // 今日学习会话（心情词包/打卡进度）：本地优先，避免接入同步时把刚生成的会话丢掉
      if (this.state.learnSession && this.state.learnSession.date === todayKey()) {
        base.learnSession = this.state.learnSession;
      }
      this._fixLearnSession(base);
      return base;
    },

    /** 把当前状态镜像写一份到 localStorage，作为云端不可达时的离线缓存。 */
    _mirrorLocal() {
      try { LocalAdapter.save(this.state); } catch (e) { /* 缓存失败不影响主流程 */ }
    },

    /**
     * 应用远端推送（实时同步 / 手动同步拉取）。
     * 关键：合并（并集）而非整篇替换——本地条目、打卡、今日会话永不因云端为空/陈旧而丢失。
     *  - 条目：按 id 并集，冲突取 updatedAt 较新者；
     *  - 打卡：按天并集，布尔 OR、分钟取最大（与 _mergeForCloud 一致）；
     *  - 设置：以云端为准，但本地 Token/同步码/AI Key 始终保留（云端已剥离凭证）；
     *  - 今日会话：仅当云端会话「严格更新」时才采用云端，否则保留本地（云端为空也不再清空本地）。
     * 回声去重：远端 updatedAt 与本地相同则跳过，避免 save→watch 死循环。
     */
    _applyRemote(remoteState) {
      if (!remoteState || typeof remoteState !== 'object') return false;
      if (remoteState.updatedAt && this.state.updatedAt === remoteState.updatedAt) return false; // 回声去重

      // 远端执行了主动清空（clearedAt 比本机 clearedAck 新）→ 本机也清空，不做并集合并
      const remoteCleared = Number(remoteState.clearedAt) || 0;
      const localAck = Number(this.state.clearedAck) || 0;
      if (remoteCleared > localAck) {
        this.state.entries = [];
        this.state.checkins = {};
        this.state.learnSession = null;
        this.state.clearedAt = remoteCleared;
        this.state.clearedAck = remoteCleared;
        try { if (global.localStorage) global.localStorage.removeItem(BEST_KEY); } catch (e) {}
        this._mirrorLocal();
        return true;
      }

      const keepToken = this.state.settings.gistToken;   // 远端 Gist 不含 token，保留本地凭证避免刷新后重连失败
      const keepKey = this.state.settings.gistKey;
      const keepAiKey = (this.state.settings.ai && this.state.settings.ai.apiKey) || ''; // AI Key 仅存本机，不被远端（已剥离）覆盖

      // 条目：并集（按 id 去重），冲突取 updatedAt 较新的一方，绝不因云端为空/陈旧而清空本地条目
      const byId = new Map();
      (this.state.entries || []).forEach(e => { if (e && e.id) byId.set(e.id, e); });
      (Array.isArray(remoteState.entries) ? remoteState.entries : []).forEach(e => {
        if (!e || !e.id) return;
        const local = byId.get(e.id);
        if (!local) byId.set(e.id, e);                                          // 远端独有条目 → 加入
        else if ((e.updatedAt || 0) > (local.updatedAt || 0)) byId.set(e.id, e); // 远端更新 → 采用
      });
      const mergedEntries = Array.from(byId.values());

      // 打卡：按天并集，布尔 OR、分钟取最大（与 _mergeForCloud 一致）
      const ck = {};
      const dks = new Set([].concat(Object.keys(this.state.checkins || {}), Object.keys(remoteState.checkins || {})));
      dks.forEach(dk => {
        const lc = (this.state.checkins || {})[dk] || {};
        const rc = (remoteState.checkins || {})[dk] || {};
        ck[dk] = {
          listening: !!(lc.listening || rc.listening),
          speaking: !!(lc.speaking || rc.speaking),
          reading: !!(lc.reading || rc.reading),
          writing: !!(lc.writing || rc.writing),
          minutes: Math.max(Number(lc.minutes) || 0, Number(rc.minutes) || 0)
        };
      });

      // 设置：以云端为准，但本地 Token/同步码/AI Key 始终保留（云端已剥离凭证，不会被覆盖清空）
      const mergedSettings = Object.assign(defaultState().settings, remoteState.settings || {}, {
        gistToken: keepToken,
        gistKey: keepKey,
        ai: Object.assign({}, (remoteState.settings && remoteState.settings.ai) || {}, { apiKey: keepAiKey })
      });

      // 组装新 state：先继承本地全部字段，再用「云端合并结果」覆盖条目/打卡/设置——本地独有数据因此保留
      const merged = Object.assign(defaultState(), this.state, remoteState, {
        entries: mergedEntries,
        checkins: ck,
        settings: mergedSettings
      });

      // 今日学习会话冲突解决：仅当云端会话「严格更新」时才采用云端；否则保留本地，
      // 避免刚生成的词包被空/旧云端数据打回（修复：云端为空时不再清空本地会话 → 生成今日学习才有效）。
      const localLS = this.state.learnSession;
      const remoteLS = remoteState.learnSession;
      const localLSUpdated = (localLS && typeof localLS === 'object') ? (localLS.updatedAt || 0) : -1;
      const remoteLSUpdated = (remoteLS && typeof remoteLS === 'object') ? (remoteLS.updatedAt || 0) : -1;
      if (remoteLS && typeof remoteLS === 'object' && remoteLSUpdated > localLSUpdated) {
        merged.learnSession = remoteLS;
      } else {
        merged.learnSession = localLS;   // 云端为空或不过新 → 保留本地
      }
      this._fixLearnSession(merged);
      this.state = merged;
      this._migrate();
      this._mirrorLocal();       // 镜像到本地，云端离线也能恢复
      return true;
    },

    /** 修正 learnSession 中可能为 null/undefined 的字段，避免渲染端崩溃 */
    _fixLearnSession(state) {
      state = state || this.state;
      const ls = state.learnSession;
      if (!ls || typeof ls !== 'object') return;
      if (!ls.dur || typeof ls.dur !== 'object') ls.dur = { en: 0, ja: 0, ko: 0 };
      ['en', 'ja', 'ko'].forEach(lg => { if (typeof ls.dur[lg] !== 'number') ls.dur[lg] = 0; });
      if (!Array.isArray(ls.themes)) ls.themes = [];
      if (typeof ls.salt !== 'number') ls.salt = 0;
      if (!Array.isArray(ls.added)) ls.added = [];
      if (!ls.judged || typeof ls.judged !== 'object') ls.judged = {};
      if (!Array.isArray(ls.order)) ls.order = ['en', 'ja', 'ko'];
      if (typeof ls.idx !== 'number') ls.idx = 0;
      if (!ls.focus) ls.focus = 'en';
      if (typeof ls.updatedAt !== 'number') ls.updatedAt = 0;   // 会话时间戳（用于跨端冲突解决）
      if (!ls.langDone || typeof ls.langDone !== 'object') ls.langDone = { en: false, ja: false, ko: false };
      if (!ls.langCheckedIn || typeof ls.langCheckedIn !== 'object') ls.langCheckedIn = { en: false, ja: false, ko: false };
    },


    /**
     * 启用 GitHub Gist 同步（免费、零服务器）：初始化 GistAdapter → 拉取远端（合并）→ 轮询订阅近实时变更。
     * token 为 GitHub Personal Access Token（仅 gist 权限）。key 为 Gist ID（同步码）；为空则自动创建新 Gist。
     *
     * 重要：超时 / 网络抖动 / GitHub 限流 等临时失败时，不再直接断开同步，而是保持 Gist 适配器并进入自动重试，
     * 避免「提示的恢复时间还没到就把同步开关断开」的体验问题。只有 401/404 等不可逆错误才降级到本地。
     */
    async enableGist(token, key) {
      token = (token || '').trim();
      key = (key || '').trim();
      const keepAiKey = (this.state.settings.ai && this.state.settings.ai.apiKey) || ''; // 连接同步前先暂存本地 AI Key
      if (!token) { this._gistError = '缺少 GitHub Token'; return false; }
      this._gistError = null;
      let isNew = false;
      if (!key) {
        const created = await GistAdapter.create(token, this.state);
        if (!created) { this._gistError = GistAdapter.error || '创建 Gist 失败'; return false; }
        key = created;
        isNew = true;
        this.state.settings.gistKey = key;
        this.state.settings.gistToken = token;
        this.commit();
      }
      const ok = await GistAdapter.init({ token, key });
      if (!ok) { this._gistError = GistAdapter.error; return false; }
      this.useAdapter(GistAdapter);

      // 临时失败类型：保持连接、自动重试； auth/notfound 等才降级本地
      const tempFail = new Set(['timeout', 'network', 'ratelimit']);
      const keepGistAndRetry = (type) => {
        this._gistEnabled = true;
        this.state.settings.gistToken = token;
        this.state.settings.gistKey = key;
        this.state.settings.ai = Object.assign({}, this.state.settings.ai || {}, { apiKey: (this.state.settings.ai && this.state.settings.ai.apiKey) || keepAiKey });
        this._setStatus(type === 'ratelimit' ? 'ratelimit' : 'offline');
        if (type === 'ratelimit') this._scheduleRateLimitRetry();
        else this._scheduleRetry();
        this._mirrorLocal();
      };

      // 轮询订阅尽早启动：即使本次拉取/写入因超时/限流失败，恢复后也能自动同步
      if (this._gistUnsub) { try { this._gistUnsub(); } catch (e) {} }
      this._gistUnsub = GistAdapter.subscribe((remoteState) => {
        if (this._applyRemote(remoteState)) {
          this._emit();
          if (this.onRemote) this.onRemote();
        }
      });

      if (isNew) {
        // 新建的 Gist 内容为空，必须先把本地数据上传，否则下次读取空内容会覆盖本地
        const okSave = await GistAdapter.save(this.state);
        if (!okSave) {
          const type = GistAdapter._lastErrorType;
          if (tempFail.has(type)) { keepGistAndRetry(type); return true; }
          this._gistError = '写入 Gist 失败（' + (GistAdapter.error || '未知') + '）';
          this.useAdapter(LocalAdapter);
          return false;
        }
        this._mirrorLocal();
      } else {
        // 连接已有 Gist：先拉取远端并合并（保留本地独有条目），再把合并后的完整数据写回云端，实现双向同步
        const remote = await GistAdapter.load();
        const loadType = GistAdapter._lastErrorType;
        if (remote && typeof remote === 'object') {
          this.state = this._mergeForCloud(remote);
        } else if (tempFail.has(loadType)) {
          // 拉取云端失败但凭证有效：保持 Gist 连接，稍后自动重试，避免一次超时/限流就断开同步
          keepGistAndRetry(loadType);
          return true;
        }
        this.state.settings.gistToken = token;   // 防止被云端剥离后的空 token 覆盖，刷新后才能正常重连
        this.state.settings.gistKey = key;
        // 远端 Gist 的 ai.apiKey 为空（已剥离），用本地 Key 覆盖，避免连接同步清空本地 AI Key
        this.state.settings.ai = Object.assign({}, this.state.settings.ai || {}, { apiKey: (this.state.settings.ai && this.state.settings.ai.apiKey) || keepAiKey });
        this._migrate();
        const okSave = await GistAdapter.save(this.state);
        if (!okSave) {
          const type = GistAdapter._lastErrorType;
          if (tempFail.has(type)) { keepGistAndRetry(type); return true; }
          this._gistError = '写入 Gist 失败（' + (GistAdapter.error || '未知') + '）';
          this.useAdapter(LocalAdapter);
          return false;
        }
        this.commit();
        this._mirrorLocal();
      }
      this._gistEnabled = true;
      this._gistError = null;
      return true;
    },

    /** 关闭 GitHub 同步，切回本地。同时清除本地保存的 Token/同步码（云端 Gist 不删，下次需重填才能重新同步）。 */
    disableGist() {
      if (this._gistUnsub) { try { this._gistUnsub(); } catch (e) {} this._gistUnsub = null; }
      this.useAdapter(LocalAdapter);
      this._gistEnabled = false;
      this.state.settings.gistToken = '';
      this.state.settings.gistKey = '';
      this.commit();
      return true;
    },

    /**
     * 仅断开同步（停止轮询、切回本地），但【保留】已填写的 Token/同步码。
     * 用于「手动关闭同步开关」：断开连接但不清空用户填写内容，再次开启时可自动重连。
     * 与 disableGist() 的区别：disableGist 会清空凭证（用于失败/清除数据等需要彻底重置的场景）。
     */
    disableGistKeep() {
      if (this._gistUnsub) { try { this._gistUnsub(); } catch (e) {} this._gistUnsub = null; }
      this.useAdapter(LocalAdapter);
      this._gistEnabled = false;
      this.commit();
      return true;
    },

    // ===== 订阅 =====

    subscribe(fn) {
      this._listeners.push(fn);
      return () => {
        this._listeners = this._listeners.filter(f => f !== fn);
      };
    },

    onStatus(fn) {
      this._statusListeners.push(fn);
      fn(this._status);
    },

    _setStatus(s) {
      this._status = s;
      this._statusListeners.forEach(f => f(s));
    },

    _emit() {
      this._listeners.forEach(f => f(this.state));
    },

    /**
     * 自动保存：任何数据变更都会触发，300ms 防抖。
     * 用户无需点击"保存"，关闭应用后数据不丢失。
     */
    _autosave() {
      this.state.updatedAt = Date.now();
      const adapter = this.adapter;
      // GitHub API 限流中：跳过本次上传与重试，状态提示等待恢复（避免无谓请求进一步消耗配额）
      if (adapter && adapter._rateLimitedUntil && Date.now() < adapter._rateLimitedUntil) {
        this._setStatus('ratelimit');
        this._mirrorLocal();   // 仍更新本地镜像，确保本地不丢数据（云端恢复后自动补传）
        return;
      }
      this._setStatus('saving');
      clearTimeout(this._saveTimer);
      // 防抖 2.5s：合并短时间内的连续操作，显著降低 GitHub API 请求频次，避免触发限流
      this._saveTimer = setTimeout(async () => {
        const ok = await adapter.save(this.state);
        if (ok) {
          this._setStatus('saved');
          this._mirrorLocal();       // 始终保留一份本地缓存（云端不可达时可用）
        } else if (adapter && adapter._rateLimitedUntil && Date.now() < adapter._rateLimitedUntil) {
          this._setStatus('ratelimit');
          this._mirrorLocal();
          this._scheduleRateLimitRetry();   // 限流中：等 reset 后自动补传，不消耗额外配额
        } else {
          this._setStatus('offline');
          this._mirrorLocal();
          this._scheduleRetry();     // 瞬时网络失败：自动重试，无需用户操作
        }
      }, 2500);
    },

    // 上传失败后自动重试（指数退避，最多数次），应对 GitHub API / 网络的瞬时抖动。
    // 同步开关被关闭（切回本地）后自动停止，避免无谓请求。限流期间不进入此重试路径。
    _scheduleRetry() {
      if (this._retryTimer || this._gistEnabled === false) return;
      const adapter = this.adapter;
      let attempt = 0;
      const tryOnce = async () => {
        if (this._gistEnabled === false) { this._retryTimer = null; return; }
        // 限流中：放弃重试，交给定时补传逻辑（_scheduleRateLimitRetry）
        if (adapter && adapter._rateLimitedUntil && Date.now() < adapter._rateLimitedUntil) { this._retryTimer = null; return; }
        const ok = await adapter.save(this.state);
        if (ok) { this._setStatus('saved'); this._mirrorLocal(); this._retryTimer = null; return; }
        attempt++;
        if (attempt >= 6) { this._retryTimer = null; return; }
        this._retryTimer = setTimeout(tryOnce, Math.min(30000, 4000 * attempt));
      };
      this._retryTimer = setTimeout(tryOnce, 4000);
    },

    // 限流专用补传：等到 GitHub 限流恢复时间戳（X-RateLimit-Reset）之后再补传一次，避免重试消耗配额
    _scheduleRateLimitRetry() {
      if (this._retryTimer || this._gistEnabled === false) return;
      const adapter = this.adapter;
      const wait = Math.max(2000, (adapter && adapter._rateLimitedUntil ? adapter._rateLimitedUntil : Date.now() + 60000) - Date.now());
      this._retryTimer = setTimeout(async () => {
        this._retryTimer = null;
        if (this._gistEnabled === false) return;
        const ok = await adapter.save(this.state);
        if (ok) { this._setStatus('saved'); this._mirrorLocal(); }
        else if (adapter && adapter._rateLimitedUntil && Date.now() < adapter._rateLimitedUntil) { this._setStatus('ratelimit'); this._scheduleRateLimitRetry(); }
        else { this._setStatus('offline'); this._scheduleRetry(); }
      }, wait);
    },

    /** 立即落盘（页面隐藏/关闭前调用，防止防抖窗口内丢数据） */
    async flush() {
      clearTimeout(this._saveTimer);
      const adapter = this.adapter;
      // 限流中强制落盘意义不大（会失败），但本地镜像已在 _autosave/mirrorLocal 中更新，不会丢数据
      if (adapter && adapter._rateLimitedUntil && Date.now() < adapter._rateLimitedUntil) {
        this._setStatus('ratelimit');
        this._mirrorLocal();
        return false;
      }
      const ok = await adapter.save(this.state);
      this._setStatus(ok ? 'saved' : (adapter && adapter._rateLimitedUntil ? 'ratelimit' : 'offline'));
      return ok;
    },

    commit() {
      this._autosave();
      this._emit();
    },

    // ===== 条目 CRUD =====

    addEntry(data) {
      const now = Date.now();
      const entry = {
        id: uid(),
        lang: data.lang || 'en',
        type: data.type || 'word',
        text: (data.text || '').trim(),
        reading: (data.reading || '').trim(),
        pitch: (data.pitch || '').trim(),      // 日语声调
        romaji: (data.romaji || '').trim(),    // 日语罗马音（AI/手动补充，主题词库无）
        hanja: (data.hanja || '').trim(),      // 韩语汉字词
        pos: (data.pos || '').trim(),          // 词性
        meaning: (data.meaning || '').trim(),
        example: (data.example || '').trim(),
        exampleTrans: (data.exampleTrans || '').trim(),
        source: (data.source || '').trim(),
        note: (data.note || '').trim(),
        tags: Array.isArray(data.tags) ? data.tags : parseTags(data.tags),
        cn: (data.cn || '').trim(),
        groupId: (data.groupId || '').trim(),
        level: typeof data.level === 'number' ? data.level : 0,
        learned: data.learned === true,   // 是否已被用户主动学习过；只有点过「认识/不认识」才置 true
        learnedAt: data.learned === true ? (data.learnedAt || now) : 0,   // 真实学习(点击)时间，用于「今日已学习」
        createdAt: now,
        updatedAt: now,
        dateKey: todayKey(now),
        _bankId: (data.bankId || '').trim(),
        srs: { stage: 0, nextReview: todayKey(now), reviews: 0, lapses: 0 }
      };
      this.state.entries.unshift(entry);
      this.commit();
      return entry;
    },

    addEntries(list) {
      const created = [];
      list.forEach(d => {
        const now = Date.now();
        created.push({
          id: uid(),
          lang: d.lang || 'en',
          type: d.type || 'word',
          text: (d.text || '').trim(),
          reading: (d.reading || '').trim(),
          pitch: (d.pitch || '').trim(),
          romaji: (d.romaji || '').trim(),
          hanja: (d.hanja || '').trim(),
          pos: (d.pos || '').trim(),
          meaning: (d.meaning || '').trim(),
          example: (d.example || '').trim(),
          exampleTrans: (d.exampleTrans || '').trim(),
          source: (d.source || '').trim(),
          note: '',
          tags: Array.isArray(d.tags) ? d.tags : parseTags(d.tags),
          cn: (d.cn || '').trim(),
          groupId: (d.groupId || '').trim(),
          level: 0,
          learned: d.learned === true,
          learnedAt: d.learned === true ? (d.learnedAt || now) : 0,
          createdAt: now,
          updatedAt: now,
          dateKey: todayKey(now),
          srs: { stage: 0, nextReview: todayKey(now), reviews: 0, lapses: 0 }
        });
      });
      this.state.entries = created.concat(this.state.entries);
      this.commit();
      return created;
    },

    updateEntry(id, patch) {
      const e = this.state.entries.find(x => x.id === id);
      if (!e) return null;
      Object.assign(e, patch, { updatedAt: Date.now() });
      // 标记为已学(真实点击)时记录学习时刻，用于统计「今日已学习」
      if (patch.learned === true) {
        e.learnedAt = (typeof patch.learnedAt === 'number' && patch.learnedAt) ? patch.learnedAt : Date.now();
      }
      if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
        e.tags = parseTags(patch.tags);
      }
      this.commit();
      return e;
    },

    removeEntry(id) {
      this.state.entries = this.state.entries.filter(x => x.id !== id);
      this.commit();
    },

    getEntry(id) {
      return this.state.entries.find(x => x.id === id) || null;
    },

    // ===== 打卡（听说读写，按天） =====

    _checkin(key) {
      if (!this.state.checkins[key]) {
        this.state.checkins[key] = { listening: false, speaking: false, reading: false, writing: false, minutes: 0, studySeconds: 0, completed: false };
      }
      return this.state.checkins[key];
    },

    toggleCheckin(skill, dateKey) {
      const key = dateKey || todayKey();
      const rec = this._checkin(key);
      rec[skill] = !rec[skill];
      this.commit();
      return rec[skill];
    },

    setCheckinMinutes(minutes, dateKey) {
      const key = dateKey || todayKey();
      this._checkin(key).minutes = minutes;
      this.commit();
    },

    // 累加「自动学习计时」产生的秒数（与手动填写的 minutes 分开累计，避免互相覆盖）
    addStudySeconds(sec, dateKey) {
      const key = dateKey || todayKey();
      const rec = this._checkin(key);
      rec.studySeconds = (rec.studySeconds || 0) + (sec | 0);
      this.commit();
    },

    setCheckinCompleted(dateKey) {
      const key = dateKey || todayKey();
      this._checkin(key).completed = true;
      this.commit();
    },

    getCheckin(dateKey) {
      const key = dateKey || todayKey();
      return Object.assign(
        { listening: false, speaking: false, reading: false, writing: false, minutes: 0, studySeconds: 0, completed: false },
        this.state.checkins[key] || {}
      );
    },

    /** 某天是否有任何学习活动（打卡或新增已学条目） */
    hasActivity(dateKey) {
      const c = this.state.checkins[dateKey];
      if (c) {
        if (c.completed) return true;
        if (SKILLS.some(s => c[s.key])) return true;
        if ((c.minutes || 0) > 0) return true;
      }
      return this.state.entries.some(e => e.learned && e.dateKey === dateKey);
    },

    /** 某天的活动强度 0-4，用于热力图 */
    activityLevel(dateKey) {
      const count = this.state.entries.filter(e => e.learned && e.dateKey === dateKey).length;
      const c = this.state.checkins[dateKey] || {};
      const skills = SKILLS.filter(s => c[s.key]).length;
      const minutes = Number(c.minutes) || 0;
      const score = count + skills * 2 + Math.floor(minutes / 15);
      if (score === 0) return 0;
      if (score <= 3) return 1;
      if (score <= 8) return 2;
      if (score <= 15) return 3;
      return 4;
    },

    // ===== SRS 复习算法（艾宾浩斯间隔重复） =====

    dueEntries(lang) {
      const today = todayKey();
      return this.state.entries.filter(e => {
        if (!e.learned) return false;   // 只有用户主动学过的词才进入复习队列
        if (lang && lang !== 'all' && e.lang !== lang) return false;
        if (e.level >= 3 && e.srs.stage >= SRS_INTERVALS.length - 1) return false;
        return daysBetween(e.srs.nextReview, today) >= 0;
      });
    },

    /**
     * 评分推进复习进度
     * @param {string} id
     * @param {'again'|'hard'|'good'} grade
     */
    reviewEntry(id, grade) {
      const e = this.state.entries.find(x => x.id === id);
      if (!e) return;
      const srs = e.srs;
      srs.reviews += 1;

      if (grade === 'again') {
        srs.lapses += 1;
        srs.stage = Math.max(0, srs.stage - 2);
        e.level = Math.max(0, e.level - 1);
      } else if (grade === 'hard') {
        srs.stage = Math.max(0, srs.stage);   // 停留在当前阶段，重复一次
      } else {
        srs.stage = Math.min(SRS_INTERVALS.length - 1, srs.stage + 1);
        if (srs.stage >= 3) e.level = Math.min(3, Math.max(e.level, 2));
        if (srs.stage >= 5) e.level = 3;
        else if (e.level < 1) e.level = 1;
      }

      const interval = SRS_INTERVALS[srs.stage] || 1;
      srs.nextReview = addDays(todayKey(), Math.max(1, interval));
      srs.lastReview = todayKey();
      e.updatedAt = Date.now();
      this.commit();
    },

    /** 预测下次复习间隔文案，用于按钮提示 */
    previewInterval(entry, grade) {
      const stage = entry.srs.stage;
      let next;
      if (grade === 'again') next = Math.max(0, stage - 2);
      else if (grade === 'hard') next = stage;
      else next = Math.min(SRS_INTERVALS.length - 1, stage + 1);
      const d = Math.max(1, SRS_INTERVALS[next] || 1);
      return d === 1 ? '1天后' : `${d}天后`;
    },

    // ===== 查询与分组 =====

    /** 按日期倒序分组，用于历史折叠视图 */
    groupByDate(entries) {
      const map = new Map();
      entries.forEach(e => {
        if (!map.has(e.dateKey)) map.set(e.dateKey, []);
        map.get(e.dateKey).push(e);
      });
      return Array.from(map.entries())
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([date, items]) => ({
          date,
          items: items.sort((a, b) => b.createdAt - a.createdAt)
        }));
    },

    filter(opts) {
      const o = opts || {};
      const q = (o.q || '').trim().toLowerCase();
      return this.state.entries.filter(e => {
        if (o.lang && o.lang !== 'all' && e.lang !== o.lang) return false;
        if (o.type && o.type !== 'all' && e.type !== o.type) return false;
        if (o.level !== undefined && o.level !== 'all' && e.level !== Number(o.level)) return false;
        if (o.tag && !e.tags.includes(o.tag)) return false;
        if (q) {
          const hay = [e.text, e.reading, e.meaning, e.example, e.exampleTrans, e.source, e.hanja, e.tags.join(' ')]
            .join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    },

    allTags() {
      const set = new Set();
      this.state.entries.forEach(e => e.tags.forEach(t => set.add(t)));
      return Array.from(set).sort();
    },

    // ===== 统计 =====

    stats(lang) {
      const today = todayKey();

      // 词库全部条目（含已学与未学、AI 补充词）
      const allEntries = lang && lang !== 'all'
        ? this.state.entries.filter(e => e.lang === lang)
        : this.state.entries;

      // 已学条目（点过认识/不认识）
      const learnedEntries = allEntries.filter(e => e.learned);

      const byLang = { en: 0, ja: 0, ko: 0 };
      const byLevel = [0, 0, 0, 0];
      learnedEntries.forEach(e => {
        byLang[e.lang] = (byLang[e.lang] || 0) + 1;
        byLevel[e.level] = (byLevel[e.level] || 0) + 1;
      });

      // 近 7 日已学趋势（按语言堆叠）
      const trend = [];
      for (let i = 6; i >= 0; i--) {
        const key = addDays(today, -i);
        const dayItems = learnedEntries.filter(e => e.dateKey === key);
        trend.push({
          date: key,
          label: i === 0 ? '今天' : weekdayLabel(key),
          total: dayItems.length,
          en: dayItems.filter(e => e.lang === 'en').length,
          ja: dayItems.filter(e => e.lang === 'ja').length,
          ko: dayItems.filter(e => e.lang === 'ko').length
        });
      }

      // 连续学习天数（今天没学则从前一天开始计）
      let streak = 0;
      let cursor = today;
      if (!this.hasActivity(cursor)) cursor = addDays(today, -1);
      while (this.hasActivity(cursor)) {
        streak += 1;
        cursor = addDays(cursor, -1);
      }

      // 累计学习时长
      let totalMinutes = 0;
      let totalStudySeconds = 0;   // 原始秒数（不提前 floor 到分钟，避免短学习被吞成 0 且跨天不累计）
      for (const dk in this.state.checkins) {
        const c = this.state.checkins[dk] || {};
        const mins = Number(c.minutes) || 0;
        const secs = Number(c.studySeconds) || 0;
        totalMinutes += mins + Math.floor(secs / 60);
        totalStudySeconds += mins * 60 + secs;
      }

      // 完成打卡天数：今日学习三语词包全部完成并打卡
      const completedDays = Object.keys(this.state.checkins).filter(k => this.state.checkins[k].completed).length;

      return {
        // 新顶部指标
        streak,
        completedDays,
        totalEntries: allEntries.length,
        todayAdded: allEntries.filter(e => e.dateKey === today).length,
        learned: learnedEntries.length,
        todayLearned: learnedEntries.filter(e => e.learnedAt && todayKey(e.learnedAt) === today).length,
        mastered: byLevel[3],
        masterRate: learnedEntries.length ? Math.round((byLevel[3] / learnedEntries.length) * 100) : 0,
        due: this.dueEntries(lang).length,
        totalMinutes,
        totalStudySeconds,
        // 辅助/图表数据
        byLang,
        byLevel,
        trend,
        weekCount: learnedEntries.filter(e => daysBetween(e.dateKey, today) < 7).length,
        activeDays: Object.keys(this.state.checkins).filter(k => this.hasActivity(k)).length
      };
    },

    // ===== 导入导出 =====

    exportJSON() {
      return JSON.stringify(Object.assign({ _app: 'lang-workbench', _v: 1 }, this.state), null, 2);
    },

    // 校验文件是否为本应用导出的备份；非法时抛出可读错误
    validateImport(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('文件不是有效的 JSON');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('文件内容不是有效的备份对象');
      }
      if (!Array.isArray(data.entries)) {
        throw new Error('不是本应用的备份文件（缺少条目数据）');
      }
      const isBackup = data._app === 'lang-workbench';
      if (data.entries.length > 0) {
        const looksValid = data.entries.some(e =>
          e && typeof e === 'object' && e.text != null && e.lang != null
        );
        if (!looksValid && !isBackup) {
          throw new Error('不是本应用的备份文件（条目格式不符）');
        }
      } else if (!isBackup) {
        throw new Error('不是本应用的备份文件（无法识别）');
      }
      return true;
    },

    importJSON(text, mode) {
      this.validateImport(text);
      const data = JSON.parse(text);
      delete data._app;
      delete data._v;
      if (mode === 'merge') {
        const existing = new Set(this.state.entries.map(e => e.id));
        data.entries.forEach(e => {
          if (!existing.has(e.id)) this.state.entries.push(e);
        });
        Object.assign(this.state.checkins, data.checkins || {});
      } else {
        this.state = Object.assign(defaultState(), data);
      }
      this._migrate();
      this.commit();
      return this.state.entries.length;
    },

    exportCSV(entries) {
      const rows = [['语言', '类型', '原文', '读音', '释义', '例句', '例句翻译', '来源', '标签', '掌握度', '录入日期']];
      entries.forEach(e => {
        rows.push([
          LANGS[e.lang] ? LANGS[e.lang].name : e.lang,
          TYPES[e.type] ? TYPES[e.type].name : e.type,
          e.text, e.reading, e.meaning, e.example, e.exampleTrans,
          e.source, e.tags.join(' '), LEVELS[e.level].name, e.dateKey
        ]);
      });
      return rows.map(r =>
        r.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')
      ).join('\n');
    },

    clearAll() {
      this.state = defaultState();
      try { if (global.localStorage) global.localStorage.removeItem(BEST_KEY); } catch (e) {}
      this.commit();
    }
  };

  // ---------- 批量粘贴解析 ----------

  function parseTags(str) {
    if (!str) return [];
    return String(str)
      .split(/[,，、\s]+/)
      .map(s => s.trim().replace(/^#/, ''))
      .filter(Boolean);
  }

  /**
   * 解析批量粘贴文本。每行一条，支持 Tab / | / ，/ - 等分隔符。
   * 字段顺序：原文 | 读音 | 释义 | 例句 | 例句翻译
   * 只写「原文 释义」两列也能识别。
   */
  function parseBulk(text, lang, type) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out = [];

    lines.forEach(line => {
      let parts;
      if (line.includes('\t')) parts = line.split('\t');
      else if (line.includes('|')) parts = line.split('|');
      else if (line.includes('：') || line.includes(':')) parts = line.split(/[：:]/);
      else if (line.includes('  ')) parts = line.split(/\s{2,}/);
      else if (line.includes('，')) parts = line.split('，');
      else if (line.includes(' - ')) parts = line.split(' - ');
      else parts = line.split(/\s+(.+)/).filter(Boolean);

      parts = parts.map(p => p.trim()).filter((p, i) => p !== '' || i === 0);
      if (!parts.length || !parts[0]) return;

      // 读音识别：被 // [] （） 包裹，或全假名/罗马音
      let text0 = parts[0], reading = '', meaning = '', example = '', exampleTrans = '';

      // 形如 apple /ˈæpl/ 的写法
      const inlineReading = text0.match(/^(.+?)\s*[\/\[（(]([^\/\]）)]+)[\/\]）)]\s*$/);
      if (inlineReading) {
        text0 = inlineReading[1].trim();
        reading = inlineReading[2].trim();
      }

      if (parts.length === 2) {
        meaning = parts[1];
      } else if (parts.length === 3) {
        if (looksLikeReading(parts[1], lang)) {
          reading = reading || parts[1];
          meaning = parts[2];
        } else {
          meaning = parts[1];
          example = parts[2];
        }
      } else if (parts.length >= 4) {
        reading = reading || parts[1];
        meaning = parts[2];
        example = parts[3];
        exampleTrans = parts[4] || '';
      }

      out.push({
        lang, type,
        text: text0,
        reading,
        meaning,
        example,
        exampleTrans
      });
    });

    return out;
  }

  function looksLikeReading(s, lang) {
    if (!s) return false;
    if (lang === 'ja') return /^[\u3040-\u309f\u30a0-\u30ff\sー・]+$/.test(s);
    if (lang === 'ko') return /^[a-zA-Z\s\-']+$/.test(s);
    return /^[\/\[]?[ˈˌa-zɑɒæʌəɜɪiːʊuːeɛɔθðʃʒŋtʃdʒ\s\.\-']+[\/\]]?$/.test(s);
  }

  // ---------- 导出 ----------

  global.LangStore = {
    Store,
    LANGS, TYPES, LEVELS, SKILLS, SRS_INTERVALS,
    uid, todayKey, addDays, daysBetween,
    formatDateLabel, weekdayLabel, relativeDayLabel,
    parseBulk, parseTags,
    LocalAdapter, GistAdapter
  };
})(window);
