# Mzdová kalkulačka

Desktopová aplikace pro macOS – výpočet a porovnání čisté mzdy zaměstnance i
živnostníka (IČO). Umožňuje zadat plat a benefity, dopočítat odvody a daně, mzdy
ukládat, pojmenovávat a vzájemně porovnávat.

Aplikace je postavená na Electronu, takže z ní jde vytvořit klasická `.dmg`
instalačka s ikonou v Docku.

---

## Co budeš potřebovat

Nainstalovaný **Node.js** verze 18 nebo novější. Ověříš v Terminálu:

    node --version

Pokud příkaz vypíše chybu, stáhni Node.js z https://nodejs.org (verze „LTS",
instaluje se jako běžná .pkg aplikace) nebo přes Homebrew: brew install node

**Důležité:** `.dmg` pro macOS lze sestavit **pouze na macOS**. Na Windows ani
Linuxu to nepůjde.

---

## Vytvoření .dmg instalačky

V Terminálu přejdi do složky projektu a spusť:

    # 1) nainstaluj závislosti (jednou, při prvním sestavení)
    npm install

    # 2) sestav .dmg
    npm run dist

Sestavení může pár minut trvat (poprvé se stahuje Electron). Hotová `.dmg`
najdeš ve složce **release/** – soubor se jmenuje přibližně
„Mzdová kalkulacka-1.0.0-arm64.dmg" (nebo -x64 pro starší Intel Macy).

Tu `.dmg` pak otevřeš dvojklikem a aplikaci přetáhneš do složky Aplikace,
přesně jako u jakékoli jiné macOS appky.

### Než aplikaci poprvé otevřeš

Aplikace není podepsaná u Applu (to vyžaduje placený vývojářský účet), takže ji
macOS při prvním spuštění zablokuje. Obejdeš to takto: na ikonu aplikace klikni
**pravým tlačítkem → Otevřít** a v dialogu potvrď **Otevřít**. Stačí jednou, pak
už se spouští normálně.

---

## Spuštění bez sestavování (vývojový režim)

Pokud si chceš aplikaci jen vyzkoušet bez tvorby `.dmg`:

    npm install
    npm run electron:dev

Otevře se v samostatném okně aplikace. Zastavíš ji v Terminálu klávesami Ctrl+C.

Případně čistě v prohlížeči (bez Electronu):

    npm run dev

Otevře se na http://localhost:5173

---

## Tip: jak zjistit cestu ke složce

V Terminálu napiš `cd ` (s mezerou na konci) a pak složku projektu přetáhni myší
z Finderu přímo do okna Terminálu – cesta se doplní sama.

---

## Kde se ukládají data

Uložené mzdy se ukládají lokálně v aplikaci (localStorage), nikam se neodesílají.
Zůstávají uložené i po zavření aplikace.

## Poznámka k výpočtům

Všechny výpočty (odvody, daně, paušály, minimální zálohy, progresivní zdanění) jsou
**orientační** a používají sazby platné pro rok 2026. Sazby lze v aplikaci ručně
upravit. Pro závazné výpočty se obrať na účetního.
