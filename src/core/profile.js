/**
 * 設定（プロフィール）のスキーマと既定値。
 *
 * 大学生協の公費運用は大学ごとに違う（備考欄に財源を書く方式、独自の公費 WEB
 * フォーム、外商担当へのメール、など）。ここを 1 つのオブジェクトに寄せておき、
 * 大学が変わっても設定だけ差し替えれば動くようにする。
 */

/** @typedef {{id:string,label:string,code:string,representative:string}} FundingSource */

export const DEFAULT_PROFILE = {
  requester: {
    name: '',
    kana: '',
    affiliation: '', // 例: ○○大学 医学部 精神医学教室
    email: '',
    phone: '',
    deliveryPlace: '', // 例: 医学部本館 3F 305 号室
  },

  coop: {
    label: '大学生協 書籍部',
    to: '', // 生協書籍部 / 外商担当のメールアドレス
    cc: '',
    receiveMethod: '研究室へ配達', // or '店頭受取'
    storeName: '', // 受取店舗名（店頭受取のとき）
    memberNumber: '', // 組合員番号（不要なら空）
  },

  bookstore: {
    label: '地元書店',
    to: '', // 書店の注文受付メールアドレス
    cc: '',
    receiveMethod: '店頭受取',
    storeName: '',
    customerNumber: '',
  },

  /** 研究費の財源。複数登録して注文時に選ぶ */
  fundingSources: /** @type {FundingSource[]} */ ([
    // { id: 'kakenhi-a', label: '科研費', code: '00X00000', representative: '' },
  ]),

  defaults: {
    route: 'coop', // 'coop' | 'bookstore'
    fundingMode: 'research', // 'research' | 'private'
    fundingSourceId: '',
    quantity: 1,
  },

  /** 文面の差し替え。大学生協ごとの決まり文句をここで吸収する */
  templates: {
    coopSubject: '【書籍注文】{funding} {name}（{count}点）',
    coopGreeting: '{orgLabel} 御中\n\nいつもお世話になっております。\n下記の書籍を注文いたします。',
    coopClosing: 'お手数をおかけしますが、よろしくお願いいたします。',
    bookstoreSubject: '【書籍お取り寄せのお願い】{name}（{count}点）',
    bookstoreGreeting:
      '{orgLabel} 御中\n\nお世話になっております。\n下記の書籍のお取り寄せをお願いできますでしょうか。',
    bookstoreClosing:
      'ご在庫・入荷可否をご確認のうえ、ご連絡いただけますと幸いです。\nどうぞよろしくお願いいたします。',
    /** 生協の備考欄に貼る 1 行（公費 WEB フォーム用にコピーできる） */
    remarksLine: '{fundingLabel} / 予算代表者: {representative} / 配達先: {deliveryPlace}',
  },
};

/** 保存済み設定を既定値にマージする（キー追加に強くする） */
export function withDefaults(saved) {
  const p = saved || {};
  const d = DEFAULT_PROFILE;
  return {
    requester: { ...d.requester, ...(p.requester || {}) },
    coop: { ...d.coop, ...(p.coop || {}) },
    bookstore: { ...d.bookstore, ...(p.bookstore || {}) },
    fundingSources: Array.isArray(p.fundingSources) ? p.fundingSources : [...d.fundingSources],
    defaults: { ...d.defaults, ...(p.defaults || {}) },
    templates: { ...d.templates, ...(p.templates || {}) },
  };
}

/** 送信前に足りない項目を返す。UI 側で赤字にする用 */
export function validate(profile, route) {
  const p = withDefaults(profile);
  const missing = [];
  if (!p.requester.name) missing.push('氏名');
  if (!p.requester.affiliation) missing.push('所属');
  if (!p.requester.email) missing.push('メールアドレス');
  const target = route === 'bookstore' ? p.bookstore : p.coop;
  if (!target.to) missing.push(route === 'bookstore' ? '書店の宛先メール' : '生協の宛先メール');
  return missing;
}

export function findFundingSource(profile, id) {
  return withDefaults(profile).fundingSources.find((s) => s.id === id) || null;
}
