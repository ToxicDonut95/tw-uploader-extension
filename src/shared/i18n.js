globalThis.tdText = function (key, substitutions) {
  let text = '';
  try {
    text = chrome.i18n.getMessage(key, substitutions);
  } catch (i18nError) {
    text = '';
  }
  return text || key;
};
