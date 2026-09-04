/**
 * 設定（プロフィール）のスキーマと既定値。
 *
 * 大学生協の公費運用は大学ごとに違う（備考欄に財源を書く方式、独自の公費 WEB
 * フォーム、外商担当へのメール、など）。ここを 1 つのオブジェクトに寄せておき、
 * 大学が変わっても設定だけ差し替えれば動くようにする。
 *
 * 注文先は「生協 1 枠 + 書店 1 枠」の固定ではなく destinations[] にした。
 * 兼務・異動・複数キャンパスで宛先が 2 つ以上になるのが普通で、
 * 固定枠だと運用が破綻するため。財源（fundingSources）と同じ形にしてある。
 */

/** @typedef {{id:string,label:string,code:string,representative:string}} FundingSource */
/**
 * @typedef {{id:string, kind:'coop'|'bookstore', label:string, to:string, cc:string,
 *            receiveMethod:string, storeName:string, memberNumber:string}} Destination
 */

/** 宛先の種別。セレクトの選択肢と表示ラベルをここに集約する */
export const DESTINATION_KINDS = [
  { value: 'coop', label: '生協' },
  { value: 'bookstore', label: '書店' },
];

/** 種別ごとの既定の受取方法。新規追加時と旧設定の移行時の両方で使う */
const DEFAULT_RECEIVE_METHOD = { coop: '研究室へ配達', bookstore: '店頭受取' };

/**
 * メールの開き方。設定 UI のセレクトと mergeDefaults の丸めがここを唯一の
 * 出典にする（→ mailopen.js）。
 *
 * - `auto`   まず `mailto:` を試し、開けなかったと推定できたときだけ Gmail の
 *            退路を出す（既定。ハンドラ未登録の利用者を拾うため）
 * - `mailto` 既定のメーラーに固定する。**退路は出さない**（意図的な選択なので）
 * - `gmail`  Gmail の作成画面を新しいタブで開く
 */
export const MAIL_OPENERS = ['auto', 'mailto', 'gmail'];

/**
 * 旧スキーマ（v0.2 まで）の coop.label / bookstore.label の既定値。
 * どちらも非空で、旧 options は withDefaults() の出力をそのまま保存していたため、
 * 「生協しか設定していない人の bookstore.label」も既定値のまま残っている。
 * 移行時にこの値を「ユーザーが入力した中身」と見なすと幽霊宛先が生える。
 * 旧 options には書店の label 入力欄すら無かったので、この値＝未入力の印。
 */
const LEGACY_DEFAULT_LABELS = { coop: '大学生協 書籍部', bookstore: '地元書店' };

export const DEFAULT_PROFILE = {
  requester: {
    name: '',
    kana: '',
    affiliation: '', // 例: ○○大学 △△学部 ××研究室
    email: '',
    phone: '',
    deliveryPlace: '', // 例: △△棟 3F 305号室
  },

  /** 注文先。複数登録して注文時に選ぶ。既定は空で、未登録は validate が拾う */
  destinations: /** @type {Destination[]} */ ([]),

  /** 研究費の財源。複数登録して注文時に選ぶ */
  fundingSources: /** @type {FundingSource[]} */ ([
    // { id: 'kakenhi-a', label: '科研費', code: '00X00000', representative: '' },
  ]),

  defaults: {
    destinationId: '',
    fundingMode: 'research', // 'research' | 'private'
    fundingSourceId: '',
    quantity: 1,
    mailOpener: 'auto', // MAIL_OPENERS のいずれか
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
    /**
     * 簡略版（compose の compact）の挨拶・結び。
     *
     * 和文はフル版だと 1 冊でも mailto の長さ制限を超えるが、挨拶・結びを詰め、
     * 罫線・著者・出版社・発行年・合計行を落とすと収まる。収まれば本文入りで
     * メーラーが開き、貼り付けが要らなくなる（→ compose.js の pickMailPlan）。
     * ここを長くすると簡略版まで制限を超えてコピー経路に落ちるので、短く保つこと。
     * 「御中」を含めてあるのは、宛名の敬称も大学ごとの流儀に合わせて
     * 差し替えられるようにするため（フル版の *Greeting と同じ作り）。
     */
    coopCompactGreeting: '{orgLabel} 御中\n\n下記を注文します。',
    coopCompactClosing: 'よろしくお願いいたします。',
    bookstoreCompactGreeting:
      '{orgLabel} 御中\n\nお世話になっております。下記のお取り寄せをお願いします。',
    bookstoreCompactClosing: 'ご確認のうえご連絡ください。よろしくお願いいたします。',
    /** 生協の備考欄に貼る 1 行（公費 WEB フォーム用にコピーできる） */
    remarksLine: '{fundingLabel} / 予算代表者: {representative} / 配達先: {deliveryPlace}',
  },
};

