/* ============================================================
   themes.js — 主题体系 + 每日词包生成引擎
   核心思路：用户每天选「心情」或「兴趣」，系统据此生成三语专属词包。
   同一天重复打开不会换词（按日期+主题锁定），学完可手动换一批。
   ============================================================ */

(function (global) {
  'use strict';

  // ---------- 主题定义 ----------
  // group: mood(心情) / interest(兴趣)

  const THEMES = [
    // ===== 心情维度 =====
    { key: 'energetic', group: 'mood', emoji: '⚡', name: '元气满满', desc: '干劲十足，想冲一把' },
    { key: 'happy',     group: 'mood', emoji: '😊', name: '心情不错', desc: '愉悦、轻松、想笑' },
    { key: 'calm',      group: 'mood', emoji: '🌿', name: '平静放空', desc: '慢下来，安安静静' },
    { key: 'tired',     group: 'mood', emoji: '😮‍💨', name: '有点累', desc: '疲惫、想休息' },
    { key: 'anxious',   group: 'mood', emoji: '🌀', name: '焦虑压力', desc: '心里堵得慌' },
    { key: 'lonely',    group: 'mood', emoji: '🌙', name: '有点emo', desc: '孤独、想念、感伤' },

    // ===== 兴趣维度 =====
    { key: 'travel',   group: 'interest', emoji: '✈️', name: '旅行出行', desc: '机场、酒店、问路' },
    { key: 'food',     group: 'interest', emoji: '🍜', name: '美食料理', desc: '点餐、味道、下厨' },
    { key: 'drama',    group: 'interest', emoji: '🎬', name: '影视追剧', desc: '剧情、演员、追番' },
    { key: 'music',    group: 'interest', emoji: '🎧', name: '音乐现场', desc: '歌曲、演唱会、乐队' },
    { key: 'work',     group: 'interest', emoji: '💼', name: '职场工作', desc: '会议、汇报、同事' },
    { key: 'love',     group: 'interest', emoji: '💗', name: '恋爱人际', desc: '约会、告白、相处' },
    { key: 'health',   group: 'interest', emoji: '🏃', name: '运动健康', desc: '锻炼、身体、作息' },
    { key: 'shopping', group: 'interest', emoji: '🛍️', name: '购物消费', desc: '买单、打折、退换' },
    { key: 'tech',     group: 'interest', emoji: '📱', name: '科技数码', desc: '手机、软件、AI' },
    { key: 'nature',   group: 'interest', emoji: '🌤️', name: '自然季节', desc: '天气、四季、风景' },
    { key: 'study',    group: 'interest', emoji: '📖', name: '学习成长', desc: '读书、考试、进步' },
    { key: 'daily',    group: 'interest', emoji: '🏠', name: '日常生活', desc: '起居、家务、琐事' }
  ];

  const THEME_MAP = {};
  THEMES.forEach(t => { THEME_MAP[t.key] = t; });

  // 难度：1 入门 / 2 中级 / 3 进阶
  const DIFFICULTY = [
    { v: 1, name: '入门', desc: '英语四级 · 日语 N5-N4 · 韩语 TOPIK 1-2' },
    { v: 2, name: '中级', desc: '英语六级 · 日语 N3-N2 · 韩语 TOPIK 3-4' },
    { v: 3, name: '进阶', desc: '雅思托福 · 日语 N2-N1 · 韩语 TOPIK 5-6' }
  ];

  // ---------- 确定性随机（同一天同一主题必得同一批词） ----------

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(arr, seed) {
    const rand = mulberry32(seed);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- 词库访问 ----------

  function bankOf(lang) {
    const banks = {
      en: global.WORDBANK_EN,
      ja: global.WORDBANK_JA,
      ko: global.WORDBANK_KO
    };
    return banks[lang] || [];
  }

  /** 词库条目 → 标准 entry 数据 */
  function expand(w, lang) {
    return {
      lang,
      type: w.ty || 'word',
      text: w.t,
      reading: w.r || '',
      pitch: lang === 'ja' ? (w.pt || '') : '',
      hanja: lang === 'ko' ? (w.h || '') : '',
      pos: w.p || '',
      meaning: w.m || '',
      example: w.e || '',
      exampleTrans: w.et || '',
      source: '',
      tags: (w.th || []).slice(0, 2),
      level: 0,
      _bankId: lang + ':' + w.t   // 用于去重
    };
  }

  /**
   * 生成某语言的每日词包
   * @param {string} lang
   * @param {string[]} themeKeys  一个或多个主题（心情 ∪ 兴趣的并集）
   * @param {number} count        需要的词数
   * @param {number} difficulty   难度上限
   * @param {Set} learned         已学过的 _bankId 集合
   * @param {string} dateKey      日期，用于确定性随机
   * @param {number} salt         换一批时递增
   */
  function dailyPack(lang, themeKeys, count, difficulty, learned, dateKey, salt) {
    const bank = bankOf(lang);
    if (!bank.length) return [];

    themeKeys = (themeKeys && themeKeys.length) ? themeKeys : ['daily'];
    const seed = hashSeed(`${dateKey}|${themeKeys.join('+')}|${lang}|${salt || 0}`);

    const diffCap = (difficulty && typeof difficulty === 'object' && difficulty[lang] != null)
      ? difficulty[lang]
      : (typeof difficulty === 'number' ? difficulty : 3);
    const inThemes = w => (w.th || []).some(t => themeKeys.includes(t));
    const isWord = w => !w.ty || w.ty === 'word';   // 学习内容以单词为主
    const matchDiff = w => (w.lv || 1) <= diffCap;
    const notLearned = w => !learned.has(lang + ':' + w.t);

    // 第一优先：主题匹配 + 单词 + 难度匹配 + 未学过
    let pool = bank.filter(w => inThemes(w) && isWord(w) && matchDiff(w) && notLearned(w));
    let picked = seededShuffle(pool, seed).slice(0, count);

    // 第二优先：主题匹配 + 单词 + 未学过（放宽难度）
    if (picked.length < count) {
      const ids = new Set(picked.map(w => w.t));
      const more = bank.filter(w => inThemes(w) && isWord(w) && notLearned(w) && !ids.has(w.t));
      picked = picked.concat(seededShuffle(more, seed + 1).slice(0, count - picked.length));
    }

    // 第三优先：同难度未学过的任意单词（主题词用尽时补足）
    if (picked.length < count) {
      const ids = new Set(picked.map(w => w.t));
      const more = bank.filter(w => isWord(w) && matchDiff(w) && notLearned(w) && !ids.has(w.t));
      picked = picked.concat(seededShuffle(more, seed + 2).slice(0, count - picked.length));
    }

    // 兜底：全部学完，允许重复出现（复习性质）
    if (picked.length < count) {
      const ids = new Set(picked.map(w => w.t));
      const more = bank.filter(w => isWord(w) && !ids.has(w.t));
      picked = picked.concat(seededShuffle(more, seed + 3).slice(0, count - picked.length));
    }

    return picked.map(w => expand(w, lang));
  }

  /** 生成三语完整词包（themeKeys 为心情+兴趣的并集） */
  function generatePack(opts) {
    const { themeKey, themeKeys, perLang, difficulty, learned, dateKey, salt, langs } = opts;
    const use = langs && langs.length ? langs : ['en', 'ja', 'ko'];
    const keys = (themeKeys && themeKeys.length) ? themeKeys
      : (themeKey ? [themeKey] : ['daily']);
    const out = {};
    use.forEach(lang => {
      out[lang] = dailyPack(lang, keys, perLang, difficulty, learned, dateKey, salt);
    });
    return out;
  }

  /** 词库统计，用于设置页展示 */
  function bankStats() {
    const s = {};
    ['en', 'ja', 'ko'].forEach(l => {
      const b = bankOf(l);
      s[l] = {
        total: b.length,
        byLevel: [0, b.filter(w => (w.lv || 1) === 1).length,
                     b.filter(w => w.lv === 2).length,
                     b.filter(w => w.lv === 3).length]
      };
    });
    s.themes = THEMES.length;
    s.total = s.en.total + s.ja.total + s.ko.total;
    return s;
  }

  /** 某主题下各语言可用词量 */
  function themeCoverage(themeKey, difficulty) {
    const r = {};
    ['en', 'ja', 'ko'].forEach(l => {
      r[l] = bankOf(l).filter(w =>
        (w.th || []).includes(themeKey) && (w.lv || 1) <= (difficulty || 3)
      ).length;
    });
    return r;
  }

  /** 根据日期推荐一个主题（避免每天都要纠结选哪个） */
  function suggestTheme(dateKey) {
    const interests = THEMES.filter(t => t.group === 'interest');
    const idx = hashSeed(dateKey) % interests.length;
    return interests[idx].key;
  }

  global.LangThemes = {
    THEMES, THEME_MAP, DIFFICULTY,
    generatePack, dailyPack, bankStats, themeCoverage, suggestTheme,
    hashSeed, seededShuffle, expand
  };
})(window);
