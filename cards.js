/* Deckula! v1.2.2 — данные карт (нормализованы) + декларативные RULES.
 * Никаких JS-функций в поведении: всё описано данными (DSL).
 *
 * ПОЧЕМУ CARDS И RULES РАЗДЕЛЕНЫ: CARDS — плоские СТАТИЧЕСКИЕ данные
 * (что карта ЕСТЬ: name/vp/placement/visitor...), нужны UI для рендера и
 * не меняются в партии. RULES — декларативное ПОВЕДЕНИЕ (что карта ДЕЛАЕТ),
 * интерпретируемое движком (OPS в engine.js). Разделение — КОНВЕНЦИЯ, не
 * необходимость: каждое правило имеет source === id карты, поэтому логику
 * можно бы теоретически вложить в CARDS[source].rules. Отдельно — ради
 *   чистоты данных для UI, кросс-карточных связей (where.inPlay/target/id),
 *   поддержки глобальных правил (source:null) и обзора баланса в одном месте.
 *
 *   ГЛОБАЛЬНЫЕ ПРАВИЛА ИГРЫ (не привязанные к карте) вынесены в отдельный
 *   массив GAME_RULES (source:null) — старт/сброс энергии, поражение при 3+
 *   посетителях, победа при пустой колоде. Параметр Особой подготовки —
 *   в объекте PREP. Всё это позволяет менять базовые правила без правки
 *   движка (engine.js).
 *
 * ПОЛЕ vp (ЕДИНСТВЕННОЕ ПОЛЕ ОЧКОВ) имеет три формы:
 *   vp: N               — плоские очки в игре (число, в т.ч. 0 / отрицательное)
 *   vp: {scaled: N}     — «2★»: база N, масштабируется связкой (карты 23, 28)
 *   vp: {end: true}     — «X»: очки только в конце игры через RULES (карты 10, 39, 46)
 * placement: threat | home | choice   (threat/home = большая красная стрелка)
 *
 * ФЛАГИ ТИПА КАРТЫ (вместо строки type_icons и поля kind):
 *   visitor       — Посетитель (входит в Зону Угрозы; чип V)
 *   placement     — threat | home | choice  (чипы ↑ / ↓ соответственно)
 *   instant       — мгновенный эффект «(!)» (чип ❗)
 *   discardEffect — эффект сброса (СБРОС, активируется в начале хода; чип 🔄)
 *   attachment    — наложение / жетон (чип ◎, только если нет других чипов)
 * Чипы в UI выводятся из этих полей (cardChips в index.html).
 * Поле kind удалено: оно дублировало флаги и не влияло на логику.
 */

const CARD_META = {
  BUY_COST: 2,
  DISCARD_ENERGY: 1,
  START_ENERGY: 2,
  MAX_ENERGY: 7,
};

const DIFFICULTY = {
  easy:   { label: "Начальная", visitors: [19, 9, 49, 15, null] },
  hard:   { label: "Сложная",   visitors: [9, 15, null, null, null] },
  harder: { label: "Ещё сложнее", visitors: [null, null, null, null, null] },
};

