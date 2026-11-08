import { ButtonBuilder, ButtonStyle } from 'discord.js';
import { type BarRule, formatLevel, questionText } from '../bar/questions.js';
import type { BarQuestion, BarVote } from '../bar/store.js';
import { BAR_IMAGE } from '../charts/maker.js';
import { discordTime } from '../format.js';
import type { Lang } from '../lang.js';
import { ACCENT, card, heading, kicker, picture, row } from './ui.js';

/**
 * The daily bar question's card. Open: the question, its chart and the With and Against buttons. Closed:
 * how the answers split and Ledger's side. Settled: what happened and who read it right. Nobody is pinged,
 * nothing is scored. Times are Discord timestamps, so every member sees their own time.
 */

export type BarAction = 'with' | 'against';
export const barButtonId = (action: BarAction, id: number) => `bar:${action}:${id}`;
export function parseBarButtonId(customId: string): { action: BarAction; id: number } | null {
  const m = /^bar:(with|against):(\d+)$/.exec(customId);
  return m ? { action: m[1] as BarAction, id: Number(m[2]) } : null;
}

const pct = (x: number) => `${(Math.abs(x) * 100).toFixed(1)}%`;

const WORDS = {
  en: {
    label: 'Bar question',
    chartResult: 'result',
    with: 'With',
    against: 'Against',
    side: (v: number) => (v === 1 ? 'with' : 'against'),
    howTo: (close: string) => `**With** if you think yes, **Against** if you think no. You can switch until ${close}.`,
    answers: (n: number) => (n === 1 ? '1 answer so far' : `${n} answers so far`),
    resultAt: (t: string) => `result ${t}`,
    now: (asset: string, v: string) => `${asset} now ${v}`,
    closed: (w: number, a: number) => `**Answers are in:** ${w} with · ${a} against.`,
    ledger: (side: string, share: string) => `Ledger is ${side}: over the past year this happened on ${share} of days.`,
    result: (yes: boolean) => `**Result: ${yes ? 'yes' : 'no'}.**`,
    moved: (asset: string, a: string, b: string) => `${asset} went from ${a} to ${b}.`,
    relative: (a: string, v: string, p: string, better: boolean) => `${a} did ${p} ${better ? 'better' : 'worse'} than ${v}.`,
    readRight: (n: number, total: number) => `${n} of ${total} read it right`,
    nobody: 'Nobody answered this one.',
    ledgerResult: (right: boolean) => (right ? 'Ledger read it right too.' : 'Ledger missed this one.'),
    void: "No price came in, so this one doesn't count.",
    rightNames: 'Read it right',
    missedNames: 'Missed',
    voted: (side: string) => `You're **${side}**.`,
    switched: (side: string) => `Switched: you're **${side}** now.`,
    same: (side: string) => `You're already **${side}**.`,
    until: (t: string) => `You can change it until ${t}.`,
    locked: 'Answers on this one are closed. The next question posts tomorrow.',
  },
  pt: {
    label: 'Pergunta do bar',
    chartResult: 'resultado',
    with: 'A favor',
    against: 'Contra',
    side: (v: number) => (v === 1 ? 'a favor' : 'contra'),
    howTo: (close: string) => `**A favor** se você acha que sim, **Contra** se acha que não. Dá para mudar até ${close}.`,
    answers: (n: number) => (n === 1 ? '1 resposta até agora' : `${n} respostas até agora`),
    resultAt: (t: string) => `resultado ${t}`,
    now: (asset: string, v: string) => `${asset} agora ${v}`,
    closed: (w: number, a: number) => `**Respostas fechadas:** ${w} a favor · ${a} contra.`,
    ledger: (side: string, share: string) => `O Ledger está ${side}: no último ano isso aconteceu em ${share} dos dias.`,
    result: (yes: boolean) => `**Resultado: ${yes ? 'sim' : 'não'}.**`,
    moved: (asset: string, a: string, b: string) => `O ${asset} foi de ${a} para ${b}.`,
    relative: (a: string, v: string, p: string, better: boolean) => `O ${a} rendeu ${p} ${better ? 'a mais' : 'a menos'} que o ${v}.`,
    readRight: (n: number, total: number) => `${n} de ${total} acertaram`,
    nobody: 'Ninguém respondeu esta.',
    ledgerResult: (right: boolean) => (right ? 'O Ledger também acertou.' : 'O Ledger errou esta.'),
    void: 'O preço não chegou, então esta não conta.',
    rightNames: 'Acertaram',
    missedNames: 'Erraram',
    voted: (side: string) => `Você está **${side}**.`,
    switched: (side: string) => `Mudou: agora você está **${side}**.`,
    same: (side: string) => `Você já está **${side}**.`,
    until: (t: string) => `Dá para mudar até ${t}.`,
    locked: 'As respostas desta já fecharam. A próxima pergunta sai amanhã.',
  },
  es: {
    label: 'Pregunta del bar',
    chartResult: 'resultado',
    with: 'A favor',
    against: 'En contra',
    side: (v: number) => (v === 1 ? 'a favor' : 'en contra'),
    howTo: (close: string) => `**A favor** si crees que sí, **En contra** si crees que no. Puedes cambiar hasta ${close}.`,
    answers: (n: number) => (n === 1 ? '1 respuesta hasta ahora' : `${n} respuestas hasta ahora`),
    resultAt: (t: string) => `resultado ${t}`,
    now: (asset: string, v: string) => `${asset} ahora ${v}`,
    closed: (w: number, a: number) => `**Respuestas cerradas:** ${w} a favor · ${a} en contra.`,
    ledger: (side: string, share: string) => `Ledger está ${side}: en el último año esto pasó en ${share} de los días.`,
    result: (yes: boolean) => `**Resultado: ${yes ? 'sí' : 'no'}.**`,
    moved: (asset: string, a: string, b: string) => `${asset} pasó de ${a} a ${b}.`,
    relative: (a: string, v: string, p: string, better: boolean) => `A ${a} le fue ${p} ${better ? 'mejor' : 'peor'} que a ${v}.`,
    readRight: (n: number, total: number) => `${n} de ${total} acertaron`,
    nobody: 'Nadie respondió esta.',
    ledgerResult: (right: boolean) => (right ? 'Ledger también acertó.' : 'Ledger falló esta.'),
    void: 'No llegó el precio, así que esta no cuenta.',
    rightNames: 'Acertaron',
    missedNames: 'Fallaron',
    voted: (side: string) => `Estás **${side}**.`,
    switched: (side: string) => `Cambiaste: ahora estás **${side}**.`,
    same: (side: string) => `Ya estás **${side}**.`,
    until: (t: string) => `Puedes cambiarlo hasta ${t}.`,
    locked: 'Las respuestas de esta ya cerraron. La próxima pregunta sale mañana.',
  },
  zh: {
    label: '酒吧每日一问',
    chartResult: '结果',
    with: '支持',
    against: '反对',
    side: (v: number) => (v === 1 ? '支持' : '反对'),
    howTo: (close: string) => `觉得会就点 **支持**，觉得不会就点 **反对**。${close} 之前都可以改。`,
    answers: (n: number) => `目前 ${n} 人回答`,
    resultAt: (t: string) => `${t} 公布结果`,
    now: (asset: string, v: string) => `${asset} 现在 ${v}`,
    closed: (w: number, a: number) => `**回答已截止：** ${w} 人支持 · ${a} 人反对。`,
    ledger: (side: string, share: string) => `Ledger 选${side}：过去一年里，有 ${share} 的日子是这样。`,
    result: (yes: boolean) => `**结果：${yes ? '是' : '否'}。**`,
    moved: (asset: string, a: string, b: string) => `${asset} 从 ${a} 到 ${b}。`,
    relative: (a: string, v: string, p: string, better: boolean) => `${a} 比 ${v} ${better ? '强' : '弱'} ${p}。`,
    readRight: (n: number, total: number) => `${total} 人里 ${n} 人答对`,
    nobody: '这题没有人回答。',
    ledgerResult: (right: boolean) => (right ? 'Ledger 也答对了。' : 'Ledger 这次答错了。'),
    void: '没有拿到价格，这题不算。',
    rightNames: '答对',
    missedNames: '答错',
    voted: (side: string) => `你选了 **${side}**。`,
    switched: (side: string) => `已改为 **${side}**。`,
    same: (side: string) => `你已经选了 **${side}**。`,
    until: (t: string) => `${t} 之前都可以改。`,
    locked: '这题已经截止回答，明天会有新问题。',
  },
  ja: {
    label: 'バーの今日の質問',
    chartResult: '結果',
    with: '賛成',
    against: '反対',
    side: (v: number) => (v === 1 ? '賛成' : '反対'),
    howTo: (close: string) => `そう思うなら **賛成**、思わないなら **反対**。${close} まで変更できます。`,
    answers: (n: number) => `現在 ${n} 件の回答`,
    resultAt: (t: string) => `結果は ${t}`,
    now: (asset: string, v: string) => `${asset} 現在 ${v}`,
    closed: (w: number, a: number) => `**回答締め切り：** 賛成 ${w} · 反対 ${a}`,
    ledger: (side: string, share: string) => `Ledger は${side}：過去1年でこうなった日は ${share} です。`,
    result: (yes: boolean) => `**結果：${yes ? 'はい' : 'いいえ'}。**`,
    moved: (asset: string, a: string, b: string) => `${asset} は ${a} から ${b} になりました。`,
    relative: (a: string, v: string, p: string, better: boolean) => `${a} は ${v} より ${p} ${better ? '強かった' : '弱かった'}。`,
    readRight: (n: number, total: number) => `${total} 人中 ${n} 人が正解`,
    nobody: 'この質問には回答がありませんでした。',
    ledgerResult: (right: boolean) => (right ? 'Ledger も正解でした。' : 'Ledger は今回は外れでした。'),
    void: '価格が取れなかったので、この質問は無効です。',
    rightNames: '正解',
    missedNames: '不正解',
    voted: (side: string) => `**${side}** にしました。`,
    switched: (side: string) => `**${side}** に変更しました。`,
    same: (side: string) => `すでに **${side}** です。`,
    until: (t: string) => `${t} まで変更できます。`,
    locked: 'この質問の回答は締め切りました。次の質問は明日です。',
  },
};
type Words = (typeof WORDS)['en'];
export const barWords = (lang: Lang): Words => WORDS[lang] as Words;

