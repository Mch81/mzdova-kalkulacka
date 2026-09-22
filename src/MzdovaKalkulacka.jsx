import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Plus, Trash2, Save, FolderOpen, Calendar, Coins,
  Wallet, Check, Pencil, Copy,
  Briefcase, Building2, SlidersHorizontal, ChevronDown, ArrowDownToLine,
  BarChart3, TrendingUp, Crown,
  Download, Upload, Info, ShieldCheck, FileDown,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Úložiště – adaptér nad localStorage s bezpečným fallbackem          */
/*  (stejné rozhraní jako storage v Claude artefaktech)                */
/* ------------------------------------------------------------------ */
// Některá prostředí (např. Electron na file://) mohou mít localStorage
// nedostupné. Pokud selže, použijeme paměťovou náhradu, ať appka nespadne.
const memStore = new Map();
let lsOk = false;
try {
  const t = "__test__";
  window.localStorage.setItem(t, "1");
  window.localStorage.removeItem(t);
  lsOk = true;
} catch (_) {
  lsOk = false;
}

const backend = lsOk
  ? {
      getItem: (k) => window.localStorage.getItem(k),
      setItem: (k, v) => window.localStorage.setItem(k, v),
      removeItem: (k) => window.localStorage.removeItem(k),
      keys: () => Object.keys(window.localStorage),
    }
  : {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => void memStore.set(k, v),
      removeItem: (k) => void memStore.delete(k),
      keys: () => Array.from(memStore.keys()),
    };

const storage = {
  async get(key) {
    try {
      const value = backend.getItem(key);
      return value === null || value === undefined ? null : { key, value };
    } catch (_) {
      return null;
    }
  },
  async set(key, value) {
    try {
      backend.setItem(key, value);
      return { key, value };
    } catch (_) {
      return null;
    }
  },
  async delete(key) {
    try {
      backend.removeItem(key);
      return { key, deleted: true };
    } catch (_) {
      return { key, deleted: false };
    }
  },
  async list(prefix = "") {
    try {
      const keys = backend.keys().filter((k) => k && k.startsWith(prefix));
      return { keys, prefix };
    } catch (_) {
      return { keys: [], prefix };
    }
  },
};


/* ------------------------------------------------------------------ */
/*  Datový model                                                       */
/* ------------------------------------------------------------------ */
// Mzda:
//   type   – 'employee' | 'osvc'
//   items  – položky (zaměstnanec)
//   invoices – fakturační položky (OSVČ)
//   rates  – editovatelné sazby OSVČ
//
// Položka (zaměstnanec):
//   kind   – 'plat' | 'amount' | 'bonus' | 'extra'
//   period – 'month' | 'year'  (u 'amount' a 'plat')
//
// Faktura (OSVČ):
//   label, amount, period ('month'|'year')

const DAYS_DIVISOR = 20; // extra volno: měsíční plat / 20 × dní
const STATUTORY_VACATION_DAYS = 20; // zákonná dovolená; k ní se přičítají dny navíc

const uid = () => Math.random().toString(36).slice(2, 10);

// Výchozí sazby OSVČ pro rok 2026 (vše editovatelné)
function defaultRates() {
  return {
    expensePct: 60,        // paušální výdaje %
    taxPct: 15,            // základní sazba daně %
    taxPctHigh: 23,        // zvýšená sazba daně %
    progThreshold: 1762812,// hranice pro 23 % (36× průměrná mzda 2026) Kč/rok
    taxCredit: 30840,      // roční sleva na poplatníka Kč
    basePct: 50,           // vyměřovací základ = % ze zisku
    socialPct: 29.2,       // sociální pojištění %
    healthPct: 13.5,       // zdravotní pojištění %
    minSocial: 5720,       // min. měsíční záloha sociální Kč
    minHealth: 3306,       // min. měsíční záloha zdravotní Kč
  };
}

// Výchozí sazby zaměstnance pro rok 2026 (vše editovatelné)
function defaultEmpRates() {
  return {
    socialPct: 7.1,         // sociální pojištění zaměstnance %
    healthPct: 4.5,         // zdravotní pojištění zaměstnance %
    taxPct: 15,             // základní sazba daně %
    taxPctHigh: 23,         // zvýšená sazba daně %
    progThreshold: 1762812, // hranice pro 23 % (36× průměrná mzda 2026) Kč/rok
    taxCredit: 30840,       // roční sleva na poplatníka Kč
  };
}

function defaultItems() {
  return [
    { id: uid(), label: "Plat", kind: "plat", amount: 0, period: "month", removable: false },
    { id: uid(), label: "Penze", kind: "amount", amount: 0, period: "month", removable: false },
    { id: uid(), label: "Životní", kind: "amount", amount: 0, period: "month", removable: false },
    { id: uid(), label: "Cafeterie", kind: "amount", amount: 0, period: "month", removable: false },
    { id: uid(), label: "Stravenky", kind: "amount", amount: 0, period: "month", removable: false },
    { id: uid(), label: "Bonus", kind: "bonus", amount: 0, period: "year", removable: false },
    { id: uid(), label: "Extra volno na zákonných 20 dní", kind: "extra", amount: 0, period: "year", removable: false },
  ];
}

function defaultInvoices() {
  return [{ id: uid(), label: "Faktura", amount: 0, period: "month" }];
}

/* ------------------------------------------------------------------ */
/*  Výpočetní jádro                                                    */
/* ------------------------------------------------------------------ */
function monthlyPlat(items) {
  const plat = items.find((i) => i.kind === "plat");
  if (!plat) return 0;
  return plat.period === "month" ? plat.amount : plat.amount / 12;
}

// vrací { month, year } pro jednu položku
function computeItem(item, items) {
  const a = Number(item.amount) || 0;
  if (item.kind === "extra") {
    // a = počet dní; denní mzda = měsíční Plat / 20
    const daily = monthlyPlat(items) / DAYS_DIVISOR;
    const yr = daily * a;
    return { month: yr / 12, year: yr };
  }
  if (item.kind === "bonus") {
    // bonus je roční
    return { month: a / 12, year: a };
  }
  // plat + běžné položky s přepínačem
  if (item.period === "month") return { month: a, year: a * 12 };
  return { month: a / 12, year: a };
}

function totals(items) {
  let month = 0, year = 0;
  for (const it of items) {
    const c = computeItem(it, items);
    month += c.month;
    year += c.year;
  }
  return { month, year };
}

/* ----- OSVČ: příjem z faktur ----- */
function invoiceTotals(invoices) {
  let month = 0, year = 0;
  for (const inv of invoices) {
    const a = Number(inv.amount) || 0;
    if (inv.period === "month") { month += a; year += a * 12; }
    else { month += a / 12; year += a; }
  }
  return { month, year };
}

/* ----- OSVČ: dopočet odvodů a čisté mzdy (roční základ) ----- */
function osvcCalc(invoices, rates) {
  const r = rates;
  const incomeYear = invoiceTotals(invoices).year; // hrubý příjem / rok

  // Zisk po paušálních výdajích
  const expenses = incomeYear * (r.expensePct / 100);
  const profit = Math.max(0, incomeYear - expenses);

  // Vyměřovací základ pro pojistné
  const base = profit * (r.basePct / 100);

  // Sociální a zdravotní – respektuje minimální zálohy (roční)
  const socialCalc = base * (r.socialPct / 100);
  const healthCalc = base * (r.healthPct / 100);
  const socialMin = r.minSocial * 12;
  const healthMin = r.minHealth * 12;
  const social = incomeYear > 0 ? Math.max(socialCalc, socialMin) : 0;
  const health = incomeYear > 0 ? Math.max(healthCalc, healthMin) : 0;

  // Daň z příjmu: progresivní 15 % do hranice, 23 % nad ni (z daňového základu = zisk)
  const threshold = r.progThreshold;
  const profitLow = Math.min(profit, threshold);
  const profitHigh = Math.max(0, profit - threshold);
  const taxLow = profitLow * (r.taxPct / 100);
  const taxHigh = profitHigh * (r.taxPctHigh / 100);
  const taxBeforeCredit = taxLow + taxHigh;
  const tax = Math.max(0, taxBeforeCredit - r.taxCredit);

  const totalDeductions = social + health + tax;
  const netYear = incomeYear - totalDeductions;

  return {
    incomeYear, incomeMonth: incomeYear / 12,
    expenses, profit, base,
    social, health, tax,
    socialIsMin: incomeYear > 0 && socialCalc < socialMin,
    healthIsMin: incomeYear > 0 && healthCalc < healthMin,
    taxBeforeCredit,
    profitHigh, taxLow, taxHigh,
    inProgression: profitHigh > 0,
    totalDeductions,
    netYear, netMonth: netYear / 12,
  };
}

/* ----- Zaměstnanec: čistá mzda (daň + odvody z peněžní mzdy plat+bonus) ----- */
function employeeCalc(items, empRates) {
  const r = empRates;
  // Hrubá peněžní mzda = Plat + Bonus (daňový a odvodový základ)
  let grossYear = 0;
  let benefitsYear = 0; // ostatní benefity (čistá hodnota, nedaní se v tomto modelu)
  for (const it of items) {
    const c = computeItem(it, items);
    if (it.kind === "plat" || it.kind === "bonus") grossYear += c.year;
    else benefitsYear += c.year;
  }

  // Odvody zaměstnance z hrubé mzdy
  const social = grossYear * (r.socialPct / 100);
  const health = grossYear * (r.healthPct / 100);

  // Daň: progresivní 15 % / 23 % z hrubé mzdy, minus sleva
  const threshold = r.progThreshold;
  const low = Math.min(grossYear, threshold);
  const high = Math.max(0, grossYear - threshold);
  const taxBeforeCredit = low * (r.taxPct / 100) + high * (r.taxPctHigh / 100);
  const tax = Math.max(0, taxBeforeCredit - r.taxCredit);

  const deductions = social + health + tax;
  const netCashYear = grossYear - deductions;       // čistá peněžní mzda
  const netYear = netCashYear + benefitsYear;        // + hodnota benefitů
  const inProgression = high > 0;

  return {
    grossYear, grossMonth: grossYear / 12,
    benefitsYear, benefitsMonth: benefitsYear / 12,
    social, health, tax, taxBeforeCredit, inProgression,
    deductions,
    netCashYear, netCashMonth: netCashYear / 12,
    netYear, netMonth: netYear / 12,
  };
}

