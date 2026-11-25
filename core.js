/*
 * core.js — 清掃お仕事アプリの決まりごと（誰が何を見られて、何ができるか）
 *
 * 同じファイルを 2 か所で使います。
 *   - GAS（Apps Script）: そのまま「Core.gs」として貼り付ける。本番のサーバー側。
 *   - ブラウザ: index.html から読み込む。試作モードでは、これがサーバーの代わりに動く。
 *
 * データは表（配列）5 つです。GAS ではスプレッドシートの各シートに対応します。
 *   users : { userId, name, lineName, role:'admin'|'worker', status:'active'|'pending'|'inactive', createdAt,
 *             wage:時給, transport:1回あたりの交通費, taxType:'kou'|'otsu'|'none' }
 *   stmts : { id:'yyyy-MM_userId', month, userId, name, days, minutes, wage, base, transport, tax, net,
 *             status:'sent'|'held', hold:理由, lines:JSON, createdAt, sentAt }   ← 支払明細（月末締め・当月払い）
 *   jobs  : { id, date:'yyyy-MM-dd', place, guestIn:'HH:mm'|'' , assignee:userId|'' }
 *           ← 「入る」を押した人が、その場で担当に決まる（早い者勝ち）。キャンセルもその場で募集中に戻る。
 *   cards : { jobId, userId, start, end, supplyOk, supplyNote, lost, lostPlace, lostPhoto,
 *             damage, damageNote, damagePhoto }          ← タイムカード 兼 清掃報告
 *   reqs  : { id, type:'fix', jobId, userId, start:'HH:mm', end:'HH:mm', at, status:'open'|'done'|'rejected' }
 *
 * 時刻はすべてミリ秒（数値）。日付の計算は日本時間（+09:00）です。
 */
