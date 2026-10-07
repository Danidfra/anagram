import { test, expect } from '@playwright/test';

test('formatting component renders text safely and reveals spoilers by keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { mount } = await import('/node_modules/.vite/deps/svelte.js');
    const { default: FormattedMessage } =
      await import('/src/lib/components/FormattedMessage.svelte');
    const { formatMessage } = await import('/src/utils/messageFormatting.ts');
    const target = document.createElement('div');
    target.id = 'formatting-fixture';
    document.body.replaceChildren(target);
    mount(FormattedMessage, {
      target,
      props: {
        parts: formatMessage(
          '**Bold *nested italic*** _Italic_ __Underline__ ~Strike~ `**literal** <script>`\n```js\n  const value = "<img>";\n```\n||Hidden text|| [Docs](https://example.org/docs) [Unsafe](javascript:alert(1)) <img src=x onerror=alert(1)>',
        ),
        onopen: (href: string) => {
          target.dataset.opened = href;
        },
        oncontact: () => {},
        onlinkmenu: (event: MouseEvent, href: string) => {
          event.preventDefault();
          target.dataset.menu = href;
        },
      },
    });
  });
  const fixture = page.locator('#formatting-fixture');
  await expect(fixture.locator('strong')).toHaveText('Bold nested italic');
  await expect(fixture.locator('strong em')).toHaveText('nested italic');
  await expect(fixture.locator('u')).toHaveText('Underline');
  await expect(fixture.locator('s')).toHaveText('Strike');
  await expect(fixture.locator('code').first()).toHaveText('**literal** <script>');
  await expect(fixture.locator('code.block')).toHaveText('  const value = "<img>";');
  await expect(fixture.locator('script, img, iframe')).toHaveCount(0);
  await expect(fixture.locator('a')).toHaveCount(1);
  const link = fixture.getByRole('link', { name: 'Docs' });
  await expect(link).toHaveAttribute('title', 'https://example.org/docs');
  await link.click();
  await expect(fixture).toHaveAttribute('data-opened', 'https://example.org/docs');
  await link.click({ button: 'right' });
  await expect(fixture).toHaveAttribute('data-menu', 'https://example.org/docs');
  await expect(fixture).not.toContainText('Hidden text');
  const spoiler = fixture.getByRole('button', { name: 'Reveal spoiler' });
  await spoiler.focus();
  await page.keyboard.press('Enter');
  await expect(fixture).toContainText('Hidden text');
  await expect(spoiler).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fixture.locator('code.block')).toBeVisible();
  expect(
    await fixture.evaluate((node) => node.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
});
