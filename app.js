/*
 * ぺぇのつくったもの — 公開ページと更新ツールで共有する処理
 * データ定義・検証・描画をここにまとめ、editor/ からも読み込む。
 */
(function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var WORK_TYPES = ['web', 'android'];
  var IMAGE_KINDS = ['icon', 'screenshot'];
  var TYPE_LABELS = { web: 'Web', android: 'Android' };
  var SECTION_TITLES = { web: 'Webアプリ', android: 'Androidアプリ' };
  var DEFAULT_BUTTON_LABELS = { web: '使ってみる', android: '配布ページへ' };
  var ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
  // 画像は assets/ 配下の相対パスのみ（../ や絶対URLは不可）
  var IMAGE_PATH_PATTERN = /^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i;

  // 24x24・線画の簡素なアイコン（外部取得なし）
  var ICONS = {
    link: { label: 'リンク', svg: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>' },
    home: { label: 'ホームページ', svg: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>' },
    x: { label: 'X', svg: '<path d="M5 4l14 16M19 4L5 20"/>' },
    bluesky: { label: 'Bluesky', svg: '<path d="M12 11C10 7 7 5 5 5c-1.5 0-2 1-2 2.5 0 2 1 4.5 4 4.5-3 .5-3.5 3-1.5 4.5 2 1.5 4.5 0 6.5-4 2 4 4.5 5.5 6.5 4s1.5-4-1.5-4.5c3 0 4-2.5 4-4.5C21 6 20.5 5 19 5c-2 0-5 2-7 6z"/>' },
    instagram: { label: 'Instagram', svg: '<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.5"/><circle cx="17" cy="7" r="0.8" fill="currentColor" stroke="none"/>' },
    youtube: { label: 'YouTube', svg: '<rect x="3" y="6" width="18" height="12" rx="4"/><path d="M10.5 9.5v5l4-2.5z" fill="currentColor"/>' },
    github: { label: 'GitHub', svg: '<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="7.5" r="2"/><path d="M7 7.5v9"/><path d="M17 9.5c0 4-10 2.5-10 7"/>' },
    nostr: { label: 'Nostr', svg: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>' },
    misskey: { label: 'Misskey', svg: '<path d="M5 18V7l4 6 3-4.5 3 4.5 4-6v11"/>' },
    pixiv: { label: 'pixiv', svg: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M10 17V8h3a2.5 2.5 0 0 1 0 5h-3"/>' },
    note: { label: 'note', svg: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 16V9.5"/><path d="M9 11a3 3 0 0 1 6 0v5"/>' }
  };
  var EXTERNAL_SVG = '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>';
  var PLACEHOLDER_SVG = '<path d="M12 4c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6z"/><circle cx="18.5" cy="17.5" r="1.2"/><circle cx="6" cy="18" r="0.9"/>';

  /* ---------- データ定義 ---------- */

  function isSafeUrl(value) {
    if (typeof value !== 'string' || value.trim() === '') return false;
    try {
      var u = new URL(value);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
    } catch (e) {
      return false;
    }
  }

  function isImagePath(value) {
    return typeof value === 'string' && IMAGE_PATH_PATTERN.test(value);
  }

  function defaultButtonLabel(type) {
    return DEFAULT_BUTTON_LABELS[type] || '開く';
  }

  function generateId(prefix, existing) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var taken = existing || [];
    for (;;) {
      var buf = new Uint8Array(8);
      crypto.getRandomValues(buf);
      var s = '';
      for (var i = 0; i < buf.length; i++) s += chars[buf[i] % chars.length];
      var id = prefix + '-' + s;
      if (taken.indexOf(id) === -1) return id;
    }
  }

  function newWork(existingIds) {
    return {
      id: generateId('work', existingIds),
      name: '',
      description: '',
      type: 'web',
      url: '',
      buttonLabel: '',
      image: '',
      imageKind: 'icon',
      imageAlt: '',
      visible: true
    };
  }

  function newLink(existingIds) {
    return {
      id: generateId('link', existingIds),
      label: '',
      url: '',
      icon: '',
      visible: true
    };
  }

  /* ---------- 検証 ----------
   * mode 'structure': 型・schemaVersion・ID重複・危険なURL・画像パス（インポート・下書き復元時）
   * mode 'publish'  : 上記に加え、必須項目と公開項目のURL（書き出し時）
   * 戻り値: [{ key, field, message }]  key はフォーム項目の特定に使う
   */
  function validateSite(data, mode) {
    var publish = mode === 'publish';
    var errors = [];
    function add(key, field, message) {
      errors.push({ key: key, field: field, message: message });
    }
    function isObj(v) {
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    }
    function checkString(obj, prop, key, field) {
      if (typeof obj[prop] !== 'string') {
        add(key, field, obj[prop] === undefined ? '項目がありません' : '文字列である必要があります');
        return false;
      }
      return true;
    }
    function checkBool(obj, prop, key, field) {
      if (typeof obj[prop] !== 'boolean') {
        add(key, field, obj[prop] === undefined ? '項目がありません' : 'true か false である必要があります');
        return false;
      }
      return true;
    }
    function checkImage(obj, prop, key, field) {
      if (!checkString(obj, prop, key, field)) return;
      if (obj[prop] !== '' && !isImagePath(obj[prop])) {
        add(key, field, 'assets/ から始まる PNG・JPEG・WebP の相対パスである必要があります');
      }
    }
    function checkUrl(obj, key, field, required) {
      if (!checkString(obj, 'url', key, field)) return;
      var v = obj.url.trim();
      if (v === '') {
        if (required) add(key, field, '公開するには https:// または http:// で始まるURLが必要です');
      } else if (!isSafeUrl(v)) {
        add(key, field, 'https:// または http:// で始まる正しいURLを入力してください');
      }
    }

    if (!isObj(data)) {
      add('root', 'データ全体', 'JSONのオブジェクトではありません');
      return errors;
    }
    if (data.schemaVersion !== SCHEMA_VERSION) {
      add('schemaVersion', 'schemaVersion',
        data.schemaVersion === undefined ? '項目がありません' : '未対応のバージョンです（' + String(data.schemaVersion) + '）。対応しているのは ' + SCHEMA_VERSION + ' です');
      return errors;
    }

    // プロフィール
    var p = data.profile;
    if (!isObj(p)) {
      add('profile', 'サイトの基本情報', p === undefined ? '項目がありません' : '形式が正しくありません');
    } else {
      if (checkString(p, 'siteTitle', 'profile.siteTitle', 'サイト名') && publish && p.siteTitle.trim() === '') {
        add('profile.siteTitle', 'サイト名', '入力してください');
      }
      if (checkString(p, 'displayName', 'profile.displayName', '表示名') && publish && p.displayName.trim() === '') {
        add('profile.displayName', '表示名', '入力してください');
      }
      checkString(p, 'bio', 'profile.bio', '紹介文');
      checkImage(p, 'image', 'profile.image', 'プロフィール画像');
    }

    // 作品
    if (!Array.isArray(data.works)) {
      add('works', '作品一覧', data.works === undefined ? '項目がありません' : '配列である必要があります');
    } else {
      var workIds = {};
      data.works.forEach(function (w, i) {
        var label = '作品' + (i + 1) + (isObj(w) && typeof w.name === 'string' && w.name.trim() ? '「' + w.name.trim() + '」' : '');
        if (!isObj(w)) {
          add('works.#' + i, label, '形式が正しくありません');
          return;
        }
        var k = 'works.' + (typeof w.id === 'string' ? w.id : '#' + i) + '.';
        if (typeof w.id !== 'string' || !ID_PATTERN.test(w.id)) {
          add(k + 'id', label + 'のID', '英小文字・数字・ハイフンのIDが必要です');
        } else if (workIds[w.id]) {
          add(k + 'id', label + 'のID', 'ID「' + w.id + '」が重複しています');
        } else {
          workIds[w.id] = true;
        }
        if (checkString(w, 'name', k + 'name', label + 'の作品名') && publish && w.name.trim() === '') {
          add(k + 'name', label + 'の作品名', '入力してください');
        }
        checkString(w, 'description', k + 'description', label + 'の説明');
        if (WORK_TYPES.indexOf(w.type) === -1) add(k + 'type', label + 'の種別', 'web か android である必要があります');
        var visibleOk = checkBool(w, 'visible', k + 'visible', label + 'の公開設定');
        checkUrl(w, k + 'url', label + 'のURL', publish && visibleOk && w.visible);
        checkString(w, 'buttonLabel', k + 'buttonLabel', label + 'のボタン文言');
        checkImage(w, 'image', k + 'image', label + 'の画像');
        if (IMAGE_KINDS.indexOf(w.imageKind) === -1) add(k + 'imageKind', label + 'の画像の種類', 'icon か screenshot である必要があります');
        checkString(w, 'imageAlt', k + 'imageAlt', label + 'の画像の説明');
      });
    }

    // 各種リンク
    if (!Array.isArray(data.links)) {
      add('links', '各種リンク', data.links === undefined ? '項目がありません' : '配列である必要があります');
    } else {
      var linkIds = {};
      data.links.forEach(function (l, i) {
        var label = 'リンク' + (i + 1) + (isObj(l) && typeof l.label === 'string' && l.label.trim() ? '「' + l.label.trim() + '」' : '');
        if (!isObj(l)) {
          add('links.#' + i, label, '形式が正しくありません');
          return;
        }
        var k = 'links.' + (typeof l.id === 'string' ? l.id : '#' + i) + '.';
        if (typeof l.id !== 'string' || !ID_PATTERN.test(l.id)) {
          add(k + 'id', label + 'のID', '英小文字・数字・ハイフンのIDが必要です');
        } else if (linkIds[l.id]) {
          add(k + 'id', label + 'のID', 'ID「' + l.id + '」が重複しています');
        } else {
          linkIds[l.id] = true;
        }
        if (checkString(l, 'label', k + 'label', label + 'の表示名') && publish && l.label.trim() === '') {
          add(k + 'label', label + 'の表示名', '入力してください');
        }
        var visibleOk = checkBool(l, 'visible', k + 'visible', label + 'の公開設定');
        checkUrl(l, k + 'url', label + 'のURL', publish && visibleOk && l.visible);
        if (checkString(l, 'icon', k + 'icon', label + 'のアイコン') && l.icon !== '' && !ICONS.hasOwnProperty(l.icon)) {
          add(k + 'icon', label + 'のアイコン', '未対応のアイコン「' + l.icon + '」です');
        }
      });
    }
    return errors;
  }

  /* ---------- 描画 ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // 固定の内部定義だけを SVG として挿入する（利用者の文字列は使わない）
  function svgIcon(inner, className) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', className || 'icon');
    svg.innerHTML = inner;
    return svg;
  }

  function placeholder(className) {
    var box = el('div', 'ph ' + (className || ''));
    box.setAttribute('aria-hidden', 'true');
    box.appendChild(svgIcon(PLACEHOLDER_SVG, 'ph-icon'));
    return box;
  }

  function externalLink(href, className) {
    var a = el('a', className);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function appendNewTabHint(a) {
    a.appendChild(svgIcon(EXTERNAL_SVG, 'icon icon-ext'));
    a.appendChild(el('span', 'sr-only', '（新しいタブで開きます）'));
  }

  function isPublic(item) {
    return item && item.visible === true && isSafeUrl(item.url);
  }

  function renderWorkCard(work, resolveImage) {
    var card = el('article', 'card');
    var name = (work.name || '').trim();
    var hasImage = isImagePath(work.image);
    var isShot = hasImage && work.imageKind === 'screenshot';

    function makeImg(wrapClass) {
      var wrap = el('div', 'media ' + wrapClass);
      var img = document.createElement('img');
      img.src = resolveImage(work.image);
      img.alt = (work.imageAlt || '').trim() || name;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () {
        // 読み込み失敗時は同じ枠の代替表示に差し替えてレイアウトを保つ
        wrap.replaceWith(placeholder(wrapClass));
      }, { once: true });
      wrap.appendChild(img);
      return wrap;
    }

    if (isShot) card.appendChild(makeImg('media-shot'));

    var head = el('div', 'card-head');
    if (!isShot) head.appendChild(hasImage ? makeImg('media-icon') : placeholder('media-icon'));
    var titles = el('div', 'card-titles');
    titles.appendChild(el('h3', 'card-title', name));
    titles.appendChild(el('span', 'badge badge-' + work.type, TYPE_LABELS[work.type] || work.type));
    head.appendChild(titles);
    card.appendChild(head);

    var desc = (work.description || '').trim();
    if (desc) card.appendChild(el('p', 'card-desc', desc));

    var btn = externalLink(work.url.trim(), 'btn');
    btn.appendChild(el('span', null, (work.buttonLabel || '').trim() || defaultButtonLabel(work.type)));
    appendNewTabHint(btn);
    var foot = el('div', 'card-foot');
    foot.appendChild(btn);
    card.appendChild(foot);
    return card;
  }

  function renderSite(root, data, options) {
    var opts = options || {};
    var resolveImage = opts.resolveImage || function (p) { return p; };
    var profile = data.profile || {};
    var title = (profile.siteTitle || '').trim();

    if (opts.setDocumentTitle !== false && title) document.title = title;
    root.textContent = '';

    // プロフィール
    var header = el('header', 'profile');
    var avatar = el('div', 'avatar');
    if (isImagePath(profile.image)) {
      var img = document.createElement('img');
      img.src = resolveImage(profile.image);
      img.alt = ((profile.displayName || '').trim() || title) + 'のアイコン';
      img.width = 160;
      img.height = 160;
      img.addEventListener('error', function () {
        avatar.textContent = '';
        avatar.appendChild(placeholder('avatar-ph'));
      }, { once: true });
      avatar.appendChild(img);
    } else {
      avatar.appendChild(placeholder('avatar-ph'));
    }
    header.appendChild(avatar);
    header.appendChild(el('h1', 'site-title', title));
    var bio = (profile.bio || '').trim();
    if (bio) header.appendChild(el('p', 'bio', bio));
    root.appendChild(header);

    var main = el('main', 'content');
    var works = Array.isArray(data.works) ? data.works : [];
    WORK_TYPES.forEach(function (type) {
      var list = works.filter(function (w) {
        return w && w.type === type && isPublic(w) && typeof w.name === 'string' && w.name.trim();
      });
      if (!list.length) return;
      var section = el('section', 'section section-' + type);
      section.setAttribute('aria-labelledby', 'sec-' + type);
      var h2 = el('h2', 'section-title', SECTION_TITLES[type]);
      h2.id = 'sec-' + type;
      section.appendChild(h2);
      var grid = el('div', 'grid');
      list.forEach(function (w) { grid.appendChild(renderWorkCard(w, resolveImage)); });
      section.appendChild(grid);
      main.appendChild(section);
    });

    // 各種リンク（公開対象ゼロなら見出しごと出さない）
    var links = (Array.isArray(data.links) ? data.links : []).filter(function (l) {
      return l && isPublic(l) && typeof l.label === 'string' && l.label.trim();
    });
    if (links.length) {
      var ls = el('section', 'section section-links');
      ls.setAttribute('aria-labelledby', 'sec-links');
      var lh = el('h2', 'section-title', 'リンク');
      lh.id = 'sec-links';
      ls.appendChild(lh);
      var ul = el('ul', 'links');
      links.forEach(function (l) {
        var li = el('li');
        var a = externalLink(l.url.trim(), 'link-pill');
        var icon = ICONS[l.icon] || ICONS.link;
        a.appendChild(svgIcon(icon.svg, 'icon icon-service'));
        a.appendChild(el('span', 'link-label', l.label.trim()));
        appendNewTabHint(a);
        li.appendChild(a);
        ul.appendChild(li);
      });
      ls.appendChild(ul);
      main.appendChild(ls);
    }
    root.appendChild(main);

    var footer = el('footer', 'footer');
    var who = (profile.displayName || '').trim();
    footer.appendChild(el('p', null, '© ' + (who || title)));
    root.appendChild(footer);
  }

  function showLoadError(root, message) {
    root.textContent = '';
    var box = el('div', 'load-error');
    box.setAttribute('role', 'alert');
    box.appendChild(el('p', null, message));
    root.appendChild(box);
  }

  /* ---------- 公開ページの起動 ---------- */

  function bootPublic() {
    var root = document.getElementById('app');
    if (!root) return;
    var params = new URLSearchParams(location.search);
    var isPreview = params.get('preview') === '1' && window.parent !== window;

    if (isPreview) {
      // 更新ツールのプレビュー：同じオリジンの親ウィンドウから編集中のデータを受け取る
      document.documentElement.classList.add('is-preview');
      window.addEventListener('message', function (ev) {
        if (ev.origin !== location.origin || ev.source !== window.parent) return;
        var msg = ev.data;
        if (!msg || msg.type !== 'pee-preview' || !msg.data) return;
        var images = msg.images || {};
        renderSite(root, msg.data, {
          resolveImage: function (p) { return Object.prototype.hasOwnProperty.call(images, p) ? images[p] : p; }
        });
      });
      window.parent.postMessage({ type: 'pee-preview-ready' }, location.origin);
      return;
    }

    fetch('data/site.json', { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var errors = validateSite(data, 'structure');
        if (errors.length && (errors[0].key === 'root' || errors[0].key === 'schemaVersion')) {
          throw new Error(errors[0].field + ': ' + errors[0].message);
        }
        renderSite(root, data);
      })
      .catch(function () {
        showLoadError(root, 'データを読み込めませんでした。時間をおいて再読み込みしてください。');
      });
  }

  window.PeeSite = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    WORK_TYPES: WORK_TYPES,
    TYPE_LABELS: TYPE_LABELS,
    ICONS: ICONS,
    isSafeUrl: isSafeUrl,
    isImagePath: isImagePath,
    defaultButtonLabel: defaultButtonLabel,
    generateId: generateId,
    newWork: newWork,
    newLink: newLink,
    validateSite: validateSite,
    renderSite: renderSite
  };

  if (document.documentElement.getAttribute('data-page') === 'public') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootPublic);
    } else {
      bootPublic();
    }
  }
})();
