/**
 * The languages Ledger's takes, cards, charts and fixed lines come in. Chat replies follow whatever language
 * the member writes in (the model handles that); the fixed text follows the conversation's language, read in
 * code from the members' own messages.
 */
export type Lang = 'en' | 'zh' | 'ja' | 'pt' | 'es';

/** How each language is named in instructions to the model. */
export const LANG_NAMES: { [L in Lang]: string } = {
  en: 'English',
  zh: 'Simplified Chinese',
  ja: 'Japanese',
  pt: 'Portuguese',
  es: 'Spanish',
};

const HAN = /[㐀-䶿一-鿿豈-﫿]/g;
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/g;

// Words common in one of the Latin-script languages and rare in the others. Shared words (que, como, para,
// mas, no, a, o) are left out on purpose: they can't tell Portuguese from Spanish.
const MARKERS: { [L in 'en' | 'pt' | 'es']: Set<string> } = {
  en: new Set(
    `the is are was were you your what how why when where who which will would should could can does did don't i my of to in
    it's i'm this that these those there they them their with from about think going today tomorrow price buy sell
    and but not have has had just like know good bad thanks thank hello hey english please much more than also`.split(/\s+/),
  ),
  pt: new Set(
    `não nao você voce vocês voces obrigado obrigada muito muita tudo isso isto consegue falar português portugues
    sim olá ola bom boa um uma uns umas com do da dos das ao aos na nas pra pro também tambem então entao agora
    hoje ontem amanhã amanha preço preco acho eu ele ela nós meu minha seu sua fazer pode vai tem estão
    ou é e quanto quanta qual quais aqui ainda já ja onde porquê bem obrigadão valeu beleza cara tá ta vou`.split(/\s+/),
  ),
  es: new Set(
    `sí hola gracias muy bien el los las la del al un una con pero y es son estoy estás tengo tienes hay hoy
    ayer mañana precio ahora entonces también porque cuándo cuál cuáles mejor bueno buena yo tú usted ustedes
    nosotros eso esto puedes hablar hablas español espanol qué cómo dónde creo vamos voy va van están pues
    todavía aquí muchas mucho`.split(/\s+/),
  ),
};

/**
 * The language of one message, or null when it's too short or too mixed to tell ("ok", "BTC?", a link).
 * Japanese and Chinese by script; English, Portuguese and Spanish by their own letters and common words.
 */
export function detectLang(raw: string): Lang | null {
  const text = raw.replace(/<[@#:&!a-z0-9_]+>/gi, ' ').replace(/https?:\/\/\S+/g, ' ');
  // Asking for a language by name counts as that language.
  if (/日本語/.test(text)) return 'ja';
  if (/中文|汉语|漢語/.test(text)) return 'zh';
  const kana = text.match(KANA)?.length ?? 0;
  const han = text.match(HAN)?.length ?? 0;
  const latin = text.match(/[A-Za-zÀ-ÿ]/g)?.length ?? 0;
  if (kana >= 1 && kana + han >= 2) return 'ja';
  // Tickers ("BTC", "ETH") and an English word or two don't make a Chinese message English.
  if (han >= 2 && han * 2 >= latin) return 'zh';

  const lower = text.toLowerCase();
  const score = { en: 0, pt: 0, es: 0 };
  // Letters only one of them uses.
  if (/[ãõç]/.test(lower)) score.pt += 2;
  if (/[ñ¿¡]/.test(lower)) score.es += 2;
  for (const word of lower.match(/[a-zà-ÿ']+/g) ?? []) {
    for (const lang of ['en', 'pt', 'es'] as const) if (MARKERS[lang].has(word)) score[lang]++;
  }
  const ranked = (Object.entries(score) as ['en' | 'pt' | 'es', number][]).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  return best![1] > 0 && best![1] > second![1] ? best![0] : null;
}

/** The language of one message, English when it can't be told. */
export function langOf(text: string): Lang {
  return detectLang(text) ?? 'en';
}

/**
 * The language of a conversation, from the members' messages (oldest first): the latest one that can be
 * told, so "ok" or "BTC?" after Portuguese stays Portuguese, while "in English please" switches.
 */
export function langOfThread(texts: string[]): Lang {
  for (let i = texts.length - 1; i >= 0; i--) {
    const lang = detectLang(texts[i]!);
    if (lang) return lang;
  }
  return 'en';
}

/** Whether a string has any Chinese or Japanese characters (for picking fonts). */
export function hasHan(text: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿぀-ヿㇰ-ㇿｦ-ﾟ]/.test(text);
}
