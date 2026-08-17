/* Deckula! v1.2.2 — чистый игровой движок (без DOM, Node-совместимый).
 * Интерпретирует декларативные RULES + ops из cards.js.
 * Состояние = стейт-машин с pending-выборами (без async/Promise).
 */
(function (root) {
  'use strict';

  // ---------- Детерминированный PRNG (mulberry32) ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ---------- Утилиты состояния ----------
  function makeInstance(def) {
    return { def, id: def.id, attachments: [], under: [], tokens: 0, empty: false, flags: {} };
  }

  function inPlay(game) { return game.home.concat(game.threat); }

  // Пытошная (id 29) в игре (не пустая) — даёт «Да, господин» платить 1⚡ вместо сброса
  function pytoshnayaInPlay(game) {
    return inPlay(game).some(c => c.def.id === 29 && !c.empty);
  }

  function findInPlay(game, id) {
    return inPlay(game).find(c => c.def.id === id);
  }

  // рекурсивный поиск карты (включая вложения .under и .attachments) по home+threat
  function findAnywhere(game, id) {
    const walk = (list) => {
      for (const c of list) {
        if (c.def.id === id) return c;
        const r = walk(c.under) || walk(c.attachments);
        if (r) return r;
      }
      return null;
    };
    return walk(game.home.concat(game.threat));
  }

  // поиск для скоринга: карта в игре, включая прикреплённые (карта 46 → 5/31/37)
  function findInPlayInclAttach(game, id) {
    return findAnywhere(game, id);
  }

  function isVisitor(def) { return !!def.visitor; }

  // Числовое значение очков карты (единственное поле vp: number | {scaled:N} | {end:true})
  function vpValue(def) {
    const v = def.vp;
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') return ('scaled' in v) ? v.scaled : 0;
    return 0;
  }

  // Есть ли у карты красный символ ПО (в т.ч. 2★ и X-печать)
  function hasRedSeal(def) {
    const v = def.vp;
    if (typeof v === 'number') return v !== 0;
    if (v && typeof v === 'object') return ('scaled' in v) ? v.scaled !== 0 : ('end' in v);
    return false;
  }

  // Настоящие посетители в Зоне Угрозы (для Дом, милый дом / поражения):
  // без Дом, милый дом, без threatExempt, без вложения «Ужин подан» (id 38)
  function threatVisitors(game) {
    return game.threat.filter(c =>
      !c.empty &&
      c.def.visitor &&
      !c.def.threatExempt &&
      !c.attachments.some(a => a.def.id === 38));
  }

  // Счёт посетителей в Зоне Угрозы с учётом weight (для Дом, милый дом)
  function threatCount(game) {
    let n = 0;
    for (const c of threatVisitors(game)) n += (c.def.threatWeight || 1);
    return n;
  }

  function buyCost(game) {
    let cost = root.CARD_META.BUY_COST;
    for (const c of game.threat) if (c.def.buyCostMod) cost = c.def.buyCostMod;
    return cost;
  }

  // Сумма ПО карт "в игре" (не-empty)
  function baseScore(game) {
    let s = 0;
    for (const c of inPlay(game)) if (!c.empty) s += vpValue(c.def) + (c.vpBonus || 0);
    return s;
  }

  function log(game, msg) { game.log.push(msg); }

  // вклад в итоговый счёт с привязкой к карте-источнику (для разбивки на экране победы)
  function pushScoreLog(game, source, value) {
    game._scoreLog = game._scoreLog || [];
    game._scoreLog.push({ source: source != null ? source : null, value });
  }

  // ---------- Слой логирования (единый источник формулировок) ----------
  // Все русские строки лога формируются только здесь; ops вызывают строго
  // типизированные методы. Вывод — строки в game.log (для совместимости с UI).
  function turnTag(game) {
    return (game.turn === 0) ? '[Подготовка] ' : '[Ход ' + game.turn + '] ';
  }

  const Logger = {
    _push(game, msg) { log(game, turnTag(game) + msg); },

    energy(game, value) { this._push(game, (value >= 0 ? '+' : '') + value + ' энергии'); },
    defeat(game, reasonText) { this._push(game, 'Поражение! ' + (reasonText || '')); },

    draw(game, card) { this._push(game, 'Открыта: ' + card.def.name); },
    enter(game, card, zone) { this._push(game, (zone === 'threat' ? 'В Зоне Угрозы: ' : 'В Доме: ') + card.def.name); },
    buy(game, card, cost) { this._push(game, 'Куплено: ' + card.def.name + ' (−' + cost + '⚡)'); },
    discardCard(game, card, src) { this._push(game, (src ? src + ': сброшена ' : 'Сброшена ') + card.def.name); },
    kill(game, card) { this._push(game, 'Убит ' + card.def.name); },
    shield(game, card) { this._push(game, card.def.name + ' поглотила убийство жетоном'); },
    buduar(game, card, bud) { this._push(game, card.def.name + ' захвачен Будуаром (под ' + bud.def.name + ')'); },
    buduarRelease(game, card, bud) { this._push(game, card.def.name + ' освобождён из Будуара (реплей)'); },
    bury(game, card, under) { this._push(game, card.def.name + ' под ' + under.def.name); },
    becameEmpty(game, name) { this._push(game, name + ' стала Пустой'); },
    becameEmptyMulti(game, n) { this._push(game, n + ' карт(ы) стали Пустыми'); },
    attach(game, card, target) { this._push(game, card.def.name + ' наложена на ' + target.def.name); },
    skip(game, label) { this._push(game, 'Пропущено: ' + label); },

    armedDiscard(game, self) { this._push(game, self.def.name + ' сброшена для активации эффекта'); },
    recall(game, card) { this._push(game, 'Возвращена из сброса: ' + card.def.name); },
    addVisitors(game, n) { this._push(game, 'Замешаны посетители: ' + n); },
    hoard(game, card) { this._push(game, 'Коллекционер спрятал ' + card.def.name); },
    hoardFlush(game) { this._push(game, 'Коллекционер сброшен со спрятанным'); },
    shuffleBack(game, card) { this._push(game, card.def.name + ' замещена в колоду'); },
    peek(game, n) { this._push(game, 'Посмотрено карт: ' + n); },
    payShuffle(game, ids) { this._push(game, 'Уголки и закоулки: замещено посетителей — ' + ids); },
    paySkip(game) { this._push(game, 'Уголки и закоулки: пропущено'); },
    compete(game, name) { this._push(game, 'Выбран эффект: ' + name); },
    activate(game, id) { this._push(game, 'Активирован эффект СБРОС: ' + (root.CARD_BY_ID[id] ? root.CARD_BY_ID[id].name : id)); },
    autoApplied(game, names) { this._push(game, 'Авто-применён эффект СБРОС: ' + names.join(', ')); },
    skipTurnStart(game) { this._push(game, 'Этап начала хода пропущен (нет активных эффектов)'); },
    memoir(game, detail) { this._push(game, 'Сентиментальные мемуары: ' + detail); },
    setup(game, pickName, drawn, discarded) { this._push(game, 'Подготовка: открыто [' + drawn + '], выбрана ' + pickName + ', сброшено [' + discarded + ']'); },
    win(game, score) { this._push(game, 'Победа! Очки: ' + score); },
    scoreKill(game, card) { this._push(game, card.def.name + ' +1 ПО за убийство'); },
  };

  // сброс карты для активации её СБРОС-эффекта (повторяющийся паттерн во многих ops)
  function armedDiscardSelf(game, self) {
    if (!self || game._armedActivate !== self.def.id) return false;
    removeFrom(game, self); game.discard.push(self); Logger.armedDiscard(game, self);
    return true;
  }

  // разбивка очков по картам: base = vp + vpBonus, bonus = вклады score-ops по source
  function scoreBreakdown(game) {
    const byId = new Map();
    const ensure = id => { if (!byId.has(id)) byId.set(id, { id: id, base: 0, bonus: 0 }); return byId.get(id); };
    for (const c of inPlay(game)) {
      if (c.empty) continue;
      const b = vpValue(c.def) + (c.vpBonus || 0);
      if (b !== 0) ensure(c.def.id).base += b;
    }
    for (const e of (game._scoreLog || [])) {
      if (e.source == null) continue;
      ensure(e.source).bonus += e.value;
    }
    return Array.from(byId.values())
      .map(r => ({ id: r.id, def: root.CARD_BY_ID[r.id], points: r.base + r.bonus, base: r.base, bonus: r.bonus }))
      .filter(r => r.def && r.points !== 0)
      .sort((a, b) => b.points - a.points);
  }

  // изменение энергии с клампом [0, MAX_ENERGY] (нет лимита накопления по умолчанию, если MAX не задан)
  function addEnergy(game, delta) {
    const max = root.CARD_META.MAX_ENERGY != null ? root.CARD_META.MAX_ENERGY : Infinity;
    game.energy = Math.max(0, Math.min(max, game.energy + delta));
  }

  // ---------- Авто-пропуск / авто-активация начала хода ----------
  // Бесплатные заведомо полезные СБРОС-эффекты, активируемые автоматически
  // без запроса игрока (no downside, приносят пользу самим фактом применения).
  const AUTO_TURNSTART = new Set([42]); // Коллекционер (бесплатный заведомо полезный); 13 убрана (ручной выбор пира)

  // глубокая копия изменяемых зон (def НЕ копируем; rng -> детерминированный стаб,
  // чтобы зонд не сдвигал реальный PRNG и не влиял на будущие открытия)
  function cloneGame(g) {
    const c = {};
    c.deck = g.deck.map(cloneInst);
    c.discard = g.discard.map(cloneInst);
    c.home = g.home.map(cloneInst);
    c.threat = g.threat.map(cloneInst);
    c.supply = g.supply.map(cloneInst);
    c.log = g.log.slice();
    c._scoreLog = (g._scoreLog || []).slice();
    c._scoreAdd = g._scoreAdd || 0;
    c.energy = g.energy;
    c.setAside = (g.setAside || []).map(cloneInst);
    c._kills = g._kills || 0;
    c._killScore = g._killScore || 0;
    c._portraitUsed = !!g._portraitUsed;
    c.rng = function () { return 0; };
    c._armedActivate = null;
    c._resumeStack = [];
    c.pending = null;
    c._pendingOp = null; c._pendingSelf = null; c._pendingSource = null;
    c._pendingCard2 = null; c._pendingBudget = null; c._pendingDiscardSrc = null;
    c._skipVisitorEffects = false; c._freeNext = null; c._freeIfDrawn = null; c._autoPlayIfDrawn = null;
    return c;
  }
  function cloneInst(inst) {
    const c = Object.assign({}, inst);
    c.def = inst.def;
    c.attachments = inst.attachments.map(cloneInst);
    c.under = inst.under.map(cloneInst);
    c.flags = Object.assign({}, inst.flags || {});
    return c;
  }

  // сигнатурный снимок состояния с исключением карты inst (чтобы сам сброс карты
  // не считался «полезным» изменением)
  function sigExcl(g, inst) {
    const ser = z => z.filter(c => c !== inst).map(c => c.def.id);
    return JSON.stringify({
      e: g.energy,
      d: ser(g.deck), di: ser(g.discard), h: ser(g.home), t: ser(g.threat), s: ser(g.supply),
      l: g.log.length, sa: g._scoreAdd || 0,
      u: g.home.concat(g.threat).filter(c => c !== inst).map(c => c.under.map(x => x.def.id)),
      a: g.home.concat(g.threat).filter(c => c !== inst).map(c => c.attachments.map(x => x.def.id)),
    });
  }

  // неразрушающе проверяет: даст ли активация СБРОС-эффекта sourceId что-то,
  // кроме сброса самой карты. true = «живой» (полезный) эффект.
  function probeArmed(game, sourceId) {
    const inst = game.home.concat(game.threat).find(c => c.def.id === sourceId);
    if (!inst) return false;
    const clone = cloneGame(game);
    const cloneInst = clone.home.concat(clone.threat).find(c => c.def.id === sourceId);
    if (!cloneInst) return false;
    clone._armedActivate = sourceId;
    const all = (root.RULES || []).concat(root.GAME_RULES || []);
    const rule = all.find(r => r.event === 'turnStart' && r.source === sourceId &&
      findInPlay(clone, r.source) &&
      (!r.where || matchWhere(clone, r.where, { source: r.source })));
    if (!rule) return false;
    runOps(clone, rule.do, rule.source, undefined);
    clone._armedActivate = null;
    if (clone.pending) return true; // появился выбор с реальными целями
    const before = sigExcl(game, inst);
    const after = sigExcl(clone, cloneInst);
    return before !== after; // иное изменение состояния (кроме сброса самой карты)
  }

  // авто-резолв безобидных pending-выборов для AUTO_TURNSTART-эффектов
  function autoResolveTurnStartPending(game) {
    const k = game.pending && game.pending.kind;
      if (k === 'banshee') {
      const opts = game.pending.options.filter(o => o !== 'no');
      const sel = opts.length ? opts[0] : 'no';
      if (sel !== 'no') {
        const v = game.threat.find(c => c.def.id === sel);
        if (v) killOne(game, v);
        const self = game.home.concat(game.threat).find(c => c.def.id === 4);
        if (self) { removeFrom(game, self); game.deck.push(self); }
        for (const vis of redirectToAbsorber(game, game.threat.filter(c => c.def.visitor).slice())) { removeFrom(game, vis); game.deck.push(vis); }
        shuffle(game.deck, game.rng);
      }
      game.pending = null;
      continueResume(game);
      } else if (k === 'beastFeast') {
        const self = game.home.concat(game.threat).find(c => c.def.id === game._pendingSource);
        const all = redirectToAbsorber(game, game.threat.filter(c => c.def.visitor).slice());
        for (const v of all) killOne(game, v, self ? self.def.id : null);
        game._pendingSource = null; game.pending = null;
        continueResume(game);
    }
  }

  // активировать СБРОС-эффект sourceId автоматически (без экрана выбора)
  function runAutoActivate(game, sourceId) {
    const all = (root.RULES || []).concat(root.GAME_RULES || []);
    const rule = all.find(r => r.event === 'turnStart' && r.source === sourceId &&
      findInPlay(game, r.source) &&
      (!r.where || matchWhere(game, r.where, { source: r.source })));
    if (!rule) return;
    game._armedActivate = sourceId;
    const halted = runOps(game, rule.do, rule.source, undefined);
    game._armedActivate = null;
    if (halted && game.pending) autoResolveTurnStartPending(game);
    else continueResume(game);
  }

  // ---------- Подготовка ----------
  function createGame(opts) {
    opts = opts || {};
    const seed = opts.seed != null ? opts.seed : 12345;
    const rng = mulberry32(seed);
    const difficulty = opts.difficulty || 'easy';

    const CARDS = root.CARDS, DIFF = root.DIFFICULTY, RULES = root.RULES;
    if (!CARDS) throw new Error('cards.js не загружен');

    // ограничение пула карт (проверка/тренировка на подмножестве)
    const cardPool = (opts.allowedIds && opts.allowedIds.length)
      ? CARDS.filter(c => opts.allowedIds.indexOf(c.id) !== -1)
      : CARDS;
    const allowedVisitorIds = new Set(cardPool.filter(c => c.visitor).map(c => c.id));

    // отложить посетителей + Дом, милый дом
    const setAside = cardPool.filter(c => c.visitor || c.id === 20).map(makeInstance);
    const visitorDefs = cardPool.filter(c => c.visitor);
    const diff = DIFF[difficulty] || DIFF.easy;

    // выбрать посетителей для замеса по сложности
    const chosenVisitorIds = [];
    const pool = visitorDefs.slice();
    shuffle(pool, rng);
    let p = 0;
    for (const v of diff.visitors) {
      if (v == null || !allowedVisitorIds.has(v)) { // случайный из доступных
        while (p < pool.length && chosenVisitorIds.indexOf(pool[p].id) !== -1) p++;
        if (p < pool.length) chosenVisitorIds.push(pool[p++].id);
      } else {
        chosenVisitorIds.push(v);
      }
    }

    const chosenVisitors = setAside.filter(c => chosenVisitorIds.indexOf(c.def.id) !== -1);
    const supply = setAside.filter(c => chosenVisitorIds.indexOf(c.def.id) === -1 && c.def.id !== 20);

    // остальные карты в колоду
    let deck = cardPool.filter(c => !c.visitor && c.id !== 20).map(makeInstance);
    shuffle(deck, rng);

    // открыть N (PREP.openings), выбрать 1 бесплатно в Дом
    const openingsCount = (root.PREP && root.PREP.openings) || 3;
    const openings = [];
    for (let k = 0; k < openingsCount && deck.length; k++) openings.push(deck.pop());
    const pick = opts.setupPick != null ? opts.setupPick : 0;
    const home0 = openings[pick];
    const discards0 = openings.filter((_, i) => i !== pick);
    const home = [home0];
    const discard = discards0;

    // замешиваем Дом, милый дом + выбранных посетителей
    const toShuffle = [setAside.find(c => c.def.id === 20)].concat(chosenVisitors);
    shuffle(toShuffle, rng);
    deck = deck.concat(toShuffle);
    shuffle(deck, rng);

    const game = {
      deck, discard, home, threat: [], supply, setAside: [],
      _kills: 0, _killScore: 0, _portraitUsed: false,
      energy: 0,
      turn: 0, status: 'playing', phase: 'start',
      pending: null, seed, rng, log: [],
      pendingCard: null, _resumeStack: [], difficulty,
      _scoreLog: [],
      _armedTurnStart: null, _armedActivate: null,
    };
    // базовые правила подготовки (GAME_RULES: старт энергии и т.п.)
    Logger.setup(game, home0.def.name, openings.map(o => o.def.name).join(', '), discards0.map(o => o.def.name).join(', '));
    fireEvent(game, 'setup');
    // эффекты входа стартовой карты (как при обычном разыгрывании)
    fireEnter(game, home0);
    return game;
  }

  // ---------- Интерпретатор правил ----------
  function rulesFor(event, game, sourceId, pre) {
    const all = (root.RULES || []).concat(root.GAME_RULES || []);
    return all.filter(r => r.event === event &&
      (sourceId == null || r.source === sourceId) &&
      (r.source == null || findInPlay(game, r.source)) &&
      (!!r.pre === !!pre));
  }

  function matchWhere(game, where, ctx) {
    if (!where) return true;
    if (where.inPlay && !where.inPlay.every(id => findInPlay(game, id))) return false;
    if (where.inPlayAny && !where.inPlayAny.some(id => findInPlay(game, id))) return false;
    if (where.threatCount) {
      const n = threatCount(game);
      if (where.threatCount['>='] != null && !(n >= where.threatCount['>='])) return false;
    }
    if (where.selfUnderEmpty) {
      const self = ctx.source ? game.home.concat(game.threat).find(c => c.def.id === ctx.source) : null;
      if (!(self && self.under.length === 0)) return false;
    }
    if (where.visitorInPlay !== undefined) {
      const has = game.threat.length > 0;
      if (where.visitorInPlay !== has) return false;
    }
    if (where.selfInPlay !== undefined) {
      const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
      if (where.selfInPlay !== !!self) return false;
    }
    return true;
  }

  // выполнить список ops; возвращает true если остановились на pending
  function runOps(game, ops, source, triggering, ctxExtra, startIdx) {
    const ctx = Object.assign({ source, triggering }, ctxExtra || {});
    for (let i = startIdx || 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.when && !matchWhere(game, op.when, ctx)) continue;
      const halted = executeOp(game, op, ctx);
      if (halted) {
        game._resumeStack.push({ ops, i: i + 1, source, triggering, ctxExtra });
        return true;
      }
    }
    return false;
  }

  // продолжить все сохранённые контексты возобновления (стек), пока не встретится новый pending
  function continueResume(game) {
    while (game._resumeStack.length && !game.pending) {
      const r = game._resumeStack.pop();
      const halted = runOps(game, r.ops, r.source, r.triggering, r.ctxExtra, r.i);
      if (halted) return true; // новый pending на вершине стека — ждём
    }
    return false;
  }

  // запуск правил события
  function fireEvent(game, event, opts) {
    opts = opts || {};
    const pre = !!opts.pre;
    const trig = opts.triggering;
    const rules = rulesFor(event, game, opts.sourceId, pre);
    // отфильтровать по where (как раньше)
    const matched = rules.filter(r => {
      if (r.where && !matchWhere(game, r.where, { source: r.source, triggering: trig })) return false;
      // карта не триггерит собственное visitorRevealed при своём появлении
      // (стандартная семантика «входит в игру»: эффект срабатывает на других посетителей)
      if (event === 'visitorRevealed' && trig && r.source != null && trig.def && trig.def.id === r.source) return false;
      return true;
    });

    // turnStart / gameEnd всегда срабатывают полностью (без выбора "один из")
    const competeExcluded = (event === 'turnStart' || event === 'gameEnd');
    if (!competeExcluded) {
      const mandatory = matched.filter(r => !r.discretionary);
      const competing = matched.filter(r => r.discretionary);
      // сначала обязательные эффекты
      for (const r of mandatory) {
        const halted = runOps(game, r.do, r.source, trig);
        if (halted) return true;
      }
      // если дискреционных несколько — игрок выбирает ровно один, остальные пропадают
      if (competing.length > 1) {
        setPending(game, 'competeEffect', competing.map(r => r.source), 'Выберите один эффект (остальные пропадают)');
        game._competeRules = competing;
        game._competeTriggering = trig;
        return true;
      }
      // 0 или 1 дискреционных — запускаем их
      for (const r of competing) {
        const halted = runOps(game, r.do, r.source, trig);
        if (halted) return true;
      }
      return false;
    }

    // turnStart: возобновляемая очередь правил — последующие НЕ "голодают",
    // когда более раннее правило ставит pending (ждём выбор, затем продолжаем)
    if (event === 'turnStart') {
      game._tsQueue = matched;
      game._tsIdx = 0;
      return runTurnStart(game);
    }
    // gameEnd и прочие competeExcluded: останавливаемся на первом halted
    for (const r of matched) {
      const halted = runOps(game, r.do, r.source, trig);
      if (halted) return true;
    }
    return false;
  }

  // выполнить очередь turnStart-правил, продолжая с game._tsIdx после pending
  function runTurnStart(game) {
    const q = game._tsQueue;
    if (!q) return false;
    while (game._tsIdx < q.length) {
      const r = q[game._tsIdx];
      const halted = runOps(game, r.do, r.source, undefined);
      if (halted) { game._tsIdx++; return true; }
      game._tsIdx++;
    }
    return false;
  }

  // ---------- Ops ----------
  function setPending(game, kind, options, label) {
    game.pending = { kind, options, label };
  }

  function executeOp(game, op, ctx) {
    const O = OPS;
    switch (op.op) {
      case 'energy': {
        addEnergy(game, op.value);
        Logger.energy(game, op.value);
        return false;
      }
      case 'loseGame': {
        if (op.when && !matchWhere(game, op.when, ctx)) return false;
        game.status = 'lost';
        game.lossReason = op.reason || 'rule';
        game.lossCards = [];
        if (op.capture === 'threat') {
          for (const c of threatVisitors(game)) game.lossCards.push(c);
        }
        Logger.defeat(game, op.reasonText);
        return false;
      }
      case 'win': {
        endGame(game);
        return false;
      }
      case 'killVisitor': {
        let count = op.count || 1;
        if (op.target === 'all') {
        const all = redirectToAbsorber(game, killableVisitors(game));
          for (const v of all) killOne(game, v, op.under);
          return false;
        }
        // выбор посетителя
        const targets = redirectToAbsorber(game, killableVisitors(game));
        if (targets.length === 0) return false;
        const self = (ctx.source != null)
          ? game.home.concat(game.threat).find(c => c.def.id === ctx.source)
          : null;
        if (op.discardSelf) {
          if (!self) return false;
          // Пытошная (29): «Да, господин» (50) — заплатить 1⚡ вместо сброса
          if (ctx.source === 50 && pytoshnayaInPlay(game) && game.energy >= 1) {
            const srcName = root.CARD_BY_ID[50] ? root.CARD_BY_ID[50].name : 'Карта';
            setPending(game, 'payKeepSelf',
              ['pay', 'discard', 'no'],
              srcName + ': заплатить 1⚡, чтобы оставить карту в игре, или сбросить её?');
            game._pendingOp = op; game._pendingSelf = self; return true;
          }
          if (game._freePlay) {
            // бесплатное «разыгрывание»: карта сразу уходит в сброс, далее — выбор цели
            removeFrom(game, self); game.discard.push(self); Logger.armedDiscard(game, self);
          } else if (armedDiscardSelf(game, self)) {
            // далее — выбор цели
          } else {
            const options = targets.map(c => c.def.id).concat(['no']);
            const srcName = (ctx.source != null && root.CARD_BY_ID[ctx.source]) ? root.CARD_BY_ID[ctx.source].name : 'Карта';
            setPending(game, 'killVisitor', options, srcName + ': сбросить, чтобы убить посетителя?');
            game._pendingOp = op; game._pendingSelf = self; return true;
          }
        }
        if (targets.length === 1 && count === 1) { killOne(game, targets[0], op.under); return false; }
        setPending(game, 'killVisitor', targets.map(c => c.def.id), 'Убить посетителя');
        game._pendingOp = op;
        return true;
      }
      case 'addVisitors': {
        if (op.discardSelf) {
          const self = (ctx.source != null)
            ? game.home.concat(game.threat).find(c => c.def.id === ctx.source)
            : null;
          if (!self) return false;
          if (armedDiscardSelf(game, self)) {
            const n = op.n || 1;
            for (let k = 0; k < n; k++) {
              if (game.supply.length === 0) break;
              const idx = Math.floor(game.rng() * game.supply.length);
              const v = game.supply.splice(idx, 1)[0];
              game.deck.push(v);
            }
            Logger.addVisitors(game, n);
            return false;
          }
          const srcName = (ctx.source != null && root.CARD_BY_ID[ctx.source]) ? root.CARD_BY_ID[ctx.source].name : 'Карта';
          setPending(game, 'addVisitors', ['yes', 'no'], srcName + ': сбросить, чтобы заместить Посетителя в колоду?');
          game._pendingOp = op; game._pendingSelf = self; return true;
        }
        const n = op.n || 1;
        for (let k = 0; k < n; k++) {
          if (game.supply.length === 0) break;
          const idx = Math.floor(game.rng() * game.supply.length);
          const v = game.supply.splice(idx, 1)[0];
          game.deck.push(v);
        }
        Logger.addVisitors(game, n);
        return false;
      }
      case 'returnVisitorBottom': {
        const self = (ctx.source != null)
          ? game.home.concat(game.threat).find(c => c.def.id === ctx.source)
          : null;
        const targets = redirectToAbsorber(game, inPlay(game).filter(c => c.def.visitor && !c.empty));
        if (op.discardSelf) {
          if (!self || targets.length === 0) return false;
          if (armedDiscardSelf(game, self)) {
            if (targets.length === 1) { moveToBottom(game, targets[0]); return false; }
            setPending(game, 'returnVisitorBottom', targets.map(c => c.def.id), 'Вернуть под низ колоды');
            game._pendingOp = op; return true;
          }
          const options = targets.map(c => c.def.id).concat(['no']);
          setPending(game, 'returnVisitorBottom', options, 'Зеркальный зал: сбросить, чтобы вернуть посетителя под низ');
          game._pendingOp = op; game._pendingSelf = self; return true;
        }
        if (targets.length === 0) return false;
        if (targets.length === 1) { moveToBottom(game, targets[0]); return false; }
        setPending(game, 'returnVisitorBottom', targets.map(c => c.def.id), 'Вернуть под низ колоды');
        game._pendingOp = op; return true;
      }
      case 'payToShuffleVisitors': {
        const targets = redirectToAbsorber(game, game.threat.filter(c => c.def.visitor));
        const max = Math.min(op.range[1], targets.length, game.energy);
        if (max < op.range[0]) return false;
        game._pendingBudget = max;
        setPending(game, 'payToShuffleVisitors', targets.map(c => c.def.id),
          'Уголки и закоулки: выберите посетителей для замещения (каждый — 1⚡, доступно ' + max + ')');
        game._pendingOp = op; return true;
      }
      case 'beastFeast': {
        const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
        const beast = self && self.attachments.some(a => a.def.id === 40);
        if (beast) {
          const required = (findAnywhere(game, 12) || self.under.some(x => x.def.id === 12)) ? 2 : 3;
          if (threatCount(game) >= required) {
            setPending(game, 'beastFeast', ['yes', 'no'], 'Логово людоеда: убить всех и захоронить?');
            game._pendingOp = op; game._pendingSource = ctx.source; return true;
          }
        }
        return false;
      }
      case 'moveUnder': {
        const card = findInPlay(game, op.card);
        if (!card) return false;
        const target = findAnywhere(game, op.target);
        if (!target) return false;
        removeFrom(game, card);
        target.under.push(card);
        Logger.bury(game, card, target);
        return false;
      }
      case 'beast': {
        const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
        if (!self) return false;
        const lair = findInPlay(game, 13);
        if (lair) {
          removeFrom(game, self); lair.attachments.push(self); Logger.attach(game, self, lair);
          return false;
        }
        // ветка «Пир» переинтерпретирована (§3.5): 40 не сбрасывает 12+себя и не убивает
        // посетителя самостоятельно; без Логова Зверь просто сбрасывается
        removeFrom(game, self); game.discard.push(self);
        return false;
      }
      case 'buryUnder': {
        const card = findAnywhere(game, op.card);
        if (!card) return false;
        const v = ctx.triggering;
        if (!v) return false;
        // убрать из зоны, положить под card
        removeFrom(game, v);
         card.under.push(v);
         if (op.skipEffects) { v.flags.buried45 = true; }
         Logger.bury(game, v, card);
         return false;
      }
      case 'hoardUnder': {
        const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
        if (!self) return false;
        // взять карту из колоды под себя
        if (game.deck.length) {
          const c = game.deck.pop();
          self.under.push(c);
          Logger.hoard(game, c);
        }
        if (self.under.length >= (op.max || 3)) {
          for (const c of self.under) game.discard.push(c);
          self.under = [];
          Logger.hoardFlush(game);
        }
        return false;
      }
      case 'takeFromUnder': {
        const card = findInPlay(game, op.card);
        if (!card || card.under.length === 0) return false;
        if (op.discardSelf) {
          const self = (ctx.source != null)
            ? game.home.concat(game.threat).find(c => c.def.id === ctx.source)
            : null;
          if (!self) return false;
          const srcName = (ctx.source != null && root.CARD_BY_ID[ctx.source]) ? root.CARD_BY_ID[ctx.source].name : 'Карта';
          setPending(game, 'takeFromUnder', ['discard', 'underExpo'], srcName + ': сбросить, чтобы забрать карту из-под ' + card.def.name + '?');
          game._pendingCard2 = card; game._pendingOp = op; game._pendingSelf = self; return true;
        }
        setPending(game, 'takeFromUnder', ['discard', 'underExpo'], 'Забрать карту из-под ' + card.def.name);
        game._pendingCard2 = card; game._pendingOp = op; return true;
      }
      case 'discardHome': {
        const match = op.match || 'any';
        const srcName = (ctx.source != null && root.CARD_BY_ID[ctx.source]) ? root.CARD_BY_ID[ctx.source].name : '';
        let pool = game.home.filter(c => !c.empty);
        if (ctx.source != null) pool = pool.filter(c => !(c.def.immuneTo && c.def.immuneTo.indexOf(ctx.source) !== -1) && !c.attachments.some(a => a.def.immuneTo && a.def.immuneTo.indexOf(ctx.source) !== -1));
        if (match === 'hasVP') pool = pool.filter(c => hasRedSeal(c.def));
        else if (match === 'noVP') pool = pool.filter(c => !hasRedSeal(c.def));
        if (pool.length === 0) return false;
        if (op.target === 'choice' && pool.length > 1) {
          setPending(game, 'discardHome', pool.map(c => c.def.id), 'Сбросить карту Дома');
          game._pendingOp = op; game._pendingDiscardSrc = srcName; return true;
        }
        const c = pool[0];
        removeFrom(game, c); game.discard.push(c);
        Logger.discardCard(game, c, srcName);
        return false;
      }
      case 'discardSelf': {
        const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
        if (self) { removeFrom(game, self); game.discard.push(self); Logger.discardCard(game, self, ''); }
        return false;
      }
      case 'recallDiscard': {
        if (game.discard.length === 0) return false;
        if (op.discardSelf) {
          const self = (ctx.source != null)
            ? game.home.concat(game.threat).find(c => c.def.id === ctx.source)
            : null;
          if (!self) return false;
          if (armedDiscardSelf(game, self)) {
            const opts = game.discard.filter(c => c !== self).map(c => c.def.id);
            setPending(game, 'recallDiscard', opts, 'Вернуть из сброса и разыграть');
            game._pendingOp = op; return true;
          }
          const options = game.discard.map(c => c.def.id).concat(['no']);
          const srcName = (ctx.source != null && root.CARD_BY_ID[ctx.source]) ? root.CARD_BY_ID[ctx.source].name : 'Карта';
          setPending(game, 'recallDiscard', options, srcName + ': сбросить, чтобы вернуть карту из сброса?');
          game._pendingOp = op; game._pendingSelf = self; return true;
        }
        setPending(game, 'recallDiscard', game.discard.map(c => c.def.id), 'Вернуть из сброса и разыграть');
        game._pendingOp = op; return true;
      }
      case 'shuffleBack': {
        let card;
        if (op.target === 'self') card = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
        else card = findInPlay(game, op.target);
        if (!card) return false;
        if (op.discardSelf) {
          const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
          if (!self) return false;
          if (armedDiscardSelf(game, self)) {
            removeFrom(game, card); game.deck.push(card); shuffle(game.deck, game.rng);
            Logger.shuffleBack(game, card);
            return false;
          }
          setPending(game, 'shuffleBack', ['yes', 'no'], 'На шаг впереди: сбросить, чтобы заместить Дом, милый дом');
          game._pendingOp = op; game._pendingSelf = self; return true;
        }
        removeFrom(game, card); game.deck.push(card); shuffle(game.deck, game.rng);
        Logger.shuffleBack(game, card);
        return false;
      }
      case 'attach': {
        const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
        if (!self) return false;
        let target = null;
        if (op.target === 'latestHome') {
          const pool = game.home.filter(c => c !== self);
          target = pool[pool.length - 1];
        } else if (op.target === 'nextVisitor') target = ctx.triggering;
        else if (op.target === 'threatVisitor') {
          const pool = game.threat.filter(c => c !== self && c.def.visitor);
          if (pool.length > 1) { setPending(game, 'attach', pool.map(c => c.def.id), 'Наложить'); game._pendingOp = op; game._pendingSource = ctx.source; return true; }
          target = pool[0];
        } else if (op.target === 'choice') {
          const pool = game.home.filter(c => c !== self);
          if (pool.length > 1) { setPending(game, 'attach', pool.map(c => c.def.id), 'Наложить'); game._pendingOp = op; game._pendingSource = ctx.source; return true; }
          target = pool[0];
        }
        if (target) { removeFrom(game, self); target.attachments.push(self); Logger.attach(game, self, target); if (op.makeEmpty) target.empty = true; if (op.ignoreText) target.flags.ignoreText = true; }
        return false;
      }
      case 'tokenInit': {
        const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
        if (!self) return false;
        self.tokens = (game._kills || 0);
        return false;
      }
      case 'buduarCapture': {
        const bud = findInPlay(game, 24);
        if (!bud) return false;
        const v = ctx.triggering;
        if (!v) return false;
        if ((bud.under.length || 0) === 0) {
          // 1-й посетитель: под Будуар, эффекты подавлены
          removeFrom(game, v);
          bud.under.push(v);
          v.flags.stored = true;
          Logger.buduar(game, v, bud);
          return false;
        }
        // 2-й посетитель: освободить захваченного, сбросить Будуар, реплей
        const captured = bud.under.shift();
        removeFrom(game, bud);
        game.discard.push(bud);
        if (captured) {
          captured.flags.stored = false;
          game.threat.push(captured);
          Logger.buduarRelease(game, captured, bud);
          fireEnter(game, captured); // эффекты как при свежем входе
        }
        return false;
      }
      case 'setEmpty': {
        if (op.target === 'latestHome') {
          const t = game.home[game.home.length - 1];
          if (t) { t.empty = true; Logger.becameEmpty(game, t.def.name); }
        } else if (op.target === 'self') {
          const t = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
          if (t) { t.empty = true; Logger.becameEmpty(game, t.def.name); }
        } else if (op.target === 'rightOfSelf') {
          const self = game.home.concat(game.threat).find(c => c.def.id === ctx.source);
          if (self) {
            const i = game.home.indexOf(self);
            let n = 0;
            for (let k = i + 1; k < game.home.length; k++) {
              const c = game.home[k];
              if (c.def.immuneTo && c.def.immuneTo.indexOf(ctx.source) !== -1) continue;
              if (c.attachments.some(a => a.def.immuneTo && a.def.immuneTo.indexOf(ctx.source) !== -1)) continue;
              c.empty = true; n++;
            }
            if (n) Logger.becameEmptyMulti(game, n);
          }
        }
        return false;
      }
      case 'peek': {
        const n = Math.min(op.n || 4, game.deck.length);
        const top = game.deck.slice(game.deck.length - n);
        const self = (ctx.source != null)
          ? game.home.concat(game.threat).find(c => c.def.id === ctx.source)
          : null;
        if (op.discardSelf) {
          if (!self) return false;
          if (!armedDiscardSelf(game, self)) {
            game._pendingSelf = self; game._pendingOp = op;
          }
        }
        setPending(game, 'peek', top.map(c => c.def.id), 'Посмотреть и вернуть в порядке (сверху)');
        game._pendingN = n; return true;
      }
      case 'freePlaceNext': {
        // помечаем: следующая карта без стрелки -> бесплатно в home (если условие)
        if (op.when && !matchWhere(game, op.when, ctx)) return false;
        game._freeNext = { zone: op.zone || 'home' };
        return false;
      }
      case 'freeIfDrawn': {
        game._freeIfDrawn = game._freeIfDrawn || [];
        game._freeIfDrawn.push(op.id);
        return false;
      }
      case 'autoPlayIfDrawn': {
        game._autoPlayIfDrawn = game._autoPlayIfDrawn || [];
        game._autoPlayIfDrawn.push({ id: op.id, source: op.source });
        return false;
      }
      case 'memoirChoice': {
        const self = game.home.concat(game.threat).find(c => c.def.id === 22);
        if (!self) return false;
        setPending(game, 'memoirChoice', ['discardDraw', 'replay'], 'Сентиментальные мемуары');
        game._pendingOp = op; return true;
      }
      case 'scoreAdd': {
        const v = op.value;
        game._scoreAdd = (game._scoreAdd || 0) + v;
        pushScoreLog(game, ctx.source, v);
        return false;
      }
      case 'scoreIf': {
        if (op.inPlay.every(id => findInPlay(game, id))) {
          const v = op.value;
          game._scoreAdd = (game._scoreAdd || 0) + v;
          pushScoreLog(game, ctx.source, v);
        }
        return false;
      }
      case 'scorePer': {
        const n = op.inPlay.filter(id => findInPlayInclAttach(game, id)).length;
        const v = n * op.value;
        game._scoreAdd = (game._scoreAdd || 0) + v;
        pushScoreLog(game, ctx.source, v);
        return false;
      }
      case 'scoreUnder': {
        const card = findInPlay(game, op.id);
        const n = card ? card.under.length : 0;
        const v = op.base + n;
        game._scoreAdd = (game._scoreAdd || 0) + v;
        pushScoreLog(game, ctx.source, v);
        return false;
      }
      case 'scoreThreat': {
        const n = threatCount(game);
        const v = (n === 0 ? op.empty : n * op.per);
        game._scoreAdd = (game._scoreAdd || 0) + v;
        pushScoreLog(game, ctx.source, v);
        return false;
      }
      case 'discardFromPlay': {
        const list = op.ids || [];
        const pool = inPlay(game).filter(c => list.indexOf(c.def.id) !== -1);
        if (pool.length === 0) return false;
        if (pool.length === 1) { removeFrom(game, pool[0]); game.discard.push(pool[0]); return false; }
        setPending(game, 'discardFromPlay', pool.map(c => c.def.id), 'Сбросить карту из игры');
        game._pendingOp = op; return true;
      }
      case 'banshee': {
        if (killableVisitors(game).length > 0) {
          const opts = redirectToAbsorber(game, killableVisitors(game)).map(c => c.def.id).concat(['no']);
          setPending(game, 'banshee', opts, 'Баньши: убить посетителя (выбор)?');
          game._pendingOp = op; return true;
        }
        return false;
      }
      default:
        console.warn('Неизвестный op: ' + op.op);
        return false;
    }
  }

  const OPS = {}; // заполняется выше через executeOp (ссылка не нужна)

  function killOne(game, v, underId) {
    // щит: поглотить убийство жетоном вместо гибели (Археолог Нюхач, 14)
    if (v.def.shieldTokens && (v.tokens || 0) > 0) {
      v.tokens--;
      Logger.shield(game, v);
      return;
    }
    // Злорадное привидение (16) на жертве: жертва в сброс, призрак в setAside,
    // +1 ПО перманентно (game._killScore)
    const ghost = v.attachments.find(a => a.def.ghost);
    if (ghost) {
      removeFrom(game, ghost);
      game.setAside.push(ghost);
      removeFrom(game, v);
      game.discard.push(v);
      Logger.kill(game, v);
      game._killScore = (game._killScore || 0) + 1;
      pushScoreLog(game, 16, 1);
      game._kills = (game._kills || 0) + 1;
      for (const c of game.home.concat(game.threat)) if (c.def.tokenOnKill) c.tokens = (c.tokens || 0) + 1;
      return;
    }
    removeFrom(game, v);
    if (underId != null) {
      const card = findInPlay(game, underId);
      if (card) { card.under.push(v); Logger.bury(game, v, card); bumpKills(game); return; }
    }
    game.discard.push(v);
    Logger.kill(game, v);
    bumpKills(game);
  }

  // счётчик убийств + жетоны Археолога Нюхача (14)
  function bumpKills(game) {
    game._kills = (game._kills || 0) + 1;
    for (const c of game.home.concat(game.threat)) if (c.def.tokenOnKill) c.tokens = (c.tokens || 0) + 1;
  }

  // посетители, которых можно убить (только настоящие посетители, не Дом, милый дом)
  function killableVisitors(game) {
    return game.threat.filter(c => c.def.visitor && !c.empty);
  }

  // «Сэр Здоровяк» (id 36): поглощает эффекты, направленные на посетителей.
  // Возвращает карту-поглотитель в Зоне Угрозы (в игре — только она) либо null.
  function absorbingVisitor(game) {
    return game.threat.find(c => c.def.absorbVisitorEffects && !c.empty) || null;
  }

  // Перенаправляет список целей-посетителей на поглотителя, если он в игре.
  // Массовые эффекты (по нескольким посетителям) бьют только по нему.
  function redirectToAbsorber(game, base) {
    const a = absorbingVisitor(game);
    return a ? [a] : base;
  }

  function moveToBottom(game, c) {
    removeFrom(game, c);
    game.deck.unshift(c);
  }

   function removeFrom(game, c) {
    for (const z of [game.home, game.threat, game.deck, game.discard, game.supply]) {
      const i = z.indexOf(c); if (i !== -1) { z.splice(i, 1); orphanNested(game, c); return; }
    }
    // ищем в under/attachments (перемещение вложенной карты — вложения остаются с ней)
    for (const card of inPlay(game)) {
      let i = card.under.indexOf(c); if (i !== -1) { card.under.splice(i, 1); return; }
      i = card.attachments.indexOf(c); if (i !== -1) { card.attachments.splice(i, 1); return; }
    }
  }

  // карта ушла из игры верхним уровнем — её похороненные/прикреплённые карты тоже выбывают в сброс
  function orphanNested(game, c) {
    const nested = c.under.concat(c.attachments);
    c.under = []; c.attachments = [];
    for (const n of nested) {
      if (inPlay(game).indexOf(n) !== -1 || game.discard.indexOf(n) !== -1) continue;
      orphanNested(game, n);
      game.discard.push(n);
    }
  }

  // ---------- Обработка выборов ----------
  function resolvePending(game, selection) {
    if (!game.pending) return;
    const kind = game.pending.kind;
    const op = game._pendingOp;
    game.pending = null;

    if (kind === 'killVisitor') {
      if (selection !== 'no') {
        const v = game.threat.find(c => c.def.id === selection);
        if (v) {
          const ghost = v.attachments.find(a => a.def.ghost);
          if (ghost && findInPlay(game, 21) && !game._portraitUsed) {
            // Импозантный портрет (21): перехват 1 раз за игру — переместить призрак на другого
            const others = game.threat.filter(c => c !== v && c.def.visitor && !c.empty && !c.attachments.some(a => a.def.ghost));
            if (others.length > 0) {
              game._pendingGhostVictim = v;
              setPending(game, 'ghostTarget', others.map(c => c.def.id), 'Злорадное привидение: переместить на другого Посетителя?');
              game._pendingOp = op;
              return; // ждём выбор цели
            }
          }
          // Ужасный экспонат (3): выбор захоронения под карту
          if (findInPlay(game, 3)) {
            game._pendingExpoVictim = v;
            setPending(game, 'buryUnderExpo', ['bury', 'discard'], 'Похоронить под Ужасный экспонат или сбросить?');
            game._pendingOp = op;
            return;
          }
          killOne(game, v, op && op.under);
        }
        if (op && op.discardSelf && game._pendingSelf) {
          removeFrom(game, game._pendingSelf);
          game.discard.push(game._pendingSelf);
          game._pendingSelf = null;
        }
      } else {
        Logger.skip(game, 'убийство посетителя');
      }
      game._pendingOp = null;
    } else if (kind === 'buryUnderExpo') {
      const v = game._pendingExpoVictim;
      if (v) {
        if (selection === 'bury') killOne(game, v, 3);
        else killOne(game, v, op && op.under);
      }
      if (op && op.discardSelf && game._pendingSelf) {
        removeFrom(game, game._pendingSelf);
        game.discard.push(game._pendingSelf);
        game._pendingSelf = null;
      }
      game._pendingExpoVictim = null;
      game._pendingOp = null;
    } else if (kind === 'ghostTarget') {
      const victim = game._pendingGhostVictim;
      const ghost = victim ? victim.attachments.find(a => a.def.ghost) : null;
      if (ghost) removeFrom(game, ghost); // отцепить ДО удаления жертвы (иначе orphanNested сбросит)
      // убить жертву (сброс), +1 ПО, призрак переместить на выбранного Посетителя
      removeFrom(game, victim);
      game.discard.push(victim);
      Logger.kill(game, victim);
      game._killScore = (game._killScore || 0) + 1;
      pushScoreLog(game, 16, 1);
      if (ghost) {
        const target = game.threat.find(c => c.def.id === selection);
        if (target) { target.attachments.push(ghost); Logger.attach(game, ghost, target); }
      }
      game._portraitUsed = true;
      if (op && op.discardSelf && game._pendingSelf) {
        removeFrom(game, game._pendingSelf);
        game.discard.push(game._pendingSelf);
        game._pendingSelf = null;
      }
      game._pendingGhostVictim = null;
      game._pendingOp = null;
    } else     if (kind === 'payKeepSelf') {
      const self = game._pendingSelf;
      const targets = redirectToAbsorber(game, killableVisitors(game));
      if (selection === 'pay') {
        addEnergy(game, -1);
        Logger.energy(game, -1);
        game._pendingSelf = null; // карта остаётся в игре
      } else if (selection === 'discard') {
        // _pendingSelf сохраняется — после убийства карта уйдёт в сброс
      } else {
        Logger.skip(game, 'Да, господин (Пытошная)');
        game._pendingSelf = null; game._pendingOp = null;
        return;
      }
      if (targets.length === 1 && (op ? (op.count || 1) : 1) === 1) {
        killOne(game, targets[0], op && op.under);
        if (game._pendingSelf) { removeFrom(game, game._pendingSelf); game.discard.push(game._pendingSelf); game._pendingSelf = null; }
      }
      else { setPending(game, 'killVisitor', targets.map(c => c.def.id), 'Убить посетителя'); game._pendingOp = op; }
    } else if (kind === 'returnVisitorBottom') {
      if (selection !== 'no') {
        const c = inPlay(game).find(x => x.def.id === selection);
        if (c) moveToBottom(game, c);
        if (op && op.discardSelf && game._pendingSelf) {
          removeFrom(game, game._pendingSelf);
          game.discard.push(game._pendingSelf);
          game._pendingSelf = null;
        }
      } else {
        Logger.skip(game, 'возврат посетителя под низ');
      }
    } else if (kind === 'shuffleBack') {
      if (selection !== 'no') {
        const card = findInPlay(game, op ? op.target : null);
        if (card) { removeFrom(game, card); game.deck.push(card); shuffle(game.deck, game.rng); Logger.shuffleBack(game, card); }
        if (op && op.discardSelf && game._pendingSelf) {
          removeFrom(game, game._pendingSelf);
          game.discard.push(game._pendingSelf);
          game._pendingSelf = null;
        }
      }
    } else if (kind === 'payToShuffleVisitors') {
      if (selection !== 'skip' && Array.isArray(selection) && selection.length) {
        const ids = Array.from(new Set(selection)).slice(0, game._pendingBudget);
        if (ids.length) {
          addEnergy(game, -ids.length);
          for (const id of ids) {
            const v = game.threat.find(c => c.def.id === id);
            if (v) { removeFrom(game, v); game.deck.push(v); }
          }
          shuffle(game.deck, game.rng);
          Logger.payShuffle(game, ids.length);
        }
      } else {
        Logger.paySkip(game);
      }
      game._pendingBudget = null;
      } else if (kind === 'beastFeast') {
        if (selection === 'yes') {
          const self = game.home.concat(game.threat).find(c => c.def.id === game._pendingSource);
          const all = redirectToAbsorber(game, game.threat.filter(c => c.def.visitor).slice());
          for (const v of all) killOne(game, v, self ? self.def.id : null);
          if (self) {
            const bi = self.attachments.findIndex(a => a.def.id === 40);
            if (bi !== -1) { const beast = self.attachments.splice(bi, 1)[0]; game.discard.push(beast); Logger.discardCard(game, beast, ''); }
          }
          game._pendingSource = null;
        }
    } else if (kind === 'takeFromUnder') {
      const host = game._pendingCard2;
      if (host && host.under.length > 0) {
        const c = host.under.shift();
        if (selection === 'underExpo') {
          const expo = findInPlay(game, 3);
          if (expo) expo.under.push(c); else game.discard.push(c); // fallback в сброс без Экспоната
        } else {
          game.discard.push(c);
        }
      }
      if (op && op.discardSelf && game._pendingSelf) {
        removeFrom(game, game._pendingSelf);
        game.discard.push(game._pendingSelf);
        game._pendingSelf = null;
      }
      game._pendingCard2 = null;
    } else if (kind === 'discardHome') {
        const c = game.home.find(x => x.def.id === selection);
        if (c) {
          const src = game._pendingDiscardSrc || '';
          removeFrom(game, c); game.discard.push(c);
          Logger.discardCard(game, c, src);
          game._pendingDiscardSrc = null;
        }
      } else if (kind === 'discardFromPlay') {
        const c = inPlay(game).find(x => x.def.id === selection);
        if (c) { removeFrom(game, c); game.discard.push(c); }
      } else if (kind === 'recallDiscard') {
        if (selection !== 'no') {
          const c = game.discard.find(x => x.def.id === selection);
          if (c) { removeFrom(game, c); Logger.recall(game, c); autoPlace(game, c); if (game.pending) game.phase = 'enterPending'; }
          if (op && op.discardSelf && game._pendingSelf) {
            removeFrom(game, game._pendingSelf);
            game.discard.push(game._pendingSelf);
            game._pendingSelf = null;
          }
        }
      } else if (kind === 'addVisitors') {
        if (selection === 'yes') {
          const n = op.n || 1;
          for (let k = 0; k < n; k++) {
            if (game.supply.length === 0) break;
            const idx = Math.floor(game.rng() * game.supply.length);
            const v = game.supply.splice(idx, 1)[0];
            game.deck.push(v);
          }
          Logger.addVisitors(game, n);
        }
        if (op && op.discardSelf && game._pendingSelf) {
          removeFrom(game, game._pendingSelf);
          game.discard.push(game._pendingSelf);
          game._pendingSelf = null;
        }
      } else if (kind === 'attach') {
      const target = game.home.concat(game.threat).find(x => x.def.id === selection);
      const self = game.home.concat(game.threat).find(c => c.def.id === game._pendingSource);
      if (target && self) { removeFrom(game, self); target.attachments.push(self); if (op.makeEmpty) target.empty = true; }
      game._pendingSource = null;
    } else if (kind === 'peek') {
      const n = game._pendingN;
      const order = selection; // массив id сверху вниз
      const newTop = order.map(id => game.deck.find(c => c.def.id === id)).filter(Boolean);
      game.deck = game.deck.slice(0, game.deck.length - n).concat(newTop);
      Logger.peek(game, n);
      game._pendingN = null;
      if (op && op.discardSelf && game._pendingSelf) {
        removeFrom(game, game._pendingSelf);
        game.discard.push(game._pendingSelf);
        game._pendingSelf = null;
      }
      } else if (kind === 'memoirChoice') {
      const self = game.home.concat(game.threat).find(c => c.def.id === 22);
      if (selection === 'discardDraw') {
        Logger.memoir(game, 'сброшены, открыта новая карта');
        if (self) { removeFrom(game, self); game.discard.push(self); }
        const card = game.deck.pop() || null;
        if (card) placeDrawnCard(game, card);
      } else {
        if (self) { removeFrom(game, self); game.discard.push(self); }
        const card = game.deck.pop() || null;
        if (card && card.def.visitor) {
          // Сентиментальные мемуары: немедленно проиграть, если следующая — Посетитель
          game.threat.push(card);
          game.status = 'lost';
          game.lossReason = 'memoir';
          game.lossCards = [card];
          Logger.defeat(game, 'Сентиментальные мемуары: следующая карта — Посетитель');
        } else {
          Logger.memoir(game, 'следующая карта разыграна бесплатно');
          game._freeNext = true;
          if (card) { autoPlace(game, card); if (!game.pending) afterEnter(game); }
        }
      }
      } else if (kind === 'banshee') {
        if (selection !== 'no') {
          const v = game.threat.find(c => c.def.id === selection);
          if (v) killOne(game, v);
          const self = game.home.concat(game.threat).find(c => c.def.id === 4);
          if (self) { removeFrom(game, self); game.deck.push(self); }
          for (const v of redirectToAbsorber(game, game.threat.filter(c => c.def.visitor).slice())) { removeFrom(game, v); game.deck.push(v); }
          shuffle(game.deck, game.rng);
        }
    } else if (kind === 'competeEffect') {
      const src = selection;
      const rules = game._competeRules || [];
      const trig = game._competeTriggering;
      game._competeRules = null; game._competeTriggering = null;
      const rule = rules.find(r => r.source === src);
      if (rule) {
        const nm = (root.CARD_BY_ID[src] ? root.CARD_BY_ID[src].name : src);
        Logger.compete(game, nm);
        const halted = runOps(game, rule.do, rule.source, trig); // остальные competing ПРОПАЛИ
        if (halted) return; // вложенный выбор (цель убийства и т.п.) — ждём
      }
    }
    // продолжить оставшиеся ops
    continueResume(game);
    // после выбора — продолжаем ход (мемуары сами разыгрывают карту)
    if (!game.pending && kind !== 'memoirChoice') step(game);
  }

  // ---------- Вход карты в игру ----------
  // Единая логика размещения взятой карты: стрелка/бесплатно -> autoPlace,
  // иначе выбор Купить/Сбросить. Используется и в doDraw, и в эффектах
  // (Сентиментальные мемуары), чтобы не дублировать поведение открытия.
  // разыграть карту автоматически (стрелка/бесплатно) и продолжить ход
  function autoEnter(game, card) {
    autoPlace(game, card);
    if (game.pending) return;
    afterEnter(game);
  }

  // разыграть открытую карту бесплатно и немедленно (эффект комбо, напр. 35 -> 44 «Голоса!»)
  function autoPlayForFree(game, card, source) {
    const hadVisitors = killableVisitors(game).length > 0;
    game.home.push(card); // карта в игре, чтобы найти её правило эффекта
    const all = (root.RULES || []).concat(root.GAME_RULES || []);
    const rule = all.find(r => r.event === 'turnStart' && r.source === card.def.id &&
      findInPlay(game, r.source) &&
      (!r.where || matchWhere(game, r.where, { source: r.source })));
    game._freePlay = true;
    if (rule) runOps(game, rule.do, rule.source, card);
    game._freePlay = false;
    // «разыгранная» карта уходит в сброс (если эффект ещё не сбросил её сам)
    if (findInPlay(game, card.def.id)) { removeFrom(game, card); game.discard.push(card); Logger.discardCard(game, card, ''); }
    // канон: «Если нет Посетителей — сбросьте обе эти карты»
    if (!hadVisitors) {
      const src = source != null ? findInPlay(game, source) : null;
      if (src) { removeFrom(game, src); game.discard.push(src); Logger.discardCard(game, src, ''); }
    }
    if (game.pending) { game.phase = 'enterPending'; return; }
    afterEnter(game);
  }

  function placeDrawnCard(game, card) {
    const def = card.def;
    Logger.draw(game, card);
    // autoPlayIfDrawn: разыграть открытую карту бесплатно и немедленно (комбо, напр. 35 -> 44)
    if (game._autoPlayIfDrawn) {
      const ap = game._autoPlayIfDrawn.find(e => e.id === def.id);
      if (ap && !hasArrow(def)) {
        const srcInPlay = ap.source == null || findInPlay(game, ap.source);
        if (srcInPlay) { autoPlayForFree(game, card, ap.source); return; }
      }
    }
    if (hasArrow(def) || (game._freeNext && !hasArrow(def)) || (game._freeIfDrawn && game._freeIfDrawn.indexOf(def.id) !== -1)) {
      game._freeNext = null;
      autoEnter(game, card); return;
    }
    // выбор Купить/Сбросить
    offerDraft(game, card);
  }

  function hasArrow(def) { return def.placement === 'threat' || def.placement === 'home'; }

  function fireEnter(game, card) {
    const def = card.def;
    if (isVisitor(def)) {
      // Хорошее вино (2): следующий Посетитель подкладывается под Ужин (38),
      // если 38 уже наложена на другого Посетителя
      if (findInPlay(game, 2) && !card.flags.buried45 && !card.attachments.some(a => a.def.id === 38)) {
        const host = game.home.concat(game.threat).find(c => c.attachments.some(a => a.def.id === 38));
        const dinner = host ? host.attachments.find(a => a.def.id === 38) : null;
        if (dinner) {
          removeFrom(game, card);
          dinner.under.push(card);
          card.flags.wineBuried = true;
          Logger.bury(game, card, dinner);
          checkLoss(game);
          return;
        }
      }
      fireEvent(game, 'visitorRevealed', { triggering: card, pre: true });
      if (game._skipVisitorEffects) { game._skipVisitorEffects = false; return; }
      if (card.flags.stored) { checkLoss(game); return; }
    }
    // enter самой карты (подавлен, если посетитель похоронен картой 45 или подавлен Пламенем)
    if (!card.flags.buried45 && !card.flags.ignoreText) {
      fireEvent(game, 'enter', { sourceId: def.id, triggering: card });
    }
    // реакции на посетителя (energy и т.п.) — сохраняются для похороненных (чужие карты 7/34)
    if (isVisitor(def) && !game._skipVisitorEffects) {
      fireEvent(game, 'visitorRevealed', { triggering: card, pre: false });
    }
    game._skipVisitorEffects = false;
    checkLoss(game);
  }

  function checkLoss(game) {
    fireEvent(game, 'checkThreat');
  }

  // ---------- Ход (единый фазовый step) ----------
  // Фазы: start -> (startPending) -> draw -> (enterPending) | choice -> ... -> start
  function step(game) {
    if (game.status !== 'playing' || game.pending) return;
    switch (game.phase) {
      case 'start': doStart(game); break;
      case 'startPending': continueTurnStartOrDraw(game); break;
      case 'draw': doDraw(game); break;
      case 'enterPending': afterEnter(game); break;
      case 'turnStartArmed': break; // ждём выбора игрока (tap/пропуск)
    }
  }

  function doStart(game) {
    game.turn++;
    game._scoreAdd = 0;
    const armed = computeArmedTurnStart(game).map(c => c.def.id);
    // авто-активация бесплатных заведомо полезных эффектов (до пересчёта живых,
    // т.к. они могут изменить состояние и сделать другие эффекты «мёртвыми»)
    const auto = armed.filter(id => AUTO_TURNSTART.has(id));
    for (const id of auto) {
      if (probeArmed(game, id)) runAutoActivate(game, id);
    }
    // отбросить «мёртвые» (бесполезные прямо сейчас) эффекты СБРОС
    const live = armed.filter(id => !AUTO_TURNSTART.has(id) && probeArmed(game, id));
    game._armedTurnStart = live;
    if (game.pending) { game.phase = 'turnStartArmed'; return; } // страховка
    if (auto.length) {
      Logger.autoApplied(game, auto.map(id => (root.CARD_BY_ID[id] ? root.CARD_BY_ID[id].name : id)));
    }
    if (live.length === 0) {
      if (auto.length === 0) Logger.skipTurnStart(game);
      doDraw(game);
      return;
    }
    game._armedActivate = null;
    game.phase = 'turnStartArmed';
  }

  // собрать карты с активируемым стартовым эффектом (для подсветки/фазы)
  function computeArmedTurnStart(game) {
    const all = (root.RULES || []).concat(root.GAME_RULES || []);
    const matched = all.filter(r => r.event === 'turnStart' &&
      (r.source == null || findInPlay(game, r.source)) &&
      (!r.where || matchWhere(game, r.where, { source: r.source })));
    const seen = new Set();
    const armed = [];
    for (const r of matched) {
      if (r.source == null) continue;
      if (seen.has(r.source)) continue;
      const inst = game.home.concat(game.threat).find(c => c.def.id === r.source);
      if (inst) { armed.push(inst); seen.add(r.source); }
    }
    return armed;
  }

  // игрок тапнул подсвеченную карту — активировать её стартовый эффект
  function activateTurnStart(game, sourceId) {
    if (!game._armedTurnStart || game._armedTurnStart.indexOf(sourceId) === -1) return;
    Logger.activate(game, sourceId);
    game._armedTurnStart = game._armedTurnStart.filter(id => id !== sourceId);
    game._armedActivate = sourceId;
    const all = (root.RULES || []).concat(root.GAME_RULES || []);
    const rule = all.find(r => r.event === 'turnStart' && r.source === sourceId &&
      findInPlay(game, r.source) &&
      (!r.where || matchWhere(game, r.where, { source: r.source })));
    if (rule) runOps(game, rule.do, rule.source, undefined);
    game._armedActivate = null;
    if (game.pending) return; // выбор цели — ждём инлайн-взаимодействия
    if (game._armedTurnStart.length === 0) doDraw(game);
    else game.phase = 'turnStartArmed';
  }

  // пропустить фазу начала хода целиком
  function skipTurnStart(game) {
    Logger.skipTurnStart(game);
    game._armedTurnStart = [];
    game._armedActivate = null;
    doDraw(game);
  }

  // продолжить очередь turnStart после резолва pending, затем — открытие карты
  function continueTurnStartOrDraw(game) {
    if (runTurnStart(game)) { game.phase = 'startPending'; return; }
    doDraw(game);
  }

  function doDraw(game) {
    if (game.deck.length === 0) { fireEvent(game, 'deckEmpty'); return; }
    placeDrawnCard(game, game.deck.pop());
  }

  function offerDraft(game, card) {
    const canBuy = game.energy >= buyCost(game);
    const options = [];
    if (canBuy) options.push('buy');
    options.push('discard');
    setPending(game, 'buyOrDiscard', options, 'Купить (' + buyCost(game) + '⚡) или Сбросить (+1⚡)');
    game._pendingCard = card;
    game.pendingCard = card;
    game.phase = 'choice';
  }

  // Преданный фанат (1): переместить на последнюю карту Дома и сделать её Пустой
  function moveFanTo(game) {
    const fan = findAnywhere(game, 1);
    if (!fan) return;
    if (game.home.length === 0) return;
    const last = game.home[game.home.length - 1];
    if (last === undefined) return;
    if (last === fan) return;
    if (last.attachments.indexOf(fan) !== -1) return; // уже на последней
    // отцепить от старого хозяина и восстановить его
    for (const c of game.home.concat(game.threat)) {
      const i = c.attachments.indexOf(fan);
      if (i !== -1) { c.attachments.splice(i, 1); c.empty = false; }
    }
    removeFrom(game, fan); // вытащить, если фанат остался top-level в зоне
    last.attachments.push(fan);
    last.empty = true;
  }

  function autoPlace(game, card) {
    const zone = card.def.placement === 'threat' ? game.threat : game.home;
    zone.push(card);
    Logger.enter(game, card, card.def.placement === 'threat' ? 'threat' : 'home');
    fireEnter(game, card);
    if (zone === game.home) moveFanTo(game);
    if (game.pending) game.phase = 'enterPending';
  }

  function afterEnter(game) {
    if (game.pending) return;
    if (game.deck.length === 0) fireEvent(game, 'deckEmpty');
    else game.phase = 'start';
  }

  function endGame(game) {
    if (game.status === 'lost') return;
    game.status = 'won';
    game.finalScore = computeScore(game);
    Logger.win(game, game.finalScore);
  }

  function computeScore(game) {
    let s = baseScore(game) + (game._killScore || 0);
    game._scoreLog = [];
    fireEvent(game, 'gameEnd');
    s += (game._scoreAdd || 0);
    game.scoreDetails = scoreBreakdown(game);
    game._scoreAdd = 0;
    return s;
  }

  // ---------- Драйвер выбора ----------
  function choose(game, selection) {
    if (!game.pending) return;
    const kind = game.pending.kind;
    if (kind === 'buyOrDiscard') {
      const card = game._pendingCard;
      game.pending = null; game._pendingCard = null;
      if (selection === 'buy') {
        Logger.buy(game, card, buyCost(game));
        addEnergy(game, -buyCost(game));
        game.home.push(card);
        fireEnter(game, card);
        moveFanTo(game);
      } else {
        game.discard.push(card);
        Logger.discardCard(game, card, '');
        fireEvent(game, 'cardDiscarded');
      }
      game.pendingCard = null;
      continueResume(game);
      if (game.pending) { game.phase = 'enterPending'; return; }
      afterEnter(game);
      return;
    }
    // остальные виды выбора
    resolvePending(game, selection);
    if (game.pending) return;
    if (game._armedTurnStart && game._armedTurnStart.length) {
      game.phase = 'turnStartArmed';
      return;
    }
    if (game.phase === 'turnStartArmed') { doDraw(game); return; }
    if (game.phase === 'enterPending') afterEnter(game);
    else if (game.phase === 'startPending') doDraw(game);
  }

  // экспорт
  root.Engine = {
    createGame, choose, resolvePending, step,
    activateTurnStart, skipTurnStart,
    threatCount, baseScore, computeScore, scoreBreakdown, inPlay, findInPlay, fireEnter,
    mulberry32, shuffle, makeInstance, buyCost,
    _internal: { fireEvent, runOps, executeOp, killOne, removeFrom, placeDrawnCard, checkLoss, autoPlace, computeArmedTurnStart, probeArmed, cloneGame, sigExcl, findAnywhere, findInPlayInclAttach },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.Engine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