/** "BTC went from 80,750 to 81,900." or "ETH did 1.2% better than BTC." */
function movedLine(w: Words, rule: BarRule, start: number, end: number): string {
  if (rule.kind === 'beats') return w.relative(rule.asset, rule.versus!, pct(end / start - 1), end > start);
  return w.moved(rule.asset, formatLevel(start), formatLevel(end));
}

/** Up to 25 names as mentions that notify nobody (the card's messages never ping). */
const names = (votes: BarVote[]) => `${votes.slice(0, 25).map((v) => `<@${v.userId}>`).join(' ')}${votes.length > 25 ? ` +${votes.length - 25}` : ''}`;

/**
 * The result, posted once as its own short message (a reply to the question) when the 24 hours are up:
 * what happened, who read it right and who missed, by name, without pinging anyone.
 */
export function barResultContainer(q: BarQuestion, votes: BarVote[]) {
  const w = barWords(q.lang);
  const header = [kicker(`${w.label} · ${w.chartResult}`), heading(questionText(q.rule, q.lang))];
  if (q.status === 'void') return card(ACCENT.muted, [...header, w.void]);
  const right = votes.filter((v) => v.value === q.outcome);
  const missed = votes.filter((v) => v.value !== q.outcome);
  return card(q.outcome === 1 ? ACCENT.right : ACCENT.wrong, [
    ...header,
    `${w.result(q.outcome === 1)} ${movedLine(w, q.rule, q.startValue, q.endValue!)}`,
    right.length ? `✓ **${w.rightNames} (${right.length}):** ${names(right)}` : null,
    missed.length ? `✗ **${w.missedNames} (${missed.length}):** ${names(missed)}` : null,
    kicker(votes.length ? w.ledgerResult(q.ledger === q.outcome) : w.nobody),
  ]);
}

