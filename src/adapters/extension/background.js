/**
 * 最小の background service worker。
 *
 * 存在理由は 1 つだけ: content script から設定画面を開くため。
 * chrome.runtime.openOptionsPage は拡張ページ（popup / options / background）
 * 専用の API で content script には存在しないため、content script からは
 * sendMessage で依頼を投げ、ここで代理実行する。
 *
 * import を一切しないので manifest 側で "type": "module" は付けない
 * （必要になった時点で足すのが最小の差分）。
 */

const OPEN_OPTIONS = 'jimoto:open-options';

// MV3 の SW は idle で停止し、メッセージ受信で起動する。起動直後の同期実行中に
// listener が登録されていないとイベントを取りこぼすため、トップレベルで同期登録する。
//
// 送信元の検証はしていない。externally_connectable を宣言していないので、
// ウェブページからの sendMessage は onMessage には届かない（届くのは自分自身の
// content script と拡張ページだけ）。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 自分の型以外には応答しない（将来 listener を足したときに塞がないため）
  if (message?.type !== OPEN_OPTIONS) return;

  chrome.runtime.openOptionsPage(() => {
    const error = chrome.runtime.lastError;
    if (error) console.warn('[jimoto] openOptionsPage に失敗', error.message);
    sendResponse({ ok: !error, error: error?.message });
  });

  return true; // 非同期に sendResponse する
});