const CARDS = [
  { id: 1, name: "Преданный фанат", placement: "home", vp: 0, visitor: true, attachment: true,
    effect: "Поместите на последнюю сыгранную карту в Домашней зоне. Эта карта теперь Пустая. Каждый раз, когда вы выкладываете новую карту в Домашнюю зону, переместите на нее Преданного фаната." },

  { id: 2, name: "Хорошее вино", placement: "choice", vp: 0,
    effect: "Ужин подан воздействует теперь на 2 Посетителей. Если она уже на Посетителе (или если в Зоне Угрозы только один Посетитель), вы должны положить под нее следующего Посетителя, вошедшего в Зону Угрозы." },

  { id: 3, name: "Ужасный экспонат", placement: "choice", instant: true, vp: 1,
    effect: "Замешайте в колоду не глядя 2 дополнительных Посетителей. Вы можете помещать будущих убитых под эту карту. Эта карта принесет 1 ПО + 1 ПО за каждого Посетителя под ней." },

  { id: 4, name: "Банши", placement: "choice", vp: 0,
    effect: "В начале каждого хода (до открытия карт) вы можете убить одного Посетителя (на ваш выбор). Затем замешайте эту карту и всех посетителей из Зоны Угрозы обратно в колоду." },

  { id: 5, name: "Странный приём", placement: "choice", vp: 0, attachment: true,
    immuneTo: [15, 49, 6],
    effect: "Поместите на карту в Домашней зоне. На эту карту не влияют карты Мстительный фермер или Мстительный крестьянин или Неудачный день." },

  { id: 6, name: "Неудачный день", placement: "home", vp: 0, visitor: true, attachment: true,
    effect: "Поместите все карты в Домашней зоне справа от этой карты. Теперь они все Пустые. Не влияет на последующие добавленные карты в Домашнюю зону." },

  { id: 7, name: "Будь на стиле!", placement: "threat", vp: -2, visitor: true,
    effect: "Каждый раз, когда открываете карту Посетителя, получите 1 энергию." },

  { id: 8, name: "Охотник на монстров", placement: "threat", instant: true, vp: 0, visitor: true,
    effect: "Сбросьте одну из следующих карт из игры: Странный приём, Зверь, Банши, Да господин, или Скрип-скрип." },

  { id: 9, name: "Любопытная Пижонка", placement: "threat", vp: 0, visitor: true,
    effect: "Карта-персонаж без дополнительного текстового эффекта." },

  { id: 10, name: "Библиотека Дедала", placement: "choice", vp: {end: true},
    effect: "Если в конце игры в Зоне Угрозы нет Посетителей, получите 2 ПО. Иначе получите -1 ПО за каждого Посетителя в Зоне Угрозы." },

  { id: 11, name: "Оплывшие свечи", placement: "choice", vp: 0,
    effect: "Если Зловония в Домашней зоне, положите следующую открытую карту без стрелки в Домашнюю зону бесплатно." },

  { id: 12, name: "Пир для монстра", placement: "choice", vp: 0,
    effect: "Если в какой-то момент вместе с этой картой в игре оказывается Логово людоеда, положите под нее эту карту. Тогда требование по количеству Посетителей для Логова людоеда снижается до 2." },

  { id: 13, name: "Логово людоеда", placement: "choice", discardEffect: true, vp: 0,
    effect: "Если Зверь на этой карте, вы можете сбросить ее в начале хода, чтобы убить всех Посетителей в Зоне Угрозы и поместить их под эту карту. В Зоне Угрозы должно быть минимум 3 Посетителя." },

  { id: 14, name: "Археолог Нюхач", placement: "threat", instant: true, vp: 0, visitor: true,
    effect: "Поместите жетон на эту карту за каждого убитого до сих пор Посетителя. Когда убиваете Посетителя, добавьте жетон. Когда эффект нацелен на эту карту, вместо этого уберите один жетон. Если жетонов нет, примените эффект как обычно." },

  { id: 15, name: "Мстительный фермер", placement: "threat", instant: true, vp: 0, visitor: true,
    effect: "Сбросьте карту без красного символа ПО из Домашней зоны. Если таких карт нет, сбросьте любую карту из Домашней зоны." },

  { id: 16, name: "Злорадное привидение", placement: "choice", vp: 0, attachment: true,
    onKillScore: true,
    effect: "Поместите на Посетителя. Когда вы его убиваете, отложите обе карты в сторону до конца игры и получите 1 ПО." },

  { id: 17, name: "Легковерный оккультист", placement: "threat", vp: 0, visitor: true,
    buyCostMod: 3,
    effect: "Пока эта карта в Зоне Угрозы, карты стоят 3 энергии вместо 2." },

  { id: 18, name: "Зеркальный зал", placement: "choice", discardEffect: true, vp: 0,
    effect: "Верните одного Посетителя, находящегося в игре, под низ колоды." },

  { id: 19, name: "Незадачливый бродяга", placement: "threat", vp: 0, visitor: true,
    effect: "Карта-персонаж без дополнительного текстового эффекта." },

  { id: 20, name: "Дом, милый дом", placement: "threat", vp: 0,
    threatLossAt: 3,
    effect: "Если одновременно с этой картой 3 или более Посетителей в Зоне Угрозы, вы немедленно проигрываете." },

  { id: 21, name: "Импозантный портрет", placement: "choice", vp: 1,
    effect: "Если вы убили Посетителя с помощью Злорадного привидения, вы можете переместить ее на другого Посетителя в игре, вместо того чтобы отложить как обычно. (Один раз за игру)" },

  { id: 22, name: "Сентиментальные мемуары", placement: "home", discardEffect: true, vp: 3,
    effect: "Выберите: Сбросить эту карту и открыть другую ИЛИ разыграть ее бесплатно, но немедленно проиграть, если следующая карта будет Посетитель." },

  { id: 23, name: "Великолепный зал", placement: "choice", vp: {scaled: 2},
    effect: "Получите 3 очка, если Роскошное фойе тоже в игре." },

  { id: 24, name: "Ветхий будуар", placement: "choice", vp: 1,
    effect: "Поместите следующего Посетителя на эту карту. Если позже будет открыт еще один Посетитель, сбросьте эту карту, и разыграйте эффекты обеих карт, как будто открыли их только что." },

  { id: 25, name: "Уголки и закоулки", placement: "choice", vp: 0,
    effect: "В начале своего хода вы можете потратить 1-3 энергии, чтобы замешать столько Посетителей из Зоны Угрозы обратно в колоду, сколько энергии потратили." },

  { id: 26, name: "Зловония", placement: "choice", vp: 0,
    effect: "Если Оплывшие свечи находятся в Домашней зоне, положите следующую открытую карту без стрелки в Домашнюю зону бесплатно." },

  { id: 27, name: "На шаг впереди", placement: "choice", discardEffect: true, vp: 0,
    effect: "Если Дом, милый дом в игре, замешайте ее обратно в колоду." },

  { id: 28, name: "Роскошное фойе", placement: "choice", vp: {scaled: 2},
    effect: "Получите 3 очка, если Великолепный зал тоже в игре." },

  { id: 29, name: "Пытошная", placement: "choice", vp: 1,
    effect: "Когда применяете эффект карты Да, господин, можете заплатить 1 энергию, вместо того чтобы сбросить ее." },

  { id: 30, name: "Бульварный писака", placement: "threat", instant: true, vp: 0, visitor: true,
    effect: "Замешайте не глядя еще двоих Посетителей в колоду." },

  { id: 31, name: "Ревущее пламя", placement: "choice", vp: 0, attachment: true,
    effect: "Поместите на следующего открытого Посетителя и игнорируйте текст на его карте. Если посетитель убит, сбросьте эту карту." },

  { id: 32, name: "Садистский механизм", placement: "choice", discardEffect: true, vp: 0,
    effect: "Убейте Посетителя." },

  { id: 33, name: "Скрип-скрип", placement: "choice", discardEffect: true, vp: 0,
    effect: "Верните любую карту на ваш выбор из сброса и разыграйте бесплатно." },

  { id: 34, name: "Меткий стрелок", placement: "threat", instant: true, vp: 0, visitor: true,
    effect: "Потеряйте 2 энергии. Каждый раз, когда открываете нового Посетителя, потеряйте 1 энергию." },

  { id: 35, name: "Зловещее красноречие", placement: "choice", vp: 1,
    effect: "Если открываете Голоса, немедленно разыграйте ее бесплатно. Если нет Посетителей, сбросьте обе эти карты." },

  { id: 36, name: "Сэр Здоровяк", placement: "threat", vp: 0, visitor: true,
    absorbVisitorEffects: true,
    effect: "Принимает на себя все эффекты, направленные на Посетителей. Если какой-либо эффект направлен на нескольких Посетителей одновременно, он направляется только на Сэра Здоровяка." },

  { id: 37, name: "Безупречная чистота", placement: "choice", discardEffect: true, vp: 1,
    effect: "Заберите карту из-под карты Трагическая случайность и сбросьте ее. (Вместо сброса можете положить ее под Ужасный экспонат)" },

  { id: 38, name: "Ужин подан", placement: "choice", vp: 0, attachment: true,
    effect: "Поместите на любого Посетителя в Зоне Угрозы. Он теперь не идет в счет Посетителей для эффекта карты Дом, милый дом." },

  { id: 39, name: "Головокружительный вид", placement: "choice", vp: {end: true},
    effect: "1 ПО за каждую из следующих карт в игре: Сентиментальные мемуары и Хорошее вино." },

  { id: 40, name: "Зверь", placement: "home", instant: true, vp: 0, visitor: true,
    effect: "Если Логово людоеда в игре, поместите на нее эту карту и игнорируйте то, что написано далее. Если Пир для Монстра в игре, сбросьте ее и эту карту и убейте Посетителя. В противном случае сбросьте эту карту." },

  { id: 41, name: "Часы пробили 13", placement: "choice", discardEffect: true, vp: 0,
    effect: "В начале хода посмотрите на 4 верхние карты колоды и верните их на верх колоды в любом порядке." },

  { id: 42, name: "Коллекционер", placement: "threat", vp: 0, visitor: true,
    hiddenUnder: true,
    effect: "Каждый ход (до открытия карты) возьмите дополнительную карту и не глядя положите под эту карту. Если под ней 3 карты, сбросьте ее вместе с картами под ней. Если Коллекционер убит, сбросьте карты." },

  { id: 43, name: "Дегустационная", placement: "choice", vp: 1,
    effect: "Если вытянули Хорошее вино, поместите ее в Домашнюю зону бесплатно." },

  { id: 44, name: "Голоса!", placement: "choice", discardEffect: true, vp: 0,
    effect: "Убейте Посетителя. Если в Домашней зоне есть Зловония или Оплывшие свечи, убейте еще одного." },

  { id: 45, name: "Трагическая случайность", placement: "choice", vp: 0,
    effect: "Если под этой картой пусто, когда вы открываете следующего Посетителя, немедленно поместите его под эту карту. Не применяйте эффекты карты Посетителя." },

  { id: 46, name: "Трофейная комната", placement: "choice", vp: {end: true},
    effect: "1 ПО за каждую из следующих карт в игре: Странный приём, Ревущее пламя, Безупречная чистота." },

  { id: 47, name: "Жутковатая формальность", placement: "choice", discardEffect: true, vp: 0,
    effect: "Замешайте не глядя еще одного Посетителя в колоду." },

  { id: 48, name: "Вампировед", placement: "threat", vp: 0, visitor: true,
    threatWeight: 2,
    effect: "Считается за двоих Посетителей при подсчете эффекта карты Дом, милый дом." },

  { id: 49, name: "Мстительный крестьянин", placement: "threat", instant: true, vp: 0, visitor: true,
    effect: "Сбросьте карту с красным символом ПО из Домашней зоны. Если таких карт нет, сбросьте любую карту из Домашней зоны." },

  { id: 50, name: "Да, господин", placement: "choice", discardEffect: true, vp: 0,
    effect: "Убейте Посетителя." },
];

