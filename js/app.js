/* ============================================================
   app.js — 视图与交互
   ============================================================ */

(function () {
  'use strict';

  const {
    Store, LANGS, TYPES, LEVELS, SKILLS,
    todayKey, addDays, daysBetween,
    formatDateLabel, weekdayLabel, relativeDayLabel,
    parseBulk, parseTags, uid
  } = window.LangStore;

  // ---------- 应用状态（非持久化的 UI 状态） ----------
  const ui = {
    view: 'capture',
    lang: 'all',
    captureMode: 'form',      // form | bulk
    draft: {},                // 录入草稿（含未提交内容，自动保存）
    openDays: new Set(),      // 历史页展开的日期
    filter: { q: '', type: 'all', level: 'all', tag: '' },
    review: { queue: [], index: 0, revealed: false, done: 0 },
    selectedMood: null,     // 今日心情（单选）
    selectedInterests: [],  // 今日兴趣（可多选）
    learn: null,           // 今日学习会话：{ themes:[], salt, added:Set, judged:{}, pack, total }
    learnDismissed: false  // 用户主动「换主题」后置 true：优先展示选择器，不被云端旧会话覆盖，直到重新生成
  };

  const DRAFT_KEY = 'lang-workbench-draft';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function icon(id, cls) {
    return `<svg class="${cls || ''}"><use href="#${id}"/></svg>`;
  }

  // ---------- 语音朗读（单词 / 例句 TTS） ----------
  const TTS_LANG = { en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' };

  function speakText(text, lang) {
    if (!text) return;
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读', 'warn'); return; }
    try {
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = TTS_LANG[lang] || 'en-US';
      utt.rate = 0.9;
      const voices = speechSynthesis.getVoices() || [];
      const v = voices.find(x => x.lang === utt.lang)
             || voices.find(x => x.lang && x.lang.toLowerCase().startsWith(lang));
      if (v) utt.voice = v;
      speechSynthesis.cancel();
      speechSynthesis.speak(utt);
    } catch (e) { /* 忽略朗读异常 */ }
  }

  // ============================================================
  // 草稿自动保存 —— 未点击"添加"的半成品内容也不会丢
  // ============================================================

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      ui.draft = raw ? JSON.parse(raw) : {};
    } catch (e) { ui.draft = {}; }
  }

  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(ui.draft)); } catch (e) {}
    }, 250);
  }

  function clearDraft() {
    ui.draft = { lang: ui.draft.lang, type: ui.draft.type, level: 0 };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(ui.draft)); } catch (e) {}
  }

  // ============================================================
  // Toast
  // ============================================================

  function toast(msg, type) {
    const wrap = $('#toastWrap');
    const el = document.createElement('div');
    el.className = 'toast';
    const mark = type === 'ok' ? '✓ ' : type === 'warn' ? '⚠ ' : '';
    el.textContent = mark + msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 250);
    }, 2000);
  }

  // 把 AI 调用异常转成可定位的提示（附模型原始返回片段）
  function aiErr(err, where) {
    const base = err ? ((err && err.message) ? err.message : String(err)) : '';
    const le = (window.LangAI && LangAI.lastError) ? LangAI.lastError : null;
    let msg = where || 'AI 出错';
    if (base) msg += '：' + base;
    if (le && le.raw) {
      const raw = String(le.raw).replace(/\s+/g, ' ').slice(0, 140);
      msg += '\n（模型原样返回：' + raw + '）';
    } else if (le && le.parseErr) {
      msg += '\n（解析错误：' + le.parseErr + '）';
    }
    return msg;
  }

  // ============================================================
  // 弹窗
  // ============================================================

  function modal(opts) {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-backdrop" id="mdBackdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3 class="modal-title">${esc(opts.title)}</h3>
            <button class="btn btn-icon btn-ghost" id="mdClose" style="margin-left:auto">${icon('i-close')}</button>
          </div>
          <div class="modal-body">${opts.body}</div>
          <div class="modal-foot">${opts.foot || ''}</div>
        </div>
      </div>`;
    const close = () => { root.innerHTML = ''; };
    $('#mdClose').onclick = close;
    $('#mdBackdrop').onclick = e => { if (e.target.id === 'mdBackdrop') close(); };
    if (opts.onMount) opts.onMount(close);
    return close;
  }

  // ============================================================
  // 语言字段配置 —— 三种语言字段结构不同
  // ============================================================

  const FIELD_CONFIG = {
    en: {
      textLabel: '单词 / 短语', textPlaceholder: 'resilient',
      readingLabel: '音标', readingPlaceholder: '/rɪˈzɪliənt/', readingHint: 'IPA',
      extra: null
    },
    ja: {
      textLabel: '表记（漢字・かな）', textPlaceholder: '頑張る',
      readingLabel: '读音（ふりがな）', readingPlaceholder: 'がんばる', readingHint: '假名',
      extra: { key: 'pitch', label: '声调', placeholder: '3', hint: '0～4型' }
    },
    ko: {
      textLabel: '谚文', textPlaceholder: '열심히',
      readingLabel: '罗马音', readingPlaceholder: 'yeolsimhi', readingHint: 'romaja',
      extra: { key: 'hanja', label: '汉字词', placeholder: '熱心-', hint: '可留空' }
    }
  };

  const POS_OPTIONS = {
    en: ['名词 n.', '动词 v.', '形容词 adj.', '副词 adv.', '介词 prep.', '连词 conj.', '短语 phr.'],
    ja: ['名詞', '動詞（五段）', '動詞（一段）', 'い形容詞', 'な形容詞', '副詞', '助詞', '表現'],
    ko: ['명사 名词', '동사 动词', '형용사 形容词', '부사 副词', '조사 助词', '표현 表达']
  };

  // ============================================================
  // 视图：今日录入
  // ============================================================

  // 会话身份：同一天 + 相同心情主题 + 相同打乱盐值 视为「同一个会话」；否则视为其他设备改了心情
  function learnIdentity(L) {
    if (!L) return '';
    return (L.date || '') + '|' + (L.themes || []).join(',') + '|' + (L.salt || 0);
  }

  function renderCapture() {
    const s = Store.state.learnSession;
    const today = todayKey();
    // 若云端/持久化没有今日会话，内存中也不应残留旧会话（避免 dur 等字段为空导致崩溃）
    if (ui.learn && (!s || s.date !== today)) {
      ui.learn = null;
    }
    // 用户主动「换主题」后，优先展示选择器，不被云端旧会话覆盖（除非用户已重新生成）
    if (ui.learnDismissed && !ui.learn) return renderThemePicker();
    // 跨端心情同步：云端/持久化的今日会话与本地内存会话「身份」不同（其他设备改了心情），
    // 则采用云端会话，避免手机端一直显示自己之前选的心情。身份相同则保留本机进度（不打断学习）。
    if (s && s.date === today) {
      if (!ui.learn || learnIdentity(ui.learn) !== learnIdentity(s)) {
        restoreLearn();
      }
    }
    if (!ui.learn) return renderThemePicker();
    return renderLearnSession();
  }

  function moodChip(t) {
    const active = ui.selectedMood === t.key;
    return `<button class="theme-chip ${active ? 'active' : ''}" data-mood="${t.key}">
      <span class="theme-emoji">${t.emoji}</span>
      <span class="theme-name">${esc(t.name)}</span>
      <span class="theme-desc">${esc(t.desc)}</span>
    </button>`;
  }

  function interestChip(t) {
    const active = ui.selectedInterests.includes(t.key);
    return `<button class="theme-chip ${active ? 'active' : ''}" data-interest="${t.key}">
      <span class="theme-emoji">${t.emoji}</span>
      <span class="theme-name">${esc(t.name)}</span>
      <span class="theme-desc">${esc(t.desc)}</span>
    </button>`;
  }

  function renderThemePicker() {
    const today = todayKey();
    const canGen = ui.selectedMood || ui.selectedInterests.length;
    const selLabel = !canGen ? '先选一个心情或兴趣'
      : [ui.selectedMood, ...ui.selectedInterests].map(themeName).join(' ＋ ');

    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head">
          <h2 class="card-title">选个今天的心情 / 兴趣</h2>
          <span style="margin-left:auto;font-size:12px;color:var(--text-3)">据二者生成专属三语词包</span>
        </div>
        <div class="card-body">
          <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px">
            💡 今日心情 <span class="picker-hint">单选</span>
          </div>
          <div class="theme-grid">
            ${LangThemes.THEMES.filter(t => t.group === 'mood').map(moodChip).join('')}
          </div>
          <div style="font-size:12px;font-weight:600;color:var(--text-2);margin:14px 0 8px">
            🎯 兴趣 <span class="picker-hint">可多选</span>
          </div>
          <div class="theme-grid">
            ${LangThemes.THEMES.filter(t => t.group === 'interest').map(interestChip).join('')}
          </div>

          <div style="display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap">
            <button class="btn btn-primary" id="btnGenLearn" ${canGen ? '' : 'disabled'} style="justify-content:center;padding:11px 18px">
              ${canGen ? '🎯 生成今日学习' : '请先选择'}
            </button>
            <button class="btn btn-sm btn-ghost" id="btnSurprise">🎲 随机心情（${themeName(LangThemes.suggestTheme(today))}）</button>
            <span style="font-size:12px;color:var(--text-3);margin-left:auto">已选：${selLabel}</span>
          </div>
        </div>
      </div>

      <div style="margin-top:4px">
        <button class="btn btn-ghost" id="btnManualAdd" style="width:100%;justify-content:center;padding:12px">
          + 自己加词（辅助录入）
        </button>
      </div>
    `;
  }

  function renderLearnSession() {
    const L = ui.learn;
    const focus = L.focus || 'en';
    const showAll = focus === 'all';
    const langs = showAll ? L.order : [focus];

    // 三语全部完成打卡 → 完成总览（仅「全部」视图下三种都学完才显示）
    const allDone = L.order.every(lg =>
      ((L.pack && L.pack[lg]) || []).length > 0 && L.langCheckedIn[lg]);
    if (allDone) return allDoneView();

    const themeTitle = L.themes.map(k => {
      const tm = LangThemes.THEME_MAP[k];
      return tm ? `${tm.emoji} ${esc(tm.name)}` : esc(k);
    }).join(' ＋ ');

    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <span style="font-size:15px;font-weight:700">${themeTitle} · 专属词包</span>
        <span class="badge badge-neutral">${formatDateLabel(todayKey())}</span>
        ${L.aiLoading ? '<span class="badge badge-ai">✨ AI 补充中…</span>' : ''}
        <button class="btn btn-sm btn-ghost" id="btnBackTheme">🔄 换主题</button>
      </div>

      ${langs.map(renderLangSection).join('')}

      <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="btnReshuffle">🔄 换一批新词</button>
        <button class="btn btn-primary" id="btnFinishLater" style="margin-left:auto">稍后再学</button>
      </div>

      <div style="margin-top:14px">
        <button class="btn btn-ghost" id="btnManualAdd" style="width:100%;justify-content:center;padding:12px">
          + 自己加词（辅助录入）
        </button>
      </div>
    `;
  }

  function allDoneView() {
    const L = ui.learn;
    const sec = totalSeconds();
    const counts = {};
    ['en', 'ja', 'ko'].forEach(lg => {
      counts[lg] = ((L.pack && L.pack[lg]) || []).filter(x => L.added.has(x._bankId)).length;
    });
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-body" style="padding:18px;text-align:center">
          <div style="font-size:34px">🎉</div>
          <div style="font-size:17px;font-weight:700;margin-top:4px">今日三语词包全部学完</div>
          <div style="font-size:13px;color:var(--text-3);margin-top:6px">
            累计学习时长 ${fmtDuration(sec)} ・ 共 ${counts.en + counts.ja + counts.ko} 词
          </div>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap">
            <span class="badge badge-en">🇬🇧 ${counts.en}</span>
            <span class="badge badge-ja">🇯🇵 ${counts.ja}</span>
            <span class="badge badge-ko">🇰🇷 ${counts.ko}</span>
          </div>
          <div style="display:flex;gap:10px;margin-top:18px;justify-content:center;flex-wrap:wrap">
            <button class="btn btn-primary" id="btnViewStats">查看学习统计</button>
          </div>
        </div>
      </div>`;
  }

  function renderLangSection(lg) {
    const items = ((ui.learn.pack && ui.learn.pack[lg]) || []);
    if (!items.length) return '';
    const L = LANGS[lg];
    // 学完并确认打卡后：该语种显示为「完成打卡」横幅，不再列单词
    if (ui.learn.langCheckedIn[lg]) {
      const sec = langSeconds(lg);
      return `
        <div style="margin-bottom:18px">
          <div class="checkin-banner">
            <div class="cb-icon">✅</div>
            <div class="cb-body">
              <div class="cb-title">完成打卡 · 今日${esc(L.name)}单词已学完</div>
              <div class="cb-sub">${items.length} 个词 ・ 学习时长 ${fmtDuration(sec)}</div>
            </div>
          </div>
        </div>`;
    }
    return `
      <div style="margin-bottom:18px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span class="badge badge-${lg}">${L.flag} ${L.name}</span>
          <span style="font-size:12px;color:var(--text-3)">${items.length} 个</span>
          <span style="font-size:12px;color:var(--text-3);margin-left:auto">已学 ${countAddedInLang(lg)}/${items.length}</span>
        </div>
        <div class="learn-grid">
          ${items.map(renderLearnCard).join('')}
        </div>
      </div>`;
  }

  function countAddedInLang(lg) {
    return ((ui.learn.pack && ui.learn.pack[lg]) || []).filter(x => ui.learn.added.has(x._bankId)).length;
  }

  function renderLearnCard(it) {
    const added = ui.learn.added.has(it._bankId);
    const j = ui.learn.judged[it._bankId];
    const jLabel = j === 'know' ? '（认识）' : j === 'unknown' ? '（不认识）' : '';
    const isAI = !!(it._bankId && String(it._bankId).indexOf('ai:') === 0);
    const isMe = !!it.isManual;
    const tag = isAI ? '<span class="word-tag tag-ai">✨ AI 生成</span>'
      : isMe ? '<span class="word-tag tag-me">✍ 自己加词</span>' : '';
    const spk = (txt, lang) => txt
      ? `<button class="spk" data-spk-text="${esc(txt)}" data-spk-lang="${lang}" title="朗读">${icon('i-volume')}</button>`
      : '';
    return `
      <div class="learn-card ${added ? 'done' : ''}" data-bank="${esc(it._bankId)}">
        <div class="learn-front">
          <div class="learn-text">${esc(it.text)} ${spk(it.text, it.lang)}</div>
          <div class="learn-read">
            ${it.reading ? `<span>${esc(it.reading)}</span>` : ''}
            ${it.pitch ? `<span class="learn-pitch">${esc(it.pitch)}型</span>` : ''}
            ${it.hanja ? `<span class="learn-hanja">［${esc(it.hanja)}］</span>` : ''}
            ${tag}
          </div>
        </div>
        <div class="learn-back">
          ${it.meaning ? `<div class="learn-meaning">${esc(it.meaning)}</div>` : ''}
          ${it.example ? `
            <div class="learn-example">
              ${esc(it.example)} ${spk(it.example, it.lang)}
              ${it.exampleTrans ? `<div class="learn-example-trans">${esc(it.exampleTrans)}</div>` : ''}
            </div>` : ''}
        </div>
        ${added ? `
          <div class="learn-added">✓ 已加入复习队列${jLabel}</div>
        ` : `
          <div class="learn-actions">
            <button class="learn-btn unknown" data-judge="unknown" data-bank="${esc(it._bankId)}">不认识</button>
            <button class="learn-btn know" data-judge="know" data-bank="${esc(it._bankId)}">认识</button>
          </div>
        `}
      </div>`;
  }

  function renderForm(lang, cfg, type, level) {
    const d = ui.draft;
    return `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        <div class="lang-tabs" data-role="draftLang">
          ${['en', 'ja', 'ko'].map(l =>
            `<button class="lang-tab ${lang === l ? 'active' : ''}" data-lang="${l}">${LANGS[l].flag} ${LANGS[l].name}</button>`
          ).join('')}
        </div>
        <div class="type-chips" data-role="draftType">
          ${Object.values(TYPES).map(t =>
            `<button class="chip ${type === t.key ? 'active' : ''}" data-type="${t.key}">${t.name}</button>`
          ).join('')}
        </div>
      </div>

      <div class="form-grid">
        <div class="field ${cfg.extra ? '' : 'span-2'}">
          <label class="label">${cfg.textLabel} <span style="color:var(--danger)">*</span></label>
          <input class="input" data-draft="text" placeholder="${cfg.textPlaceholder}"
                 value="${esc(d.text || '')}" autocomplete="off" style="font-size:15px;font-weight:600">
        </div>

        ${cfg.extra ? `
        <div class="field">
          <label class="label">${cfg.extra.label} <span class="hint">${cfg.extra.hint}</span></label>
          <input class="input" data-draft="${cfg.extra.key}" placeholder="${cfg.extra.placeholder}"
                 value="${esc(d[cfg.extra.key] || '')}" autocomplete="off">
        </div>` : ''}

        <div class="field">
          <label class="label">${cfg.readingLabel} <span class="hint">${cfg.readingHint}</span></label>
          <input class="input" data-draft="reading" placeholder="${cfg.readingPlaceholder}"
                 value="${esc(d.reading || '')}" autocomplete="off" style="font-family:var(--mono)">
        </div>

        <div class="field">
          <label class="label">词性</label>
          <select class="select" data-draft="pos">
            <option value="">未指定</option>
            ${POS_OPTIONS[lang].map(p =>
              `<option ${d.pos === p ? 'selected' : ''}>${p}</option>`
            ).join('')}
          </select>
        </div>

        <div class="field span-2">
          <label class="label">释义 <span style="color:var(--danger)">*</span></label>
          <input class="input" data-draft="meaning" placeholder="有韧性的；能迅速恢复的"
                 value="${esc(d.meaning || '')}" autocomplete="off">
        </div>

        <div class="field">
          <label class="label">例句</label>
          <textarea class="textarea" data-draft="example" placeholder="She is remarkably resilient.">${esc(d.example || '')}</textarea>
        </div>

        <div class="field">
          <label class="label">例句翻译</label>
          <textarea class="textarea" data-draft="exampleTrans" placeholder="她的心理韧性非常强。">${esc(d.exampleTrans || '')}</textarea>
        </div>

        <div class="field">
          <label class="label">来源 <span class="hint">书籍 / 剧集 / 课程</span></label>
          <input class="input" data-draft="source" placeholder="经济学人 2026.08"
                 value="${esc(d.source || '')}" autocomplete="off">
        </div>

        <div class="field">
          <label class="label">标签 <span class="hint">空格或逗号分隔</span></label>
          <input class="input" data-draft="tags" placeholder="商务 高频 易混"
                 value="${esc(d.tags || '')}" autocomplete="off">
        </div>

        <div class="field span-2">
          <label class="label">掌握程度</label>
          <div class="level-picker" data-role="draftLevel">
            ${LEVELS.map(l =>
              `<button class="level-opt ${level === l.v ? 'active' : ''}" data-level="${l.v}">${l.name}</button>`
            ).join('')}
          </div>
        </div>

        <div class="field span-2">
          <label class="label">备注 <span class="hint">选填 · 辨析、联想、易错点</span></label>
          <textarea class="textarea" data-draft="note" style="min-height:56px"
                    placeholder="与 tough 的区别：resilient 强调恢复力">${esc(d.note || '')}</textarea>
        </div>
      </div>

      <div style="display:flex;gap:9px;margin-top:16px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="btnAdd">${icon('i-plus')} 添加条目</button>
        <button class="btn btn-ghost" id="btnClearDraft">清空</button>
        <span style="font-size:12px;color:var(--text-3);margin-left:auto">
          草稿已自动保存 · 快捷键 Ctrl + Enter
        </span>
      </div>
    `;
  }

  function renderBulk(lang, type) {
    return `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        <div class="lang-tabs" data-role="draftLang">
          ${['en', 'ja', 'ko'].map(l =>
            `<button class="lang-tab ${lang === l ? 'active' : ''}" data-lang="${l}">${LANGS[l].flag} ${LANGS[l].name}</button>`
          ).join('')}
        </div>
        <div class="type-chips" data-role="draftType">
          ${Object.values(TYPES).map(t =>
            `<button class="chip ${type === t.key ? 'active' : ''}" data-type="${t.key}">${t.name}</button>`
          ).join('')}
        </div>
      </div>

      <div class="field">
        <label class="label">
          批量文本
          <span class="hint">每行一条，用 Tab、竖线 | 或全角逗号分隔字段</span>
        </label>
        <textarea class="textarea" id="bulkText" style="min-height:190px;font-family:var(--mono);font-size:13px"
          placeholder="格式：原文 | 读音 | 释义 | 例句 | 例句翻译&#10;&#10;resilient | /rɪˈzɪliənt/ | 有韧性的 | She is resilient. | 她很坚韧&#10;頑張る | がんばる | 努力、加油&#10;열심히 | yeolsimhi | 努力地">${esc(ui.draft.bulk || '')}</textarea>
      </div>

      <div id="bulkPreview" style="margin-top:12px"></div>

      <div style="display:flex;gap:9px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="btn" id="btnParse">解析预览</button>
        <button class="btn btn-primary" id="btnBulkAdd">全部添加</button>
        <span style="font-size:12px;color:var(--text-3);margin-left:auto">支持从 Excel / 词典直接复制粘贴</span>
      </div>
    `;
  }

  // ============================================================
  // 条目卡片
  // ============================================================

  function renderEntry(e) {
    const L = LANGS[e.lang] || LANGS.en;
    const T = TYPES[e.type] || TYPES.word;
    const lv = LEVELS[e.level] || LEVELS[0];
    const dueIn = daysBetween(todayKey(), e.srs.nextReview);
    const dueText = !e.learned ? '未学习' : (dueIn <= 0 ? '待复习' : `${dueIn}天后复习`);
    const spk = (txt, lang) => txt
      ? `<button class="spk" data-spk-text="${esc(txt)}" data-spk-lang="${lang}" title="朗读">${icon('i-volume')}</button>`
      : '';

    return `
      <div class="entry" data-id="${e.id}">
        <div class="entry-bar ${e.lang}"></div>
        <div class="entry-main">
          <div class="entry-head">
            <span class="entry-text">${esc(e.text)}</span>
            ${spk(e.text, e.lang)}
            ${e.reading ? `<span class="entry-reading">${esc(e.reading)}</span>` : ''}
            ${e.pitch ? `<span class="entry-pitch">${esc(e.pitch)}型</span>` : ''}
            ${e.hanja ? `<span class="entry-reading">［${esc(e.hanja)}］</span>` : ''}
          </div>
          ${e.meaning ? `<div class="entry-meaning">${esc(e.meaning)}</div>` : ''}
          ${e.example ? `
            <div class="entry-example">
              ${esc(e.example)} ${spk(e.example, e.lang)}
              ${e.exampleTrans ? `<div class="entry-example-trans">${esc(e.exampleTrans)}</div>` : ''}
            </div>` : ''}
          ${e.note ? `<div style="margin-top:6px;font-size:12px;color:var(--text-3)">💡 ${esc(e.note)}</div>` : ''}
          <div class="entry-meta">
            <span class="badge badge-${e.lang}">${L.short}</span>
            <span class="tag">${T.name}</span>
            ${e.pos ? `<span class="tag">${esc(e.pos)}</span>` : ''}
            <span style="display:inline-flex;align-items:center;gap:4px">
              <i class="level-dot" data-level="${e.level}"></i>${lv.name}
            </span>
            <span>·</span>
            <span>${dueText}</span>
            ${e.source ? `<span>· 📖 ${esc(e.source)}</span>` : ''}
            ${e.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}
          </div>
        </div>
        <div class="entry-actions">
          <button class="btn btn-icon btn-ghost" data-act="edit" title="编辑">${icon('i-edit')}</button>
          <button class="btn btn-icon btn-ghost btn-danger" data-act="del" title="删除">${icon('i-trash')}</button>
        </div>
      </div>
    `;
  }

  // ============================================================
  // 视图：历史归档（按日期折叠）
  // ============================================================

  function renderHistory() {
    const list = Store.filter({
      lang: ui.lang,
      q: ui.filter.q,
      type: ui.filter.type,
      level: ui.filter.level,
      tag: ui.filter.tag
    });
    const groups = Store.groupByDate(list);
    const tags = Store.allTags();

    // 首次进入时默认展开今天（之后尊重用户的折叠/展开操作，不自动回弹）
    if (groups.length && ui.openDays.size === 0 && !ui._histAutoExpand) {
      ui.openDays.add(groups[0].date);
      ui._histAutoExpand = true;
    }

    return `
      <div class="filter-bar">
        <div class="filter-search-wrap">
          <div class="search-box">
            ${icon('i-search')}
            <input class="input" id="searchInput" placeholder="搜索原文、释义、例句、来源、标签…"
                   value="${esc(ui.filter.q)}" autocomplete="off">
          </div>
        </div>

        <div class="filter-controls">
          <select class="select" id="filterType">
            <option value="all">全部类型</option>
            ${Object.values(TYPES).map(t =>
              `<option value="${t.key}" ${ui.filter.type === t.key ? 'selected' : ''}>${t.name}</option>`
            ).join('')}
          </select>
          <select class="select" id="filterLevel">
            <option value="all">全部掌握度</option>
            ${LEVELS.map(l =>
              `<option value="${l.v}" ${String(ui.filter.level) === String(l.v) ? 'selected' : ''}>${l.name}</option>`
            ).join('')}
          </select>
          ${tags.length ? `
          <select class="select" id="filterTag">
            <option value="">全部标签</option>
            ${tags.map(t => `<option value="${esc(t)}" ${ui.filter.tag === t ? 'selected' : ''}>#${esc(t)}</option>`).join('')}
          </select>` : ''}
          <span class="hist-expand-desktop">
            <button class="btn btn-sm" id="btnExpandAll">展开全部</button>
            <button class="btn btn-sm" id="btnCollapseAll">全部折叠</button>
          </span>
        </div>
      </div>

      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">
        共 ${list.length} 条记录 · ${groups.length} 天
      </div>

      ${groups.length ? groups.map(renderDayGroup).join('') : `
        <div class="card"><div class="empty">
          <div class="empty-icon">🗂️</div>
          <div class="empty-title">没有匹配的记录</div>
          <div class="empty-text">换个关键词，或到「今日录入」添加内容</div>
        </div></div>`}
    `;
  }

  function renderDayGroup(g) {
    const open = ui.openDays.has(g.date);
    const rel = relativeDayLabel(g.date);
    const counts = { en: 0, ja: 0, ko: 0 };
    g.items.forEach(e => counts[e.lang]++);

    return `
      <div class="day-group ${open ? 'open' : ''}" data-date="${g.date}">
        <div class="day-head">
          ${icon('i-caret', 'day-caret')}
          <span class="day-date">${formatDateLabel(g.date)}</span>
          <span class="day-weekday">${weekdayLabel(g.date)}</span>
          ${rel ? `<span class="day-rel">${rel}</span>` : ''}
          <div class="day-stats">
            ${counts.en ? `<span class="badge badge-en">EN ${counts.en}</span>` : ''}
            ${counts.ja ? `<span class="badge badge-ja">日 ${counts.ja}</span>` : ''}
            ${counts.ko ? `<span class="badge badge-ko">한 ${counts.ko}</span>` : ''}
            <span class="badge badge-neutral">${g.items.length} 条</span>
          </div>
        </div>
        <div class="day-body">
          ${g.items.map(renderEntry).join('')}
        </div>
      </div>
    `;
  }

  // ============================================================
  // 视图：复习
  // ============================================================

  function buildReviewQueue() {
    const due = Store.dueEntries(ui.lang);
    // 优先复习掌握度低的
    due.sort((a, b) => a.level - b.level || a.srs.nextReview.localeCompare(b.srs.nextReview));
    ui.review.queue = due;
    ui.review.index = 0;
    ui.review.revealed = false;
    ui.review.done = 0;
  }

  function renderReview() {
    const q = ui.review.queue;

    if (!q.length) {
      const total = Store.dueEntries(ui.lang).length;
      const next = Store.state.entries
        .filter(e => e.learned && (ui.lang === 'all' || e.lang === ui.lang))
        .map(e => e.srs.nextReview).sort()[0];
      return `
        <div class="card"><div class="empty">
          <div class="empty-icon">${ui.review.done > 0 ? '🎉' : '☕'}</div>
          <div class="empty-title">${ui.review.done > 0 ? `复习完成！本轮 ${ui.review.done} 条` : '暂时没有待复习的内容'}</div>
          <div class="empty-text">
            ${next && total === 0 ? `下一批复习时间：${formatDateLabel(next)}` : '先去录入一些新内容吧'}
          </div>
          <button class="btn btn-primary" id="btnRebuild" style="margin-top:16px">重新检查</button>
        </div></div>
      `;
    }

    const e = q[ui.review.index];
    const L = LANGS[e.lang];
    const pct = Math.round((ui.review.index / q.length) * 100);
    const revealed = ui.review.revealed;

    return `
      <div class="review-stage">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span class="badge badge-${e.lang}">${L.flag} ${L.name}</span>
          <span class="tag">${(TYPES[e.type] || TYPES.word).name}</span>
          <span style="margin-left:auto;font-size:12px;color:var(--text-3);font-weight:600">
            ${ui.review.index + 1} / ${q.length}
          </span>
        </div>

        <div class="review-progress">
          <div class="review-progress-bar" style="width:${pct}%"></div>
        </div>

        <div class="flashcard" id="flashcard">
          <div class="flash-front">${esc(e.text)} <button class="spk" data-spk-text="${esc(e.text)}" data-spk-lang="${e.lang}" title="朗读单词">${icon('i-volume')}</button></div>
          ${revealed && e.reading ? `<div class="flash-reading">${esc(e.reading)}${e.pitch ? ` ・${esc(e.pitch)}型` : ''}</div>` : ''}

          ${revealed ? `
            <div class="flash-back">
              ${e.cn ? `<div style="font-size:12px;color:var(--text-3);margin-bottom:4px">中文：${esc(e.cn)}</div>` : ''}
              <div class="flash-meaning">${esc(e.meaning || '（未填写释义）')}</div>
              ${e.pos ? `<div style="font-size:12px;color:var(--text-3);margin-top:4px">${esc(e.pos)}</div>` : ''}
              ${e.example ? `
                <div class="flash-example">
                  ${esc(e.example)} <button class="spk" data-spk-text="${esc(e.example)}" data-spk-lang="${e.lang}" title="朗读例句">${icon('i-volume')}</button>
                  ${e.exampleTrans ? `<div style="color:var(--text-3);font-size:13px;margin-top:4px">${esc(e.exampleTrans)}</div>` : ''}
                </div>` : ''}
              ${e.note ? `<div style="font-size:12px;color:var(--text-3);margin-top:10px">💡 ${esc(e.note)}</div>` : ''}
            </div>
          ` : `<div style="color:var(--text-3);font-size:13px;margin-top:20px">点击卡片或按空格显示答案</div>`}
        </div>

        ${revealed ? `
          <div class="review-actions">
            <button class="review-btn again" data-grade="again">
              忘记了<small>${Store.previewInterval(e, 'again')}</small>
            </button>
            <button class="review-btn hard" data-grade="hard">
              有点难<small>${Store.previewInterval(e, 'hard')}</small>
            </button>
            <button class="review-btn good" data-grade="good">
              记住了<small>${Store.previewInterval(e, 'good')}</small>
            </button>
          </div>
          <div style="text-align:center;font-size:11px;color:var(--text-3);margin-top:10px">
            快捷键 1 / 2 / 3
          </div>
        ` : `
          <button class="btn btn-primary" id="btnReveal" style="width:100%;margin-top:16px;padding:12px">
            显示答案
          </button>
        `}

        <div style="display:flex;gap:8px;margin-top:18px;justify-content:center">
          <button class="btn btn-sm btn-ghost" id="btnSkip">跳过这条</button>
          <button class="btn btn-sm btn-ghost" data-spk-text="${esc(e.example || e.text)}" data-spk-lang="${e.lang}">${icon('i-volume')} 朗读</button>
        </div>
      </div>
    `;
  }

  // ============================================================
  // 视图：统计
  // ============================================================

  function renderStats() {
    const s = Store.stats(ui.lang);
    const maxTrend = Math.max(1, ...s.trend.map(t => t.total));

    return `
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">🔥 连续学习</div>
          <div class="stat-value">${s.streak}<span class="stat-unit">天</span></div>
          <div class="stat-foot">完成打卡 ${s.completedDays} 天</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">📚 新增词汇</div>
          <div class="stat-value">${s.totalEntries}<span class="stat-unit">条</span></div>
          <div class="stat-foot">今日新增 ${s.todayAdded} 条</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">🎯 已学习</div>
          <div class="stat-value">${s.learned}<span class="stat-unit">词</span></div>
          <div class="stat-foot">已掌握 ${s.mastered} 词 · 掌握率 ${s.masterRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">⏰ 待复习</div>
          <div class="stat-value" style="${s.due > 0 ? 'color:var(--danger)' : ''}">${s.due}</div>
          <div class="stat-foot">累计学习 ${s.totalMinutes} 分钟</div>
        </div>
      </div>

      <div class="chart-grid" style="margin-bottom:14px">
        <div class="card">
          <div class="card-head"><h2 class="card-title">近 7 日录入趋势</h2></div>
          <div class="card-body">
            <div class="bar-chart">
              ${s.trend.map(t => {
                const h = t.total === 0 ? 3 : Math.max(8, Math.round((t.total / maxTrend) * 118));
                return `
                  <div class="bar-col">
                    <span class="bar-value">${t.total || ''}</span>
                    <div class="bar-stack" style="height:${h}px" title="${t.date}：${t.total} 条">
                      ${t.en ? `<div class="bar-seg en" style="height:${(t.en / (t.total || 1)) * 100}%"></div>` : ''}
                      ${t.ja ? `<div class="bar-seg ja" style="height:${(t.ja / (t.total || 1)) * 100}%"></div>` : ''}
                      ${t.ko ? `<div class="bar-seg ko" style="height:${(t.ko / (t.total || 1)) * 100}%"></div>` : ''}
                    </div>
                    <span class="bar-label">${t.label}</span>
                  </div>`;
              }).join('')}
            </div>
            <div style="display:flex;gap:14px;justify-content:center;margin-top:12px;font-size:11px;color:var(--text-3)">
              <span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--en)"></i> 英语</span>
              <span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--ja)"></i> 日语</span>
              <span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--ko)"></i> 韩语</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2 class="card-title">语言分布</h2></div>
          <div class="card-body">
            ${['en', 'ja', 'ko'].map(lg => {
            const c = s.byLang[lg] || 0;
            const p = s.learned ? Math.round((c / s.learned) * 100) : 0;
              return `
                <div class="progress-row">
                  <div class="progress-head">
                    <span style="font-weight:600">${LANGS[lg].flag} ${LANGS[lg].name}</span>
                    <span style="color:var(--text-3)">${c} 条 · ${p}%</span>
                  </div>
                  <div class="progress-track"><div class="progress-fill ${lg}" style="width:${p}%"></div></div>
                </div>`;
            }).join('')}

            <div style="border-top:1px solid var(--border);margin:16px 0 14px"></div>
            <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:10px">掌握程度分布</div>
            ${LEVELS.map(l => {
            const c = s.byLevel[l.v] || 0;
            const p = s.learned ? Math.round((c / s.learned) * 100) : 0;
              return `
                <div class="progress-row">
                  <div class="progress-head">
                    <span>${l.name}</span><span style="color:var(--text-3)">${c}</span>
                  </div>
                  <div class="progress-track"><div class="progress-fill l${l.v}" style="width:${p}%"></div></div>
                </div>`;
            }).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2 class="card-title">打卡热力图</h2>
          <span style="margin-left:auto;font-size:11px;color:var(--text-3)">最近 15 周</span>
        </div>
        <div class="card-body">
          <div class="heatmap">${renderHeatmap()}</div>
          <div style="display:flex;align-items:center;gap:5px;margin-top:12px;font-size:11px;color:var(--text-3)">
            <span>少</span>
            ${[0, 1, 2, 3, 4].map(v => `<i class="heat-cell" data-v="${v}"></i>`).join('')}
            <span>多</span>
          </div>
        </div>
      </div>
    `;
  }

  function renderHeatmap() {
    const cells = [];
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 104);
    start.setDate(start.getDate() - start.getDay()); // 对齐到周日

    for (let i = 0; i < 105 + today.getDay(); i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      if (d > today) break;
      const key = todayKey(d);
      const v = Store.activityLevel(key);
      cells.push(`<i class="heat-cell" data-v="${v}" title="${key}"></i>`);
    }
    return cells.join('');
  }

  // ============================================================
  // 渲染调度
  // ============================================================

  const TITLES = {
    capture: ['今日学习', '系统生成专属词包，认识 / 不认识即加入复习队列'],
    review:  ['复习巩固', '基于艾宾浩斯遗忘曲线安排'],
    history: ['历史归档', '按日期折叠，随时回溯'],
    stats:   ['学习统计', '进度与坚持度一览']
  };

  // 顶栏语言筛选：高亮跟随当前视图语言焦点，在学习/复习/历史页显示
  function syncLangTabs() {
    const inLearn = !!ui.learn;
    const show = inLearn || ui.view === 'review' || ui.view === 'history';
    const active = ui.view === 'review' ? ui.lang : (inLearn ? (ui.learn.focus || 'en') : ui.lang);
    // 同步所有语言标签（含顶部与历史页内的副本），高亮当前语言
    $$('.lang-tab').forEach(b => b.classList.toggle('active', b.dataset.lang === active));
    const top = $('#langTabs');
    if (top) top.style.display = show ? '' : 'none';  // 顶栏语言筛选在「今日录入（未学习）」时隐藏；移动端历史页由 CSS 收起，改用页面内副本
  }

  function render() {
    try {
    applyTheme(Store.state.settings.theme || 'light');   // 任何重渲染都让主题与 state 一致：本地切换、云端推送换主题、刷新后均自动同步
    document.body.setAttribute('data-view', ui.view);    // 供 CSS 按视图微调布局（如移动端历史页收起顶栏语言标签）
    const [title, sub] = TITLES[ui.view];
    $('#pageTitle').textContent = title;
    $('#pageSub').textContent = sub;

    let html = '';
    if (ui.view === 'capture') html = renderCapture();
    else if (ui.view === 'review') html = renderReview();
    else if (ui.view === 'history') html = renderHistory();
    else if (ui.view === 'stats') html = renderStats();

    $('#content').innerHTML = html;
    syncLangTabs();

    // 待复习角标
    const due = Store.dueEntries(ui.lang).length;
    [['#navDue', due], ['#mnavDue', due]].forEach(([sel, n]) => {
      const el = $(sel);
      if (!el) return;
      el.textContent = n > 99 ? '99+' : n;
      el.classList.toggle('hidden', n === 0);
    });

    // 导航高亮
    $$('.nav-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === ui.view));
    $$('.mnav-item').forEach(b => b.classList.toggle('active', b.dataset.view === ui.view));

    if (ui.view === 'capture' && ui.captureMode === 'bulk' && ui.draft.bulk) {
      renderBulkPreview();
    }
    } catch (err) {
      // 单视图渲染异常不应拖垮整个应用 / 阻断导航：就地显示可恢复的错误，控制台保留堆栈
      console.error('render failed', err);
      const content = $('#content');
      if (content) {
        content.innerHTML = `
          <div class="card" style="margin-top:20px">
            <div class="empty">
              <div class="empty-icon">⚠️</div>
              <div class="empty-title">该页面渲染出错</div>
              <div class="empty-text" style="text-align:left;max-width:560px;margin:0 auto">
                错误信息：${esc(err && err.message ? err.message : String(err))}<br>
                可先切换到其它页面继续使用；若要恢复此页面，请刷新或重新选择心情。
              </div>
              <button class="btn btn-primary" style="margin-top:12px" onclick="location.reload()">刷新页面</button>
            </div>
          </div>`;
      }
    }
  }

  function switchView(v) {
    ui.view = v;
    if (v === 'review') buildReviewQueue();
    render();
    $('#main').scrollTop = 0;
  }

  // ============================================================
  // 事件绑定
  // ============================================================

  function bindGlobal() {
    // 导航
    $$('.nav-item[data-view]').forEach(b => b.onclick = () => switchView(b.dataset.view));
    $$('.mnav-item').forEach(b => b.onclick = () => switchView(b.dataset.view));

    // 顶栏语言筛选（学习页切单词 / 复习页切复习）；历史页内的副本也复用同一绑定
    $$('.lang-tab[data-lang]').forEach(b => b.onclick = () => selectLang(b.dataset.lang));

    // 主题
    const toggleTheme = () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      Store.state.settings.theme = next;
      Store.commit();
    };
    $('#btnTheme').onclick = toggleTheme;
    $('#btnThemeMobile').onclick = toggleTheme;

    // 手动同步到云端（点一下立即双向同步：推本地 + 拉远端，弥补 20s 轮询不及时）
    const syncNowCloud = async () => {
      const s = Store.state.settings;
      if (!s.gistSync || Store.adapter.name !== 'gist') {
        toast('尚未开启 GitHub 同步，请先在设置里开启后再同步', 'warn');
        return;
      }
      const Gist = window.LangStore.GistAdapter;
      if (!Gist || !s.gistToken || !s.gistKey) {
        toast('同步凭证缺失，请检查设置中的 Token 与同步码', 'warn');
        return;
      }
      // 限流中：直接提示，不重复发请求（避免进一步消耗配额）；限流恢复后会自动补传
      if (Gist._rateLimitedUntil && Date.now() < Gist._rateLimitedUntil) {
        toast('GitHub 限流中，预计 ' + new Date(Gist._rateLimitedUntil).toLocaleTimeString() + ' 恢复，稍后会自动同步', 'warn');
        return;
      }
      const btns = $$('#btnSyncCloud, #btnSyncCloudTop');
      btns.forEach(b => { if (b) b.disabled = true; });
      Store._setStatus('saving');

      // 手动同步增加重试：GitHub 在国内网络不稳定，一次超时未必是真的失败
      const fetchRemote = async (attempts = 3, delay = 1200) => {
        for (let i = 0; i < attempts; i++) {
          await Gist.init({ token: s.gistToken, key: s.gistKey });
          const remote = await Gist.load();
          if (remote && typeof remote === 'object') return remote;
          const type = Gist._lastErrorType;
          if (type === 'auth' || type === 'notfound') throw new Error(Gist.error || '拉取云端失败');
          if (i < attempts - 1) await new Promise(r => setTimeout(r, delay));
        }
        throw new Error(Gist.error || '拉取云端失败，请检查网络');
      };
      const pushRemote = async (attempts = 3, delay = 1200) => {
        for (let i = 0; i < attempts; i++) {
          await Gist.init({ token: s.gistToken, key: s.gistKey });
          if (await Gist.save(Store.state)) return true;
          const type = Gist._lastErrorType;
          if (type === 'auth' || type === 'notfound') throw new Error(Gist.error || '上传失败');
          if (type === 'ratelimit') {
            toast('GitHub 限流中，预计 ' + new Date(Gist._rateLimitedUntil).toLocaleTimeString() + ' 恢复', 'warn');
            return false;
          }
          if (i < attempts - 1) await new Promise(r => setTimeout(r, delay));
        }
        throw new Error(Gist.error || '上传失败，请检查网络');
      };

      try {
        await Store.flush();                                                       // 先落本地镜像
        const remote = await fetchRemote();                                        // 先拉：取回云端最新并应用（含其它端改动）
        if (Store._applyRemote(remote)) { Store._emit(); if (Store.onRemote) Store.onRemote(); }
        const pushed = await pushRemote();                                         // 后推：把合并后的最新写回云端
        if (pushed) {
          toast('已同步（已合并云端更新）', 'ok');
          Store._setStatus('saved');
        } else {
          Store._setStatus('ratelimit');
        }
      } catch (e) {
        Store._setStatus('offline');
        toast('同步失败：' + (e && e.message ? e.message : e), 'err');
      } finally {
        btns.forEach(b => { if (b) b.disabled = false; });
      }
    };
    const syncBtn = $('#btnSyncCloud');
    if (syncBtn) syncBtn.onclick = syncNowCloud;
    const topSyncBtn = $('#btnSyncCloudTop');
    if (topSyncBtn) topSyncBtn.onclick = syncNowCloud;

    // 导入导出
    $('#btnExport').onclick = doExport;
    $('#btnImport').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = doImport;

    // 设置（右上角齿轮）
    $('#btnOpenSettings').onclick = openSettings;

    // 内容区事件委托
    $('#content').addEventListener('click', onContentClick);
    $('#content').addEventListener('input', onContentInput);
    $('#content').addEventListener('change', onContentChange);
    $('#modalRoot').addEventListener('click', onModalClick);

    // 键盘快捷键
    document.addEventListener('keydown', onKeydown);

    // 关闭前强制落盘
    window.addEventListener('beforeunload', () => { Store.flush(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') Store.flush();
    });
  }

  function onKeydown(ev) {
    // 复习页快捷键
    if (ui.view === 'review' && ui.review.queue.length) {
      const tag = ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        if (!ui.review.revealed) { ui.review.revealed = true; render(); }
        return;
      }
      if (ui.review.revealed && ['1', '2', '3'].includes(ev.key)) {
        ev.preventDefault();
        grade(['again', 'hard', 'good'][Number(ev.key) - 1]);
        return;
      }
    }
    // 录入页 Ctrl+Enter 提交
    if (ui.view === 'capture' && (ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      if (ui.captureMode === 'form') submitForm();
      else bulkAdd();
    }
  }

  function onContentClick(ev) {
    const t = ev.target;

    // ---- 语音朗读（单词 / 例句） ----
    const spkBtn = t.closest('[data-spk-text]');
    if (spkBtn) { speakText(spkBtn.dataset.spkText, spkBtn.dataset.spkLang); return; }

    // ---- 今日学习：心情(单选) / 兴趣(多选) / 生成 ----
    const mc = t.closest('[data-mood]');
    if (mc) {
      const k = mc.dataset.mood;
      ui.selectedMood = (ui.selectedMood === k) ? null : k;
      render();
      return;
    }
    const ic = t.closest('[data-interest]');
    if (ic) {
      const k = ic.dataset.interest;
      const i = ui.selectedInterests.indexOf(k);
      if (i >= 0) ui.selectedInterests.splice(i, 1);
      else ui.selectedInterests.push(k);
      render();
      return;
    }
    if (t.closest('#btnGenLearn')) {
      if (!ui.selectedMood && !ui.selectedInterests.length) { toast('请先选心情或兴趣', 'warn'); return; }
      const keys = [];
      if (ui.selectedMood) keys.push(ui.selectedMood);
      ui.selectedInterests.forEach(k => keys.push(k));
      startLearn(keys);
      return;
    }
    if (t.closest('#btnSurprise')) { startLearn([LangThemes.suggestTheme(todayKey())]); return; }
    if (t.closest('#btnManualAdd')) { openManualAdd(); return; }
    if (t.closest('#btnBackTheme')) { pauseTimer(); ui.learn = null; ui.learnDismissed = true; persistLearn(); render(); return; }  // 主动换主题：清空持久化会话并优先展示选择器
    if (t.closest('#btnReshuffle')) {
      pauseTimer();
      ui.learn.salt = (ui.learn.salt || 0) + 1;
      persistLearn();      // 先锁定新 salt：避免 regenerate 内部 render 触发 renderCapture 旧会话恢复，把「换一批」撤销
      regenerateLearn();
      persistLearn();      // 保存新词包
      render(); return;
    }
    if (t.closest('#btnFinishLater')) { pauseTimer(); persistLearn(); ui.learn = null; render(); toast('已保存进度，随时继续', 'ok'); return; }  // 保留 learnSession（含词包），下次进入 capture 自动恢复相同内容

    if (t.closest('#btnViewStats')) { ui.learn = null; switchView('stats'); return; }
    const lb = t.closest('.learn-btn');
    if (lb) { learnWord(lb.dataset.bank, lb.dataset.judge); return; }

    // ---- 录入模式切换 ----
    const modeBtn = t.closest('.capture-mode button');
    if (modeBtn) { ui.captureMode = modeBtn.dataset.mode; render(); return; }

    // ---- 草稿语言/类型/等级 ----
    const langBtn = t.closest('[data-role="draftLang"] .lang-tab');
    if (langBtn) { ui.draft.lang = langBtn.dataset.lang; saveDraft(); render(); return; }

    const typeBtn = t.closest('[data-role="draftType"] .chip');
    if (typeBtn) { ui.draft.type = typeBtn.dataset.type; saveDraft(); render(); return; }

    const lvBtn = t.closest('[data-role="draftLevel"] .level-opt');
    if (lvBtn) { ui.draft.level = Number(lvBtn.dataset.level); saveDraft(); render(); return; }

    // ---- 提交 ----
    if (t.closest('#btnAdd')) { submitForm(); return; }
    if (t.closest('#btnClearDraft')) { clearDraft(); render(); toast('草稿已清空'); return; }
    if (t.closest('#btnParse')) { renderBulkPreview(); return; }
    if (t.closest('#btnBulkAdd')) { bulkAdd(); return; }

    // ---- 今日打卡（听说读写） ----
    const sc = t.closest('.skill-card');
    if (sc) {
      const on = Store.toggleCheckin(sc.dataset.skill);
      sc.classList.toggle('done', on);
      return;
    }

    // ---- 历史折叠 ----
    const dayHead = t.closest('.day-head');
    if (dayHead) {
      const g = dayHead.parentElement;
      const date = g.dataset.date;
      if (ui.openDays.has(date)) ui.openDays.delete(date);
      else ui.openDays.add(date);
      g.classList.toggle('open');
      return;
    }

    if (t.closest('#btnExpandAll')) {
      Store.groupByDate(Store.state.entries).forEach(g => ui.openDays.add(g.date));
      render(); return;
    }
    if (t.closest('#btnCollapseAll')) { ui.openDays.clear(); render(); return; }

    // ---- 条目操作 ----
    const actBtn = t.closest('[data-act]');
    if (actBtn) {
      const act = actBtn.dataset.act;
      const id = actBtn.dataset.id || (actBtn.closest('.entry') || {}).dataset?.id;
      if (act === 'speak') { speak(id); return; }
      if (act === 'edit') { openEdit(id); return; }
      if (act === 'del') { confirmDelete(id); return; }
    }

    // ---- 复习 ----
    if (t.closest('#flashcard') && !ui.review.revealed) {
      ui.review.revealed = true; render(); return;
    }
    if (t.closest('#btnReveal')) { ui.review.revealed = true; render(); return; }

    const gradeBtn = t.closest('[data-grade]');
    if (gradeBtn) { grade(gradeBtn.dataset.grade); return; }

    if (t.closest('#btnSkip')) {
      ui.review.index++;
      ui.review.revealed = false;
      if (ui.review.index >= ui.review.queue.length) ui.review.queue = [];
      render(); return;
    }
    if (t.closest('#btnRebuild')) { buildReviewQueue(); render(); return; }
  }

  // 弹窗内的事件（朗读 / 打卡技能）
  function onModalClick(ev) {
    const t = ev.target;
    const spkBtn = t.closest('[data-spk-text]');
    if (spkBtn) { speakText(spkBtn.dataset.spkText, spkBtn.dataset.spkLang); return; }
    const sc = t.closest('.skill-card');
    if (sc) {
      const on = Store.toggleCheckin(sc.dataset.skill);
      sc.classList.toggle('done', on);
      return;
    }
  }

  function onContentInput(ev) {
    const t = ev.target;

    // 表单草稿自动保存
    const key = t.dataset.draft;
    if (key) { ui.draft[key] = t.value; saveDraft(); return; }

    if (t.id === 'bulkText') { ui.draft.bulk = t.value; saveDraft(); return; }

    if (t.id === 'searchInput') {
      ui.filter.q = t.value;
      clearTimeout(t._timer);
      t._timer = setTimeout(() => {
        const pos = t.selectionStart;
        render();
        const el = $('#searchInput');
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      }, 220);
      return;
    }

    // 打卡时长
    if (t.dataset.minutes) {
      Store.setCheckinMinutes(Number(t.value) || 0);
      return;
    }
  }

  function onContentChange(ev) {
    const t = ev.target;
    if (t.id === 'filterType') { ui.filter.type = t.value; render(); }
    if (t.id === 'filterLevel') { ui.filter.level = t.value; render(); }
    if (t.id === 'filterTag') { ui.filter.tag = t.value; render(); }
    if (t.dataset.draft === 'pos') { ui.draft.pos = t.value; saveDraft(); }
  }

  // ============================================================
  // 今日学习：主题选词 + 逐词学习 + 加入复习
  // ============================================================

  function themeName(key) {
    const t = LangThemes.THEME_MAP[key];
    return t ? t.name : key;
  }

  function startLearn(themeKeys) {
    const order = ['en', 'ja', 'ko'];
    ui.learnDismissed = false;   // 重新生成后清除「换主题」标记
    ui.learn = {
      date: todayKey(),          // 与持久化会话保持一致，避免 learnIdentity 比较时因缺 date 触发无谓 restore
      themes: themeKeys.slice(), salt: 0, added: new Set(), judged: {},
      pack: { en: [], ja: [], ko: [] }, total: 0,   // 初始化为空对象，避免 persistLearn 访问 null 崩溃
      order, idx: 0, focus: 'en',      // focus: 顶栏语言筛选（'all' 显示三语，否则单语）
      dur: { en: 0, ja: 0, ko: 0 },   // 每语累计学习秒数
      activeLang: null, activeStart: 0,
      langDone: { en: false, ja: false, ko: false },
      langCheckedIn: { en: false, ja: false, ko: false }  // 学完并确认打卡后标记
    };
    persistLearn();        // 先落盘：保证随后 regenerateLearn 内的 render 时，Store.state.learnSession 已是新会话（身份一致），不会被旧云端/本地会话覆盖
    regenerateLearn();
    persistLearn();        // 再落盘：保存刚生成的词包本身，保证「稍后再学」重开得到完全相同的词
  }

  // 把内存中的今日学习会话序列化进 Store.state.learnSession（持久化 + 参与 GitHub 同步）。
  // 注意：计时 activeStart 等临时态不入；added 是 Set 需转数组；不含任何 Token/Key。
  // 关键：连同「词包 pack 本身」一起保存，保证「稍后再学」后重开得到完全相同的词与进度，
  // 而不是按 learned 集合重新生成（那样刚学过的词会被排除导致内容变化）。
  function persistLearn() {
    const L = ui.learn;
    if (!L) {
      Store.state.learnSession = null;
      Store.commit();
      return;
    }
    ensureDur(L);
    const pack = {};
    const srcPack = L.pack && typeof L.pack === 'object' ? L.pack : {};
    ['en', 'ja', 'ko'].forEach(lg => {
      pack[lg] = (srcPack[lg] || []).map(x => Object.assign({}, x));   // 深拷贝，避免与内存引用纠缠
    });
    const total = (pack.en.length) + (pack.ja.length) + (pack.ko.length);
    Store.state.learnSession = {
      date: todayKey(),
      updatedAt: Date.now(),    // 会话时间戳：用于跨端冲突解决（本地更新则不被旧云端数据覆盖）
      themes: L.themes.slice(),
      salt: L.salt || 0,
      focus: L.focus || 'en',
      order: L.order.slice(),
      idx: L.idx || 0,
      langDone: Object.assign({}, L.langDone),
      langCheckedIn: Object.assign({}, L.langCheckedIn),
      dur: Object.assign({ en: 0, ja: 0, ko: 0 }, L.dur),
      added: Array.from(L.added || []),
      judged: Object.assign({}, L.judged),
      pack, total
    };
    Store.commit();
  }

  // 从持久化/同步来的 learnSession 恢复内存会话
  function restoreLearn() {
    const s = Store.state.learnSession;
    if (!s || s.date !== todayKey()) { ui.learn = null; return; }
    // 过滤掉云端/旧版本中可能已失效的主题 key，避免渲染时取 THEME_MAP[k] 为 undefined 而崩溃
    const themes = (s.themes || []).filter(k => LangThemes.THEME_MAP[k]);
    if (!themes.length) { ui.learn = null; Store.state.learnSession = null; return; }
    const L = {
      date: todayKey(),
      themes: themes,
      salt: s.salt || 0,
      added: new Set(s.added || []),
      judged: Object.assign({}, s.judged),
      pack: null, total: 0,
      order: (s.order || ['en', 'ja', 'ko']).slice(),
      idx: s.idx || 0,
      focus: s.focus || 'en',
      dur: Object.assign({ en: 0, ja: 0, ko: 0 }, s.dur || {}),
      activeLang: null, activeStart: 0,
      langDone: Object.assign({ en: false, ja: false, ko: false }, s.langDone),
      langCheckedIn: Object.assign({ en: false, ja: false, ko: false }, s.langCheckedIn),
      aiLoading: false
    };
    ui.learn = L;
    // 优先直接复用已持久化的词包（完全相同的词与进度），仅旧版本无 pack 时才重新生成
    if (s.pack && ((s.pack.en || []).length || (s.pack.ja || []).length || (s.pack.ko || []).length)) {
      L.pack = {
        en: (s.pack.en || []).map(x => Object.assign({}, x)),
        ja: (s.pack.ja || []).map(x => Object.assign({}, x)),
        ko: (s.pack.ko || []).map(x => Object.assign({}, x))
      };
      L.total = ((L.pack.en || []).length) + ((L.pack.ja || []).length) + ((L.pack.ko || []).length);
      ensureDur(L);
      const focusLang = (L.focus === 'all') ? L.order[0] : (L.focus || L.order[0]);
      startTimer(focusLang);
      render();
    } else {
      regenerateLearn();
    }
  }

  // ---------- 学习计时（按语言） ----------
  function ensureDur(L) {
    if (!L) return null;
    if (!L.dur || typeof L.dur !== 'object') L.dur = { en: 0, ja: 0, ko: 0 };
    ['en', 'ja', 'ko'].forEach(lg => { if (typeof L.dur[lg] !== 'number') L.dur[lg] = 0; });
    return L.dur;
  }
  function pauseTimer() {
    const L = ui.learn;
    if (!L || !L.activeLang || !L.activeStart) return;
    const dur = ensureDur(L);
    dur[L.activeLang] = (dur[L.activeLang] || 0) + Math.floor((Date.now() - L.activeStart) / 1000);
    L.activeStart = 0; L.activeLang = null;
  }
  function startTimer(lang) {
    const L = ui.learn;
    if (!L || L.langCheckedIn[lang]) return;   // 已打卡完成的语言不再计时，保持时长定格
    ensureDur(L);
    L.activeLang = lang; L.activeStart = Date.now();
  }
  function langSeconds(lang) {
    const L = ui.learn;
    if (!L) return 0;
    const dur = ensureDur(L);
    let s = dur[lang] || 0;
    if (L.activeLang === lang && L.activeStart) s += Math.floor((Date.now() - L.activeStart) / 1000);
    return s;
  }
  function totalSeconds() {
    const L = ui.learn;
    if (!L) return 0;
    ensureDur(L);
    return ['en', 'ja', 'ko'].reduce((a, lg) => a + langSeconds(lg), 0);
  }
  function fmtDuration(sec) {
    sec = Math.max(0, sec | 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m <= 0) return s + ' 秒';
    return m + ' 分 ' + (s < 10 ? '0' : '') + s + ' 秒';
  }

  // 顶栏语言筛选（全部/英语/日语/韩语）：学习页切单词、复习页切复习
  function selectLang(lang) {
    ui.lang = lang;
    Store.state.settings.activeLang = lang;
    Store.commit();
    if (ui.learn) {                         // 学习中：'all' 显示三语，否则只显示该语言
      pauseTimer();
      ui.learn.focus = lang;
      if (lang !== 'all') startTimer(lang);
    }
    if (ui.view === 'review') buildReviewQueue();
    render();
  }

  // ---------- 学完一种语言 → 弹出「完成打卡」 ----------
  function showLangCheckin(lang) {
    const L = ui.learn;
    const info = LANGS[lang];
    const studied = ((L.pack && L.pack[lang]) || []).filter(x => L.added.has(x._bankId));
    const sec = langSeconds(lang);
    const rec = Store.getCheckin();

    const body = `
      <div style="text-align:center;margin-bottom:6px">
        <div style="font-size:30px">${info.flag}</div>
        <div style="font-size:16px;font-weight:700;margin-top:2px">${esc(info.name)} · 今日 ${studied.length} 词学完 🎉</div>
      </div>

      <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin:10px 0 2px;flex-wrap:wrap">
        <span class="badge badge-neutral">⏱ 本次学习时长</span>
        <b style="font-size:18px">${fmtDuration(sec)}</b>
      </div>
      <div style="font-size:12px;color:var(--text-3);text-align:center;margin-bottom:8px">今日累计学习 ${fmtDuration(totalSeconds())}</div>

      <div style="font-size:12px;font-weight:600;color:var(--text-2);margin:14px 0 8px">今日词汇总结（${esc(info.name)}）</div>
      <div class="word-summary">
        ${studied.map(it => `
          <div class="ws-item">
            <div class="ws-head">
              <b>${esc(it.text)}</b>
              <button class="spk" data-spk-text="${esc(it.text)}" data-spk-lang="${lang}" title="朗读">${icon('i-volume')}</button>
              ${it.reading ? `<span class="ws-read">${esc(it.reading)}</span>` : ''}
            </div>
            <div class="ws-mean">${esc(it.meaning)}</div>
            ${it.example ? `<div class="ws-ex">${esc(it.example)} <button class="spk" data-spk-text="${esc(it.example)}" data-spk-lang="${lang}" title="朗读">${icon('i-volume')}</button>${it.exampleTrans ? `<span class="ws-ext">${esc(it.exampleTrans)}</span>` : ''}</div>` : ''}
          </div>`).join('')}
      </div>

      <div style="font-size:12px;font-weight:600;color:var(--text-2);margin:16px 0 8px">今天练了哪些？（听说读写）</div>
      <div class="skill-grid">
        ${SKILLS.map(s => `
          <div class="skill-card ${rec[s.key] ? 'done' : ''}" data-skill="${s.key}">
            <span class="skill-check">✓</span>
            <span class="skill-emoji">${s.emoji}</span>
            <span class="skill-name">${s.name}</span>
          </div>`).join('')}
      </div>`;

    const foot = `
      <button class="btn btn-ghost" id="lcStats">查看统计</button>
      <button class="btn btn-primary" id="lcDone" style="flex:1">完成今日打卡 🎉</button>`;

    modal({
      title: '完成打卡',
      body,
      foot,
      onMount(c) {
        const statsBtn = $('#lcStats');
        if (statsBtn) statsBtn.onclick = () => { c(); switchView('stats'); };
        const doneBtn = $('#lcDone');
        if (doneBtn) doneBtn.onclick = () => {
        c();
        L.langCheckedIn[lang] = true;
        persistLearn();
        render();
        // 三语都完成打卡 → 把今天标记为完成打卡，用于统计
        if (L.order.every(lg => L.langCheckedIn[lg])) {
          Store.setCheckinCompleted(todayKey());
        }
      };
      }
    });
  }

  function regenerateLearn() {
    const L = ui.learn;
    if (!L) return;
    const learned = new Set(Store.state.entries.filter(e => e.learned).map(e => e._bankId).filter(Boolean));
    const perLang = Store.state.settings.dailyGoal || 10;
    const aiOn = !!(window.LangAI && LangAI.enabled());
    const bankCount = Math.max(1, Math.floor(perLang / 2));   // 词库（主题）词：约一半
    const aiCount = perLang - bankCount;                       // AI 拓展词：约一半
    const diff = Store.state.settings.difficulty || { en: 3, ja: 1, ko: 1 };
    // 已打卡完成的语言保留原 pack/时长/状态，只重新生成未打卡的语言
    const langsToGen = L.order.filter(lg => !L.langCheckedIn[lg]);
    if (langsToGen.length > 0) {
      const newPack = LangThemes.generatePack({
        themeKeys: L.themes, perLang: aiOn ? bankCount : perLang, difficulty: diff, learned,
        dateKey: todayKey(), salt: L.salt, langs: langsToGen
      }) || { en: [], ja: [], ko: [] };
      langsToGen.forEach(lg => { L.pack[lg] = newPack[lg] || []; });
    }
    L.total = ((L.pack.en || []).length) + ((L.pack.ja || []).length) + ((L.pack.ko || []).length);
    // 标记已学完的语言（仅用于内部判断，不再自动跳到下一语言）
    L.order.forEach(lg => {
      const items = (L.pack && L.pack[lg]) || [];
      L.langDone[lg] = items.length > 0 && items.every(x => L.added.has(x._bankId));
    });
    // 当前 focus 已打卡则自动切到第一个未打卡语言；若全部打卡则不启动计时
    const focusLang = (L.focus === 'all') ? L.order[0] : (L.focus || L.order[0]);
    const targetLang = L.langCheckedIn[focusLang]
      ? (L.order.find(lg => !L.langCheckedIn[lg]) || null)
      : focusLang;
    if (targetLang) startTimer(targetLang);
    render();
    if (aiOn && langsToGen.length > 0) aiSupplement(L, { aiCount, perLang, diff });   // 仅给未打卡语言补 AI 词
  }

  // 生成时按主题用 AI 自动补充词库（异步追加，不阻塞首屏）
  // opts: { aiCount, perLang, diff }。AI 词 + 词库词 合计补满到 每日每语词量（aiCount 不足时用词库词兜底）
  function aiSupplement(L, opts) {
    if (!L || !LangAI.enabled()) return;
    opts = opts || {};
    const perLang = opts.perLang || 10;
    const diff = opts.diff || { en: 3, ja: 1, ko: 1 };
    const aiCount = opts.aiCount || 5;
    const langs = ['en', 'ja', 'ko'];
    const themeNames = L.themes.map(themeName);
    const themeLabel = themeNames.join(' · ');
    const existing = [];
    langs.forEach(lg => ((L.pack && L.pack[lg]) || []).forEach(x => { if (x.text) existing.push(x.text); }));

    // 用词库（主题）词把某语言补满到 perLang（AI 不足时兜底，保证总数达标）
    function topUpBank() {
      const learned = new Set(Store.state.entries.filter(e => e.learned).map(e => e._bankId).filter(Boolean));
      langs.forEach(lg => {
        if (L.langCheckedIn[lg]) return;   // 已打卡语言不动
        if (!L.pack) L.pack = { en: [], ja: [], ko: [] };
        let guard = 0;
        while (((L.pack && L.pack[lg]) || []).length < perLang && guard < 8) {
          const need = perLang - ((L.pack && L.pack[lg]) || []).length;
          const extra = LangThemes.generatePack({
            themeKeys: L.themes, perLang: need, difficulty: diff, learned,
            dateKey: todayKey(), salt: (L.salt || 0) + 1000 + guard, langs: [lg]
          })[lg] || [];
          const before = ((L.pack && L.pack[lg]) || []).length;
          extra.forEach(x => {
            if (!(L.pack[lg].some(p => p._bankId === x._bankId))) L.pack[lg].push(x);
          });
          if (((L.pack && L.pack[lg]) || []).length === before) break;   // 已无可补充，避免死循环
          guard++;
        }
      });
    }

    L.aiLoading = true;
    render();
    LangAI.expandPack({ themes: themeNames, langs, perLang: aiCount, existing })
      .then(items => {
        if (!ui.learn || ui.learn !== L) return;          // 用户已切换 / 离开
        const seen = new Set();
        let added = 0, saved = 0;
        items.forEach(it => {
          if (L.langCheckedIn[it.lang]) return;   // 已打卡语言不再追加 AI 词
          const arr = (L.pack && L.pack[it.lang]) || null;
          if (!arr) return;
          const key = it.lang + '|' + it.text.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          if (arr.some(x => (x.text || '').toLowerCase() === it.text.toLowerCase())) return;
          const bid = 'ai:' + it.lang + ':' + it.text.toLowerCase().replace(/\s+/g, '_');
          it._bankId = bid;
          arr.push(it);
          added++;
          // 自动加入词汇库（词库），按 bankId 去重避免重复
          if (!Store.state.entries.some(e => e._bankId === bid)) {
            Store.addEntry({
              lang: it.lang, type: it.type || 'word', text: it.text,
              reading: it.reading, pitch: it.pitch, hanja: it.hanja, pos: it.pos,
              meaning: it.meaning, example: it.example, exampleTrans: it.exampleTrans,
              source: 'AI 补充 · ' + themeLabel, tags: it.tags || [], level: 0, bankId: bid,
              learned: false   // AI 补充词只进词库，不算学过；只有用户点击「认识/不认识」后才算
            });
            saved++;
          }
        });
        topUpBank();   // AI 不足则用词库词补满到 perLang
        L.total = langs.reduce((a, lg) => a + ((L.pack && L.pack[lg]) || []).length, 0);
        L.aiLoading = false;
        persistLearn();   // 关键：把 AI 补充后的完整词包写回 learnSession，否则刷新/同步后 AI 词丢失
        if (added) toast('AI 已补充 ' + added + ' 个词（已加入词库 ' + saved + '）', 'ok');
        render();
      })
      .catch(err => {
        if (!ui.learn || ui.learn !== L) return;
        topUpBank();   // AI 失败也保证当日词量达标
        L.total = langs.reduce((a, lg) => a + ((L.pack && L.pack[lg]) || []).length, 0);
        L.aiLoading = false;
        persistLearn();   // 失败也要持久化兜底补满后的词包
        render();
        toast('AI 补充失败：' + (err && err.message ? err.message : err), 'warn');
      });
  }

  function learnWord(bankId, judge) {
    const L = ui.learn;
    if (!L || L.added.has(bankId)) return;
    let item = null;
    for (const lg of ['en', 'ja', 'ko']) {
      const f = ((L.pack && L.pack[lg]) || []).find(x => x._bankId === bankId);
      if (f) { item = f; break; }
    }
    if (!item) return;
    const known = judge === 'know';
    const themeLabel = L.themes.map(themeName).join(' · ');
    // 按 bankId 去重：AI 拓展词已在生成时写入词库，这里更新其掌握程度并标记为已学
    const existing = Store.state.entries.find(e => e._bankId === bankId);
    if (existing) {
      Store.updateEntry(existing.id, { level: known ? 1 : 0, learned: true });
    } else {
      Store.addEntry({
        lang: item.lang, type: item.type || 'word',
        text: item.text, reading: item.reading, pitch: item.pitch, hanja: item.hanja,
        pos: item.pos, meaning: item.meaning, example: item.example, exampleTrans: item.exampleTrans,
        source: '每日词包 · ' + themeLabel,
        tags: [themeLabel].concat(item.tags || []),
        level: known ? 1 : 0,
        bankId: item._bankId,
        learned: true
      });
    }
    L.added.add(bankId);
    L.judged[bankId] = judge;
    persistLearn();   // 实时保存进度（词包 + 已学集合），保证「稍后再学」重开内容完全一致

    // 当前语言 10 词学完 → 自动弹出完成打卡
    const cur = item.lang;
    const items = (L.pack && L.pack[cur]) || [];
    if (items.length > 0 && items.every(x => L.added.has(x._bankId))) {
      pauseTimer();
      L.langDone[cur] = true;
      const mins = Math.round(langSeconds(cur) / 60);
      if (mins > 0) Store.setCheckinMinutes(Store.getCheckin().minutes + mins);
      showLangCheckin(cur);
      return;
    }
    render();
  }

  function openManualAdd() {
    ui.manual = { cn: '', lang: 'en', f: {} };
    ['en', 'ja', 'ko'].forEach(l => {
      ui.manual.f[l] = { text: '', reading: '', extra: '', meaning: '', example: '', exampleTrans: '', tags: '', pos: '' };
    });
    const M = ui.manual;

    function renderInner() {
      const lg = M.lang, cfg = FIELD_CONFIG[lg], f = M.f[lg];
      return `
        <div class="form-grid">
          <div class="field span-2" style="margin-bottom:12px">
            <label class="label">${cfg.textLabel} <span style="color:var(--danger)">*</span></label>
            <div style="display:flex;gap:8px;align-items:stretch">
              <input class="input" id="ma-text" value="${esc(f.text)}" placeholder="${cfg.textPlaceholder}" style="font-size:15px;font-weight:600;flex:1">
              <button class="btn btn-sm btn-ghost" id="maAi" type="button" title="用 AI 根据上方原文补全下方字段（在原文框按回车也可）">✨ AI 填充</button>
            </div>
          </div>
          <div class="field span-2">
            <label class="label">${cfg.readingLabel} <span class="hint">${cfg.readingHint || ''}</span></label>
            <input class="input" id="ma-reading" value="${esc(f.reading)}" placeholder="${cfg.readingPlaceholder}" style="font-family:var(--mono)">
          </div>
          ${cfg.extra ? `
          <div class="field span-2">
            <label class="label">${cfg.extra.label} <span class="hint">${cfg.extra.hint || ''}</span></label>
            <input class="input" id="ma-extra" value="${esc(f.extra)}" placeholder="${cfg.extra.placeholder}">
          </div>` : ''}
          <div class="field span-2">
            <label class="label">释义 <span style="color:var(--danger)">*</span></label>
            <input class="input" id="ma-meaning" value="${esc(f.meaning)}" placeholder="...">
          </div>
          <div class="field span-2">
            <label class="label">例句</label>
            <textarea class="textarea" id="ma-example" style="min-height:54px">${esc(f.example)}</textarea>
          </div>
          <div class="field span-2">
            <label class="label">例句翻译</label>
            <textarea class="textarea" id="ma-exampleTrans" style="min-height:54px">${esc(f.exampleTrans)}</textarea>
          </div>
          <div class="field span-2">
            <label class="label">标签 <span class="hint">空格或逗号分隔</span></label>
            <input class="input" id="ma-tags" value="${esc(f.tags)}" placeholder="商务 高频">
          </div>
        </div>`;
    }

    const body = `
      <div style="margin-bottom:12px">
        <label class="label">中文概念</label>
        <div style="display:flex;gap:8px;align-items:stretch">
          <input class="input" id="ma-cn" value="${esc(M.cn)}" placeholder="例如：坚持、努力、咖啡" style="font-size:15px;font-weight:600;flex:1">
          <button class="btn btn-sm btn-ghost" id="maGen" type="button" title="用 AI 根据中文概念生成英/日/韩三语">✨ AI 生成三语</button>
        </div>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px">输入中文概念后可由 AI 一次性生成英/日/韩三语单词与全部内容。</div>
      </div>
      <div class="lang-tabs" id="maLang" style="margin-bottom:12px">
        ${['en', 'ja', 'ko'].map(l => `<button class="lang-tab ${M.lang === l ? 'active' : ''}" data-lang="${l}">${LANGS[l].flag} ${LANGS[l].name}</button>`).join('')}
      </div>
      <div id="maInner">${renderInner()}</div>`;

    const close = modal({
      title: '自己加词（三语卡片）',
      body,
      foot: `<button class="btn" id="maCancel">取消</button><button class="btn btn-primary" id="maSave">加入词库</button>`,
      onMount(c) {
        const syncCN = () => { M.cn = $('#ma-cn').value; };
        $('#ma-cn').addEventListener('input', syncCN);

        function bindInner() {
          const f = M.f[M.lang];
          const set = (sel, key) => { const el = $(sel); if (el) el.addEventListener('input', () => { f[key] = el.value; }); };
          set('#ma-text', 'text'); set('#ma-reading', 'reading'); set('#ma-extra', 'extra');
          set('#ma-meaning', 'meaning'); set('#ma-example', 'example'); set('#ma-exampleTrans', 'exampleTrans'); set('#ma-tags', 'tags');
          const maAi = $('#maAi');
          if (maAi) maAi.onclick = async () => {
            const lg = M.lang;
            const text = (M.f[lg].text || '').trim();
            if (!text) { toast('请先在上方填写' + FIELD_CONFIG[lg].textLabel, 'warn'); return; }
            if (!window.LangAI || !LangAI.enabled()) { toast('请先在「设置 - AI 辅助」开启并填写接口与 Key', 'warn'); return; }
            const b = maAi, old = b.textContent;
            b.textContent = '填充中…'; b.disabled = true;
            try {
              const r = await LangAI.fillWord({ lang: lg, text });
              if (r) {
                const f = M.f[lg];
                if (r.reading) f.reading = r.reading;
                if (r.pos) f.pos = r.pos;
                if (r.meaning) f.meaning = r.meaning;
                if (r.example) f.example = r.example;
                if (r.exampleTrans) f.exampleTrans = r.exampleTrans;
                if (r.tags) f.tags = r.tags;
                $('#maInner').innerHTML = renderInner();
                highlightTabs();
                bindInner();
                if (r._partial) {
                  toast('AI 已填充部分字段（释义等未返回，请手动补全）', 'warn');
                } else {
                  toast('AI 已填充「' + LANGS[lg].name + '」字段，可修改后加入', 'ok');
                }
              } else {
                toast(aiErr(null, 'AI 未返回有效内容'), 'warn');
              }
            } catch (err) {
              toast(aiErr(err, 'AI 填充失败'), 'warn');
            } finally {
              b.textContent = old; b.disabled = false;
            }
          };
          // 当前语种“原文”输入框回车：自动触发 AI 填充
          const maTextEl = $('#ma-text');
          if (maTextEl) maTextEl.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const t = (M.f[M.lang].text || '').trim();
              if (t && window.LangAI && LangAI.enabled()) maAi.click();
            }
          });
        }
        bindInner();

        function highlightTabs() {
          $$('#maLang .lang-tab').forEach(x => x.classList.toggle('active', x.dataset.lang === M.lang));
        }

        $$('#maLang .lang-tab').forEach(b => b.onclick = () => {
          M.lang = b.dataset.lang;
          $('#maInner').innerHTML = renderInner();
          highlightTabs();
          bindInner();
        });

        const maGen = $('#maGen');
        if (maGen) maGen.onclick = async () => {
          syncCN();
          const cn = M.cn.trim();
          if (!cn) { toast('请先填写中文概念', 'warn'); return; }
          if (!window.LangAI || !LangAI.enabled()) { toast('请先在「设置」开启 AI 并填写接口与 Key', 'warn'); return; }
          const btn = maGen, old = btn.textContent;
          btn.textContent = '生成中…'; btn.disabled = true;
          try {
            const res = await LangAI.generateTri(cn);
            if (res && (res.en || res.ja || res.ko)) {
              ['en', 'ja', 'ko'].forEach(l => { if (res[l]) Object.assign(M.f[l], res[l]); });
              $('#maInner').innerHTML = renderInner();
              highlightTabs();
              bindInner();
              const partial = ['en', 'ja', 'ko'].some(l => res[l] && res[l]._partial);
              if (partial) toast('AI 已生成三语（部分释义未返回，请检查并补全）', 'warn');
              else toast('AI 已生成三语，可修改后加入', 'ok');
            } else {
              toast(aiErr(null, 'AI 未返回有效内容'), 'warn');
            }
          } catch (err) {
            toast(aiErr(err, 'AI 三语生成失败'), 'warn');
          } finally {
            btn.textContent = old; btn.disabled = false;
          }
        };
        // 中文概念输入框回车：自动触发 AI 生成三语
        const maCnEl = $('#ma-cn');
        if (maCnEl) maCnEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const cn = (M.cn || '').trim();
            if (cn && window.LangAI && LangAI.enabled()) maGen.click();
          }
        });

        $('#maCancel').onclick = c;

        $('#maSave').onclick = () => {
          const gid = 'g_' + uid();
          let added = 0;
          ['en', 'ja', 'ko'].forEach(l => {
            const f = M.f[l];
            const text = (f.text || '').trim();
            const meaning = (f.meaning || '').trim();
            if (!text) return;
            if (!meaning) { toast(LANGS[l].name + ' 的释义未填，跳过该语种', 'warn'); return; }
            const bid = 'me:' + l + ':' + text;   // 自己加词的 bankId 前缀，用于单词卡「自建」标签与去重
            const patch = {
              lang: l, type: 'word', text,
              reading: (f.reading || '').trim(),
              meaning, example: (f.example || '').trim(),
              exampleTrans: (f.exampleTrans || '').trim(),
              pos: (f.pos || '').trim(),
              source: '自己添加', tags: parseTags(f.tags), level: 0,
              cn: M.cn.trim(), groupId: gid, bankId: bid
            };
            if (FIELD_CONFIG[l].extra) patch[FIELD_CONFIG[l].extra.key] = (f.extra || '').trim();
            Store.addEntry(patch);
            // 同步加入当前学习词包（若在学习页且未打卡），单词卡显示「自建」标签
            if (ui.learn && !ui.learn.langCheckedIn[l]) {
              if (!ui.learn.pack[l]) ui.learn.pack[l] = [];
              if (!ui.learn.pack[l].some(x => x._bankId === bid)) {
                ui.learn.pack[l].push({
                  _bankId: bid, lang: l, type: 'word', text,
                  reading: patch.reading, meaning: patch.meaning,
                  example: patch.example, exampleTrans: patch.exampleTrans,
                  pos: patch.pos, source: '自己添加', isManual: true
                });
                ui.learn.total = (ui.learn.total || 0) + 1;
              }
            }
            added++;
          });
          if (!added) { toast('请至少填写一个语种的原文与释义', 'warn'); return; }
          c();
          render();
          toast('已加入词库（' + added + ' 个语种）', 'ok');
        };
      }
    });
  }

  function openSettings() {
    const s = Store.state.settings;
    const body = `
      <div style="margin-bottom:18px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">每日每语词量</div>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="range" id="setCount" min="5" max="30" step="1" value="${s.dailyGoal}" style="flex:1">
          <b id="setCountVal" style="min-width:70px;text-align:right">${s.dailyGoal} 个/语</b>
        </div>
        <div id="setCountTotal" style="font-size:11px;color:var(--text-3);margin-top:4px">三语合计 ${s.dailyGoal * 3} 个/天</div>
      </div>
      <div style="border-top:1px solid var(--border);margin:16px 0;padding-top:14px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">难度（按语言）</div>
        ${['en', 'ja', 'ko'].map(lg => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span class="badge badge-${lg}" style="min-width:54px;justify-content:center">${LANGS[lg].name}</span>
            <div class="type-chips" data-set-diff="${lg}">
              ${LangThemes.DIFFICULTY.map(d => `<button class="chip ${s.difficulty[lg] === d.v ? 'active' : ''}" data-v="${d.v}" data-lg="${lg}" title="${d.desc}">${d.name}</button>`).join('')}
            </div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid var(--border);margin:16px 0;padding-top:14px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">词库规模</div>
        ${(() => {
          const st = LangThemes.bankStats();
          const ents = (Store.state.entries || []);
          const userBy = { en: 0, ja: 0, ko: 0 };
          ents.forEach(e => { if (userBy[e.lang] !== undefined) userBy[e.lang]++; });
          ['en', 'ja', 'ko'].forEach(l => {
            const n = userBy[l] || 0;
            st[l].total += n;
            if (n > 0) st[l].user = n;
            st.total += n;
          });
          return ['en', 'ja', 'ko'].map(l =>
            `<div style="font-size:12px;color:var(--text-2);margin-bottom:4px">${LANGS[l].flag} ${LANGS[l].name}：${st[l].total} 词（入门 ${st[l].byLevel[1]} · 中级 ${st[l].byLevel[2]} · 进阶 ${st[l].byLevel[3]}${st[l].user ? ' · 自建 ' + st[l].user : ''}）</div>`
          ).join('') + `<div style="font-size:12px;color:var(--text-3);margin-top:4px">共 ${LangThemes.THEMES.length} 个主题 · 全库 ${st.total} 词（含自建 ${ents.length}）</div>`;
        })()}
      </div>
      <div style="border-top:1px solid var(--border);margin:16px 0;padding-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-size:13px;font-weight:600">GitHub 同步（手机 ↔ 电脑）</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px" id="gistHint">${s.gistSync ? '已开启' : '未开启'}</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="setGist" ${s.gistSync ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
        <div id="gistCfg" style="${s.gistSync ? '' : 'display:none'}">
          <input type="text" id="setGistToken" class="input" placeholder="GitHub Token（仅勾 gist 权限，存本机）" value="${esc(s.gistToken || '')}" style="width:100%;margin-top:10px">
          <input type="text" id="setGistKey" class="input" placeholder="同步码（Gist ID；留空则自动新建，多端填同一个）" value="${esc(s.gistKey || '')}" style="width:100%;margin-top:8px">
          <div style="font-size:11px;color:var(--text-3);margin-top:6px">无需任何付费云服务：用免费 GitHub 账号生成一个 Personal Access Token（只勾 <code>gist</code> 权限）填上方即可。手机和电脑填<b>同一个 Token + 同一个同步码</b>即双向实时同步。数据存于你的私人 Gist，仅你自己可读。</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);margin:16px 0;padding-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-size:13px;font-weight:600">AI 辅助（拓展词库 / 自动填词）</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px" id="aiHint">${s.ai && s.ai.enabled ? '已开启' : '未开启'}</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="setAi" ${(s.ai && s.ai.enabled) ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
        <div id="aiCfg" style="${(s.ai && s.ai.enabled) ? '' : 'display:none'}">
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
            <span style="font-size:11px;color:var(--text-3)">一键填入接口与模型：</span>
            <button class="btn btn-xs btn-ghost" type="button" data-ai-preset="zhipu">智谱</button>
            <button class="btn btn-xs btn-ghost" type="button" data-ai-preset="deepseek">DeepSeek</button>
            <button class="btn btn-xs btn-ghost" type="button" data-ai-preset="volc">火山引擎</button>
            <button class="btn btn-xs btn-ghost" type="button" data-ai-preset="silicon">硅基流动</button>
          </div>
          <input type="text" id="setAiBase" class="input" placeholder="接口地址，如 https://api.openai.com/v1" value="${esc((s.ai && s.ai.baseUrl) || '')}" style="width:100%">
          <input type="text" id="setAiKey" class="input" placeholder="API Key（仅存本机浏览器，不上传）" value="${esc((s.ai && s.ai.apiKey) || '')}" style="width:100%;margin-top:8px">
          <input type="text" id="setAiModel" class="input" placeholder="模型名，如 gpt-4o-mini / deepseek-chat" value="${esc((s.ai && s.ai.model) || '')}" style="width:100%;margin-top:8px">
          <button class="btn btn-sm btn-ghost" id="setAiTest" type="button" style="margin-top:10px">🧪 测试 AI 连接</button>
          <pre id="setAiTestResult" style="display:none;margin-top:8px;font-size:11px;background:var(--bg-2);padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-all;color:var(--text-2);max-height:160px;overflow:auto"></pre>
          <div style="font-size:11px;color:var(--text-3);margin-top:8px">🔒 API Key 仅存本机浏览器，不会上传。点上方厂商按钮可自动填入接口与模型，再填 Key 即可。</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:6px">支持 OpenAI 兼容接口；地址需为 https，且服务端允许浏览器跨域（CORS）。开启后自动生成主题词包，手动加词也可一键补全释义/例句/读音。</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);margin:16px 0;padding-top:14px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">数据管理</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm btn-ghost" id="setExport" type="button"><svg class="ic"><use href="#i-history"/></svg> 导出备份</button>
          <button class="btn btn-sm btn-ghost" id="setImport" type="button"><svg class="ic"><use href="#i-plus"/></svg> 导入数据</button>
          <button class="btn btn-sm" id="setClear" type="button" style="background:var(--danger);border-color:var(--danger);color:#fff">🗑 清除数据</button>
        </div>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px">「清除数据」会清空全部学习记录（词库、复习进度、打卡），设置保留、不可恢复，建议先「导出备份」。</div>
      </div>`;

    const close = modal({
      title: '设置',
      body,
      foot: `<button class="btn btn-primary" id="setSave">完成</button>`,
      onMount(c) {
        // 统一的 GitHub 连接逻辑（供「回车」「开关自动重连」「关闭设置后台连接」复用）
        const connectGist = async (opts) => {
          opts = opts || {};
          const gt = $('#setGistToken'), gk = $('#setGistKey'), gh = $('#gistHint'), tog = $('#setGist');
          const Gist = window.LangStore.GistAdapter;
          const token = (gt ? gt.value : '').trim();
          const key = (gk ? gk.value : '').trim();
          s.gistToken = token; s.gistKey = key;
          if (!token) {
            if (!opts.silent && gh) { gh.textContent = '请填写 GitHub Token 后自动连接'; gh.style.color = ''; }
            return;
          }
          if (!opts.silent && gh) { gh.textContent = '连接中…'; gh.style.color = ''; }
          try {
            s.gistSync = true; Store.commit();
            const ok = await Store.enableGist(token, key);
            if (!ok) throw new Error(Store._gistError || '未知');
            if (gk && s.gistKey) gk.value = s.gistKey;
            // 临时失败时 enableGist 会保持连接并自动重试，这里给出对应的友好提示
            const lastType = Gist && Gist._lastErrorType;
            if (lastType === 'ratelimit') {
              if (!opts.silent && gh) { gh.textContent = '已连接，GitHub 限流中，' + (Gist._rateLimitedUntil ? '预计 ' + new Date(Gist._rateLimitedUntil).toLocaleTimeString() + ' 恢复' : '稍后自动同步') + ' ⏳'; gh.style.color = ''; }
              if (opts.useToast) toast('GitHub 同步已连接（限流中，稍后自动完成）', 'ok');
            } else if (lastType === 'timeout' || lastType === 'network') {
              if (!opts.silent && gh) { gh.textContent = '已连接，当前网络较慢，稍后自动同步 ⏳'; gh.style.color = ''; }
              if (opts.useToast) toast('GitHub 同步已连接（稍后自动完成）', 'ok');
            } else {
              if (!opts.silent && gh) { gh.textContent = '已同步到 GitHub ✅'; gh.style.color = ''; }
              if (opts.useToast) toast('GitHub 同步已连接', 'ok');
            }
          } catch (err) {
            // 只有 401/404 等不可逆错误才断开并关闭开关；超时/网络/限流已在 enableGist 中保持连接自动重试。
            const msg = String(err.message || err);
            const isFatal = /401|Bad credentials|Unauthorized|404|不存在|无效|撤销/i.test(msg);
            if (isFatal) {
              s.gistSync = false;
              Store.disableGistKeep();   // 断开连接、切回本地，但保留 Token/同步码
              if (tog) tog.checked = false;
            }
            let display = msg;
            if (/401|Bad credentials|Unauthorized/i.test(msg)) {
              display = 'Token 无效或已被撤销（401）：请重新生成只勾 gist 权限的 Classic Token 再粘贴';
            } else if (/404|不存在/i.test(msg)) {
              display = '同步码对应的 Gist 不存在（404）：请检查同步码或新建一个';
            }
            if (!opts.silent && gh) { gh.textContent = '连接失败：' + display + '（已保留填写内容，可稍后重试）'; gh.style.color = 'var(--danger)'; }
            if (opts.useToast) toast('GitHub 同步连接失败：' + display + '（已保留填写内容）', 'warn');
          }
        };
        $('#setCount').addEventListener('input', e => {
          $('#setCountVal').textContent = e.target.value + ' 个/语';
        });
        $$('[data-set-diff] .chip').forEach(b => b.onclick = () => {
          const lg = b.dataset.lg, v = Number(b.dataset.v);
          s.difficulty[lg] = v;
          $$(`[data-set-diff="${lg}"] .chip`).forEach(x => x.classList.toggle('active', x === b));
        });
        // GitHub 同步开关
        const gistToggle = $('#setGist');
        const gistCfg = $('#gistCfg');
        const gistHint = $('#gistHint');
        if (gistToggle) {
          gistToggle.addEventListener('change', () => {
            const on = gistToggle.checked;
            gistCfg.style.display = on ? '' : 'none';
            if (on) {
              s.gistSync = true; Store.commit();   // 标记开启意图
              if (s.gistToken) {
                connectGist();   // 已有 Token：自动重连（内容保留）
              } else {
                // 首次/全空：清空输入，提示填写（避免"填一次就消失"）
                const gToken = $('#setGistToken'), gKey = $('#setGistKey');
                if (gToken) gToken.value = '';
                if (gKey) gKey.value = '';
                gistHint.textContent = '请填写 GitHub Token（仅 gist 权限），按回车连接';
                gistHint.style.color = '';
              }
            } else {
              // 手动关闭：断开连接，但保留已填的 Token/同步码（再次开启自动重连，不丢内容）
              s.gistSync = false;
              Store.disableGistKeep();
              gistHint.textContent = '已断开（Token 已保留，再次开启自动重连）';
              gistHint.style.color = '';
            }
          });
          const gToken = $('#setGistToken'), gKey = $('#setGistKey');
          // 仅在输入框保存值，不在每次按键时发起连接，避免失败循环
          if (gToken) {
            gToken.addEventListener('input', e => { s.gistToken = e.target.value.trim(); });
            gToken.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); connectGist(); } });
          }
          if (gKey) {
            gKey.addEventListener('input', e => { s.gistKey = e.target.value.trim(); });
            gKey.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); connectGist(); } });
          }
        }
        // AI 辅助开关
        const aiToggle = $('#setAi'), aiCfg = $('#aiCfg'), aiHint = $('#aiHint');
        if (aiToggle) {
          aiToggle.addEventListener('change', () => {
            const on = aiToggle.checked;
            aiCfg.style.display = on ? '' : 'none';
            s.ai.enabled = on;
            aiHint.textContent = on ? '已开启' : '未开启';
            Store.commit();
          });
          const ab = $('#setAiBase'), ak = $('#setAiKey'), am = $('#setAiModel');
          if (ab) ab.addEventListener('input', e => { s.ai.baseUrl = e.target.value.trim(); Store.commit(); });
          if (ak) ak.addEventListener('input', e => { s.ai.apiKey = e.target.value.trim(); Store.commit(); });
          if (am) am.addEventListener('input', e => { s.ai.model = e.target.value.trim(); Store.commit(); });
          const aiTest = $('#setAiTest'), aiTestRes = $('#setAiTestResult');
          if (aiTest) aiTest.onclick = async () => {
            aiTestRes.style.display = '';
            aiTestRes.textContent = '测试中…';
            aiTest.disabled = true;
            try {
              const r = await LangAI.test();
              const lines = [
                '请求地址：' + r.url,
                '模型：' + r.model,
                'HTTP 状态：' + (r.status || '无') + (r.ok ? ' ✅' : ' ❌'),
                r.err ? '网络错误：' + r.err : '',
                r.ok ? '' : '响应前 200 字：' + (r.raw ? r.raw.slice(0, 200) : '(空)')
              ].filter(Boolean);
              aiTestRes.textContent = lines.join('\n');
            } catch (err) {
              aiTestRes.textContent = '测试出错：' + (err && err.message ? err.message : err);
            } finally {
              aiTest.disabled = false;
            }
          };
          // 厂商一键填入：自动填好接口地址与模型名，聚焦 Key 输入框，不覆盖已有 Key
          const AI_PRESETS = {
            zhipu:    { name: '智谱',    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
            deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',          model: 'deepseek-chat' },
            volc:     { name: '火山引擎', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'deepseek-v3-250324' },
            silicon:  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1',         model: 'deepseek-ai/DeepSeek-V3' }
          };
          $$('[data-ai-preset]').forEach(btn => {
            btn.onclick = () => {
              const p = AI_PRESETS[btn.dataset.aiPreset];
              if (!p) return;
              s.ai.baseUrl = p.baseUrl;
              s.ai.model = p.model;
              const ab = $('#setAiBase'), am = $('#setAiModel'), ak = $('#setAiKey');
              if (ab) ab.value = p.baseUrl;
              if (am) am.value = p.model;
              if (ak) ak.focus();   // 输入焦点放在 Key 框，只需填写 Key
              Store.commit();
              toast('已填入「' + p.name + '」接口与模型，请填写 API Key', 'ok');
            };
          });
        }
        // 每日每语词量滑块：实时更新“X 个/语”与“三语合计”
        const setCountEl = $('#setCount');
        if (setCountEl) {
          const updCount = () => {
            const v = Number(setCountEl.value) || 10;
            const valEl = $('#setCountVal'); if (valEl) valEl.textContent = v + ' 个/语';
            const totEl = $('#setCountTotal'); if (totEl) totEl.textContent = '三语合计 ' + (v * 3) + ' 个/天';
          };
          setCountEl.addEventListener('input', updCount);
        }
        // 关闭设置时的收尾：开了开关却没填凭证 → 自动关闭同步（保留已填写内容则保持开启）
        const beforeClose = () => {
          if (s.gistSync) {
            if (!s.gistToken && !s.gistKey) {
              // 开启了 GitHub 同步但没填 Token/同步码 → 自动关闭
              s.gistSync = false;
              Store.disableGistKeep();
              if (gistToggle) gistToggle.checked = false;
            } else if (Store.adapter.name !== 'gist') {
              // 已填凭证但尚未连接（如填完直接关设置）→ 后台尝试连接
              connectGist({ silent: true, useToast: true });
            }
          }
          if (s.ai && s.ai.enabled && !s.ai.apiKey) {
            // 开启了 AI 辅助但没填 Key → 自动关闭
            s.ai.enabled = false;
            if (aiToggle) aiToggle.checked = false;
          }
          Store.commit();
        };
        const finish = () => { beforeClose(); c(); };
        $('#setSave').onclick = () => {
          s.dailyGoal = Number($('#setCount').value) || 10;
          Store.commit();
          if (ui.view === 'capture') render();
          finish();
          toast('设置已保存', 'ok');
        };
        // 关闭（X / 点遮罩）同样走 beforeClose 收尾逻辑
        $('#mdClose').onclick = finish;
        $('#mdBackdrop').onclick = e => { if (e.target.id === 'mdBackdrop') finish(); };
        // 数据管理：导出 / 导入 / 清除
        const setExport = $('#setExport');
        if (setExport) setExport.onclick = () => { c(); doExport(); };
        const setImport = $('#setImport');
        if (setImport) setImport.onclick = () => { c(); $('#fileInput').click(); };
        const setClear = $('#setClear');
        if (setClear) setClear.onclick = () => {
          modal({
            title: '清除数据',
            body: `<p style="margin:0 0 8px;color:var(--text-2)">确定清空全部学习记录吗？</p>
                   <div style="padding:12px;background:var(--surface-2);border-radius:8px;font-size:13px;color:var(--text-2)">将删除：词库（全部词条）、复习进度与打卡记录。<br>保留：每日词量、难度、主题、AI 与同步设置。</div>
                   <p style="font-size:12px;color:var(--text-3);margin-top:12px">此操作不可恢复，建议先「导出备份」。</p>`,
            foot: `<button class="btn" id="clCancel">取消</button>
                   <button class="btn btn-primary" style="background:var(--danger);border-color:var(--danger)" id="clOk">清空</button>`,
            onMount(close) {
              $('#clCancel').onclick = close;
              $('#clOk').onclick = async () => {
                Store.state.entries = [];
                Store.state.checkins = {};
                Store.state.learnSession = null;   // 清空今日学习会话，避免清完又被恢复的会话带回到选心情页之外
                Store.state.updatedAt = Date.now();
                // 已开启 GitHub 同步时：先把「空数据」覆盖到云端 Gist，使手机/电脑等所有已同步设备
                // 下次拉取也会变成空，否则云端仍保留旧记录，清完重新打开会从云端把那 4 天拉回来。
                if (Store.state.settings.gistSync && Store.adapter.name === 'gist') {
                  const tok = Store.state.settings.gistToken, key = Store.state.settings.gistKey;
                  Store.signalClearSync();   // 放行一次空上传 + 清掉最佳快照，避免已删数据复活/被拒上传
                  Store.disableGistKeep();   // 先停轮询、切回本地，保留 Token
                  const Gist = window.LangStore.GistAdapter;
                  if (Gist && tok && key) {
                    try {
                      await Gist.init({ token: tok, key: key });
                      await Gist.save(Store.state);   // 云端覆盖为空
                      // 不重新拉取远端（避免把旧记录拉回），仅恢复轮询订阅，保持后续继续同步
                      Store.useAdapter(Gist);
                      Store._gistEnabled = true;
                      if (Store._gistUnsub) { try { Store._gistUnsub(); } catch (e) {} }
                      Store._gistUnsub = Gist.subscribe((remoteState) => {
                        if (Store._applyRemote(remoteState)) { Store._emit(); if (Store.onRemote) Store.onRemote(); }
                      });
                    } catch (e) {}
                  }
                }
                Store.commit();
                close();
                if (ui.view === 'review') buildReviewQueue();
                render();
                toast('学习记录已清空' + (Store.state.settings.gistSync ? '，云端也同步清空' : ''), 'ok');
              };
            }
          });
        };
      }
    });
  }

  // ============================================================
  // 业务动作
  // ============================================================

  function submitForm() {
    const d = ui.draft;
    if (!d.text || !d.text.trim()) {
      toast('请填写原文', 'warn');
      const el = $('[data-draft="text"]');
      if (el) el.focus();
      return;
    }
    if (!d.meaning || !d.meaning.trim()) {
      toast('请填写释义', 'warn');
      const el = $('[data-draft="meaning"]');
      if (el) el.focus();
      return;
    }
    Store.addEntry({
      lang: d.lang, type: d.type || 'word',
      text: d.text, reading: d.reading, pitch: d.pitch, hanja: d.hanja,
      pos: d.pos, meaning: d.meaning, example: d.example,
      exampleTrans: d.exampleTrans, source: d.source, note: d.note,
      tags: parseTags(d.tags), level: d.level || 0
    });
    // 保留语言/类型/来源，清空内容字段，方便连续录入
    const keepSource = d.source, keepTags = d.tags, keepLang = d.lang, keepType = d.type;
    ui.draft = { lang: keepLang, type: keepType, source: keepSource, tags: keepTags, level: 0 };
    saveDraft();
    render();
    toast('已添加并自动保存', 'ok');
    setTimeout(() => {
      const el = $('[data-draft="text"]');
      if (el) el.focus();
    }, 30);
  }

  function renderBulkPreview() {
    const text = ($('#bulkText') || {}).value || ui.draft.bulk || '';
    const lang = ui.draft.lang || 'en';
    const type = ui.draft.type || 'word';
    const parsed = parseBulk(text, lang, type);
    const box = $('#bulkPreview');
    if (!box) return;

    if (!parsed.length) {
      box.innerHTML = `<div style="font-size:12px;color:var(--text-3)">尚未识别到内容</div>`;
      return;
    }
    box.innerHTML = `
      <div style="font-size:12px;color:var(--text-2);margin-bottom:8px;font-weight:600">
        识别到 ${parsed.length} 条：
      </div>
      <div class="card" style="max-height:220px;overflow-y:auto">
        ${parsed.slice(0, 30).map(p => `
          <div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:13px">
            <b>${esc(p.text)}</b>
            ${p.reading ? `<span style="color:var(--text-3);font-family:var(--mono);margin-left:6px">${esc(p.reading)}</span>` : ''}
            ${p.meaning ? `<span style="margin-left:8px">${esc(p.meaning)}</span>` : '<span style="color:var(--danger);margin-left:8px">缺释义</span>'}
            ${p.example ? `<div style="color:var(--text-3);font-size:12px;margin-top:2px">${esc(p.example)}</div>` : ''}
          </div>`).join('')}
        ${parsed.length > 30 ? `<div style="padding:8px 12px;font-size:12px;color:var(--text-3)">…另外 ${parsed.length - 30} 条</div>` : ''}
      </div>`;
  }

  function bulkAdd() {
    const text = ($('#bulkText') || {}).value || ui.draft.bulk || '';
    const parsed = parseBulk(text, ui.draft.lang || 'en', ui.draft.type || 'word');
    if (!parsed.length) { toast('没有可添加的内容', 'warn'); return; }
    Store.addEntries(parsed);
    ui.draft.bulk = '';
    saveDraft();
    render();
    toast(`已添加 ${parsed.length} 条`, 'ok');
  }

  function grade(g) {
    const e = ui.review.queue[ui.review.index];
    if (!e) return;
    Store.reviewEntry(e.id, g);
    ui.review.done++;
    ui.review.index++;
    ui.review.revealed = false;
    if (ui.review.index >= ui.review.queue.length) ui.review.queue = [];
    render();
  }

  function speak(id) {
    const e = Store.getEntry(id);
    if (!e) return;
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读', 'warn'); return; }
    const u = new SpeechSynthesisUtterance(e.example || e.text);
    u.lang = { en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' }[e.lang];
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function confirmDelete(id) {
    const e = Store.getEntry(id);
    if (!e) return;
    modal({
      title: '删除确认',
      body: `<p style="margin:0 0 6px">确定删除这条记录吗？</p>
             <div style="padding:12px;background:var(--surface-2);border-radius:8px;margin-top:10px">
               <b style="font-size:15px">${esc(e.text)}</b>
               <div style="color:var(--text-2);font-size:13px;margin-top:2px">${esc(e.meaning)}</div>
             </div>
             <p style="font-size:12px;color:var(--text-3);margin-top:12px">删除后不可恢复（可从备份文件还原）</p>`,
      foot: `<button class="btn" id="dcCancel">取消</button>
             <button class="btn btn-primary" style="background:var(--danger);border-color:var(--danger)" id="dcOk">删除</button>`,
      onMount(close) {
        $('#dcCancel').onclick = close;
        $('#dcOk').onclick = () => {
          Store.removeEntry(id);
          close();
          if (ui.view === 'review') buildReviewQueue();
          render();
          toast('已删除');
        };
      }
    });
  }

  function openEdit(id) {
    const e = Store.getEntry(id);
    if (!e) return;
    const cfg = FIELD_CONFIG[e.lang];

    modal({
      title: '编辑条目',
      body: `
        <div class="form-grid">
          <div class="field span-2">
            <label class="label">${cfg.textLabel}</label>
            <input class="input" id="ed-text" value="${esc(e.text)}" style="font-weight:600">
          </div>
          <div class="field">
            <label class="label">${cfg.readingLabel}</label>
            <input class="input" id="ed-reading" value="${esc(e.reading)}" style="font-family:var(--mono)">
          </div>
          ${cfg.extra ? `
          <div class="field">
            <label class="label">${cfg.extra.label}</label>
            <input class="input" id="ed-extra" value="${esc(e[cfg.extra.key] || '')}">
          </div>` : `
          <div class="field">
            <label class="label">词性</label>
            <input class="input" id="ed-pos" value="${esc(e.pos || '')}">
          </div>`}
          <div class="field span-2">
            <label class="label">释义</label>
            <input class="input" id="ed-meaning" value="${esc(e.meaning)}">
          </div>
          <div class="field span-2">
            <label class="label">例句</label>
            <textarea class="textarea" id="ed-example">${esc(e.example)}</textarea>
          </div>
          <div class="field span-2">
            <label class="label">例句翻译</label>
            <textarea class="textarea" id="ed-exampleTrans" style="min-height:56px">${esc(e.exampleTrans)}</textarea>
          </div>
          <div class="field">
            <label class="label">来源</label>
            <input class="input" id="ed-source" value="${esc(e.source)}">
          </div>
          <div class="field">
            <label class="label">标签</label>
            <input class="input" id="ed-tags" value="${esc(e.tags.join(' '))}">
          </div>
          <div class="field span-2">
            <label class="label">备注</label>
            <textarea class="textarea" id="ed-note" style="min-height:56px">${esc(e.note || '')}</textarea>
          </div>
          <div class="field span-2">
            <label class="label">掌握程度</label>
            <div class="level-picker" id="ed-levels">
              ${LEVELS.map(l => `<button class="level-opt ${e.level === l.v ? 'active' : ''}" data-level="${l.v}">${l.name}</button>`).join('')}
            </div>
          </div>
        </div>`,
      foot: `<button class="btn" id="edCancel">取消</button>
             <button class="btn btn-primary" id="edSave">保存修改</button>`,
      onMount(close) {
        let level = e.level;
        $$('#ed-levels .level-opt').forEach(b => {
          b.onclick = () => {
            level = Number(b.dataset.level);
            $$('#ed-levels .level-opt').forEach(x => x.classList.toggle('active', x === b));
          };
        });
        $('#edCancel').onclick = close;
        $('#edSave').onclick = () => {
          const patch = {
            text: $('#ed-text').value,
            reading: $('#ed-reading').value,
            meaning: $('#ed-meaning').value,
            example: $('#ed-example').value,
            exampleTrans: $('#ed-exampleTrans').value,
            source: $('#ed-source').value,
            note: $('#ed-note').value,
            tags: parseTags($('#ed-tags').value),
            level
          };
          if (cfg.extra) patch[cfg.extra.key] = $('#ed-extra').value;
          else if ($('#ed-pos')) patch.pos = $('#ed-pos').value;
          Store.updateEntry(id, patch);
          close();
          render();
          toast('已保存', 'ok');
        };
      }
    });
  }

  // ============================================================
  // 导入导出
  // ============================================================

  function doExport() {
    modal({
      title: '导出备份',
      body: `<p style="margin:0 0 14px;color:var(--text-2)">
               导出后可在另一台设备通过「导入数据」恢复，也可作为定期备份。
             </p>
             <div style="display:flex;flex-direction:column;gap:9px">
               <button class="btn" id="exJson" style="justify-content:flex-start;padding:12px 14px">
                 <b>JSON 完整备份</b>
                 <span style="color:var(--text-3);font-size:12px;margin-left:6px">含全部字段、复习进度、打卡记录</span>
               </button>
               <button class="btn" id="exCsv" style="justify-content:flex-start;padding:12px 14px">
                 <b>CSV 表格</b>
                 <span style="color:var(--text-3);font-size:12px;margin-left:6px">可用 Excel 打开，仅词条内容</span>
               </button>
             </div>`,
      onMount(close) {
        $('#exJson').onclick = () => {
          download(`语言工作台备份-${todayKey()}.json`, Store.exportJSON(), 'application/json');
          close(); toast('已导出 JSON 备份', 'ok');
        };
        $('#exCsv').onclick = () => {
          const list = Store.filter({ lang: ui.lang });
          download(`语言工作台-${todayKey()}.csv`, '\ufeff' + Store.exportCSV(list), 'text/csv');
          close(); toast('已导出 CSV', 'ok');
        };
      }
    });
  }

  function doImport(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        Store.validateImport(reader.result);
      } catch (err) {
        toast('导入失败：' + err.message, 'warn');
        return;
      }
      modal({
        title: '导入数据',
        body: `<p style="margin:0 0 14px;color:var(--text-2)">文件：<b>${esc(file.name)}</b></p>
               <div style="display:flex;flex-direction:column;gap:9px">
                 <button class="btn" id="imMerge" style="justify-content:flex-start;padding:12px 14px">
                   <b>合并</b><span style="color:var(--text-3);font-size:12px;margin-left:6px">保留现有数据，追加新条目（推荐）</span>
                 </button>
                 <button class="btn btn-danger" id="imReplace" style="justify-content:flex-start;padding:12px 14px">
                   <b>覆盖</b><span style="font-size:12px;margin-left:6px">清空当前数据后导入</span>
                 </button>
               </div>`,
        onMount(close) {
          const run = mode => {
            try {
              const n = Store.importJSON(reader.result, mode);
              close();
              ui.openDays.clear();
              if (ui.view === 'review') buildReviewQueue();
              render();
              toast(`导入成功，当前共 ${n} 条`, 'ok');
            } catch (err) {
              toast('导入失败：' + err.message, 'warn');
            }
          };
          $('#imMerge').onclick = () => run('merge');
          $('#imReplace').onclick = () => run('replace');
        }
      });
    };
    reader.readAsText(file);
    ev.target.value = '';
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ============================================================
  // 主题 & 同步状态
  // ============================================================

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const dark = theme === 'dark';
    $('#themeLabel').textContent = dark ? '浅色模式' : '深色模式';
    $('#btnTheme').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
    $('#btnThemeMobile').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#14161a' : '#f6f7f9');
  }

  function bindSyncStatus() {
    const dot = $('#syncDot');
    const text = $('#syncText');
    Store.onStatus(s => {
      dot.className = 'sync-dot' + (s === 'saving' ? ' saving' : s === 'offline' ? ' offline' : s === 'ratelimit' ? ' offline' : '');
      text.textContent = s === 'saving' ? '保存中…'
        : s === 'offline' ? '同步重试中…'
        : s === 'ratelimit' ? 'GitHub 限流中，稍后自动同步'
        : '已自动保存';
    });
  }

  // ============================================================
  // 启动
  // ============================================================

  async function boot() {
    try {
      await Store.init();
      if (Store.hasRecoveredData()) {
        toast('已从本机备份自动找回学习记录（之前被同步意外清空）', 'ok');
      }
      loadDraft();

      applyTheme(Store.state.settings.theme || 'light');
      ui.lang = Store.state.settings.activeLang || 'all';

      bindGlobal();
      bindSyncStatus();
      // 若已开启 GitHub 同步，启动后自动接入（失败则降级本地，不打断使用）
      if (Store.state.settings.gistSync && Store.state.settings.gistToken) {
        const ok = await Store.enableGist(Store.state.settings.gistToken, Store.state.settings.gistKey);
        if (!ok) toast('GitHub 同步连接失败：' + (Store._gistError || '未知') + '（已用本地数据）', 'warn');
      }
      Store.onRemote = () => render();
      render();

      // 注册 Service Worker（离线可用 + 可安装）
      if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      }
    } catch (err) {
      console.error('boot failed', err);
      const content = $('#content');
      if (content) {
        content.innerHTML = `
          <div class="card" style="margin-top:20px">
            <div class="empty">
              <div class="empty-icon">⚠️</div>
              <div class="empty-title">页面加载出错</div>
              <div class="empty-text" style="text-align:left;max-width:560px;margin:0 auto">
                错误信息：${esc(err && err.message ? err.message : String(err))}<br>
                请尝试：<b>硬刷新</b>（QQ浏览器点刷新按钮往上滑选「强制刷新」或清除缓存后重开），或在「设置 - 数据管理」里清除数据后刷新。
              </div>
            </div>
          </div>`;
      }
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
