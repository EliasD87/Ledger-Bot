import { ordinal } from './deskCards.js';
import { ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import { discordTime, formatPrice, formatUsd } from '../format.js';
import { type ThesisSpec, measureLabel, nftAmount } from '../theses/spec.js';
import { timeLeft } from '../theses/moments.js';
import type { Leader, MomentKind, Record, Sides, Thesis, ThesisStatus } from '../theses/store.js';
import type { Verdict } from '../theses/measure.js';
import { myPageButton } from './pageCards.js';
import { CHART_NAME } from '../charts/maker.js';
import { ACCENT, card, cards, divider, heading, kicker, picture, row } from './ui.js';

export type ThesisAction = 'log' | 'drop' | 'with' | 'against' | 'progress' | 'timeframes' | 'retime' | 'sharpen' | 'sharpened' | 'duel' | 'case';

/** `arg` carries a number some buttons need: the timeframe in days for "retime". */
export const thesisButtonId = (action: ThesisAction, id: number, arg?: number) => `thesis:${action}:${id}${arg !== undefined ? `:${arg}` : ''}`;

export function parseThesisButtonId(customId: string): { action: ThesisAction; id: number; arg?: number } | null {
  const m = /^thesis:(log|drop|with|against|progress|timeframes|retime|sharpen|sharpened|duel|case):(\d+)(?::(\d+))?$/.exec(customId);
  return m ? { action: m[1] as ThesisAction, id: Number(m[2]), ...(m[3] ? { arg: Number(m[3]) } : {}) } : null;
}

const button = (action: ThesisAction, id: number, label: string, style = ButtonStyle.Secondary, arg?: number) =>
  new ButtonBuilder().setCustomId(thesisButtonId(action, id, arg)).setLabel(label).setStyle(style);

const EDGE: { [S in ThesisStatus]: number } = {
  draft: ACCENT.amber,
  open: ACCENT.open,
  aged_well: ACCENT.right,
  aged_badly: ACCENT.wrong,
  void: ACCENT.muted,
  cancelled: ACCENT.muted,
};

/** The fixed words on take cards, in the language the member wrote the take in. */
const WORDS = {
  en: {
    lean: { for: 'Evidence leans with the take.', against: 'Evidence leans against the take.', even: 'Evidence is split.' },
    stressTest: 'Stress test',
    fullCase: 'Full case',
    wrongIf: 'Wrong if',
    caseTitle: (claim: string) => `Full case · ${claim}`,
    thesis: (id: number) => `Thesis #${id}`,
    onRecord: 'on the record',
    agedWell: 'aged well ✓',
    agedBadly: 'aged badly ✗',
    voided: 'void',
    notLogged: 'not logged',
    readAs: 'read as',
    loggedAt: (m: string, v: string, when: string) => `Logged at ${m} ${v} · checks back ${when}`,
    net: 'net',
    logIt: 'Log it',
    floorNow: (v: string) => `**Floor now:** ${v}`,
    floorLine: 'Here it is. Log it if you stand by it.',
    floorNeeds: (change: string, days: number) => `It needs ${change} within ${days === 1 ? 'a day' : `${days} days`}, and counts as soon as the floor gets there.`,
    timeframes: 'Other timeframes',
    sharpen: 'Make it sharper',
    notNow: 'Not now',
    withYou: "I'm with you",
    against: "I'm against",
    progress: "How's it doing?",
    duel: (a: string, b: string) => `⚔️ Duel: ${a} vs ${b}`,
    for: 'For',
    againstHeading: 'Against',
    kill: 'What would prove it wrong',
    history: 'History',
    analysts: (days: number, parts: string) => `Newsletter analysts, last ${days} days · ${parts}`,
    analystSplit: (ticker: string, bull: number, bear: number) => `${ticker}: ${bull} bullish, ${bear} bearish`,
    sides: (w: number, a: number) => `With **${w}** · Against **${a}**`,
    sideWith: 'with',
    sideAgainst: 'against',
    draftFooter: (when: string, data: string) => `Checks back ${when} once logged · ${data}`,
    checkIn: (days: number, date: string) => (days === 1 ? 'tomorrow' : `in ${days} days, around ${date}`),
    footer: (data: string) => `Data: ${data} · evidence, not a forecast`,
    checkBack: (id: number) => `Check-back · thesis #${id}`,
    reachedEarly: 'It got to the level before the check-back date, so it counts.',
    duelWin: (winner: string, loser: string) => `⚔️ Duel: ${winner} wins against ${loser}.`,
    contrarian: (a: number, n: number) => `Contrarian win: ${a} of ${n} were against.`,
    readItRight: 'Read it right',
    missed: 'Missed',
    sinceLogged: 'since logged',
    littleTime: 'little time',
    theCheckBack: 'the check-back',
    reached: (where: string, left: string, by: string) => `**On the way.** ${where}: past the line with ${left} left. It still has to be there on ${by}.`,
    slipped: (where: string, left: string, by: string) => `**Gave it back.** ${where}: short of the line again, ${left} left before ${by}.`,
    pressure: (where: string, left: string) => `**Under pressure.** ${where}: further against the take than its usual range for the whole window, with ${left} left.`,
    days: (d: number) => (d === 1 ? '1 day' : d % 30 === 0 && d >= 30 ? (d === 30 ? '1 month' : `${d / 30} months`) : d % 7 === 0 ? (d === 7 ? '1 week' : `${d / 7} weeks`) : `${d} days`),
    tfRow: (label: string, rate: number, windows: string) => `${label}: ${rate}% of ${windows} windows`,
    thisTake: 'this take',
    median: 'median',
    tfTitle: (claim: string) => `⏱ Same take, other timeframes · ${claim}`,
    tfIntro: 'How often the move it needs has happened before:',
    tfNote: 'History, not a forecast. Longer windows usually give a move more room to happen.',
    use: (label: string) => `Use ${label}`,
    sharperTitle: (id: number) => `🎯 A sharper version of #${id}`,
    testThis: 'Test this version',
    sharperNote: 'Testing it replaces the stress test on your card; nothing is logged until you press Log it.',
    cantRead: (m: string) => `Couldn't read ${m} right now. Try again in a minute.`,
    soon: 'soon',
    netSoFar: 'net so far',
    onTrack: (ok: boolean) => (ok ? 'On track so far' : 'Not there so far'),
    checksBack: (when: string) => `checks back ${when}`,
    measure: (s: ThesisSpec) => measureLabel(s),
    date: (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    left: (checkAt: number, now: number) => timeLeft(checkAt, now),
  },
  zh: {
    lean: { for: '证据更支持这个观点。', against: '证据更不支持这个观点。', even: '证据两边差不多。' },
    stressTest: '压力测试',
    fullCase: '完整分析',
    wrongIf: '这样就错了',
    caseTitle: (claim: string) => `完整分析 · ${claim}`,
    thesis: (id: number) => `观点 #${id}`,
    onRecord: '已记录',
    agedWell: '应验了 ✓',
    agedBadly: '没应验 ✗',
    voided: '作废',
    notLogged: '未记录',
    readAs: '理解为',
    loggedAt: (m: string, v: string, when: string) => `记录时 ${m} ${v} · ${when}复盘`,
    net: '净',
    logIt: '记录',
    floorNow: (v: string) => `**目前地板价：** ${v}`,
    floorLine: '在这里。你有把握就点「记录」。',
    floorNeeds: (change: string, days: number) => `需要在 ${days} 天内 ${change}，地板价一到就算。`,
    timeframes: '其他时间',
    sharpen: '更精确',
    notNow: '先不',
    withYou: '我支持',
    against: '我反对',
    progress: '进展如何？',
    duel: (a: string, b: string) => `⚔️ 对决：${a} vs ${b}`,
    for: '支持',
    againstHeading: '反对',
    kill: '什么情况说明它错了',
    history: '历史',
    analysts: (days: number, parts: string) => `通讯和播客分析师（近 ${days} 天）· ${parts}`,
    analystSplit: (ticker: string, bull: number, bear: number) => `${ticker}：${bull} 看多，${bear} 看空`,
    sides: (w: number, a: number) => `支持 **${w}** · 反对 **${a}**`,
    sideWith: '支持',
    sideAgainst: '反对',
    draftFooter: (when: string, data: string) => `点「记录」把它记下来，${when}复盘 · 数据：${data}`,
    checkIn: (days: number, date: string) => (days === 1 ? '明天' : `${days} 天后（${date}左右）`),
    footer: (data: string) => `数据：${data} · 只是证据，不是预测`,
    checkBack: (id: number) => `复盘 · 观点 #${id}`,
    reachedEarly: '在复盘日之前已经到达目标，所以算应验。',
    duelWin: (winner: string, loser: string) => `⚔️ 对决：${winner} 赢了 ${loser}。`,
    contrarian: (a: number, n: number) => `逆向胜利：${n} 人里有 ${a} 人反对。`,
    readItRight: '判断对了',
    missed: '判断错了',
    sinceLogged: '记录以来',
    littleTime: '不多',
    theCheckBack: '复盘日',
    reached: (where: string, left: string, by: string) => `**快到了。** ${where}：已经过线，还剩 ${left}。${by}那天还得在线上才算。`,
    slipped: (where: string, left: string, by: string) => `**又回去了。** ${where}：又跌回线下，离${by}还剩 ${left}。`,
    pressure: (where: string, left: string) => `**有压力了。** ${where}：反方向走得比整个周期的常见区间还远，还剩 ${left}。`,
    days: (d: number) => (d % 30 === 0 && d >= 30 ? (d === 30 ? '1 个月' : `${d / 30} 个月`) : d % 7 === 0 ? (d === 7 ? '1 周' : `${d / 7} 周`) : `${d} 天`),
    tfRow: (label: string, rate: number, windows: string) => `${label}：${windows} 个窗口里 ${rate}% 做到了`,
    thisTake: '当前观点',
    median: '中位数',
    tfTitle: (claim: string) => `⏱ 同一个观点，其他时间范围 · ${claim}`,
    tfIntro: '它需要的涨跌以前出现过多少次：',
    tfNote: '这是历史，不是预测。时间越长，通常越有机会。',
    use: (label: string) => `用 ${label}`,
    sharperTitle: (id: number) => `🎯 #${id} 的更精确版本`,
    testThis: '测试这个版本',
    sharperNote: '测试后会替换卡片上的压力测试；点「记录」之前不会记下来。',
    cantRead: (m: string) => `现在读不到 ${m}，过一分钟再试试。`,
    soon: '很快',
    netSoFar: '目前净额',
    onTrack: (ok: boolean) => (ok ? '目前在轨道上' : '目前还没到'),
    checksBack: (when: string) => `${when}复盘`,
    measure: (s: ThesisSpec) =>
      s.nft ? `${s.asset} 地板价` : s.kind === 'relative' ? `${s.asset}/${s.versus}` : s.kind === 'flows' ? `${s.asset} ETF 净流量` : `${s.asset} 价格`,
    date: (ms: number) => `${new Date(ms).getUTCMonth() + 1}月${new Date(ms).getUTCDate()}日`,
    left: (checkAt: number, now: number) => {
      const days = (checkAt - now) / 86_400_000;
      return days < 1 ? '不到一天' : `${Math.round(days)} 天`;
    },
  },
  ja: {
    lean: { for: '証拠はこの見解寄りです。', against: '証拠はこの見解に反しています。', even: '証拠は五分五分です。' },
    stressTest: 'ストレステスト',
    fullCase: '詳しく見る',
    wrongIf: 'こうなれば外れ',
    caseTitle: (claim: string) => `詳しい分析 · ${claim}`,
    thesis: (id: number) => `見解 #${id}`,
    onRecord: '記録済み',
    agedWell: '当たった ✓',
    agedBadly: '外れた ✗',
    voided: '無効',
    notLogged: '未記録',
    readAs: '解釈',
    loggedAt: (m: string, v: string, when: string) => `記録時 ${m} ${v} · ${when}に答え合わせ`,
    net: '純額',
    logIt: '記録する',
    floorNow: (v: string) => `**現在のフロア価格：** ${v}`,
    floorLine: 'こちらです。自信があれば「記録する」を押してください。',
    floorNeeds: (change: string, days: number) => `${days}日以内に ${change} 必要です。フロア価格が届いた時点で成立します。`,
    timeframes: '他の期間',
    sharpen: 'もっと具体的に',
    notNow: '今はいい',
    withYou: '賛成',
    against: '反対',
    progress: '今どう？',
    duel: (a: string, b: string) => `⚔️ 対決：${a} vs ${b}`,
    for: '賛成の根拠',
    againstHeading: '反対の根拠',
    kill: '間違いと分かる条件',
    history: '過去のデータ',
    analysts: (days: number, parts: string) => `ニュースレターのアナリスト（直近${days}日）· ${parts}`,
    analystSplit: (ticker: string, bull: number, bear: number) => `${ticker}：強気 ${bull}、弱気 ${bear}`,
    sides: (w: number, a: number) => `賛成 **${w}** · 反対 **${a}**`,
    sideWith: '賛成',
    sideAgainst: '反対',
    draftFooter: (when: string, data: string) => `「記録する」で記録すると、${when}に答え合わせします · データ：${data}`,
    checkIn: (days: number, date: string) => (days === 1 ? '明日' : `${days}日後（${date}ごろ）`),
    footer: (data: string) => `データ：${data} · 予測ではなく証拠です`,
    checkBack: (id: number) => `答え合わせ · 見解 #${id}`,
    reachedEarly: '答え合わせの日より前に目標に届いたので、当たりです。',
    duelWin: (winner: string, loser: string) => `⚔️ 対決：${winner} が ${loser} に勝ちました。`,
    contrarian: (a: number, n: number) => `逆張りの勝ち：${n}人中${a}人が反対でした。`,
    readItRight: '読みが当たった人',
    missed: '外れた人',
    sinceLogged: '記録以降',
    littleTime: 'わずか',
    theCheckBack: '答え合わせの日',
    reached: (where: string, left: string, by: string) => `**届きました。** ${where}：ラインを越えて、残り ${left}。${by}にもラインの上にある必要があります。`,
    slipped: (where: string, left: string, by: string) => `**戻りました。** ${where}：またラインの下に、${by}まで残り ${left}。`,
    pressure: (where: string, left: string) => `**苦しい展開。** ${where}：期間全体の通常の幅を超えて逆に動いています。残り ${left}。`,
    days: (d: number) => (d % 30 === 0 && d >= 30 ? `${d / 30}か月` : d % 7 === 0 ? `${d / 7}週間` : `${d}日`),
    tfRow: (label: string, rate: number, windows: string) => `${label}：${windows}回中 ${rate}%`,
    thisTake: 'この見解',
    median: '中央値',
    tfTitle: (claim: string) => `⏱ 同じ見解を別の期間で · ${claim}`,
    tfIntro: '必要な値動きが過去に起きた割合：',
    tfNote: '過去のデータで、予測ではありません。期間が長いほど、値動きの余地は大きくなります。',
    use: (label: string) => `${label}にする`,
    sharperTitle: (id: number) => `🎯 #${id} をもっと具体的に`,
    testThis: 'このバージョンを試す',
    sharperNote: '試すとカードのストレステストが置き換わります。「記録する」を押すまでは記録されません。',
    cantRead: (m: string) => `今は ${m} を読めません。1分後にもう一度どうぞ。`,
    soon: 'まもなく',
    netSoFar: 'ここまでの純額',
    onTrack: (ok: boolean) => (ok ? '今のところ順調' : '今のところ届いていません'),
    checksBack: (when: string) => `${when}に答え合わせ`,
    measure: (s: ThesisSpec) => measureLabel(s, 'ja'),
    date: (ms: number) => `${new Date(ms).getUTCMonth() + 1}月${new Date(ms).getUTCDate()}日`,
    left: (checkAt: number, now: number) => {
      const days = (checkAt - now) / 86_400_000;
      return days < 1 ? '1日未満' : `${Math.round(days)}日`;
    },
  },
  pt: {
    lean: { for: 'As evidências pendem a favor da tese.', against: 'As evidências pendem contra a tese.', even: 'As evidências estão divididas.' },
    stressTest: 'Teste de estresse',
    fullCase: 'Análise completa',
    wrongIf: 'Errada se',
    caseTitle: (claim: string) => `Análise completa · ${claim}`,
    thesis: (id: number) => `Tese #${id}`,
    onRecord: 'registrada',
    agedWell: 'acertou ✓',
    agedBadly: 'errou ✗',
    voided: 'anulada',
    notLogged: 'não registrada',
    readAs: 'entendido como',
    loggedAt: (m: string, v: string, when: string) => `Registrada com ${m} em ${v} · conferência ${when}`,
    net: 'líquido',
    logIt: 'Registrar',
    floorNow: (v: string) => `**Floor agora:** ${v}`,
    floorLine: 'Aqui está. Registre se você confia nela.',
    floorNeeds: (change: string, days: number) => `Precisa de ${change} em ${days === 1 ? 'um dia' : `${days} dias`}, e vale assim que o floor chegar lá.`,
    timeframes: 'Outros prazos',
    sharpen: 'Deixar mais precisa',
    notNow: 'Agora não',
    withYou: 'Estou com você',
    against: 'Sou contra',
    progress: 'Como está indo?',
    duel: (a: string, b: string) => `⚔️ Duelo: ${a} vs ${b}`,
    for: 'A favor',
    againstHeading: 'Contra',
    kill: 'O que provaria que está errada',
    history: 'Histórico',
    analysts: (days: number, parts: string) => `Analistas de newsletters, últimos ${days} dias · ${parts}`,
    analystSplit: (ticker: string, bull: number, bear: number) => `${ticker}: ${bull} otimistas, ${bear} pessimistas`,
    sides: (w: number, a: number) => `A favor **${w}** · Contra **${a}**`,
    sideWith: 'a favor',
    sideAgainst: 'contra',
    draftFooter: (when: string, data: string) => `Registre para colocar no histórico e receber a conferência ${when} · dados: ${data}`,
    checkIn: (days: number, date: string) => (days === 1 ? 'amanhã' : `em ${days} dias, por volta de ${date}`),
    footer: (data: string) => `Dados: ${data} · evidências, não uma previsão`,
    checkBack: (id: number) => `Conferência · tese #${id}`,
    reachedEarly: 'Chegou ao nível antes da data da conferência, então vale.',
    duelWin: (winner: string, loser: string) => `⚔️ Duelo: ${winner} vence ${loser}.`,
    contrarian: (a: number, n: number) => `Vitória do contra: ${a} de ${n} eram contra.`,
    readItRight: 'Acertaram',
    missed: 'Erraram',
    sinceLogged: 'desde o registro',
    littleTime: 'pouco tempo',
    theCheckBack: 'a conferência',
    reached: (where: string, left: string, by: string) => `**No caminho.** ${where}: passou da linha com ${left} restantes. Ainda precisa estar lá em ${by}.`,
    slipped: (where: string, left: string, by: string) => `**Devolveu.** ${where}: abaixo da linha de novo, ${left} restantes até ${by}.`,
    pressure: (where: string, left: string) => `**Sob pressão.** ${where}: mais contra a tese do que a faixa normal para todo o prazo, com ${left} restantes.`,
    days: (d: number) => (d === 1 ? '1 dia' : d % 30 === 0 && d >= 30 ? (d === 30 ? '1 mês' : `${d / 30} meses`) : d % 7 === 0 ? (d === 7 ? '1 semana' : `${d / 7} semanas`) : `${d} dias`),
    tfRow: (label: string, rate: number, windows: string) => `${label}: ${rate}% de ${windows} janelas`,
    thisTake: 'esta tese',
    median: 'mediana',
    tfTitle: (claim: string) => `⏱ Mesma tese, outros prazos · ${claim}`,
    tfIntro: 'Com que frequência o movimento necessário já aconteceu:',
    tfNote: 'Histórico, não previsão. Prazos mais longos costumam dar mais espaço ao movimento.',
    use: (label: string) => `Usar ${label}`,
    sharperTitle: (id: number) => `🎯 Uma versão mais precisa da #${id}`,
    testThis: 'Testar esta versão',
    sharperNote: 'Testar substitui o teste de estresse no seu card; nada é registrado até você apertar Registrar.',
    cantRead: (m: string) => `Não consegui ler ${m} agora. Tente de novo em um minuto.`,
    soon: 'em breve',
    netSoFar: 'líquido até agora',
    onTrack: (ok: boolean) => (ok ? 'No caminho até agora' : 'Ainda não chegou'),
    checksBack: (when: string) => `conferência ${when}`,
    measure: (s: ThesisSpec) => measureLabel(s, 'pt'),
    date: (ms: number) => new Date(ms).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/\.$/, ''),
    left: (checkAt: number, now: number) => {
      const days = (checkAt - now) / 86_400_000;
      return days < 1 ? 'menos de um dia' : Math.round(days) === 1 ? '1 dia' : `${Math.round(days)} dias`;
    },
  },
  es: {
    lean: { for: 'La evidencia se inclina a favor de la tesis.', against: 'La evidencia se inclina en contra de la tesis.', even: 'La evidencia está dividida.' },
    stressTest: 'Prueba de estrés',
    fullCase: 'Análisis completo',
    wrongIf: 'Falla si',
    caseTitle: (claim: string) => `Análisis completo · ${claim}`,
    thesis: (id: number) => `Tesis #${id}`,
    onRecord: 'registrada',
    agedWell: 'acertó ✓',
    agedBadly: 'falló ✗',
    voided: 'anulada',
    notLogged: 'sin registrar',
    readAs: 'entendido como',
    loggedAt: (m: string, v: string, when: string) => `Registrada con ${m} en ${v} · revisión ${when}`,
    net: 'neto',
    logIt: 'Registrar',
    floorNow: (v: string) => `**Floor ahora:** ${v}`,
    floorLine: 'Aquí está. Regístrala si la sostienes.',
    floorNeeds: (change: string, days: number) => `Necesita ${change} en ${days === 1 ? 'un día' : `${days} días`}, y cuenta en cuanto el floor llegue ahí.`,
    timeframes: 'Otros plazos',
    sharpen: 'Hacerla más precisa',
    notNow: 'Ahora no',
    withYou: 'Estoy contigo',
    against: 'Estoy en contra',
    progress: '¿Cómo va?',
    duel: (a: string, b: string) => `⚔️ Duelo: ${a} vs ${b}`,
    for: 'A favor',
    againstHeading: 'En contra',
    kill: 'Qué demostraría que está mal',
    history: 'Historia',
    analysts: (days: number, parts: string) => `Analistas de newsletters, últimos ${days} días · ${parts}`,
    analystSplit: (ticker: string, bull: number, bear: number) => `${ticker}: ${bull} alcistas, ${bear} bajistas`,
    sides: (w: number, a: number) => `A favor **${w}** · En contra **${a}**`,
    sideWith: 'a favor',
    sideAgainst: 'en contra',
    draftFooter: (when: string, data: string) => `Regístrala para que quede constancia y recibir la revisión ${when} · datos: ${data}`,
    checkIn: (days: number, date: string) => (days === 1 ? 'mañana' : `en ${days} días, hacia el ${date}`),
    footer: (data: string) => `Datos: ${data} · evidencia, no una predicción`,
    checkBack: (id: number) => `Revisión · tesis #${id}`,
    reachedEarly: 'Llegó al nivel antes de la fecha de revisión, así que cuenta.',
    duelWin: (winner: string, loser: string) => `⚔️ Duelo: ${winner} gana a ${loser}.`,
    contrarian: (a: number, n: number) => `Victoria a contracorriente: ${a} de ${n} estaban en contra.`,
    readItRight: 'Acertaron',
    missed: 'Fallaron',
    sinceLogged: 'desde el registro',
    littleTime: 'poco tiempo',
    theCheckBack: 'la revisión',
    reached: (where: string, left: string, by: string) => `**En camino.** ${where}: pasó la línea con ${left} por delante. Aún tiene que estar ahí el ${by}.`,
    slipped: (where: string, left: string, by: string) => `**Lo devolvió.** ${where}: otra vez por debajo de la línea, quedan ${left} hasta el ${by}.`,
    pressure: (where: string, left: string) => `**Bajo presión.** ${where}: más en contra de la tesis que su rango habitual para todo el plazo, con ${left} por delante.`,
    days: (d: number) => (d === 1 ? '1 día' : d % 30 === 0 && d >= 30 ? (d === 30 ? '1 mes' : `${d / 30} meses`) : d % 7 === 0 ? (d === 7 ? '1 semana' : `${d / 7} semanas`) : `${d} días`),
    tfRow: (label: string, rate: number, windows: string) => `${label}: ${rate}% de ${windows} ventanas`,
    thisTake: 'esta tesis',
    median: 'mediana',
    tfTitle: (claim: string) => `⏱ Misma tesis, otros plazos · ${claim}`,
    tfIntro: 'Con qué frecuencia ha pasado antes el movimiento que necesita:',
    tfNote: 'Historia, no predicción. Los plazos más largos suelen dar más margen al movimiento.',
    use: (label: string) => `Usar ${label}`,
    sharperTitle: (id: number) => `🎯 Una versión más precisa de la #${id}`,
    testThis: 'Probar esta versión',
    sharperNote: 'Probarla reemplaza la prueba de estrés de tu tarjeta; nada se registra hasta que pulses Registrar.',
    cantRead: (m: string) => `No pude leer ${m} ahora. Inténtalo de nuevo en un minuto.`,
    soon: 'pronto',
    netSoFar: 'neto hasta ahora',
    onTrack: (ok: boolean) => (ok ? 'Va bien por ahora' : 'Todavía no llega'),
    checksBack: (when: string) => `revisión ${when}`,
    measure: (s: ThesisSpec) => measureLabel(s, 'es'),
    date: (ms: number) => new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/\.$/, ''),
    left: (checkAt: number, now: number) => {
      const days = (checkAt - now) / 86_400_000;
      return days < 1 ? 'menos de un día' : Math.round(days) === 1 ? '1 día' : `${Math.round(days)} días`;
    },
  },
};
type Words = (typeof WORDS)['en'];
const wordsFor = (t: Thesis): Words => WORDS[t.analysis?.lang ?? 'en'] as Words;