// помощник: есть ли у карты плоские очки (красный символ ПО)
function hasRedVP(c) { const v = c.vp; return typeof v === 'number' && v !== 0; }

// ----- Декларативные правила (RULES) -----
// { source, event:'enter'|'turnStart'|'visitorRevealed'|'gameEnd'|'setup'|'cardDiscarded'|'checkThreat'|'deckEmpty',
//   где setup/cardDiscarded/checkThreat/deckEmpty — глобальные правила (source:null, см. GAME_RULES),
//   pre?:true (только на этапе reveal до размещения), where?, do:[ops] }
const RULES = [
  // 1 Преданный фанат: перемещается на последнюю карту Дома и делает её Пустой
  { source: 1, event: 'enter', do: [{ op: 'attach', target: 'latestHome', makeEmpty: true }] },

  // 3 Ужасный экспонат: +2 посетителя в колоду; ПО = 1 + под ней
  { source: 3, event: 'enter', do: [{ op: 'addVisitors', n: 2 }] },
  { source: 3, event: 'gameEnd', do: [{ op: 'scoreUnder', id: 3, base: 1 }] },

  // 4 Банши: в начале хода можете убить + заместить
  { source: 4, event: 'turnStart', do: [{ op: 'banshee' }] },

  // 7 Будь на стиле: +1 энергии за каждого открытого посетителя
  { source: 7, event: 'visitorRevealed', do: [{ op: 'energy', value: 1 }] },

  // 8 Охотник на монстров: сбросить одну из списка из игры
  { source: 8, event: 'enter', discretionary: true, do: [{ op: 'discardFromPlay', ids: [5, 40, 4, 50, 33] }] },

  // 6 Неудачный день: карты справа становятся Пустыми
  { source: 6, event: 'enter', do: [{ op: 'setEmpty', target: 'rightOfSelf' }] },

  // 10 Библиотека Дедала
  { source: 10, event: 'gameEnd', do: [{ op: 'scoreThreat', empty: 2, per: -1 }] },

  // 11/26 Оплывшие свечи / Зловония: следующая без стрелки — бесплатно в Дом
  { source: 11, event: 'enter', where: { inPlay: [26] }, do: [{ op: 'freePlaceNext', zone: 'home' }] },
  { source: 26, event: 'enter', where: { inPlay: [11] }, do: [{ op: 'freePlaceNext', zone: 'home' }] },

  // 13 Логово людоеда: в начале хода — пир
  { source: 13, event: 'turnStart', do: [{ op: 'beastFeast' }] },

  // 15 Мстительный фермер: сбросить карту Дома без ПО
  { source: 15, event: 'enter', do: [{ op: 'discardHome', match: 'noVP', target: 'choice' }] },

  // 16 Злорадное привидение: +1 ПО при убийстве (через onKillScore)
  // 17 Легковерный оккультист: buyCostMod (учитывается движком)

  // 18 Зеркальный зал: в начале хода (по выбору) сбросить → вернуть посетителя под низ
  { source: 18, event: 'turnStart', do: [{ op: 'returnVisitorBottom', discardSelf: true }] },

  // 22 Сентиментальные мемуары: выбор при входе
  { source: 22, event: 'enter', do: [{ op: 'memoirChoice' }] },

  // 23/28 Великолепный зал / Роскошное фойе: база 2★, в паре даёт 3★ (итого +1 к базе)
  { source: 23, event: 'gameEnd', do: [{ op: 'scoreIf', inPlay: [28], value: 1 }] },
  { source: 28, event: 'gameEnd', do: [{ op: 'scoreIf', inPlay: [23], value: 1 }] },

  // 25 Уголки и закоулки
  { source: 25, event: 'turnStart', do: [{ op: 'payToShuffleVisitors', range: [1, 3] }] },

  // 27 На шаг впереди: в начале хода (по выбору) сбросить → заместить Дом, милый дом
  { source: 27, event: 'turnStart', where: { inPlay: [20] }, do: [{ op: 'shuffleBack', target: 20, discardSelf: true }] },

  // 30 Бульварный писака: +2 посетителя
  { source: 30, event: 'enter', do: [{ op: 'addVisitors', n: 2 }] },

  // 32 Садистский механизм: эффект сброса — в начале хода сбросить, чтобы убить посетителя
  { source: 32, event: 'turnStart', do: [{ op: 'killVisitor', count: 1, discardSelf: true }] },

  // 33 Скрип-скрип: вернуть из сброса и разыграть (за сброс в начале хода)
  { source: 33, event: 'turnStart', do: [{ op: 'recallDiscard', discardSelf: true }] },

  // 34 Меткий стрелок
  { source: 34, event: 'enter', do: [{ op: 'energy', value: -2 }] },
  { source: 34, event: 'visitorRevealed', do: [{ op: 'energy', value: -1 }] },

  // 35 Зловещее красноречие: авто-разыгрыш Голоса!
  { source: 35, event: 'enter', do: [{ op: 'autoPlayIfDrawn', id: 44 }] },

  // 37 Безупречная чистота: забрать из-под Трагической случайности (за сброс в начале хода)
  { source: 37, event: 'turnStart', do: [{ op: 'takeFromUnder', card: 45, discardSelf: true }] },

  // 38 Ужин подан: наложение на посетителя (exempt учитывается в threatCount)
  { source: 38, event: 'enter', discretionary: true, do: [{ op: 'attach', target: 'threatVisitor' }] },

  // 39 Головокружительный вид
  { source: 39, event: 'gameEnd', do: [{ op: 'scorePer', inPlay: [22, 2], value: 1 }] },

  // 41 Часы пробили 13: в начале хода (за сброс) посмотреть 4 верхние и переставить
  { source: 41, event: 'turnStart', do: [{ op: 'peek', n: 4, discardSelf: true }] },

  // 42 Коллекционер: прятать карту под себя
  { source: 42, event: 'turnStart', do: [{ op: 'hoardUnder', max: 3 }] },

  // 43 Дегустационная: Хорошее вино бесплатно
  { source: 43, event: 'enter', do: [{ op: 'freeIfDrawn', id: 2 }] },

  // 44 Голоса! (за сброс в начале хода)
  { source: 44, event: 'turnStart', do: [{ op: 'killVisitor', count: 1, discardSelf: true }, { op: 'killVisitor', count: 1, when: { inPlayAny: [26, 11] } }] },

  // 45 Трагическая случайность: похоронить посетителя (pre)
  { source: 45, event: 'visitorRevealed', pre: true, where: { selfUnderEmpty: true }, do: [{ op: 'buryUnder', card: 45, skipEffects: true }] },

  // 46 Трофейная комната
  { source: 46, event: 'gameEnd', do: [{ op: 'scorePer', inPlay: [5, 31, 37], value: 1 }] },

  // 47 Жутковатая формальность: +1 посетитель (за сброс в начале хода)
  { source: 47, event: 'turnStart', do: [{ op: 'addVisitors', n: 1, discardSelf: true }] },

  // 49 Мстительный крестьянин: сбросить карту Дома с ПО
  { source: 49, event: 'enter', discretionary: true, do: [{ op: 'discardHome', match: 'hasVP', target: 'choice' }] },

  // 50 Да, господин: сброс в начале хода, убить посетителя
  { source: 50, event: 'turnStart', do: [{ op: 'killVisitor', count: 1, discardSelf: true }] },
];