/** 空の宛先を 1 件作る。UI の「宛先を追加」から呼ぶ */
export function createDestination(kind = 'coop') {
  return {
    // 同一ミリ秒に 2 件追加されても衝突しないよう乱数を足す
    id: `dest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    label: '',
    to: '',
    cc: '',
    receiveMethod: DEFAULT_RECEIVE_METHOD[kind] || '',
    storeName: '',
    memberNumber: '',
  };
}

/** セレクトに出す表示名。どちらの種別か分からないと選び間違えるので必ず添える */
export function destinationLabel(destination) {
  if (!destination) return '';
  const name = destination.label || destination.storeName || '(名称未設定)';
  const kind = DESTINATION_KINDS.find((k) => k.value === destination.kind);
  return kind ? `${name}（${kind.label}）` : name;
}

/**
 * 旧スキーマ（coop / bookstore の固定 2 枠）を destinations[] に移す。
 * ユーザーは既に設定を保存済みなので、ここで取りこぼすと設定が消える。
 * id を種別名そのものにしてあるのは、旧 defaults.route の値
 * （'coop' | 'bookstore'）をそのまま destinationId として使えるようにするため。
 */
function migrateDestinations(saved) {
  const list = [];
  const add = (kind, legacy, label, memberNumber) => {
    if (!legacy) return;
    // 中身が 1 つも無い（=既定値のまま触られていない）枠は宛先として作らない。
    // label が非空でも「設定済み」とは見なせない。旧既定ラベルが非空だったため、
    // 生協しか使っていない人にも bookstore.label が '地元書店' のまま保存されており、
    // それを拾うと宛先メール空の幽霊宛先が生える（保存時のフィルタも通過してしまう）。
    // 自分でラベルを書き換えていた人の情報は失いたくないので、既定ラベルと
    // 一致しないときだけ「設定済み」と見なす
    const hasContent = Boolean(legacy.to || legacy.storeName);
    const hasCustomLabel = Boolean(legacy.label) && legacy.label !== LEGACY_DEFAULT_LABELS[kind];
    if (!hasContent && !hasCustomLabel) return;
    list.push({
      id: kind,
      kind,
      label,
      to: legacy.to || '',
      cc: legacy.cc || '',
      receiveMethod: legacy.receiveMethod || DEFAULT_RECEIVE_METHOD[kind],
      storeName: legacy.storeName || '',
      memberNumber: memberNumber || '',
    });
  };
  const coop = saved.coop;
  const bookstore = saved.bookstore;
  add('coop', coop, coop?.label || '', coop?.memberNumber);
  // 書店は店名の方が実運用の表示名だったので、店名を優先して label に寄せる
  add('bookstore', bookstore, bookstore?.storeName || bookstore?.label || '', bookstore?.customerNumber);
  return list;
}

/** メールの開き方を既知の値に丸める。既定は DEFAULT_PROFILE が唯一の出典 */
const normalizeMailOpener = (value) =>
  MAIL_OPENERS.includes(value) ? value : DEFAULT_PROFILE.defaults.mailOpener;

/** 旧 defaults.route を destinationId に畳む。route 自体は保存し直さない */
function mergeDefaults(savedDefaults) {
  const { route, ...rest } = savedDefaults || {};
  return {
    ...DEFAULT_PROFILE.defaults,
    ...rest,
    destinationId: rest.destinationId || route || '',
    // 知らない値は既定に丸める。mailOpener は退路の表示条件そのもので、
    // 未知の値が素通りすると looksUnopened が常に偽になり（'auto' でないため）
    // 退路が二度と出ない＝「押しても何も起きない」に静かに戻る。
    // 既定値をここに直書きしないのは、DEFAULT_PROFILE と二重定義になり、
    // 片方だけ変えても全件 green のまま通ってしまうため
    mailOpener: normalizeMailOpener(rest.mailOpener),
  };
}

/** 保存済み設定を既定値にマージする（キー追加に強くする）。純粋・冪等 */
export function withDefaults(saved) {
  const p = saved || {};
  const d = DEFAULT_PROFILE;
  return {
    requester: { ...d.requester, ...(p.requester || {}) },
    destinations: Array.isArray(p.destinations) ? p.destinations : migrateDestinations(p),
    fundingSources: Array.isArray(p.fundingSources) ? p.fundingSources : [...d.fundingSources],
    defaults: mergeDefaults(p.defaults),
    templates: { ...d.templates, ...(p.templates || {}) },
  };
}

/**
 * メールの開き方を差し替えた新しいプロフィールを返す（純関数。元は変更しない）。
 *
 * 元を書き換えないのは、退路からの「次回から Gmail で開きます」が
 * **保存に失敗しても画面の状態と食い違わない**ようにするため。
 * 未知の値は mergeDefaults と同じ規則で 'auto' に丸める。
 */
export function setMailOpener(profile, value) {
  const p = withDefaults(profile);
  return {
    ...p,
    defaults: {
      ...p.defaults,
      mailOpener: normalizeMailOpener(value),
    },
  };
}

/** 送信前に足りない項目を返す。UI 側で赤字にする用 */
export function validate(profile, destinationId) {
  const p = withDefaults(profile);
  const missing = [];
  if (!p.requester.name) missing.push('氏名');
  if (!p.requester.affiliation) missing.push('所属');
  if (!p.requester.email) missing.push('メールアドレス');
  // composeOrder と同じ解決経路を通す。ここがズレると「検証は通ったのに宛先が空」になる
  const destination = findDestination(p, destinationId);
  if (!destination) missing.push('注文先');
  else if (!destination.to) missing.push('宛先メール');
  return missing;
}

export function findFundingSource(profile, id) {
  return withDefaults(profile).fundingSources.find((s) => s.id === id) || null;
}

/** id 一致 → 既定の宛先 → 先頭 の順に解決する。1 件も無ければ null */
export function findDestination(profile, id) {
  const p = withDefaults(profile);
  const list = p.destinations;
  if (!list.length) return null;
  return (
    list.find((x) => x.id === id) ||
    list.find((x) => x.id === p.defaults.destinationId) ||
    list[0]
  );
}
