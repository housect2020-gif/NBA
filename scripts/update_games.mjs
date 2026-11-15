// Saves ESPN game info (pre-game over/under, scores) to the Supabase "games" table.
// Runs on a schedule from GitHub Actions. Needs env: SUPABASE_URL, SUPABASE_SECRET_KEY.
// Optional: LEAGUES="NBA,WNBA,MLB,NFL", DRY_RUN=1, ESPN_BASE (testing).
const SPORTS = {
  NBA: 'basketball/nba',
  WNBA: 'basketball/wnba',
  MLB: 'baseball/mlb',
  NFL: 'football/nfl',
};
const ESPN = process.env.ESPN_BASE || 'https://site.api.espn.com/apis/site/v2/sports';
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
const DRY = process.env.DRY_RUN === '1';
const leagues = (process.env.LEAGUES || 'NBA,WNBA,MLB,NFL').split(',').map(s => s.trim()).filter(Boolean);

if (!DRY && (!URL_ || !KEY)) { console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY'); process.exit(1); }

function etDay(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d); // YYYY-MM-DD
  return parts;
}

// ---- spread / favorite / "rule pick" -------------------------------------------------------
// ESPN gives the spread as text like "BOS -6.5" (minus = favorite). Rule (NBA only):
//   favorite is the HOME team -> Under;  favorite is the AWAY team -> Over.
function parseMl(v) { const n = Number(v); return (v == null || v === '' || isNaN(n) || n === 0) ? null : n; }
function oddsExtras(league, odds, awayAbbr, homeAbbr) {
  const out = {};
  if (!odds) return out;
  let fav = null, spread = null;
  const m = String(odds.details || '').match(/^([A-Za-z]{2,4})\s+([+-]?\d+(?:\.\d+)?)/);
  if (m) { fav = m[1].toUpperCase(); spread = Math.abs(parseFloat(m[2])); }
  if (fav && fav !== String(awayAbbr).toUpperCase() && fav !== String(homeAbbr).toUpperCase()) fav = null;  // unknown code: don't guess
  if (!fav) {
    if (odds.homeTeamOdds && odds.homeTeamOdds.favorite) fav = String(homeAbbr).toUpperCase();
    else if (odds.awayTeamOdds && odds.awayTeamOdds.favorite) fav = String(awayAbbr).toUpperCase();
    if (fav && spread == null && typeof odds.spread === 'number') spread = Math.abs(odds.spread);
  }
  if (fav) {
    out.pre_favorite = fav;
    if (spread != null && !isNaN(spread)) out.pre_spread = spread;
    if (league === 'NBA' && spread !== 0) out.rule_pick = fav === String(homeAbbr).toUpperCase() ? 'Under' : 'Over';
  }
  const hMl = parseMl(odds.homeTeamOdds && odds.homeTeamOdds.moneyLine != null ? odds.homeTeamOdds.moneyLine
    : (odds.moneyline && odds.moneyline.home && odds.moneyline.home.close && odds.moneyline.home.close.odds));
  const aMl = parseMl(odds.awayTeamOdds && odds.awayTeamOdds.moneyLine != null ? odds.awayTeamOdds.moneyLine
    : (odds.moneyline && odds.moneyline.away && odds.moneyline.away.close && odds.moneyline.away.close.odds));
  if (hMl != null) out.pre_home_ml = Math.round(hMl);
  if (aMl != null) out.pre_away_ml = Math.round(aMl);
  return out;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'sports-sheet-job' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function upsert(rows) {
  if (!rows.length) return;
  if (DRY) { console.log('DRY upsert', JSON.stringify(rows)); return; }
  const r = await fetch(`${URL_}/rest/v1/games?on_conflict=league,game_id`, {
    method: 'POST',
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert failed: HTTP ${r.status} ${await r.text()}`);
}

const nowIso = new Date().toISOString();
let total = 0;

for (const league of leagues) {
  const path = SPORTS[league];
  if (!path) { console.warn('Unknown league', league); continue; }
  const seen = new Map();
  for (const off of [-1, 0, 1]) {
    const day = etDay(off).replace(/-/g, '');
    try {
      const data = await getJson(`${ESPN}/${path}/scoreboard?dates=${day}`);
      for (const ev of data.events || []) seen.set(String(ev.id), ev);
    } catch (e) { console.warn(`[${league}] ${day}: ${e.message}`); }
  }

  const preRows = [];    // pre-game games (written in batches that share the same set of fields)
  const others = [];     // started/finished games -> never touch pre_odds
  for (const ev of seen.values()) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const away = (comp.competitors || []).find(c => c.homeAway === 'away');
    const home = (comp.competitors || []).find(c => c.homeAway === 'home');
    if (!away || !home) continue;
    const state = (comp.status && comp.status.type && comp.status.type.state) || (ev.status && ev.status.type && ev.status.type.state) || null;
    const lines = c => (c.linescores || []).map(l => Number(l.value));
    const base = {
      league, game_id: String(ev.id),
      game_date: etDay(0) && new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ev.date)),
      start_time: ev.date,
      away: away.team && away.team.abbreviation, home: home.team && home.team.abbreviation,
      season_type: ev.season ? ev.season.type : null,
      state, updated_at: nowIso,
    };
    if (state === 'pre') {
      // Only fields ESPN actually has right now are written, so a missing value never wipes one saved earlier.
      const row = { ...base, ...oddsExtras(league, comp.odds && comp.odds[0], away.team && away.team.abbreviation, home.team && home.team.abbreviation) };
      const ou = comp.odds && comp.odds[0] && Number(comp.odds[0].overUnder);
      if (ou && !isNaN(ou)) { row.pre_odds = ou; row.pre_odds_at = nowIso; }
      preRows.push(row);
    } else {
      others.push({
        ...base,
        away_q: lines(away), home_q: lines(home),
        final_away: state === 'post' ? Number(away.score) : null,
        final_home: state === 'post' ? Number(home.score) : null,
      });
    }
  }
  // PostgREST needs every row in a batch to have the same keys, so group pre-game rows by which fields they carry.
  const groups = new Map();
  for (const row of preRows) { const k = Object.keys(row).sort().join(','); (groups.get(k) || groups.set(k, []).get(k)).push(row); }
  for (const rows of groups.values()) await upsert(rows);
  await upsert(others);
  total += preRows.length + others.length;
  console.log(`[${league}] ${seen.size} games (${preRows.filter(r => r.pre_odds != null).length} with a pre-game total, ${preRows.filter(r => r.rule_pick).length} with a rule pick)`);
}
console.log(`Done: ${total} rows`);
