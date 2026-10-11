/*
 * ぺぇのつくったもの — 更新ツール
 * 下書きは localStorage（JSON）と IndexedDB（新しく選んだ画像）に保存する。
 * GitHubへの書き込みは行わず、公開用ファイル（site.json または ZIP）を書き出すだけ。
 */
(function () {
  'use strict';

  var S = window.PeeSite;
  var DRAFT_KEY = 'pee-portfolio-editor-draft-v1';
  var DB_NAME = 'pee-portfolio-editor';
  var DB_STORE = 'images';
  var MAX_FILE_BYTES = 5 * 1024 * 1024;
  var MAX_DIMENSION = 1600;
  var PREVIEW_WIDTHS = { mobile: 390, pc: 1280 };

  var state = {
    data: null,
    // 新しく選んだ画像: path -> { blob, url }。blob が null なら下書き復元時に画像データが見つからなかったもの
    images: new Map(),
    dirty: false,
    showAllErrors: false,
    touched: new Set(),
    imageErrors: new Map(),
    open: new Set(),
    previewReady: false,
    previewWidth: 'mobile'
  };
  var fields = new Map();      // エラー表示先: key -> { focus, err, itemId }
  var headUpdaters = [];       // 各項目の見出し更新関数

  var $ = function (id) { return document.getElementById(id); };

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(text, className) {
    var b = h('button', 'btn ' + (className || ''), text);
    b.type = 'button';
    return b;
  }

  function fieldId(key) {
    return 'f-' + key.replace(/[^A-Za-z0-9_-]/g, '-');
  }

  /* ---------- 状態表示 ---------- */

  function setStatus(message, kind) {
    var el = $('status');
    el.textContent = message || '';
    el.className = 'status' + (kind ? ' status-' + kind : '');
  }

  function setDirty(value) {
    state.dirty = value;
    $('dirty').hidden = !value;
  }

  function showProblems(title, items) {
    var box = $('problems');
    box.textContent = '';
    if (!items || !items.length) {
      box.hidden = true;
      return;
    }
    box.appendChild(h('p', 'problems-title', title));
    var ul = h('ul');
    items.forEach(function (it) {
      var li = h('li');
      var target = it.key && fields.get(it.key);
      if (target) {
        var b = h('button', 'link-button', it.field + '：' + it.message);
        b.type = 'button';
        b.addEventListener('click', function () { focusField(it.key); });
        li.appendChild(b);
      } else {
        li.textContent = it.field + '：' + it.message;
      }
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.hidden = false;
  }

  function focusField(key) {
    var f = fields.get(key);
    if (!f) return;
    if (f.itemId && !state.open.has(f.itemId)) {
      state.open.add(f.itemId);
      var li = document.querySelector('.item[data-id="' + CSS.escape(f.itemId) + '"]');
      if (li) setItemOpen(li, true);
    }
    f.focus.focus();
    f.focus.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  /* ---------- 画像 ---------- */

  function resolveEditorImage(path) {
    var entry = state.images.get(path);
    if (entry) return entry.url || '';
    return '../' + path;
  }

  function randomName(length) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var buf = new Uint8Array(length);
    crypto.getRandomValues(buf);
    var s = '';
    for (var i = 0; i < buf.length; i++) s += chars[buf[i] % chars.length];
    return s;
  }

  function newImagePath(dir, ext) {
    var path;
    do {
      path = dir + randomName(12) + '.' + ext;
    } while (state.images.has(path));
    return path;
  }

  function sniffType(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
  }

  var EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
  }

  // 形式・容量を確認し、長辺が1600pxを超える場合は縮小する（PNG/WebPの透過は保持）
  async function processImage(file) {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error('画像が5MBを超えています（' + (file.size / 1024 / 1024).toFixed(1) + 'MB）。小さくしてから選んでください。');
    }
    var head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    var type = sniffType(head);
    if (!type) throw new Error('PNG・JPEG・WebP の画像を選んでください（SVGなどは使えません）。');

    var bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      throw new Error('画像を読み込めませんでした。別の画像を選んでください。');
    }
    var w = bitmap.width;
    var hgt = bitmap.height;
    var longest = Math.max(w, hgt);
    if (longest <= MAX_DIMENSION) {
      bitmap.close && bitmap.close();
      return { blob: new Blob([file], { type: type }), type: type };
    }
    var scale = MAX_DIMENSION / longest;
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(hgt * scale));
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close && bitmap.close();
    var out = await canvasToBlob(canvas, type, 0.9);
    if (!out || out.type !== type) {
      // WebPに書き出せないブラウザでは、透過を保てるPNGにする
      out = await canvasToBlob(canvas, 'image/png');
      type = 'image/png';
    }
    if (!out) throw new Error('画像を縮小できませんでした。別の画像を選んでください。');
    return { blob: out, type: type };
  }

  var pendingImagePick = null;

  function pickImage(onPicked, errKey) {
    pendingImagePick = { onPicked: onPicked, errKey: errKey };
    var input = $('image-input');
    input.value = '';
    input.click();
  }

  async function handleImageInput() {
    var input = $('image-input');
    var file = input.files && input.files[0];
    var pick = pendingImagePick;
    pendingImagePick = null;
    if (!file || !pick) return;
    setStatus('画像を準備しています…');
    try {
      var result = await processImage(file);
      state.imageErrors.delete(pick.errKey);
      pick.onPicked(result);
      setStatus('画像を設定しました。公開サイトに反映するには、書き出したZIPをリポジトリに反映してください。', 'info');
    } catch (e) {
      state.imageErrors.set(pick.errKey, e.message);
      setStatus(e.message, 'error');
      refreshValidation();
    }
  }

  function addNewImage(dir, result) {
    var path = newImagePath(dir, EXT[result.type]);
    state.images.set(path, { blob: result.blob, url: URL.createObjectURL(result.blob) });
    return path;
  }

  function imageRefs() {
    var refs = [];
    var d = state.data;
    if (!d) return refs;
    if (d.profile && d.profile.image) refs.push({ path: d.profile.image, key: 'profile.image', field: 'プロフィール画像' });
    d.works.forEach(function (w, i) {
      if (w.image) refs.push({ path: w.image, key: 'works.' + w.id + '.image', field: '作品' + (i + 1) + (w.name.trim() ? '「' + w.name.trim() + '」' : '') + 'の画像' });
    });
    return refs;
  }

  function referencedNewPaths() {
    var seen = [];
    imageRefs().forEach(function (r) {
      if (state.images.has(r.path) && seen.indexOf(r.path) === -1) seen.push(r.path);
    });
    return seen;
  }

  // どこからも参照されなくなった新規画像をメモリから外す
  function releaseUnusedImages() {
    var used = referencedNewPaths();
    state.images.forEach(function (entry, path) {
      if (used.indexOf(path) === -1) {
        if (entry.url) URL.revokeObjectURL(entry.url);
        state.images.delete(path);
      }
    });
  }

  function clearImages() {
    state.images.forEach(function (entry) { if (entry.url) URL.revokeObjectURL(entry.url); });
    state.images.clear();
  }

  /* ---------- IndexedDB ---------- */

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('IndexedDB を使えません'));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbRun(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, mode);
        var store = tx.objectStore(DB_STORE);
        var result;
        Promise.resolve(fn(store, function (r) { result = r; }));
        tx.oncomplete = function () { db.close(); resolve(result); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error('保存が中断されました')); };
      });
    });
  }

  function idbPutAll(entries) {
    return idbRun('readwrite', function (store) {
      entries.forEach(function (e) { store.put(e.blob, e.path); });
    });
  }

  function idbGet(path) {
    return idbRun('readonly', function (store, done) {
      var req = store.get(path);
      req.onsuccess = function () { done(req.result || null); };
    });
  }

  function idbDeleteExcept(keep) {
    return idbRun('readwrite', function (store) {
      var req = store.getAllKeys();
      req.onsuccess = function () {
        req.result.forEach(function (k) { if (keep.indexOf(k) === -1) store.delete(k); });
      };
    });
  }

  /* ---------- 下書き ---------- */

  function readDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      var draft = JSON.parse(raw);
      if (!draft || typeof draft !== 'object' || !draft.data) return { broken: true };
      return draft;
    } catch (e) {
      return { broken: true };
    }
  }

  async function saveDraft() {
    if (!state.data) return;
    var newPaths = referencedNewPaths();
    try {
      var withBlob = newPaths
        .map(function (p) { return { path: p, blob: state.images.get(p).blob }; })
        .filter(function (e) { return e.blob; });
      if (withBlob.length) await idbPutAll(withBlob);
      var payload = JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        data: state.data,
        newImages: newPaths
      });
      localStorage.setItem(DRAFT_KEY, payload);
      if (localStorage.getItem(DRAFT_KEY) !== payload) throw new Error('verify');
    } catch (e) {
      setStatus('下書きを保存できませんでした。端末の空き容量やブラウザの設定（プライベートモードなど）を確認してください。', 'error');
      return;
    }
    // 下書きの保存が確定してから、使われなくなった画像を片付ける
    try { await idbDeleteExcept(newPaths); } catch (e) { /* 片付けに失敗しても下書きは有効 */ }
    setDirty(false);
    setStatus('下書きをこの端末に保存しました（' + formatTime(new Date()) + '）。公開サイトはまだ変わっていません。', 'ok');
  }

  async function restoreDraft(draft) {
    var data = S.migrate(draft.data);
    var errors = S.validateSite(data, 'structure');
    if (errors.length) {
      showProblems('下書きの内容に問題があるため、復元できませんでした。公開データを読み込みます。', errors);
      return loadPublished();
    }
    clearImages();
    var paths = Array.isArray(draft.newImages) ? draft.newImages : [];
    var missing = 0;
    for (var i = 0; i < paths.length; i++) {
      var blob = null;
      try { blob = await idbGet(paths[i]); } catch (e) { blob = null; }
      if (blob) {
        state.images.set(paths[i], { blob: blob, url: URL.createObjectURL(blob) });
      } else {
        state.images.set(paths[i], { blob: null, url: '' });
        missing++;
      }
    }
    setData(data);
    setDirty(false);
    if (missing) {
      setStatus('下書きを復元しましたが、画像' + missing + '件のデータが見つかりませんでした。該当する画像を選び直してください。', 'error');
    } else {
      setStatus('下書きを復元しました（保存日時：' + formatTime(new Date(draft.savedAt)) + '）。', 'ok');
    }
  }

  function formatTime(d) {
    if (isNaN(d.getTime())) return '不明';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------- 読み込み ---------- */

  async function loadPublished() {
    setStatus('公開データを読み込んでいます…');
    try {
      var res = await fetch('../data/site.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var text = await res.text();
      var data = S.migrate(JSON.parse(text));
      var errors = S.validateSite(data, 'structure');
      if (errors.length) {
        showProblems('公開データ（data/site.json）に問題があります。', errors);
        if (!state.data) showEmpty('公開データに問題があるため編集を始められません。「JSONファイルを読み込む」から正しいファイルを読み込んでください。');
        setStatus('公開データに問題があります。', 'error');
        return;
      }
      clearImages();
      setData(data);
      setDirty(false);
      setStatus('最新の公開データを読み込みました。', 'ok');
    } catch (e) {
      if (!state.data) showEmpty('公開データ（data/site.json）を読み込めませんでした。HTTPサーバー経由で開くか、「JSONファイルを読み込む」から読み込んでください。');
      setStatus('公開データを読み込めませんでした。', 'error');
    }
  }

  async function importJsonFile(file) {
    var text;
    try {
      text = await file.text();
    } catch (e) {
      showProblems('ファイルを読み込めませんでした。', [{ field: file.name, message: '読み込みに失敗しました' }]);
      return;
    }
    var data;
    try {
      data = S.migrate(JSON.parse(text));
    } catch (e) {
      showProblems('JSONとして読み込めませんでした。現在の編集内容はそのままです。', [{ field: file.name, message: '不正なJSONです（' + e.message + '）' }]);
      setStatus('JSONファイルを読み込めませんでした。', 'error');
      return;
    }
    var errors = S.validateSite(data, 'structure');
    if (errors.length) {
      showProblems('読み込んだファイルに問題があります。現在の編集内容はそのままです。', errors);
      setStatus('JSONファイルに問題があるため読み込みませんでした。', 'error');
      return;
    }
    if (state.data && !confirm('現在の編集内容を、読み込んだファイル「' + file.name + '」の内容にすべて置き換えます。よろしいですか？')) {
      setStatus('読み込みを取り消しました。');
      return;
    }
    setData(data);
    releaseUnusedImages();
    setDirty(true);
    setStatus('「' + file.name + '」を読み込みました。必要なら「下書きを保存」してください。', 'ok');
  }

  /* ---------- 書き出し ---------- */

  function cleanData(src) {
    var d = JSON.parse(JSON.stringify(src));
    var p = d.profile;
    p.siteTitle = p.siteTitle.trim();
    p.displayName = p.displayName.trim();
    p.bio = p.bio.trim();
    d.categories.forEach(function (c) {
      ['label', 'badge', 'buttonLabel'].forEach(function (k) { c[k] = c[k].trim(); });
    });
    d.works.forEach(function (w) {
      ['name', 'url', 'buttonLabel', 'imageAlt'].forEach(function (k) { w[k] = w[k].trim(); });
      w.description = w.description.trim();
    });
    d.links.forEach(function (l) {
      l.label = l.label.trim();
      l.url = l.url.trim();
    });
    return {
      schemaVersion: d.schemaVersion,
      profile: { siteTitle: p.siteTitle, displayName: p.displayName, bio: p.bio, image: p.image },
      categories: d.categories.map(function (c) {
        return { id: c.id, label: c.label, badge: c.badge, buttonLabel: c.buttonLabel, visible: c.visible };
      }),
      works: d.works.map(function (w) {
        return { id: w.id, name: w.name, description: w.description, category: w.category, url: w.url, buttonLabel: w.buttonLabel, image: w.image, imageKind: w.imageKind, imageAlt: w.imageAlt, visible: w.visible };
      }),
      links: d.links.map(function (l) {
        return { id: l.id, label: l.label, url: l.url, icon: l.icon, visible: l.visible };
      })
    };
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function stamp() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  async function exportFiles() {
    if (!state.data) return;
    state.showAllErrors = true;
    var errors = refreshValidation();
    if (errors.length) {
      showProblems('書き出す前に、次の項目を直してください（' + errors.length + '件）。', errors);
      setStatus('入力内容に直す項目があるため、書き出しませんでした。', 'error');
      return;
    }
    showProblems('', []);
    var data = cleanData(state.data);
    var json = JSON.stringify(data, null, 2) + '\n';
    var newPaths = referencedNewPaths();

    if (!newPaths.length) {
      download(new Blob([json], { type: 'application/json' }), 'site.json');
      setStatus('公開用ファイル「site.json」を書き出しました。リポジトリの data/site.json と差し替えてコミットすると、公開サイトに反映されます。', 'ok');
      return;
    }

    var entries = [{ path: 'data/site.json', data: new TextEncoder().encode(json) }];
    try {
      for (var i = 0; i < newPaths.length; i++) {
        var entry = state.images.get(newPaths[i]);
        entries.push({ path: newPaths[i], data: new Uint8Array(await entry.blob.arrayBuffer()) });
      }
    } catch (e) {
      setStatus('画像データを読み出せなかったため、書き出しを中止しました。画像を選び直してください。', 'error');
      return;
    }
    var name = 'pee-portfolio-update-' + stamp() + '.zip';
    download(PeeZip.create(entries), name);
    setStatus('公開用ファイル「' + name + '」を書き出しました（site.json と画像' + newPaths.length + '件）。展開した中身をリポジトリのフォルダに重ねてコミット・Pushすると、公開サイトに反映されます。', 'ok');
  }

  /* ---------- 検証表示 ---------- */

  function collectErrors() {
    var errors = S.validateSite(state.data, 'publish');
    imageRefs().forEach(function (r) {
      var entry = state.images.get(r.path);
      if (entry && !entry.blob) {
        errors.push({ key: r.key, field: r.field, message: '画像データが見つかりません。もう一度選び直してください' });
      }
    });
    return errors;
  }

  // 戻り値は書き出しを止めるべきエラー。画像選択の失敗（transient）は表示だけに使う
  function refreshValidation() {
    if (!state.data) return [];
    var errors = collectErrors();
    var byKey = new Map();
    state.imageErrors.forEach(function (message, key) { byKey.set(key, message); });
    errors.forEach(function (e) { if (!byKey.has(e.key)) byKey.set(e.key, e.message); });

    fields.forEach(function (f, key) {
      var msg = byKey.get(key);
      var show = msg && (state.showAllErrors || state.touched.has(key) || state.imageErrors.has(key) || !/入力してください|URLが必要/.test(msg));
      f.err.textContent = show ? msg : '';
      f.err.hidden = !show;
      if (f.focus.matches('input, textarea, select')) {
        if (show) f.focus.setAttribute('aria-invalid', 'true');
        else f.focus.removeAttribute('aria-invalid');
      }
    });
    headUpdaters.forEach(function (fn) { fn(byKey); });

    if (state.showAllErrors && !$('problems').hidden) {
      if (errors.length) showProblems('書き出す前に、次の項目を直してください（' + errors.length + '件）。', errors);
      else showProblems('', []);
    }
    return errors;
  }

  /* ---------- プレビュー ---------- */

  var previewTimer = null;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(sendPreview, 150);
  }

  function sendPreview() {
    var frame = $('preview');
    if (!state.previewReady || !state.data || !frame.contentWindow) return;
    var images = {};
    state.images.forEach(function (entry, path) { if (entry.url) images[path] = entry.url; });
    frame.contentWindow.postMessage({ type: 'pee-preview', data: state.data, images: images }, location.origin);
  }

  function layoutPreview() {
    var wrap = $('preview-frame');
    var frame = $('preview');
    var width = PREVIEW_WIDTHS[state.previewWidth];
    var available = wrap.clientWidth;
    var scale = Math.min(1, available / width);
    var height = wrap.clientHeight;
    frame.style.width = width + 'px';
    frame.style.height = Math.ceil(height / scale) + 'px';
    frame.style.transform = 'scale(' + scale + ')';
    frame.style.left = scale === 1 ? Math.floor((available - width) / 2) + 'px' : '0';
  }

  function setPreviewWidth(mode) {
    state.previewWidth = mode;
    document.querySelectorAll('.seg').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.width === mode));
    });
    layoutPreview();
  }

  /* ---------- 変更の反映 ---------- */

  function changed(key) {
    if (key) state.touched.add(key);
    setDirty(true);
    refreshValidation();
    schedulePreview();
  }

  function setData(data) {
    state.data = JSON.parse(JSON.stringify(data));
    state.touched.clear();
    state.imageErrors.clear();
    state.showAllErrors = false;
    showProblems('', []);
    $('btn-save').disabled = false;
    $('btn-export').disabled = false;
    renderEditor();
    schedulePreview();
  }

  function showEmpty(message) {
    var root = $('editor-root');
    root.textContent = '';
    root.appendChild(h('p', 'empty-state', message));
  }

  /* ---------- フォーム部品 ---------- */

  function register(key, focusEl, errEl, itemId) {
    fields.set(key, { focus: focusEl, err: errEl, itemId: itemId || null });
  }

  function makeField(opts) {
    var wrap = h('div', 'field' + (opts.className ? ' ' + opts.className : ''));
    var id = fieldId(opts.key);
    opts.input.id = id;
    var label = h('label', 'field-label', opts.label);
    label.htmlFor = id;
    if (opts.required) label.appendChild(h('span', 'req', '必須'));
    wrap.appendChild(label);
    var described = [];
    if (opts.hint) {
      var hint = h('p', 'hint', opts.hint);
      hint.id = id + '-hint';
      described.push(hint.id);
      wrap.appendChild(hint);
    }
    wrap.appendChild(opts.input);
    var err = h('p', 'field-error');
    err.id = id + '-err';
    err.hidden = true;
    described.push(err.id);
    wrap.appendChild(err);
    opts.input.setAttribute('aria-describedby', described.join(' '));
    opts.input.addEventListener('blur', function () {
      state.touched.add(opts.key);
      refreshValidation();
    });
    register(opts.key, opts.input, err, opts.itemId);
    return wrap;
  }

  function textInput(obj, prop, key, opts) {
    var o = opts || {};
    var input = h(o.multiline ? 'textarea' : 'input', 'input');
    if (o.multiline) input.rows = 3;
    else input.type = o.type || 'text';
    if (o.inputMode) input.inputMode = o.inputMode;
    if (o.placeholder) input.placeholder = o.placeholder;
    if (o.autocomplete) input.autocomplete = o.autocomplete;
    input.spellcheck = !o.noSpell;
    input.value = obj[prop];
    input.addEventListener('input', function () {
      obj[prop] = input.value;
      if (o.onInput) o.onInput();
      changed(o.lazyTouch ? null : key);
    });
    return input;
  }

  function checkbox(obj, prop, key, labelText, onChange, itemId) {
    var wrap = h('div', 'field field-check');
    var input = h('input');
    input.type = 'checkbox';
    input.id = fieldId(key);
    input.checked = !!obj[prop];
    var label = h('label', null, labelText);
    label.htmlFor = input.id;
    input.addEventListener('change', function () {
      obj[prop] = input.checked;
      if (onChange) onChange();
      changed(key);
    });
    wrap.appendChild(input);
    wrap.appendChild(label);
    var err = h('p', 'field-error');
    err.hidden = true;
    wrap.appendChild(err);
    register(key, input, err, itemId);
    return wrap;
  }

  function imageField(opts) {
    // opts: key, label, hint, get(), set(path), dir, itemId, onChange
    var wrap = h('div', 'field image-field');
    var labelId = fieldId(opts.key) + '-label';
    var label = h('p', 'field-label', opts.label);
    label.id = labelId;
    wrap.appendChild(label);
    if (opts.hint) wrap.appendChild(h('p', 'hint', opts.hint));
    var row = h('div', 'image-row');
    var preview = h('div', 'image-preview');
    var buttons = h('div', 'image-buttons');
    var choose = button('画像を選ぶ');
    choose.id = fieldId(opts.key);
    var remove = button('画像を外す', 'btn-ghost');
    buttons.appendChild(choose);
    buttons.appendChild(remove);
    row.appendChild(preview);
    row.appendChild(buttons);
    wrap.appendChild(row);
    var err = h('p', 'field-error');
    err.hidden = true;
    err.id = fieldId(opts.key) + '-err';
    choose.setAttribute('aria-describedby', labelId + ' ' + err.id);
    wrap.appendChild(err);

    function update() {
      preview.textContent = '';
      var path = opts.get();
      if (path) {
        var src = resolveEditorImage(path);
        if (src) {
          var img = new Image();
          img.alt = '現在の画像';
          img.src = src;
          img.addEventListener('error', function () {
            preview.textContent = '';
            preview.appendChild(h('span', 'image-none', '表示できません'));
          }, { once: true });
          preview.appendChild(img);
        } else {
          preview.appendChild(h('span', 'image-none', '画像データなし'));
        }
        choose.textContent = '画像を差し替える';
        remove.hidden = false;
      } else {
        preview.appendChild(h('span', 'image-none', '画像なし'));
        choose.textContent = '画像を選ぶ';
        remove.hidden = true;
      }
    }

    choose.addEventListener('click', function () {
      pickImage(function (result) {
        var path = addNewImage(opts.dir, result);
        opts.set(path);
        releaseUnusedImages();
        update();
        if (opts.onChange) opts.onChange();
        changed(opts.key);
      }, opts.key);
    });
    remove.addEventListener('click', function () {
      opts.set('');
      state.imageErrors.delete(opts.key);
      releaseUnusedImages();
      update();
      if (opts.onChange) opts.onChange();
      changed(opts.key);
      choose.focus();
    });
    register(opts.key, choose, err, opts.itemId);
    update();
    return wrap;
  }

  /* ---------- 各セクション ---------- */

  function renderEditor() {
    fields.clear();
    headUpdaters = [];
    var root = $('editor-root');
    root.textContent = '';
    root.appendChild(renderProfileSection());
    root.appendChild(renderListSection('categories'));
    root.appendChild(renderListSection('works'));
    root.appendChild(renderListSection('links'));
    refreshValidation();
  }

  function renderProfileSection() {
    var p = state.data.profile;
    var sec = h('section', 'panel');
    sec.setAttribute('aria-labelledby', 'sec-profile');
    var title = h('h2', 'panel-title', 'サイトの基本情報');
    title.id = 'sec-profile';
    sec.appendChild(title);
    sec.appendChild(makeField({ key: 'profile.siteTitle', label: 'サイト名', required: true, input: textInput(p, 'siteTitle', 'profile.siteTitle') }));
    sec.appendChild(makeField({ key: 'profile.displayName', label: '表示名', required: true, input: textInput(p, 'displayName', 'profile.displayName') }));
    sec.appendChild(makeField({ key: 'profile.bio', label: '紹介文', input: textInput(p, 'bio', 'profile.bio', { multiline: true }) }));
    sec.appendChild(imageField({
      key: 'profile.image',
      label: 'プロフィール画像',
      hint: 'PNG・JPEG・WebP、5MBまで。長辺1600pxを超える画像は縮小します。',
      dir: 'assets/profile-',
      get: function () { return p.image; },
      set: function (v) { p.image = v; }
    }));
    return sec;
  }

  function worksInCategory(categoryId) {
    return state.data.works.filter(function (w) { return w.category === categoryId; }).length;
  }

  var LIST_CONFIG = {
    categories: {
      title: 'ジャンル',
      note: 'ジャンルの並び順が、公開ページでの見出しの順番になります。公開する作品がないジャンルは表示されません。',
      addLabel: 'ジャンルを追加',
      noun: 'ジャンル',
      unnamed: '（見出し未入力）',
      empty: 'ジャンルがありません。作品を登録するには、先にジャンルを追加してください。',
      create: function (ids) { return S.newCategory(ids); },
      name: function (c) { return c.label.trim(); },
      tags: function (c) {
        var tags = [];
        if (c.badge.trim()) tags.push({ text: c.badge.trim(), cls: 'tag-c' + S.badgeColorIndex(state.data, c.id) });
        tags.push({ text: '作品' + worksInCategory(c.id) + '件', cls: 'tag-icon' });
        return tags;
      },
      canDelete: function (c) {
        var n = worksInCategory(c.id);
        return n ? 'このジャンルには作品が' + n + '件あります。先に、それらの作品のジャンルを変えるか、作品を削除してください。' : null;
      },
      renderFields: renderCategoryFields
    },
    works: {
      title: '作品',
      addLabel: '作品を追加',
      noun: '作品',
      unnamed: '（作品名未入力）',
      empty: 'まだ作品がありません。',
      create: function (ids) {
        var first = state.data.categories[0];
        return S.newWork(ids, first ? first.id : '');
      },
      name: function (w) { return w.name.trim(); },
      tags: function (w) {
        var c = S.findCategory(state.data, w.category);
        if (!c) return [{ text: 'ジャンル未設定', cls: 'tag-warn' }];
        return [{ text: c.badge.trim() || c.label.trim() || '（見出し未入力）', cls: 'tag-c' + S.badgeColorIndex(state.data, c.id) }];
      },
      renderFields: renderWorkFields
    },
    links: {
      title: '各種リンク',
      addLabel: 'リンクを追加',
      noun: 'リンク',
      unnamed: '（表示名未入力）',
      empty: 'まだリンクがありません。リンクがないあいだは、公開ページにこの欄は表示されません。',
      create: function (ids) { return S.newLink(ids); },
      name: function (l) { return l.label.trim(); },
      tags: function (l) {
        var icon = S.ICONS[l.icon];
        return icon ? [{ text: icon.label, cls: 'tag-icon' }] : [];
      },
      renderFields: renderLinkFields
    }
  };

  function renderListSection(listKey) {
    var cfg = LIST_CONFIG[listKey];
    var sec = h('section', 'panel');
    sec.id = 'panel-' + listKey;
    sec.setAttribute('aria-labelledby', 'sec-' + listKey);
    var title = h('h2', 'panel-title', cfg.title);
    title.id = 'sec-' + listKey;
    sec.appendChild(title);
    sec.appendChild(h('p', 'panel-note', cfg.note || '並び順がそのまま公開ページの表示順になります。「非表示」にした項目も公開用ファイルには残ります。'));

    var items = state.data[listKey];
    if (!items.length) sec.appendChild(h('p', 'empty-state', cfg.empty));
    var ul = h('ul', 'items');
    items.forEach(function (item, index) {
      ul.appendChild(renderItem(listKey, item, index, items.length));
    });
    sec.appendChild(ul);

    var add = button('＋ ' + cfg.addLabel, 'btn-add');
    add.id = 'add-' + listKey;
    add.addEventListener('click', function () {
      var ids = state.data[listKey].map(function (x) { return x.id; });
      var item = cfg.create(ids);
      state.data[listKey].push(item);
      state.open.add(item.id);
      rerenderList(listKey);
      changed(null);
      var first = document.querySelector('.item[data-id="' + CSS.escape(item.id) + '"] .item-body input');
      if (first) first.focus();
    });
    sec.appendChild(add);
    return sec;
  }

  function rerenderList(listKey, focus) {
    // 該当リストに属するフィールド登録を消してから描き直す
    Array.from(fields.keys()).forEach(function (k) { if (k.indexOf(listKey + '.') === 0) fields.delete(k); });
    var old = $('panel-' + listKey);
    var fresh = renderListSection(listKey);
    old.replaceWith(fresh);
    headUpdaters = headUpdaters.filter(function (fn) { return document.body.contains(fn.node); });
    refreshValidation();
    if (focus) {
      var li = document.querySelector('.item[data-id="' + CSS.escape(focus.id) + '"]');
      var target = li && li.querySelector('[data-action="' + focus.action + '"]');
      if (target && target.disabled) target = li.querySelector('[data-action="' + (focus.action === 'up' ? 'down' : 'up') + '"]');
      if (target && !target.disabled) target.focus();
      else if (li) li.querySelector('.item-toggle').focus();
    }
  }

  function setItemOpen(li, open) {
    var toggle = li.querySelector('.item-toggle');
    var body = li.querySelector('.item-body');
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    li.classList.toggle('is-open', open);
  }

  function renderItem(listKey, item, index, total) {
    var cfg = LIST_CONFIG[listKey];
    var li = h('li', 'item');
    li.dataset.id = item.id;
    var bodyId = 'body-' + item.id;

    var head = h('div', 'item-head');
    var toggle = h('button', 'item-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', bodyId);
    var chev = h('span', 'chev');
    chev.setAttribute('aria-hidden', 'true');
    var nameEl = h('span', 'item-name');
    var tagsEl = h('span', 'item-tags');
    toggle.appendChild(chev);
    toggle.appendChild(nameEl);
    toggle.appendChild(tagsEl);
    head.appendChild(toggle);

    var moves = h('div', 'item-moves');
    var up = button('↑', 'btn-icon');
    up.dataset.action = 'up';
    up.disabled = index === 0;
    var down = button('↓', 'btn-icon');
    down.dataset.action = 'down';
    down.disabled = index === total - 1;
    moves.appendChild(up);
    moves.appendChild(down);
    head.appendChild(moves);
    li.appendChild(head);

    var body = h('div', 'item-body');
    body.id = bodyId;
    cfg.renderFields(item, body);

    var foot = h('div', 'item-foot');
    var del = button('この' + cfg.noun + 'を削除', 'btn-danger');
    foot.appendChild(del);
    body.appendChild(foot);
    li.appendChild(body);

    function updateHead(errorsByKey) {
      var name = cfg.name(item);
      var shown = name || cfg.unnamed;
      nameEl.textContent = shown;
      tagsEl.textContent = '';
      cfg.tags(item).forEach(function (t) { tagsEl.appendChild(h('span', 'tag ' + t.cls, t.text)); });
      if (!item.visible) tagsEl.appendChild(h('span', 'tag tag-hidden', '非表示'));
      var prefix = listKey + '.' + item.id + '.';
      var hasError = false;
      if (errorsByKey) errorsByKey.forEach(function (_, k) { if (k.indexOf(prefix) === 0) hasError = true; });
      if (hasError) tagsEl.appendChild(h('span', 'tag tag-warn', '要確認'));
      up.setAttribute('aria-label', '「' + shown + '」を上へ移動');
      down.setAttribute('aria-label', '「' + shown + '」を下へ移動');
      del.setAttribute('aria-label', '「' + shown + '」を削除');
    }
    updateHead.node = li;
    headUpdaters.push(updateHead);
    updateHead(null);
    setItemOpen(li, state.open.has(item.id));

    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') !== 'true';
      if (open) state.open.add(item.id);
      else state.open.delete(item.id);
      setItemOpen(li, open);
    });

    function move(delta, action) {
      var list = state.data[listKey];
      var i = list.indexOf(item);
      var j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return;
      list.splice(i, 1);
      list.splice(j, 0, item);
      rerenderList(listKey, { id: item.id, action: action });
      changed(null);
      setStatus('「' + (cfg.name(item) || cfg.unnamed) + '」を' + (j + 1) + '番目に移動しました。');
    }
    up.addEventListener('click', function () { move(-1, 'up'); });
    down.addEventListener('click', function () { move(1, 'down'); });

    del.addEventListener('click', function () {
      var shown = cfg.name(item) || cfg.unnamed;
      var blocked = cfg.canDelete && cfg.canDelete(item);
      if (blocked) {
        alert(blocked);
        setStatus('「' + shown + '」は削除しませんでした。' + blocked, 'error');
        return;
      }
      var extra = listKey === 'works' ? '\n（画像ファイルはリポジトリから削除されません）' : '';
      if (!confirm('「' + shown + '」を削除しますか？' + extra)) return;
      var list = state.data[listKey];
      var i = list.indexOf(item);
      if (i < 0) return;
      list.splice(i, 1);
      state.open.delete(item.id);
      releaseUnusedImages();
      rerenderList(listKey);
      changed(null);
      var next = list[i] || list[i - 1];
      var target = next && document.querySelector('.item[data-id="' + CSS.escape(next.id) + '"] .item-toggle');
      (target || $('add-' + listKey)).focus();
      setStatus('「' + shown + '」を削除しました。');
    });

    return li;
  }

  function refreshHeads() {
    refreshValidation();
  }

  function renderWorkFields(w, body) {
    var base = 'works.' + w.id + '.';
    var id = w.id;
    var labelInput;

    body.appendChild(makeField({
      key: base + 'name', label: '作品名', required: true, itemId: id,
      input: textInput(w, 'name', base + 'name', { onInput: refreshHeads, lazyTouch: true })
    }));

    var categorySelect = h('select', 'input');
    categorySelect.addEventListener('change', function () {
      w.category = categorySelect.value;
      changed(base + 'category');
    });
    body.appendChild(makeField({
      key: base + 'category', label: 'ジャンル', required: true, itemId: id,
      hint: 'ジャンルは「ジャンル」の欄で追加・名前の変更・並べ替えができます。',
      input: categorySelect
    }));

    body.appendChild(makeField({
      key: base + 'url', label: 'リンク先URL', itemId: id,
      hint: '公開する場合は https:// または http:// で始まるURLが必要です。',
      input: textInput(w, 'url', base + 'url', { type: 'url', inputMode: 'url', placeholder: 'https://', noSpell: true, autocomplete: 'off', lazyTouch: true })
    }));

    body.appendChild(makeField({
      key: base + 'description', label: '説明（任意）', itemId: id,
      hint: '空欄なら説明は表示しません。',
      input: textInput(w, 'description', base + 'description', { multiline: true })
    }));

    labelInput = textInput(w, 'buttonLabel', base + 'buttonLabel');
    var labelField = makeField({
      key: base + 'buttonLabel', label: 'ボタンの文言（任意）', itemId: id,
      hint: ' ',
      input: labelInput
    });
    var labelHint = labelField.querySelector('.hint');
    body.appendChild(labelField);

    // ジャンルの追加・名前変更・並べ替えに合わせて、選択肢と既定のボタン文言を更新する
    var lastSignature = null;
    function syncCategory() {
      var cats = state.data.categories;
      var signature = JSON.stringify(cats.map(function (c) { return [c.id, c.label]; }));
      if (signature !== lastSignature) {
        lastSignature = signature;
        categorySelect.textContent = '';
        if (!S.findCategory(state.data, w.category)) {
          var none = h('option', null, '（選んでください）');
          none.value = '';
          categorySelect.appendChild(none);
        }
        cats.forEach(function (c) {
          var o = h('option', null, c.label.trim() || '（見出し未入力）');
          o.value = c.id;
          categorySelect.appendChild(o);
        });
        categorySelect.value = S.findCategory(state.data, w.category) ? w.category : '';
      }
      var fallback = S.defaultButtonLabel(S.findCategory(state.data, w.category));
      labelInput.placeholder = fallback;
      labelHint.textContent = '空欄なら「' + fallback + '」と表示します（ジャンルの設定）。';
    }
    syncCategory.node = body;
    headUpdaters.push(syncCategory);
    syncCategory();

    body.appendChild(imageField({
      key: base + 'image',
      label: '画像（任意）',
      hint: 'アイコンかスクリーンショットを1枚。PNG・JPEG・WebP、5MBまで。長辺1600pxを超える画像は縮小します。',
      dir: 'assets/works/',
      itemId: id,
      get: function () { return w.image; },
      set: function (v) { w.image = v; }
    }));

    var kindSet = h('fieldset', 'field field-radios');
    kindSet.appendChild(h('legend', 'field-label', '画像の種類'));
    [['icon', 'アイコン（正方形の枠）'], ['screenshot', 'スクリーンショット（横長の枠）']].forEach(function (pair) {
      var lab = h('label', 'radio');
      var r = h('input');
      r.type = 'radio';
      r.name = 'kind-' + w.id;
      r.value = pair[0];
      r.checked = w.imageKind === pair[0];
      r.addEventListener('change', function () {
        if (r.checked) {
          w.imageKind = pair[0];
          changed(base + 'imageKind');
        }
      });
      lab.appendChild(r);
      lab.appendChild(document.createTextNode(pair[1]));
      kindSet.appendChild(lab);
    });
    var kindErr = h('p', 'field-error');
    kindErr.hidden = true;
    kindSet.appendChild(kindErr);
    register(base + 'imageKind', kindSet.querySelector('input'), kindErr, id);
    body.appendChild(kindSet);

    body.appendChild(makeField({
      key: base + 'imageAlt', label: '画像の説明（代替テキスト・任意）', itemId: id,
      hint: '画像が見えない人向けの説明です。空欄なら作品名を使います。',
      input: textInput(w, 'imageAlt', base + 'imageAlt')
    }));

    body.appendChild(checkbox(w, 'visible', base + 'visible', '公開ページに表示する', null, id));
  }

  function renderCategoryFields(c, body) {
    var base = 'categories.' + c.id + '.';
    var id = c.id;
    body.appendChild(makeField({
      key: base + 'label', label: '見出し', required: true, itemId: id,
      hint: '公開ページのセクションの見出しです（例：Webアプリ、グッズ）。',
      input: textInput(c, 'label', base + 'label', { onInput: refreshHeads, lazyTouch: true })
    }));
    body.appendChild(makeField({
      key: base + 'badge', label: '作品カードの小さな表示（任意）', itemId: id,
      hint: '作品カードの名前の下に出る短い文字です（例：Web）。空欄なら表示しません。',
      input: textInput(c, 'badge', base + 'badge', { onInput: refreshHeads })
    }));
    body.appendChild(makeField({
      key: base + 'buttonLabel', label: 'ボタンの既定の文言（任意）', itemId: id,
      hint: '作品ごとのボタンの文言が空欄のときに使います。空欄なら「' + S.defaultButtonLabel(null) + '」と表示します。',
      input: textInput(c, 'buttonLabel', base + 'buttonLabel', { placeholder: S.defaultButtonLabel(null) })
    }));
    body.appendChild(checkbox(c, 'visible', base + 'visible', '公開ページに表示する', null, id));
  }

  function renderLinkFields(l, body) {
    var base = 'links.' + l.id + '.';
    var id = l.id;
    body.appendChild(makeField({
      key: base + 'label', label: '表示名', required: true, itemId: id,
      hint: '公開ページには、アイコンと一緒にこの文字が表示されます。',
      input: textInput(l, 'label', base + 'label', { onInput: refreshHeads, lazyTouch: true })
    }));
    body.appendChild(makeField({
      key: base + 'url', label: 'URL', itemId: id,
      hint: '公開する場合は https:// または http:// で始まるURLが必要です。',
      input: textInput(l, 'url', base + 'url', { type: 'url', inputMode: 'url', placeholder: 'https://', noSpell: true, autocomplete: 'off', lazyTouch: true })
    }));
    var select = h('select', 'input');
    var none = h('option', null, 'なし（リンクのアイコン）');
    none.value = '';
    select.appendChild(none);
    Object.keys(S.ICONS).forEach(function (k) {
      if (k === 'link') return;
      var o = h('option', null, S.ICONS[k].label);
      o.value = k;
      select.appendChild(o);
    });
    var linkOpt = h('option', null, 'リンク');
    linkOpt.value = 'link';
    select.insertBefore(linkOpt, select.children[1]);
    select.value = l.icon;
    select.addEventListener('change', function () {
      l.icon = select.value;
      changed(base + 'icon');
    });
    body.appendChild(makeField({
      key: base + 'icon', label: 'アイコン（任意）', itemId: id,
      hint: '一覧にないサービスは「なし」のままで登録できます。',
      input: select
    }));
    body.appendChild(checkbox(l, 'visible', base + 'visible', '公開ページに表示する', null, id));
  }

  /* ---------- 起動 ---------- */

  function bindToolbar() {
    $('btn-save').addEventListener('click', saveDraft);
    $('btn-export').addEventListener('click', exportFiles);
    $('btn-import').addEventListener('click', function () {
      var input = $('json-input');
      input.value = '';
      input.click();
    });
    $('json-input').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (file) importJsonFile(file);
    });
    $('btn-reload').addEventListener('click', function () {
      if (state.data && !confirm('編集中の内容を、最新の公開データで置き換えます。\n端末内の下書きは「下書きを保存」するまで残ります。よろしいですか？')) return;
      loadPublished();
    });
    $('image-input').addEventListener('change', handleImageInput);

    document.querySelectorAll('.seg').forEach(function (b) {
      b.addEventListener('click', function () { setPreviewWidth(b.dataset.width); });
    });
    if (window.ResizeObserver) new ResizeObserver(layoutPreview).observe($('preview-frame'));
    window.addEventListener('resize', layoutPreview);

    window.addEventListener('message', function (ev) {
      if (ev.origin !== location.origin || ev.source !== $('preview').contentWindow) return;
      if (ev.data && ev.data.type === 'pee-preview-ready') {
        state.previewReady = true;
        sendPreview();
      }
    });

    window.addEventListener('beforeunload', function (ev) {
      if (state.dirty) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });
  }

  function askDraftChoice(draft) {
    return new Promise(function (resolve) {
      var dialog = $('draft-dialog');
      $('draft-dialog-text').textContent = '前回保存した下書き（' + formatTime(new Date(draft.savedAt)) + '）があります。どちらを読み込みますか？';
      function done(choice) {
        dialog.close();
        resolve(choice);
      }
      $('draft-restore').onclick = function () { done('draft'); };
      $('draft-published').onclick = function () { done('published'); };
      // Escキーで閉じず、必ずどちらかを選んでもらう
      dialog.addEventListener('cancel', function (ev) { ev.preventDefault(); });
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
        $('draft-restore').focus();
      } else {
        resolve(confirm('前回保存した下書きがあります。下書きを復元しますか？\n（キャンセルで最新の公開データを読み込みます）') ? 'draft' : 'published');
      }
    });
  }

  async function start() {
    bindToolbar();
    layoutPreview();
    var draft = readDraft();
    if (draft && draft.broken) {
      setStatus('端末内の下書きが壊れているため使えません。公開データを読み込みます。', 'error');
      return loadPublished();
    }
    if (draft) {
      var choice = await askDraftChoice(draft);
      if (choice === 'draft') return restoreDraft(draft);
      await loadPublished();
      setStatus('最新の公開データを読み込みました。端末内の下書きは、「下書きを保存」するまで残ります。', 'info');
      return;
    }
    return loadPublished();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