/* ----- Jednotný souhrn uloženého záznamu (employee i osvc) ----- */
function recordSummary(rec) {
  const isOsvc = rec.type === "osvc";
  if (isOsvc) {
    const c = osvcCalc(rec.invoices || [], { ...defaultRates(), ...(rec.rates || {}) });
    return {
      isOsvc: true,
      month: c.netMonth, year: c.netYear,
      grossMonth: c.incomeMonth, grossYear: c.incomeYear,
      vacationDays: 0, vacBonusMonth: 0, vacBonusYear: 0,
      compareMonth: c.netMonth, compareYear: c.netYear,
      detail: c,
    };
  }
  const t = totals(rec.items || []);
  const e = employeeCalc(rec.items || [], { ...defaultEmpRates(), ...(rec.empRates || {}) });
  // počet dní volna = 20 zákonných + dny navíc (z položky „Extra volno")
  const extraDays = Number((rec.items || []).find((i) => i.kind === "extra")?.amount) || 0;
  const days = STATUTORY_VACATION_DAYS + extraDays;
  const vacBonusYear = (e.netMonth / DAYS_DIVISOR) * days;  // bonus za volno / rok
  const vacBonusMonth = vacBonusYear / 12;
  return {
    isOsvc: false,
    month: e.netMonth, year: e.netYear,                       // čistá mzda (vč. benefitů)
    grossMonth: t.month, grossYear: t.year,                   // hrubý balíček celkem
    vacationDays: days, vacBonusMonth, vacBonusYear,
    compareMonth: e.netMonth + vacBonusMonth,                 // pro porovnání: + bonus za volno
    compareYear: e.netYear + vacBonusYear,
    detail: e,
  };
}

/* ------------------------------------------------------------------ */
/*  Formátování                                                        */
/* ------------------------------------------------------------------ */
const fmt = (n) =>
  new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 }).format(
    Math.round(Number(n) || 0)
  );

