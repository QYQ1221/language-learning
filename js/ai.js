/*
 * LangAI —— 浏览器直连 AI 客户端（OpenAI 兼容接口）
 * 支持 OpenAI / DeepSeek / 通义 / Moonshot 等任意兼容 /chat/completions 的服务。
 * 配置存于 Store.state.settings.ai = { enabled, baseUrl, apiKey, model }。
 * Key 仅存于用户浏览器 localStorage，不进代码、不上传服务器。
 */
(function (global) {
  'use strict';

  function getCfg() {
    try {
      const s = (global.LangStore && global.LangStore.Store && global.LangStore.Store.state.settings) || {};
      return s.ai || {};
    } catch (e) { return {}; }
  }

  function enabled() {
    const c = getCfg();
    return !!(c.enabled && c.baseUrl && c.apiKey);
  }

  function cfg() { return getCfg(); }

  // 从模型文本中解析 JSON（兼容 ```json 代码块、前后废话、中文引号、尾随逗号、字符串内裸换行等）
  // 返回对象；若失败则返回 {_error: '...', _raw: text, _preview: '...'} 供上层给出详细诊断
  function parseJSON(text) {
    if (!text) return { _error: '空响应', _raw: '', _preview: '' };
    const raw = String(text);
    let t = raw;
    // 1) 清掉常见不可见字符
    t = t.replace(/^[\uFEFF\u200B-\u200D\u00A0]+/, '').replace(/[\uFEFF\u200B-\u200D\u00A0]+$/g, '').replace(/[\uFEFF\u200B-\u200D\u00A0]/g, '').trim();
    // 2) 中文全角引号 → 半角
    t = t.replace(/[\u201C\u201D\u201F\u275D\u275E\uFF02]/g, '"').replace(/[\u2018\u2019\u201B\u275B\u275C\uFF07]/g, "'");
    // 3) markdown 代码块优先
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();

    // 4) 直接解析
    try { return JSON.parse(t); } catch (e) {}

    // 5) 用嵌套深度找到第一个完整的 JSON 对象/数组
    const s = t.search(/[[{]/);
    if (s < 0) return { _error: '未找到 JSON 起始符号', _raw: raw, _preview: raw.replace(/\s+/g, ' ').slice(0, 200) };
    const open = t[s];
    const close = open === '[' ? ']' : '}';
    let depth = 0, inString = false, escape = false;
    let slice = '';
    for (let i = s; i < t.length; i++) {
      const c = t[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') inString = false;
      } else {
        if (c === '"') { inString = true; continue; }
        if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) { slice = t.slice(s, i + 1); break; }
        }
      }
    }

    // 6) 修复常见模型错误后重试
    const attempts = [
      () => slice && JSON.parse(slice),
      () => slice && JSON.parse(slice.replace(/,(\s*[}\]])/g, '$1')),          // 尾随逗号
      () => slice && JSON.parse(repairNewlines(slice)),                         // 字符串内裸换行
      () => slice && JSON.parse(slice.replace(/,(\s*[}\]])/g, '$1').replace(/\n/g, '\\n').replace(/\r/g, '')),
      () => { const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i); return m && JSON.parse(repairNewlines(m[1])); },
      () => { const m = raw.match(/[{\[][\s\S]*?[}\]]/); return m && JSON.parse(repairNewlines(m[0])); }
    ];
    for (const fn of attempts) {
      try { const r = fn(); if (r != null) return r; } catch (e) {}
    }

    // 7) 仍然失败：返回诊断对象
    const errInfo = { _error: 'JSON 解析失败', _raw: raw, _slice: slice, _preview: raw.replace(/\s+/g, ' ').slice(0, 280) };
    try { errInfo._parseErr = JSON.parse(slice).toString(); } catch (e) { errInfo._parseErr = e.message; }
    return errInfo;
  }

  // 修复 JSON 字符串值中的裸换行 / 回车（模型常犯的错）
  function repairNewlines(json) {
    let out = '', inString = false, escape = false;
    for (let i = 0; i < json.length; i++) {
      const c = json[i];
      if (inString) {
        if (escape) { escape = false; out += c; continue; }
        if (c === '\\') { escape = true; out += c; continue; }
        if (c === '"') { inString = false; out += c; continue; }
        if (c === '\n' || c === '\r') { out += '\\n'; continue; }
        out += c;
      } else {
        if (c === '"') { inString = true; }
        out += c;
      }
    }
    return out;
  }

  async function chat(system, user, opts) {
    opts = opts || {};
    const c = getCfg();
    const url = (c.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: c.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: opts.temperature != null ? opts.temperature : 0.7
    };
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts.max_tokens != null) body.max_tokens = opts.max_tokens;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + c.apiKey
        },
        body: JSON.stringify(body)
      });
    } catch (netErr) {
      const detail = (netErr && netErr.message) ? netErr.message : String(netErr);
      let hint = '';
      // 浏览器直连 AI 时，fetch 被 reject 多半是 CORS 跨域拦截 / 混合内容拦截 / 地址不可达
      if (!detail || detail === 'Failed to fetch' || detail.indexOf('NetworkError') >= 0 || detail.toLowerCase().indexOf('cors') >= 0) {
        hint = '（多为浏览器跨域 CORS 被拦截，或 HTTPS 页面调了 HTTP 接口被混合内容拦截。请确认：① 接口地址是 https 且服务端允许跨域 ' +
          'Access-Control-Allow-Origin；② 若用中转/自建代理，需放行浏览器来源；③ 官方接口如 DeepSeek/OpenAI 通常支持直连）';
      }
      throw new Error('网络请求失败' + (detail ? ('：' + detail) : '') + hint);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('AI 接口返回 ' + res.status + (txt ? '：' + txt.slice(0, 140) : ''));
    }
    const data = await res.json().catch(() => null);
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (opts.json === false) return content;
    const parsed = parseJSON(content);
    if (parsed && parsed._error) {
      // 解析失败：抛出含原始片段的错误，便于定位
      const info = parsed;
      const preview = (info._preview || '').slice(0, 280);
      const tail = (info._raw || '').replace(/\s+/g, ' ').slice(-120);
      LangAI.lastError = { time: Date.now(), type: 'parse', raw: info._raw, slice: info._slice, error: info._parseErr || info._error };
      throw new Error('AI 返回内容无法解析为 JSON（请确认接口/模型正确，并要求模型只输出半角双引号合法 JSON）\n' +
        '【解析错误】' + (info._parseErr || info._error) + '\n' +
        '【长度】' + (info._raw || '').length + '\n' +
        '【开头】' + preview + '\n' +
        '【结尾】' + tail + '\n' +
        '【完整内容】请打开浏览器控制台(F12 → Console)查看 LangAI.lastError');
    }
    LangAI.lastError = null;
    return parsed;
  }

  // 根据学习主题拓展词库，返回词项数组
  // item: { lang, text, reading, pos, meaning, example, exampleTrans, tags }
  async function expandPack(opts) {
    const themes = (opts.themes || []).join('、');
    const langs = opts.langs || ['en', 'ja', 'ko'];
    const perLang = opts.perLang || 5;
    const existing = opts.existing || [];
    const system = '你是三语（英语/日语/韩语）词汇教学助手。请根据用户选定的学习主题，生成贴合该主题的额外生词，补充进今日学习词包。要求：单词真实常用、与主题强相关、难度适中；日语给出假名读音并另给罗马音，韩语给出罗马音，英语给出 IPA 音标；例句简洁自然并附中文翻译；不要重复已给词。';
    const user = '学习主题：' + (themes || '日常通用') +
      '\n已生成词（请勿重复）：' + (existing.join('、') || '无') +
      '\n请为以下每种语言各生成 ' + perLang + ' 个生词：' + langs.join(', ') + '。' +
      '\n只返回一个 JSON 数组，每个元素结构：{"lang":"en|ja|ko","text":"原文","reading":"读音","romaji":"罗马音（仅日语填写，其他语言留空字符串）","pos":"词性（如 n./v./adj.）","meaning":"中文释义","example":"目标语言例句","exampleTrans":"例句中文翻译","tags":["主题标签"]}。必须只输出这一个合法 JSON 数组，所有字符串用半角双引号(")，不要中文引号“”，不要任何解释文字，不要 markdown 代码块。';
    const data = await chat(system, user, { temperature: 0.85 });
    if (!Array.isArray(data)) return [];
    const LANGSET = { en: 1, ja: 1, ko: 1 };
    return data
      .filter(x => x && x.lang && LANGSET[x.lang] && x.text && x.meaning)
      .map(x => ({
        lang: x.lang,
        text: String(x.text).trim(),
        reading: (x.reading || '').trim(),
        romaji: (x.romaji || x.romaja || x['罗马音'] || '').trim(),
        pos: (x.pos || '').trim(),
        meaning: String(x.meaning).trim(),
        example: (x.example || '').trim(),
        exampleTrans: (x.exampleTrans || '').trim(),
        tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
        type: 'word',
        source: 'AI 补充 · ' + themes,
        _ai: true
      }));
  }

  // 手动加词：根据输入词补全字段
  async function fillWord(opts) {
    const lang = opts.lang || 'en';
    const text = (opts.text || '').trim();
    if (!text) return null;
    const langName = { en: '英语', ja: '日语', ko: '韩语' }[lang] || '英语';
    const system = '你是为语言学习者补全单词卡片字段的助手。根据用户给出的单词与目标语言，补全中文学习卡片所需字段。' +
      '只返回一个合法 JSON 对象，所有字符串用半角双引号 "，不要用中文引号“”；不要任何解释文字、不要 markdown 代码块。' +
      'reading 填真实读音，meaning 填真实中文释义，example 用目标语言写真实例句。';
    const user = '目标语言：' + langName + '\n单词：' + text +
      '\n请返回完整 JSON（仅一个对象）：{"reading":"真实读音","romaji":"罗马音（仅日语填写，其他语言留空字符串）","pos":"词性","meaning":"准确中文释义","example":"一句真实例句","exampleTrans":"例句中文翻译","tags":["标签1","标签2"]}。' +
      '\n要求：meaning 必填；reading 不要写"读音（英语 IPA / 日语假名 / 韩语罗马音）"这种说明文字，必须写该单词的真实读音；日语请同时在 romaji 填写罗马音；example 不要写"一句地道的目标语言例句"这种说明文字，必须写真实例句。只输出这个 JSON 对象。';
    const data = await chat(system, user, { temperature: 0.35, max_tokens: 1024 });
    if (!data || typeof data !== 'object') { LangAI.lastError = { raw: String(data), type: 'shape' }; return null; }
    // 兼容字段名：部分模型会用别名或中文键（释义/例句/读音/标签等）
    // 兜底：若模型误把当前单词当成“三语卡片”返回 {en/ja/ko:...}，尝试从当前语种 key 提取
    if (!data.meaning && !data.reading && (data.en || data.ja || data.ko || data['英语'] || data['日语'] || data['韩语'])) {
      const tri = data.en || data.ja || data.ko || data['英语'] || data['日语'] || data['韩语'];
      if (tri && typeof tri === 'object') {
        data.reading = tri.reading || data.reading;
        data.pos = tri.pos || data.pos;
        data.meaning = tri.meaning || data.meaning;
        data.example = tri.example || data.example;
        data.exampleTrans = tri.exampleTrans || data.exampleTrans;
        data.tags = tri.tags || data.tags;
      }
    }
    const pick = (obj, keys) => {
      for (const k of keys) { const v = obj[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
      return '';
    };
    const tagsRaw = data.tags != null ? data.tags : (data['标签'] != null ? data['标签'] : '');
    let meaning = pick(data, ['meaning', 'definition', '释义', '中文释义', '定义', '解释']);
    // 若模型未返回释义，专门追问一次中文释义并补上（避免“填充了但释义为空”）
    if (!meaning) {
      try {
        const m = await chat(
          '你是双语词典助手。只输出目标单词的准确中文释义，一个词或短语即可，不要解释、不要任何标点之外的符号、不要 JSON。',
          '目标语言：' + langName + '\n单词：' + text + '\n请给出它的准确中文释义。',
          { temperature: 0.2, json: false }
        );
        meaning = (m || '').trim();
      } catch (e) { /* 忽略追问失败，继续用已得字段 */ }
    }
    const out = {
      reading: pick(data, ['reading', 'pronunciation', 'phonetic', '音标', '读音', '拼音']),
      romaji: pick(data, ['romaji', '罗马音', 'romaja']),
      pos: pick(data, ['pos', 'partOfSpeech', '词性', 'part']),
      meaning,
      example: pick(data, ['example', '例句', 'sentence']),
      exampleTrans: pick(data, ['exampleTrans', 'translation', '例句翻译', '翻译', '中文翻译']),
      tags: Array.isArray(tagsRaw) ? tagsRaw.map(String).join(' ') : (typeof tagsRaw === 'string' ? tagsRaw : '')
    };
    const hasAny = out.reading || out.pos || out.meaning || out.example || out.exampleTrans || out.tags;
    if (!hasAny) { LangAI.lastError = { raw: JSON.stringify(data), type: 'empty' }; return null; }
    out._partial = !out.meaning; // 标记是否缺释义等关键字段
    return out;
  }

  // 为一个中文概念生成单一语种的单词卡片
  async function fillOneLang(concept, lang) {
    const langName = { en: '英语', ja: '日语', ko: '韩语' }[lang] || '英语';
    const extraHint = lang === 'ja' ? 'extra 填声调（如 0〜4 型，可空）' : lang === 'ko' ? 'extra 填汉字词（可空）' : 'extra 可空';
    const system = '你是' + langName + '词汇教学助手。根据用户给出的中文概念，给出最贴切的' + langName + '单词及中文学习者所需字段。释义 meaning 用英文撰写，例句翻译 exampleTrans 用中文。只返回一个合法 JSON 对象，不要使用中文引号“”，不要解释文字，不要 markdown 代码块。';
    const user = '中文概念：' + concept +
      '\n请返回' + langName + '单词卡片，结构：{"text":"原文（' + langName + '原生文字）","reading":"读音（英语 IPA / 日语假名 / 韩语罗马音）","romaji":"罗马音（仅日语填写，其他语言留空字符串）","pos":"词性","meaning":"用英文撰写的释义","example":"一句地道的' + langName + '例句","exampleTrans":"例句中文翻译","tags":["1-3 个主题标签"],"extra":"' + extraHint + '"}。';
    const data = await chat(system, user, { temperature: 0.35, max_tokens: 1024 });
    if (!data || typeof data !== 'object') return null;
    // 兼容：模型可能误返回 {en/ja/ko:{...}} 三语格式
    let x = data;
    if (!x.text && (x.en || x.ja || x.ko || x['英语'] || x['日语'] || x['韩语'])) {
      x = x[lang] || x.en || x.ja || x.ko || x['英语'] || x['日语'] || x['韩语'];
    }
    if (!x || typeof x !== 'object' || !x.text) return null;
    const pick = (obj, keys) => {
      for (const k of keys) { const v = obj[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
      return '';
    };
    const tagsRaw = x.tags != null ? x.tags : (x['标签'] != null ? x['标签'] : '');
    let meaning = pick(x, ['meaning', 'definition', '释义', '英文释义', '定义']);
    if (!meaning) {
      try {
        const m = await chat(
          '你是双语词典助手。只输出目标单词的英文定义（English definition），一个短语即可，不要解释、不要 JSON、不要中文。',
          '语言：' + langName + '\n单词：' + String(x.text).trim() + '\n请给出它的英文释义。',
          { temperature: 0.2, json: false }
        );
        meaning = (m || '').trim();
      } catch (e) { /* 忽略 */ }
    }
    return {
      text: String(x.text).trim(),
      reading: pick(x, ['reading', 'pronunciation', 'phonetic', '音标', '读音', '拼音']),
      romaji: pick(x, ['romaji', '罗马音', 'romaja']),
      pos: pick(x, ['pos', 'partOfSpeech', '词性', 'part']),
      meaning,
      example: pick(x, ['example', '例句', 'sentence']),
      exampleTrans: pick(x, ['exampleTrans', 'translation', '例句翻译', '翻译', '中文翻译']),
      tags: Array.isArray(tagsRaw) ? tagsRaw.map(String).join(' ') : (typeof tagsRaw === 'string' ? tagsRaw : ''),
      extra: pick(x, ['extra', '补充', '声调', '汉字词']),
      _partial: !meaning
    };
  }

  // 手动加词（三语卡片）：给一个中文概念，分别生成英/日/韩三语单词及全部内容
  // 返回 { en:{text,reading,pos,meaning,example,exampleTrans,tags,extra}, ja:{...}, ko:{...} }
  async function generateTri(cn, opts) {
    const concept = (cn || '').trim();
    if (!concept) return null;
    const out = {};
    // 分别请求三种语言，避免一次性长输出被截断或漏语种
    for (const l of ['en', 'ja', 'ko']) {
      try {
        const r = await fillOneLang(concept, l);
        if (r) out[l] = r;
      } catch (e) { /* 单个语种失败继续 */ }
    }
    if (!out.en && !out.ja && !out.ko) { LangAI.lastError = { raw: '三语分别请求均未返回有效内容', type: 'empty' }; return null; }
    return out;
  }

  // 设置页一键测试：发一个极简请求，返回原始状态/响应片段供诊断
  async function test() {
    const c = getCfg();
    if (!c.enabled || !c.baseUrl || !c.apiKey) throw new Error('AI 未开启或缺少接口地址/API Key');
    const url = (c.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: c.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Reply with exactly: pong' }
      ],
      max_tokens: 10
    };
    let resText = '', status = 0, ok = false, err = '';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
        body: JSON.stringify(body)
      });
      status = res.status;
      ok = res.ok;
      resText = await res.text().catch(() => '');
    } catch (netErr) {
      err = (netErr && netErr.message) ? netErr.message : String(netErr);
    }
    return { url, model: body.model, status, ok, err, raw: resText };
  }

  const LangAI = { enabled, cfg, chat, expandPack, fillWord, generateTri, parseJSON, test, lastError: null };
  global.LangAI = LangAI;
})(typeof window !== 'undefined' ? window : this);
