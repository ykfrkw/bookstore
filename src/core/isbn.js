/**
 * ISBN の正規化・検証・相互変換。
 * Amazon の和書は ASIN が ISBN-10 と一致することが多いが、
 * 洋書・ISBN-13 のみの新刊・Kindle 版は一致しないので必ず検証する。
 */

/** 入力から数字と X 以外を落とす */
export function normalize(raw) {
  if (!raw) return '';
  return String(raw).toUpperCase().replace(/[^0-9X]/g, '');
}

export function isValidIsbn10(s) {
  const v = normalize(s);
  if (!/^[0-9]{9}[0-9X]$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(v[i]);
  const check = v[9] === 'X' ? 10 : Number(v[9]);
  return (sum + check) % 11 === 0;
}

export function isValidIsbn13(s) {
  const v = normalize(s);
  if (!/^[0-9]{13}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(v[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(v[12]);
}

export function toIsbn13(s) {
  const v = normalize(s);
  if (isValidIsbn13(v)) return v;
  if (!isValidIsbn10(v)) return null;
  const body = '978' + v.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

export function toIsbn10(s) {
  const v = normalize(s);
  if (isValidIsbn10(v)) return v;
  if (!isValidIsbn13(v) || !v.startsWith('978')) return null;
  const body = v.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body[i]);
  const rem = (11 - (sum % 11)) % 11;
  return body + (rem === 10 ? 'X' : String(rem));
}

/** 表示用ハイフン区切りは版元により区切り位置が違うため、あえて付けない */
export function display(s) {
  const v = toIsbn13(s);
  return v || normalize(s);
}

/**
 * 対応サイトの URL / ページ文字列から ISBN 候補を拾う。
 * DOM に依存しない純関数にしてあるので、ローカルページでも同じものを使う。
 * URL 判定はホストごとに分岐し、該当ホスト以外では従来（Amazon）どおり動く。
 * @param {{url?: string, text?: string}} input
 * @returns {{isbn13: string|null, source: string}}
 */
export function extractIsbn({ url = '', text = '' } = {}) {
  // 0) 紀伊國屋ウェブストア: /f/dsg-01-<13桁>（和書）・dsg-02（洋書）に ISBN-13 が
  //    直接埋め込まれている。dsg-08（電子書籍）は意図的に対象外 —
  //    電子版の ISBN で紙の本を発注する事故を防ぐため。
  //    チェックディジット不正なら URL 経路では採用せず、テキスト経路に落とす。
  const kino = url.match(
    /^https?:\/\/(?:[^/]+\.)?kinokuniya\.co\.jp\/f\/dsg-0[12]-([0-9]{13})/i
  )?.[1];
  if (kino && isValidIsbn13(kino)) return { isbn13: kino, source: 'url-kinokuniya' };

  // 0') 丸善ジュンク堂ネットストア（Shopify 系）: /products/<13桁> が ISBN-13
  const mj = url.match(
    /^https?:\/\/(?:[^/]+\.)?maruzenjunkudo\.co\.jp\/products\/([0-9]{13})/i
  )?.[1];
  if (mj && isValidIsbn13(mj)) return { isbn13: mj, source: 'url-maruzen' };

  // 1) URL の ASIN が ISBN-10 として妥当なら採用（Amazon 和書のほとんどがこれ）
  const asin = url.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i)?.[1];
  if (asin && isValidIsbn10(asin)) {
    return { isbn13: toIsbn13(asin), source: 'asin' };
  }

  // 2) ページ本文の "ISBN-13: 978-..." 等
  const m13 = text.match(/ISBN[-\s]?13[^0-9]{0,10}((?:97[89][-\s]?)(?:[0-9][-\s]?){9}[0-9])/i);
  if (m13 && isValidIsbn13(m13[1])) return { isbn13: normalize(m13[1]), source: 'page-isbn13' };

  const m10 = text.match(/ISBN[-\s]?10[^0-9]{0,10}((?:[0-9][-\s]?){9}[0-9X])/i);
  if (m10 && isValidIsbn10(m10[1])) return { isbn13: toIsbn13(m10[1]), source: 'page-isbn10' };

  // 3) 裸の 13 桁（雑誌コード等の誤検出を避けるため 978/979 始まりに限定）
  const bare = text.match(/\b97[89][-\s]?(?:[0-9][-\s]?){9}[0-9]\b/);
  if (bare && isValidIsbn13(bare[0])) return { isbn13: normalize(bare[0]), source: 'page-bare' };

  return { isbn13: null, source: asin ? 'asin-not-isbn' : 'none' };
}