/* ------------------------------------------------------------------ */
/*  Komponenta řádku položky                                           */
/* ------------------------------------------------------------------ */
function ItemRow({ item, items, onChange, onRemove }) {
  const c = computeItem(item, items);
  const isExtra = item.kind === "extra";
  const isBonus = item.kind === "bonus";
  const hasPeriod = item.kind === "amount" || item.kind === "plat";

  return (
    <div className="row">
      <div className="row-label">
        {item.custom ? (
          <input
            className="label-edit"
            value={item.label}
            onChange={(e) => onChange({ ...item, label: e.target.value })}
            placeholder="Název položky"
          />
        ) : (
          <span className="label-text">{item.label}</span>
        )}
        {isExtra && <span className="hint">{`dny navíc nad ${STATUTORY_VACATION_DAYS} zákonných`}</span>}
        {isBonus && <span className="hint">ročně</span>}
      </div>

      <div className="row-input">
        <input
          type="number"
          inputMode="decimal"
          value={item.amount === 0 ? "" : item.amount}
          placeholder={isExtra ? "počet dní" : "0"}
          onChange={(e) =>
            onChange({ ...item, amount: e.target.value === "" ? 0 : Number(e.target.value) })
          }
        />
        {isExtra ? (
          <span className="unit">dní</span>
        ) : isBonus ? (
          <span className="unit fixed">Kč / rok</span>
        ) : hasPeriod ? (
          <div className="toggle">
            <button
              className={item.period === "month" ? "on" : ""}
              onClick={() => onChange({ ...item, period: "month" })}
            >
              měsíc
            </button>
            <button
              className={item.period === "year" ? "on" : ""}
              onClick={() => onChange({ ...item, period: "year" })}
            >
              rok
            </button>
          </div>
        ) : null}
      </div>

      <div className="row-calc">
        <div className="calc-cell">
          <span className="calc-k">měsíc</span>
          <span className="calc-v">{fmt(c.month)}</span>
        </div>
        <div className="calc-cell">
          <span className="calc-k">rok</span>
          <span className="calc-v">{fmt(c.year)}</span>
        </div>
      </div>

      <button
        className="row-del"
        disabled={!item.removable}
        title={item.removable ? "Odebrat" : "Základní položku nelze odebrat"}
        onClick={() => item.removable && onRemove(item.id)}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Řádek faktury (OSVČ)                                                */
/* ------------------------------------------------------------------ */
function InvoiceRow({ inv, onChange, onRemove, canRemove }) {
  const a = Number(inv.amount) || 0;
  const month = inv.period === "month" ? a : a / 12;
  const year = inv.period === "month" ? a * 12 : a;
  return (
    <div className="row">
      <div className="row-label">
        <input
          className="label-edit"
          value={inv.label}
          onChange={(e) => onChange({ ...inv, label: e.target.value })}
          placeholder="Faktura"
        />
      </div>
      <div className="row-input">
        <input
          type="number"
          inputMode="decimal"
          value={inv.amount === 0 ? "" : inv.amount}
          placeholder="0"
          onChange={(e) =>
            onChange({ ...inv, amount: e.target.value === "" ? 0 : Number(e.target.value) })
          }
        />
        <div className="toggle">
          <button
            className={inv.period === "month" ? "on" : ""}
            onClick={() => onChange({ ...inv, period: "month" })}
          >
            měsíc
          </button>
          <button
            className={inv.period === "year" ? "on" : ""}
            onClick={() => onChange({ ...inv, period: "year" })}
          >
            rok
          </button>
        </div>
      </div>
      <div className="row-calc">
        <div className="calc-cell">
          <span className="calc-k">měsíc</span>
          <span className="calc-v">{fmt(month)}</span>
        </div>
        <div className="calc-cell">
          <span className="calc-k">rok</span>
          <span className="calc-v">{fmt(year)}</span>
        </div>
      </div>
      <button
        className="row-del"
        disabled={!canRemove}
        title={canRemove ? "Odebrat fakturu" : "Aspoň jedna faktura musí zůstat"}
        onClick={() => canRemove && onRemove(inv.id)}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Řádek editovatelné sazby                                           */
/* ------------------------------------------------------------------ */
function RateField({ label, suffix, value, onChange }) {
  return (
    <label className="rate-field">
      <span className="rate-label">{label}</span>
      <span className="rate-input">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
        <span className="rate-suffix">{suffix}</span>
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  Porovnání mezd                                                     */
/* ------------------------------------------------------------------ */
function CompareView({ records }) {
  const data = records.map((rec) => {
    const s = recordSummary(rec);
    return {
      id: rec.id, name: rec.name, isOsvc: s.isOsvc,
      net: s.month, netYear: s.year,                  // čistá mzda bez bonusu za volno
      vacBonus: s.vacBonusMonth, vacBonusYear: s.vacBonusYear,
      vacationDays: s.vacationDays,
      month: s.compareMonth, year: s.compareYear,     // finální porovnávané hodnoty
    };
  }).sort((a, b) => b.month - a.month);                // seřazeno od nejvyšší celkové částky

  const anyVac = data.some((d) => d.vacBonus > 0);
  const maxMonth = Math.max(...data.map((d) => d.month), 1);
  const maxYear = Math.max(...data.map((d) => d.year), 1);
  const bestMonth = Math.max(...data.map((d) => d.month));

  const Bars = ({ period, max }) => (
    <div className="cmp-bars">
      {data.map((d) => {
        const netVal = period === "month" ? d.net : d.netYear;
        const bonusVal = period === "month" ? d.vacBonus : d.vacBonusYear;
        const total = netVal + bonusVal;
        const totalPct = Math.max(1, (total / max) * 100);
        const netShare = total > 0 ? (netVal / total) * 100 : 100; // podíl mzdy uvnitř pruhu
        const hasBonus = bonusVal > 0;
        return (
          <div className="cmp-bar-row" key={d.id}>
            <div className="cmp-bar-label">
              <span className="cmp-bar-name">{d.name}</span>
              <span className={d.isOsvc ? "type-tag osvc" : "type-tag"}>{d.isOsvc ? "IČO" : "Zam."}</span>
            </div>
            <div className="cmp-bar-track">
              <div
                className={"cmp-bar-stack" + (d.isOsvc ? " osvc" : "")}
                style={{ width: totalPct + "%" }}
                title={`Celkem: ${fmt(total)} Kč`}
              >
                <div
                  className="cmp-seg net"
                  style={{ width: netShare + "%" }}
                  title={`Čistá mzda: ${fmt(netVal)} Kč`}
                />
                {hasBonus && (
                  <div
                    className="cmp-seg bonus"
                    style={{ width: (100 - netShare) + "%" }}
                    title={`Bonus za volno: ${fmt(bonusVal)} Kč`}
                  />
                )}
              </div>
            </div>
            <div className="cmp-bar-figures">
              <span className="cmp-bar-total">{fmt(total)} Kč</span>
              {bonusVal > 0 && (
                <span className="cmp-bar-split">
                  <span className="split-net">{fmt(netVal)}</span>
                  <span className="split-plus">+</span>
                  <span className="split-bonus">{fmt(bonusVal)}</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="compare">
      {/* tabulka */}
      <div className="cmp-table-wrap">
        <table className="cmp-table">
          <thead>
            <tr>
              <th>Mzda</th>
              <th>Typ</th>
              <th className="num">Čistá / měsíc</th>
              {anyVac && <th className="num">Bonus za volno</th>}
              <th className="num">Celkem / měsíc</th>
              <th className="num">Celkem / rok</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id} className={d.month === bestMonth ? "best-row" : ""}>
                <td className="cmp-td-name">
                  {d.month === bestMonth && <Crown size={14} className="crown" />}
                  {d.name}
                </td>
                <td>
                  <span className={d.isOsvc ? "type-tag osvc" : "type-tag"}>{d.isOsvc ? "IČO" : "Zaměstnanec"}</span>
                </td>
                <td className="num mono">{fmt(d.net)} Kč</td>
                {anyVac && (
                  <td className="num mono vac-col">
                    {d.vacBonus > 0 ? `+${fmt(d.vacBonus)} Kč` : "—"}
                    {d.vacBonus > 0 && <span className="vac-days-note">{d.vacationDays} dní</span>}
                  </td>
                )}
                <td className="num mono strong-col">{fmt(d.month)} Kč</td>
                <td className="num mono">{fmt(d.year)} Kč</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.length > 1 && (
        <p className="cmp-note">
          <TrendingUp size={14} /> Nejvyšší celkový měsíční příjem: <strong>{fmt(bestMonth)} Kč</strong>
          {(() => {
            const sorted = [...data].sort((a, b) => b.month - a.month);
            if (sorted.length >= 2) {
              const diff = sorted[0].month - sorted[1].month;
              if (diff > 0) return ` — o ${fmt(diff)} Kč/měs víc než druhá v pořadí.`;
            }
            return ".";
          })()}
        </p>
      )}

      {anyVac && (
        <p className="cmp-vac-hint">
          Celková částka u zaměstnance zahrnuje bonus za dny volna: počet dní = {STATUTORY_VACATION_DAYS} zákonných + dny navíc
          (z položky „Extra volno"), ročně (čistá měsíční mzda ÷ {DAYS_DIVISOR}) × počet dní, rozpočítaný do měsíce —
          protože živnostník za volno nedostává nic.
        </p>
      )}

      {/* legenda */}
      {(() => {
        const hasEmp = data.some((d) => !d.isOsvc);
        const hasOsvc = data.some((d) => d.isOsvc);
        return (
          <div className="cmp-legend">
            {hasEmp && <span className="leg-item"><span className="leg-dot net" /> Čistá mzda (zaměstnanec)</span>}
            {anyVac && <span className="leg-item"><span className="leg-dot bonus" /> Bonus za volno</span>}
            {hasOsvc && <span className="leg-item"><span className="leg-dot osvc" /> Čistá mzda (IČO)</span>}
          </div>
        );
      })()}

      {/* grafy */}
      <div className="cmp-section-title">Celkem měsíčně {anyVac && "(vč. bonusu za volno)"}</div>
      <Bars period="month" max={maxMonth} />
      <div className="cmp-section-title">Celkem ročně {anyVac && "(vč. bonusu za volno)"}</div>
      <Bars period="year" max={maxYear} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tisknutelný dokument pro PDF export porovnání                       */
/*  (renderuje se skrytě mimo obrazovku, html2canvas ho pak vyfotí)     */
/* ------------------------------------------------------------------ */
function pdfBreakdown(rec) {
  const s = recordSummary(rec);
  const lines = [];
  if (!s.isOsvc) {
    for (const it of rec.items || []) {
      const a = Number(it.amount) || 0;
      if (!a) continue;
      const c = computeItem(it, rec.items || []);
      lines.push({ label: it.label || "Položka", month: c.month, year: c.year });
    }
  } else {
    for (const inv of rec.invoices || []) {
      const a = Number(inv.amount) || 0;
      if (!a) continue;
      const month = inv.period === "month" ? a : a / 12;
      const year = inv.period === "month" ? a * 12 : a;
      lines.push({ label: inv.label || "Faktura", month, year });
    }
  }
  return { s, lines };
}

function ComparePdfDoc({ records }) {
  const data = records
    .map((rec) => ({ rec, s: recordSummary(rec) }))
    .sort((a, b) => b.s.compareMonth - a.s.compareMonth);

  const anyVac = data.some((d) => d.s.vacBonusMonth > 0);
  const maxMonth = Math.max(...data.map((d) => d.s.compareMonth), 1);
  const maxYear = Math.max(...data.map((d) => d.s.compareYear), 1);
  const bestMonth = Math.max(...data.map((d) => d.s.compareMonth));
  const dateStr = new Date().toLocaleDateString("cs-CZ", {
    day: "numeric", month: "long", year: "numeric",
  });

  const Bars = ({ period }) => {
    const max = period === "month" ? maxMonth : maxYear;
    return (
      <div className="pdf-bars">
        {data.map(({ rec, s }) => {
          const netVal = period === "month" ? s.month : s.year;
          const bonusVal = period === "month" ? s.vacBonusMonth : s.vacBonusYear;
          const total = netVal + bonusVal;
          const totalPct = Math.max(2, (total / max) * 100);
          const netShare = total > 0 ? (netVal / total) * 100 : 100;
          return (
            <div className="pdf-bar-row" key={rec.id}>
              <div className="pdf-bar-name">{rec.name}</div>
              <div className="pdf-bar-track">
                <div
                  className={"pdf-bar-fill" + (s.isOsvc ? " osvc" : "")}
                  style={{ width: totalPct + "%" }}
                >
                  {bonusVal > 0 && (
                    <>
                      <span className="pdf-seg net" style={{ width: netShare + "%" }} />
                      <span className="pdf-seg bonus" style={{ width: 100 - netShare + "%" }} />
                    </>
                  )}
                </div>
              </div>
              <div className="pdf-bar-val">{fmt(total)} Kč</div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="pdf-inner">
      <div className="pdf-header">
        <h1>Porovnání mezd</h1>
        <div className="pdf-sub">Vygenerováno {dateStr} · {data.length} {data.length === 1 ? "mzda" : data.length < 5 ? "mzdy" : "mezd"}</div>
      </div>

      {/* souhrnná tabulka čísel */}
      <table className="pdf-table">
        <thead>
          <tr>
            <th>Mzda</th>
            <th>Typ</th>
            <th className="r">Čistá / měsíc</th>
            {anyVac && <th className="r">Bonus za volno</th>}
            <th className="r">Celkem / měsíc</th>
            <th className="r">Celkem / rok</th>
          </tr>
        </thead>
        <tbody>
          {data.map(({ rec, s }) => (
            <tr key={rec.id} className={s.compareMonth === bestMonth ? "best" : ""}>
              <td>{s.compareMonth === bestMonth ? "★ " : ""}{rec.name}</td>
              <td>{s.isOsvc ? "IČO" : "Zaměstnanec"}</td>
              <td className="r">{fmt(s.month)} Kč</td>
              {anyVac && <td className="r">{s.vacBonusMonth > 0 ? "+" + fmt(s.vacBonusMonth) + " Kč" : "—"}</td>}
              <td className="r strong">{fmt(s.compareMonth)} Kč</td>
              <td className="r">{fmt(s.compareYear)} Kč</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* grafy */}
      <h2 className="pdf-h2">Graf – celkem měsíčně{anyVac ? " (vč. bonusu za volno)" : ""}</h2>
      <Bars period="month" />
      <h2 className="pdf-h2">Graf – celkem ročně{anyVac ? " (vč. bonusu za volno)" : ""}</h2>
      <Bars period="year" />

      {/* rozpis položek jednotlivých mezd */}
      <h2 className="pdf-h2">Rozpis jednotlivých mezd</h2>
      {data.map(({ rec, s }) => {
        const { lines } = pdfBreakdown(rec);
        const d = s.detail;
        return (
          <div className="pdf-detail" key={rec.id}>
            <div className="pdf-detail-head">
              <span className="pdf-detail-name">{rec.name}</span>
              <span className="pdf-detail-type">{s.isOsvc ? "IČO / živnostník" : "Zaměstnanec"}</span>
            </div>
            <table className="pdf-table small">
              <thead>
                <tr>
                  <th>{s.isOsvc ? "Faktura / položka" : "Položka"}</th>
                  <th className="r">Měsíčně</th>
                  <th className="r">Ročně</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={3} className="pdf-empty">Bez vyplněných položek</td></tr>
                )}
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.label}</td>
                    <td className="r">{fmt(l.month)} Kč</td>
                    <td className="r">{fmt(l.year)} Kč</td>
                  </tr>
                ))}
                {s.isOsvc && d && (
                  <>
                    <tr className="sub"><td>Hrubý příjem</td><td className="r">{fmt(d.incomeMonth)} Kč</td><td className="r">{fmt(d.incomeYear)} Kč</td></tr>
                    <tr className="neg"><td>− Sociální pojištění</td><td className="r">−{fmt(d.social / 12)} Kč</td><td className="r">−{fmt(d.social)} Kč</td></tr>
                    <tr className="neg"><td>− Zdravotní pojištění</td><td className="r">−{fmt(d.health / 12)} Kč</td><td className="r">−{fmt(d.health)} Kč</td></tr>
                    <tr className="neg"><td>− Daň z příjmu</td><td className="r">−{fmt(d.tax / 12)} Kč</td><td className="r">−{fmt(d.tax)} Kč</td></tr>
                  </>
                )}
                {!s.isOsvc && s.vacBonusMonth > 0 && (
                  <tr className="sub"><td>+ Bonus za volno ({s.vacationDays} dní)</td><td className="r">+{fmt(s.vacBonusMonth)} Kč</td><td className="r">+{fmt(s.vacBonusYear)} Kč</td></tr>
                )}
                <tr className="total">
                  <td>Čistá mzda{!s.isOsvc && s.vacBonusMonth > 0 ? " vč. bonusu" : ""}</td>
                  <td className="r">{fmt(s.compareMonth)} Kč</td>
                  <td className="r">{fmt(s.compareYear)} Kč</td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}

      <div className="pdf-foot">
        Orientační výpočet dle sazeb 2026 · Mzdová kalkulačka
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Hlavní aplikace                                                    */
/* ------------------------------------------------------------------ */
export default function App() {
  const [view, setView] = useState(() => {
    // první návštěva → přistaneme na úvodní stránce, jinak rovnou u zadání
    try { return backend.getItem("mk_intro_seen") ? "edit" : "info"; } catch (_) { return "info"; }
  }); // 'info' | 'edit' | 'saved' | 'compare'
  const [type, setType] = useState(null); // null (nevybráno) | 'employee' | 'osvc'
  const [items, setItems] = useState(defaultItems);
  const [invoices, setInvoices] = useState(defaultInvoices);
  const [rates, setRates] = useState(defaultRates);
  const [empRates, setEmpRates] = useState(defaultEmpRates);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [empRatesOpen, setEmpRatesOpen] = useState(false);
  const [name, setName] = useState("");
  const [currentId, setCurrentId] = useState(null);
  const [saved, setSaved] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [compareIds, setCompareIds] = useState([]); // vybrané mzdy k porovnání
  const [toast, setToast] = useState(null);
  const [dirty, setDirty] = useState(false);
  const fileInputRef = useRef(null);
  const [exportName, setExportName] = useState("");
  const pdfRef = useRef(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  const t = totals(items);
  const osvc = osvcCalc(invoices, rates);
  const emp = employeeCalc(items, empRates);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  /* ---- úvodní stránka viděná → příště přistaneme rovnou u zadání ---- */
  useEffect(() => {
    storage.set("mk_intro_seen", "1");
  }, []);

  /* ---- načtení seznamu uložených mezd ---- */
  const refreshList = useCallback(async () => {
    try {
      const res = await storage.list("mzda:");
      const keys = (res && res.keys) || [];
      const out = [];
      for (const k of keys) {
        try {
          const r = await storage.get(k);
          if (r && r.value) out.push(JSON.parse(r.value));
        } catch (_) {}
      }
      out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      setSaved(out);
    } catch (e) {
      console.error("list error", e);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  /* ---- akce: položky zaměstnance ---- */
  const updateItem = (next) => {
    setItems((arr) => arr.map((i) => (i.id === next.id ? next : i)));
    setDirty(true);
  };
  const removeItem = (id) => {
    setItems((arr) => arr.filter((i) => i.id !== id));
    setDirty(true);
  };
  const addCustom = () => {
    setItems((arr) => [
      ...arr,
      { id: uid(), label: "", kind: "amount", amount: 0, period: "month", removable: true, custom: true },
    ]);
    setDirty(true);
  };

  /* ---- akce: faktury OSVČ ---- */
  const updateInvoice = (next) => {
    setInvoices((arr) => arr.map((i) => (i.id === next.id ? next : i)));
    setDirty(true);
  };
  const removeInvoice = (id) => {
    setInvoices((arr) => (arr.length > 1 ? arr.filter((i) => i.id !== id) : arr));
    setDirty(true);
  };
  const addInvoice = () => {
    setInvoices((arr) => [...arr, { id: uid(), label: "Faktura", amount: 0, period: "month" }]);
    setDirty(true);
  };

  /* ---- akce: sazby ---- */
  const updateRate = (key, val) => {
    setRates((r) => ({ ...r, [key]: val }));
    setDirty(true);
  };
  const resetRates = () => {
    setRates(defaultRates());
    setDirty(true);
    flash("Sazby obnoveny na 2026");
  };
  const updateEmpRate = (key, val) => {
    setEmpRates((r) => ({ ...r, [key]: val }));
    setDirty(true);
  };
  const resetEmpRates = () => {
    setEmpRates(defaultEmpRates());
    setDirty(true);
    flash("Sazby obnoveny na 2026");
  };

  const changeType = (next) => {
    if (next === type) return;
    setType(next);
    setDirty(true);
  };

  const newSheet = () => {
    setType(null);
    setItems(defaultItems());
    setInvoices(defaultInvoices());
    setRates(defaultRates());
    setEmpRates(defaultEmpRates());
    setName("");
    setCurrentId(null);
    setDirty(false);
    setView("edit");
    flash("Nová mzda připravena");
  };

  const save = async () => {
    const nm = name.trim() || "Bez názvu";
    const id = currentId || "mzda:" + uid();
    const record = { id, name: nm, type, items, invoices, rates, empRates, updated: Date.now() };
    try {
      const r = await storage.set(id, JSON.stringify(record));
      if (!r) return flash("Uložení se nezdařilo");
      setCurrentId(id);
      setName(nm);
      setDirty(false);
      await refreshList();
      setView("saved"); // po uložení skoč na přehled uložených mezd
      flash(`Uloženo: ${nm}`);
    } catch (e) {
      console.error(e);
      flash("Chyba při ukládání");
    }
  };

  const load = (rec) => {
    setType(rec.type || "employee");
    setItems((rec.items || defaultItems()).map((i) => ({ ...i })));
    setInvoices((rec.invoices || defaultInvoices()).map((i) => ({ ...i })));
    setRates({ ...defaultRates(), ...(rec.rates || {}) });
    setEmpRates({ ...defaultEmpRates(), ...(rec.empRates || {}) });
    setName(rec.name);
    setCurrentId(rec.id);
    setDirty(false);
    setView("edit");
    flash(`Načteno: ${rec.name}`);
  };

  const duplicate = (rec) => {
    setType(rec.type || "employee");
    setItems((rec.items || defaultItems()).map((i) => ({ ...i, id: uid() })));
    setInvoices((rec.invoices || defaultInvoices()).map((i) => ({ ...i, id: uid() })));
    setRates({ ...defaultRates(), ...(rec.rates || {}) });
    setEmpRates({ ...defaultEmpRates(), ...(rec.empRates || {}) });
    setName(rec.name + " (kopie)");
    setCurrentId(null);
    setDirty(true);
    setView("edit");
    flash("Vytvořena kopie – ulož ji");
  };

  const del = async (rec) => {
    try {
      await storage.delete(rec.id);
      if (rec.id === currentId) {
        setCurrentId(null);
      }
      setCompareIds((ids) => ids.filter((x) => x !== rec.id));
      await refreshList();
      flash("Smazáno");
    } catch (e) {
      console.error(e);
      flash("Mazání se nezdařilo");
    }
  };

  /* ---- export všech uložených mezd do souboru (JSON) ---- */
  const exportData = () => {
    const base = exportName.trim();
    if (!base) {
      flash("Název souboru je povinný");
      return;
    }
    try {
      const payload = {
        app: "mzdova-kalkulacka",
        verze: 1,
        exportovano: new Date().toISOString(),
        pocet: saved.length,
        mzdy: saved,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      // sanitizace: pryč s lomítky, doplníme .json
      const safe = base.replace(/[\\/]+/g, "-");
      const filename = safe.toLowerCase().endsWith(".json") ? safe : safe + ".json";
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash(
        saved.length
          ? `Vyexportováno ${saved.length} ${saved.length === 1 ? "mzda" : saved.length < 5 ? "mzdy" : "mezd"}`
          : "Export hotový (zatím žádné uložené mzdy)"
      );
    } catch (e) {
      console.error(e);
      flash("Export se nezdařil");
    }
  };

  /* ---- import mezd z dříve vyexportovaného souboru ---- */
  const importData = async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data && data.mzdy)
        ? data.mzdy
        : null;
      if (!list) {
        flash("Soubor nemá očekávaný formát");
        return;
      }
      let n = 0;
      for (const rec of list) {
        if (!rec || typeof rec !== "object") continue;
        const id =
          typeof rec.id === "string" && rec.id.startsWith("mzda:")
            ? rec.id
            : "mzda:" + uid();
        const clean = { ...rec, id, updated: rec.updated || Date.now() };
        await storage.set(id, JSON.stringify(clean));
        n++;
      }
      await refreshList();
      setView("saved");
      flash(
        n
          ? `Naimportováno ${n} ${n === 1 ? "mzda" : n < 5 ? "mzdy" : "mezd"}`
          : "Soubor neobsahoval žádné mzdy"
      );
    } catch (e) {
      console.error(e);
      flash("Import se nezdařil – neplatný soubor");
    }
  };

  const toggleCompare = (id) => {
    setCompareIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    );
  };

  /* ---- export porovnání do PDF (grafy + čísla + rozpis položek) ---- */
  const exportComparePDF = async () => {
    const node = pdfRef.current;
    if (!node || compareRecords.length === 0) {
      flash("Nejdřív vyber mzdy k porovnání");
      return;
    }
    setPdfBusy(true);
    try {
      // knihovny načteme až teď (nezvětšují hlavní bundle)
      const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
        import("jspdf"),
        import("html2canvas"),
      ]);
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch (_) {}
      }
      const canvas = await html2canvas(node, {
        scale: 2,
        backgroundColor: "#ffffff",
        windowWidth: node.scrollWidth,
      });
      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 10;
      const imgW = pageW - margin * 2;
      const usableH = pageH - margin * 2;
      // kolik pixelů plátna se vejde na jednu stránku
      const pxPerPage = Math.floor((usableH * canvas.width) / imgW);

      let sy = 0;
      let page = 0;
      while (sy < canvas.height) {
        const sliceH = Math.min(pxPerPage, canvas.height - sy);
        // vyřízneme jen tu část plátna, která patří na aktuální stránku
        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = canvas.width;
        pageCanvas.height = sliceH;
        const ctx = pageCanvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        ctx.drawImage(canvas, 0, sy, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        const pageImg = pageCanvas.toDataURL("image/jpeg", 0.92);
        const pageImgH = (sliceH * imgW) / canvas.width;
        if (page > 0) pdf.addPage();
        pdf.addImage(pageImg, "JPEG", margin, margin, imgW, pageImgH);
        sy += sliceH;
        page++;
      }
      pdf.save("porovnani-mezd.pdf");
      flash("PDF vygenerováno");
    } catch (e) {
      console.error(e);
      flash("PDF se nezdařilo");
    } finally {
      setPdfBusy(false);
    }
  };

  const compareRecords = compareIds
    .map((id) => saved.find((r) => r.id === id))
    .filter(Boolean);

  return (
    <>
      <style>{css}</style>

      <div className="wrap">
        {/* dekorativní pozadí */}
        <div className="bg-grid" />
        <div className="bg-glow" />

        <header className="head">
          <div className="brand">
            <div className="brand-mark"><Wallet size={20} /></div>
            <div>
              <h1>Mzdová kalkulačka</h1>
              <p>Zaměstnanec i živnostník v jednom přehledu</p>
            </div>
          </div>
          <div className="head-actions">
            <button className="btn primary" onClick={newSheet}>
              <Plus size={16} /> Nová mzda
            </button>
          </div>
        </header>

        {/* hlavní menu */}
        <nav className="mainnav">
          <button
            className={view === "info" ? "nav-btn on" : "nav-btn"}
            onClick={() => setView("info")}
          >
            <Info size={16} /> Úvod
          </button>
          <button
            className={view === "edit" ? "nav-btn on" : "nav-btn"}
            onClick={() => setView("edit")}
          >
            <Pencil size={16} /> Zadej mzdu
          </button>
          <button
            className={view === "saved" ? "nav-btn on" : "nav-btn"}
            onClick={() => setView("saved")}
          >
            <FolderOpen size={16} /> Uložené mzdy
            {saved.length > 0 && <span className="navbadge">{saved.length}</span>}
          </button>
          <button
            className={view === "compare" ? "nav-btn on" : "nav-btn"}
            onClick={() => setView("compare")}
          >
            <BarChart3 size={16} /> Porovnání mezd
          </button>
        </nav>

        {/* SEKCE: Úvod – upozornění na ukládání + export/import */}
        {view === "info" && (
          <div className="section">
            <div className="intro-page">
              <div className="intro-mark"><ShieldCheck size={26} /></div>
              <h2>Vítej v mzdové kalkulačce</h2>
              <p className="intro-lead">
                Tahle kalkulačka <strong>neukládá tvá data na žádný server</strong>.
                Uložené mzdy zůstávají jen ve tvém prohlížeči na tomto zařízení.
              </p>
              <ul className="intro-list">
                <li>Data mohou <strong>zmizet</strong> při smazání dat prohlížeče, v anonymním okně nebo na jiném počítači či prohlížeči.</li>
                <li>Pro trvalé uchování nebo přenos jinam si data <strong>vyexportuj do souboru</strong>.</li>
                <li>Exportovaný soubor kdykoli zase <strong>naimportuješ</strong> zpět.</li>
              </ul>

              <div className="intro-data">
                <span className="intro-data-title">Záloha dat</span>
                <label className="export-name">
                  <span className="export-name-label">Název souboru pro export <em>*</em></span>
                  <div className="export-name-input">
                    <input
                      type="text"
                      value={exportName}
                      placeholder="např. moje-mzdy"
                      onChange={(e) => setExportName(e.target.value)}
                    />
                    <span className="export-name-suffix">.json</span>
                  </div>
                </label>
                <div className="intro-actions">
                  <button className="btn primary" onClick={exportData}>
                    <Download size={16} /> Exportovat data
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  >
                    <Upload size={16} /> Importovat data
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files && e.target.files[0];
                      if (f) importData(f);
                      e.target.value = "";
                    }}
                  />
                </div>
                <p className="intro-hint">
                  Export uloží všechny tvé uložené mzdy do jednoho souboru. Import je zase načte zpět –
                  třeba na jiném počítači nebo po smazání dat prohlížeče.
                </p>
              </div>

              <button className="btn primary center" onClick={() => setView("edit")}>
                <Pencil size={16} /> Začít zadávat mzdu
              </button>
            </div>
          </div>
        )}

        {view === "edit" && (
        <>
        {/* nejdřív vyber, koho počítáš – teprve pak se zobrazí pole */}
        {!type && (
          <p className="type-prompt">Koho budeme počítat? Vyber typ mzdy:</p>
        )}
        <div className="typeswitch">
          <button
            className={type === "employee" ? "ts-btn on" : "ts-btn"}
            onClick={() => changeType("employee")}
          >
            <Briefcase size={16} /> Zaměstnanec
          </button>
          <button
            className={type === "osvc" ? "ts-btn on" : "ts-btn"}
            onClick={() => changeType("osvc")}
          >
            <Building2 size={16} /> IČO / živnostník
          </button>
        </div>

        {type && (
        <>
        <div className="namebar">
          <div className="name-field">
            <Pencil size={14} />
            <input
              value={name}
              placeholder="Pojmenuj tuto mzdu (např. Současná práce)"
              onChange={(e) => { setName(e.target.value); setDirty(true); }}
            />
          </div>
          <button className="btn primary" onClick={save}>
            <Save size={16} /> {currentId ? "Uložit změny" : "Uložit mzdu"}
          </button>
        </div>

        {/* souhrn */}
        {type === "employee" ? (
          <div className="summary">
            <div className="sum-card big net">
              <span className="sum-k"><Calendar size={14} /> Čistá mzda měsíčně</span>
              <span className="sum-v">{fmt(emp.netMonth)} <small>Kč</small></span>
            </div>
            <div className="sum-card">
              <span className="sum-k"><Coins size={14} /> Čistá mzda ročně</span>
              <span className="sum-v">{fmt(emp.netYear)} <small>Kč</small></span>
            </div>
          </div>
        ) : (
          <div className="summary">
            <div className="sum-card big net">
              <span className="sum-k"><Calendar size={14} /> Čistá mzda měsíčně</span>
              <span className="sum-v">{fmt(osvc.netMonth)} <small>Kč</small></span>
            </div>
            <div className="sum-card">
              <span className="sum-k"><Coins size={14} /> Čistá mzda ročně</span>
              <span className="sum-v">{fmt(osvc.netYear)} <small>Kč</small></span>
            </div>
          </div>
        )}

        {/* obsah podle typu */}
        {type === "employee" ? (
          <>
            <div className="table">
              <div className="thead">
                <span>Položka</span>
                <span>Zadání</span>
                <span className="th-calc">Výpočet</span>
                <span />
              </div>
              {items.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  items={items}
                  onChange={updateItem}
                  onRemove={removeItem}
                />
              ))}
              <button className="add-row" onClick={addCustom}>
                <Plus size={16} /> Přidat vlastní položku
              </button>
            </div>


            {/* dopočet čisté mzdy zaměstnance */}
            <div className="breakdown">
              <div className="bd-row head">
                <span>Výpočet čisté mzdy (ročně)</span>
                <span />
              </div>
              <div className="bd-row">
                <span>Hrubá mzda (Plat + Bonus)</span>
                <span className="bd-v">{fmt(emp.grossYear)} Kč</span>
              </div>
              <div className="bd-row deduct">
                <span>Sociální pojištění ({empRates.socialPct} %)</span>
                <span className="bd-v">−{fmt(emp.social)} Kč</span>
              </div>
              <div className="bd-row deduct">
                <span>Zdravotní pojištění ({empRates.healthPct} %)</span>
                <span className="bd-v">−{fmt(emp.health)} Kč</span>
              </div>
              <div className="bd-row deduct">
                <span>
                  Daň z příjmu
                  {emp.inProgression
                    ? ` (${empRates.taxPct} % / ${empRates.taxPctHigh} % − sleva ${fmt(empRates.taxCredit)})`
                    : ` (${empRates.taxPct} % − sleva ${fmt(empRates.taxCredit)})`}
                  {emp.inProgression && <em className="min-tag prog">23 % nad {fmt(empRates.progThreshold)}</em>}
                </span>
                <span className="bd-v">−{fmt(emp.tax)} Kč</span>
              </div>
              <div className="bd-row total-line">
                <span>= Čistá peněžní mzda</span>
                <span className="bd-v">{fmt(emp.netCashYear)} Kč</span>
              </div>
              {emp.benefitsYear > 0 && (
                <div className="bd-row">
                  <span>+ Hodnota benefitů (penze, stravenky, …)</span>
                  <span className="bd-v">{fmt(emp.benefitsYear)} Kč</span>
                </div>
              )}
              <div className="bd-row net-line">
                <span><ArrowDownToLine size={15} /> Čistá mzda ročně</span>
                <span className="bd-v">{fmt(emp.netYear)} Kč</span>
              </div>
              <div className="bd-row net-line month">
                <span>Čistá mzda měsíčně</span>
                <span className="bd-v">{fmt(emp.netMonth)} Kč</span>
              </div>
            </div>

            {/* editovatelné sazby zaměstnance */}
            <div className="rates">
              <button className="rates-toggle" onClick={() => setEmpRatesOpen((o) => !o)}>
                <span><SlidersHorizontal size={15} /> Sazby a parametry výpočtu</span>
                <ChevronDown size={16} className={empRatesOpen ? "rot" : ""} />
              </button>
              {empRatesOpen && (
                <div className="rates-body">
                  <div className="rates-grid">
                    <RateField label="Sociální pojištění" suffix="%" value={empRates.socialPct} onChange={(v) => updateEmpRate("socialPct", v)} />
                    <RateField label="Zdravotní pojištění" suffix="%" value={empRates.healthPct} onChange={(v) => updateEmpRate("healthPct", v)} />
                    <RateField label="Sazba daně" suffix="%" value={empRates.taxPct} onChange={(v) => updateEmpRate("taxPct", v)} />
                    <RateField label="Zvýšená sazba daně" suffix="%" value={empRates.taxPctHigh} onChange={(v) => updateEmpRate("taxPctHigh", v)} />
                    <RateField label="Hranice pro zvýšenou daň" suffix="Kč/rok" value={empRates.progThreshold} onChange={(v) => updateEmpRate("progThreshold", v)} />
                    <RateField label="Sleva na poplatníka" suffix="Kč/rok" value={empRates.taxCredit} onChange={(v) => updateEmpRate("taxCredit", v)} />
                  </div>
                  <button className="rates-reset" onClick={resetEmpRates}>
                    Obnovit výchozí hodnoty (2026)
                  </button>
                </div>
              )}
            </div>

            <p className="footnote">
              Bonus se zadává jako roční částka. Do „Extra volno" zadej dny dovolené navíc nad zákonných {STATUTORY_VACATION_DAYS} dní
              (hodnota = měsíční Plat ÷ {DAYS_DIVISOR} × dny navíc). V Porovnání s IČO se počítá bonus za {STATUTORY_VACATION_DAYS} zákonných + dny navíc.
              Čistá mzda se počítá z peněžní mzdy (Plat + Bonus): odečte se sociální {empRates.socialPct} %,
              zdravotní {empRates.healthPct} % a daň ({empRates.taxPct} % / {empRates.taxPctHigh} %) po slevě na poplatníka.
              Hodnota nepeněžních benefitů (penze, stravenky, cafeterie, extra volno) se připočítává v plné výši.
              Jde o orientační odhad — skutečnou výplatu ověř ve mzdové účtárně.
            </p>
          </>
        ) : (
          <>
            {/* faktury */}
            <div className="table">
              <div className="thead">
                <span>Faktura</span>
                <span>Zadání</span>
                <span className="th-calc">Výpočet</span>
                <span />
              </div>
              {invoices.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  inv={inv}
                  onChange={updateInvoice}
                  onRemove={removeInvoice}
                  canRemove={invoices.length > 1}
                />
              ))}
              <button className="add-row" onClick={addInvoice}>
                <Plus size={16} /> Přidat fakturu
              </button>
            </div>

            {/* dopočet odvodů */}
            <div className="breakdown">
              <div className="bd-row head">
                <span>Výpočet odvodů (ročně)</span>
                <span />
              </div>
              <div className="bd-row">
                <span>Hrubý příjem (faktury)</span>
                <span className="bd-v">{fmt(osvc.incomeYear)} Kč</span>
              </div>
              <div className="bd-row sub">
                <span>− Paušální výdaje ({rates.expensePct} %)</span>
                <span className="bd-v">−{fmt(osvc.expenses)} Kč</span>
              </div>
              <div className="bd-row total-line">
                <span>= Zisk (daňový základ)</span>
                <span className="bd-v">{fmt(osvc.profit)} Kč</span>
              </div>
              <div className="bd-row deduct">
                <span>
                  Sociální pojištění ({rates.socialPct} %)
                  {osvc.socialIsMin && <em className="min-tag">min. záloha</em>}
                </span>
                <span className="bd-v">−{fmt(osvc.social)} Kč</span>
              </div>
              <div className="bd-row deduct">
                <span>
                  Zdravotní pojištění ({rates.healthPct} %)
                  {osvc.healthIsMin && <em className="min-tag">min. záloha</em>}
                </span>
                <span className="bd-v">−{fmt(osvc.health)} Kč</span>
              </div>
              <div className="bd-row deduct">
                <span>
                  Daň z příjmu
                  {osvc.inProgression
                    ? ` (${rates.taxPct} % / ${rates.taxPctHigh} % − sleva ${fmt(rates.taxCredit)})`
                    : ` (${rates.taxPct} % − sleva ${fmt(rates.taxCredit)})`}
                  {osvc.inProgression && <em className="min-tag prog">23 % nad {fmt(rates.progThreshold)}</em>}
                </span>
                <span className="bd-v">−{fmt(osvc.tax)} Kč</span>
              </div>
              <div className="bd-row net-line">
                <span><ArrowDownToLine size={15} /> Čistá mzda ročně</span>
                <span className="bd-v">{fmt(osvc.netYear)} Kč</span>
              </div>
              <div className="bd-row net-line month">
                <span>Čistá mzda měsíčně</span>
                <span className="bd-v">{fmt(osvc.netMonth)} Kč</span>
              </div>
            </div>

            {/* editovatelné sazby */}
            <div className="rates">
              <button className="rates-toggle" onClick={() => setRatesOpen((o) => !o)}>
                <span><SlidersHorizontal size={15} /> Sazby a parametry výpočtu</span>
                <ChevronDown size={16} className={ratesOpen ? "rot" : ""} />
              </button>
              {ratesOpen && (
                <div className="rates-body">
                  <div className="rates-grid">
                    <RateField label="Paušální výdaje" suffix="%" value={rates.expensePct} onChange={(v) => updateRate("expensePct", v)} />
                    <RateField label="Sazba daně" suffix="%" value={rates.taxPct} onChange={(v) => updateRate("taxPct", v)} />
                    <RateField label="Zvýšená sazba daně" suffix="%" value={rates.taxPctHigh} onChange={(v) => updateRate("taxPctHigh", v)} />
                    <RateField label="Hranice pro zvýšenou daň" suffix="Kč/rok" value={rates.progThreshold} onChange={(v) => updateRate("progThreshold", v)} />
                    <RateField label="Sleva na poplatníka" suffix="Kč/rok" value={rates.taxCredit} onChange={(v) => updateRate("taxCredit", v)} />
                    <RateField label="Vyměřovací základ" suffix="% ze zisku" value={rates.basePct} onChange={(v) => updateRate("basePct", v)} />
                    <RateField label="Sociální pojištění" suffix="%" value={rates.socialPct} onChange={(v) => updateRate("socialPct", v)} />
                    <RateField label="Zdravotní pojištění" suffix="%" value={rates.healthPct} onChange={(v) => updateRate("healthPct", v)} />
                    <RateField label="Min. záloha sociální" suffix="Kč/měs" value={rates.minSocial} onChange={(v) => updateRate("minSocial", v)} />
                    <RateField label="Min. záloha zdravotní" suffix="Kč/měs" value={rates.minHealth} onChange={(v) => updateRate("minHealth", v)} />
                  </div>
                  <button className="rates-reset" onClick={resetRates}>
                    Obnovit výchozí hodnoty (2026)
                  </button>
                </div>
              )}
            </div>

            <p className="footnote">
              Mzda = součet všech faktur. Výpočet používá paušální výdaje {rates.expensePct} %, vyměřovací základ {rates.basePct} % ze zisku
              a respektuje minimální zálohy. Daň je progresivní: {rates.taxPct} % z daňového základu do {fmt(rates.progThreshold)} Kč
              a {rates.taxPctHigh} % z části nad touto hranicí, snížená o slevu na poplatníka.
              Jde o orientační odhad — skutečné odvody ověř u účetního.
            </p>
          </>
        )}
        </>
        )}
        </>
        )}

        {/* SEKCE: Uložené mzdy */}
        {view === "saved" && (
          <div className="section">
            {loadingList ? (
              <p className="muted">Načítám…</p>
            ) : saved.length === 0 ? (
              <div className="empty card">
                <FolderOpen size={30} />
                <p>Zatím nemáš žádnou uloženou mzdu.</p>
                <span>Přejdi na „Zadej mzdu", vyplň údaje a ulož.</span>
                <button className="btn primary center" onClick={newSheet}>
                  <Plus size={16} /> Zadat první mzdu
                </button>
              </div>
            ) : (
              <div className="saved-grid">
                {saved.map((rec) => {
                  const s = recordSummary(rec);
                  return (
                    <div key={rec.id} className={rec.id === currentId ? "save-card active" : "save-card"}>
                      <div className="sc-head">
                        <span className={s.isOsvc ? "type-tag osvc" : "type-tag"}>
                          {s.isOsvc ? "IČO" : "Zaměstnanec"}
                        </span>
                        {rec.id === currentId && <span className="now"><Check size={12} /> aktivní</span>}
                      </div>
                      <h3 className="sc-name">{rec.name}</h3>
                      <div className="sc-figures">
                        <div>
                          <span className="sc-k">Čistá / měsíc</span>
                          <span className="sc-v">{fmt(s.month)} Kč</span>
                        </div>
                        <div>
                          <span className="sc-k">Čistá / rok</span>
                          <span className="sc-v">{fmt(s.year)} Kč</span>
                        </div>
                      </div>
                      <div className="sc-actions">
                        <button className="btn ghost sm" onClick={() => load(rec)}>
                          <Pencil size={14} /> Otevřít
                        </button>
                        <button className="icon-btn" title="Duplikovat" onClick={() => duplicate(rec)}>
                          <Copy size={15} />
                        </button>
                        <button className="icon-btn danger" title="Smazat" onClick={() => del(rec)}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* SEKCE: Porovnání mezd */}
        {view === "compare" && (
          <div className="section">
            {saved.length === 0 ? (
              <div className="empty card">
                <BarChart3 size={30} />
                <p>Není co porovnávat.</p>
                <span>Nejdřív si ulož aspoň dvě mzdy.</span>
              </div>
            ) : (
              <>
                <p className="cmp-hint">Vyber mzdy, které chceš porovnat:</p>
                <div className="pick-list">
                  {saved.map((rec) => {
                    const s = recordSummary(rec);
                    const on = compareIds.includes(rec.id);
                    return (
                      <button
                        key={rec.id}
                        className={on ? "pick on" : "pick"}
                        onClick={() => toggleCompare(rec.id)}
                      >
                        <span className="pick-check">{on && <Check size={13} />}</span>
                        <span className="pick-name">{rec.name}</span>
                        <span className={s.isOsvc ? "type-tag osvc" : "type-tag"}>
                          {s.isOsvc ? "IČO" : "Zam."}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {compareRecords.length === 0 ? (
                  <p className="muted center-text">Vyber aspoň jednu mzdu výše.</p>
                ) : (
                  <>
                    <div className="cmp-export">
                      <button className="btn primary" onClick={exportComparePDF} disabled={pdfBusy}>
                        <FileDown size={16} /> {pdfBusy ? "Generuji PDF…" : "Exportovat do PDF"}
                      </button>
                    </div>
                    <CompareView records={compareRecords} />
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* skrytý dokument pro PDF export (html2canvas ho vyfotí) */}
      {compareRecords.length > 0 && (
        <div className="pdf-doc" ref={pdfRef} aria-hidden="true">
          <ComparePdfDoc records={compareRecords} />
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Styly                                                              */
/* ------------------------------------------------------------------ */
const css = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Outfit:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap');

* { box-sizing: border-box; }

.wrap {
  --bg:#f2f4f8; --panel:#ffffff; --panel2:#eef1f6; --line:#dde2ec;
  --txt:#1a1f2e; --mut:#6b7385; --acc:#3b6cf6; --acc2:#13a085;
  --good:#13a085; --danger:#e0524d;
  --bonus:#7c5cf0;
  position:relative; min-height:100vh; padding:32px 20px 64px;
  background:var(--bg); color:var(--txt);
  font-family:'Outfit',sans-serif; overflow-x:hidden;
  max-width:920px; margin:0 auto;
}
.bg-grid {
  position:fixed; inset:0; pointer-events:none; z-index:0;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:46px 46px; opacity:.5;
  mask-image:radial-gradient(circle at 50% 0%,#000 0%,transparent 70%);
}
.bg-glow {
  position:fixed; top:-160px; left:50%; transform:translateX(-50%);
  width:680px; height:420px; z-index:0; pointer-events:none;
  background:radial-gradient(ellipse,rgba(59,108,246,.16),transparent 65%);
  filter:blur(20px);
}
.wrap > *:not(.bg-grid):not(.bg-glow){ position:relative; z-index:1; }

.head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:26px; }
.brand { display:flex; gap:14px; align-items:center; }
.brand-mark {
  width:44px; height:44px; border-radius:13px; display:grid; place-items:center;
  background:linear-gradient(145deg,#5b82f8,var(--acc)); color:#fff;
  box-shadow:0 6px 18px rgba(59,108,246,.30);
}
.head h1 { margin:0; font-family:'Fraunces',serif; font-weight:600; font-size:25px; letter-spacing:-.01em; }
.head p { margin:2px 0 0; color:var(--mut); font-size:13.5px; }
.head-actions { display:flex; gap:9px; }

/* hlavní navigace */
.mainnav {
  display:flex; gap:6px; padding:6px; background:var(--panel);
  border:1px solid var(--line); border-radius:15px; margin-bottom:24px;
  box-shadow:0 2px 8px rgba(35,33,28,.04);
}
.nav-btn {
  flex:1; display:inline-flex; align-items:center; justify-content:center; gap:8px;
  border:none; background:none; cursor:pointer; color:var(--mut);
  padding:12px 12px; border-radius:11px; font-size:14.5px; font-weight:600;
  font-family:inherit; transition:.16s; position:relative;
}
.nav-btn:hover { color:var(--txt); background:var(--panel2); }
.nav-btn.on { background:var(--acc); color:#fff; box-shadow:0 4px 12px rgba(59,108,246,.28); }
.nav-btn.on:hover { background:var(--acc); color:#fff; }
.navbadge {
  background:rgba(255,255,255,.28); color:#fff; font-size:11px; font-weight:700;
  min-width:18px; height:18px; border-radius:9px; display:grid; place-items:center; padding:0 5px;
}
.nav-btn:not(.on) .navbadge { background:var(--panel2); color:var(--mut); }

.section { animation:fade .2s ease; }
.center { align-self:center; margin-top:16px; }
.center-text { text-align:center; margin-top:18px; }

.btn {
  display:inline-flex; align-items:center; gap:7px; cursor:pointer;
  border:1px solid var(--line); background:var(--panel); color:var(--txt);
  padding:9px 14px; border-radius:11px; font-size:13.5px; font-weight:500;
  font-family:inherit; transition:.16s; position:relative;
  box-shadow:0 1px 2px rgba(35,33,28,.04);
}
.btn:hover { border-color:#c2cad8; transform:translateY(-1px); }
.btn.ghost:hover { background:var(--panel2); }
.btn.primary { background:linear-gradient(145deg,#5b82f8,var(--acc)); color:#fff; border:none; font-weight:600; box-shadow:0 5px 16px rgba(59,108,246,.30); }
.btn.primary:hover { filter:brightness(1.04); }
.badge {
  position:absolute; top:-7px; right:-7px; background:var(--acc2); color:#fff;
  font-size:11px; font-weight:700; min-width:18px; height:18px; border-radius:9px;
  display:grid; place-items:center; padding:0 5px;
}

.namebar { display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap; }
.name-field {
  flex:1; min-width:240px; display:flex; align-items:center; gap:10px;
  background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:0 14px;
  color:var(--mut);
}
.name-field input {
  flex:1; background:none; border:none; outline:none; color:var(--txt);
  font-family:inherit; font-size:15px; padding:13px 0;
}
.name-field input::placeholder { color:var(--mut); }
.name-field:focus-within { border-color:var(--acc); }

.type-prompt {
  margin:0 0 10px; font-size:15px; font-weight:600; color:var(--txt);
}
.typeswitch {
  display:flex; gap:6px; padding:5px; background:var(--panel2);
  border:1px solid var(--line); border-radius:14px; margin-bottom:20px;
}
.ts-btn {
  flex:1; display:inline-flex; align-items:center; justify-content:center; gap:8px;
  border:none; background:none; cursor:pointer; color:var(--mut);
  padding:11px 14px; border-radius:10px; font-size:14.5px; font-weight:600;
  font-family:inherit; transition:.16s;
}
.ts-btn:hover { color:var(--txt); }
.ts-btn.on { background:var(--panel); color:var(--txt); box-shadow:0 2px 8px rgba(35,33,28,.08); }

.summary { display:flex; gap:14px; margin-bottom:24px; flex-wrap:wrap; }
.sum-card {
  flex:1; min-width:180px; background:var(--panel); border:1px solid var(--line);
  border-radius:16px; padding:18px 20px; display:flex; flex-direction:column; gap:8px;
  box-shadow:0 2px 8px rgba(35,33,28,.04);
}
.sum-card.big {
  background:linear-gradient(150deg,#fff,#eef3fe);
  border-color:#c6d4f7; box-shadow:0 4px 16px rgba(59,108,246,.12);
}
.sum-card.big.net {
  background:linear-gradient(150deg,#fff,#e9f7f3);
  border-color:#bce8dd; box-shadow:0 4px 16px rgba(19,160,133,.14);
}
.sum-k { display:flex; align-items:center; gap:7px; color:var(--mut); font-size:13px; font-weight:500; }
.sum-v { font-family:'JetBrains Mono',monospace; font-size:30px; font-weight:600; letter-spacing:-.02em; }
.sum-card.big .sum-v { color:var(--acc); }
.sum-card.big.net .sum-v { color:var(--acc2); }
.sum-v small { font-size:15px; color:var(--mut); font-weight:500; }

.table {
  background:var(--panel); border:1px solid var(--line); border-radius:18px;
  overflow:hidden; box-shadow:0 2px 10px rgba(35,33,28,.04);
}
.thead, .row {
  display:grid; grid-template-columns:1.3fr 1.5fr 1.4fr 44px;
  align-items:center; gap:14px; padding:13px 18px;
}
.thead {
  font-size:11.5px; text-transform:uppercase; letter-spacing:.07em;
  color:var(--mut); font-weight:600; border-bottom:1px solid var(--line);
  background:var(--panel2);
}
.th-calc { text-align:left; }
.row { border-bottom:1px solid var(--line); transition:background .14s; }
.row:hover { background:var(--panel2); }

.row-label { display:flex; flex-direction:column; gap:2px; }
.label-text { font-weight:600; font-size:15px; }
.label-edit {
  background:var(--bg); border:1px solid var(--line); border-radius:8px;
  padding:7px 9px; color:var(--txt); font-family:inherit; font-size:14px; font-weight:600; outline:none; width:100%;
}
.label-edit:focus { border-color:var(--acc); }
.hint { font-size:11px; color:var(--mut); }

.row-input { display:flex; align-items:center; gap:8px; }
.row-input input[type=number] {
  width:100%; max-width:130px; background:var(--bg); border:1px solid var(--line);
  border-radius:9px; padding:9px 11px; color:var(--txt);
  font-family:'JetBrains Mono',monospace; font-size:14px; outline:none;
}
.row-input input[type=number]:focus { border-color:var(--acc); }
.unit { font-size:12.5px; color:var(--mut); white-space:nowrap; }
.unit.fixed { font-size:12px; }

.toggle { display:inline-flex; background:var(--bg); border:1px solid var(--line); border-radius:9px; overflow:hidden; }
.toggle button {
  border:none; background:none; color:var(--mut); cursor:pointer;
  padding:7px 11px; font-size:12.5px; font-family:inherit; font-weight:500; transition:.14s;
}
.toggle button.on { background:var(--acc); color:#fff; font-weight:600; }

.row-calc { display:flex; gap:18px; }
.calc-cell { display:flex; flex-direction:column; gap:1px; }
.calc-k { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--mut); }
.calc-v { font-family:'JetBrains Mono',monospace; font-size:14.5px; font-weight:600; }

.row-del {
  border:none; background:none; color:var(--mut); cursor:pointer;
  display:grid; place-items:center; padding:7px; border-radius:8px; transition:.14s;
}
.row-del:hover:not(:disabled) { color:var(--danger); background:rgba(224,82,77,.1); }
.row-del:disabled { opacity:.25; cursor:not-allowed; }

.add-row {
  width:100%; border:none; background:none; color:var(--acc2); cursor:pointer;
  display:flex; align-items:center; justify-content:center; gap:8px;
  padding:15px; font-size:14px; font-weight:600; font-family:inherit; transition:.14s;
}
.add-row:hover { background:var(--panel2); }

.footnote { color:var(--mut); font-size:12.5px; line-height:1.6; margin:18px 4px 0; }

/* pole počet dní volna */
.vacation {
  margin-top:16px; display:flex; align-items:center; justify-content:space-between;
  gap:16px; flex-wrap:wrap; background:var(--panel); border:1px solid var(--line);
  border-radius:16px; padding:16px 20px; box-shadow:0 2px 8px rgba(35,33,28,.04);
}
.vac-label { display:flex; align-items:center; gap:12px; color:var(--acc); }
.vac-label > div { display:flex; flex-direction:column; gap:2px; }
.vac-title { font-weight:600; font-size:15px; color:var(--txt); }
.vac-sub { font-size:12px; color:var(--mut); }
.vac-input {
  display:flex; align-items:center; gap:9px; background:var(--bg);
  border:1px solid var(--line); border-radius:10px; padding:0 13px;
}
.vac-input:focus-within { border-color:var(--acc); }
.vac-input input {
  width:80px; background:none; border:none; outline:none; color:var(--txt);
  font-family:'JetBrains Mono',monospace; font-size:15px; padding:11px 0; text-align:right;
}
.vac-input .unit { font-size:13px; color:var(--mut); white-space:nowrap; }

/* porovnání – sloupec bonusu za volno */
.cmp-table .vac-col { color:var(--acc); font-size:13px; font-weight:600; }
.vac-days-note { display:block; font-size:10.5px; color:var(--mut); font-weight:500; margin-top:1px; }
.cmp-table .strong-col { font-weight:700; }
.cmp-vac-hint {
  color:var(--mut); font-size:12.5px; line-height:1.6; margin:0 2px 24px;
}

/* breakdown odvodů */
.breakdown {
  margin-top:18px; background:var(--panel); border:1px solid var(--line);
  border-radius:18px; overflow:hidden; box-shadow:0 2px 10px rgba(35,33,28,.04);
}
.bd-row {
  display:flex; justify-content:space-between; align-items:center; gap:14px;
  padding:13px 20px; border-bottom:1px solid var(--line); font-size:14.5px;
}
.bd-row:last-child { border-bottom:none; }
.bd-row.head {
  background:var(--panel2); font-size:11.5px; text-transform:uppercase;
  letter-spacing:.07em; color:var(--mut); font-weight:600; padding:12px 20px;
}
.bd-row.sub { color:var(--mut); padding-top:9px; padding-bottom:9px; }
.bd-row.total-line { font-weight:600; background:rgba(59,108,246,.05); }
.bd-row.deduct span:first-child { display:flex; align-items:center; gap:8px; }
.bd-row.deduct .bd-v { color:var(--danger); }
.bd-row.net-line {
  font-weight:700; background:rgba(19,160,133,.08); color:var(--acc2);
}
.bd-row.net-line span:first-child { display:flex; align-items:center; gap:8px; }
.bd-row.net-line.month { background:rgba(19,160,133,.05); font-weight:600; }
.bd-row.net-line .bd-v { color:var(--acc2); }
.bd-v { font-family:'JetBrains Mono',monospace; font-weight:600; white-space:nowrap; }
.min-tag {
  font-style:normal; font-size:10.5px; font-weight:600; margin-left:8px;
  background:var(--panel2); color:var(--mut); padding:2px 7px; border-radius:6px;
}
.min-tag.prog { background:rgba(59,108,246,.12); color:var(--acc); }

/* sazby */
.rates { margin-top:14px; }
.rates-toggle {
  width:100%; display:flex; justify-content:space-between; align-items:center;
  background:var(--panel); border:1px solid var(--line); border-radius:13px;
  padding:13px 18px; cursor:pointer; color:var(--txt); font-family:inherit;
  font-size:14px; font-weight:600; transition:.14s;
}
.rates-toggle:hover { background:var(--panel2); }
.rates-toggle span { display:flex; align-items:center; gap:9px; }
.rates-toggle .rot { transform:rotate(180deg); }
.rates-toggle svg { transition:transform .2s; }
.rates-body {
  margin-top:10px; background:var(--panel); border:1px solid var(--line);
  border-radius:13px; padding:18px;
}
.rates-grid {
  display:grid; grid-template-columns:repeat(2,1fr); gap:12px 16px;
}
.rate-field { display:flex; flex-direction:column; gap:6px; }
.rate-label { font-size:12.5px; color:var(--mut); font-weight:500; }
.rate-input {
  display:flex; align-items:center; gap:8px; background:var(--bg);
  border:1px solid var(--line); border-radius:9px; padding:0 11px;
}
.rate-input:focus-within { border-color:var(--acc); }
.rate-input input {
  flex:1; min-width:0; background:none; border:none; outline:none; color:var(--txt);
  font-family:'JetBrains Mono',monospace; font-size:14px; padding:9px 0;
}
.rate-suffix { font-size:12px; color:var(--mut); white-space:nowrap; }
.rates-reset {
  margin-top:14px; background:none; border:1px solid var(--line); border-radius:9px;
  color:var(--mut); cursor:pointer; padding:9px 14px; font-family:inherit;
  font-size:13px; font-weight:500; transition:.14s;
}
.rates-reset:hover { color:var(--txt); border-color:#c2cad8; }

/* type tag v seznamu uložených */
.type-tag {
  font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
  background:rgba(19,160,133,.14); color:var(--acc2); padding:2px 7px; border-radius:6px;
}
.type-tag.osvc { background:rgba(124,92,240,.14); color:var(--bonus); }

/* karty uložených mezd */
.saved-grid {
  display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:14px;
}
.save-card {
  background:var(--panel); border:1px solid var(--line); border-radius:16px;
  padding:18px; display:flex; flex-direction:column; gap:13px;
  box-shadow:0 2px 8px rgba(35,33,28,.04); transition:.16s;
}
.save-card:hover { border-color:#c2cad8; transform:translateY(-2px); box-shadow:0 6px 18px rgba(35,33,28,.08); }
.save-card.active { border-color:var(--acc); }
.sc-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sc-name { margin:0; font-family:'Fraunces',serif; font-weight:600; font-size:19px; letter-spacing:-.01em; }
.sc-figures { display:flex; gap:18px; }
.sc-figures > div { display:flex; flex-direction:column; gap:2px; }
.sc-k { font-size:11.5px; color:var(--mut); font-weight:500; }
.sc-v { font-family:'JetBrains Mono',monospace; font-size:16.5px; font-weight:600; }
.sc-actions { display:flex; align-items:center; gap:8px; margin-top:2px; }
.sc-actions .btn.sm { flex:1; padding:8px 12px; font-size:13px; justify-content:center; }
.now { display:inline-flex; align-items:center; gap:3px; font-size:11px; color:var(--acc2); font-weight:600; }

.empty.card {
  display:flex; flex-direction:column; align-items:center; text-align:center;
  background:var(--panel); border:1px solid var(--line); border-radius:18px;
  padding:50px 24px; color:var(--mut);
}
.empty.card svg { opacity:.5; margin-bottom:14px; }
.empty.card p { margin:0 0 4px; font-weight:600; color:var(--txt); font-size:16px; }
.empty.card span { font-size:13.5px; }

/* výběr mezd k porovnání */
.cmp-hint { color:var(--mut); font-size:14px; margin:0 0 12px; font-weight:500; }
.pick-list { display:flex; flex-wrap:wrap; gap:9px; margin-bottom:26px; }
.pick {
  display:inline-flex; align-items:center; gap:9px; cursor:pointer;
  background:var(--panel); border:1px solid var(--line); border-radius:11px;
  padding:9px 13px 9px 10px; font-family:inherit; font-size:14px; font-weight:500;
  color:var(--txt); transition:.14s;
}
.pick:hover { border-color:#c2cad8; }
.pick.on { border-color:var(--acc); background:rgba(59,108,246,.06); }
.pick-check {
  width:19px; height:19px; border-radius:6px; border:1.5px solid var(--line);
  display:grid; place-items:center; color:#fff; flex-shrink:0; transition:.14s;
}
.pick.on .pick-check { background:var(--acc); border-color:var(--acc); }
.pick-name { font-weight:600; }

/* porovnání – tabulka */
.compare { animation:fade .2s ease; }
.cmp-table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:16px; box-shadow:0 2px 8px rgba(35,33,28,.04); }
.cmp-table { width:100%; border-collapse:collapse; background:var(--panel); }
.cmp-table th {
  text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.06em;
  color:var(--mut); font-weight:600; padding:13px 16px; background:var(--panel2);
  border-bottom:1px solid var(--line); white-space:nowrap;
}
.cmp-table th.num, .cmp-table td.num { text-align:right; }
.cmp-table td { padding:14px 16px; border-bottom:1px solid var(--line); font-size:14.5px; }
.cmp-table tr:last-child td { border-bottom:none; }
.cmp-table .mono { font-family:'JetBrains Mono',monospace; font-weight:600; white-space:nowrap; }
.cmp-td-name { font-weight:600; display:flex; align-items:center; gap:7px; }
.cmp-table .best-row { background:rgba(19,160,133,.07); }
.crown { color:var(--acc2); flex-shrink:0; }

.cmp-note {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  background:rgba(19,160,133,.08); border:1px solid #bce8dd; border-radius:12px;
  padding:12px 16px; margin:16px 0 28px; font-size:13.5px; color:var(--txt);
}
.cmp-note svg { color:var(--acc2); flex-shrink:0; }
.cmp-note strong { color:var(--acc2); }

/* porovnání – pruhy */
.cmp-section-title {
  font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--mut);
  font-weight:600; margin:0 2px 12px;
}
.cmp-bars { display:flex; flex-direction:column; gap:13px; margin-bottom:30px; }
.cmp-bar-row { display:flex; align-items:center; gap:14px; }
.cmp-bar-label { width:150px; flex-shrink:0; display:flex; align-items:center; gap:7px; }
.cmp-bar-name {
  font-weight:600; font-size:13.5px; white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; max-width:104px;
}
.cmp-bar-track {
  flex:1; position:relative; background:var(--panel2); border-radius:9px;
  height:30px; overflow:hidden;
}
.cmp-bar-stack {
  position:absolute; left:0; top:0; height:100%; display:flex;
  border-radius:9px; overflow:hidden; transition:width .5s cubic-bezier(.2,.8,.2,1);
}
.cmp-seg { height:100%; transition:width .5s cubic-bezier(.2,.8,.2,1); }
/* Zaměstnanec: mzda zelená, bonus modrý */
.cmp-seg.net { background:linear-gradient(90deg,#3fc0a5,var(--acc2)); }
.cmp-seg.bonus { background:linear-gradient(90deg,#5b82f8,var(--acc)); }
/* IČO: celý pruh fialový */
.cmp-bar-stack.osvc .cmp-seg.net { background:linear-gradient(90deg,#9277f4,var(--bonus)); }
.cmp-bar-figures {
  width:148px; flex-shrink:0; display:flex; flex-direction:column; gap:1px; text-align:right;
}
.cmp-bar-total { font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:700; color:var(--txt); }
.cmp-bar-split { font-family:'JetBrains Mono',monospace; font-size:11.5px; display:flex; gap:5px; justify-content:flex-end; align-items:center; }
.split-net { color:var(--acc2); font-weight:600; }
.split-plus { color:var(--mut); }
.split-bonus { color:var(--acc); font-weight:600; }

.cmp-legend { display:flex; gap:18px; margin:0 2px 16px; flex-wrap:wrap; }
.leg-item { display:inline-flex; align-items:center; gap:7px; font-size:12.5px; color:var(--mut); font-weight:500; }
.leg-dot { width:13px; height:13px; border-radius:4px; }
.leg-dot.net { background:linear-gradient(90deg,#3fc0a5,var(--acc2)); }
.leg-dot.bonus { background:linear-gradient(90deg,#5b82f8,var(--acc)); }
.leg-dot.osvc { background:linear-gradient(90deg,#9277f4,var(--bonus)); }

/* navigace mezi sekcemi a sdílené prvky */
@keyframes fade { from{opacity:0} to{opacity:1} }
.icon-btn {
  border:none; background:var(--panel2); color:var(--mut); cursor:pointer;
  width:32px; height:32px; border-radius:9px; display:grid; place-items:center; transition:.14s;
}
.icon-btn:hover { color:var(--txt); }
.icon-btn.danger:hover { color:var(--danger); background:rgba(224,82,77,.12); }
.muted { color:var(--mut); font-size:14px; }

/* úvodní stránka – upozornění na ukládání + záloha dat */
.intro-page {
  position:relative; background:var(--panel); border:1px solid var(--line);
  border-radius:20px; padding:30px 30px 28px; box-shadow:0 12px 34px rgba(26,31,46,.10);
}
.intro-mark {
  width:52px; height:52px; border-radius:14px; display:grid; place-items:center;
  background:linear-gradient(135deg,var(--acc),var(--acc2)); color:#fff; margin-bottom:16px;
}
.intro-page h2 { margin:0 0 8px; font-family:'Fraunces',serif; font-size:24px; color:var(--txt); }
.intro-lead { margin:0 0 14px; font-size:15px; line-height:1.55; color:var(--txt); max-width:620px; }
.intro-lead strong { color:var(--danger); }
.intro-list { margin:0 0 22px; padding-left:18px; display:flex; flex-direction:column; gap:8px; max-width:620px; }
.intro-list li { font-size:14px; line-height:1.5; color:var(--mut); }
.intro-list strong { color:var(--txt); }

.intro-data {
  background:var(--panel2); border:1px solid var(--line); border-radius:14px;
  padding:16px 18px; margin-bottom:22px;
}
.intro-data-title {
  display:block; font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase;
  color:var(--mut); margin-bottom:12px;
}
.export-name { display:block; margin-bottom:14px; max-width:360px; }
.export-name-label { display:block; font-size:13px; font-weight:600; color:var(--txt); margin-bottom:6px; }
.export-name-label em { color:var(--danger); font-style:normal; }
.export-name-input {
  display:flex; align-items:center; background:var(--panel); border:1px solid var(--line);
  border-radius:10px; padding:0 12px; transition:.14s;
}
.export-name-input:focus-within { border-color:var(--acc); box-shadow:0 0 0 3px rgba(59,108,246,.14); }
.export-name-input input {
  flex:1; border:none; background:none; outline:none; padding:10px 0; font-size:14px;
  font-family:inherit; color:var(--txt); min-width:0;
}
.export-name-suffix { color:var(--mut); font-size:14px; font-family:'JetBrains Mono',monospace; }
.intro-actions { display:flex; gap:10px; flex-wrap:wrap; }
.intro-hint {
  margin:12px 0 0; font-size:12.5px; line-height:1.5; color:var(--mut); max-width:560px;
}
@media (max-width:680px){
  .intro-page { padding:24px 20px; }
  .intro-actions{ flex-direction:column; align-items:stretch; }
  .intro-actions .btn{ justify-content:center; }
}

/* export porovnání do PDF – tlačítko */
.cmp-export { display:flex; justify-content:flex-end; margin-bottom:16px; }
.cmp-export .btn[disabled] { opacity:.6; cursor:default; }

/* skrytý dokument, který html2canvas vyfotí do PDF (mimo .wrap → pevné barvy) */
.pdf-doc { position:fixed; left:-10000px; top:0; width:760px; background:#fff; z-index:-1; }
.pdf-inner {
  width:760px; background:#fff; color:#1a1f2e; padding:36px 40px;
  font-family:'Outfit','Segoe UI',system-ui,sans-serif;
}
.pdf-header { border-bottom:2px solid #1a1f2e; padding-bottom:14px; margin-bottom:22px; }
.pdf-header h1 { margin:0; font-size:26px; font-weight:700; letter-spacing:-.01em; }
.pdf-sub { margin-top:5px; font-size:13px; color:#6b7385; }
.pdf-h2 { font-size:16px; font-weight:700; margin:26px 0 12px; color:#1a1f2e; }

.pdf-table { width:100%; border-collapse:collapse; font-size:13px; }
.pdf-table th { text-align:left; padding:9px 10px; background:#eef1f6; color:#4a5163; font-weight:600; border-bottom:1px solid #dde2ec; }
.pdf-table td { padding:9px 10px; border-bottom:1px solid #eef1f6; }
.pdf-table th.r, .pdf-table td.r { text-align:right; }
.pdf-table td.strong { font-weight:700; }
.pdf-table tr.best td { background:#e9f7f2; }
.pdf-table.small { font-size:12.5px; }
.pdf-table.small th { background:#f4f6fa; }
.pdf-table tr.neg td { color:#b0453f; }
.pdf-table tr.sub td { color:#4a5163; }
.pdf-table tr.total td { font-weight:700; border-top:2px solid #1a1f2e; background:#f4f6fa; }
.pdf-empty { color:#9aa1b2; font-style:italic; }

.pdf-bars { display:flex; flex-direction:column; gap:9px; margin-bottom:4px; }
.pdf-bar-row { display:flex; align-items:center; gap:12px; }
.pdf-bar-name { width:150px; font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pdf-bar-track { flex:1; height:22px; background:#eef1f6; border-radius:6px; overflow:hidden; }
.pdf-bar-fill { height:100%; background:#13a085; border-radius:6px; display:flex; }
.pdf-bar-fill.osvc { background:#9277f4; }
.pdf-seg { height:100%; display:block; }
.pdf-seg.net { background:#13a085; }
.pdf-seg.bonus { background:#7c5cf0; }
.pdf-bar-val { width:112px; text-align:right; font-size:12.5px; font-weight:700; }

.pdf-detail { margin-bottom:18px; border:1px solid #dde2ec; border-radius:10px; overflow:hidden; }
.pdf-detail-head { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#f4f6fa; border-bottom:1px solid #dde2ec; }
.pdf-detail-name { font-weight:700; font-size:14px; }
.pdf-detail-type { font-size:12px; color:#6b7385; }
.pdf-detail .pdf-table th:first-child, .pdf-detail .pdf-table td:first-child { padding-left:14px; }
.pdf-detail .pdf-table th:last-child, .pdf-detail .pdf-table td:last-child { padding-right:14px; }
.pdf-foot { margin-top:24px; padding-top:12px; border-top:1px solid #dde2ec; font-size:11px; color:#9aa1b2; text-align:center; }

.toast {
  position:fixed; bottom:26px; left:50%; transform:translateX(-50%); z-index:60;
  background:var(--txt); border:1px solid var(--txt); color:var(--bg);
  padding:12px 20px; border-radius:12px; font-size:14px; font-weight:500;
  box-shadow:0 10px 30px rgba(35,33,28,.25); animation:pop .25s ease;
}
@keyframes pop { from{transform:translate(-50%,12px);opacity:0} to{transform:translate(-50%,0);opacity:1} }

@media (max-width:680px){
  .thead { display:none; }
  .row { grid-template-columns:1fr 44px; grid-template-areas:"label del" "input input" "calc calc"; gap:10px; padding:15px 16px; }
  .row-label{grid-area:label;} .row-del{grid-area:del;} .row-input{grid-area:input;} .row-calc{grid-area:calc; padding-top:4px; border-top:1px dashed var(--line);}
  .row-input input[type=number]{max-width:none;}
  .sum-v{font-size:26px;}
  .rates-grid{ grid-template-columns:1fr; }
  .ts-btn{ font-size:13.5px; padding:11px 8px; }
  .bd-row{ font-size:13.5px; padding:12px 16px; }
  .nav-btn{ font-size:12.5px; padding:11px 6px; gap:5px; flex-direction:column; }
  .cmp-bar-label{ width:90px; }
  .cmp-bar-name{ max-width:64px; font-size:12px; }
  .cmp-bar-figures{ width:96px; }
  .cmp-bar-total{ font-size:13px; }
  .cmp-bar-split{ font-size:10px; }
  .saved-grid{ grid-template-columns:1fr; }
}
`;
