// Parse without attaching to a document: imports cannot load while validating.
// Only ordinary rules targeting the name itself/its descendants are retained.
export function customCallNameCss(source: string): string {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(source);
    return [...sheet.cssRules]
      .flatMap((rule) => {
        if (!(rule instanceof CSSStyleRule)) return [];
        if (
          !rule.selectorText
            .split(',')
            .every(
              (selector) =>
                /^\.customname(?:$|[\s.:#\[>+~])/.test(selector.trim()) &&
                !/:host|::slotted/i.test(selector),
            )
        )
          return [];
        const declarations: string[] = [];
        for (const property of rule.style) {
          const value = rule.style.getPropertyValue(property);
          const decoded = value
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n\f])/gi, (_, hex, char) =>
              hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char,
            );
          // String forms of image-set/image/src can fetch without an explicit url().
          if (
            /\b(?:url|image-set|-webkit-image-set|image|src|var|paint)\s*\(|(?:https?|data|file|blob):|@import/i.test(
              decoded,
            ) ||
            property.startsWith('--')
          )
            continue;
          declarations.push(
            `${property}:${value}${rule.style.getPropertyPriority(property) ? ' !important' : ''}`,
          );
        }
        return [`${rule.selectorText}{${declarations.join(';')}}`];
      })
      .join('\n');
  } catch {
    return '';
  }
}
