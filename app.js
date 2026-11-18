/*
 * app.js: reads the CSV files in data/, runs the math in capstruct.js and
 * builds the tables on the page. Everything happens in the browser; the only
 * requests are for this site's own files in data/.
 */
(function () {
  'use strict';

  const C = window.CapStruct;

  const FILES = {
    assumptions: 'data/assumptions.csv',
    cdss: 'data/cdss.csv',
    schedule: 'data/banker_schedule.csv',
    firms: 'data/example_firms.csv',
    scenarios: 'data/ebit_scenarios.csv'
  };

  // ---------- small DOM helpers (textContent only, never innerHTML) ----------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    });
    [].concat(children === undefined ? [] : children).forEach(c => {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function fill(id, children) {
    const target = document.getElementById(id);
    target.replaceChildren(...[].concat(children));
  }

  async function loadText(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Couldn\'t read ' + path + ' (HTTP ' + res.status + ').');
    return res.text();
  }

  // ---------- Firm U and Firm L ----------

  function firmTable(caption, firm, taxRate) {
    const y = firm.years;
    const each = f => y.map(yr => f(yr));
    const rows = [
      ['Assets', each(() => C.fmtDollars(firm.assets))],
      ['Equity', each(() => C.fmtDollars(firm.equity))],
      ['Sales', each(yr => C.fmtDollars(yr.sales))],
      ['Oper. costs', each(yr => C.fmtParen(yr.operatingCosts))],
      ['EBIT', each(yr => C.fmtDollars(yr.ebit))],
      ['Interest', each(yr => C.fmtParen(yr.interest))],
      ['EBT', each(yr => C.fmtDollars(yr.ebt))],
      ['Taxes (' + C.fmtPct(taxRate) + ')', each(yr => C.fmtParen(yr.taxes))],
      ['Net income', each(yr => C.fmtDollars(yr.netIncome))],
      ['ROE', each(yr => C.fmtPct(yr.roe))],
      ['TIE', each(yr => C.fmtMult(yr.tie))]
    ];
    const stats = [
      ['E(ROE)', C.fmtPct(firm.eRoe)],
      ['σ(ROE)', C.fmtPct(firm.sdRoe)],
      ['CV(ROE)', C.fmtNumber(firm.cvRoe, 2)],
      ['E(TIE)', C.fmtMult(firm.eTie)],
      ['σ(TIE)', C.fmtMult(firm.sdTie)]
    ];

    const head = el('thead', {}, el('tr', {}, [
      el('th', { scope: 'col' }, 'Probability'),
      ...y.map(yr => el('th', { scope: 'col' }, C.fmtNumber(yr.probability, 2)))
    ]));
    const body = el('tbody', {}, [
      ...rows.map(([label, cells]) => el('tr', {}, [
        el('th', { scope: 'row' }, label),
        ...cells.map(c => el('td', {}, c))
      ])),
      ...stats.map(([label, value], i) => el('tr', { class: i === 0 ? 'stat first-stat' : 'stat' }, [
        el('th', { scope: 'row' }, label),
        el('td', { colspan: String(y.length), class: 'center' }, value)
      ]))
    ]);
    return el('table', { class: 'firm' }, [el('caption', {}, caption), head, body]);
  }

  // Short labels under a slider, like $250k or $1M.
  function fmtCompact(x) {
    if (x >= 1e6) return '$' + C.roundHalfUp(x / 1e6, 3) + 'M';
    if (x >= 1e3) return '$' + C.roundHalfUp(x / 1e3, 3) + 'k';
    return C.fmtDollars(x);
  }

  // A labelled slider over a list of stops. The slider moves over the
  // positions 0, 1, 2, ... so it can only land on a listed amount.
  function makeSlider(id, labelText, stops) {
    const input = el('input', { type: 'range', id: id, min: '0', max: String(stops.length - 1), step: '1' });
    const output = el('output', { for: id, class: 'lever-value' });
    const ticks = el('div', { class: 'ticks', 'aria-hidden': 'true' }, stops.map(s => el('span', {}, fmtCompact(s))));
    const head = el('div', { class: 'lever-head' }, [el('label', { for: id }, labelText), output]);
    return {
      input: input,
      parts: [head, input, ticks],
      set(i) {
        input.value = String(i);
        output.textContent = C.fmtDollars(stops[i]);
        input.setAttribute('aria-valuetext', C.fmtDollars(stops[i]));
      }
    };
  }

  function renderFirms(firmIn, scenarios, taxRate) {
    const make = debt => C.firmExample({ totalAssets: firmIn.totalAssets, debt: debt, interestRate: firmIn.interestRate, taxRate: taxRate }, scenarios);
    const u = make(0);
    const stops = C.firmSliderStops(firmIn);
    const caseIndex = stops.indexOf(firmIn.firmLDebt);
    const slider = makeSlider('firm-l-debt', 'Firm L’s debt', stops);
    const caseBtn = el('button', { type: 'button' }, 'Case (' + C.fmtDollars(firmIn.firmLDebt) + ')');
    const lCell = el('div');

    function draw(i) {
      slider.set(i);
      const l = make(stops[i]);
      lCell.replaceChildren(firmTable('Firm L: ' + C.fmtDollars(l.debt) + ' of debt at ' + C.fmtPct(l.interestRate), l, taxRate));
    }
    slider.input.addEventListener('input', () => draw(Number(slider.input.value)));
    caseBtn.addEventListener('click', () => draw(caseIndex));
    draw(caseIndex);

    const notes = [
      el('p', { class: 'note' }, 'Firm U has no interest, so its TIE, E(TIE) and σ(TIE) are n/a. ROE uses book equity: total assets − debt.')
    ];
    if (Math.abs(u.probabilitySum - 1) > 1e-9) {
      notes.push(el('p', { class: 'warning' }, 'The probabilities in data/ebit_scenarios.csv add up to ' + C.fmtNumber(u.probabilitySum, 4) + ', not 1.'));
    }
    fill('firms', [
      el('div', { class: 'lever' }, [
        ...slider.parts,
        el('div', { class: 'buttons' }, caseBtn),
        el('p', { class: 'note' }, 'The interest rate is held at ' + C.fmtPct(firmIn.interestRate) +
          ' at every amount, so the slider shows what debt does to Firm L’s return and risk, not how lenders would respond.')
      ]),
      el('div', { class: 'firm-grid' }, [firmTable('Firm U: no debt', u, taxRate), lCell]),
      ...notes
    ]);
  }

  // ---------- CDSS debt slider and buttons ----------

  function stakeValue(m) {
    if (m.status === 'ok') return C.fmtPct(m.value);
    if (m.status === 'all') return '100.00%';
    if (m.status === 'sell') return 'n/a: see note';
    return 'n/a';
  }

  function stakeNote(m) {
    if (m.status === 'all') return el('p', { class: 'note' }, 'No outside shareholders would be left: the buyback takes every share they own.');
    if (m.status === 'sell') {
      return el('p', { class: 'warning' }, 'Management would have to sell: the buyback (' + C.fmtShares(m.repurchased) +
        ' shares) is more than the ' + C.fmtShares(m.outside) + ' shares outside investors own.');
    }
    return null;
  }

  function methodCard(title, r, waccLabel, wacc) {
    const items = [
      ['Share price', C.fmtMoney(r.price), 'price'],
      ['Shares repurchased', C.fmtShares(r.repurchased)],
      ['Shares remaining', C.fmtShares(r.remaining)],
      ['EPS', C.fmtMoney(r.eps)],
      ['Dividends per share', C.fmtMoney(r.dps)],
      ['TIE', C.fmtMult(r.tie)],
      [waccLabel, C.fmtPct(wacc)],
      ['Management’s share', stakeValue(r.management)]
    ];
    return el('div', { class: 'method-card' }, [
      el('h3', {}, title),
      el('dl', {}, items.map(([k, v, cls]) => el('div', { class: cls || null }, [el('dt', {}, k), el('dd', {}, v)]))),
      stakeNote(r.management)
    ]);
  }

  function buttonMessage(t, what) {
    if (!t) return 'No amount of debt has a ' + what + '.';
    if (t.agree) return 'Both buyback methods give the ' + what + ' at ' + C.fmtDollars(t.debt) + ' of debt.';
    return 'The methods disagree: the case method gives the ' + what + ' at ' + C.fmtDollars(t.caseDebt) +
      ' and the new-price method at ' + (t.newDebt === null ? 'no amount' : C.fmtDollars(t.newDebt)) +
      '. The slider is at the case method’s amount.';
  }

  function renderLevers(inp, res) {
    const stops = res.caseRows.map(r => r.debt);
    const slider = makeSlider('cdss-debt', 'CDSS’s debt', stops);
    const priceBtn = el('button', { type: 'button' }, 'Best price');
    const epsBtn = el('button', { type: 'button' }, 'Highest EPS');
    const message = el('p', { class: 'callout', role: 'status' });
    message.hidden = true;
    const rates = el('p', { class: 'note' });
    const cards = el('div', { class: 'method-grid' });

    function draw(i, msg) {
      slider.set(i);
      const c = res.caseRows[i];
      const n = res.newRows[i];
      rates.textContent = 'At ' + C.fmtDollars(c.debt) + ' the banker quotes r_d = ' + (c.rd === null ? '—' : C.fmtPct(c.rd)) +
        ' and r_s = ' + C.fmtPct(c.rs) + '. Interest = ' + C.fmtDollars(c.interest) + '; net income = ' + C.fmtDollars(c.netIncome) + '.';
      cards.replaceChildren(
        methodCard('Case method: buy back at ' + C.fmtMoney(inp.price), c, 'WACC (book weights)', c.waccBook),
        methodCard('New-price method: buy back at ' + C.fmtMoney(n.price), n, 'WACC (market weights)', n.waccMarket)
      );
      message.textContent = msg || '';
      message.hidden = !msg;
      document.querySelectorAll('table.schedule tr[data-debt]').forEach(tr => {
        tr.classList.toggle('selected', tr.getAttribute('data-debt') === String(c.debt));
      });
    }

    function goTo(target, what) {
      const i = target ? stops.indexOf(target.debt) : Number(slider.input.value);
      draw(i, buttonMessage(target, what));
    }

    slider.input.addEventListener('input', () => draw(Number(slider.input.value)));
    priceBtn.addEventListener('click', () => goTo(res.buttons.price, 'highest share price'));
    epsBtn.addEventListener('click', () => goTo(res.buttons.eps, 'highest EPS'));

    fill('cdss-levers', [
      el('div', { class: 'lever' }, [
        ...slider.parts,
        el('div', { class: 'buttons' }, [priceBtn, epsBtn]),
        message
      ]),
      rates,
      cards,
      el('p', { class: 'note' }, 'The slider stops only at the amounts in the banker’s schedule. The selected amount is outlined in the tables below.')
    ]);
    const zero = stops.indexOf(0);
    draw(zero === -1 ? 0 : zero);
  }

  // ---------- CDSS ----------

  // A table with one row per amount of borrowing. data-label lets the CSS
  // turn each row into a card on a phone.
  function scheduleTable(caption, columns, rows, bestDebt) {
    const head = el('thead', {}, el('tr', {}, columns.map(c => el('th', { scope: 'col' }, c.label))));
    const body = el('tbody', {}, rows.map(r => el('tr', { class: r.debt === bestDebt ? 'best' : null, 'data-debt': String(r.debt) }, columns.map((c, i) =>
      i === 0
        ? el('th', { scope: 'row', 'data-label': c.label }, [c.value(r), r.debt === bestDebt ? el('span', { class: 'tag' }, 'highest price') : null])
        : el('td', { 'data-label': c.label }, c.value(r))
    ))));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'schedule' }, [el('caption', {}, caption), head, body]));
  }

  const rdCell = r => (r.rd === null ? '—' : C.fmtPct(r.rd));

  function renderCdss(inp, schedule) {
    const res = C.analyzeCdss(inp, schedule);

    fill('cdss-inputs', [
      el('p', {}, [
        'EBIT = sales × (1 − variable cost rate) − fixed costs = ',
        C.fmtDollars(inp.sales) + ' × (1 − ' + C.fmtPct(inp.variableCostRate) + ') − ' + C.fmtDollars(inp.fixedCosts) +
        ' = ', el('strong', {}, C.fmtDollars(res.ebit)),
        '. The case says EBIT stays the same at every amount of debt.'
      ]),
      el('dl', { class: 'facts' }, [
        ['Shares outstanding (n)', C.fmtShares(inp.shares)],
        ['Today\'s price (P₀)', C.fmtMoney(inp.price)],
        ['Tax rate (T)', C.fmtPct(inp.taxRate)],
        ['Total book assets (A)', C.fmtDollars(inp.totalAssets)],
        ['Management owns', C.fmtPct(inp.managementShare)]
      ].map(([k, v]) => el('div', {}, [el('dt', {}, k), el('dd', {}, v)]))),
      el('p', { class: 'note' }, 'The case doesn\'t state total assets. The AGE exhibit and solution use ' +
        C.fmtDollars(inp.totalAssets) + ' (' + C.fmtShares(inp.shares).replace(/\.00$/, '') + ' shares at a ' +
        C.fmtMoney(inp.totalAssets / inp.shares) + ' book value per share). CDSS pays out all its earnings, so dividends per share = EPS and g = 0.')
    ]);

    const caseCols = [
      { label: 'Debt (D)', value: r => C.fmtDollars(r.debt) },
      { label: 'r_d', value: rdCell },
      { label: 'r_s', value: r => C.fmtPct(r.rs) },
      { label: 'Net income', value: r => C.fmtDollars(r.netIncome) },
      { label: 'Shares repurchased', value: r => C.fmtShares(r.repurchased) },
      { label: 'Shares remaining', value: r => C.fmtShares(r.remaining) },
      { label: 'EPS (= DPS)', value: r => C.fmtMoney(r.eps) },
      { label: 'TIE', value: r => C.fmtMult(r.tie) },
      { label: 'Share price', value: r => C.fmtMoney(r.price) },
      { label: 'WACC (book weights)', value: r => C.fmtPct(r.waccBook) }
    ];
    fill('case-method', [
      el('p', {}, 'Shares repurchased = D / P₀. Shares remaining = n − D / P₀. EPS = net income / shares remaining. ' +
        'Price = EPS / r_s. WACC (book weights) = D/A × r_d × (1 − T) + (A − D)/A × r_s.'),
      scheduleTable('Case method: buy back at ' + C.fmtMoney(inp.price), caseCols, res.caseRows, res.best.casePrice && res.best.casePrice.debt),
      el('p', { class: 'note' }, 'The textbook solution rounds EPS to the cent before dividing by r_s. This app doesn\'t round along the way, so some prices differ from the solution by a few cents.')
    ]);

    const newCols = [
      { label: 'Debt (D)', value: r => C.fmtDollars(r.debt) },
      { label: 'r_d', value: rdCell },
      { label: 'r_s', value: r => C.fmtPct(r.rs) },
      { label: 'Net income', value: r => C.fmtDollars(r.netIncome) },
      { label: 'Value of equity (S)', value: r => C.fmtDollars(r.equityValue) },
      { label: 'Value of firm (V)', value: r => C.fmtDollars(r.firmValue) },
      { label: 'Share price', value: r => C.fmtMoney(r.price) },
      { label: 'Shares repurchased', value: r => C.fmtShares(r.repurchased) },
      { label: 'Shares remaining', value: r => C.fmtShares(r.remaining) },
      { label: 'EPS (= DPS)', value: r => C.fmtMoney(r.eps) },
      { label: 'TIE', value: r => C.fmtMult(r.tie) },
      { label: 'WACC (market weights)', value: r => C.fmtPct(r.waccMarket) }
    ];
    fill('new-price-method', [
      el('p', {}, 'S = net income / r_s. V = S + D. Price P = V / n. Shares repurchased = D / P. Shares remaining = n − D / P. ' +
        'EPS = net income / shares remaining. WACC (market weights) = D/V × r_d × (1 − T) + S/V × r_s.'),
      scheduleTable('New-price method: buy back at the price after the announcement', newCols, res.newRows, res.best.newPrice && res.best.newPrice.debt)
    ]);

    renderSummary(inp, res);
    renderLevers(inp, res);
  }

  function renderSummary(inp, res) {
    const line = (label, pick, fmt) => el('li', {}, [
      label + ': ',
      pick ? el('strong', {}, C.fmtDollars(pick.debt) + ' of debt') : 'none',
      pick ? ' (' + fmt(pick.value) + ')' : ''
    ]);
    const b = res.best;
    const items = [
      line('Highest share price, case method', b.casePrice, C.fmtMoney),
      line('Highest share price, new-price method', b.newPrice, C.fmtMoney),
      line('Lowest WACC, book weights', b.bookWacc, C.fmtPct),
      line('Lowest WACC, market weights', b.marketWacc, C.fmtPct)
    ];
    const verdict = res.allAgree
      ? el('p', {}, 'All four point to the same amount of debt.')
      : el('p', { class: 'callout' }, 'These don\'t all point to the same amount of debt, so the app doesn\'t pick one. Look at which measure each one uses.');

    const check = (ok, text) => el('li', { class: ok ? 'ok' : 'bad' }, (ok ? '✓ ' : '✗ ') + text);
    const checks = [];
    if (res.zeroCheck) {
      checks.push(check(res.zeroCheck.ok, 'At $0 of debt, EPS / r_s = ' + C.fmtMoney(res.zeroCheck.computed) +
        '; data/cdss.csv says today\'s price is ' + C.fmtMoney(res.zeroCheck.listed) + '.'));
    }
    checks.push(check(res.epsChecksOk, 'New-price method: EPS = r_s × P at every amount of debt.'));
    checks.push(check(res.waccChecksOk, 'New-price method: market-weight WACC = EBIT × (1 − T) / V at every amount of debt.'));

    fill('summary', [
      el('ul', {}, items),
      verdict,
      el('h3', {}, 'Checks'),
      el('ul', { class: 'checks' }, checks),
      ...res.warnings.map(w => el('p', { class: 'warning', role: 'alert' }, w))
    ]);
  }

  // ---------- start ----------

  async function main() {
    try {
      const texts = await Promise.all(Object.values(FILES).map(loadText));
      const data = {};
      Object.keys(FILES).forEach((k, i) => { data[k] = C.parseCSV(texts[i]); });

      const taxRate = C.taxRateFrom(data.assumptions);
      const firmIn = C.firmInputs(data.firms);
      const scenarios = C.parseScenarios(data.scenarios);
      const inp = C.cdssInputs(data.cdss, taxRate);
      const schedule = C.parseSchedule(data.schedule, FILES.schedule);

      renderFirms(firmIn, scenarios, taxRate);
      renderCdss(inp, schedule);
      document.getElementById('status').hidden = true;
    } catch (err) {
      const status = document.getElementById('status');
      status.className = 'warning';
      status.textContent = err.message + (location.protocol === 'file:'
        ? ' Browsers block reading data/ from a file opened directly. Open the app from its web address instead.'
        : '');
    }
  }

  main();
})();