/** A measure value in its own units: a price, a ratio, or a flow total. */
export function formatMeasure(spec: ThesisSpec, value: number): string {
  if (spec.nft) return nftAmount(value, spec.nft.currency);
  if (spec.kind === 'flows') return formatUsd(value, true);
  if (spec.kind === 'relative') return value.toPrecision(4);
  return formatPrice(value);
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

function change(t: Thesis, end: number, w: Words = wordsFor(t)): string {
  if (t.spec.kind === 'flows' || t.startValue === null) return `**${formatMeasure(t.spec, end)}** ${w.net}`;
  return `**${formatMeasure(t.spec, t.startValue)} → ${formatMeasure(t.spec, end)}** (${pct(end / t.startValue - 1)})`;
}

/** The stress-test card, which becomes the thesis on the record once logged and shows its result once checked. */
export function thesisContainer(t: Thesis, sides: Sides, opts: { chart?: boolean } = {}): ContainerBuilder {
  const w = wordsFor(t);
  const a = t.analysis.argument;
  const who = `<@${t.authorId}>`;
  const status =
    t.status === 'draft'
      ? `⚖️ ${w.stressTest} · ${who}`
      : `⚖️ ${w.thesis(t.id)} · ${who} · ${
          t.status === 'open' ? w.onRecord : t.status === 'aged_well' ? w.agedWell : t.status === 'aged_badly' ? w.agedBadly : t.status === 'void' ? w.voided : w.notLogged
        }`;
  const timeline =
    t.status === 'open' && t.checkAt
      ? kicker(w.loggedAt(w.measure(t.spec), formatMeasure(t.spec, t.startValue ?? 0), discordTime(t.checkAt, 'R')))
      : (t.status === 'aged_well' || t.status === 'aged_badly') && t.endValue !== null
        ? `${w.measure(t.spec)} ${change(t, t.endValue, w)}`
        : null;

  // The rest of the argument (every point, history, analysts, how the take was read) is one tap away, privately.
  const fullCase = t.spec.nft ? [] : [button('case', t.id, w.fullCase)];
  const buttons =
    t.status === 'draft'
      ? row(
          button('log', t.id, w.logIt, ButtonStyle.Primary),
          ...fullCase,
          ...(t.spec.kind !== 'flows' && !t.spec.nft ? [button('timeframes', t.id, w.timeframes), button('sharpen', t.id, w.sharpen)] : []),
          button('drop', t.id, w.notNow),
        )
      : t.status === 'open'
        ? row(button('with', t.id, w.withYou), button('against', t.id, w.against), button('progress', t.id, w.progress), ...fullCase)
        : fullCase.length
          ? row(...fullCase)
          : null;
  const debate = sides.with.length + sides.against.length > 0;
  const duel = t.challengerId ? w.duel(who, `<@${t.challengerId}>`) : null;
  // NFT floor takes have no debate: where the floor was when tested, and what the take needs from there.
  const floor = t.spec.nft ? t.analysis.floor : undefined;
  const need = floor ? (t.spec.kind === 'price' ? t.spec.target! / floor.value - 1 : (t.spec.direction === 'up' ? 1 : -1) * (t.spec.pct ?? 0)) : null;
  const body = t.spec.nft
    ? [
        floor && w.floorNow(`${formatMeasure(t.spec, floor.value)}${floor.usd ? ` (about ${formatUsd(floor.usd)})` : ''}`),
        need !== null && need !== 0 && w.floorNeeds(pct(need), t.spec.horizonDays),
      ]
    : [
        // Short enough to read in a glance: the strongest two points a side and what would prove it wrong.
        [
          ...a.for.slice(0, 2).map((p) => `**${w.for}** · ${p.point}`),
          ...a.against.slice(0, 2).map((p) => `**${w.againstHeading}** · ${p.point}`),
          // Older takes wrote it as "If …"; after "Wrong if" that reads twice.
          a.kill && `**${w.wrongIf}** · ${a.kill.replace(/^(if|si|se)\s+/i, '')}`,
        ]
          .filter(Boolean)
          .join('\n'),
      ];

  return card(EDGE[t.status], [
    kicker(status),
    heading(t.claim),
    // The answer first: which way the evidence leans, in one line.
    !t.spec.nft && `**${w.lean[a.lean]}**${a.verdict ? ` ${a.verdict}` : ''}`,
    timeline,
    opts.chart && picture(CHART_NAME, t.claim),
    ...body,
    (t.status !== 'draft' || debate) && divider(),
    t.status !== 'draft' && w.sides(sides.with.length, sides.against.length),
    duel,
    debate && kicker([...sides.with.map((u) => `<@${u}> ${w.sideWith}`), ...sides.against.map((u) => `<@${u}> ${w.sideAgainst}`)].slice(0, 20).join(' · ')),
    buttons,
    kicker(
      t.status === 'draft'
        ? w.draftFooter(w.checkIn(t.spec.horizonDays, w.date(t.createdAt + t.spec.horizonDays * 86_400_000)), t.analysis.sources.join(', '))
        : w.footer(t.analysis.sources.join(', ')),
    ),
  ]);
}

/** Everything behind a take's card, shown privately on "Full case": how it was read, every point, history, analysts. */
export function caseContainer(t: Thesis): ContainerBuilder {
  const w = wordsFor(t);
  const a = t.analysis.argument;
  return card(EDGE[t.status], [
    kicker(w.caseTitle(t.claim)),
    kicker(`"${t.take.length > 140 ? `${t.take.slice(0, 139)}…` : t.take}"${t.analysis.assumptions.length ? ` · ${w.readAs}: ${t.analysis.assumptions.join('; ')}` : ''}`),
    `**${w.lean[a.lean]}**${a.verdict ? ` ${a.verdict}` : ''}`,
    divider(),
    `**${w.for}**`,
    ...a.for.map((p) => `· ${p.point}`),
    `**${w.againstHeading}**`,
    ...a.against.map((p) => `· ${p.point}`),
    divider(),
    a.kill && `**${w.kill}:** ${a.kill}`,
    a.history && `**${w.history}:** ${a.history}`,
    // Counted in code when it was tested: each analyst once, by their latest call.
    !!t.analysis.analysts?.length &&
      kicker(w.analysts(t.analysis.analysts[0]!.days, t.analysis.analysts.map((x) => w.analystSplit(x.ticker, x.bullish, x.bearish)).join(' · '))),
    kicker(w.footer(t.analysis.sources.join(', '))),
  ]);
}

/** The line above an NFT floor take's card: written in code, since the card has no debate to react to. */
export function floorTakeLine(t: Thesis): string {
  return wordsFor(t).floorLine;
}

export function thesisCard(t: Thesis, sides: Sides, opts: { chart?: boolean } = {}) {
  return cards([thesisContainer(t, sides, opts)]);
}

/** The check-back, posted as a reply to the thesis card: how it aged and who read it right. Pings the author only. */
export function verdictPost(v: Verdict, sides: Sides, opts: { chart?: boolean } = {}) {
  const t = v.thesis;
  const w = wordsFor(t);
  const right = v.held ? sides.with : sides.against;
  const missed = v.held ? sides.against : sides.with;
  const contrarian = v.held && sides.against.length > sides.with.length;
  const challenger = t.challengerId;
  const duel = challenger ? w.duelWin(`<@${v.held ? t.authorId : challenger}>`, `<@${v.held ? challenger : t.authorId}>`) : null;
  return cards(
    [
      card(v.held ? ACCENT.right : ACCENT.wrong, [
        kicker(`⚖️ ${w.checkBack(t.id)} · <@${t.authorId}>`),
        heading(`${t.claim} · ${v.held ? w.agedWell : w.agedBadly}`),
        `${w.measure(t.spec)} ${change(t, v.endValue, w)}`,
        v.held && t.settledAt !== null && t.checkAt !== null && t.settledAt < t.checkAt && kicker(w.reachedEarly),
        opts.chart && picture(CHART_NAME, t.claim),
        duel,
        contrarian && w.contrarian(sides.against.length, sides.with.length + sides.against.length),
        right.length > 0 && kicker(`${w.readItRight}: ${right.slice(0, 15).map((u) => `<@${u}>`).join(' ')}`),
        missed.length > 0 && kicker(`${w.missed}: ${missed.slice(0, 15).map((u) => `<@${u}>`).join(' ')}`),
        row(myPageButton(t.guildId)),
      ]),
    ],
    // Named on the post, but nobody is notified: members look when they want to.
  );
}

/** A mid-take moment, posted as a reply to the thesis card. Switched off for now; notifies nobody. */
export function momentPost(t: Thesis, kind: MomentKind, value: number, now: number) {
  const w = wordsFor(t);
  const left = t.checkAt ? w.left(t.checkAt, now) : w.littleTime;
  const by = t.checkAt ? w.date(t.checkAt) : w.theCheckBack;
  const where = `${w.measure(t.spec)} ${formatMeasure(t.spec, value)}${t.startValue ? ` (${w.sinceLogged} ${pct(value / t.startValue - 1)})` : ''}`;
  const line = kind === 'reached' ? w.reached(where, left, by) : kind === 'slipped' ? w.slipped(where, left, by) : w.pressure(where, left);
  return cards(
    [
      card(kind === 'pressure' ? ACCENT.muted : ACCENT.open, [
        kicker(`⚖️ ${w.thesis(t.id)} · <@${t.authorId}>`),
        `${t.claim}\n${line}`,
        row(button('progress', t.id, w.progress)),
      ]),
    ],
    // Unused while mid-take moments are off; never notifies anyone.
  );
}

/** "Other timeframes": how often the same move happened over other windows, with a way to switch (author only). */
export function timeframesContainer(t: Thesis, rows: { days: number; rate: number; windows: number; median: number }[], canSwitch: boolean) {
  const w = wordsFor(t);
  const lines = rows.map((r) => {
    const mine = r.days === t.spec.horizonDays;
    const line = w.tfRow(w.days(r.days), Math.round(r.rate * 100), r.windows.toLocaleString('en-US'));
    return `${mine ? `**${line} · ${w.thisTake}**` : line} · ${w.median} ${pct(r.median)}`;
  });
  const options = rows.filter((r) => r.days !== t.spec.horizonDays).slice(0, 4);
  return card(ACCENT.amber, [
    kicker(w.tfTitle(t.claim)),
    w.tfIntro,
    lines.join('\n'),
    kicker(w.tfNote),
    canSwitch && options.length > 0 && row(...options.map((r) => button('retime', t.id, w.use(w.days(r.days)), ButtonStyle.Secondary, r.days))),
  ]);
}

/** "Make it sharper": the proposed version, with a button to test it instead. */
export function sharpenContainer(t: Thesis, proposal: { claim: string; why: string }): ContainerBuilder {
  const w = wordsFor(t);
  return card(ACCENT.amber, [
    kicker(w.sharperTitle(t.id)),
    `~~${t.claim}~~\n**${proposal.claim}**`,
    proposal.why,
    row(button('sharpened', t.id, w.testThis, ButtonStyle.Primary)),
    kicker(w.sharperNote),
  ]);
}

/** Live progress for "How's it doing?". */
export function progressText(t: Thesis, now: number, value: number | null, holding: boolean | null): string {
  const w = wordsFor(t);
  if (value === null) return w.cantRead(w.measure(t.spec));
  const left = t.checkAt ? discordTime(t.checkAt, 'R') : w.soon;
  return [
    `**${w.thesis(t.id)}:** ${t.claim}`,
    `${w.measure(t.spec)} ${t.spec.kind === 'flows' ? `**${formatMeasure(t.spec, value)}** ${w.netSoFar}` : change(t, value, w)}`,
    `${w.onTrack(!!holding)} · ${w.checksBack(left)}`,
  ].join('\n');
}

/** A member's record of takes: /takes @member and the record view. With a chart of their recent form. */
export function recordContainer(name: string, r: Record, opts: { chart?: boolean; rank?: { rank: number; of: number; leader: Leader } | null } = {}): ContainerBuilder {
  const settled = r.agedWell + r.agedBadly;
  const duels = r.duels.won + r.duels.lost;
  const rival = r.duels.against[0];
  return card(ACCENT.page, [
    `## ⚖️ ${name}'s takes`,
    settled || r.open
      ? `**${r.agedWell}** aged well · **${r.agedBadly}** aged badly · **${r.open}** open${settled ? ` · ${Math.round((r.agedWell / settled) * 100)}% hit rate` : ''}`
      : 'Nothing on the record yet.',
    opts.rank && `**Leaderboard:** ${ordinal(opts.rank.rank)} of ${opts.rank.of} · ${opts.rank.leader.right} right calls (${leaderDetail(opts.rank.leader)})`,
    opts.chart && picture(CHART_NAME, `${name}'s recent takes`),
    r.bold.total > 0 && `**Bold takes** (history said under 25%): ${r.bold.right} of ${r.bold.total} aged well`,
    r.bestAsset && `**Reads ${r.bestAsset.asset} best:** ${r.bestAsset.right} of ${r.bestAsset.total}`,
    r.contrarianWins > 0 && `**Contrarian wins:** ${r.contrarianWins}`,
    duels > 0 && `**Duels:** ${r.duels.won}–${r.duels.lost}${rival ? ` · vs <@${rival.userId}> ${rival.won}–${rival.lost}` : ''}`,
    r.best && `**Best take:** #${r.best.id} ${r.best.claim}`,
    r.sidesSettled > 0 && `**Sides taken:** read ${r.sidesRight} of ${r.sidesSettled} right`,
    kicker('Bring a take: @Ledger and say what you think will happen'),
  ]);
}

/** The server's debates and records: /takes with no member. */
/** "4 of 6 takes, 9 of 12 sides": what a leaderboard row is made of. */
export function leaderDetail(l: Leader): string {
  return [l.takes ? `${l.takesRight} of ${l.takes} ${l.takes === 1 ? 'take' : 'takes'}` : null, l.sides ? `${l.sidesRight} of ${l.sides} ${l.sides === 1 ? 'side' : 'sides'}` : null]
    .filter(Boolean)
    .join(', ');
}

export function boardContainer(open: { t: Thesis; sides: Sides }[], leaders: Leader[], opts: { chart?: boolean } = {}): ContainerBuilder {
  const hottest = [...open].sort((a, b) => b.sides.with.length + b.sides.against.length - (a.sides.with.length + a.sides.against.length)).slice(0, 6);
  return card(ACCENT.page, [
    '## ⚖️ The takes',
    '**Open debates**',
    hottest.length
      ? hottest.map(({ t, sides }) => `#${t.id} ${t.claim} · <@${t.authorId}> · with ${sides.with.length}, against ${sides.against.length} · ${discordTime(t.checkAt!, 'R')}`).join('\n')
      : kicker('None yet. Bring one: @Ledger and say what you think will happen'),
    leaders.length > 0 && divider(),
    leaders.length > 0 && '**Leaderboard**',
    leaders.length > 0 && kicker('Right calls: your own takes that aged well, plus the sides you took that turned out right.'),
    opts.chart && picture(CHART_NAME, 'Leaderboard'),
    leaders.length > 0 && leaders.slice(0, 10).map((l, i) => `${i + 1}. <@${l.userId}> · ${l.right} right (${leaderDetail(l)})`).join('\n'),
    leaders.length > 0 && kicker('Ask me "what\'s my rank?" for your exact place.'),
  ]);
}
