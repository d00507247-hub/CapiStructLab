/*
 * capstruct.js: the finance math for the AGE capital structure app.
 *
 * Every function here is "pure": it takes numbers in and gives numbers back,
 * and never touches the web page. That lets us check the math with Node:
 *   node -e "const C = require('./capstruct.js'); console.log(C.roundHalfUp(3.495, 2))"
 *
 * Notation (same as CLAUDE.md):
 *   T  = tax rate          D  = amount borrowed
 *   n  = shares before any buyback   P0 = today's price
 *   A  = total book assets r_d = cost of debt   r_s = cost of equity
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // Reading CSV text
  // ---------------------------------------------------------------------

  // Turns CSV text into an array of objects keyed by the header row.
  // Handles quoted fields, so a note that contains a comma still works.
  function parseCSV(text) {
    const src = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    const kept = rows.filter(r => r.some(v => v.trim() !== ''));
    if (!kept.length) return [];
    const header = kept[0].map(h => h.trim());
    return kept.slice(1).map(r => {
      const o = {};
      header.forEach((h, j) => { o[h] = (r[j] === undefined ? '' : r[j]).trim(); });
      return o;
    });
  }

  // A blank cell becomes null (for example, the $0 row's cost of debt).
  function toNumber(value, label) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(label + ' is not a number: "' + value + '"');
    return n;
  }

  // For files laid out as name,value rows (cdss.csv, assumptions.csv, example_firms.csv).
  function keyValues(rows, file, keyCol) {
    const out = {};
    rows.forEach(r => { out[r[keyCol]] = toNumber(r.value, file + ' ' + r[keyCol]); });
    return out;
  }

  function requireKeys(map, keys, file) {
    keys.forEach(k => {
      if (map[k] === undefined || map[k] === null) throw new Error(file + ' is missing a value for "' + k + '".');
    });
  }

  // ---------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------

  function taxRateFrom(assumptionRows) {
    const a = keyValues(assumptionRows, 'data/assumptions.csv', 'assumption');
    requireKeys(a, ['tax_rate'], 'data/assumptions.csv');
    return a.tax_rate;
  }

  function cdssInputs(cdssRows, taxRate) {
    const c = keyValues(cdssRows, 'data/cdss.csv', 'item');
    requireKeys(c, ['sales', 'variable_cost_rate', 'fixed_costs', 'total_assets',
      'shares_outstanding', 'share_price', 'management_share'], 'data/cdss.csv');
    return {
      sales: c.sales,
      variableCostRate: c.variable_cost_rate,
      fixedCosts: c.fixed_costs,
      totalAssets: c.total_assets,
      currentDebt: c.debt === undefined || c.debt === null ? 0 : c.debt,
      shares: c.shares_outstanding,
      price: c.share_price,
      managementShare: c.management_share,
      taxRate: taxRate
    };
  }

  // The banker's schedule, sorted from least to most debt.
  function parseSchedule(rows, file) {
    const name = file || 'banker schedule';
    const out = rows.map((r, i) => {
      const line = name + ' row ' + (i + 2);
      const debt = toNumber(r.debt, line + ' debt');
      const rd = toNumber(r.cost_of_debt, line + ' cost_of_debt');
      const rs = toNumber(r.cost_of_equity, line + ' cost_of_equity');
      if (debt === null || debt < 0) throw new Error(line + ': debt must be 0 or more.');
      if (rs === null || rs <= 0) throw new Error(line + ': cost_of_equity must be more than 0.');
      if (debt > 0 && rd === null) throw new Error(line + ': cost_of_debt is blank but debt is more than $0.');
      return { debt: debt, rd: debt > 0 ? rd : null, rs: rs };
    });
    if (!out.length) throw new Error(name + ' has no rows.');
    out.sort((a, b) => a.debt - b.debt);
    for (let i = 1; i < out.length; i++) {
      if (out[i].debt === out[i - 1].debt) throw new Error(name + ' lists $' + out[i].debt + ' twice.');
    }
    return out;
  }

  function firmInputs(rows) {
    const f = keyValues(rows, 'data/example_firms.csv', 'item');
    requireKeys(f, ['total_assets', 'firm_l_debt', 'interest_rate', 'slider_max', 'slider_step'],
      'data/example_firms.csv');
    return {
      totalAssets: f.total_assets,
      firmLDebt: f.firm_l_debt,
      interestRate: f.interest_rate,
      sliderMax: f.slider_max,
      sliderStep: f.slider_step
    };
  }

  function parseScenarios(rows) {
    const out = rows.map((r, i) => {
      const line = 'data/ebit_scenarios.csv row ' + (i + 2);
      const s = {
        probability: toNumber(r.probability, line + ' probability'),
        sales: toNumber(r.sales, line + ' sales'),
        operatingCosts: toNumber(r.operating_costs, line + ' operating_costs')
      };
      if (s.probability === null || s.sales === null || s.operatingCosts === null) {
        throw new Error(line + ' has a blank value.');
      }
      return s;
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------

  // Probability-weighted average.
  function expectedValue(probs, xs) {
    return xs.reduce((sum, x, i) => sum + probs[i] * x, 0);
  }

  // Square root of the probability-weighted squared deviations.
  function stdDev(probs, xs) {
    const mean = expectedValue(probs, xs);
    return Math.sqrt(xs.reduce((sum, x, i) => sum + probs[i] * (x - mean) * (x - mean), 0));
  }

  // ---------------------------------------------------------------------
  // Firm U and Firm L (question c)
  // ---------------------------------------------------------------------

  // One firm's partial income statements and ratios in each kind of year.
  // Firm U is this with debt = 0.
  function firmExample(opts, scenarios) {
    const A = opts.totalAssets;
    const D = opts.debt;
    const T = opts.taxRate;
    const equity = A - D; // ROE uses book equity
    const years = scenarios.map(s => {
      const ebit = s.sales - s.operatingCosts;
      const interest = opts.interestRate * D;
      const ebt = ebit - interest;
      const taxes = T * ebt;
      const netIncome = ebt - taxes;
      return {
        probability: s.probability,
        sales: s.sales,
        operatingCosts: s.operatingCosts,
        ebit: ebit,
        interest: interest,
        ebt: ebt,
        taxes: taxes,
        netIncome: netIncome,
        roe: equity > 0 ? netIncome / equity : null,
        tie: interest > 0 ? ebit / interest : null // no interest: TIE is n/a
      };
    });
    const p = years.map(y => y.probability);
    const roes = years.map(y => y.roe);
    const ties = years.map(y => y.tie);
    const hasRoe = roes.every(x => x !== null);
    const hasTie = ties.every(x => x !== null);
    const eRoe = hasRoe ? expectedValue(p, roes) : null;
    const sdRoe = hasRoe ? stdDev(p, roes) : null;
    return {
      assets: A,
      debt: D,
      equity: equity,
      interestRate: opts.interestRate,
      years: years,
      probabilitySum: p.reduce((a, b) => a + b, 0),
      eRoe: eRoe,
      sdRoe: sdRoe,
      cvRoe: hasRoe && eRoe !== 0 ? sdRoe / eRoe : null,
      eTie: hasTie ? expectedValue(p, ties) : null,
      sdTie: hasTie ? stdDev(p, ties) : null
    };
  }

  // ---------------------------------------------------------------------
  // CDSS at each amount of borrowing (question d)
  // ---------------------------------------------------------------------

  // EBIT = sales × (1 − variable cost rate) − fixed costs. Same at every debt level.
  function cdssEbit(inp) {
    return inp.sales * (1 - inp.variableCostRate) - inp.fixedCosts;
  }

  function netIncomeAt(inp, ebit, row) {
    const interest = row.debt > 0 ? row.rd * row.debt : 0;
    return { interest: interest, netIncome: (ebit - interest) * (1 - inp.taxRate) };
  }

  // Case method, questions d(3) and d(4): buy back at today's price P0.
  function caseMethod(inp, ebit, row) {
    const T = inp.taxRate;
    const n = inp.shares;
    const A = inp.totalAssets;
    const D = row.debt;
    const ni = netIncomeAt(inp, ebit, row);
    const repurchased = D / inp.price;
    const remaining = n - repurchased;
    const eps = remaining > 0 ? ni.netIncome / remaining : null;
    const price = eps === null ? null : eps / row.rs;
    const rdAfterTax = D > 0 ? row.rd * (1 - T) : 0;
    return {
      debt: D,
      rd: row.rd,
      rs: row.rs,
      interest: ni.interest,
      netIncome: ni.netIncome,
      repurchased: repurchased,
      remaining: remaining,
      eps: eps,
      dps: eps, // CDSS pays out all its earnings
      tie: ni.interest > 0 ? ebit / ni.interest : null,
      price: price,
      // Book weights (the AGE solution's method for d(7))
      waccBook: (D / A) * rdAfterTax + ((A - D) / A) * row.rs,
      management: managementStake(inp, repurchased, remaining)
    };
  }

  // New-price method: buy back at the price after the announcement.
  function newPriceMethod(inp, ebit, row) {
    const T = inp.taxRate;
    const n = inp.shares;
    const D = row.debt;
    const ni = netIncomeAt(inp, ebit, row);
    const S = ni.netIncome / row.rs; // value of equity (g = 0)
    const V = S + D; // value of the firm
    const price = V / n;
    const repurchased = price > 0 ? D / price : null;
    const remaining = repurchased === null ? null : n - repurchased;
    const eps = remaining > 0 ? ni.netIncome / remaining : null;
    const rdAfterTax = D > 0 ? row.rd * (1 - T) : 0;
    const waccMarket = V > 0 ? (D / V) * rdAfterTax + (S / V) * row.rs : null;
    const waccCheckValue = V > 0 ? ebit * (1 - T) / V : null;
    return {
      debt: D,
      rd: row.rd,
      rs: row.rs,
      interest: ni.interest,
      netIncome: ni.netIncome,
      equityValue: S,
      firmValue: V,
      price: price,
      repurchased: repurchased,
      remaining: remaining,
      eps: eps,
      dps: eps,
      tie: ni.interest > 0 ? ebit / ni.interest : null,
      waccMarket: waccMarket,
      management: managementStake(inp, repurchased, remaining),
      // Checks: EPS = r_s × P, and WACC = EBIT(1 − T) / V
      epsCheckOk: eps !== null && close(eps, row.rs * price),
      waccCheckOk: waccMarket !== null && close(waccMarket, waccCheckValue)
    };
  }

  // Management's share of the company after the buyback. Management doesn't
  // sell, so only outside investors' shares can be bought back.
  function managementStake(inp, repurchased, remaining) {
    if (repurchased === null || remaining === null) return { status: 'na' };
    const outside = (1 - inp.managementShare) * inp.shares;
    const tol = 1e-9 * Math.max(1, outside);
    if (repurchased > outside + tol) return { status: 'sell', outside: outside, repurchased: repurchased };
    if (Math.abs(repurchased - outside) <= tol) return { status: 'all', value: 1 };
    return { status: 'ok', value: inp.managementShare * inp.shares / remaining };
  }

  function close(a, b) {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }

  // The debt amount with the highest (or lowest) value. Rows are sorted by
  // debt, so on an exact tie the smaller amount of debt wins.
  function argBest(rows, key, direction) {
    let best = null;
    rows.forEach(r => {
      const v = r[key];
      if (v === null || v === undefined || !Number.isFinite(v)) return;
      if (best === null) { best = r; return; }
      const b = best[key];
      const tol = 1e-12 * Math.max(1, Math.abs(v), Math.abs(b));
      if (direction === 'max' ? v > b + tol : v < b - tol) best = r;
    });
    return best === null ? null : { debt: best.debt, value: best[key] };
  }

  // If both buyback methods pick the same amount, go there. If not, go to the
  // case method's amount and report both (agree = false).
  function buttonTarget(caseBest, newBest) {
    if (!caseBest && !newBest) return null;
    if (!caseBest) return { debt: newBest.debt, caseDebt: null, newDebt: newBest.debt, agree: false };
    return {
      debt: caseBest.debt,
      caseDebt: caseBest.debt,
      newDebt: newBest ? newBest.debt : null,
      agree: !!newBest && newBest.debt === caseBest.debt
    };
  }

  // The Firm L slider's stops: 0 to slider_max in steps of slider_step,
  // always including the case's own amount of debt.
  function firmSliderStops(firmIn) {
    const stops = [];
    if (firmIn.sliderStep > 0) {
      const count = Math.floor(firmIn.sliderMax / firmIn.sliderStep + 1e-9);
      for (let i = 0; i <= count; i++) stops.push(roundHalfUp(i * firmIn.sliderStep, 6));
    }
    if (stops.indexOf(firmIn.firmLDebt) === -1) stops.push(firmIn.firmLDebt);
    return stops.sort((a, b) => a - b);
  }

  function analyzeCdss(inp, schedule) {
    const ebit = cdssEbit(inp);
    const caseRows = schedule.map(r => caseMethod(inp, ebit, r));
    const newRows = schedule.map(r => newPriceMethod(inp, ebit, r));

    const best = {
      casePrice: argBest(caseRows, 'price', 'max'),
      newPrice: argBest(newRows, 'price', 'max'),
      bookWacc: argBest(caseRows, 'waccBook', 'min'),
      marketWacc: argBest(newRows, 'waccMarket', 'min')
    };
    const picks = [best.casePrice, best.newPrice, best.bookWacc, best.marketWacc];
    const allAgree = picks.every(p => p !== null && p.debt === picks[0].debt);
    best.caseEps = argBest(caseRows, 'eps', 'max');
    best.newEps = argBest(newRows, 'eps', 'max');
    // Where the Best price and Highest EPS buttons move the slider.
    const buttons = {
      price: buttonTarget(best.casePrice, best.newPrice),
      eps: buttonTarget(best.caseEps, best.newEps)
    };

    const warnings = [];
    // Check: EPS / r_s at $0 should equal today's price in cdss.csv.
    const zero = caseRows.find(r => r.debt === 0);
    let zeroCheck = null;
    if (!zero) {
      warnings.push('The banker\'s schedule has no $0 row, so the app can\'t check it against today\'s share price.');
    } else {
      zeroCheck = { computed: zero.price, listed: inp.price, ok: Math.abs(zero.price - inp.price) < 0.005 };
      if (!zeroCheck.ok) {
        warnings.push('At $0 of debt, EPS / r_s = ' + fmtMoney(zero.price) + ', but data/cdss.csv says today\'s price is ' +
          fmtMoney(inp.price) + '. The schedule\'s cost of equity at $0 doesn\'t fit today\'s price, so treat the results with care.');
      }
    }
    if (inp.currentDebt) {
      warnings.push('data/cdss.csv shows debt of ' + fmtDollars(inp.currentDebt) +
        '. The app treats each amount in the banker\'s schedule as CDSS\'s total debt.');
    }
    caseRows.forEach(r => {
      if (r.remaining <= 0) warnings.push('Case method: borrowing ' + fmtDollars(r.debt) + ' would buy back every share at ' + fmtMoney(inp.price) + '.');
    });
    const epsChecksOk = newRows.every(r => r.epsCheckOk);
    const waccChecksOk = newRows.every(r => r.waccCheckOk);
    if (!epsChecksOk) warnings.push('New-price method: EPS doesn\'t equal r_s × P at every amount of debt.');
    if (!waccChecksOk) warnings.push('New-price method: market-weight WACC doesn\'t equal EBIT × (1 − T) / V at every amount of debt.');

    return {
      ebit: ebit,
      caseRows: caseRows,
      newRows: newRows,
      best: best,
      buttons: buttons,
      allAgree: allAgree,
      zeroCheck: zeroCheck,
      epsChecksOk: epsChecksOk,
      waccChecksOk: waccChecksOk,
      warnings: warnings
    };
  }

  // ---------------------------------------------------------------------
  // Rounding and display
  // ---------------------------------------------------------------------

  // Round half up on the decimal value. toFixed rounds the binary value and
  // gets cases like 14.025 and 3.495 wrong; toPrecision(12) clears the tiny
  // binary error first.
  function roundHalfUp(x, d) {
    const f = Math.pow(10, d);
    return Math.round(Number((x * f).toPrecision(12))) / f;
  }

  function withCommas(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // x rounded to d decimals, with thousands separators.
  function fmtNumber(x, d) {
    if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
    const r = roundHalfUp(x, d);
    const parts = Math.abs(r).toFixed(d).split('.');
    const body = withCommas(parts[0]) + (parts[1] ? '.' + parts[1] : '');
    return (r < 0 ? '−' : '') + body;
  }

  function signed(x, d, prefix, suffix) {
    if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
    const s = fmtNumber(x, d);
    return s.charAt(0) === '−' ? '−' + prefix + s.slice(1) + suffix : prefix + s + suffix;
  }

  const fmtDollars = x => signed(x, 0, '$', '');           // nearest dollar
  const fmtMoney = x => signed(x, 2, '$', '');             // prices, EPS, dividends
  const fmtPct = x => (x === null || x === undefined ? 'n/a' : fmtNumber(x * 100, 2) + '%');
  const fmtMult = x => (x === null || x === undefined ? 'n/a' : fmtNumber(x, 2) + '×');
  const fmtShares = x => fmtNumber(x, 2);                  // never round share counts away
  // A subtraction on an income statement, shown as (4,000).
  const fmtParen = x => (x === null || x === undefined ? 'n/a' : '(' + fmtNumber(x, 0) + ')');

  const api = {
    parseCSV, toNumber, keyValues, taxRateFrom, cdssInputs, parseSchedule, firmInputs, parseScenarios,
    expectedValue, stdDev, firmExample,
    cdssEbit, caseMethod, newPriceMethod, managementStake, argBest, buttonTarget, firmSliderStops, analyzeCdss,
    roundHalfUp, fmtNumber, fmtDollars, fmtMoney, fmtPct, fmtMult, fmtShares, fmtParen
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CapStruct = api;
})(typeof window !== 'undefined' ? window : this);