export function barQuestionContainer(q: BarQuestion, votes: BarVote[], opts: { chart?: boolean } = {}) {
  const w = barWords(q.lang);
  const withCount = votes.filter((v) => v.value === 1).length;
  const share = `${Math.round(q.ledgerShare * 100)}%`;
  const date = new Date(q.opensAt).toLocaleDateString(q.lang === 'en' ? 'en-GB' : { pt: 'pt-BR', es: 'es-ES', zh: 'zh-CN', ja: 'ja-JP' }[q.lang], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const header = [kicker(`${w.label} · ${date}`), heading(questionText(q.rule, q.lang)), opts.chart && picture(BAR_IMAGE, questionText(q.rule, q.lang))];

  if (q.status === 'open') {
    return card(ACCENT.amber, [
      ...header,
      w.howTo(discordTime(q.closesAt, 't')),
      kicker(
        [w.answers(votes.length), w.resultAt(discordTime(q.settlesAt, 'R')), q.rule.kind !== 'beats' && w.now(q.rule.asset, formatLevel(q.startValue))]
          .filter(Boolean)
          .join(' · '),
      ),
      row(
        new ButtonBuilder().setCustomId(barButtonId('with', q.id)).setLabel(w.with).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(barButtonId('against', q.id)).setLabel(w.against).setStyle(ButtonStyle.Danger),
      ),
    ]);
  }
  if (q.status === 'closed') {
    return card(ACCENT.open, [
      ...header,
      w.closed(withCount, votes.length - withCount),
      kicker(`${w.ledger(w.side(q.ledger), share)} · ${w.resultAt(discordTime(q.settlesAt, 'R'))}`),
    ]);
  }
  if (q.status === 'void') return card(ACCENT.muted, [...header, w.void]);

  const right = votes.filter((v) => v.value === q.outcome);
  return card(q.outcome === 1 ? ACCENT.right : ACCENT.wrong, [
    ...header,
    `${w.result(q.outcome === 1)} ${movedLine(w, q.rule, q.startValue, q.endValue!)}`,
    votes.length ? `${w.readRight(right.length, votes.length)}.` : w.nobody,
    kicker(`${w.closed(withCount, votes.length - withCount).replace(/\*\*/g, '')} ${w.ledgerResult(q.ledger === q.outcome)}`),
  ]);
}
