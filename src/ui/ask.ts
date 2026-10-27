import { t } from '../i18n';

/** In-app replacement for window.confirm / window.prompt, styled like the rest of the tracker. */
interface AskOptions {
  /** Label of the confirm button; defaults to OK. */
  ok?: string;
  /** Shows a text field prefilled with this value and resolves to its text. */
  value?: string;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

/** Opens a modal dialog; resolves to the field text (or true without a field) on OK, null on Cancel / Esc / backdrop. */
function ask(message: string, options: AskOptions = {}): Promise<string | true | null> {
  document.getElementById('ask')?.remove();
  const el = document.createElement('dialog');
  el.className = 'ask';
  el.id = 'ask';
  el.setAttribute('aria-labelledby', 'ask-msg');
  const withField = options.value !== undefined;
  el.innerHTML = `
    <form method="dialog">
      <p id="ask-msg">${escape(message)}</p>
      ${withField ? `<input type="text" id="ask-input" aria-labelledby="ask-msg" autocomplete="off" spellcheck="false">` : ''}
      <div class="btn-row">
        <button type="button" class="btn" id="ask-cancel">${escape(t('dialog.cancel'))}</button>
        <button type="submit" class="btn primary" id="ask-ok">${escape(options.ok ?? t('dialog.ok'))}</button>
      </div>
    </form>`;
  document.body.append(el);
  const input = el.querySelector<HTMLInputElement>('#ask-input');
  if (input) input.value = options.value!;

  return new Promise((resolve) => {
    let result: string | true | null = null;
    // OK is the form's only submit button, so Enter in the field confirms.
    el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      result = input ? input.value : true;
      el.close();
    });
    el.querySelector('#ask-cancel')!.addEventListener('click', () => el.close());
    // Keep keys away from the tracker behind the dialog; Esc still cancels it.
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.addEventListener('keyup', (e) => e.stopPropagation());
    let inside = false;
    el.addEventListener('pointerdown', (e) => (inside = e.target !== el));
    el.addEventListener('click', (e) => {
      if (e.target === el && !inside) el.close();
    });
    el.addEventListener('close', () => {
      el.remove();
      resolve(result);
    });
    el.showModal();
    if (input) {
      input.focus();
      input.select();
    } else {
      el.querySelector<HTMLButtonElement>('#ask-ok')!.focus();
    }
  });
}

/** Asks a yes/no question; true when the user confirms. */
export async function confirmDialog(message: string, ok?: string): Promise<boolean> {
  return (await ask(message, { ok })) === true;
}

/** Asks for a line of text; null when cancelled. */
export async function promptDialog(message: string, value = '', ok?: string): Promise<string | null> {
  const answer = await ask(message, { value, ok });
  return typeof answer === 'string' ? answer : null;
}
