import { expect, test } from '@playwright/test';

test('app confirmations queue, return checkbox choices and cancel without native dialogs', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create Account', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    window.confirm = () => {
      throw new Error('Native confirmation must not be used');
    };
    const { Dialog } = await import('/src/lib/platform/ui.ts');
    (window as any).__promptResults = [];
    Dialog.create({
      title: 'Use App Relays',
      message: 'Use the default relays?',
      persistent: true,
      options: {
        type: 'checkbox',
        model: [],
        items: [{ label: 'Remember this', value: 'remember-this' }],
      },
      ok: { label: 'Yes' },
      cancel: { label: 'No' },
    })
      .onOk((values) => (window as any).__promptResults.push(values))
      .onDismiss(() => (window as any).__promptResults.push('dismissed'));
    Dialog.create({ title: 'Second confirmation' }).onCancel(() =>
      (window as any).__promptResults.push('cancelled'),
    );
  });
  const dialog = page.getByRole('dialog', { name: 'Use App Relays', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Remember this' }).check();
  await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Second confirmation', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__promptResults)).toEqual([
    ['remember-this'],
    'dismissed',
    'cancelled',
  ]);
});