// ----- ОБЩИЕ ПРАВИЛА ИГРЫ (GAME_RULES) -----
// Глобальные правила, НЕ привязанные к конкретной карте (source: null).
// Интерпретируются движком точно так же, как RULES (через executeOp).
// Это позволяет менять базовые правила игры (старт/сброс энергии,
// поражение/победа) как данные, без правки engine.js.
const GAME_RULES = [
  // A. «Начните с 2 очков энергии» (Подготовка п.6)
  { source: null, event: 'setup', do: [{ op: 'energy', value: 2 }] },

  // B. «Сбросьте карту и получите 1 энергию» (Ход п.4 — единственный источник)
  { source: null, event: 'cardDiscarded', do: [{ op: 'energy', value: 1 }] },

  // C. «Дом, милый дом»: поражение при 3+ посетителях в Зоне Угрозы (Игра Б/Дом п.милый дом)
  { source: null, event: 'checkThreat',
    where: { inPlay: [20], threatCount: { '>=': 3 } }, do: [{ op: 'loseGame', reason: 'dom', reasonText: 'Дом, милый дом не выдержал: 3+ посетителя в Зоне Угрозы', capture: 'threat' }] },

  // D. Победа, если дошли до конца колоды (Игра А)
  { source: null, event: 'deckEmpty', do: [{ op: 'win' }] },
];

// Параметры Особой подготовки (E, Правила п.36-54).
// Интерактивный выбор 1 из N карт — задача UI (см. AGENTS.md «Prep»);
// движок при отсутствии выбора авто-размещает openings[pick] (по умолчанию
// openings[0]), как и раньше. Количество открываемых карт вынесено в данные.
const PREP = { openings: 3 };

const CARD_BY_ID = {};
CARDS.forEach(c => CARD_BY_ID[c.id] = c);

if (typeof module !== 'undefined') {
  module.exports = { CARDS, CARD_BY_ID, CARD_META, DIFFICULTY, RULES, GAME_RULES, PREP };
} else {
  window.CARDS = CARDS; window.CARD_BY_ID = CARD_BY_ID; window.CARD_META = CARD_META;
  window.DIFFICULTY = DIFFICULTY; window.RULES = RULES;
  window.GAME_RULES = GAME_RULES; window.PREP = PREP;
}
