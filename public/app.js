const byId = (id) => document.getElementById(id);
const state = { ask: {}, dashboard: {} };

function setMessage(id, text, isError = false) {
  const element = byId(id);
  element.textContent = text;
  element.classList.toggle('error', isError);
}

function labelFor(header) {
  return ({ transactionDate: 'Transaction date', postedDate: 'Posted date', fullName: 'Name', vendor: 'Vendor', description: 'Description', amount: 'Amount', mcc: 'MCC' })[header] || header;
}

function renderPagination(target, { page, pageSize, total }, onPageChange) {
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  const summary = document.createElement('p');
  summary.className = 'result-summary';
  summary.textContent = total ? `Showing rows ${first}-${last} of ${total}` : '0 matching rows';
  target.append(summary);
  if (total <= pageSize) return;
  const controls = document.createElement('div');
  controls.className = 'pagination';
  const previous = document.createElement('button');
  previous.type = 'button'; previous.textContent = 'Previous'; previous.disabled = page === 1;
  previous.addEventListener('click', () => onPageChange(page - 1));
  const pageLabel = document.createElement('span');
  pageLabel.textContent = `Page ${page} of ${Math.ceil(total / pageSize)}`;
  const next = document.createElement('button');
  next.type = 'button'; next.textContent = 'Next'; next.disabled = page >= Math.ceil(total / pageSize);
  next.addEventListener('click', () => onPageChange(page + 1));
  controls.append(previous, pageLabel, next);
  target.append(controls);
}

function renderRows(targetId, rows, options) {
  const target = byId(targetId);
  target.replaceChildren();
  renderPagination(target, options, options.onPageChange);
  if (!rows.length) return;
  const fragment = byId('table-template').content.cloneNode(true);
  const table = fragment.querySelector('table');
  const headers = Object.keys(rows[0]);
  const headRow = document.createElement('tr');
  headers.forEach((header) => {
    const cell = document.createElement('th');
    if (options.sortable) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'sort-button';
      const active = options.sortBy === header;
      button.textContent = `${labelFor(header)}${active ? (options.sortDirection === 'asc' ? ' ▲' : ' ▼') : ''}`;
      button.setAttribute('aria-label', `Sort by ${labelFor(header)}`);
      button.addEventListener('click', () => options.onSort(header));
      cell.append(button);
    } else cell.textContent = labelFor(header);
    headRow.append(cell);
  });
  table.querySelector('thead').append(headRow);
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    headers.forEach((header) => {
      const cell = document.createElement('td');
      cell.textContent = row[header] ?? '';
      tr.append(cell);
    });
    table.querySelector('tbody').append(tr);
  });
  target.append(fragment);
  renderPagination(target, options, options.onPageChange);
}

function renderSql(sql) {
  const target = byId('ask-meta');
  target.replaceChildren();
  const title = document.createElement('p');
  title.className = 'sql-label';
  title.textContent = 'Generated PostgreSQL query used by the website';
  const wrapper = document.createElement('div');
  wrapper.className = 'sql-block';
  const code = document.createElement('code');
  code.textContent = sql;
  const copy = document.createElement('button');
  copy.type = 'button'; copy.className = 'copy-button'; copy.textContent = 'Copy SQL';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(sql); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Copy unavailable'; }
    window.setTimeout(() => { copy.textContent = 'Copy SQL'; }, 1800);
  });
  wrapper.append(code, copy);
  target.append(title, wrapper);
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

async function loadAsk(page = 1) {
  setMessage('ask-message', 'Searching…'); byId('ask-results').replaceChildren();
  const response = await fetch('/api/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: state.ask.question, page, sql: state.ask.sql, explanation: state.ask.explanation })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  state.ask = { question: state.ask.question, sql: data.sql, explanation: data.explanation, page: data.page };
  setMessage('ask-message', data.explanation || 'Results returned.');
  renderSql(data.sql);
  renderRows('ask-results', data.rows, { ...data, sortable: false, onPageChange: loadAsk });
}

byId('ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.ask = { question: byId('question').value.trim(), sql: null, explanation: '' };
  byId('ask-meta').replaceChildren();
  try { await loadAsk(1); } catch (error) { setMessage('ask-message', error.message, true); }
});

async function loadDashboard(page = 1) {
  setMessage('dashboard-message', 'Searching…'); byId('dashboard-results').replaceChildren();
  const params = new URLSearchParams({ ...state.dashboard, page });
  const response = await fetch(`/api/transactions?${params}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  state.dashboard = { ...state.dashboard, page: data.page, sortBy: data.sortBy, sortDirection: data.sortDirection };
  setMessage('dashboard-message', `${data.total} possible exception${data.total === 1 ? '' : 's'} found.`);
  renderRows('dashboard-results', data.rows, {
    ...data, sortable: true,
    onPageChange: loadDashboard,
    onSort: (column) => {
      state.dashboard.sortDirection = state.dashboard.sortBy === column && state.dashboard.sortDirection === 'asc' ? 'desc' : 'asc';
      state.dashboard.sortBy = column;
      loadDashboard(1).catch((error) => setMessage('dashboard-message', error.message, true));
    }
  });
}

byId('dashboard-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.dashboard = { year: byId('year').value, field: byId('field').value, keyword: byId('keyword').value, sortBy: 'transactionDate', sortDirection: 'desc' };
  try { await loadDashboard(1); } catch (error) { setMessage('dashboard-message', error.message, true); }
});

fetch('/api/years').then((response) => response.json()).then(({ years }) => {
  byId('year').innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join('');
}).catch(() => setMessage('dashboard-message', 'Could not load years from the database.', true));
