export async function mount(element, props, context) {
  const token = context.url.consume('quote_token') || context.url.consume('quote_fragment');
  let quote = null;

  async function request(path, options) {
    const response = await context.api.fetch(path, options);
    if (!response.ok) throw new Error(`Quote API returned ${response.status}`);
    return response.json();
  }

  async function load() {
    if (!token) return;
    quote = await request(`/quotes/current?token=${encodeURIComponent(token)}`);
  }

  function render(view = context.navigation.current) {
    element.replaceChildren();
    const shell = document.createElement('section');
    shell.className = 'quote-extension';
    const heading = document.createElement('h2');
    heading.textContent = String(props.heading || 'Your quote');
    shell.appendChild(heading);

    if (view === 'approved') {
      const message = document.createElement('p');
      message.textContent = 'Thank you. The quote has been approved.';
      shell.appendChild(message);
    } else if (quote) {
      const summary = document.createElement('p');
      summary.textContent = `${quote.title}: ${quote.total}`;
      shell.appendChild(summary);
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent = 'Approve quote';
      approve.addEventListener('click', async () => {
        await request('/quotes/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        context.navigation.navigate('approved');
      });
      shell.appendChild(approve);
    } else {
      const message = document.createElement('p');
      message.textContent = token ? 'Loading quote…' : 'Calculate a new quote or open your personal quote link.';
      shell.appendChild(message);
    }
    element.appendChild(shell);
  }

  context.navigation.subscribe(render);
  render();
  try { await load(); render(); } catch { element.textContent = 'The quote service is temporarily unavailable.'; }
}
