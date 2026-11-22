// Saves ESPN game info (pre-game over/under, scores) to the Supabase "games" table.
// Runs on a schedule from GitHub Actions. Needs env: SUPABASE_URL, SUPABASE_SECRET_KEY.
// Optional: LEAGUES="NBA,WNBA,MLB,NFL", DRY_RUN=1, ESPN_BASE (testing).
//
// NBA "lock": on the first run within LOCK_MINUTES (60) of tip-off, the rule pick, total, spread and time are
// saved once as lock_* and never change again. If no run lands in that window, the last pre-game line is saved
// instead and marked lock_late = true, so it can be left out of the scorecard.
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
const LOCK_MINUTES = Number(process.env.LOCK_MINUTES || 60);
const LOCK_LEAGUES = new Set(['NBA']);
let TIER_COLS = true;
let INJ_COLS = true;    // turns off by itself if the lock_injuries column does not exist yet   // turns off by itself if the lock_type column does not exist yet

// Standing of each NBA team (rank by win %, then points differential) -> tier Good / Mid / Bad (thirds).
// Saved with the lock so History can score the over/under rule by matchup type.
async function nbaTiers() {
  try {
    const url = ESPN.replace('/apis/site/v2/', '/apis/v2/') + '/basketball/nba/standings';
    const j = await getJson(url);
    const rows = [];
    for (const c of j.children || []) for (const e of (c.standings && c.standings.entries) || []) {
      const st = n => { const x = (e.stats || []).find(y => y.name === n); return x ? Number(x.value) : null; };
      const w = st('wins'), l = st('losses');
      if (w == null || l == null || w + l === 0) continue;
      const pf = st('avgPointsFor'), pa = st('avgPointsAgainst');
      rows.push({ abbr: e.team.abbreviation, pct: w / (w + l), diff: pf != null && pa != null ? pf - pa : 0 });
    }
    if (rows.length < 20) return null;
    rows.sort((a, b) => b.pct - a.pct || b.diff - a.diff);
    const n = rows.length, third = Math.round(n / 3), map = new Map();
    rows.forEach((r, i) => map.set(r.abbr, { rank: i + 1, tier: i < third ? 'G' : (i >= n - third ? 'B' : 'M') }));
    return map;
  } catch (e) { console.warn('standings unavailable: ' + e.message); return null; }
}
// Injury snapshot: who ESPN lists as Out / Day-To-Day for each team at lock time (the feed only shows the latest status).
async function nbaInjuries() {
  try {
    const j = await getJson(ESPN + '/basketball/nba/injuries');
    const map = new Map();
    const fresh = Date.now() - 48 * 3600 * 1000;
    for (const t of j.injuries || []) for (const i of t.injuries || []) {
      const ab = i.athlete && i.athlete.team && i.athlete.team.abbreviation;
      if (!ab) continue;
      const e = map.get(ab) || { out: [], dtd: [], long: 0 };
      const isFresh = !i.date || new Date(i.date).getTime() >= fresh;
      const name = i.athlete.shortName || i.athlete.displayName;
      let pid = null;
      for (const l of i.athlete.links || []) { const mm = /\/id\/(\d+)\//.exec(l.href || ''); if (mm) { pid = mm[1]; break; } }
      const who = { n: name, id: pid, p: i.athlete.position && i.athlete.position.abbreviation };
      if (i.status === 'Out') { if (isFresh) e.out.push(who); else e.long++; }
      else if (isFresh) e.dtd.push(who.n);
      map.set(ab, e);
    }
    return map.size ? map : null;
  } catch (e) { console.warn('injuries unavailable: ' + e.message); return null; }
}
// Who matters: a "core" player started at least half his games or plays 24+ minutes a game (needs 3+ games on file).
function withImpact(e) {
  return { ...e, out: e.out.map(o => {
    const st = PLAYERS && o.id ? PLAYERS.get(String(o.id)) : null;
    if (!st || st.gp < 3) return { ...o, core: null };
    const mpg = st.min / st.gp, ppg = st.pts / st.gp, sr = st.starts / st.gp;
    return { ...o, mpg: Math.round(mpg * 10) / 10, ppg: Math.round(ppg * 10) / 10, core: sr >= 0.5 || mpg >= 24 };
  }) };
}
function injFields(inj, awayAbbr, homeAbbr) {
  if (!INJ_COLS || !inj) return {};
  const e0 = { out: [], dtd: [], long: 0 };
  return { lock_injuries: JSON.stringify({ at: new Date().toISOString(), a: withImpact(inj.get(awayAbbr) || e0), h: withImpact(inj.get(homeAbbr) || e0) }) };
}

// ---------- player minutes / starts from finished games' box scores ----------
let PLAYERS = null;     // Map playerId -> { gp, starts, min, pts }  (null until loaded / if the players table is missing)
const hdr = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}` });
async function loadPlayers() {
  try {
    const r = await fetch(`${URL_}/rest/v1/players?league=eq.NBA&select=player_id,gp,starts,min,pts&limit=2000`, { headers: hdr() });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    return new Map(rows.map(x => [String(x.player_id), { gp: Number(x.gp), starts: Number(x.starts), min: Number(x.min), pts: Number(x.pts) }]));
  } catch (e) { return null; }
}
// Adds up to MAX_BOXSCORES finished games per run (the first runs catch up on the season, newest games first).
async function updatePlayers() {
  const MAX = Number(process.env.MAX_BOXSCORES || 25);
  let r = await fetch(`${URL_}/rest/v1/games?league=eq.NBA&state=eq.post&season_type=in.(2,3)&players_done=is.null&select=game_id&order=game_date.desc&limit=${MAX}`, { headers: hdr() });
  if (!r.ok) { console.warn('players: games.players_done column or players table not found - run the players SQL in Supabase.'); return; }
  const ids = (await r.json()).map(x => String(x.game_id));
  if (!ids.length) { console.log('players: nothing new to add'); return; }
  const add = new Map(), done = [];
  for (const id of ids) {
    try {
      const j = await getJson(`${ESPN}/basketball/nba/summary?event=${id}`);
      const teams = (j.boxscore && j.boxscore.players) || [];
      if (!teams.length) continue;
      for (const t of teams) {
        const st = (t.statistics || [])[0]; if (!st) continue;
        const labels = st.labels || [], iM = labels.indexOf('MIN'), iP = labels.indexOf('PTS');
        for (const a of st.athletes || []) {
          if (a.didNotPlay || !a.athlete || !a.stats || !a.stats.length || iM < 0) continue;
          const min = parseFloat(a.stats[iM]); if (!(min > 0)) continue;
          const pts = iP >= 0 ? (parseFloat(a.stats[iP]) || 0) : 0;
          const k = String(a.athlete.id);
          const e = add.get(k) || { player_id: k, name: a.athlete.displayName, team: t.team && t.team.abbreviation, pos: a.athlete.position && a.athlete.position.abbreviation, gp: 0, starts: 0, min: 0, pts: 0 };
          e.gp++; e.starts += a.starter ? 1 : 0; e.min += min; e.pts += pts;
          add.set(k, e);
        }
      }
      done.push(id);
    } catch (e) { console.warn(`players: ${id}: ${e.message}`); }
  }
  if (!done.length) return;
  // add to what is already saved
  const have = await (async () => {
    const m = new Map();
    const keys = [...add.keys()];
    for (let i = 0; i < keys.length; i += 100) {
      const rr = await fetch(`${URL_}/rest/v1/players?league=eq.NBA&player_id=in.(${keys.slice(i, i + 100).join(',')})&select=player_id,gp,starts,min,pts`, { headers: hdr() });
      if (rr.ok) for (const x of await rr.json()) m.set(String(x.player_id), x);
    }
    return m;
  })();
  const rows = [...add.values()].map(e => {
    const o = have.get(e.player_id) || { gp: 0, starts: 0, min: 0, pts: 0 };
    return { league: 'NBA', ...e, gp: Number(o.gp) + e.gp, starts: Number(o.starts) + e.starts, min: Number(o.min) + e.min, pts: Number(o.pts) + e.pts, updated_at: new Date().toISOString() };
  });
  if (DRY) { console.log(`DRY players: ${rows.length} players from ${done.length} games`); return; }
  const up = await fetch(`${URL_}/rest/v1/players?on_conflict=league,player_id`, {
    method: 'POST', headers: { ...hdr(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  if (!up.ok) { console.warn(`players: save failed HTTP ${up.status} ${await up.text()}`); return; }
  const mk = await fetch(`${URL_}/rest/v1/games?league=eq.NBA&game_id=in.(${done.join(',')})`, {
    method: 'PATCH', headers: { ...hdr(), 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ players_done: true }) });
  if (!mk.ok) console.warn(`players: could not mark games done HTTP ${mk.status}`);
  console.log(`players: added ${done.length} games, ${rows.length} players`);
}
const TV = { G: 3, M: 2, B: 1 };
function tierFields(tiers, awayAbbr, homeAbbr) {
  if (!TIER_COLS || !tiers) return {};
  const a = tiers.get(awayAbbr), h = tiers.get(homeAbbr);
  if (!a || !h) return {};
  const [hi, lo] = TV[a.tier] >= TV[h.tier] ? [a.tier, h.tier] : [h.tier, a.tier];
  return { lock_away_rank: a.rank, lock_home_rank: h.rank, lock_type: hi + lo };
}
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

// Existing saved rows for these games (to see which already have a lock, and to use their last pre-game line as a late fallback).
// Returns null when the lock columns are not in the table yet -> locking is skipped and everything else works as before.
async function existingRows(league, ids) {
  if (DRY && !process.env.SUPABASE_URL) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const mk = cols => `${URL_}/rest/v1/games?league=eq.${league}&game_id=in.(${chunk.join(',')})&select=${cols}`;
    const base = 'game_id,lock_at,pre_odds,pre_odds_at,pre_favorite,pre_spread,rule_pick';
    const hdr = { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } };
    let r = await fetch(mk(base + (TIER_COLS ? ',lock_type' : '') + (INJ_COLS ? ',lock_injuries' : '')), hdr);
    if (!r.ok && INJ_COLS) {   // injuries column not in the table yet -> keep going without it
      INJ_COLS = false;
      console.warn(`[${league}] lock_injuries column not found - run the injuries SQL in Supabase to save injury snapshots.`);
      r = await fetch(mk(base + (TIER_COLS ? ',lock_type' : '')), hdr);
    }
    if (!r.ok && TIER_COLS) {   // matchup columns not in the table yet -> keep locking, just without them
      TIER_COLS = false;
      console.warn(`[${league}] matchup columns not found - run the matchup SQL in Supabase to save rank/type. Locking continues without them.`);
      r = await fetch(mk(base), hdr);
    }
    if (!r.ok) { console.warn(`[${league}] lock lookup failed (HTTP ${r.status}) - locking skipped. Run the lock SQL in Supabase.`); return null; }
    const rows = await r.json();
    if (!Array.isArray(rows)) { console.warn(`[${league}] lock lookup returned an unexpected answer - locking skipped.`); return null; }
    for (const row of rows) out.set(String(row.game_id), row);
  }
  return out;
}

function groupBySignature(rows) {
  const groups = new Map();
  for (const row of rows) { const k = Object.keys(row).sort().join(','); (groups.get(k) || groups.set(k, []).get(k)).push(row); }
  return [...groups.values()];
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

  const existing = LOCK_LEAGUES.has(league) && seen.size ? await existingRows(league, [...seen.keys()]) : null;
  let locked = 0, lockedLate = 0;
  const tiers = existing ? await nbaTiers() : null;
  const inj = existing ? await nbaInjuries() : null;
  if (existing && !PLAYERS && URL_) PLAYERS = await loadPlayers();
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
      // Lock: first run inside the last LOCK_MINUTES before tip-off (and never changed afterwards).
      if (existing && !(existing.get(String(ev.id)) || {}).lock_at && row.pre_odds != null) {
        const mins = (new Date(ev.date).getTime() - Date.now()) / 60000;
        if (mins <= LOCK_MINUTES && mins >= -30) {
          row.lock_total = row.pre_odds;
          row.lock_spread = row.pre_spread != null ? row.pre_spread : null;
          row.lock_favorite = row.pre_favorite || null;
          row.lock_pick = row.rule_pick || null;
          row.lock_at = nowIso;
          row.lock_late = false;
          Object.assign(row, tierFields(tiers, row.away, row.home), injFields(inj, row.away, row.home));
          locked++;
        }
      }
      preRows.push(row);
    } else {
      const row = {
        ...base,
        away_q: lines(away), home_q: lines(home),
        final_away: state === 'post' ? Number(away.score) : null,
        final_home: state === 'post' ? Number(home.score) : null,
      };
      // No lock was taken before tip-off: keep the last pre-game line we had, marked late.
      const ex = existing && existing.get(String(ev.id));
      if (ex && !ex.lock_at && ex.pre_odds != null) {
        row.lock_total = Number(ex.pre_odds);
        row.lock_spread = ex.pre_spread != null ? Number(ex.pre_spread) : null;
        row.lock_favorite = ex.pre_favorite || null;
        row.lock_pick = ex.rule_pick || null;
        row.lock_at = ex.pre_odds_at || nowIso;
        row.lock_late = true;
        Object.assign(row, tierFields(tiers, row.away, row.home), injFields(inj, row.away, row.home));
        lockedLate++;
      }
      others.push(row);
    }
  }
  // PostgREST needs every row in a batch to have the same keys, so group pre-game rows by which fields they carry.
  for (const rows of groupBySignature(preRows)) await upsert(rows);
  for (const rows of groupBySignature(others)) await upsert(rows);
  total += preRows.length + others.length;
  console.log(`[${league}] ${seen.size} games (${preRows.filter(r => r.pre_odds != null).length} with a pre-game total, ${preRows.filter(r => r.rule_pick).length} with a rule pick)` +
    (existing ? `, locks: ${locked} on time, ${lockedLate} late` : ''));
}
if (leagues.includes('NBA') && URL_ && !DRY) { try { await updatePlayers(); } catch (e) { console.warn('players step failed: ' + e.message); } }
console.log(`Done: ${total} rows`);
