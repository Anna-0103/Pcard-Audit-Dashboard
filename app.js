const byId = (id) => document.getElementById(id);

function setMessage(id, text, isError = false) {
  const element = byId(id);
  element.textContent = text;
  element.classList.toggle('error', isError);
}

function renderRows(targetId, rows, truncated = false) {
  const target = byId(targetId);
  target.replaceChildren();
  if (!rows.length) { target.textContent = 'No matching transactions found.'; return; }
  const fragment = byId('table-template').content.cloneNode(true);
  const table = fragment.querySelector('table');
  const headers = Object.keys(rows[0]);
  const headRow = document.createElement('tr');
  headers.forEach((header) => { const cell = document.createElement('th'); cell.textContent = header; headRow.append(cell); });
  table.querySelector('thead').append(headRow);
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    headers.forEach((header) => { const cell = document.createElement('td'); cell.textContent = row[header] ?? ''; tr.append(cell); });
    table.querySelector('tbody').append(tr);
  });
  target.append(fragment);
  if (truncated) target.insertAdjacentHTML('beforeend', '<p class="meta">Showing the first 200 rows. Refine the search for a smaller result set.</p>');
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  const asking = tab.id === 'ask-tab';
  byId('ask-panel').classList.toggle('hidden', !asking);
  byId('dashboard-panel').classList.toggle('hidden', asking);
  byId('ask-tab').classList.toggle('active', asking);
  byId('dashboard-tab').classList.toggle('active', !asking);
  byId('ask-tab').setAttribute('aria-selected', asking);
  byId('dashboard-tab').setAttribute('aria-selected', !asking);
}));

byId('ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('ask-message', 'Searching…'); byId('ask-meta').textContent = ''; byId('ask-results').replaceChildren();
  try {
    const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: byId('question').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setMessage('ask-message', data.explanation || 'Results returned.');
    byId('ask-meta').textContent = `Read-only query used: ${data.sql}`;
    renderRows('ask-results', data.rows, data.truncated);
  } catch (error) { setMessage('ask-message', error.message, true); }
});

byId('dashboard-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('dashboard-message', 'Searching…'); byId('dashboard-results').replaceChildren();
  const params = new URLSearchParams({ year: byId('year').value, field: byId('field').value, keyword: byId('keyword').value });
  try {
    const response = await fetch(`/api/transactions?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setMessage('dashboard-message', `${data.rows.length} possible exception${data.rows.length === 1 ? '' : 's'} found.`);
    renderRows('dashboard-results', data.rows, data.truncated);
  } catch (error) { setMessage('dashboard-message', error.message, true); }
});

fetch('/api/years').then((response) => response.json()).then(({ years }) => {
  byId('year').innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join('');
}).catch(() => setMessage('dashboard-message', 'Could not load years from the database.', true));
