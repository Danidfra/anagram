import { writable, type Writable } from 'svelte/store';

export const DEFAULT_CUSTOM_NAME_CSS = `.customname {
  position: absolute;
  left: 16px;
  bottom: 16px;

  margin: 0;
  padding: 16px 32px;
  width: max-content;

  font: 600 28px Arial, sans-serif;
  color: white;
  background: #171020;
  border: 2px solid #ed24ff;
  border-radius: 12px;

  text-shadow: 0 0 8px #b968ff;

  box-shadow:
    inset 0 0 4px white,
    0 0 8px #ed24ff,
    0 0 18px #d000ff,
    0 0 30px #a020ff;
}

.customname span {
  color: #c0b7d2;
  font-weight: 400;
}

.customname::before,
.customname::after {
  content: "";
  position: absolute;
  width: 35%;
  height: 45%;
  pointer-events: none;
  filter:
    drop-shadow(0 0 4px #39ff45)
    drop-shadow(0 0 8px #39ff45);
}

.customname::before {
  left: -9px;
  bottom: -9px;
  border-left: 2px solid #39ff45;
  border-bottom: 2px solid #39ff45;
  border-radius: 0 0 0 14px;
}

.customname::after {
  right: -9px;
  top: -9px;
  border-right: 2px solid #39ff45;
  border-top: 2px solid #39ff45;
  border-radius: 0 14px 0 0;
}`;
// Update previously saved copies of the unmodified example without changing custom CSS.
const PREVIOUS_DEFAULT_CUSTOM_NAME_CSS = DEFAULT_CUSTOM_NAME_CSS.replace(
  '  position: absolute;\n  left: 16px;\n  bottom: 16px;',
  '  position: fixed;\n  left: 200px;\n  bottom: 200px;',
);
export interface GroupCallName {
  name: string;
  cssEnabled: boolean;
  css: string;
}
export const defaultGroupCallName = (): GroupCallName => ({
  name: '',
  cssEnabled: false,
  css: DEFAULT_CUSTOM_NAME_CSS,
});
const stores = new Map<string, Writable<GroupCallName>>();
const storageKey = (account: string) => `ui-group-call-name:${account}`;
function normalize(value: Partial<GroupCallName>): GroupCallName {
  return {
    name: typeof value.name === 'string' ? value.name.slice(0, 80) : '',
    cssEnabled: value.cssEnabled === true,
    css:
      typeof value.css === 'string' && value.css !== PREVIOUS_DEFAULT_CUSTOM_NAME_CSS
        ? value.css
        : DEFAULT_CUSTOM_NAME_CSS,
  };
}
export function groupCallNames(account: string): Writable<GroupCallName> {
  let store = stores.get(account);
  if (!store) {
    let preference = defaultGroupCallName();
    try {
      const saved = localStorage.getItem(storageKey(account));
      // Preserve the user's own draft settings from the earlier local-name UI.
      // Remote aliases are never used to override participants' shared names.
      const value = saved
        ? JSON.parse(saved)
        : JSON.parse(localStorage.getItem(`ui-group-call-names:${account}`) || '{}')?.[account];
      if (value && typeof value === 'object') preference = normalize(value);
    } catch {
      /* A missing or invalid local preference uses normal call labels. */
    }
    store = writable(preference);
    stores.set(account, store);
  }
  return store;
}
export function saveGroupCallName(account: string, value: GroupCallName) {
  if (!/^[a-f0-9]{64}$/.test(account)) return;
  const next = normalize(value);
  try {
    localStorage.setItem(storageKey(account), JSON.stringify(next));
  } catch {
    /* Still usable for this session. */
  }
  groupCallNames(account).set(next);
}