var Core = (function () {
  var WD = '日月火水木金土';
  var DAY = 86400000;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function addDays(s, n) {
    var a = s.split('-').map(Number);
    var t = new Date(Date.UTC(a[0], a[1] - 1, a[2] + n));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  function nextMonth(ym) {
    var a = ym.split('-').map(Number);
    return a[1] === 12 ? (a[0] + 1) + '-01' : a[0] + '-' + pad(a[1] + 1);
  }
  function prevMonth(ym) {
    var a = ym.split('-').map(Number);
    return a[1] === 1 ? (a[0] - 1) + '-12' : a[0] + '-' + pad(a[1] - 1);
  }
  function md(s) {
    var a = s.split('-').map(Number);
    var w = new Date(Date.UTC(a[0], a[1] - 1, a[2])).getUTCDay();
    return a[1] + '/' + a[2] + '（' + WD[w] + '）';
  }
  function jst(ms) { return new Date(ms + 9 * 3600000); }
  function hm(ms) { var d = jst(ms); return d.getUTCHours() + ':' + pad(d.getUTCMinutes()); }
  function hhmm(ms) { var d = jst(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function dateOf(ms) { var d = jst(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function at(date, t) { return Date.parse(date + 'T' + t + ':00+09:00'); }
  function minutes(c) { return c && c.start && c.end ? Math.max(0, Math.round((c.end - c.start) / 60000)) : 0; }
  function dur(min) { var h = Math.floor(min / 60), m = min % 60; return h ? h + '時間' + (m ? m + '分' : '') : m + '分'; }

  function yen(n) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円'; }
  function ymLabel(ym) { var a = ym.split('-').map(Number); return a[0] + '年' + a[1] + '月'; }
  function lastDay(ym) { return addDays(nextMonth(ym) + '-01', -1); }

  function fail(msg) { var e = new Error(msg); e.userMessage = msg; throw e; }
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 300); }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function isTime(s) { return /^\d{2}:\d{2}$/.test(s); }
  function link(ctx) { return ctx.liffUrl ? '\n' + ctx.liffUrl : ''; }

  function userOf(db, id) { return db.users.find(function (u) { return u.userId === id; }); }
  function nameOf(db, id) { var u = userOf(db, id); return u ? (u.name || u.lineName) : '（不明）'; }
  function jobOf(db, id) { return db.jobs.find(function (j) { return j.id === id; }) || fail('お仕事が見つかりません。画面を開き直してください。'); }
  function cardOf(db, jobId) { return db.cards.find(function (c) { return c.jobId === jobId; }); }
  function admins(db) { return db.users.filter(function (u) { return u.role === 'admin' && u.status === 'active'; }); }
  function touch(db) { for (var i = 1; i < arguments.length; i++) db.dirty[arguments[i]] = true; }
  function cardView(c) { return c ? { start: c.start, end: c.end || null } : null; }

  /* 見る人によって、お仕事 1 件の見え方を変える（ここが個人情報の線引き） */
  function jobFor(db, me, j) {
    var c = cardOf(db, j.id);
    if (me.role === 'admin') {
      return {
        id: j.id, date: j.date, place: j.place, guestIn: j.guestIn || '',
        assignee: j.assignee ? { id: j.assignee, name: nameOf(db, j.assignee) } : null,
        card: cardView(c)
      };
    }
    // ワーカー：自分の担当だけ中身が見える。ほかの人の担当は「埋まり」としか分からない。
    if (j.assignee === me.userId) {
      return { id: j.id, date: j.date, state: 'mine', place: j.place, guestIn: j.guestIn || '', card: cardView(c) };
    }
    if (j.assignee) return { id: j.id, date: j.date, state: 'filled' };
    return { id: j.id, date: j.date, state: 'open', place: j.place };
  }

  /* 募集中に戻った日を、ほかのワーカーみんなに知らせる */
  function announceOpen(db, j, except, ctx, out) {
    db.users.filter(function (u) { return u.status === 'active' && u.role === 'worker' && u.userId !== except; })
      .forEach(function (u) { out.notify.push({ to: u.userId, text: '入れる人を探しています\n' + md(j.date) + ' ' + j.place + '\n先に「入る」を押した人に決まります。' + link(ctx) }); });
  }

  function report(db, j, c) {
    var lines = [
      '清掃が終わりました',
      md(j.date) + ' ' + j.place,
      nameOf(db, c.userId) + 'さん ' + hm(c.start) + '〜' + hm(c.end) + '（' + dur(minutes(c)) + '）',
      '備品：' + (c.supplyOk ? '足りている' : '足りない → ' + c.supplyNote),
      '忘れ物：' + (c.lost ? 'あり（' + c.lostPlace + '）' : 'なし'),
      '壊れ・汚れ：' + (c.damage ? 'あり' + (c.damageNote ? '（' + c.damageNote + '）' : '') : 'なし')
    ];
    [c.lostPhoto, c.damagePhoto].forEach(function (u) { if (u && /^https?:/.test(u)) lines.push('写真：' + u); });
    return lines.join('\n');
  }

  /* ---------- 支払明細（月末締め・当月払い） ---------- */
  var TAX_LABEL = { kou: '甲欄', otsu: '乙欄', none: 'なし' };

  // その月の勤務から、支払額を計算する。送れない理由があれば hold に入る。
  function computeStmt(db, u, month, taxOverride) {
    var lines = [], running = false;
    db.cards.forEach(function (c) {
      if (c.userId !== u.userId) return;
      var j = db.jobs.find(function (x) { return x.id === c.jobId; });
      if (!j || j.date.slice(0, 7) !== month) return;
      if (!c.end) { running = true; return; }
      lines.push({ date: j.date, place: j.place, start: c.start, end: c.end, min: minutes(c) });
    });
    lines.sort(function (a, b) { return a.start - b.start; });
    var fixPending = db.reqs.some(function (r) {
      if (r.status !== 'open' || r.userId !== u.userId) return false;
      var j = db.jobs.find(function (x) { return x.id === r.jobId; });
      return j && j.date.slice(0, 7) === month;
    });
    var min = lines.reduce(function (s, l) { return s + l.min; }, 0);
    var wage = Number(u.wage) || 0, per = Number(u.transport) || 0, taxType = u.taxType || 'kou';
    var base = Math.round(min * wage / 60);          // 1 円未満は四捨五入
    var transport = lines.length * per;               // 交通費は非課税として扱う
    var tax;
    if (taxOverride !== undefined && taxOverride !== null && taxOverride !== '') tax = Math.max(0, Math.floor(Number(taxOverride) || 0));
    else if (taxType === 'none') tax = 0;
    else if (taxType === 'otsu') tax = Math.floor(base * 0.03063);
    else tax = base < 88000 ? 0 : null;               // 甲欄：88,000 円未満は 0 円。それ以上は表で決めるので人が入れる
    var hold = [];
    if (!wage) hold.push('時給が入っていません');
    if (running) hold.push('送信されていない清掃があります');
    if (fixPending) hold.push('時刻の修正が未処理です');
    if (tax === null) hold.push('支給額が 88,000 円以上なので、源泉所得税の額を入れてください');
    return { id: month + '_' + u.userId, month: month, userId: u.userId, name: u.name || u.lineName, days: lines.length, minutes: min,
      wage: wage, base: base, transportPer: per, transport: transport, taxType: taxType, tax: tax || 0,
      net: base + transport - (tax || 0), payDate: lastDay(month), lines: lines, hold: hold };
  }
  function saveStmt(db, s, status, ctx) {
    db.stmts = db.stmts.filter(function (x) { return x.id !== s.id; });
    db.stmts.push({ id: s.id, month: s.month, userId: s.userId, name: s.name, days: s.days, minutes: s.minutes, wage: s.wage,
      base: s.base, transport: s.transport, tax: s.tax, net: s.net, status: status, hold: s.hold.join(' / '),
      lines: JSON.stringify(s.lines), createdAt: ctx.now, sentAt: status === 'sent' ? ctx.now : null });
    touch(db, 'stmts');
  }
  function viewStmt(st) {
    var lines = st.lines; if (typeof lines === 'string') { try { lines = JSON.parse(lines || '[]'); } catch (e) { lines = []; } }
    return { id: st.id, month: st.month, userId: st.userId, name: st.name, days: Number(st.days), minutes: Number(st.minutes),
      wage: Number(st.wage), base: Number(st.base), transport: Number(st.transport), tax: Number(st.tax), net: Number(st.net),
      payDate: lastDay(st.month), status: st.status, hold: st.hold || '', lines: lines || [], sentAt: st.sentAt || null };
  }
  function stmtText(s) {
    return [ymLabel(s.month) + '分の支払明細です',
      '勤務 ' + s.days + '回・' + dur(s.minutes),
      '時給 ' + yen(s.wage) + ' × ' + dur(s.minutes) + ' = ' + yen(s.base),
      s.transport ? '交通費 ' + s.days + '回分 = ' + yen(s.transport) : '',
      '源泉所得税 −' + yen(s.tax),
      'お振り込み額 ' + yen(s.net),
      md(s.payDate) + 'にお振り込みします。',
      'くわしくはアプリの「勤務時間」で見られます。'].filter(Boolean).join('\n');
  }
  function payList(month, sent, held) {
    var t = [ymLabel(month) + '分の振込一覧（月末締め・当月払い）'];
    sent.forEach(function (s) { t.push(s.name + 'さん　' + yen(s.net)); });
    if (sent.length) t.push('合計　' + yen(sent.reduce(function (a, s) { return a + s.net; }, 0)));
    if (held.length) {
      t.push('', 'まだ送っていない明細（アプリの「支払」で確認してください）：');
      held.forEach(function (s) { t.push(s.name + 'さん：' + s.hold.join('、')); });
    }
    return t.join('\n');
  }
  // 月を締める。送れる人には明細を送り、管理者には振込一覧を送る。
  function closeMonth(db, ctx, month, out) {
    var sent = [], held = [];
    db.users.filter(function (u) { return u.status === 'active' && u.role === 'worker'; }).forEach(function (u) {
      var prev = db.stmts.find(function (x) { return x.id === month + '_' + u.userId; });
      if (prev && prev.status === 'sent') return;
      var s = computeStmt(db, u, month);
      if (!s.days && !s.hold.length) return;
      if (s.hold.length) { saveStmt(db, s, 'held', ctx); held.push(s); return; }
      saveStmt(db, s, 'sent', ctx); sent.push(s);
      out.notify.push({ to: u.userId, text: stmtText(s) + link(ctx) });
    });
    if (sent.length || held.length) out.notify.push({ to: 'admins', text: payList(month, sent, held) + link(ctx) });
    return { sent: sent.length, held: held.length };
  }

  /* ---------- ワーカー（と管理者）ができること ---------- */
  var WORKER = {
    bootstrap: function (db, me, p, ctx) {
      var month = /^\d{4}-\d{2}$/.test(p.month) ? p.month : ctx.today.slice(0, 7);
      var from = month + '-01' < ctx.today ? month + '-01' : ctx.today;
      var monthEnd = addDays(nextMonth(month) + '-01', -1);
      var horizon = addDays(ctx.today, 60);
      var to = monthEnd > horizon ? monthEnd : horizon;
      var isAdmin = me.role === 'admin';
      var jobs = db.jobs
        .filter(function (j) { return j.date >= from && j.date <= to; })
        .filter(function (j) { return isAdmin || j.date >= ctx.today || j.assignee === me.userId; })
        .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
        .map(function (j) { return jobFor(db, me, j); });
      var data = { me: pubMe(me), today: ctx.today, month: month, jobs: jobs };

      if (!isAdmin) {
        var running = db.cards.find(function (c) { return c.userId === me.userId && c.start && !c.end; });
        var mine = db.jobs.filter(function (j) { return j.assignee === me.userId && j.date === ctx.today; });
        var tj = running ? jobOf(db, running.jobId)
          : (mine.find(function (j) { var c = cardOf(db, j.id); return !c || !c.end; }) || mine[0]);
        data.todayJob = tj ? jobFor(db, me, tj) : null;
        var thisMonth = ctx.today.slice(0, 7);
        data.monthMinutes = db.cards.filter(function (c) {
          if (c.userId !== me.userId) return false;
          var j = db.jobs.find(function (x) { return x.id === c.jobId; });
          return j && j.date.slice(0, 7) === thisMonth;
        }).reduce(function (s, c) { return s + minutes(c); }, 0);
        return data;
      }

      data.workers = db.users.filter(function (u) { return u.status === 'active' && u.role === 'worker'; })
        .map(function (u) { return { id: u.userId, name: u.name || u.lineName }; });
      data.pending = db.users.filter(function (u) { return u.status === 'pending'; })
        .map(function (u) { return { id: u.userId, lineName: u.lineName }; });
      data.fixes = db.reqs.filter(function (r) { return r.status === 'open'; }).map(function (r) {
        var j = db.jobs.find(function (x) { return x.id === r.jobId; }) || { date: '', place: '' };
        var c = cardOf(db, r.jobId);
        return { id: r.id, date: j.date, place: j.place, name: nameOf(db, r.userId),
          was: c && c.end ? hm(c.start) + '〜' + hm(c.end) : '', start: r.start, end: r.end };
      });
      data.todayJobs = db.jobs.filter(function (j) { return j.date === ctx.today; }).map(function (j) {
        var c = cardOf(db, j.id);
        return { id: j.id, place: j.place, name: j.assignee ? nameOf(db, j.assignee) : null,
          state: !j.assignee ? 'none' : !c ? 'notyet' : !c.end ? 'working' : 'done',
          start: c ? c.start : null, end: c ? c.end || null : null };
      });
      return data;
    },

    /* 「入る」：押した瞬間にその人の担当に決まる。先に押した人が勝ち（サーバーで順番に処理する） */
    take: function (db, me, p, ctx) {
      var j = jobOf(db, p.jobId);
      if (j.date < ctx.today) fail('過ぎた日には入れません。');
      if (j.assignee === me.userId) return;
      if (j.assignee) fail('ひと足先に、ほかの人に決まりました。');
      j.assignee = me.userId; touch(db, 'jobs');
    },

    /* キャンセル：前日まで。その場で募集中に戻す。管理者には「お知らせ」だけ届き、ほかのワーカーに募集が届く */
    cancel: function (db, me, p, ctx, out) {
      var j = jobOf(db, p.jobId);
      if (j.assignee !== me.userId) fail('あなたの担当ではありません。');
      if (j.date <= ctx.today) fail('アプリでのキャンセルは前日までです。当日はオーナーに直接連絡してください。');
      if (cardOf(db, j.id)) fail('もう清掃を始めています。');
      j.assignee = ''; touch(db, 'jobs');
      var reason = str(p.reason, 200);
      out.notify.push({ to: 'admins', text: nameOf(db, me.userId) + 'さんが ' + md(j.date) + ' ' + j.place + ' をキャンセルしました' +
        (reason ? '\n理由：' + reason : '') + '\n募集中に戻して、ほかのワーカーに知らせました。' });
      announceOpen(db, j, me.userId, ctx, out);
    },

    start: function (db, me, p, ctx) {
      var j = jobOf(db, p.jobId);
      if (j.assignee !== me.userId) fail('あなたの担当ではありません。');
      if (j.date !== ctx.today) fail('お仕事の日になったら始められます。');
      if (cardOf(db, j.id)) fail('もう始めています。');
      if (db.cards.some(function (c) { return c.userId === me.userId && !c.end; })) fail('ほかの清掃がまだ送信されていません。');
      db.cards.push({ jobId: j.id, userId: me.userId, start: ctx.now, end: null, supplyOk: '', supplyNote: '',
        lost: '', lostPlace: '', lostPhoto: '', damage: '', damageNote: '', damagePhoto: '' });
      touch(db, 'cards');
      return { start: ctx.now };
    },

    undoStart: function (db, me, p, ctx) {
      var c = cardOf(db, p.jobId);
      if (!c || c.userId !== me.userId || c.end) fail('取り消せません。');
      if (ctx.now - c.start > 30 * 60000) fail('30分以上たっているので取り消せません。送信したあと「時刻がちがう」から直してください。');
      db.cards = db.cards.filter(function (x) { return x !== c; }); touch(db, 'cards');
    },

    finish: function (db, me, p, ctx, out) {
      var j = jobOf(db, p.jobId), c = cardOf(db, j.id);
      if (!c || c.userId !== me.userId) fail('まだ始めていません。');
      if (c.end) fail('もう送信してあります。');
      if (typeof p.supplyOk !== 'boolean' || typeof p.lost !== 'boolean' || typeof p.damage !== 'boolean') fail('答えていない質問があります。');
      if (!p.supplyOk && !str(p.supplyNote)) fail('足りないものを書いてください。');
      if (p.lost && (!p.lostPhoto || !str(p.lostPlace))) fail('忘れ物の写真と、置いた場所を入れてください。');
      if (p.damage && !p.damagePhoto) fail('壊れている所の写真を入れてください。');
      c.end = ctx.now;
      c.supplyOk = p.supplyOk; c.supplyNote = p.supplyOk ? '' : str(p.supplyNote);
      c.lost = p.lost; c.lostPlace = p.lost ? str(p.lostPlace) : ''; c.lostPhoto = p.lost ? p.lostPhoto : '';
      c.damage = p.damage; c.damageNote = p.damage ? str(p.damageNote) : ''; c.damagePhoto = p.damage ? p.damagePhoto : '';
      touch(db, 'cards');
      out.notify.push({ to: 'admins', text: report(db, j, c) });
      return { start: c.start, end: c.end };
    },

    timesheet: function (db, me, p, ctx) {
      var month = /^\d{4}-\d{2}$/.test(p.month) ? p.month : ctx.today.slice(0, 7);
      var rows = db.cards.map(function (c) {
        var j = db.jobs.find(function (x) { return x.id === c.jobId; });
        if (!j || j.date.slice(0, 7) !== month) return null;
        if (me.role !== 'admin' && c.userId !== me.userId) return null;
        return {
          jobId: j.id, date: j.date, place: j.place, userId: c.userId, name: nameOf(db, c.userId),
          start: c.start, end: c.end || null, min: minutes(c),
          supplyOk: c.supplyOk, supplyNote: c.supplyNote, lost: c.lost, lostPlace: c.lostPlace, lostPhoto: c.lostPhoto,
          damage: c.damage, damageNote: c.damageNote, damagePhoto: c.damagePhoto,
          fixPending: db.reqs.some(function (r) { return r.jobId === j.id && r.status === 'open'; })
        };
      }).filter(Boolean).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start; });
      return { month: month, rows: rows, total: rows.reduce(function (s, r) { return s + r.min; }, 0) };
    },

    myStatements: function (db, me) {
      return { list: db.stmts.filter(function (s) { return s.userId === me.userId && s.status === 'sent'; })
        .map(viewStmt).sort(function (a, b) { return a.month < b.month ? 1 : -1; }) };
    },

    requestFix: function (db, me, p, ctx, out) {
      var j = jobOf(db, p.jobId), c = cardOf(db, j.id);
      if (!c || c.userId !== me.userId || !c.end) fail('送信したあとに直せます。');
      if (!isTime(p.start) || !isTime(p.end)) fail('時刻を入れてください。');
      db.reqs.forEach(function (r) { if (r.jobId === j.id && r.status === 'open') r.status = 'rejected'; });
      db.reqs.push({ id: 'R' + ctx.now.toString(36), type: 'fix', jobId: j.id, userId: me.userId, start: p.start, end: p.end, at: ctx.now, status: 'open' });
      touch(db, 'reqs');
      out.notify.push({ to: 'admins', text: nameOf(db, me.userId) + 'さんから、時刻を直してほしいと申し出がありました\n' + md(j.date) + ' ' + j.place +
        '\n記録：' + hm(c.start) + '〜' + hm(c.end) + '\n本当は：' + p.start + '〜' + p.end + link(ctx) });
    }
  };

  /* ---------- 管理者（内側の 2 人）だけができること ---------- */
  var ADMIN = {
    addJob: function (db, me, p, ctx, out) {
      if (!isDate(p.date)) fail('日付を入れてください。');
      if (p.date < ctx.today) fail('過ぎた日には追加できません。');
      var place = str(p.place, 60); if (!place) fail('物件を入れてください。');
      var guestIn = str(p.guestIn, 5); if (guestIn && !isTime(guestIn)) fail('お客様の到着時刻の形が正しくありません。');
      var j = { id: 'J' + ctx.now.toString(36) + Math.floor(Math.random() * 1296).toString(36), date: p.date, place: place, guestIn: guestIn, assignee: '' };
      db.jobs.push(j); touch(db, 'jobs');
      if (p.announce) announceOpen(db, j, null, ctx, out);
    },

    deleteJob: function (db, me, p, ctx, out) {
      var j = jobOf(db, p.jobId);
      if (cardOf(db, j.id)) fail('タイムカードがあるお仕事は消せません。');
      if (j.assignee) out.notify.push({ to: j.assignee, text: md(j.date) + ' ' + j.place + ' のお仕事はなくなりました。' });
      db.jobs = db.jobs.filter(function (x) { return x !== j; });
      touch(db, 'jobs');
    },

    assign: function (db, me, p, ctx, out) {
      var j = jobOf(db, p.jobId), u = userOf(db, p.userId);
      if (!u || u.status !== 'active' || u.role !== 'worker') fail('その人には頼めません。');
      if (cardOf(db, j.id)) fail('もう清掃が始まっています。');
      if (j.assignee === u.userId) return;
      var prev = j.assignee;
      j.assignee = u.userId; touch(db, 'jobs');
      out.notify.push({ to: u.userId, text: 'お仕事が決まりました\n' + md(j.date) + ' ' + j.place + link(ctx) });
      if (prev && prev !== u.userId) out.notify.push({ to: prev, text: md(j.date) + ' ' + j.place + ' は、ほかの人が担当することになりました。' });
    },

    unassign: function (db, me, p, ctx, out) {
      var j = jobOf(db, p.jobId);
      if (cardOf(db, j.id)) fail('もう清掃が始まっています。');
      if (!j.assignee) return;
      var prev = j.assignee;
      out.notify.push({ to: prev, text: md(j.date) + ' ' + j.place + ' の担当から外れました。' });
      j.assignee = ''; touch(db, 'jobs');
      if (p.announce && j.date >= ctx.today) announceOpen(db, j, prev, ctx, out);
    },

    resolveFix: function (db, me, p, ctx, out) {
      var r = db.reqs.find(function (x) { return x.id === p.id && x.status === 'open'; });
      if (!r) return;
      var j = jobOf(db, r.jobId), c = cardOf(db, r.jobId);
      if (p.approve && c) {
        c.start = at(j.date, r.start); c.end = at(j.date, r.end);
        if (c.end <= c.start) c.end += DAY;
        r.status = 'done'; touch(db, 'cards', 'reqs');
        out.notify.push({ to: r.userId, text: md(j.date) + ' の時刻を ' + r.start + '〜' + r.end + ' に直しました。' });
      } else {
        r.status = 'rejected'; touch(db, 'reqs');
        out.notify.push({ to: r.userId, text: md(j.date) + ' の時刻は、記録のままにしました。くわしくはオーナーから連絡します。' });
      }
    },

    registerUser: function (db, me, p, ctx, out) {
      var u = userOf(db, p.userId);
      if (!u || u.status !== 'pending') return;
      var name = str(p.name, 30); if (!name) fail('名前を入れてください。');
      var wage = Math.floor(Number(p.wage) || 0); if (wage <= 0) fail('時給を入れてください。');
      u.name = name; u.role = 'worker'; u.status = 'active'; u.wage = wage;
      if (u.transport === '' || u.transport == null) u.transport = 0;
      if (!u.taxType) u.taxType = 'kou';
      touch(db, 'users');
      out.notify.push({ to: u.userId, text: name + 'さん、登録が終わりました。募集中の日に「入れる」を出してください。' + link(ctx) });
    },

    rejectUser: function (db, me, p) {
      var u = userOf(db, p.userId);
      if (!u || u.status !== 'pending') return;
      u.status = 'inactive'; touch(db, 'users');
    },

    /* 時給・交通費・源泉の区分を変える */
    setWorker: function (db, me, p) {
      var u = userOf(db, p.userId);
      if (!u || u.role !== 'worker') fail('その人は見つかりません。');
      var wage = Math.floor(Number(p.wage) || 0); if (wage <= 0) fail('時給を入れてください。');
      if (!TAX_LABEL[p.taxType]) fail('源泉の区分を選んでください。');
      u.wage = wage; u.transport = Math.max(0, Math.floor(Number(p.transport) || 0)); u.taxType = p.taxType;
      touch(db, 'users');
    },

    /* 支払の画面：その月の明細（送った・止まっている・まだ締めていない） */
    payroll: function (db, me, p, ctx) {
      var month = /^\d{4}-\d{2}$/.test(p.month) ? p.month : ctx.today.slice(0, 7);
      var rows = db.stmts.filter(function (s) { return s.month === month; }).map(viewStmt);
      db.users.filter(function (u) { return u.status === 'active' && u.role === 'worker'; }).forEach(function (u) {
        if (rows.some(function (r) { return r.userId === u.userId; })) return;
        var s = computeStmt(db, u, month);
        if (!s.days && !s.hold.length) return;
        s.status = 'open'; s.hold = s.hold.join(' / '); rows.push(s);
      });
      rows.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      return {
        month: month, closeDate: lastDay(month), rows: rows,
        totalSent: rows.filter(function (r) { return r.status === 'sent'; }).reduce(function (a, r) { return a + r.net; }, 0),
        workers: db.users.filter(function (u) { return u.status === 'active' && u.role === 'worker'; }).map(function (u) {
          return { id: u.userId, name: u.name || u.lineName, wage: Number(u.wage) || 0, transport: Number(u.transport) || 0, taxType: u.taxType || 'kou' };
        })
      };
    },

    /* 月末を待たずに、今すぐ締めて送る（月末の自動が動かなかったとき用） */
    closeNow: function (db, me, p, ctx, out) {
      var month = /^\d{4}-\d{2}$/.test(p.month) ? p.month : ctx.today.slice(0, 7);
      if (month > ctx.today.slice(0, 7)) fail('まだ来ていない月は締められません。');
      return closeMonth(db, ctx, month, out);
    },

    /* 止まっていた 1 人分を、直したあとで送る（源泉の額を入れる場合もここ） */
    stmtSend: function (db, me, p, ctx, out) {
      var u = userOf(db, p.userId); if (!u) fail('その人は見つかりません。');
      var month = p.month;
      var prev = db.stmts.find(function (x) { return x.id === month + '_' + u.userId; });
      if (prev && prev.status === 'sent') fail('この明細は、もう送ってあります。');
      var s = computeStmt(db, u, month, p.tax);
      if (s.hold.length) fail(s.hold.join('、') + '。');
      saveStmt(db, s, 'sent', ctx);
      out.notify.push({ to: u.userId, text: stmtText(s) + link(ctx) });
      out.notify.push({ to: 'admins', text: ymLabel(month) + '分の明細を送りました\n' + s.name + 'さん　' + yen(s.net) + '\nお振り込みをお願いします。' });
    }
  };

  function pubMe(u) { return { userId: u.userId, name: u.name || u.lineName, lineName: u.lineName, role: u.role, status: u.status }; }

  function handle(db, auth, action, p, ctx) {
    var out = { data: null, notify: [] };
    db.dirty = db.dirty || {};
    var me = userOf(db, auth.userId);
    if (!me) {
      me = { userId: auth.userId, name: '', lineName: auth.name || '', role: 'worker', status: 'pending', createdAt: ctx.now,
        wage: '', transport: 0, taxType: 'kou' };
      db.users.push(me); touch(db, 'users');
      out.notify.push({ to: 'admins', text: '新しい人がアプリを開きました：' + me.lineName + '\nアプリで登録してください。' + link(ctx) });
    } else if (auth.name && me.lineName !== auth.name) {
      me.lineName = auth.name; touch(db, 'users');
    }
    if (me.status !== 'active') {
      if (action !== 'bootstrap') fail('まだ登録されていません。オーナーの確認をお待ちください。');
      out.data = { me: pubMe(me) };
      return out;
    }
    var h = WORKER[action] || (me.role === 'admin' ? ADMIN[action] : null);
    if (!h) fail('この操作はできません。');
    out.data = h(db, me, p || {}, ctx, out) || {};
    return out;
  }

  /* 朝 8 時：その日の担当者へ。INがある日は、エアコンと電気のお願いを入れる */
  function morning(db, ctx) {
    return db.jobs.filter(function (j) { return j.date === ctx.today && j.assignee; }).map(function (j) {
      return { to: j.assignee, text: 'おはようございます。今日は「' + j.place + '」のお仕事です。' +
        (j.guestIn ? '\n今日は ' + j.guestIn + ' にお客様が来るので、帰る前にエアコンと電気をつけておいてください。' : '') + link(ctx) };
    });
  }

  /* 夕方 6 時：送信がない清掃を、本人と管理者へ */
  function evening(db, ctx) {
    var late = db.jobs.filter(function (j) {
      if (j.date !== ctx.today || !j.assignee) return false;
      var c = cardOf(db, j.id); return !c || !c.end;
    });
    var n = late.map(function (j) {
      return { to: j.assignee, text: '今日の「' + j.place + '」の送信がまだです。終わっていたら、アプリで「完了して送信」を押してください。' + link(ctx) };
    });
    if (late.length) n.push({ to: 'admins', text: 'まだ送信がない清掃：\n' + late.map(function (j) { return j.place + '（' + nameOf(db, j.assignee) + 'さん）'; }).join('\n') });
    return n;
  }

  /* 毎晩（トリガー）：今日が月末なら、その月を締めて明細を送る */
  function monthEnd(db, ctx) {
    var out = { notify: [] };
    db.dirty = db.dirty || {};
    if (addDays(ctx.today, 1).slice(8) === '01') closeMonth(db, ctx, ctx.today.slice(0, 7), out);
    return out.notify;
  }

  /* 通知の宛先 'admins' を、実際の userId の一覧に広げる */
  function recipients(db, to) { return to === 'admins' ? admins(db).map(function (u) { return u.userId; }) : [to]; }

  return {
    handle: handle, morning: morning, evening: evening, monthEnd: monthEnd, recipients: recipients,
    util: { addDays: addDays, nextMonth: nextMonth, prevMonth: prevMonth, md: md, hm: hm, hhmm: hhmm, dateOf: dateOf, at: at, dur: dur, minutes: minutes,
      yen: yen, ymLabel: ymLabel, TAX_LABEL: TAX_LABEL }
  };
})();
