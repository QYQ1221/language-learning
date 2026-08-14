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
      try {
        const res = await fetch('https://api.github.com/gists/' + this._gistId, {
          headers: { 'Authorization': 'Bearer ' + this._token, 'Accept': 'application/vnd.github+json' }
        });
        if (res.status === 404) return null;
        if (!res.ok) { console.warn('[GistAdapter] 读取失败', res.status); return null; }
        const data = await res.json();
        const file = data && data.files && data.files['langworkbench_state.json'];
        if (!file || file.content == null) return null;
        return JSON.parse(file.content);
      } catch (e) { console.warn('[GistAdapter] 读取失败', e); return null; }
    },

    // 上传到 Gist 前剥离 Token 等敏感字段，避免把凭证明文写进 Gist 文件
    _safePayload(state) {
      const safe = JSON.parse(JSON.stringify(state));
      if (safe && safe.settings) { safe.settings.gistToken = ''; }
      if (safe && safe.settings && safe.settings.ai) { safe.settings.ai.apiKey = ''; }
      return safe;
    },

    async save(state) {
      if (!this.ready) return false;
      const content = JSON.stringify(this._safePayload(state));
      try {
        const res = await fetch('https://api.github.com/gists/' + this._gistId, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + this._token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
          body: JSON.stringify({ files: { 'langworkbench_state.json': { content } } })
        });
        if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 120)); }
        return true;
      } catch (e) { this.error = e && e.message ? e.message : String(e); console.warn('[GistAdapter] 保存失败', e); return false; }
    },

    // 创建新 Gist（首次开启且未提供同步码时调用），返回 gist id
    async create(token, state) {
      try {
        const res = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
          body: JSON.stringify({ description: 'lang-workbench sync', public: false, files: { 'langworkbench_state.json': { content: JSON.stringify(this._safePayload(state)) } } })
        });
        if (!res.ok) { this.error = '创建 Gist 失败（HTTP ' + res.status + '）'; return null; }
        const data = await res.json();
        return data.id || null;
      } catch (e) { this.error = e && e.message ? e.message : String(e); return null; }
    },

    // 轮询订阅（Gist 无 WebSocket，用 20s 轮询模拟近实时同步）
    subscribe(cb) {
      if (!this.ready) return () => {};
      let last = '';
      const tick = async () => {
        try {
          const res = await fetch('https://api.github.com/gists/' + this._gistId, {
            headers: { 'Authorization': 'Bearer ' + this._token, 'Accept': 'application/vnd.github+json' }
          });
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
      checkins: {},         // { '2026-08-09': { listening:true, speaking:false, reading:true, writing:false, minutes:30 } }
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
      this._migrate();
      return this.state;
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
      });

      // 兼容旧版：checkins 由「按语言」改为「按技能(听说读写)全局」
      for (const dk in this.state.checkins) {
        const rec = this.state.checkins[dk];
        if (rec && (rec.en || rec.ja || rec.ko)) {
          const fixed = { listening: false, speaking: false, reading: false, writing: false, minutes: 0 };
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
        }
      }
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
      return base;
    },

    /** 把当前状态镜像写一份到 localStorage，作为云端不可达时的离线缓存。 */
    _mirrorLocal() {
      try { LocalAdapter.save(this.state); } catch (e) { /* 缓存失败不影响主流程 */ }
    },

    /** 应用远端推送（实时同步）：整篇替换；用 updatedAt 去重，避免本端写入的回声造成 save→watch 死循环。 */
    _applyRemote(remoteState) {
      if (!remoteState || typeof remoteState !== 'object') return false;
      if (remoteState.updatedAt && this.state.updatedAt === remoteState.updatedAt) return false; // 回声去重
      const keepToken = this.state.settings.gistToken;   // 远端 Gist 不含 token，保留本地凭证避免刷新后重连失败
      const keepKey = this.state.settings.gistKey;
      const keepAiKey = (this.state.settings.ai && this.state.settings.ai.apiKey) || ''; // AI Key 仅存本机，不被远端（已剥离）覆盖，避免同步把本地 Key 清空
      this.state = Object.assign(defaultState(), remoteState);
      this.state.settings = Object.assign(defaultState().settings, remoteState.settings || {});
      this.state.settings.gistToken = keepToken;
      this.state.settings.gistKey = keepKey;
      // 远端 Gist 中的 ai.apiKey 始终为空（上传前已剥离），此处用本地 Key 覆盖，确保 Key 永不被同步清空
      this.state.settings.ai = Object.assign({}, this.state.settings.ai || {}, { apiKey: keepAiKey });
      this._migrate();
      this._mirrorLocal();       // 镜像到本地，云端离线也能恢复
      return true;
    },


    /**
     * 启用 GitHub Gist 同步（免费、零服务器）：初始化 GistAdapter → 拉取远端（合并）→ 轮询订阅近实时变更。
     * token 为 GitHub Personal Access Token（仅 gist 权限）。key 为 Gist ID（同步码）；为空则自动创建新 Gist。
     */
    async enableGist(token, key) {
      token = (token || '').trim();
      key = (key || '').trim();
      const keepAiKey = (this.state.settings.ai && this.state.settings.ai.apiKey) || ''; // 连接同步前先暂存本地 AI Key
      if (!token) { this._gistError = '缺少 GitHub Token'; return false; }
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
      if (isNew) {
        // 新建的 Gist 内容为空，必须先把本地数据上传，否则下次读取空内容会覆盖本地
        const okSave = await GistAdapter.save(this.state);
        if (!okSave) {
          this._gistError = '写入 Gist 失败（多半是 Token 没有 gist 权限）：' + (GistAdapter.error || '');
          this.useAdapter(LocalAdapter);
          return false;
        }
        this._mirrorLocal();
      } else {
        // 连接已有 Gist：先拉取远端并合并（保留本地独有条目），再把合并后的完整数据写回云端，实现双向同步
        const remote = await GistAdapter.load();
        if (remote && typeof remote === 'object') {
          this.state = this._mergeForCloud(remote);
        }
        this.state.settings.gistToken = token;   // 防止被云端剥离后的空 token 覆盖，刷新后才能正常重连
        this.state.settings.gistKey = key;
        // 远端 Gist 的 ai.apiKey 为空（已剥离），用本地 Key 覆盖，避免连接同步清空本地 AI Key
        this.state.settings.ai = Object.assign({}, this.state.settings.ai || {}, { apiKey: (this.state.settings.ai && this.state.settings.ai.apiKey) || keepAiKey });
        this._migrate();
        const okSave = await GistAdapter.save(this.state);
        if (!okSave) {
          this._gistError = '写入 Gist 失败（同步码对应的 Gist 不存在，或 Token 无 gist 权限）：' + (GistAdapter.error || '');
          this.useAdapter(LocalAdapter);
          return false;
        }
        this.commit();
        this._mirrorLocal();
      }
      if (this._gistUnsub) { try { this._gistUnsub(); } catch (e) {} }
      this._gistUnsub = GistAdapter.subscribe((remoteState) => {
        if (this._applyRemote(remoteState)) {
          this._emit();
          if (this.onRemote) this.onRemote();
        }
      });
      this._gistEnabled = true;
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
      this._setStatus('saving');
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(async () => {
        const ok = await this.adapter.save(this.state);
        this._setStatus(ok ? 'saved' : 'offline');
        this._mirrorLocal();       // 始终保留一份本地缓存（云端不可达时可用）
      }, 300);
    },

    /** 立即落盘（页面隐藏/关闭前调用，防止防抖窗口内丢数据） */
    async flush() {
      clearTimeout(this._saveTimer);
      const ok = await this.adapter.save(this.state);
      this._setStatus(ok ? 'saved' : 'offline');
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
        this.state.checkins[key] = { listening: false, speaking: false, reading: false, writing: false, minutes: 0 };
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

    getCheckin(dateKey) {
      const key = dateKey || todayKey();
      return Object.assign(
        { listening: false, speaking: false, reading: false, writing: false, minutes: 0 },
        this.state.checkins[key] || {}
      );
    },

    /** 某天是否有任何学习活动（打卡或新增条目） */
    hasActivity(dateKey) {
      const c = this.state.checkins[dateKey];
      if (c) {
        if (SKILLS.some(s => c[s.key])) return true;
        if ((c.minutes || 0) > 0) return true;
      }
      return this.state.entries.some(e => e.dateKey === dateKey);
    },

    /** 某天的活动强度 0-4，用于热力图 */
    activityLevel(dateKey) {
      const count = this.state.entries.filter(e => e.dateKey === dateKey).length;
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
      const all = lang && lang !== 'all'
        ? this.state.entries.filter(e => e.lang === lang)
        : this.state.entries;

      const today = todayKey();
      const byLang = { en: 0, ja: 0, ko: 0 };
      const byLevel = [0, 0, 0, 0];
      all.forEach(e => {
        byLang[e.lang] = (byLang[e.lang] || 0) + 1;
        byLevel[e.level] = (byLevel[e.level] || 0) + 1;
      });

      // 近 7 日新增（按语言堆叠）
      const trend = [];
      for (let i = 6; i >= 0; i--) {
        const key = addDays(today, -i);
        const dayItems = all.filter(e => e.dateKey === key);
        trend.push({
          date: key,
          label: i === 0 ? '今天' : weekdayLabel(key),
          total: dayItems.length,
          en: dayItems.filter(e => e.lang === 'en').length,
          ja: dayItems.filter(e => e.lang === 'ja').length,
          ko: dayItems.filter(e => e.lang === 'ko').length
        });
      }

      // 连续打卡天数
      let streak = 0;
      let cursor = today;
      if (!this.hasActivity(cursor)) cursor = addDays(today, -1); // 今天还没学不断连
      while (this.hasActivity(cursor)) {
        streak += 1;
        cursor = addDays(cursor, -1);
      }

      // 累计学习时长
      let totalMinutes = 0;
      for (const dk in this.state.checkins) {
        totalMinutes += Number((this.state.checkins[dk] || {}).minutes) || 0;
      }

      return {
        total: all.length,
        todayCount: all.filter(e => e.dateKey === today).length,
        weekCount: all.filter(e => daysBetween(e.dateKey, today) < 7).length,
        due: this.dueEntries(lang).length,
        mastered: byLevel[3],
        masterRate: all.length ? Math.round((byLevel[3] / all.length) * 100) : 0,
        byLang,
        byLevel,
        trend,
        streak,
        totalMinutes,
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
